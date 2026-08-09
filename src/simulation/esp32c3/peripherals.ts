// ESP32-C3 peripherals, modelled from the public technical reference manual.
//
// Two kinds of register appear in this chip, and they need different
// treatment:
//
//   * Configuration registers, which simply hold what firmware wrote. A
//     register file models them exactly, and returning zero instead would make
//     firmware read back a configuration it never asked for.
//   * Status registers, which hardware sets. These need real behaviour, and
//     they are where a simulation either works or hangs: firmware polls a
//     ready bit and spins for ever if nothing ever sets it.
//
// So the base class below stores writes, and each peripheral overrides only
// the registers whose value the hardware itself produces. Anything not
// modelled reads back what was written, which is the honest default — and a
// status bit nobody sets makes the firmware hang visibly rather than continue
// on invented data.

import type { Peripheral, SimulatedClock } from './esp32c3Machine';
import { RegisterFile } from './registerFile';
import { SpiMemController, SPI_MEM_BASE } from './spiMem';
import { InterruptMatrix, INTERRUPT_SOURCE, SystemRegisters, type InterruptingPeripheral } from './interrupts';

export { RegisterFile } from './registerFile';
import type { SerialNorFlash } from './spiFlash';

/** Documented ESP32-C3 peripheral base addresses. */
export const PERIPHERAL_BASE = {
  uart0: 0x60000000,
  uart1: 0x60010000,
  timg0: 0x6001f000,
  timg1: 0x60020000,
  systimer: 0x60023000,
  gpio: 0x60004000,
  ioMux: 0x60009000,
  rtcCntl: 0x60008000,
  systemRegisters: 0x600c0000,
  interruptMatrix: 0x600c2000,
  extMem: 0x600c4000,
  apbCtrl: 0x60026000,
} as const;

// ------------------------------------------------------------- timer group

const TIMG_RTCCALICFG = 0x68;
const TIMG_RTCCALICFG1 = 0x6c;
const TIMG_RTCCALICFG2 = 0x80;

const RTC_CALI_START = 1 << 31;
const RTC_CALI_RDY = 1 << 15;
const RTC_CALI_MAX_SHIFT = 16;
const RTC_CALI_MAX_MASK = 0x7fff;
const RTC_CALI_CLK_SEL_SHIFT = 13;
const RTC_CALI_VALUE_SHIFT = 7;

/**
 * Nominal frequencies of the clocks the calibration unit can measure.
 *
 * These are the ESP32-C3's documented sources. The RC oscillators are
 * deliberately approximate on real silicon — measuring them is the entire
 * reason this calibration hardware exists — so nominal values are the honest
 * choice here rather than invented precision.
 */
export const CALIBRATION_CLOCK_HZ: Record<number, number> = {
  0: 136_000, // RTC_SLOW_CLK, the internal RC oscillator
  1: 32_768, // an external 32.768 kHz crystal
  2: 17_500_000, // RC_FAST divided down, as the C3 presents it for calibration
};

/** XTAL frequency on every ESP32-C3 module. */
export const XTAL_HZ = 40_000_000;

/**
 * Timer group 0, including the RTC clock calibration unit.
 *
 * ESP-IDF startup calibrates the slow clock before it can set up timekeeping,
 * and it does so by starting a measurement here and polling for the ready bit.
 * The measurement counts XTAL cycles over a requested number of slow-clock
 * cycles, so the value is derived from the two frequencies rather than being a
 * constant: change the requested cycle count and the answer changes with it.
 *
 * The measurement completes immediately. On hardware it takes as long as the
 * requested cycles, but nothing observable depends on that delay — firmware
 * polls for the ready bit and then reads the value.
 */
export class TimerGroup extends RegisterFile {
  constructor(name: string, base: number) {
    super(name, base, 0x1000);
  }

