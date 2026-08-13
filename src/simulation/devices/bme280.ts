// Bosch BME280 — temperature, pressure and humidity on I2C.
//
// A BME280 is not a BMP280 with a humidity register bolted on: it has a
// different chip id, a second calibration block at 0xE1, a humidity control
// register that only takes effect when ctrl_meas is written afterwards, and a
// twenty-bit pressure/temperature layout followed by a separate sixteen-bit
// humidity word. Firmware written against a real BME280 library checks the
// chip id first and refuses to start if it is wrong, so conflating the two
// parts would fail at the first line of every sketch.
//
// The device holds the environment a user dialled in and publishes the RAW ADC
// counts a real part would produce for it, alongside a genuine calibration
// set. The driver runs the datasheet compensation over those bytes and arrives
// back at the values that were set — nothing short-circuits its arithmetic.
//
// NOT modelled, and not pretended: conversion timing (status reads idle, so a
// measurement appears instantaneous), oversampling and IIR filtering (settings
// are stored and read back but do not change the result or add noise),
// forced-mode bits self-clearing, and SPI. Anything outside the register map
// is recorded as an unhandled access rather than answered with invented data.

import type { DeviceSnapshot } from './types';
import { RegisterI2cDevice } from './registerDevice';

export const BME280_ADDRESSES = [0x76, 0x77] as const;
/** 0x60 — distinct from the BMP280's 0x58, and the first thing a driver checks. */
export const BME280_CHIP_ID = 0x60;

const REG_CALIB00 = 0x88; // …0xA1: temperature and pressure trim
const REG_ID = 0xd0;
const REG_RESET = 0xe0;
const REG_CALIB26 = 0xe1; // …0xF0: humidity trim
const REG_CTRL_HUM = 0xf2;
const REG_STATUS = 0xf3;
const REG_CTRL_MEAS = 0xf4;
const REG_CONFIG = 0xf5;
const REG_DATA = 0xf7; // 0xF7..0xFE: press[3] temp[3] hum[2]

/**
 * A real, self-consistent trim set.
 *
 * Coefficients of this family behave the way hardware does across the range;
 * invented ones can send the pressure compensation negative at the edges.
 */
const CALIB = {
  T1: 28960, T2: 26301, T3: 50,
  P1: 38214, P2: -10653, P3: 3024, P4: 5931, P5: -95,
  P6: -7, P7: 9900, P8: -10230, P9: 4285,
  H1: 75, H2: 366, H3: 0, H4: 308, H5: 50, H6: 30,
};

/** Datasheet temperature compensation; returns [t_fine, °C]. */
function compensateTemperature(adcT: number): [number, number] {
  const var1 = (adcT / 16384 - CALIB.T1 / 1024) * CALIB.T2;
  const var2 = (adcT / 131072 - CALIB.T1 / 8192) ** 2 * CALIB.T3;
  const tFine = var1 + var2;
  return [tFine, tFine / 5120];
}

/** Datasheet pressure compensation, in Pa. */
function compensatePressure(adcP: number, tFine: number): number {
  let var1 = tFine / 2 - 64000;
  let var2 = (var1 * var1 * CALIB.P6) / 32768;
  var2 = var2 + var1 * CALIB.P5 * 2;
  var2 = var2 / 4 + CALIB.P4 * 65536;
  var1 = ((CALIB.P3 * var1 * var1) / 524288 + CALIB.P2 * var1) / 524288;
  var1 = (1 + var1 / 32768) * CALIB.P1;
  if (var1 === 0) return 0;
  let p = 1048576 - adcP;
  p = ((p - var2 / 4096) * 6250) / var1;
  var1 = (CALIB.P9 * p * p) / 2147483648;
  var2 = (p * CALIB.P8) / 32768;
  return p + (var1 + var2 + CALIB.P7) / 16;
}

/** Datasheet humidity compensation, in %RH. */
function compensateHumidity(adcH: number, tFine: number): number {
  let h = tFine - 76800;
  h =
    (adcH - (CALIB.H4 * 64 + (CALIB.H5 / 16384) * h)) *
    ((CALIB.H2 / 65536) * (1 + (CALIB.H6 / 67108864) * h * (1 + (CALIB.H3 / 67108864) * h)));
  h = h * (1 - (CALIB.H1 * h) / 524288);
  return Math.min(100, Math.max(0, h));
}

/**
 * Inverts a monotonic compensation numerically.
 *
 * The datasheet gives counts → value; what this device needs is value →
 * counts, and bisection over the real formula is exact to within a count.
 * Doing it this way rather than with an approximate inverse means the driver's
 * own maths is what produces the number the user set.
 */
function invert(target: number, lo: number, hi: number, forward: (adc: number) => number): number {
  let low = lo;
  let high = hi;
  const rising = forward(hi) > forward(lo);
  for (let i = 0; i < 48; i++) {
    const mid = Math.floor((low + high) / 2);
    const value = forward(mid);
    if (rising === value < target) low = mid;
    else high = mid;
    if (high - low <= 1) break;
  }
  return low;
}

export class Bme280Device extends RegisterI2cDevice {
  /** The environment, as the user set it. */
  temperatureC = 22;
  pressureHpa = 1013.25;
  humidityPct = 45;

