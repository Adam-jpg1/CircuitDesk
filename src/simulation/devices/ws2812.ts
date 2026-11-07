// WS2812 / NeoPixel: colours decoded from the waveform, not from a library call.
//
// This part has no bus, no clock and no chip select. Everything is in the
// timing of one wire: each bit is a ~1.25 µs period whose HIGH portion is short
// for a zero (~0.4 µs) and long for a one (~0.8 µs), twenty-four bits per pixel
// in green-red-blue order, and a low period of 50 µs or more latches the frame.
//
// So that is what is measured here. Every edge carries the emulator's own
// cycle-accurate timestamp, the high time of each pulse decides the bit, and
// the picture on the canvas is whatever those bits said. Nothing watches for a
// `setPixelColor` call, which is the only reason any of the following behave
// correctly:
//
//   • a hand-written bit-bang loop lights the strip, because it produces the
//     same waveform a library does;
//   • a sketch that drives the wrong pin lights nothing;
//   • sending twenty-four bits for a thirty-pixel strip lights one pixel and
//     leaves twenty-nine dark, rather than helpfully filling them in;
//   • a frame is only shown once the reset gap has actually elapsed.
//
// NOT modelled: brightness scaling as current draw, the WS2811's 400 kHz mode,
// per-pixel PWM refresh (a lit pixel is a colour, not a duty cycle), and
// chaining two separate strip *parts* — a strip's DOUT drives nothing here, so
// a second part wired to it stays dark. Use one part with more pixels, which is
// what the pixel-count property is for.

import type { DeviceSnapshot, SimDevice } from './types';

/** WS2812B datasheet timings, in nanoseconds. */
export const WS2812_T0H_NS = 400;
export const WS2812_T1H_NS = 800;
/**
 * Where a zero stops and a one starts.
 *
 * Halfway between the two nominal high times. Real parts are far more
 * forgiving than the datasheet windows suggest — which is why a great many
 * hand-rolled bit-bang loops work on hardware — so a single threshold is both
 * simpler and closer to observed behaviour than two acceptance windows.
 */
const BIT_THRESHOLD_NS = (WS2812_T0H_NS + WS2812_T1H_NS) / 2;
/** A high pulse longer than this is not a bit at all. */
const MAX_PULSE_NS = 5_000;
/** Low time that latches the frame. The datasheet says 50 µs. */
export const WS2812_RESET_NS = 50_000;

export interface PixelColor {
  r: number;
  g: number;
  b: number;
}

export class Ws2812Device implements SimDevice {
  readonly instanceId: string;
  /** How many pixels this part has. Bits beyond it belong further down a chain. */
  readonly pixelCount: number;

  /** The latched frame — what the canvas draws. */
  readonly pixels: PixelColor[];
  /** Bumped whenever a frame latches, so the canvas knows to repaint. */
  revision = 0;

  private riseNs = -1;
  private fallNs = -1;
  private level = false;
  /** Bits of the frame being clocked in, most significant first. */
  private bits: number[] = [];

  private frames = 0;
  /** Pulses whose high time was outside anything a WS2812 would accept. */
  private malformedPulses = 0;
  /** Frames whose bit count was not a whole number of pixels. */
  private shortFrames = 0;
  /** Bits past this part's own pixels — they would drive the next part along. */
  private overflowBits = 0;
  private log: string[] = [];

  constructor(instanceId: string, pixelCount: number) {
    this.instanceId = instanceId;
    this.pixelCount = Math.max(1, Math.floor(pixelCount));
    this.pixels = Array.from({ length: this.pixelCount }, () => ({ r: 0, g: 0, b: 0 }));
  }