  protected override onWrite(offset: number, value: number): void {
    if (offset !== TIMG_RTCCALICFG) return;
    if ((value & RTC_CALI_START) === 0) {
      // Clearing START clears the result, as the hardware does.
      this.registers.set(TIMG_RTCCALICFG, value & ~RTC_CALI_RDY);
      return;
    }
    const cycles = (value >>> RTC_CALI_MAX_SHIFT) & RTC_CALI_MAX_MASK;
    const clockSelect = (value >>> RTC_CALI_CLK_SEL_SHIFT) & 0x3;
    const sourceHz = CALIBRATION_CLOCK_HZ[clockSelect] ?? CALIBRATION_CLOCK_HZ[0];
    // XTAL cycles elapsed while the measured clock ran `cycles` times.
    const measured = Math.round((cycles * XTAL_HZ) / sourceHz);
    this.registers.set(TIMG_RTCCALICFG1, (Math.min(measured, 0x1ffffff) << RTC_CALI_VALUE_SHIFT) >>> 0);
    // Report the measurement as finished.
    this.registers.set(TIMG_RTCCALICFG, (value | RTC_CALI_RDY) >>> 0);
    // No timeout occurred.
    this.registers.set(TIMG_RTCCALICFG2, this.peek(TIMG_RTCCALICFG2) & ~(1 << 31));
  }

  /** The last calibration result, in XTAL cycles, for tests. */
  get calibrationValue(): number {
    return this.peek(TIMG_RTCCALICFG1) >>> RTC_CALI_VALUE_SHIFT;
  }
}

// -------------------------------------------------------------- system timer

/**
 * The ESP32-C3's system timer, which is the chip's timebase.
 *
 * It is two 52-bit up-counters and three comparators. ESP-IDF reads a counter
 * by writing an UPDATE bit and polling a VALUE_VALID bit — a real handshake,
 * not a plain register read — and FreeRTOS drives its tick from a comparator.
 * A register file cannot stand in for either: the poll never completes because
 * nothing sets VALUE_VALID, and startup spins in
 * `systimer_hal_get_counter_value` for ever.
 *
 * Offsets and bit positions are the documented ones from the C3 technical
 * reference manual. The counters run at 16 MHz: the source is the 40 MHz
 * crystal through the chip's fixed divider of 2.5.
 */
const SYSTIMER_CONF = 0x00;
const SYSTIMER_UNIT_OP = [0x04, 0x08];
const SYSTIMER_UNIT_LOAD_HI = [0x0c, 0x14];
const SYSTIMER_UNIT_LOAD_LO = [0x10, 0x18];
const SYSTIMER_TARGET_HI = [0x1c, 0x24, 0x2c];
const SYSTIMER_TARGET_LO = [0x20, 0x28, 0x30];
const SYSTIMER_TARGET_CONF = [0x34, 0x38, 0x3c];
const SYSTIMER_UNIT_VALUE_HI = [0x40, 0x48];
const SYSTIMER_UNIT_VALUE_LO = [0x44, 0x4c];
const SYSTIMER_COMP_LOAD = [0x50, 0x54, 0x58];
const SYSTIMER_UNIT_LOAD = [0x5c, 0x60];
const SYSTIMER_INT_ENA = 0x64;
const SYSTIMER_INT_RAW = 0x68;
const SYSTIMER_INT_CLR = 0x6c;
const SYSTIMER_INT_ST = 0x70;

const UNIT_VALUE_VALID = 1 << 29;
const UNIT_UPDATE = 1 << 30;
const UNIT_WORK_EN = [1 << 30, 1 << 29];
const TARGET_WORK_EN = [1 << 24, 1 << 23, 1 << 22];
const TARGET_PERIOD_MASK = 0x03ffffff;
const TARGET_PERIOD_MODE = 1 << 30;
const TARGET_UNIT_SEL = 1 << 31;

/** The counter's high half is 20 bits wide, so the whole counter is 52. */
const SYSTIMER_HI_MASK = 0xfffff;

