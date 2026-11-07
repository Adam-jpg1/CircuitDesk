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

import { Xtensa, FIRMWARE_HOOK_BREAK, type XtensaBus, type XtensaConfig } from './xtensa';
import type { InterruptingPeripheral, Peripheral, SimulatedClock } from '../espRiscv/peripheral';
import type { EspBusPorts } from '../espRiscv/i2c';
import type { SerialNorFlash } from '../esp32c3/spiFlash';
import type { EspApplicationImage } from '../esp32c3/espImage';
import { createRomState, type Esp32RomEntry, type Esp32RomHost, type Esp32RomState } from '../esp32/rom';
import { allRounds, type FirmwareHandler, type GuestCall, type GuestRoutine } from '../firmwareCalls';
export type { FirmwareHandler, GuestCall, GuestRoutine };

/** CPU interrupts wired inside the core (timers, software, profiling): not routable. Both chips agree. */
export const INTERNAL_INTERRUPTS = (1 << 6) | (1 << 7) | (1 << 11) | (1 << 15) | (1 << 16) | (1 << 29);

/**
 * The machine code a GuestRoutine runs through, placed in ROM space
 * (assembled from the windowed-ABI source below; the two literals are filled
 * in when it is installed).
 *
 *   lit_step:   .word STEP            ; +0
 *   lit_run:    .word RUN             ; +4
 *   gc_entry:   entry a1, 64          ; +8: entered in place of the routine
 *            1: l32r a8, lit_step
 *               callx8 a8             ; native: a9 = next call (0 = done, a2 = result), a10..a15 = its arguments
 *               beqz a9, 2f
 *               callx8 a9             ; its result comes back in a10 for the next step
 *               j 1b
 *            2: retw
 *   task_entry: entry a1, 32          ; +0x20: a FreeRTOS task's function
 *            3: l32r a8, lit_run
 *               callx8 a8             ; native: one round of the task's work, as a GuestRoutine
 *               j 3b
 */
const XTENSA_GLUE = [
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x81, 0x00, 0x81, 0xfd, 0xff, 0xe0, 0x08, 0x00, 0x16, 0x59, 0x00,
  0xe0, 0x09, 0x00, 0x06, 0xfc, 0xff, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x41, 0x00, 0x81, 0xf8, 0xff, 0xe0, 0x08,
  0x00, 0x86, 0xfd, 0xff,
];
const GLUE_GC_ENTRY = 0x08;
export const GLUE_TASK_ENTRY = 0x20;
const GLUE_STEP = 0x30;
const GLUE_RUN = 0x34;
/** A NUL-terminated task name the firmware can read. */
export const GLUE_NAME = 0x38;

/**
 * The same for a core without register windows (the ESP8266's LX106, CALL0
 * ABI). It has no task entry: the NONOS SDK has no tasks to create, and its
 * scheduler calls RUN directly (see Esp8266Machine.nextTask).
 *
 *   lit_step:   .word STEP            ; +0
 *   lit_run:    .word RUN             ; +4
 *   gc_entry:   addi a1, a1, -16      ; +8
 *               s32i a0, a1, 0
 *            1: l32r a0, lit_step
 *               callx0 a0             ; native: a9 = next call (0 = done, a2 = result), a2..a7 = its arguments
 *               beqz a9, 2f
 *               callx0 a9             ; its result comes back in a2 for the next step
 *               j 1b
 *            2: l32i a0, a1, 0
 *               addi a1, a1, 16
 *               ret
 */
const CALL0_GLUE = [
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x12, 0xc1, 0xf0, 0x02, 0x61, 0x00, 0x01, 0xfc, 0xff, 0xc0, 0x00, 0x00,
  0x16, 0x59, 0x00, 0xc0, 0x09, 0x00, 0x06, 0xfc, 0xff, 0x02, 0x21, 0x00, 0x12, 0xc1, 0x10, 0x80, 0x00, 0x00,
];

/** How a core's ABI shapes the glue: its code, gc_entry's frame, and the register a callee's first argument is in. */
interface GlueAbi {
  code: number[];
  codeEnd: number;
  frame: number;
  firstArg: number;
  hasTask: boolean;
}
const WINDOWED_GLUE: GlueAbi = { code: XTENSA_GLUE, codeEnd: 0x30, frame: 64, firstArg: 10, hasTask: true };
const CALL0_GLUE_ABI: GlueAbi = { code: CALL0_GLUE, codeEnd: CALL0_GLUE.length, frame: 16, firstArg: 2, hasTask: false };

