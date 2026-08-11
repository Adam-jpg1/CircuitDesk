// More than one board on one canvas, on one clock.
//
// A project used to mean a project with an MCU in it. Two Picos, or an ESP32
// talking to an Arduino, could not work: the binding held a single runner, and
// a bare pin number could not say which board's pin it was.
//
// The fix is not a board-to-board messaging layer. There is no such thing on a
// bench — there is a wire, and both chips can see it. So this owns several
// runners, advances them on one shared timeline, and lets the existing net
// model carry the signal. A wire between two MCUs is the same wire as a wire
// between an MCU and an LED.
//
// The scheduling is where correctness lives. Running one board for a hundred
// milliseconds and then the other would let the first finish an entire blink
// before the second saw the first edge. So every board advances through the
// same small slice before any of them advances again, and the nets are settled
// between slices. That is what makes a signal arrive when it was sent.
//
// This layer knows nothing about ESP, AVR or RP2040. It holds `BoardRunner`s.

import type { BoardRunner } from './boardRunner';

/** A board taking part in the simulation, with the project instance it is. */
export interface WorldMember {
  /** Board instance id from the project. Two identical boards differ here. */
  instanceId: string;
  runner: BoardRunner;
}

/**
 * A signal change worth telling something about.
 *
 * Deliberately not shaped for any particular panel: a logic analyser, a
 * protocol view, signal tracing and challenge grading all want the same facts,
 * and none of them should have to reach into a runner to get them.
 */
export interface NetSignalEvent {
  /** Simulated milliseconds since the world started. */
  timestamp: number;
  netId: string;
  /** Board instance that drove the change, or null for a circuit-side source. */
  source: string | null;
  level: 'high' | 'low' | 'contended' | 'floating';
}

export interface SimulationWorldOptions {
  /**
   * Simulated milliseconds every board advances before nets are settled.
   *
   * Small enough that a signal is seen soon after it is sent, large enough
   * that settling does not dominate. One millisecond is roughly a thousand
   * instructions on these parts even when nothing is idle, and no board can
   * run more than one slice ahead of any other.
   */
  sliceMs?: number;
  /** Called after each settle, for anything watching signals. */
  onSignal?: (event: NetSignalEvent) => void;
}

const DEFAULT_SLICE_MS = 1;

/** Nanoseconds per millisecond. Time is kept in integer nanoseconds inside. */
const NS_PER_MS = 1_000_000;

/**
 * Consecutive zero-length boundaries tolerated before one is ignored.
 *
 * A source that reports itself due for ever — a bug, or a peripheral whose
 * condition is already true — would otherwise spin the loop without time
 * moving. The protection is a count, not a minimum slice: forcing the clock
 * forward by some fixed amount would make that amount the finest resolution
 * anything could ever communicate at, which is precisely what this scheduler
 * must not impose. After this many attempts the offending boundary is set
 * aside for the rest of the call and the coarse slice is used, so time still
 * advances by a correct amount rather than an invented one.
 */
const MAX_ZERO_LENGTH_STEPS = 64;

const msToNs = (ms: number): number => Math.round(ms * NS_PER_MS);

/**
 * Owns the running boards and the clock they share.
 *
 * The net settling itself is not done here — that is the circuit binding's
 * job, and it already knows how to resolve a net from pin states. This calls
 * back into it between slices so the two stay one model rather than two.
 */
export class SimulationWorld {
  private readonly members: WorldMember[] = [];
  private readonly sliceMs: number;
  private readonly onSignal: ((event: NetSignalEvent) => void) | undefined;

  /**
   * Simulated time since the world started, in whole nanoseconds.
   *
   * Integer nanoseconds rather than floating milliseconds because this is the
   * resolution future protocols need and floating point does not hold it
   * cleanly: a 115200-baud bit period is 8681 ns, an I2C fast-mode edge is
   * shorter, and an SPI clock at 10 MHz has 50 ns half-periods. Public
   * interfaces stay in milliseconds, so no runner had to change.
   */
  private elapsedNs = 0;

  /** Called between slices to propagate whatever the boards just did. */
  settle: (() => void) | null = null;

  /**
   * Callbacks the world owes, soonest first.
   *
   * `at` is absolute nanoseconds. `seq` breaks ties so that two events with
   * the same timestamp always run in the order they were scheduled, which is
   * what makes a run reproducible.
   */
  private readonly scheduled: { at: number; seq: number; run: () => void }[] = [];
  private nextSeq = 0;

