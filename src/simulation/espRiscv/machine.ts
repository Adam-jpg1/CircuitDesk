// A machine for Espressif's RISC-V parts: memory map, ROM dispatch and
// peripheral routing.
//
// This is the piece between the generic RV32 core and a particular chip's
// behaviour. The core knows only how to execute instructions against a `Bus`;
// everything that makes those instructions mean something on an ESP32-C3 or an
// ESP32-C6 — where RAM lives, which addresses are peripherals, what happens
// when the program counter enters the mask ROM — is here.
//
// What is *shared* between the two parts is exactly this: the bus, the memory
// windows as a concept, the cache-through-MMU read path, the ROM call
// boundary, the guest-callback mechanism, and the interrupt plumbing. What is
// *not* shared is every address involved, which arrives as an `EspSocConfig`
// rather than being written into the code. A machine that hard-coded one
// chip's numbers and was then reused for the other would run, and would be
// wrong in ways that look like emulator bugs.
//
// Kept separate from the runner so the same machine can be driven by a test, a
// trace harness or the production adapter without any of them reimplementing
// the memory map.

import { Rv32Core, type Bus } from '../riscv/rv32Core';
import { planIdleSkip, type TimedEventSource } from '../eventScheduler';
import {
  GuestCallError,
  isFlashMapper,
  isFlashOwner,
  isInterrupting,
  isInterruptRouter,
  type FlashBytes,
  type FlashMapper,
  type GuestCallOptions,
  type GuestCallResult,
  type InterruptingPeripheral,
  type InterruptRouter,
  type MmioEvent,
  type Peripheral,
  type RomCallEvent,
  type SimulatedClock,
} from './peripheral';
import { MMU_PAGE_SIZE, type EspSocConfig } from './soc';
import {
  ARG_REGISTER_BASE,
  buildRomTable,
  createRomMachineState,
  installRomData,
  ResetReason,
  UnimplementedRomCallError,
  type RomFunction,
  type RomMachineState,
} from '../esp32c3/romFunctions';
import { romTableFor } from '../esp32c6/romDispatch';
import type { EspApplicationImage } from '../esp32c3/espImage';

/**
 * Stack headroom reserved for a guest callback, below the caller's pointer.
 *
 * Large enough for the nested frames a comparator realistically builds, small
 * enough that a deep chain of nested callbacks still fits in either chip's RAM.
 */
const GUEST_CALL_STACK_GAP = 0x400;

/**
 * Return address used when the runtime calls a function inside the firmware.
 *
 * It points at the very start of the ROM window, where no implemented function
 * lives, so the program counter arriving there can only mean the guest call
 * finished. Using an address the firmware can never legitimately return to is
 * what makes the boundary unambiguous. Both parts place their mask ROM at
 * 0x40000000, so this is the same on each.
 */
export const GUEST_RETURN_SENTINEL = 0x40000004;

/**
 * The machine performance counter, in RISC-V's implementation-defined CSR
 * range. ESP-IDF reads it as the CPU cycle count on both parts.
 */
export const CSR_PCCR_MACHINE = 0x7e2;

export interface EspMachineOptions {
  /** Extra or replacement ROM entry points, for tests. */
  romFunctions?: RomFunction[];
  resetReason?: ResetReason;
  /** Called for every access to an address no peripheral claims. */
  onUnclaimedMmio?: (event: MmioEvent) => void;
  onRomCall?: (event: RomCallEvent) => void;
  /**
   * Whether a parked core may skip straight to its next event.
   *
   * On by default, because clocking cycles through a wait is pure waste. It is
   * switchable so the two paths can be compared against each other and shown
   * to produce the same timing.
   */
  idleFastForward?: boolean;
}

/**
 * Sparse byte memory.
 *
 * These address spaces are wide and mostly empty, so memory is allocated in
 * 64 KB pages on first touch rather than as one enormous array.
 */
class SparseMemory {
  private readonly pages = new Map<number, Uint8Array>();

  page(address: number): Uint8Array {
    const key = address >>> 16;
    let page = this.pages.get(key);
    if (!page) {
      page = new Uint8Array(0x10000);
      this.pages.set(key, page);
    }
    return page;
  }

