// ADS1115 — 16-bit I2C ADC, converting what is actually on its input pins.
//
// The whole value of an external ADC in a simulator is that the number firmware
// reads came from a voltage on a wire. So there is no way to set a reading here:
// the device is handed the volts on each of its four inputs by the binding, and
// the conversion register is computed from those, the selected mux and the gain.
//
// The consequences are the ones that matter on a bench:
//
//   • an input left floating is not an input at zero volts, and reads as such
//     rather than as a confident 0;
//   • a gain set too high saturates, which is the single most common ADS1115
//     mistake — 5 V into the default ±2.048 V range does not read 5 V, it rails;
//   • a differential mux reads the difference, negative values included, and the
//     result is a signed 16-bit number;
//   • the conversion register holds the LAST conversion until a new one is
//     started, so a sketch that reads without triggering gets a stale value.
//
// NOT modelled: conversion time as a real delay (a single-shot conversion
// completes immediately and the OS bit reads as ready, rather than staying busy
// for the data rate's worth of microseconds), the comparator and ALERT/RDY pin,
// and input impedance or leakage.

import type { DeviceSnapshot, I2cDevice } from './types';

/** The four addresses the ADDR strap selects. */
export const ADS1115_ADDRESSES = [0x48, 0x49, 0x4a, 0x4b] as const;

const REG_CONVERSION = 0x00;
const REG_CONFIG = 0x01;
const REG_LO_THRESH = 0x02;
const REG_HI_THRESH = 0x03;

/** Full-scale range for each PGA setting, in volts. */
export const ADS1115_FULL_SCALE = [6.144, 4.096, 2.048, 1.024, 0.512, 0.256, 0.256, 0.256];

/** Samples per second for each data-rate setting. */
const DATA_RATES = [8, 16, 32, 64, 128, 250, 475, 860];

export class Ads1115Device implements I2cDevice {
  readonly instanceId: string;
  private readonly address: number;

  /** Volts on each input pin, or null when the pin reaches nothing. */
  private inputs: (number | null)[] = [null, null, null, null];

  /** Power-on config: single-shot, AIN0/AIN1 differential, ±2.048 V, 128 SPS. */
  private config = 0x8583;
  private conversion = 0;
  private loThresh = 0x8000;
  private hiThresh = 0x7fff;

  private pointer = REG_CONFIG;
  private pointerSet = false;
  private reading = false;
  private writeBuffer: number[] = [];
  private readOffset = 0;

  private conversions = 0;
  private saturations = 0;
  private log: string[] = [];

  constructor(instanceId: string, address: number = ADS1115_ADDRESSES[0]) {
    this.instanceId = instanceId;
    this.address = address;
  }

  matchesAddress(address: number): boolean {
    return address === this.address;
  }

  /** The binding supplies real net voltages; null means the pin is unwired. */
  setInputVolts(channel: number, volts: number | null): void {
    if (channel < 0 || channel > 3) return;
    this.inputs[channel] = volts;
  }

  start(_address: number, write: boolean): void {
    this.reading = !write;
    if (write) {
      this.pointerSet = false;
      this.writeBuffer = [];
    } else {
      this.readOffset = 0;
    }
  }

  stop(): void {
    this.pointerSet = false;
    this.writeBuffer = [];
  }

  writeByte(value: number): boolean {
    if (this.reading) return false;
    if (!this.pointerSet) {
      this.pointer = value & 0x03;
      this.pointerSet = true;
      return true;
    }
    this.writeBuffer.push(value & 0xff);
    if (this.writeBuffer.length === 2) {
      const word = (this.writeBuffer[0] << 8) | this.writeBuffer[1];
      this.writeBuffer = [];
      this.writeRegister(this.pointer, word);
    }
    return true;
  }

  readByte(): number {
    const word = this.readRegister(this.pointer);
    const byte = this.readOffset % 2 === 0 ? (word >> 8) & 0xff : word & 0xff;
    this.readOffset++;
    return byte;
  }