  /**
   * One edge on the data line, with the time it happened.
   *
   * `nowNs` comes from the emulator's cycle counter rather than from wall time,
   * so the measurement is as exact as the simulated CPU is — on a 16 MHz AVR
   * that is 62.5 ns steps, which separates a 400 ns pulse from an 800 ns one
   * with room to spare.
   */
  onEdge(high: boolean, nowNs: number): void {
    if (high === this.level) return;
    this.level = high;

    if (high) {
      // A long gap before this rising edge is the reset that latches whatever
      // was clocked in before it. The gap is only measurable now, on the next
      // frame's first edge — `settle` handles the case where there is no next
      // frame because the sketch sent one and stopped.
      if (this.bits.length > 0 && this.fallNs >= 0 && nowNs - this.fallNs >= WS2812_RESET_NS) {
        this.latch();
      }
      this.riseNs = nowNs;
      return;
    }

    this.fallNs = nowNs;
    if (this.riseNs < 0) return; // a falling edge with no rise: nothing to measure
    const highNs = nowNs - this.riseNs;
    if (highNs <= 0 || highNs > MAX_PULSE_NS) {
      this.malformedPulses++;
      return;
    }
    this.bits.push(highNs >= BIT_THRESHOLD_NS ? 1 : 0);
  }

  /**
   * Latches a frame whose reset gap has elapsed with no further edges.
   *
   * Called once per simulation slice. Without it, a sketch that writes the
   * strip once and then does nothing would never show anything, because the
   * latch would be waiting for an edge that never comes.
   */
  settle(nowNs: number): void {
    if (this.bits.length === 0) return;
    if (this.level) return; // still mid-pulse
    if (this.fallNs >= 0 && nowNs - this.fallNs >= WS2812_RESET_NS) this.latch();
  }

  private latch(): void {
    const bits = this.bits;
    this.bits = [];

    const whole = Math.floor(bits.length / 24);
    if (bits.length % 24 !== 0) {
      this.shortFrames++;
      this.note(`frame of ${bits.length} bits is not a whole number of pixels`);
    }
    if (whole > this.pixelCount) this.overflowBits += (whole - this.pixelCount) * 24;

    for (let i = 0; i < Math.min(whole, this.pixelCount); i++) {
      let g = 0;
      let r = 0;
      let b = 0;
      const base = i * 24;
      for (let k = 0; k < 8; k++) g = (g << 1) | bits[base + k];
      for (let k = 0; k < 8; k++) r = (r << 1) | bits[base + 8 + k];
      for (let k = 0; k < 8; k++) b = (b << 1) | bits[base + 16 + k];
      this.pixels[i] = { r, g, b };
    }
    // Pixels beyond the frame keep their previous colour, exactly as the
    // hardware does: a WS2812 holds its last value until it is given a new one.
    this.frames++;
    this.revision++;
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  // ---- inspection ----

  get frameCount(): number {
    return this.frames;
  }
  get malformedPulseCount(): number {
    return this.malformedPulses;
  }
  get shortFrameCount(): number {
    return this.shortFrames;
  }
  get overflowBitCount(): number {
    return this.overflowBits;
  }
  /** Bits clocked in since the last latch — a frame still in flight. */
  get pendingBits(): number {
    return this.bits.length;
  }
  get litCount(): number {
    return this.pixels.filter((p) => p.r || p.g || p.b).length;
  }

  reset(): void {
    for (const p of this.pixels) {
      p.r = 0;
      p.g = 0;
      p.b = 0;
    }
    this.bits = [];
    this.riseNs = -1;
    this.fallNs = -1;
    this.level = false;
    this.frames = 0;
    this.malformedPulses = 0;
    this.shortFrames = 0;
    this.overflowBits = 0;
    this.log = [];
    this.revision++;
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `WS2812 x${this.pixelCount}: ${this.frames} frame(s), ${this.litCount} lit` +
        (this.malformedPulses ? `, ${this.malformedPulses} malformed pulse(s)` : '') +
        (this.shortFrames ? `, ${this.shortFrames} short frame(s)` : '') +
        (this.overflowBits ? `, ${this.overflowBits} bit(s) past the end of this part` : ''),
      log: [...this.log],
    };
  }
}