  clear(): void {
    this.pages.clear();
  }
}

export class EspRiscvMachine implements Bus, SimulatedClock {
  readonly core: Rv32Core;
  readonly romState: RomMachineState;

  /**
   * Simulated time since power-on.
   *
   * This interpreter retires one instruction per step rather than modelling
   * either chip's pipeline, so time advances one CPU clock period per
   * instruction. That is an approximation of instruction timing, not of
   * behaviour: the clock rate is the one the firmware itself configured,
   * elapsed time is monotonic, and a ROM delay contributes the microseconds it
   * actually asked for. Sub-cycle accuracy is not claimed anywhere, and nothing
   * in the runtime depends on it.
   */
  private elapsedNanos = 0;

  get nanos(): number {
    return this.elapsedNanos;
  }

  /** Simulated microseconds since power-on, which is what firmware asks for. */
  get micros(): number {
    return this.elapsedNanos / 1000;
  }

  private readonly memory = new SparseMemory();
  private readonly romTable: Map<number, RomFunction>;
  private readonly peripherals: Peripheral[] = [];
  private readonly interruptSources: InterruptingPeripheral[] = [];
  private interruptRouter: InterruptRouter | undefined;
  private mmu: FlashMapper | undefined;
  private flash: FlashBytes | undefined;
  private pendingInterruptLines = 0;
  /** Simulated time at which a peripheral said its interrupt state may change. */
  private nextInterruptCheckNanos: number | undefined;
  private interruptsDirty = true;
  private readonly externalEventSources: TimedEventSource[] = [];

  /**
   * Latest simulated time this run may reach while fast-forwarding an idle
   * core. A runner asked for one slice of time sets it so a skip cannot
   * disappear far into the future and miss an input arriving meanwhile.
   */
  timeLimitNanos: number | undefined;

  /** True once nothing left can wake a parked machine. */
  stalled = false;

  /** How many times an idle wait was fast-forwarded, for measurement. */
  idleSkips = 0;
  private image: EspApplicationImage | null = null;

  /** Symbol names by address, for diagnostics. Populated from an ELF if one is available. */
  symbols = new Map<number, string>();

  constructor(
    readonly soc: EspSocConfig,
    private readonly options: EspMachineOptions = {},
  ) {
    // The chip picks the table. Two parts publish different functions at the
    // same ROM addresses, so looking an address up in a shared table would call
    // the wrong routine without ever faulting.
    this.romTable = new Map(romTableFor(soc.chip).entries);
    // A test may add or replace an entry point; nothing else may.
    for (const [address, entry] of buildRomTable(options.romFunctions ?? [])) this.romTable.set(address, entry);
    this.romState = createRomMachineState(options.resetReason ?? ResetReason.PowerOn);
    this.romState.cpuFrequencyMhz = soc.cpuMhz;
    this.romState.coexVersionAddress = soc.romData.coexVersionAddress;
    // The shared esprv_* and intr_matrix_set entry points write real registers,
    // and the two parts keep those registers in different blocks. Telling the
    // ROM state which chip it is on is what stops a C6 configuring the C3's
    // addresses and receiving no interrupts at all.
    this.romState.interruptLayout = {
      matrixBase: soc.interruptMatrixBase,
      sourceCount: soc.interruptSourceCount,
      cpu: {
        base: soc.cpuInterrupts.base,
        enable: soc.cpuInterrupts.enable,
        type: soc.cpuInterrupts.type,
        priorityBase: soc.cpuInterrupts.priorityBase,
        threshold: soc.cpuInterrupts.threshold,
      },
    };
    // The C6 is RV32IMAC; the C3 has no atomics.
    this.core = new Rv32Core(this, { atomics: soc.chip === 'esp32c6' });
    this.core.customCsrRead = (number_) => this.readChipCsr(number_);
    this.core.selectInterrupt = (mask) => this.chooseInterrupt(mask);
    this.core.customPendingInterrupts = () => this.pendingInterruptLines;
  }

  /**
   * The flash device the cache reads through, once one has been registered.
   *
   * Exposed because the C6's ROM publishes the whole flash driver, and those
   * entry points have to reach the same device the cache does — reading it
   * through the SPI1 registers instead would be driving the controller from
   * inside the ROM call that the controller's own driver made.
   */
  get flashDevice(): FlashBytes | undefined {
    return this.flash;
  }