/** Counter frequency: the 40 MHz crystal through the chip's fixed 2.5 divider. */
export const SYSTIMER_TICK_HZ = 16_000_000;

/**
 * Reset value of SYSTIMER_CONF: unit 0 counting, and both of unit 1's
 * stall-with-core bits set, exactly as the manual documents the defaults.
 */
const SYSTIMER_CONF_RESET = UNIT_WORK_EN[0] | (1 << 25) | (1 << 26);

interface SysTimerUnit {
  /** Counter value at the moment it was last loaded or stopped. */
  offset: number;
  /** Simulated nanoseconds when it started running from that offset. */
  since: number;
  running: boolean;
}

interface SysTimerComparator {
  /** Absolute counter value this comparator next fires at. */
  next: number;
  /** Ticks between repeats, or 0 when the comparator is one-shot. */
  period: number;
  armed: boolean;
}

export class SysTimer extends RegisterFile implements InterruptingPeripheral {
  private readonly units: SysTimerUnit[] = [];
  private readonly comparators: SysTimerComparator[] = [];

  constructor(private readonly clock: SimulatedClock) {
    super('systimer', PERIPHERAL_BASE.systimer, 0x1000);
    this.reset();
  }

  override reset(): void {
    super.reset();
    this.registers.set(SYSTIMER_CONF, SYSTIMER_CONF_RESET >>> 0);
    this.units.length = 0;
    for (let i = 0; i < 2; i++) {
      this.units.push({ offset: 0, since: this.clock.nanos, running: (SYSTIMER_CONF_RESET & UNIT_WORK_EN[i]) !== 0 });
    }
    this.comparators.length = 0;
    for (let i = 0; i < 3; i++) this.comparators.push({ next: 0, period: 0, armed: false });
  }

  /** Current value of a counter, in systimer ticks. */
  counter(unit: number): number {
    const u = this.units[unit];
    if (!u.running) return u.offset;
    return u.offset + Math.floor(((this.clock.nanos - u.since) * SYSTIMER_TICK_HZ) / 1e9);
  }

  /**
   * Bits set in INT_RAW right now.
   *
   * Comparators are evaluated on demand rather than on a schedule: the answer
   * is a function of the counter, so asking at the moment of the read gives the
   * same result as updating continuously, without stepping the peripheral.
   */
  private rawInterrupts(): number {
    const conf = this.peek(SYSTIMER_CONF);
    let raw = this.peek(SYSTIMER_INT_RAW);
    for (let i = 0; i < 3; i++) {
      const comparator = this.comparators[i];
      if (!comparator.armed || (conf & TARGET_WORK_EN[i]) === 0) continue;
      const unit = (this.peek(SYSTIMER_TARGET_CONF[i]) & TARGET_UNIT_SEL) !== 0 ? 1 : 0;
      const value = this.counter(unit);
      if (value < comparator.next) continue;
      raw |= 1 << i;
      if (comparator.period > 0) {
        // Keep the repeat aligned to the original phase rather than to the
        // moment it was noticed, so a late read cannot make the tick drift.
        const missed = Math.floor((value - comparator.next) / comparator.period) + 1;
        comparator.next += missed * comparator.period;
      } else {
        comparator.armed = false;
      }
    }
    this.registers.set(SYSTIMER_INT_RAW, raw >>> 0);
    return raw >>> 0;
  }

  /** Interrupt lines this peripheral is currently asserting. */
  pendingInterrupts(): number {
    return (this.rawInterrupts() & this.peek(SYSTIMER_INT_ENA)) >>> 0;
  }

  assertedInterruptSources(): number[] {
    const pending = this.pendingInterrupts();
    const sources: number[] = [];
    for (let i = 0; i < 3; i++) {
      if ((pending & (1 << i)) !== 0) sources.push(INTERRUPT_SOURCE.systimerTarget0 + i);
    }
    return sources;
  }

