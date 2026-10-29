// The LED PWM controller (LEDC) of the ESP32-C3 and ESP32-C6.
//
// Arduino-ESP32 builds analogWrite(), ledcWrite(), tone() and the ESP32Servo
// library on it, so without it every one of those left its pin silent. Six
// channels, each fed by one of four timers:
//   * a timer counts at its clock source over a divider (an 18-bit fixed-point
//     value with 8 fractional bits) and wraps every 2^resolution counts;
//   * a channel is high while its timer's count is in [hpoint, hpoint + duty)
//     and low otherwise, and drives matrix signal LEDC_LS_SIG_OUT0 + channel —
//     which the GPIO matrix then routes to whatever pad firmware chose.
// The duty register carries four fractional bits, as on the chip. Nothing is
// stepped per count: the level of a channel at any moment follows from the
// time, and the controller tells the machine when its next edge is due, so an
// edge lands at its own simulated time whether the CPU is running or asleep.
//
// The two chips share the design and differ in field positions, the place of
// the clock-select register and the matrix signal numbers; `LedcLayout` holds
// those, from each chip's ledc_reg.h. Not modelled: hardware fades (gradual
// duty changes), the overflow counter and the LEDC interrupts.

import type { Peripheral, InterruptingPeripheral } from './peripheral';

export interface LedcLayout {
  base: number;
  /** Bits of a timer's duty-resolution field, and the shifts of its divider, pause and reset bits. */
  dutyResMask: number;
  clkDivShift: number;
  pauseBit: number;
  rstBit: number;
  /** Matrix signal of channel 0's output. */
  signalBase: number;
  /** LEDC_CONF on the C3, where the clock source is selected; the C6 selects it in PCR instead. */
  confOffset: number;
}

export const ESP32C3_LEDC: LedcLayout = {
  base: 0x60019000,
  dutyResMask: 0xf,
  clkDivShift: 4,
  pauseBit: 22,
  rstBit: 23,
  signalBase: 45,
  confOffset: 0xd0,
};

export const ESP32C6_LEDC: LedcLayout = {
  base: 0x60007000,
  dutyResMask: 0x1f,
  clkDivShift: 5,
  pauseBit: 23,
  rstBit: 24,
  signalBase: 0,
  confOffset: 0x1f0,
};

const CHANNELS = 6;
const TIMERS = 4;
const CH_STRIDE = 0x14;
const CH_CONF0 = 0x00;
const CH_HPOINT = 0x04;
const CH_DUTY = 0x08;
const CH_CONF1 = 0x0c;
const CH_DUTY_R = 0x10;
const TIMER_CONF = 0xa0;
const TIMER_VALUE = 0xa4;
const TIMER_STRIDE = 0x08;
const SIG_OUT_EN = 1 << 2;
const IDLE_LV = 1 << 3;
const DUTY_START = 1 << 31;

/**
 * Clock-source select values (LEDC_APB_CLK_SEL on the C3, PCR_LEDC_SCLK_SEL on
 * the C6): 1 is the 80 MHz APB / PLL clock, 2 the ~17.5 MHz RC_FAST clock and
 * 3 the 40 MHz crystal.
 */
const SOURCE_HZ: Record<number, number> = { 1: 80_000_000, 2: 17_500_000, 3: 40_000_000 };

interface SignalSink {
  driveSignal(signal: number, drive: { level: 0 | 1; enable: boolean } | undefined): void;
}

export class EspLedc implements Peripheral, InterruptingPeripheral {
  readonly name = 'ledc';
  readonly size = 0x1000;
  readonly base: number;
  private readonly registers = new Map<number, number>();
  /** When each timer last started counting from zero. */
  private readonly anchorNs = new Array<number>(TIMERS).fill(0);
  private readonly levels = new Array<0 | 1 | undefined>(CHANNELS).fill(undefined);

  /**
   * @param sourceSelect reads the clock-source select where the chip keeps it
   *                     outside this block (the C6's PCR); left out, LEDC_CONF.
   */
  constructor(
    private readonly layout: LedcLayout,
    private readonly clock: { readonly nanos: number },
    private readonly gpio: SignalSink,
    private readonly sourceSelect?: () => number,
  ) {
    this.base = layout.base;
  }

  reset(): void {
    this.registers.clear();
    this.anchorNs.fill(0);
    for (let ch = 0; ch < CHANNELS; ch++) {
      if (this.levels[ch] !== undefined) this.gpio.driveSignal(this.layout.signalBase + ch, undefined);
    }
    this.levels.fill(undefined);
  }

  private peek(offset: number): number {
    return (this.registers.get(offset) ?? 0) >>> 0;
  }

  readUint32(offset: number): number {
    if (offset < CHANNELS * CH_STRIDE) {
      const ch = Math.floor(offset / CH_STRIDE);
      const field = offset % CH_STRIDE;
      // The duty in use reads back as written, fraction included.
      if (field === CH_DUTY_R) return this.peek(ch * CH_STRIDE + CH_DUTY);
      // DUTY_START clears itself once the duty is taken up, which is at once here.
      if (field === CH_CONF1) return this.peek(offset) & ~DUTY_START;
    }
    if (offset >= TIMER_VALUE && offset < TIMER_CONF + TIMERS * TIMER_STRIDE && (offset - TIMER_VALUE) % TIMER_STRIDE === 0) {
      return this.count((offset - TIMER_VALUE) / TIMER_STRIDE, this.clock.nanos);
    }
    return this.peek(offset);
  }