  /** True when an address is inside this chip's mask-ROM window. */
  isRomAddress(address: number): boolean {
    const a = address >>> 0;
    return a >= this.soc.memory.rom.start && a < this.soc.memory.rom.end;
  }

  /**
   * The chip's own control registers, in the range RISC-V reserves for a chip
   * to define.
   *
   * `esp_cpu_get_cycle_count()` reads the performance counter, and ESP-IDF uses
   * the difference between two readings as a delay — `esp_random()` spins until
   * enough cycles have passed. A counter stuck at zero makes that spin for
   * ever, so this has to be a real, advancing count rather than storage.
   */
  private readChipCsr(number_: number): number | undefined {
    switch (number_) {
      case CSR_PCCR_MACHINE:
        return this.core.instructionsRetired | 0;
      default:
        return undefined;
    }
  }

  /**
   * Registers a peripheral. Later registrations win for overlapping ranges.
   *
   * A block that fills one of the machine's roles announces it with a marker
   * property, so the machine never has to know which class implements the flash
   * MMU on which chip — the C3's is a flat table of registers and the C6's is an
   * index/content pair, and neither fact reaches this method.
   */
  addPeripheral(peripheral: Peripheral): void {
    this.peripherals.push(peripheral);
    if (isInterruptRouter(peripheral)) this.interruptRouter = peripheral;
    if (isFlashMapper(peripheral)) this.mmu = peripheral;
    if (isFlashOwner(peripheral)) this.flash = peripheral.flash;
    if (isInterrupting(peripheral)) this.interruptSources.push(peripheral);
    // A new source could already be asserting, so the next step has to look.
    this.interruptsDirty = true;
  }

  /**
   * Names the interrupt router when it is not itself a peripheral.
   *
   * On the C3 the controller is one register block and announces itself when it
   * is added. The C6's spans two blocks at unrelated addresses, so the object
   * that reads both is not a peripheral and has to be named.
   */
  useInterruptRouter(router: InterruptRouter): void {
    this.interruptRouter = router;
    this.interruptsDirty = true;
  }

  /**
   * Tells the machine a source changed without a register write — bytes
   * arriving at a UART from the outside world, say — so the next step looks
   * rather than waiting for the next write or scheduled check.
   */
  interruptSourceChanged(): void {
    this.interruptsDirty = true;
  }

  // ------------------------------------------------------ interrupt delivery

  /**
   * Re-derives which CPU interrupt line is pending, and tells the core.
   *
   * Doing this after every instruction would be correct but wasteful, so it is
   * driven by the two things that can change the answer: a write to any
   * peripheral register, and simulated time reaching a moment a peripheral said
   * it would assert at. Nothing else can move an interrupt line, so nothing
   * else needs to trigger a look.
   */
  private refreshInterrupts(): void {
    this.interruptsDirty = false;
    const router = this.interruptRouter;
    if (!router) return;

    const asserted: number[] = [];
    let soonest: number | undefined;
    for (const source of this.interruptSources) {
      for (const number_ of source.assertedInterruptSources()) asserted.push(number_);
      const at = source.nextInterruptChangeNanos?.();
      if (at !== undefined && (soonest === undefined || at < soonest)) soonest = at;
    }
    this.nextInterruptCheckNanos = soonest;
    this.pendingInterruptLines = router.evaluate(asserted);

    // The controller has already applied routing and its own enable mask, so
    // what is left is what the CPU may take. It is mirrored into `mip` as well,
    // because that is where a debugger or a trace looks for it.
    this.core.setPendingMask(this.pendingInterruptLines);
  }

  /** Which line the controller would deliver, for the core to trap into. */
  private chooseInterrupt(pendingAndEnabled: number): number | undefined {
    return this.interruptRouter?.select(pendingAndEnabled);
  }

  peripheralAt(address: number): Peripheral | undefined {
    const a = address >>> 0;
    for (let i = this.peripherals.length - 1; i >= 0; i--) {
      const p = this.peripherals[i];
      if (a >= p.base && a < p.base + p.size) return p;
    }
    return undefined;
  }

