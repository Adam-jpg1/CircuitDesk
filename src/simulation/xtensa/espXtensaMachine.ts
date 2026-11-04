// The machinery the Espressif Xtensa parts share: two cores on one timeline,
// interrupt delivery through a per-core interrupt matrix, mask-ROM routines
// provided natively, and a bus the chip defines.
//
// The ESP32 and the ESP32-S3 differ in almost every address — memory map,
// flash MMU, where the matrix and the CPU controls live — and in nothing here.
// Each chip's machine subclasses this with its own bus, peripherals and ROM
// table; how the two cores are interleaved, how an idle core sleeps until its
// next event, and how a ROM call returns or forwards into firmware is written
// once.

import { Xtensa, type XtensaBus, type XtensaConfig } from './xtensa';
import type { InterruptingPeripheral, Peripheral, SimulatedClock } from '../espRiscv/peripheral';
import type { EspBusPorts } from '../espRiscv/i2c';
import type { SerialNorFlash } from '../esp32c3/spiFlash';
import type { EspApplicationImage } from '../esp32c3/espImage';
import { createRomState, type Esp32RomEntry, type Esp32RomHost, type Esp32RomState } from '../esp32/rom';

/** CPU interrupts wired inside the core (timers, software, profiling): not routable. Both chips agree. */
export const INTERNAL_INTERRUPTS = (1 << 6) | (1 << 7) | (1 << 11) | (1 << 15) | (1 << 16) | (1 << 29);

export interface CoreSlot {
  cpu: Xtensa;
  /** Simulated nanoseconds this core has reached. */
  ns: number;
  running: boolean;
  /** Set while a ROM delay holds the core. */
  stalledUntil: number;
  /** Interrupt matrix: CPU line each source is routed to. */
  map: Uint8Array;
}

export class UnimplementedEsp32RomError extends Error {
  constructor(readonly address: number, readonly caller: number, chip = 'ESP32') {
    super(
      `The sketch called the ${chip} mask ROM at 0x${address.toString(16)} (from 0x${caller.toString(16)}), ` +
        'which this simulator does not provide.',
    );
    this.name = 'UnimplementedEsp32RomError';
  }
}

export abstract class EspXtensaMachine implements SimulatedClock {
  readonly slots: CoreSlot[];
  readonly romState: Esp32RomState = createRomState();
  protected readonly peripherals: Peripheral[] = [];
  protected readonly interrupting: InterruptingPeripheral[] = [];
  protected interruptsDirty = true;
  protected nextCheckNs: number | undefined;
  protected image: EspApplicationImage | null = null;
  protected readonly externalEvents: { nextEventNanos(): number | undefined }[] = [];
  /** Where the I2C and SPI controllers reach the device models; the runner fills these in. */
  readonly ports: EspBusPorts = { i2c: null, spi: null };
  /** Bytes the ROM console printed. */
  onConsoleByte: ((byte: number) => void) | null = null;
  /** Set when the firmware stops in a way it cannot recover from. */
  fault: string | null = null;
  timeLimitNanos: number | undefined;
  /** The core whose instruction is executing, for bus accesses that depend on it. */
  protected current = 0;
  protected pendingReset = false;
  protected readonly romName: string = 'ESP32';
  /** Machine code placed in ROM space that runs as firmware rather than natively. */
  protected readonly romCode: { start: number; end: number }[] = [];

  constructor(
    readonly flash: SerialNorFlash,
    configs: XtensaConfig[],
    sourceCount: number,
    rom: { start: number; end: number },
    protected readonly romTable: Map<number, Esp32RomEntry>,
  ) {
    this.slots = configs.map((config, i) => {
      const cpu = new Xtensa(this.busFor(i), config);
      cpu.romStart = rom.start;
      cpu.romEnd = rom.end;
      cpu.rom = (pc) => this.romCall(i, pc);
      return { cpu, ns: 0, running: false, stalledUntil: 0, map: new Uint8Array(sourceCount).fill(16) };
    });
  }

  // ------------------------------------------------------------- the chip's part

  abstract read8(a: number, cpu?: number): number;
  abstract read32(a: number, cpu?: number): number;
  abstract write8(a: number, v: number): void;
  abstract write16(a: number, v: number): void;
  abstract write32(a: number, v: number): void;
  /** Three instruction bytes at an address, little-endian. */
  protected abstract fetch(a: number, cpu: number): number;
  /** The CPU clock the firmware selected. */
  abstract get cpuMhz(): number;
  abstract loadImage(image: EspApplicationImage): void;
  /** The host a ROM routine called on core `i` works through. */
  protected abstract romHost(i: number): Esp32RomHost;
  /** Interrupt sources the chip raises outside any peripheral: the cross-core software interrupts. */
  protected abstract softwareSources(): number[];