  private writeRegister(reg: number, word: number): void {
    if (reg === REG_CONFIG) {
      const wasSingleShot = (this.config & 0x0100) !== 0;
      this.config = word & 0xffff;
      // Writing the config with OS set starts a single-shot conversion. That is
      // the trigger every library uses, and it is why a sketch that only reads
      // the conversion register gets the same number for ever.
      if ((word & 0x8000) !== 0 && (this.config & 0x0100) !== 0) this.convert();
      else if (!wasSingleShot && (this.config & 0x0100) === 0) this.convert();
      return;
    }
    if (reg === REG_LO_THRESH) this.loThresh = word & 0xffff;
    if (reg === REG_HI_THRESH) this.hiThresh = word & 0xffff;
  }

  private readRegister(reg: number): number {
    if (reg === REG_CONVERSION) {
      // Continuous mode reconverts on every read, which is what makes a
      // continuously-configured part track a changing input.
      if ((this.config & 0x0100) === 0) this.convert();
      return this.conversion & 0xffff;
    }
    if (reg === REG_CONFIG) {
      // OS reads high when no conversion is in progress. Conversions here are
      // instantaneous, so it is always ready — stated in the header rather than
      // pretended otherwise.
      return (this.config | 0x8000) & 0xffff;
    }
    if (reg === REG_LO_THRESH) return this.loThresh;
    if (reg === REG_HI_THRESH) return this.hiThresh;
    return 0;
  }

  /** The differential voltage the current mux setting selects, or null. */
  private muxVolts(): number | null {
    const mux = (this.config >> 12) & 0x07;
    const v = (i: number) => this.inputs[i];
    const diff = (a: number, b: number): number | null => {
      const va = v(a);
      const vb = v(b);
      return va === null || vb === null ? null : va - vb;
    };
    switch (mux) {
      case 0: return diff(0, 1);
      case 1: return diff(0, 3);
      case 2: return diff(1, 3);
      case 3: return diff(2, 3);
      case 4: return v(0);
      case 5: return v(1);
      case 6: return v(2);
      default: return v(3);
    }
  }

  private convert(): void {
    const volts = this.muxVolts();
    this.conversions++;
    if (volts === null) {
      // A floating input is not zero volts. Reporting zero would make an
      // unwired ADC look like a working one reading a grounded sensor.
      this.conversion = 0;
      this.note('conversion with an unwired input');
      return;
    }
    const fullScale = ADS1115_FULL_SCALE[(this.config >> 9) & 0x07];
    let counts = Math.round((volts / fullScale) * 32767);
    if (counts > 32767 || counts < -32768) {
      // Saturation, not wraparound. Feeding 5 V into the default 2.048 V range
      // is the classic ADS1115 mistake and it rails rather than folding over.
      this.saturations++;
      this.note(`saturated: ${volts.toFixed(3)} V past a ${fullScale} V range`);
      counts = counts > 0 ? 32767 : -32768;
    }
    this.conversion = counts & 0xffff;
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  // ---- inspection ----

  /** The last conversion as a signed count. */
  get lastCounts(): number {
    return this.conversion > 32767 ? this.conversion - 65536 : this.conversion;
  }
  /** The last conversion converted back to volts through the current gain. */
  get lastVolts(): number {
    return (this.lastCounts / 32767) * ADS1115_FULL_SCALE[(this.config >> 9) & 0x07];
  }
  get fullScaleRange(): number {
    return ADS1115_FULL_SCALE[(this.config >> 9) & 0x07];
  }
  get dataRate(): number {
    return DATA_RATES[(this.config >> 5) & 0x07];
  }
  get isContinuous(): boolean {
    return (this.config & 0x0100) === 0;
  }
  get muxSetting(): number {
    return (this.config >> 12) & 0x07;
  }
  get conversionCount(): number {
    return this.conversions;
  }
  get saturationCount(): number {
    return this.saturations;
  }

  reset(): void {
    this.config = 0x8583;
    this.conversion = 0;
    this.loThresh = 0x8000;
    this.hiThresh = 0x7fff;
    this.pointer = REG_CONFIG;
    this.pointerSet = false;
    this.conversions = 0;
    this.saturations = 0;
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `ADS1115 @0x${this.address.toString(16)} — ±${this.fullScaleRange} V, ` +
        `${this.isContinuous ? 'continuous' : 'single-shot'}, ${this.dataRate} SPS, ` +
        `last ${this.lastCounts} (${this.lastVolts.toFixed(3)} V)` +
        (this.saturations ? `, ${this.saturations} saturated` : ''),
      log: [...this.log],
    };
  }
}