  constructor(options: SimulationWorldOptions = {}) {
    this.sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS;
    this.onSignal = options.onSignal;
  }

  get timeMs(): number {
    return this.elapsedNs / NS_PER_MS;
  }

  /** Simulated time in whole nanoseconds, which is how it is actually kept. */
  get timeNs(): number {
    return this.elapsedNs;
  }

  get boards(): readonly WorldMember[] {
    return this.members;
  }

  /** True when a project has more than one board actually executing. */
  get isMultiBoard(): boolean {
    return this.members.length > 1;
  }

  add(instanceId: string, runner: BoardRunner): void {
    if (this.members.some((m) => m.instanceId === instanceId)) return;
    this.members.push({ instanceId, runner });
  }

  runnerFor(instanceId: string): BoardRunner | undefined {
    return this.members.find((m) => m.instanceId === instanceId)?.runner;
  }

  /** Every runner, keyed by instance, as the circuit binding wants them. */
  runnerMap(): Map<string, BoardRunner> {
    return new Map(this.members.map((m) => [m.instanceId, m.runner]));
  }

  /**
   * Runs something at a precise simulated time.
   *
   * The world will stop exactly there rather than running past it, which is
   * what makes a net event land when it was meant to. Used for anything
   * outside the boards that acts on a schedule — a canvas input, and later a
   * bus line changing between bit periods.
   */
  scheduleAt(atMs: number, run: () => void): void {
    this.scheduleAtNs(msToNs(atMs), run);
  }