  // ------------------------------------------------------------- plumbing

  addPeripheral(p: Peripheral): void {
    this.peripherals.push(p);
    if (typeof (p as unknown as InterruptingPeripheral).assertedInterruptSources === 'function') this.interrupting.push(p as unknown as InterruptingPeripheral);
    this.interruptsDirty = true;
  }

  addEventSource(source: { nextEventNanos(): number | undefined }): void {
    this.externalEvents.push(source);
  }

  interruptSourceChanged(): void {
    this.interruptsDirty = true;
  }

  get nanos(): number {
    const [pro, app] = this.slots;
    return app.running ? Math.min(pro.ns, app.ns) : pro.ns;
  }

  get micros(): number {
    return this.nanos / 1000;
  }

  reset(): void {
    if (this.image) this.loadImage(this.image);
  }

  protected busFor(cpu: number): XtensaBus {
    return {
      read8: (a) => this.read8(a, cpu),
      read16: (a) => this.read8(a, cpu) | (this.read8(a + 1, cpu) << 8),
      read32: (a) => this.read32(a, cpu),
      write8: (a, v) => this.write8(a, v),
      write16: (a, v) => this.write16(a, v),
      write32: (a, v) => this.write32(a, v),
      fetch: (a) => this.fetch(a, cpu),
    };
  }

  protected resetCores(): void {
    for (const slot of this.slots) {
      slot.ns = 0;
      slot.running = false;
      slot.stalledUntil = 0;
      slot.map.fill(16);
      slot.cpu.cycles = 0;
    }
  }

  protected startCore(i: number, pc: number, sp: number): void {
    const slot = this.slots[i];
    slot.cpu.reset(pc);
    // As the ROM leaves it: user vector mode, window overflow enabled, level 0.
    slot.cpu.ps = 0x00040020;
    slot.cpu.setA(1, sp);
    slot.running = true;
    if (i === 1) {
      slot.ns = this.slots[0].ns;
      slot.cpu.cycles = this.slots[0].cpu.cycles;
    }
  }

  setInterruptMap(cpu: number, source: number, line: number): void {
    const map = this.slots[cpu & 1].map;
    if (source >= 0 && source < map.length) map[source] = line & 0x1f;
    this.interruptsDirty = true;
  }

  // ------------------------------------------------------------- interrupts

  protected asserted: number[] = [];

  protected refreshInterrupts(): void {
    this.interruptsDirty = false;
    const asserted: number[] = [];
    let soonest: number | undefined;
    for (const p of this.interrupting) {
      for (const s of p.assertedInterruptSources()) asserted.push(s);
      const at = p.nextInterruptChangeNanos?.();
      if (at !== undefined && (soonest === undefined || at < soonest)) soonest = at;
    }
    for (const s of this.softwareSources()) asserted.push(s);
    this.asserted = asserted;
    this.nextCheckNs = soonest;
    for (const slot of this.slots) {
      let lines = 0;
      for (const s of asserted) {
        const line = slot.map[s];
        if (line < 32 && !((INTERNAL_INTERRUPTS >>> line) & 1)) lines |= 1 << line;
      }
      slot.cpu.lines = lines >>> 0;
    }
  }

  // ------------------------------------------------------------- ROM

  private readonly hosts: Esp32RomHost[] = [];

