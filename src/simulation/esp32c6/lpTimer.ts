// The ESP32-C6's low-power timer, which the C3 has no counterpart for.
//
// This is the chip's always-on counter, clocked from the RTC slow clock, and
// ESP-IDF reads it constantly: `lp_timer_hal_get_cycle_count()` is how
// `esp_rtc_get_time_us()` and everything built on it learn what time it is.
//
// Reading it is a two-step transaction rather than a register read, and getting
// that wrong is why a register file is not enough here. Firmware sets
// LP_TIMER_MAIN_TIMER_UPDATE in LP_TIMER_UPDATE_REG, which tells the hardware to
// latch the running counter into a pair of buffer registers, and then reads
// those. With plain storage the buffers read zero for ever, time never advances,
// and startup spins in the first loop that waits for it — which is exactly where
// real C6 firmware stopped before this existed.
//
// Register offsets and bit positions are from `soc/esp32c6/register/soc/
// lp_timer_reg.h` in the same core the firmware was built with.

import { RegisterFile } from '../esp32c3/registerFile';
import type { SimulatedClock } from '../espRiscv/peripheral';

export const LP_TIMER_BASE = 0x600b0c00;

const TAR0_LOW = 0x00;
const TAR0_HIGH = 0x04;
const UPDATE = 0x10;
const MAIN_BUF0_LOW = 0x14;
const MAIN_BUF0_HIGH = 0x18;
const MAIN_BUF1_LOW = 0x1c;
const MAIN_BUF1_HIGH = 0x20;
const INT_RAW = 0x28;
const INT_ST = 0x2c;
const INT_ENA = 0x30;
const INT_CLR = 0x34;

/** LP_TIMER_MAIN_TIMER_UPDATE, a write-triggered latch. */
const MAIN_TIMER_UPDATE = 1 << 28;

/** The counter's high half is 16 bits wide, so the whole counter is 48. */
const HIGH_MASK = 0xffff;

/**
 * SOC_CLK_RC_SLOW_FREQ_APPROX from `clk_tree_defs.h`.
 *
 * The internal RC oscillator is deliberately approximate on real silicon —
 * measuring it is the entire reason the calibration hardware exists — so the
 * nominal value is the honest choice rather than invented precision. Firmware
 * that calibrates gets an answer derived from this same number, so the two
 * cannot disagree.
 */
export const RC_SLOW_HZ = 136_000;

export class Esp32C6LpTimer extends RegisterFile {
  constructor(private readonly clock: SimulatedClock) {
    super('lp_timer', LP_TIMER_BASE, 0x400);
  }

  /** The running counter, in RTC slow-clock cycles since power-on. */
  cycles(): number {
    return Math.floor((this.clock.nanos * RC_SLOW_HZ) / 1e9);
  }

  protected override onWrite(offset: number, value: number): void {
    if (offset !== UPDATE || (value & MAIN_TIMER_UPDATE) === 0) return;
    // Latch the counter into both buffer pairs, as the hardware does, and clear
    // the trigger — it is write-only and does not stay set.
    const count = this.cycles();
    const low = count >>> 0;
    const high = Math.floor(count / 0x1_0000_0000) & HIGH_MASK;
    this.registers.set(MAIN_BUF0_LOW, low);
    this.registers.set(MAIN_BUF0_HIGH, high);
    this.registers.set(MAIN_BUF1_LOW, low);
    this.registers.set(MAIN_BUF1_HIGH, high);
    this.registers.set(UPDATE, value & ~MAIN_TIMER_UPDATE);
  }

  /** The alarm target firmware last programmed, in slow-clock cycles. */
  private target(): number {
    return (this.peek(TAR0_HIGH) & HIGH_MASK) * 0x1_0000_0000 + this.peek(TAR0_LOW);
  }

  /**
   * INT_RAW as the hardware presents it.
   *
   * The alarm is a comparison against the running counter, so it is evaluated
   * at the moment of the read: asking then gives the same answer as updating
   * continuously, without stepping the peripheral.
   */
  private rawInterrupts(): number {
    let raw = this.peek(INT_RAW);
    const target = this.target();
    if (target > 0 && this.cycles() >= target) raw |= 1;
    return raw >>> 0;
  }

  protected override onRead(offset: number): number | undefined {
    if (offset === INT_RAW) return this.rawInterrupts();
    if (offset === INT_ST) return (this.rawInterrupts() & this.peek(INT_ENA)) >>> 0;
    return undefined;
  }
}