  /**
   * Places an application image's segments at their own load addresses and
   * points the core at its own entry point.
   *
   * This is what the second-stage bootloader does on hardware. Nothing is
   * patched and no address is chosen by this runtime.
   */
  loadImage(image: EspApplicationImage): void {
    this.image = image;
    this.memory.clear();
    this.elapsedNanos = 0;
    const mmu = this.mmu;
    if (!mmu) {
      throw new Error(
        `This ${this.soc.displayName} machine has no flash MMU. Cache-mapped code and constants cannot be reached without one.`,
      );
    }
    // The flash MMU maps the application partition into the IROM and DROM
    // windows, so the whole image file — header included — is visible there,
    // not just the segment payloads. ESP-IDF's cpu_start re-reads that header
    // to validate the image it is running, and reports "Invalid app image
    // header" if it is missing.
    //
    // A flash-mapped segment appears at its load address, and it sits at a
    // known offset inside the file, so the file's own start is visible at
    // `loadAddress - fileOffset`. Mapping from there reproduces what the MMU
    // does without needing to model page tables.
    for (const segment of image.segments) {
      if (!this.isCacheMapped(segment.loadAddress)) continue;
      // The flash offset this segment's bytes live at: the application starts
      // at its partition offset, and the segment sits where the image put it.
      const flashAddress = this.soc.applicationFlashOffset + segment.fileOffset;
      // The mapping is by whole pages, so it starts at the page containing the
      // segment and covers every page the segment reaches into.
      const firstPage = Math.floor(flashAddress / MMU_PAGE_SIZE);
      const pages = Math.ceil(((flashAddress % MMU_PAGE_SIZE) + segment.data.length) / MMU_PAGE_SIZE);
      const firstEntry = mmu.entryOf(segment.loadAddress);
      for (let i = 0; i < pages; i++) mmu.map(firstEntry + i, firstPage + i);
    }
    // Segment payloads are written after the mapping so a RAM segment always
    // wins over anything the mapping happened to cover.
    for (const segment of image.segments) {
      for (let i = 0; i < segment.data.length; i++) this.writeByte(segment.loadAddress + i, segment.data[i]);
    }
    // The ROM publishes constants the application reads directly, so they have
    // to exist before it runs.
    const flashBytes = this.flash?.bytes.length;
    installRomData(this, this.soc.romData, flashBytes ? { sizeBytes: flashBytes, jedecId: 0xc84016 } : undefined);
    this.core.reset(image.entryPoint);
    // The application is entered on the ROM's stack, exactly as it would be on
    // hardware. x2 is sp in the RISC-V calling convention.
    this.core.registers[2] = this.soc.romStackTop | 0;
  }

  /** Returns the machine to its power-on state and boots the same image again. */
  reset(): void {
    this.elapsedNanos = 0;
    this.stalled = false;
    this.idleSkips = 0;
    this.pendingInterruptLines = 0;
    this.nextInterruptCheckNanos = undefined;
    this.interruptsDirty = true;
    this.romState.cpuFrequencyMhz = this.soc.cpuMhz;
    this.romState.pendingDelayUs = 0;
    for (const peripheral of this.peripherals) peripheral.reset?.();
    this.romState.regi2c.clear();
    // Whatever a chip's own ROM was keeping - the C6's heap among it - goes
    // with the reset, or a rebooted board would inherit the old one's
    // allocations.
    this.romState.chipState.clear();
    this.romState.cache.iCacheEnabled = false;
    this.romState.cache.iCacheFrozen = false;
    this.romState.cache.iromMmuSize = 0;
    this.romState.cache.dromMmuSize = 0;
    if (this.image) this.loadImage(this.image);
  }

