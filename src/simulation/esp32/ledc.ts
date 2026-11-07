// The ESP32's LED PWM controller: 8 high-speed and 8 low-speed channels, each
// group with its own four timers.
//
// analogWrite(), ledcWrite(), tone() and the ESP32Servo library all run on it.
// A timer counts at its clock over an 18-bit divider with 8 fractional bits
// and wraps every 2^resolution counts; a channel is high while its timer's
// count is in [hpoint, hpoint + duty) and drives matrix signal
// LEDC_HS_SIG_OUT0 (71) + n or LEDC_LS_SIG_OUT0 (79) + n. Levels follow from
// simulated time and the controller tells the machine when its next edge is
// due, as the C3's model does. Offsets and fields are from
// soc/esp32/register/soc/ledc_reg.h.
//
// Clocks: a high-speed timer runs from APB (TICK_SEL set) or the 1 MHz
// REF_TICK; a low-speed timer from REF_TICK (TICK_SEL set) or SLOW_CLK, which
// LEDC_CONF selects as APB or the 8 MHz RC oscillator. Not modelled: fades,
// the overflow counter and the LEDC interrupts.

import type { InterruptingPeripheral, Peripheral, SimulatedClock } from '../espRiscv/peripheral';

const CH_STRIDE = 0x14;
const GROUPS = [
  { channels: 0x00, timers: 0x140, signal: 71, high: true },
  { channels: 0xa0, timers: 0x160, signal: 79, high: false },
];
const CONF = 0x190;

interface SignalSink {
  driveSignal(signal: number, level: 0 | 1): void;
}

export class Esp32Ledc implements Peripheral, InterruptingPeripheral {
  readonly name = 'ledc';
  readonly base = 0x3ff59000;
  readonly size = 0x1000;
  private readonly regs = new Map<number, number>();
  private readonly anchorNs = new Array<number>(8).fill(0);
  private readonly levels = new Array<0 | 1 | undefined>(16).fill(undefined);

  constructor(
    private readonly clock: SimulatedClock,
    private readonly gpio: SignalSink,
    private readonly apbHz: () => number,
  ) {}

  reset(): void {
    this.regs.clear();
    this.anchorNs.fill(0);
    this.levels.fill(undefined);
  }

  private peek(offset: number): number {
    return (this.regs.get(offset) ?? 0) >>> 0;
  }

  /** Timer index 0..7 (high-speed 0-3, low-speed 4-7) of a TIMER_CONF offset, if it is one. */
  private timerAt(offset: number): number | undefined {
    for (let g = 0; g < 2; g++) {
      const rel = offset - GROUPS[g].timers;
      if (rel >= 0 && rel < 32 && rel % 8 === 0) return g * 4 + rel / 8;
    }
    return undefined;
  }

  readUint32(offset: number): number {
    for (let g = 0; g < 2; g++) {
      const rel = offset - GROUPS[g].channels;
      if (rel >= 0 && rel < 8 * CH_STRIDE) {
        const field = rel % CH_STRIDE;
        // DUTY_R reads back the duty in use; DUTY_START clears once taken up.
        if (field === 0x10) return this.peek(offset - 0x10 + 0x08);
        if (field === 0x0c) return this.peek(offset) & ~(1 << 31);
      }
      const t = offset - GROUPS[g].timers - 4;
      if (t >= 0 && t < 32 && t % 8 === 0) return this.count(g * 4 + t / 8, this.clock.nanos);
    }
    return this.peek(offset);
  }

  writeUint32(offset: number, value: number): void {
    const timer = this.timerAt(offset);
    const before = timer === undefined ? 0 : this.shape(timer);
    this.regs.set(offset, value >>> 0);
    if (timer !== undefined && (this.shape(timer) !== before || (value >>> 24) & 1)) this.anchorNs[timer] = this.clock.nanos;
    this.update();
  }

  private timerConf(timer: number): number {
    return this.peek(GROUPS[timer >> 2].timers + (timer & 3) * 8);
  }

  private shape(timer: number): number {
    return this.timerConf(timer) & 0x27fffff;
  }

  private sourceHz(timer: number): number {
    const conf = this.timerConf(timer);
    const tickSel = (conf >>> 25) & 1;
    if (timer < 4) return tickSel ? this.apbHz() : 1e6;
    if (tickSel) return 1e6;
    return this.peek(CONF) & 1 ? this.apbHz() : 8e6;
  }

  private timing(timer: number): { tickNs: number; span: number } | undefined {
    const conf = this.timerConf(timer);
    if ((conf >>> 24) & 1 || (conf >>> 23) & 1) return undefined;
    const div = ((conf >>> 5) & 0x3ffff) / 256;
    if (div < 1) return undefined;
    return { tickNs: (div * 1e9) / this.sourceHz(timer), span: 2 ** (conf & 0x1f) };
  }

  private count(timer: number, ns: number): number {
    const t = this.timing(timer);
    if (!t) return 0;
    return Math.floor((ns - this.anchorNs[timer]) / t.tickNs + 1e-9) % t.span;
  }

  private channel(ch: number) {
    const g = ch >> 3;
    const base = GROUPS[g].channels + (ch & 7) * CH_STRIDE;
    const conf0 = this.peek(base);
    return {
      timer: g * 4 + (conf0 & 3),
      enabled: (conf0 & 4) !== 0,
      idle: ((conf0 >>> 3) & 1) as 0 | 1,
      hpoint: this.peek(base + 4) & 0xfffff,
      duty: Math.floor(this.peek(base + 8) / 16),
      configured: this.regs.has(base),
    };
  }

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

  private update(): void {
    const now = this.clock.nanos;
    for (let ch = 0; ch < 16; ch++) {
      const level = this.levelAt(ch, now);
      if (level === this.levels[ch]) continue;
      this.levels[ch] = level;
      if (level !== undefined) this.gpio.driveSignal(GROUPS[ch >> 3].signal + (ch & 7), level);
    }
  }

  nextInterruptChangeNanos(): number | undefined {
    const now = this.clock.nanos;
    let soonest: number | undefined;
    for (let ch = 0; ch < 16; ch++) {
      const at = this.nextEdge(ch, now);
      if (at !== undefined && (soonest === undefined || at < soonest)) soonest = at;
    }
    return soonest;
  }

  assertedInterruptSources(): number[] {
    this.update();
    return [];
  }
}