  /**
   * The same, at nanosecond precision.
   *
   * This is the one a bit-timed protocol will use: a UART bit boundary or an
   * SPI clock edge is not a round number of milliseconds and should not have
   * to be expressed as one.
   */
  scheduleAtNs(atNs: number, run: () => void): void {
    this.scheduled.push({ at: Math.round(atNs), seq: this.nextSeq++, run });
    this.scheduled.sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  /**
   * Absolute nanosecond time of the next thing the world already knows about.
   *
   * `ignore` holds boundaries that have proven to be permanently due; they are
   * set aside for the rest of a call rather than being allowed to stall it.
   */
  private nextBoundaryNs(ignore: Set<string>): number | undefined {
    let soonest: number | undefined;
    const consider = (at: number | undefined): void => {
      if (at === undefined || !Number.isFinite(at)) return;
      if (soonest === undefined || at < soonest) soonest = at;
    };
    for (const member of this.members) {
      if (ignore.has(member.instanceId)) continue;
      const deltaMs = member.runner.nextEventMs?.();
      if (deltaMs === undefined || !Number.isFinite(deltaMs) || deltaMs < 0) continue;
      consider(this.elapsedNs + msToNs(deltaMs));
    }
    if (this.scheduled.length > 0 && !ignore.has('#scheduled')) consider(this.scheduled[0].at);
    return soonest;
  }

  /** Which source owns the earliest boundary, so it can be set aside if stuck. */
  private boundaryOwner(atNs: number, ignore: Set<string>): string | undefined {
    if (this.scheduled.length > 0 && !ignore.has('#scheduled') && this.scheduled[0].at === atNs) return '#scheduled';
    for (const member of this.members) {
      if (ignore.has(member.instanceId)) continue;
      const deltaMs = member.runner.nextEventMs?.();
      if (deltaMs === undefined) continue;
      if (this.elapsedNs + msToNs(deltaMs) === atNs) return member.instanceId;
    }
    return undefined;
  }

  /** Runs everything due at or before now, in scheduled order. */
  private drainDue(): number {
    let ran = 0;
    while (this.scheduled.length > 0 && this.scheduled[0].at <= this.elapsedNs) {
      this.scheduled.shift()!.run();
      ran++;
    }
    return ran;
  }

  /**
   * Advances the whole world by a span of simulated time.
   *
   * Boards move in lockstep rather than one at a time: nothing is propagated
   * until every board has run the same slice, so a board can never observe
   * another board's future.
   *
   * The slice is not a fixed millisecond. It is the earliest of the caller's
   * remaining time, the coarse ceiling, and the next moment any board or any
   * scheduled event says something will happen — and it is measured in whole
   * nanoseconds, so an 8681 ns UART bit boundary or a 125 ns SPI edge is a
   * time the world can actually stop at. When nothing finer is pending, the
   * ceiling applies and behaviour is exactly what it was.
   */
  runFor(simMs: number): void {
    if (simMs <= 0 || this.members.length === 0) return;
    const targetNs = this.elapsedNs + msToNs(simMs);
    const ceilingNs = msToNs(this.sliceMs);
    const stuck = new Set<string>();
    let zeroLengthSteps = 0;

    while (this.elapsedNs < targetNs) {
      // Anything already due runs before the boards advance, so a callback
      // scheduled for exactly now is not observed a slice late.
      if (this.drainDue() > 0) this.settle?.();

      let sliceNs = Math.min(ceilingNs, targetNs - this.elapsedNs);
      const boundary = this.nextBoundaryNs(stuck);
      if (boundary !== undefined) {
        const delta = boundary - this.elapsedNs;
        if (delta > 0) {
          sliceNs = Math.min(sliceNs, delta);
          zeroLengthSteps = 0;
        } else if (++zeroLengthSteps > MAX_ZERO_LENGTH_STEPS) {
          // This source insists it is due and never clears. Set it aside for
          // the rest of the call and advance by the coarse slice, which is a
          // correct amount of time rather than an invented minimum.
          const owner = this.boundaryOwner(boundary, stuck);
          if (owner) stuck.add(owner);
          zeroLengthSteps = 0;
        }
      }
      if (sliceNs <= 0) sliceNs = Math.min(ceilingNs, targetNs - this.elapsedNs);

      for (const member of this.members) member.runner.runFor(sliceNs / NS_PER_MS);
      this.elapsedNs += sliceNs;

      this.drainDue();
      // Nets are resolved once per slice, after every board has had it, so a
      // level driven during the slice is visible to all of them next slice.
      this.settle?.();
    }
  }

  /** Reports a resolved net level, for anything watching signals. */
  reportSignal(netId: string, level: NetSignalEvent['level'], source: string | null = null): void {
    this.onSignal?.({ timestamp: this.timeMs, netId, source, level });
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Resets one board without touching the others.
   *
   * A reset button on one MCU is not a reset button on the bench. The world's
   * clock keeps running, because the rest of the circuit did not stop.
   */
  resetBoard(instanceId: string): void {
    this.runnerFor(instanceId)?.reset?.();
  }

  /** Resets every board and the shared clock, as a power cycle would. */
  reset(): void {
    for (const member of this.members) member.runner.reset?.();
    this.elapsedNs = 0;
  }

  /**
   * Removes a board and lets go of whatever it was driving.
   *
   * Disposing the runner is what releases its pins: a removed board must stop
   * holding a net, or a wire would stay high with nothing on the end of it.
   */
  remove(instanceId: string): void {
    const index = this.members.findIndex((m) => m.instanceId === instanceId);
    if (index < 0) return;
    this.members[index].runner.dispose?.();
    this.members.splice(index, 1);
    this.settle?.();
  }

  dispose(): void {
    for (const member of this.members) member.runner.dispose?.();
    this.members.length = 0;
    this.scheduled.length = 0;
  }
}

// --------------------------------------------------- planned bus endpoints

/**
 * How a board will later join a shared bus, sketched rather than built.
 *
 * The buses CircuitDesk models today assume the far end is a device: an I²C
 * peripheral, an SPI flash. Board-to-board UART, I²C and SPI need the far end
 * to be able to be another MCU, and the shape below is what that requires.
 * It is written down now because the multi-board world is the thing that would
 * otherwise have to be rebuilt to accommodate it later.
 *
 *   interface BusEndpoint {
 *     instanceId: string;
 *     role: 'controller' | 'peripheral' | 'either';
 *     // Bytes the endpoint wants to put on the wire this slice.
 *     transmit(): Uint8Array | null;
 *     // Bytes the wire delivered to it.
 *     receive(bytes: Uint8Array): void;
 *     // For I²C: whether this endpoint answers to an address.
 *     acknowledges?(address: number): boolean;
 *   }
 *
 * A bus then becomes a net-like object holding endpoints, exactly as a digital
 * net holds pins, and a device model and a BoardRunner peripheral implement the
 * same interface. Nothing in the world layer above needs to know which is
 * which — which is the property worth preserving.
 */
export type PlannedBusEndpointNote = never;