  /**
   * Executes one instruction, dispatching a ROM call if the program counter has
   * entered the mask ROM.
   *
   * Returns the bytes the instruction occupied, or 0 for a ROM call, so a
   * caller can advance a cycle counter.
   */
  step(): number {
    if (
      this.interruptsDirty ||
      (this.nextInterruptCheckNanos !== undefined && this.elapsedNanos >= this.nextInterruptCheckNanos)
    ) {
      this.refreshInterrupts();
    }
    // A core parked on a wait-for-interrupt cannot change anything, and nothing
    // else will either until some source acts. Rather than clocking millions of
    // cycles through the wait, jump straight to the moment something happens.
    if (this.options.idleFastForward !== false && this.core.waiting && this.pendingInterruptLines === 0) {
      const skipped = this.skipIdleTime();
      if (skipped) return 0;
    }
    const period = 1000 / Math.max(1, this.romState.cpuFrequencyMhz);
    const pc = this.core.pc >>> 0;
    if (this.isRomAddress(pc)) {
      this.dispatchRomCall(pc);
      // A ROM routine runs natively in no time at all, but the firmware
      // measured a delay it asked for, so that delay is real simulated time.
      this.elapsedNanos += period + this.romState.pendingDelayUs * 1000;
      this.romState.pendingDelayUs = 0;
      return 0;
    }
    // A parked core is still clocked; without this a WFI would stop time and
    // the interrupt it waits for could never arrive.
    this.elapsedNanos += period;
    return this.core.step();
  }

  /**
   * Simulated time at which something will next happen on its own.
   *
   * Exposed so a scheduler above the machine can align to it. Same sources the
   * idle skip consults, so the two cannot disagree.
   */
  nextEventNanos(): number | undefined {
    let soonest: number | undefined;
    for (const source of this.eventSources()) {
      const at = source.nextEventNanos();
      if (at === undefined) continue;
      const bounded = Math.max(at, this.elapsedNanos);
      if (soonest === undefined || bounded < soonest) soonest = bounded;
    }
    return soonest;
  }

  /**
   * Advances simulated time to the next thing that can wake the machine.
   *
   * Only ever called with the core genuinely parked, so no instruction is
   * skipped and no guest state is guessed at: the only thing that moves is the
   * clock, and every peripheral derives its state from the clock anyway.
   *
   * Returns true when time moved, so the caller can treat the skip as one
   * step's worth of work.
   */
  private skipIdleTime(): boolean {
    const plan = planIdleSkip(this.eventSources(), this.elapsedNanos, this.timeLimitNanos);
    switch (plan.kind) {
      case 'advanced':
      case 'limited':
        this.elapsedNanos = plan.to;
        this.idleSkips++;
        // Whatever is due at the new time has to be looked at before the core
        // decides whether it may leave the wait.
        this.refreshInterrupts();
        return true;
      case 'due':
        this.refreshInterrupts();
        return false;
      case 'stalled':
        // Nothing will ever wake it. Clocking cycles through that changes
        // nothing, so the caller's own budget ends the run and reports it.
        this.stalled = true;
        return false;
    }
  }

  /**
   * Everything that can act on its own once the processor stops.
   *
   * Peripherals answer for themselves; the extra source covers inputs a host
   * has queued for a future moment, such as a button press scheduled on the
   * canvas.
   */
  private *eventSources(): Generator<TimedEventSource> {
    for (const source of this.interruptSources) {
      const at = source.nextInterruptChangeNanos?.bind(source);
      if (at) yield { nextEventNanos: at };
    }
    for (const source of this.externalEventSources) yield source;
  }

  /**
   * Registers something outside the chip that will act at a known time.
   *
   * The canvas uses this for input it has scheduled, so a parked machine still
   * wakes for it rather than sleeping through it.
   */
  addEventSource(source: TimedEventSource): void {
    this.externalEventSources.push(source);
  }

  /**
   * Runs a ROM function natively and returns to the caller through `ra`.
   *
   * The firmware still makes a real call with real arguments and still observes
   * a real result; only the implementation is native rather than emitted
   * machine code.
   */
  private dispatchRomCall(pc: number): void {
    const entry = this.romTable.get(pc);
    const returnAddress = this.core.registers[1] >>> 0;
    if (!entry) {
      throw new UnimplementedRomCallError(pc, this.symbols.get(pc), returnAddress, this.soc.displayName);
    }
    const args = [0, 1, 2, 3, 4, 5].map((i) => this.core.registers[ARG_REGISTER_BASE + i] | 0);
    const result = entry.handler({
      args,
      bus: this,
      machine: this.romState,
      registers: this.core.registers,
      callGuest: (target, callArgs, callOptions) => this.callGuestFunction(target, callArgs, callOptions),
    });
    if (typeof result === 'number') this.core.registers[ARG_REGISTER_BASE] = result | 0;
    this.options.onRomCall?.({
      address: pc,
      symbol: entry.name,
      args,
      result: typeof result === 'number' ? result : undefined,
      pc: returnAddress,
    });
    this.core.pc = returnAddress;
  }