  private ctrlHum = 0;
  private ctrlMeas = 0;
  private config = 0;
  private calib = new Uint8Array(0x100);

  constructor(instanceId: string, address: number) {
    super(instanceId, address);
    this.buildCalibrationBlock();
  }

  /** The raw counts a real part would report for the current environment. */
  private rawCounts(): { adcT: number; adcP: number; adcH: number; tFine: number } {
    const adcT = invert(this.temperatureC, 0, 0xfffff, (adc) => compensateTemperature(adc)[1]);
    const [tFine] = compensateTemperature(adcT);
    const adcP = invert(this.pressureHpa * 100, 0, 0xfffff, (adc) => compensatePressure(adc, tFine));
    const adcH = invert(this.humidityPct, 0, 0xffff, (adc) => compensateHumidity(adc, tFine));
    return { adcT, adcP, adcH, tFine };
  }

  /** Lays the trim values out at the addresses a driver reads them from. */
  private buildCalibrationBlock(): void {
    const put16 = (addr: number, value: number) => {
      this.calib[addr] = value & 0xff;
      this.calib[addr + 1] = (value >> 8) & 0xff;
    };
    put16(0x88, CALIB.T1);
    put16(0x8a, CALIB.T2);
    put16(0x8c, CALIB.T3);
    put16(0x8e, CALIB.P1);
    put16(0x90, CALIB.P2);
    put16(0x92, CALIB.P3);
    put16(0x94, CALIB.P4);
    put16(0x96, CALIB.P5);
    put16(0x98, CALIB.P6);
    put16(0x9a, CALIB.P7);
    put16(0x9c, CALIB.P8);
    put16(0x9e, CALIB.P9);
    this.calib[0xa1] = CALIB.H1 & 0xff;
    // The humidity block is packed: H4 and H5 share the nibbles of 0xE5.
    put16(0xe1, CALIB.H2);
    this.calib[0xe3] = CALIB.H3 & 0xff;
    this.calib[0xe4] = (CALIB.H4 >> 4) & 0xff;
    this.calib[0xe5] = ((CALIB.H4 & 0x0f) | ((CALIB.H5 & 0x0f) << 4)) & 0xff;
    this.calib[0xe6] = (CALIB.H5 >> 4) & 0xff;
    this.calib[0xe7] = CALIB.H6 & 0xff;
  }

  protected readRegister(register: number): number | null {
    if (register >= REG_CALIB00 && register <= 0xa1) return this.calib[register];
    if (register >= REG_CALIB26 && register <= 0xf0) return this.calib[register];
    if (register === REG_ID) return BME280_CHIP_ID;
    if (register === REG_CTRL_HUM) return this.ctrlHum;
    // Never measuring and never copying: a conversion appears instantaneous.
    if (register === REG_STATUS) return 0x00;
    if (register === REG_CTRL_MEAS) return this.ctrlMeas;
    if (register === REG_CONFIG) return this.config;
    if (register >= REG_DATA && register <= 0xfe) {
      // Sleep mode publishes the reset value, as a real part does, so firmware
      // that forgets to start a measurement sees that rather than live data.
      const mode = this.ctrlMeas & 0x03;
      if (mode === 0) return register === 0xf7 || register === 0xfa ? 0x80 : 0x00;
      const { adcT, adcP, adcH } = this.rawCounts();
      switch (register) {
        case 0xf7: return (adcP >> 12) & 0xff;
        case 0xf8: return (adcP >> 4) & 0xff;
        case 0xf9: return (adcP << 4) & 0xf0;
        case 0xfa: return (adcT >> 12) & 0xff;
        case 0xfb: return (adcT >> 4) & 0xff;
        case 0xfc: return (adcT << 4) & 0xf0;
        case 0xfd: return (adcH >> 8) & 0xff;
        case 0xfe: return adcH & 0xff;
        default: return null;
      }
    }
    return null;
  }

  protected writeRegister(register: number, value: number): boolean {
    switch (register) {
      case REG_CTRL_HUM:
        // Real hardware only latches this when ctrl_meas is written next,
        // which is the step people miss; storing it is enough to read back.
        this.ctrlHum = value;
        return true;
      case REG_CTRL_MEAS:
        this.ctrlMeas = value;
        return true;
      case REG_CONFIG:
        this.config = value;
        return true;
      case REG_RESET:
        if (value === 0xb6) this.reset();
        return true;
      default:
        return false;
    }
  }

  reset(): void {
    this.ctrlHum = 0;
    this.ctrlMeas = 0;
    this.config = 0;
    this.log.push('reset');
  }

  snapshot(): DeviceSnapshot {
    const mode = this.ctrlMeas & 0x03;
    return {
      status:
        mode === 0
          ? 'sleep'
          : `${this.temperatureC.toFixed(1)} °C · ${this.pressureHpa.toFixed(0)} hPa · ${this.humidityPct.toFixed(0)} %RH`,
      log: this.log.slice(-20),
    };
  }

  /** True once firmware has taken it out of sleep. */
  get isMeasuring(): boolean {
    return (this.ctrlMeas & 0x03) !== 0;
  }
}
