// Bosch BMP280 temperature + pressure sensor on I2C.
//
// The device holds a simulated environment (temperature in °C, pressure in
// hPa) and publishes the RAW ADC counts a real BMP280 would produce for those
// conditions, together with a real set of calibration constants. Firmware runs
// the datasheet compensation formula over those bytes and arrives back at the
// environment values — nothing short-circuits the driver's maths.
//
// The raw counts are obtained by inverting the datasheet compensation
// numerically (it is monotonic in the ADC value), so the round-trip is exact
// to within a count rather than approximated.
//
// NOT modelled, and deliberately not pretended: conversion time (status always
// reads idle, so a conversion appears instantaneous), oversampling and IIR
// filter noise/averaging behaviour (the settings are stored and read back but
// do not change the result), the self-clearing of the forced-mode bits after a
// one-shot conversion, and SPI mode. Everything the register map does not cover
// is recorded as an unhandled access rather than answered with invented data.

import type { DeviceSnapshot } from './types';
import { RegisterI2cDevice } from './registerDevice';

export const BMP280_ADDRESSES = [0x76, 0x77] as const;
export const BMP280_CHIP_ID = 0x58;

const REG_CALIB_START = 0x88;
const REG_CALIB_END = 0xa1;
const REG_ID = 0xd0;
const REG_RESET = 0xe0;
const REG_STATUS = 0xf3;
const REG_CTRL_MEAS = 0xf4;
const REG_CONFIG = 0xf5;
const REG_PRESS_MSB = 0xf7;
const REG_TEMP_MSB = 0xfa;

/** Calibration set from the datasheet worked example — real, self-consistent values. */
const CALIB = {
  dig_T1: 27504,
  dig_T2: 26435,
  dig_T3: -1000,
  dig_P1: 36477,
  dig_P2: -10685,
  dig_P3: 3024,
  dig_P4: 2855,
  dig_P5: 140,
  dig_P6: -7,
  dig_P7: 15500,
  dig_P8: -14600,
  dig_P9: 6000,
};

/** Datasheet temperature compensation; returns [t_fine, °C]. */
function compensateTemperature(adcT: number): [number, number] {
  const var1 = (adcT / 16384 - CALIB.dig_T1 / 1024) * CALIB.dig_T2;
  const var2 = (adcT / 131072 - CALIB.dig_T1 / 8192) ** 2 * CALIB.dig_T3;
  const tFine = var1 + var2;
  return [tFine, tFine / 5120];
}

/** Datasheet pressure compensation in Pa. */
function compensatePressure(adcP: number, tFine: number): number {
  let var1 = tFine / 2 - 64000;
  let var2 = (var1 * var1 * CALIB.dig_P6) / 32768;
  var2 = var2 + var1 * CALIB.dig_P5 * 2;
  var2 = var2 / 4 + CALIB.dig_P4 * 65536;
  var1 = ((CALIB.dig_P3 * var1 * var1) / 524288 + CALIB.dig_P2 * var1) / 524288;
  var1 = (1 + var1 / 32768) * CALIB.dig_P1;
  if (var1 === 0) return 0;
  let p = 1048576 - adcP;
  p = ((p - var2 / 4096) * 6250) / var1;
  var1 = (CALIB.dig_P9 * p * p) / 2147483648;
  var2 = (p * CALIB.dig_P8) / 32768;
  return p + (var1 + var2 + CALIB.dig_P7) / 16;
}

/** Binary-searches the raw ADC value whose compensation yields `target`. */
function invert(lo: number, hi: number, f: (x: number) => number, target: number, rising: boolean): number {
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const v = f(mid);
    if (rising ? v < target : v > target) lo = mid;
    else hi = mid;
  }
  return Math.max(0, Math.min(0xfffff, Math.round((lo + hi) / 2)));
}

/**
 * Splits a 20-bit conversion result across the MSB/LSB/XLSB registers exactly
 * as the part does: the value is left-aligned in 24 bits, so the driver
 * reassembles it with (msb << 12) | (lsb << 4) | (xlsb >> 4).
 */
function measurementByte(raw20: number, offset: number): number {
  const aligned = raw20 << 4; // 24-bit, left aligned
  if (offset === 0) return (aligned >> 16) & 0xff;
  if (offset === 1) return (aligned >> 8) & 0xff;
  return aligned & 0xf0; // XLSB carries the low 4 bits in its upper nibble
}

export class Bmp280Device extends RegisterI2cDevice {
  /** Simulated environment — the UI can drive these later. */
  temperatureC = 25;
  pressureHpa = 1013.25;