  // --------------------------------------------------------- guest callbacks

  /**
   * Calls a function inside the firmware and returns its result.
   *
   * Some ROM functions take a firmware function pointer — `qsort` takes a
   * comparator — so an independently implemented ROM routine has to be able to
   * run guest code and use the answer. That is not a shortcut: the comparator
   * really is the firmware's own, and it really does execute.
   *
   * The whole register file is saved and restored around the call, so the
   * interrupted ROM call resumes with exactly the state it had. The callback
   * gets its own stack space below the current stack pointer, keeping its
   * frames clear of the caller's. Nesting works because each level saves its
   * own copy.
   *
   * Every exit is bounded and explicit: the sentinel return, an instruction
   * budget, or a fault — never an open-ended loop.
   */
  callGuestFunction(address: number, args: number[] = [], options: GuestCallOptions = {}): GuestCallResult {
    const maxInstructions = options.maxInstructions ?? 2_000_000;
    const saved = Int32Array.from(this.core.registers);
    const savedPc = this.core.pc;
    const savedWaiting = this.core.waiting;

    // Leave a gap below the caller's stack so the callback's frames cannot
    // overwrite anything the interrupted function still needs, and keep the
    // pointer 16-byte aligned as the RISC-V ABI requires.
    const stack = ((saved[2] >>> 0) - GUEST_CALL_STACK_GAP) & ~0xf;

    this.core.registers[1] = GUEST_RETURN_SENTINEL | 0;
    this.core.registers[2] = stack | 0;
    for (let i = 0; i < args.length && i < 8; i++) this.core.registers[ARG_REGISTER_BASE + i] = args[i] | 0;
    this.core.pc = (address >>> 0) & ~1;
    this.core.waiting = false;

    let instructions = 0;
    let value = 0;
    let high = 0;
    try {
      while ((this.core.pc >>> 0) !== GUEST_RETURN_SENTINEL) {
        if (instructions >= maxInstructions) {
          throw new GuestCallError(
            `A firmware callback at 0x${(address >>> 0).toString(16)} did not return within ${maxInstructions} ` +
              'instructions. The sketch may contain an endless comparison function.',
          );
        }
        // Nested ROM calls are dispatched here too, so a callback may itself
        // call a ROM function that calls back into firmware again.
        this.step();
        instructions++;
      }
      value = this.core.registers[ARG_REGISTER_BASE] | 0;
      high = this.core.registers[ARG_REGISTER_BASE + 1] | 0;
    } finally {
      this.core.registers.set(saved);
      this.core.pc = savedPc;
      this.core.waiting = savedWaiting;
    }
    return { value, high, instructions };
  }

  // ------------------------------------------------------------------ bus

  /**
   * True when an access is a register access rather than memory.
   *
   * Asks the SoC's list of MMIO windows rather than one hardcoded range,
   * because it is not one range on every part: the C6's CPU interrupt
   * controller is a PLIC at 0x20001000, far below the peripheral window. With a
   * single window every access to it fell through to plain RAM, where the
   * writes stuck and read back — so nothing faulted, and the interrupt
   * controller the machine had built was simply never spoken to.
   */
  private isPeripheralAddress(address: number): boolean {
    const a = address >>> 0;
    for (const window of this.soc.mmio) {
      if (a >= window.start && a < window.end) return true;
    }
    return false;
  }

  private writeByte(address: number, value: number): void {
    this.memory.page(address >>> 0)[(address >>> 0) & 0xffff] = value & 0xff;
  }

