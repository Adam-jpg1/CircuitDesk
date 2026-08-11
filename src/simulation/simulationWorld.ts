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

/**
 * Shortest slice the world will take.
 *
 * Without a floor, a board reporting an event every few nanoseconds would make
 * the world take millions of slices to cross a millisecond and the browser
 * would stop responding. Ten microseconds is far below any bit period these
 * protocols use — a 115200 baud bit is 8.7 us, and this still resolves it —
 * while keeping the number of slices per millisecond bounded.
 */
const MIN_SLICE_MS = 0.01;

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

  /** Simulated milliseconds since the world started. */
  private elapsedMs = 0;

  /** Called between slices to propagate whatever the boards just did. */
  settle: (() => void) | null = null;

  /** Callbacks the world owes at a given simulated time, soonest first. */
  private readonly scheduled: { at: number; run: () => void }[] = [];

  constructor(options: SimulationWorldOptions = {}) {
    this.sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS;
    this.onSignal = options.onSignal;
  }

  get timeMs(): number {
    return this.elapsedMs;
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
    this.scheduled.push({ at: atMs, run });
    this.scheduled.sort((a, b) => a.at - b.at);
  }

  /** Simulated ms until the next thing the world already knows about. */
  private nextBoundaryMs(): number | undefined {
    let soonest: number | undefined;
    const consider = (delta: number | undefined): void => {
      if (delta === undefined || !Number.isFinite(delta) || delta < 0) return;
      if (soonest === undefined || delta < soonest) soonest = delta;
    };
    for (const member of this.members) consider(member.runner.nextEventMs?.());
    if (this.scheduled.length > 0) consider(this.scheduled[0].at - this.elapsedMs);
    return soonest;
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
   * scheduled event says something will happen. That is what keeps the
   * millisecond from becoming a communication resolution limit: a UART bit
   * period or an I2C edge is far shorter, and the world will stop on it. When
   * nothing has anything scheduled, the ceiling applies and behaviour is
   * exactly what it was.
   */
  runFor(simMs: number): void {
    if (simMs <= 0 || this.members.length === 0) return;
    let remaining = simMs;
    while (remaining > 0) {
      const boundary = this.nextBoundaryMs();
      let slice = Math.min(this.sliceMs, remaining);
      if (boundary !== undefined && boundary < slice) slice = Math.max(boundary, MIN_SLICE_MS);
      slice = Math.min(slice, remaining);

      for (const member of this.members) member.runner.runFor(slice);
      this.elapsedMs += slice;
      remaining -= slice;

      // Anything due at or before now runs before the nets are settled, so a
      // scheduled change is visible to every board on the very next slice.
      while (this.scheduled.length > 0 && this.scheduled[0].at <= this.elapsedMs) {
        this.scheduled.shift()!.run();
      }

      // Nets are resolved once per slice, after every board has had it, so a
      // level driven during the slice is visible to all of them next slice.
      this.settle?.();
    }
  }

  /** Reports a resolved net level, for anything watching signals. */
  reportSignal(netId: string, level: NetSignalEvent['level'], source: string | null = null): void {
    this.onSignal?.({ timestamp: this.elapsedMs, netId, source, level });
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
    this.elapsedMs = 0;
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
