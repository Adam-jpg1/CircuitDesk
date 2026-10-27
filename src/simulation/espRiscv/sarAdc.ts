// The SAR ADC's one-shot path (APB_SARADC), as ESP-IDF's adc_oneshot driver
// uses it on the ESP32-C3 and ESP32-C6 — which is what analogRead() calls.
//
// The driver selects a channel and attenuation in ONETIME_SAMPLE, raises
// ONETIME_START, then spins until the unit's DONE bit appears in INT_RAW and
// reads the result from the unit's DATA_STATUS register. Unmodelled, DONE never
// came and analogRead() hung the sketch forever. Register offsets and fields
// are from the IDF's soc/apb_saradc_reg.h and hal/adc_ll.h for each chip; the
// two parts share the layout and differ in base address and channel count.
//
// A conversion is ideal: the pin's voltage over the attenuation's full scale,
// as 12 bits. Full scale is the documented measurable range — on the C3, from
// its datasheet, 750, 1050, 1300 and 2500 mV for attenuation 0 to 3. On the C6,
// Espressif's hardware design guidelines give 3300 mV at attenuation 3; the
// lower three are that scaled by their dB steps, as no C6 document found gives
// them. Nothing here models the real ADC's offset, gain error or noise.

import type { Peripheral } from './peripheral';

const ONETIME_SAMPLE = 0x20;
const DATA_STATUS_1 = 0x2c;
const DATA_STATUS_2 = 0x30;
const INT_RAW = 0x44;
const INT_CLR = 0x4c;
const ONETIME_START = 1 << 29;
const SAMPLE_ADC1 = 1 << 31;
const SAMPLE_ADC2 = 1 << 30;
const DONE_ADC1 = 1 << 31;
const DONE_ADC2 = 1 << 30;

export interface SarAdcLayout {
  base: number;
  /** Channels on each unit; a unit with none is absent (the C6 has no ADC2). */
  channels: readonly [adc1: number, adc2: number];
  /** Full-scale input, in volts, for attenuation 0..3. */
  fullScale: readonly [number, number, number, number];
}

export const ESP32C3_SAR_ADC: SarAdcLayout = {
  base: 0x60040000,
  // ADC1 on GPIO0-4, ADC2 channel 0 on GPIO5.
  channels: [5, 1],
  fullScale: [0.75, 1.05, 1.3, 2.5],
};

export const ESP32C6_SAR_ADC: SarAdcLayout = {
  base: 0x6000e000,
  // ADC1 only, on GPIO0-6.
  channels: [7, 0],
  fullScale: [3.3 / 10 ** (12 / 20), 3.3 / 10 ** (9.5 / 20), 3.3 / 10 ** (6 / 20), 3.3],
};

export class EspSarAdc implements Peripheral {
  readonly name = 'apb_saradc';
  readonly size = 0x400;
  readonly base: number;
  private readonly registers = new Uint32Array(0x100);
  /** Volts on each ADC1 channel, then each ADC2 channel. */
  readonly volts: Float64Array;
  /** Conversions done, for tests. */
  conversions = 0;

  constructor(private readonly layout: SarAdcLayout) {
    this.base = layout.base;
    this.volts = new Float64Array(layout.channels[0] + layout.channels[1]);
  }

  /** The index into `volts` for a unit (0 = ADC1) and its channel, if it exists. */
  channelIndex(unit: number, channel: number): number | undefined {
    const [adc1, adc2] = this.layout.channels;
    if (unit === 0 && channel < adc1) return channel;
    if (unit === 1 && channel < adc2) return adc1 + channel;
    return undefined;
  }

  readUint32(offset: number): number {
    return this.registers[offset >>> 2] >>> 0;
  }

  writeUint32(offset: number, value: number): void {
    const index = offset >>> 2;
    const previous = this.registers[index];
    if (offset === INT_CLR) {
      this.registers[INT_RAW >>> 2] &= ~value;
      return;
    }
    if (offset === INT_RAW || offset === DATA_STATUS_1 || offset === DATA_STATUS_2) return; // read-only
    this.registers[index] = value;
    if (offset === ONETIME_SAMPLE && value & ONETIME_START && !(previous & ONETIME_START)) this.convert(value);
  }

  /** One conversion, finished at once: the driver waits for DONE and finds it. */
  private convert(sample: number): void {
    const field = (sample >>> 25) & 0xf;
    // The unit is the one enabled for one-shot sampling (bit 31 ADC1, bit 30
    // ADC2). The channel field names a pin only when it is (unit << 3) | n;
    // the driver's self-calibration converts with 0xF there — no pin, the
    // internal ground — which reads 0.
    const unit = sample & SAMPLE_ADC1 ? 0 : sample & SAMPLE_ADC2 ? 1 : field >> 3;
    const channel = field >> 3 === unit ? field & 0x7 : undefined;
    const atten = (sample >>> 23) & 0x3;
    const at = channel === undefined ? undefined : this.channelIndex(unit, channel);
    const volts = at === undefined ? 0 : this.volts[at];
    const raw = Math.max(0, Math.min(4095, Math.round((volts / this.layout.fullScale[atten]) * 4095)));
    this.conversions++;
    if (unit === 0) {
      this.registers[DATA_STATUS_1 >>> 2] = raw;
      this.registers[INT_RAW >>> 2] |= DONE_ADC1;
    } else {
      // ADC2 reports the channel above the result; the driver checks it.
      this.registers[DATA_STATUS_2 >>> 2] = ((channel ?? 0) << 13) | raw;
      this.registers[INT_RAW >>> 2] |= DONE_ADC2;
    }
  }

  reset(): void {
    this.registers.fill(0);
  }
}

/**
 * The `volts` index of the ADC channel on a GPIO, if it has one: GPIO0-4 are
 * ADC1 channels 0-4 and GPIO5 is ADC2 channel 0 on the C3; GPIO0-6 are ADC1
 * channels 0-6 on the C6.
 */
export function espAdcIndexForGpio(chip: string, gpio: number): number | undefined {
  if (chip === 'esp32c3') return gpio >= 0 && gpio <= 5 ? gpio : undefined;
  if (chip === 'esp32c6') return gpio >= 0 && gpio <= 6 ? gpio : undefined;
  return undefined;
}
