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

import type { Peripheral } from './esp32c3Machine';

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

/**
 * A peripheral whose registers hold whatever was written to them.
 *
 * Subclasses override `onWrite` and `onRead` for the registers hardware
 * drives; everything else behaves as storage.
 */
export class RegisterFile implements Peripheral {
  protected readonly registers = new Map<number, number>();

  constructor(
    readonly name: string,
    readonly base: number,
    readonly size: number,
  ) {}

  readUint32(offset: number): number {
    const handled = this.onRead(offset);
    if (handled !== undefined) return handled >>> 0;
    return (this.registers.get(offset) ?? 0) >>> 0;
  }

  writeUint32(offset: number, value: number): void {
    this.registers.set(offset, value >>> 0);
    this.onWrite(offset, value >>> 0);
  }

  /** Return a value to override plain storage, or undefined to use it. */
  protected onRead(_offset: number): number | undefined {
    return undefined;
  }

  protected onWrite(_offset: number, _value: number): void {}

  reset(): void {
    this.registers.clear();
  }

  /** Raw stored value, for tests and diagnostics. */
  peek(offset: number): number {
    return (this.registers.get(offset) ?? 0) >>> 0;
  }
}

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

/**
 * Builds the peripheral set an ESP32-C3 machine needs to start.
 *
 * Blocks are added as startup proves it touches them; each one is either
 * modelled or left as a register file, and nothing is added speculatively.
 */
export function createStartupPeripherals(): Peripheral[] {
  return [
    new TimerGroup('timg0', PERIPHERAL_BASE.timg0),
    new TimerGroup('timg1', PERIPHERAL_BASE.timg1),
    new RegisterFile('rtc_cntl', PERIPHERAL_BASE.rtcCntl, 0x1000),
    new RegisterFile('system', PERIPHERAL_BASE.systemRegisters, 0x1000),
    new RegisterFile('interrupt_matrix', PERIPHERAL_BASE.interruptMatrix, 0x1000),
    new RegisterFile('extmem', PERIPHERAL_BASE.extMem, 0x1000),
    new RegisterFile('apb_ctrl', PERIPHERAL_BASE.apbCtrl, 0x1000),
    new RegisterFile('systimer', PERIPHERAL_BASE.systimer, 0x1000),
    new RegisterFile('io_mux', PERIPHERAL_BASE.ioMux, 0x1000),
  ];
}