  /**
   * When the next armed comparator reaches its target.
   *
   * Comparators fire as time passes rather than when firmware writes, so the
   * machine cannot know to look without being told. Returning the moment it
   * next needs to look — rather than making it check after every instruction —
   * is what keeps interrupt delivery both exact and cheap.
   */
  nextInterruptChangeNanos(): number | undefined {
    const conf = this.peek(SYSTIMER_CONF);
    const enabled = this.peek(SYSTIMER_INT_ENA);
    let soonest: number | undefined;
    for (let i = 0; i < 3; i++) {
      const comparator = this.comparators[i];
      if (!comparator.armed || (conf & TARGET_WORK_EN[i]) === 0 || (enabled & (1 << i)) === 0) continue;
      const unit = (this.peek(SYSTIMER_TARGET_CONF[i]) & TARGET_UNIT_SEL) !== 0 ? 1 : 0;
      const remaining = comparator.next - this.counter(unit);
      // Already past its target: the machine should look immediately.
      const at = remaining <= 0 ? this.clock.nanos : this.clock.nanos + (remaining * 1e9) / SYSTIMER_TICK_HZ;
      if (soonest === undefined || at < soonest) soonest = at;
    }
    return soonest;
  }

  protected override onRead(offset: number): number | undefined {
    if (offset === SYSTIMER_INT_RAW) return this.rawInterrupts();
    if (offset === SYSTIMER_INT_ST) return this.pendingInterrupts();
    // VALUE_HI/LO hold the snapshot the last UPDATE latched, so they read back
    // as plain storage. INT_CLR is write-only and reads as zero.
    if (offset === SYSTIMER_INT_CLR) return 0;
    return undefined;
  }

  protected override onWrite(offset: number, value: number): void {
    if (offset === SYSTIMER_CONF) {
      for (let i = 0; i < 2; i++) this.setUnitRunning(i, (value & UNIT_WORK_EN[i]) !== 0);
      return;
    }

    const opUnit = SYSTIMER_UNIT_OP.indexOf(offset);
    if (opUnit >= 0) {
      if ((value & UNIT_UPDATE) === 0) {
        this.registers.set(offset, value & ~UNIT_VALUE_VALID);
        return;
      }
      // Latch the counter and report the snapshot ready. On hardware this takes
      // a few cycles; nothing observable depends on the delay, and firmware
      // reaches the same state either way.
      const snapshot = this.counter(opUnit);
      this.registers.set(SYSTIMER_UNIT_VALUE_LO[opUnit], snapshot >>> 0);
      this.registers.set(SYSTIMER_UNIT_VALUE_HI[opUnit], Math.floor(snapshot / 0x100000000) & SYSTIMER_HI_MASK);
      this.registers.set(offset, (value | UNIT_VALUE_VALID) >>> 0);
      return;
    }

    const loadUnit = SYSTIMER_UNIT_LOAD.indexOf(offset);
    if (loadUnit >= 0 && (value & 1) !== 0) {
      const hi = this.peek(SYSTIMER_UNIT_LOAD_HI[loadUnit]) & SYSTIMER_HI_MASK;
      const lo = this.peek(SYSTIMER_UNIT_LOAD_LO[loadUnit]) >>> 0;
      this.units[loadUnit].offset = hi * 0x100000000 + lo;
      this.units[loadUnit].since = this.clock.nanos;
      return;
    }

    const comparator = SYSTIMER_COMP_LOAD.indexOf(offset);
    if (comparator >= 0 && (value & 1) !== 0) {
      this.armComparator(comparator);
      return;
    }

    if (offset === SYSTIMER_INT_CLR) {
      this.registers.set(SYSTIMER_INT_RAW, this.peek(SYSTIMER_INT_RAW) & ~value);
      this.registers.set(SYSTIMER_INT_CLR, 0);
    }
  }

  private setUnitRunning(index: number, running: boolean): void {
    const unit = this.units[index];
    if (unit.running === running) return;
    // Freeze at the value the counter had reached, so stopping and restarting
    // does not lose or invent time.
    if (!running) unit.offset = this.counter(index);
    else unit.since = this.clock.nanos;
    unit.running = running;
  }

