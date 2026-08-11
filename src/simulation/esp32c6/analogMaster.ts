// The ESP32-C6's analog I²C master.
//
// The C3 reaches its analog blocks — the BBPLL among them — through ROM
// functions, `rom_i2c_readReg` and friends, and the C3 runtime implements those
// as handlers. The C6's ROM publishes no regi2c entry point of any spelling.
// Its firmware drives this register block directly instead, which is why the
// C3's approach has nothing to offer here and this peripheral exists.
//
// Two things in it are hardware behaviour rather than storage:
//
//   * The BUSY bit in each controller register. Firmware writes a transaction
//     and polls until it clears. It reads as clear here because the transaction
//     completes within the write.
//   * BBPLL calibration. `regi2c_ctrl_ll_bbpll_calibration_start()` releases
//     the PLL by setting I2C_MST_BBPLL_STOP_FORCE_LOW, and startup then spins
//     until I2C_MST_BBPLL_CAL_DONE appears. With storage alone that bit never
//     appears and the boot hangs there for ever, which is exactly where real C6
//     firmware stopped before this existed.
//
// Register addresses and bit positions are from
// `soc/esp32c6/include/soc/regi2c_defs.h` and
// `soc/esp32c6/register/soc/i2c_ana_mst_reg.h`.

import { RegisterFile } from '../esp32c3/registerFile';
import type { SimulatedClock } from '../espRiscv/peripheral';

export const I2C_ANA_MST_BASE = 0x600af800;

/** I2C_ANA_MST_I2C0_CTRL_REG and I2C1's, at +0x0 and +0x4. */
const I2C_CTRL = [0x00, 0x04] as const;
/** I2C_ANA_MST_I2Cn_BUSY, read-only. */
const I2C_BUSY = 1 << 25;

/** I2C_MST_ANA_CONF0_REG = 0x600AF818. */
const ANA_CONF0 = 0x18;
const BBPLL_STOP_FORCE_HIGH = 1 << 2;
const BBPLL_STOP_FORCE_LOW = 1 << 3;
const BBPLL_CAL_DONE = 1 << 24;

/**
 * How long the BBPLL takes to finish calibrating, in simulated nanoseconds.
 *
 * This is a settling time on real silicon, not a fixed digital latency, and it
 * varies with temperature and supply — ESP-IDF polls for it with a timeout
 * rather than waiting a known interval, which is what a variable delay looks
 * like from software. A nominal value is the honest choice here: what matters,
 * and what is modelled, is that the bit appears *after* the PLL was released
 * and not before. Nothing in this runtime depends on the exact figure, and no
 * timing claim is made about it.
 */
export const BBPLL_CALIBRATION_NS = 20_000;

export class Esp32C6AnalogMaster extends RegisterFile {
  /** Simulated time at which calibration was last started, if it is running. */
  private calibrationStartedAt: number | undefined;

  constructor(private readonly clock: SimulatedClock) {
    super('i2c_ana_mst', I2C_ANA_MST_BASE, 0x800);
  }

  override reset(): void {
    super.reset();
    this.calibrationStartedAt = undefined;
  }

  /** True once the PLL has been released for long enough to have calibrated. */
  calibrationDone(): boolean {
    if (this.calibrationStartedAt === undefined) return false;
    return this.clock.nanos - this.calibrationStartedAt >= BBPLL_CALIBRATION_NS;
  }

  protected override onWrite(offset: number, value: number): void {
    if (offset !== ANA_CONF0) return;
    const released = (value & BBPLL_STOP_FORCE_LOW) !== 0 && (value & BBPLL_STOP_FORCE_HIGH) === 0;
    if (released) {
      // Only a fresh release restarts the interval; re-writing the same
      // configuration while it is already calibrating does not.
      if (this.calibrationStartedAt === undefined) this.calibrationStartedAt = this.clock.nanos;
    } else {
      // Forcing the PLL stopped abandons the calibration, and CAL_DONE goes
      // away with it.
      this.calibrationStartedAt = undefined;
    }
  }

  protected override onRead(offset: number): number | undefined {
    if (offset === ANA_CONF0) {
      const stored = this.peek(ANA_CONF0);
      return this.calibrationDone() ? (stored | BBPLL_CAL_DONE) >>> 0 : (stored & ~BBPLL_CAL_DONE) >>> 0;
    }
    if (offset === I2C_CTRL[0] || offset === I2C_CTRL[1]) {
      // The transaction the firmware wrote has already been carried out, so the
      // controller is never busy when it is asked.
      return (this.peek(offset) & ~I2C_BUSY) >>> 0;
    }
    return undefined;
  }
}