  writeUint32(offset: number, value: number): void {
    const timer = offset >= TIMER_CONF && offset < TIMER_CONF + TIMERS * TIMER_STRIDE && (offset - TIMER_CONF) % TIMER_STRIDE === 0
      ? (offset - TIMER_CONF) / TIMER_STRIDE
      : undefined;
    const before = timer === undefined ? 0 : this.timerShape(timer);
    this.registers.set(offset, value >>> 0);
    // A timer held in reset, or given a new divider or resolution, starts its
    // count again from zero.
    if (timer !== undefined && (this.timerShape(timer) !== before || (value >>> this.layout.rstBit) & 1)) {
      this.anchorNs[timer] = this.clock.nanos;
    }
    this.update();
  }

  /** The fields that decide a timer's period, to notice when they change. */
  private timerShape(timer: number): number {
    const conf = this.peek(TIMER_CONF + timer * TIMER_STRIDE);
    return (conf & this.layout.dutyResMask) | (((conf >>> this.layout.clkDivShift) & 0x3ffff) << 5);
  }

  // ------------------------------------------------------------- the timers

  private sourceHz(): number {
    const sel = this.sourceSelect ? this.sourceSelect() : this.peek(this.layout.confOffset) & 0x3;
    return SOURCE_HZ[sel] ?? 0;
  }

  /** A timer's count period in ns and its counts per cycle, or undefined while it is stopped. */
  private timing(timer: number): { tickNs: number; span: number } | undefined {
    const conf = this.peek(TIMER_CONF + timer * TIMER_STRIDE);
    if ((conf >>> this.layout.rstBit) & 1 || (conf >>> this.layout.pauseBit) & 1) return undefined;
    const div = ((conf >>> this.layout.clkDivShift) & 0x3ffff) / 256;
    const hz = this.sourceHz();
    if (div < 1 || hz === 0) return undefined;
    return { tickNs: (div * 1e9) / hz, span: 2 ** (conf & this.layout.dutyResMask) };
  }

  private count(timer: number, ns: number): number {
    const t = this.timing(timer);
    if (!t) return 0;
    return Math.floor((ns - this.anchorNs[timer]) / t.tickNs + 1e-9) % t.span;
  }

  // ----------------------------------------------------------- the channels

  private channel(ch: number) {
    const base = ch * CH_STRIDE;
    const conf0 = this.peek(base + CH_CONF0);
    return {
      timer: conf0 & 0x3,
      enabled: (conf0 & SIG_OUT_EN) !== 0,
      idle: ((conf0 & IDLE_LV) !== 0 ? 1 : 0) as 0 | 1,
      hpoint: this.peek(base + CH_HPOINT) & 0xfffff,
      duty: Math.floor(this.peek(base + CH_DUTY) / 16),
      configured: this.registers.has(base + CH_CONF0),
    };
  }

  /** A channel's level at `ns`, or undefined if firmware never set it up. */
  private levelAt(ch: number, ns: number): 0 | 1 | undefined {
    const c = this.channel(ch);
    if (!c.configured) return undefined;
    if (!c.enabled) return c.idle;
    const t = this.timing(c.timer);
    if (!t) return c.idle;
    if (c.duty <= 0) return 0;
    if (c.duty >= t.span) return 1;
    const count = this.count(c.timer, ns);
    return count >= c.hpoint && count < c.hpoint + c.duty ? 1 : 0;
  }

  /** When a channel next changes level, after `ns`. */
  private nextEdge(ch: number, ns: number): number | undefined {
    const c = this.channel(ch);
    if (!c.configured || !c.enabled) return undefined;
    const t = this.timing(c.timer);
    if (!t || c.duty <= 0 || c.duty >= t.span) return undefined;
    const anchor = this.anchorNs[c.timer];
    const periodNs = t.span * t.tickNs;
    const cycleStart = anchor + Math.floor((ns - anchor) / periodNs + 1e-9) * periodNs;
    let best: number | undefined;
    for (const k of [0, 1]) {
      for (const at of [c.hpoint, Math.min(c.hpoint + c.duty, t.span)]) {
        const when = cycleStart + k * periodNs + at * t.tickNs;
        if (when > ns + 1e-6 && (best === undefined || when < best)) best = when;
      }
    }
    return best;
  }

  /** Brings every channel's output up to the present. */
  private update(): void {
    const now = this.clock.nanos;
    for (let ch = 0; ch < CHANNELS; ch++) {
      const level = this.levelAt(ch, now);
      if (level === this.levels[ch]) continue;
      this.levels[ch] = level;
      this.gpio.driveSignal(this.layout.signalBase + ch, level === undefined ? undefined : { level, enable: true });
    }
  }

  // ------------------------------------------------- telling the machine when

  nextInterruptChangeNanos(): number | undefined {
    const now = this.clock.nanos;
    let soonest: number | undefined;
    for (let ch = 0; ch < CHANNELS; ch++) {
      const at = this.nextEdge(ch, now);
      if (at !== undefined && (soonest === undefined || at < soonest)) soonest = at;
    }
    return soonest;
  }

  /**
   * Called whenever the machine re-reads its interrupt sources, which it does
   * at the time nextInterruptChangeNanos() named: the moment to move the
   * outputs. The LEDC's own interrupts are not modelled, so it asserts none.
   */
  assertedInterruptSources(): number[] {
    this.update();
    return [];
  }
}