function isRoutine(x: unknown): x is GuestRoutine {
  return typeof x === 'object' && x !== null && typeof (x as GuestRoutine).next === 'function';
}

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
  /** What the ROM's rtc_get_reset_reason reports after softwareReset(): the ESP32's SW_CPU_RESET. */
  protected readonly softwareResetReason: number = 12;
  /**
   * Whether the chip's clock carries on through a software reset. The ESP8266's
   * timers are rebuilt from zero by its reset, as the board's Reset does, so
   * its clock starts again too; the run that was in progress ends there.
   */
  protected readonly clockSurvivesSoftwareReset: boolean = true;
  protected readonly romName: string = 'ESP32';
  protected readonly romTable: Map<number, Esp32RomEntry>;
  /** Machine code placed in ROM space that runs as firmware rather than natively. */
  protected readonly romCode: { start: number; end: number }[] = [];
  /** Where this chip puts XTENSA_GLUE in its ROM space; undefined where it has none. */
  protected readonly glueBase: number | undefined = undefined;
  /** Firmware routines provided natively, by address (patched to FIRMWARE_HOOK_BREAK). */
  protected readonly firmwareHandlers = new Map<number, { name: string; handler: FirmwareHandler }>();
  /**
   * Routines under way, by the stack pointer of the glue frame running them.
   * A task's stack is its own, so the key survives a context switch, and a
   * task resumed on the other core.
   */
  private readonly routines = new Map<number, GuestRoutine>();
  /** The work the simulator's own firmware task does each time it runs (see provideTask). */
  private readonly taskRounds: (() => GuestRoutine)[] = [];
  private taskClaimed = false;
  /** Where the application image sits in flash, so cache-mapped code can be patched. */
  protected readonly appFlashOffset: number = 0x10000;
  private get glueAbi(): GlueAbi {
    return this.slots[0].cpu.config.windowed ? WINDOWED_GLUE : CALL0_GLUE_ABI;
  }

  constructor(
    readonly flash: SerialNorFlash,
    configs: XtensaConfig[],
    sourceCount: number,
    rom: { start: number; end: number },
    romTable: Map<number, Esp32RomEntry>,
  ) {
    // Each machine its own copy: entries it adds (the guest-call glue) are bound to it.
    this.romTable = new Map(romTable);
    this.slots = configs.map((config, i) => {
      const cpu = new Xtensa(this.busFor(i), config);
      cpu.romStart = rom.start;
      cpu.romEnd = rom.end;
      cpu.rom = (pc) => this.romCall(i, pc);
      cpu.firmwareHook = (pc) => this.firmwareCall(i, pc);
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
    if (isRoutine(result)) {
      if (this.glueBase === undefined) throw new UnimplementedEsp32RomError(pc, pc, this.romName);
      this.beginRoutine(i, result);
      cpu.pc = (this.glueBase + GLUE_GC_ENTRY) >>> 0;
      return true;
    }
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

  // ------------------------------------------------------------- firmware routines provided natively

  /**
   * Provides a routine of the loaded firmware natively. Its first instruction
   * becomes FIRMWARE_HOOK_BREAK, in the image (so a reset keeps it) and in
   * flash (where cache-mapped code is fetched from).
   */
  provideFirmwareRoutine(address: number, name: string, handler: FirmwareHandler): boolean {
    if (!this.image) return false;
    for (const seg of this.image.segments) {
      const at = address - seg.loadAddress;
      if (at < 0 || at + 3 > seg.data.length) continue;
      FIRMWARE_HOOK_BREAK.forEach((b, k) => {
        seg.data[at + k] = b;
        const f = this.appFlashOffset + seg.fileOffset + at + k;
        if (f < this.flash.bytes.length) this.flash.bytes[f] = b;
        this.write8(address + k, b);
      });
      this.firmwareHandlers.set(address >>> 0, { name, handler });
      return true;
    }
    return false;
  }

  /** Writes the guest-call glue into ROM space; the chip calls this as it loads an image. */
  protected installGlue(): void {
    const base = this.glueBase;
    if (base === undefined) return;
    const abi = this.glueAbi;
    const put = (a: number, v: number) => this.writeRomByte(a, v);
    abi.code.forEach((b, k) => put(base + k, b));
    [base + GLUE_STEP, base + GLUE_RUN].forEach((v, k) => [0, 8, 16, 24].forEach((sh, j) => put(base + k * 4 + j, (v >>> sh) & 0xff)));
    [...'simwifi', '\0'].forEach((c, k) => put(base + GLUE_NAME + k, c.charCodeAt(0)));
    if (!this.romCode.some((r) => r.start === base)) this.romCode.push({ start: base, end: base + abi.codeEnd });
    this.romTable.set(base + GLUE_STEP, { name: 'guest_call_step', handler: (h) => this.routineStep(h.cpu) });
    this.romTable.set(base + GLUE_RUN, {
      name: 'firmware_task_round',
      handler: (h) => {
        this.beginRoutine(h.cpu, allRounds(this.taskRounds));
        return { jump: base + GLUE_GC_ENTRY };
      },
    });
    this.routines.clear();
    this.taskClaimed = false;
  }

  /** Writes a byte of the glue into ROM space (a chip whose bus ignores writes to ROM overrides this). */
  protected writeRomByte(a: number, v: number): void {
    this.write8(a, v);
  }

  /** The glue frame gc_entry is about to open, below the caller's stack pointer. */
  private beginRoutine(core: number, routine: GuestRoutine): void {
    this.routines.set((this.slots[core].cpu.romSp() - this.glueAbi.frame) >>> 0, routine);
  }

  /** The address the firmware's scheduler can call to run one round of provideTask's work, where there is one. */
  get glueRoundEntry(): number | undefined {
    return this.glueBase === undefined ? undefined : this.glueBase + GLUE_RUN;
  }

  /** The address of the glue's task function, for xTaskCreatePinnedToCore. */
  get glueTaskEntry(): number | undefined {
    return this.glueBase === undefined || !this.glueAbi.hasTask ? undefined : this.glueBase + GLUE_TASK_ENTRY;
  }

  get glueTaskName(): number | undefined {
    return this.glueBase === undefined || !this.glueAbi.hasTask ? undefined : this.glueBase + GLUE_NAME;
  }

  /** What the simulator's firmware task does on each round (it should end by yielding a delay). */
  provideTask(round: () => GuestRoutine): void {
    this.taskRounds.push(round);
  }

  /** The task is created once per boot (a reset ends it with everything else). */
  claimTask(): boolean {
    if (this.taskClaimed) return false;
    this.taskClaimed = true;
    return true;
  }

  /** The glue's step: the routine running in this frame makes its next call, or returns. */
  private routineStep(core: number): number | void {
    const cpu = this.slots[core].cpu;
    const key = cpu.romSp() >>> 0;
    const routine = this.routines.get(key);
    if (!routine) {
      this.fault = 'The simulator lost track of a firmware call it was making.';
      return;
    }
    let r: IteratorResult<GuestCall, number | void>;
    try {
      r = routine.next(cpu.romArg(0) >>> 0);
    } catch (e) {
      this.routines.delete(key);
      this.fault = e instanceof Error ? e.message : String(e);
      return;
    }
    if (r.done) {
      this.routines.delete(key);
      cpu.setA(9, 0);
      cpu.setA(2, (r.value ?? 0) >>> 0);
      return;
    }
    const { fn, args } = r.value;
    cpu.setA(9, fn >>> 0);
    const first = this.glueAbi.firstArg;
    for (let k = 0; k < 6; k++) cpu.setA(first + k, (args[k] ?? 0) >>> 0);
    // Arguments past the sixth go on the stack, at the caller's stack pointer.
    for (let k = 6; k < args.length; k++) this.write32(cpu.romSp() + (k - 6) * 4, args[k] >>> 0);
  }

  private firmwareCall(core: number, pc: number): boolean {
    const entry = this.firmwareHandlers.get(pc);
    if (!entry) return false;
    const cpu = this.slots[core].cpu;
    const args: number[] = [];
    for (let k = 0; k < 6; k++) args.push(cpu.romArg(k) >>> 0);
    let result: number | void | GuestRoutine;
    try {
      result = entry.handler(args, core);
    } catch (e) {
      this.fault = e instanceof Error ? e.message : String(e);
      cpu.halted = this.fault;
      return true;
    }
    if (this.fault) {
      cpu.halted = this.fault;
      return true;
    }
    if (isRoutine(result)) {
      if (this.glueBase === undefined) throw new Error(`${entry.name} needs firmware calls this chip cannot make.`);
      this.beginRoutine(core, result);
      cpu.pc = (this.glueBase + GLUE_GC_ENTRY) >>> 0;
      return true;
    }
    cpu.romReturn(typeof result === 'number' ? result : 0);
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
        // The RTC domain is not reset by a software restart: ESP-IDF leaves
        // the reason (ESP.restart(), a panic) in RTC_CNTL's store registers
        // for esp_reset_reason() to read after the reboot.
        const kept = this.peripherals
          .filter((p) => p.name === 'rtc_cntl' && (p as { regs?: unknown }).regs instanceof Map)
          .map((p) => [p as unknown as { regs: Map<number, number> }, new Map((p as unknown as { regs: Map<number, number> }).regs)] as const);
        this.romState.resetReason = this.softwareResetReason;
        this.reset();
        for (const [p, saved] of kept) {
          p.regs.clear();
          for (const [offset, value] of saved) p.regs.set(offset, value);
        }
        this.romState.resetReason = this.softwareResetReason;
        if (this.clockSurvivesSoftwareReset) for (const s of this.slots) s.ns = ns;
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