  /**
   * Applies a comparator's target registers, which the manual requires a
   * COMPn_LOAD write to do — writing the target alone changes nothing.
   */
  private armComparator(index: number): void {
    const conf = this.peek(SYSTIMER_TARGET_CONF[index]);
    const unit = (conf & TARGET_UNIT_SEL) !== 0 ? 1 : 0;
    const comparator = this.comparators[index];
    if ((conf & TARGET_PERIOD_MODE) !== 0) {
      comparator.period = conf & TARGET_PERIOD_MASK;
      // A period comparator counts from now, not from an absolute target.
      comparator.next = this.counter(unit) + comparator.period;
    } else {
      comparator.period = 0;
      const hi = this.peek(SYSTIMER_TARGET_HI[index]) & SYSTIMER_HI_MASK;
      comparator.next = hi * 0x100000000 + (this.peek(SYSTIMER_TARGET_LO[index]) >>> 0);
    }
    comparator.armed = true;
  }
}

// ------------------------------------------------------- system configuration

/** Offset of the random number register within the system configuration block. */
const SYSCON_RND_DATA = 0x0b0;

/**
 * The system configuration block, which is also where the random number
 * generator presents its output.
 *
 * On hardware that output comes from amplified analog noise. A simulator has
 * no physical noise source, so this produces a deterministic sequence instead:
 * a run reproduces exactly, which is what makes a failing simulation
 * debuggable, and inventing a claim of true randomness would be worse than
 * saying plainly that this is not one.
 *
 * That distinction matters beyond debugging. Firmware that generates keys or
 * nonces from `esp_random()` gets values CircuitDesk can reproduce, so results
 * from a simulated run say nothing about the security of the same sketch on
 * real hardware.
 *
 * The sequence itself is xorshift32, which is full-period over its 32-bit
 * state, so successive reads never repeat within a run.
 */
export class SystemConfiguration extends RegisterFile {
  private randomState = 0x2545f491;

  constructor() {
    super('apb_ctrl', PERIPHERAL_BASE.apbCtrl, 0x1000);
  }

  override reset(): void {
    super.reset();
    this.randomState = 0x2545f491;
  }

  protected override onRead(offset: number): number | undefined {
    if (offset !== SYSCON_RND_DATA) return undefined;
    let x = this.randomState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.randomState = x | 0;
    return this.randomState >>> 0;
  }
}

/**
 * Builds the peripheral set an ESP32-C3 machine needs to start.
 *
 * Blocks are added as startup proves it touches them; each one is either
 * modelled or left as a register file, and nothing is added speculatively.
 */
export function createStartupPeripherals(clock: SimulatedClock, flash?: SerialNorFlash): Peripheral[] {
  return [
    // SPI0 belongs to the cache. Firmware configures it but runs no
    // transactions through it, so its registers only need to read back.
    new RegisterFile('spi0', SPI_MEM_BASE.spi0, 0x1000),
    ...(flash ? [new SpiMemController(flash)] : []),
    new TimerGroup('timg0', PERIPHERAL_BASE.timg0),
    new TimerGroup('timg1', PERIPHERAL_BASE.timg1),
    new RegisterFile('rtc_cntl', PERIPHERAL_BASE.rtcCntl, 0x1000),
    // The system block spans everything up to the interrupt matrix, and it
    // carries the software interrupts a CPU raises on itself.
    new SystemRegisters(PERIPHERAL_BASE.systemRegisters, PERIPHERAL_BASE.interruptMatrix - PERIPHERAL_BASE.systemRegisters),
    new InterruptMatrix(),
    new RegisterFile('extmem', PERIPHERAL_BASE.extMem, 0x1000),
    new SystemConfiguration(),
    new SysTimer(clock),
    new RegisterFile('io_mux', PERIPHERAL_BASE.ioMux, 0x1000),
  ];
}