  private ctrlMeas = 0x00;
  private config = 0x00;
  private calib = new Uint8Array(REG_CALIB_END - REG_CALIB_START + 1);

  constructor(instanceId: string, address: number = BMP280_ADDRESSES[0]) {
    super(instanceId, address);
    this.packCalibration();
  }

  /** Calibration constants exactly as a real part exposes them (LSB first). */
  private packCalibration(): void {
    const put = (reg: number, value: number) => {
      const i = reg - REG_CALIB_START;
      this.calib[i] = value & 0xff;
      this.calib[i + 1] = (value >> 8) & 0xff;
    };
    put(0x88, CALIB.dig_T1);
    put(0x8a, CALIB.dig_T2);
    put(0x8c, CALIB.dig_T3);
    put(0x8e, CALIB.dig_P1);
    put(0x90, CALIB.dig_P2);
    put(0x92, CALIB.dig_P3);
    put(0x94, CALIB.dig_P4);
    put(0x96, CALIB.dig_P5);
    put(0x98, CALIB.dig_P6);
    put(0x9a, CALIB.dig_P7);
    put(0x9c, CALIB.dig_P8);
    put(0x9e, CALIB.dig_P9);
  }

  /** True once firmware has put the sensor into forced or normal mode. */
  get isMeasuring(): boolean {
    return (this.ctrlMeas & 0x03) !== 0;
  }

  private cache: { t: number; p: number; rawT: number; rawP: number } | null = null;

  /** Raw ADC counts for the current environment, recomputed only when it changes. */
  private raws(): { rawT: number; rawP: number } {
    const c = this.cache;
    if (c && c.t === this.temperatureC && c.p === this.pressureHpa) return c;
    const rawT = invert(0, 0xfffff, (adc) => compensateTemperature(adc)[1], this.temperatureC, true);
    const [tFine] = compensateTemperature(rawT);
    // Pressure compensation falls as the ADC count rises.
    const rawP = invert(0, 0xfffff, (adc) => compensatePressure(adc, tFine), this.pressureHpa * 100, false);
    this.cache = { t: this.temperatureC, p: this.pressureHpa, rawT, rawP };
    return this.cache;
  }

  protected readRegister(reg: number): number | null {
    if (reg >= REG_CALIB_START && reg <= REG_CALIB_END) return this.calib[reg - REG_CALIB_START];
    switch (reg) {
      case REG_ID:
        return BMP280_CHIP_ID;
      case REG_STATUS:
        // bit 3 measuring, bit 0 im_update — idle between conversions.
        return 0x00;
      case REG_CTRL_MEAS:
        return this.ctrlMeas;
      case REG_CONFIG:
        return this.config;
      default:
        break;
    }
    // Measurement registers are only meaningful once a mode is selected; a
    // sensor left in sleep mode returns the reset value, as real silicon does.
    if (reg >= REG_PRESS_MSB && reg <= REG_PRESS_MSB + 2) {
      if (!this.isMeasuring) return reg === REG_PRESS_MSB ? 0x80 : 0x00;
      return measurementByte(this.raws().rawP, reg - REG_PRESS_MSB);
    }
    if (reg >= REG_TEMP_MSB && reg <= REG_TEMP_MSB + 2) {
      if (!this.isMeasuring) return reg === REG_TEMP_MSB ? 0x80 : 0x00;
      return measurementByte(this.raws().rawT, reg - REG_TEMP_MSB);
    }
    return null;
  }

  protected writeRegister(reg: number, value: number): boolean {
    switch (reg) {
      case REG_CTRL_MEAS:
        this.ctrlMeas = value;
        this.note(`ctrl_meas=0x${value.toString(16)} (mode ${value & 0x03})`);
        return true;
      case REG_CONFIG:
        this.config = value;
        return true;
      case REG_RESET:
        if (value === 0xb6) {
          this.reset();
          this.note('soft reset');
        }
        return true;
      default:
        return false;
    }
  }

  reset(): void {
    this.ctrlMeas = 0x00;
    this.config = 0x00;
    this.pointer = 0;
    this.unknownReads = [];
    this.unknownWrites = [];
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `BMP280 @0x${this.address.toString(16)} — ${this.isMeasuring ? 'measuring' : 'sleep'}, ` +
        `${this.temperatureC.toFixed(1)} °C, ${this.pressureHpa.toFixed(1)} hPa`,
      log: [...this.log],
    };
  }
}
