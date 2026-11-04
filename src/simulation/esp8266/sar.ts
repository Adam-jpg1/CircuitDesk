// The ESP8266's ADC, as the SDK reads it: analogRead(A0) is the SDK's
// system_adc_read(), which starts a conversion in the SAR block at
// 0x60000D00, waits for its state (0x50, bits 26:24) to return to idle, and
// takes eight samples from 0x80..0x9C. Each sample is stored inverted, eleven
// bits wide; the SDK corrects its low byte (less 21, times 279/256, at most
// 255), averages the eight, and scales the result by 12/11 to 0..1024.
//
// The model works that backwards: from the voltage on the pin it picks the
// sample whose trip through the SDK's arithmetic gives the reading an ideal
// converter would. On a NodeMCU, A0 reaches the chip's 0..1 V input through
// a 220k/100k divider, so 3.3 V on the pin reads 1024.

import type { Peripheral } from '../espRiscv/peripheral';

/** What the SDK computes from eight equal samples. */
function sdkReading(sample: number): number {
  const v = sample & 0x7ff;
  const low = Math.min(255, (Math.max(0, (v & 0xff) - 21) * 0x117) >> 8);
  const one = (v & 0xf00) + low;
  const average = ((8 * one + 8) >> 4) & 0xffff;
  return Math.min(1024, Math.floor((average * 12) / 11));
}

/** The sample that reads back as `target`, or the nearest one. */
function sampleFor(target: number): number {
  let best = 0;
  let bestErr = Infinity;
  for (let s = 0; s < 0x800; s++) {
    const err = Math.abs(sdkReading(s) - target);
    if (err < bestErr) {
      bestErr = err;
      best = s;
      if (err === 0) break;
    }
  }
  return best;
}

export class Esp8266Sar implements Peripheral {
  readonly name = 'sar';
  readonly base = 0x60000d00;
  readonly size = 0x100;
  private readonly regs = new Map<number, number>();
  private volts = 0;
  private sample = sampleFor(0);
  /** The pin's full scale: 3.3 V through the NodeMCU's divider. */
  constructor(private readonly fullScale = 3.3) {}

  setVolts(v: number): void {
    const clamped = Math.max(0, Math.min(this.fullScale, v));
    if (clamped === this.volts) return;
    this.volts = clamped;
    this.sample = sampleFor(Math.round((clamped / this.fullScale) * 1024));
  }

  reset(): void {
    this.regs.clear();
  }

  readUint32(offset: number): number {
    if (offset >= 0x80 && offset < 0xa0) return ~this.sample >>> 0;
    // The conversion is instant: the state field reads idle.
    if (offset === 0x50) return (this.regs.get(offset) ?? 0) & ~(7 << 24);
    return this.regs.get(offset) ?? 0;
  }

  writeUint32(offset: number, value: number): void {
    this.regs.set(offset, value >>> 0);
  }
}

export { sdkReading as esp8266SdkAdcReading };
