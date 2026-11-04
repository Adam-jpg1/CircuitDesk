// The ESP32's SAR ADCs, as ESP-IDF's one-shot driver (and so analogRead())
// drives them: through the RTC controller in SENS.
//
// The driver selects one channel in SAR1_EN_PAD / SAR2_EN_PAD, pulses
// MEAS1_START_SAR / MEAS2_START_SAR and spins until MEAS*_DONE_SAR, then reads
// MEAS*_DATA_SAR. Offsets and fields are soc/esp32/register/soc/sens_reg.h;
// the channel-to-GPIO map is the chip's (ADC1: 36, 37, 38, 39, 32, 33, 34, 35;
// ADC2: 4, 0, 2, 15, 13, 12, 14, 27, 25, 26).
//
// The conversion is ideal and linear: raw = volts / full scale x (2^bits - 1),
// with full scale 1.1, 1.5, 2.2 and 3.3 V for the four attenuations. The real
// part is noisy and bends near both ends of its range; that is not modelled.
// The ESP32's converter inverts its own output and ESP-IDF sets DATA_INV to
// undo it; the S3's does not, and ESP-IDF leaves DATA_INV clear. Both are
// modelled as the chips behave.

import type { Peripheral } from '../espRiscv/peripheral';

export const ESP32_ADC1_GPIOS = [36, 37, 38, 39, 32, 33, 34, 35];
export const ESP32_ADC2_GPIOS = [4, 0, 2, 15, 13, 12, 14, 27, 25, 26];
const FULL_SCALE = [1.1, 1.5, 2.2, 3.3];

/**
 * Where a chip keeps the SAR controls. The ESP32-S3 has the same design at
 * other offsets, a fixed 12-bit result, and its own pads: ADC1 on GPIO1-10,
 * ADC2 on GPIO11-20 (soc/esp32s3/register/soc/sens_reg.h).
 */
export interface SensLayout {
  base: number;
  readCtrl: number;
  readCtrl2: number;
  startForce?: number;
  atten1: number;
  atten2: number;
  slaveAddr1: number;
  measStart1: number;
  measStart2: number;
  adc1: readonly number[];
  adc2: readonly number[];
  /** The converter's own output is inverted (the ESP32's), so DATA_INV set reads true values. */
  hardwareInverted: boolean;
}

export const ESP32_SENS: SensLayout = {
  base: 0x3ff48800, readCtrl: 0x00, readCtrl2: 0x90, startForce: 0x2c, atten1: 0x34, atten2: 0x38, slaveAddr1: 0x3c,
  measStart1: 0x54, measStart2: 0x94, adc1: ESP32_ADC1_GPIOS, adc2: ESP32_ADC2_GPIOS, hardwareInverted: true,
};

export const ESP32S3_SENS: SensLayout = {
  base: 0x60008800, readCtrl: 0x00, readCtrl2: 0x24, atten1: 0x14, atten2: 0x38, slaveAddr1: 0x40,
  measStart1: 0x0c, measStart2: 0x30, adc1: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], adc2: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  hardwareInverted: false,
};

/** True when a GPIO is an ADC input on the ESP32. */
export function esp32AdcGpio(gpio: number): boolean {
  return ESP32_ADC1_GPIOS.includes(gpio) || ESP32_ADC2_GPIOS.includes(gpio);
}

export class Esp32Sens implements Peripheral {
  readonly name = 'sens';
  readonly base: number;
  readonly size = 0x400;
  private readonly regs = new Map<number, number>();
  /** Volts on each GPIO, from the circuit. */
  readonly volts = new Float64Array(40);
  conversions = 0;

  constructor(private readonly layout: SensLayout = ESP32_SENS) {
    this.base = layout.base;
  }

  /** True when a GPIO is an ADC input on this chip. */
  isAdcGpio(gpio: number): boolean {
    return this.layout.adc1.includes(gpio) || this.layout.adc2.includes(gpio);
  }

  reset(): void {
    this.regs.clear();
    this.conversions = 0;
  }

  private peek(offset: number): number {
    return (this.regs.get(offset) ?? 0) >>> 0;
  }

  readUint32(offset: number): number {
    // MEAS_STATUS: the controller is idle whenever asked.
    if (offset === this.layout.slaveAddr1) return this.peek(offset) & ~(0xff << 22);
    return this.peek(offset);
  }

  writeUint32(offset: number, value: number): void {
    const before = this.peek(offset);
    const { measStart1, measStart2 } = this.layout;
    if (offset === measStart1 || offset === measStart2) {
      // The result and DONE belong to the hardware; firmware writes the rest.
      value = (value & ~0x1ffff) | (before & 0x1ffff);
      if (!((value >>> 17) & 1)) value &= ~(1 << 16);
      this.regs.set(offset, value >>> 0);
      if ((value >>> 17) & 1 && !((before >>> 17) & 1)) this.convert(offset === measStart1 ? 1 : 2);
      return;
    }
    this.regs.set(offset, value >>> 0);
  }

  private convert(unit: 1 | 2): void {
    const L = this.layout;
    const start = unit === 1 ? L.measStart1 : L.measStart2;
    const gpios = unit === 1 ? L.adc1 : L.adc2;
    const mask = (this.peek(start) >>> 19) & ((1 << gpios.length) - 1);
    const channel = mask ? 31 - Math.clz32(mask & -mask) : -1;
    const gpio = channel >= 0 ? gpios[channel] : undefined;
    const atten = (this.peek(unit === 1 ? L.atten1 : L.atten2) >>> ((channel < 0 ? 0 : channel) * 2)) & 3;
    const width = L.startForce === undefined ? 12 : 9 + ((this.peek(L.startForce) >>> (unit === 1 ? 0 : 2)) & 3);
    const max = (1 << width) - 1;
    const v = gpio === undefined ? 0 : this.volts[gpio];
    let raw = Math.round((Math.max(0, Math.min(v, FULL_SCALE[atten])) / FULL_SCALE[atten]) * max);
    const inverted = unit === 1 ? (this.peek(L.readCtrl) >>> 28) & 1 : (this.peek(L.readCtrl2) >>> 29) & 1;
    if (Boolean(inverted) !== L.hardwareInverted) raw = max - raw;
    this.regs.set(start, ((this.peek(start) & ~0xffff) | raw | (1 << 16)) >>> 0);
    this.conversions++;
  }
}