  protected romCall(i: number, pc: number): boolean {
    for (const r of this.romCode) if (pc >= r.start && pc < r.end) return false;
    const entry = this.romTable.get(pc);
    const cpu = this.slots[i].cpu;
    if (!entry) {
      const n = (cpu.ps >>> 16) & 3;
      const caller = ((cpu.a(n * 4) & 0x3fffffff) | 0x40000000) >>> 0;
      throw new UnimplementedEsp32RomError(pc, caller, this.romName);
    }
    // Built once per core: it only refers to the core's slot and the machine.
    const host = (this.hosts[i] ??= this.romHost(i));
    const result = entry.handler(host);
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      // Forwarded into firmware: the callee runs as though called directly.
      const n = (cpu.ps >>> 16) & 3;
      if (result.a6 !== undefined) cpu.setA(n * 4 + 6, result.a6 >>> 0);
      if (result.a7 !== undefined) cpu.setA(n * 4 + 7, result.a7 >>> 0);
      cpu.pc = result.jump >>> 0;
      return true;
    }
    if (Array.isArray(result)) cpu.romReturn(result[0], result[1]);
    else cpu.romReturn(typeof result === 'number' ? result : undefined);
    return true;
  }

  softwareReset(): void {
    this.pendingReset = true;
  }

  // ------------------------------------------------------------- running

  protected periodNs(): number {
    return 1000 / this.cpuMhz;
  }

  /** Earliest time something outside the cores will act. */
  nextEventNanos(): number | undefined {
    let soonest = this.nextCheckNs;
    for (const e of this.externalEvents) {
      const at = e.nextEventNanos();
      if (at !== undefined && (soonest === undefined || at < soonest)) soonest = at;
    }
    for (const slot of this.slots) {
      if (!slot.running) continue;
      const at = this.timerWakeNs(slot);
      if (at !== undefined && (soonest === undefined || at < soonest)) soonest = at;
    }
    return soonest;
  }

  protected timerWakeNs(slot: CoreSlot): number | undefined {
    const cycles = slot.cpu.cyclesToNextTimer();
    return Number.isFinite(cycles) ? slot.ns + cycles * this.periodNs() : undefined;
  }

  /** Can this core do nothing until an interrupt arrives? */
  protected idle(slot: CoreSlot): boolean {
    return slot.cpu.waiting && slot.cpu.pendingLevel() === 0;
  }

  /** Moves a core's clock forward without executing, keeping CCOUNT in step. */
  protected advance(slot: CoreSlot, toNs: number): void {
    if (toNs <= slot.ns) return;
    const cycles = Math.floor((toNs - slot.ns) / this.periodNs());
    slot.cpu.cycles += cycles;
    slot.ns += cycles * this.periodNs();
    if (slot.ns < toNs) slot.ns = toNs;
  }

  /**
   * Runs both cores until simulated time reaches `untilNs` or the instruction
   * budget is spent. Returns the instructions executed.
   */
  run(untilNs: number, budget: number): number {
    let executed = 0;
    const [pro, app] = this.slots;
    while (executed < budget && !this.fault) {
      if (this.pendingReset) {
        this.pendingReset = false;
        const ns = this.nanos;
        this.romState.resetReason = 12;
        this.reset();
        this.romState.resetReason = 12;
        for (const s of this.slots) s.ns = ns;
        return executed;
      }
      // The core that is behind runs next, so the two share one timeline.
      const slot = app.running && app.ns < pro.ns ? app : pro;
      const other = slot === pro ? app : pro;
      if (slot.ns >= untilNs) {
        if (!other.running || other.ns >= untilNs) break;
      }
      if (this.interruptsDirty || (this.nextCheckNs !== undefined && this.nanos >= this.nextCheckNs)) this.refreshInterrupts();
      if (slot.stalledUntil > slot.ns) {
        this.advance(slot, Math.min(slot.stalledUntil, untilNs, other.running ? Math.max(other.ns, slot.ns + 1000) : untilNs));
        if (slot.ns >= slot.stalledUntil) slot.stalledUntil = 0;
        continue;
      }
      if (this.idle(slot)) {
        // Asleep until its own timer, a peripheral, the other core, or the end of the slice.
        let wake = untilNs;
        const own = this.timerWakeNs(slot);
        if (own !== undefined) wake = Math.min(wake, own);
        const ext = this.nextEventNanos();
        if (ext !== undefined) wake = Math.min(wake, Math.max(ext, slot.ns));
        if (other.running && !this.idle(other)) wake = Math.min(wake, Math.max(other.ns, slot.ns));
        if (wake <= slot.ns) wake = slot.ns + this.periodNs();
        this.advance(slot, wake);
        slot.cpu.step(); // lets the core see a timer that has now matched
        this.interruptsDirty = true;
        continue;
      }
      this.current = slot === pro ? 0 : 1;
      const period = this.periodNs();
      // How far this core may run before the other must be looked at again: a
      // few microseconds ahead of a busy one, or up to an idle one's next wake.
      let horizon = untilNs;
      if (other.running) {
        if (this.idle(other)) {
          const own = this.timerWakeNs(other);
          if (own !== undefined) horizon = Math.min(horizon, own);
        } else horizon = Math.min(horizon, other.ns + 2000);
      }
      if (this.nextCheckNs !== undefined) horizon = Math.min(horizon, Math.max(this.nextCheckNs, slot.ns + period));
      for (const e of this.externalEvents) {
        const at = e.nextEventNanos();
        if (at !== undefined) horizon = Math.min(horizon, Math.max(at, slot.ns + period));
      }
      for (let k = 0; k < 4096; k++) {
        // Time follows the cycles the core counted, so CCOUNT and the clock
        // every peripheral reads never drift apart (a native ROM call costs
        // several cycles, not one).
        const before = slot.cpu.cycles;
        try {
          slot.cpu.step();
        } catch (e) {
          this.fault = e instanceof Error ? e.message : String(e);
          return executed;
        }
        slot.ns += (slot.cpu.cycles - before) * period;
        executed++;
        if (slot.cpu.halted) {
          this.fault = slot.cpu.halted;
          return executed;
        }
        if (this.interruptsDirty || slot.stalledUntil || slot.cpu.waiting || slot.ns >= horizon) break;
      }
    }
    return executed;
  }
}