  /**
   * True for the windows the cache maps flash into.
   *
   * The C3 has two distinct ones; the C6 has a single window serving both
   * buses, which is why this asks the memory map rather than assuming two.
   */
  private isCacheMapped(address: number): boolean {
    const a = address >>> 0;
    const { drom, irom } = this.soc.memory;
    return (a >= drom.start && a < drom.end) || (a >= irom.start && a < irom.end);
  }

  private readByte(address: number): number {
    const a = address >>> 0;
    // The cache windows hold nothing of their own: every byte read from them
    // comes from the flash page the MMU points at. Reading them out of a copy
    // made at load time would go stale the moment firmware remapped a page or
    // wrote to the flash, and would leave cache2phys with nothing to invert.
    if (this.flash && this.mmu && this.isCacheMapped(a)) {
      const physical = this.mmu.translate(a);
      // An unmapped page reads as the cache's own miss value rather than as
      // whatever a neighbouring page happens to hold.
      if (physical === undefined) return 0;
      return this.flash.bytes[physical % this.flash.bytes.length];
    }
    return this.memory.page(a)[a & 0xffff];
  }

  /**
   * Peripheral registers are 32 bits wide and are accessed as words even when
   * firmware reads a byte out of one, so a narrow access reads the containing
   * word and extracts from it.
   */
  private readPeripheral(address: number): number {
    const a = address >>> 0;
    const peripheral = this.peripheralAt(a);
    if (peripheral) return peripheral.readUint32(a - peripheral.base) >>> 0;
    this.options.onUnclaimedMmio?.({ address: a, value: 0, write: false, peripheral: undefined, pc: this.core.pc >>> 0 });
    // An unmodelled register reads as zero. Firmware polling a status bit that
    // never sets will hang rather than proceed on invented data, which is the
    // honest failure and is visible through the unclaimed-MMIO callback.
    return 0;
  }

  private writePeripheral(address: number, value: number): void {
    const a = address >>> 0;
    const peripheral = this.peripheralAt(a);
    if (peripheral) {
      peripheral.writeUint32(a - peripheral.base, value >>> 0);
      // Any peripheral write can enable, mask, route, raise or clear an
      // interrupt, so the next step re-derives what is pending.
      this.interruptsDirty = true;
      return;
    }
    this.options.onUnclaimedMmio?.({ address: a, value: value >>> 0, write: true, peripheral: undefined, pc: this.core.pc >>> 0 });
  }

  readUint8(address: number): number {
    if (this.isPeripheralAddress(address)) return (this.readPeripheral(address & ~3) >>> ((address & 3) * 8)) & 0xff;
    return this.readByte(address);
  }

  readUint16(address: number): number {
    if (this.isPeripheralAddress(address)) return (this.readPeripheral(address & ~3) >>> ((address & 2) * 8)) & 0xffff;
    return this.readByte(address) | (this.readByte(address + 1) << 8);
  }

  readUint32(address: number): number {
    if (this.isPeripheralAddress(address)) return this.readPeripheral(address);
    return (
      (this.readByte(address) |
        (this.readByte(address + 1) << 8) |
        (this.readByte(address + 2) << 16) |
        (this.readByte(address + 3) << 24)) >>>
      0
    );
  }

  writeUint8(address: number, value: number): void {
    if (this.isPeripheralAddress(address)) {
      const shift = (address & 3) * 8;
      const word = this.readPeripheral(address & ~3);
      this.writePeripheral(address & ~3, (word & ~(0xff << shift)) | ((value & 0xff) << shift));
      return;
    }
    this.writeByte(address, value);
  }

  writeUint16(address: number, value: number): void {
    if (this.isPeripheralAddress(address)) {
      const shift = (address & 2) * 8;
      const word = this.readPeripheral(address & ~3);
      this.writePeripheral(address & ~3, (word & ~(0xffff << shift)) | ((value & 0xffff) << shift));
      return;
    }
    this.writeByte(address, value);
    this.writeByte(address + 1, value >> 8);
  }

  writeUint32(address: number, value: number): void {
    if (this.isPeripheralAddress(address)) {
      this.writePeripheral(address, value);
      return;
    }
    this.writeByte(address, value);
    this.writeByte(address + 1, value >> 8);
    this.writeByte(address + 2, value >> 16);
    this.writeByte(address + 3, value >> 24);
  }
}
