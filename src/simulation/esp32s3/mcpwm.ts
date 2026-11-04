// The ESP32-S3's motor-control PWM (MCPWM0 and MCPWM1), which the ESP32Servo
// library drives servos with on this chip instead of LEDC.
//
// Each unit has three timers and three operators; an operator compares the
// timer it is bound to against two values and its two generators turn the
// timer events — zero (TEZ), the compare values (TEA, TEB) and the period
// (TEP) — into an output level through per-event actions (none, low, high,
// toggle). Generator outputs are matrix signals PWMn_OUTxA/B (160 + 6n + 2x
// + b). Offsets and fields are soc/esp32s3/register/soc/mcpwm_reg.h; the clock
// is the 160 MHz PLL_F160M divided by the group and timer prescalers.
//
// Modelled: up counting, free-running timers, the four up-count events and
// their actions. Not modelled: down and up-down counting, dead time, carrier,
// fault handling, capture, synchronisation, shadow-register update timing
// (values take effect at once) and the interrupts.

import type { InterruptingPeripheral, Peripheral, SimulatedClock } from '../espRiscv/peripheral';

const SOURCE_HZ = 160e6;
const TIMER_STRIDE = 0x10;
const OPERATOR_STRIDE = 0x38;
const GEN_BASE = 0x3c;

interface SignalSink {
  driveSignal(signal: number, level: 0 | 1): void;
}

export class Esp32S3Mcpwm implements Peripheral, InterruptingPeripheral {
  readonly size = 0x1000;
  private readonly regs = new Map<number, number>();
  private readonly anchorNs = [0, 0, 0];
  private readonly levels: (0 | 1 | undefined)[] = new Array(6).fill(undefined);

  constructor(
    readonly name: string,
    readonly base: number,
    private readonly unit: number,
    private readonly clock: SimulatedClock,
    private readonly gpio: SignalSink,
  ) {}

  reset(): void {
    this.regs.clear();
    this.anchorNs.fill(0);
    this.levels.fill(undefined);
  }

  private peek(o: number): number {
    return (this.regs.get(o) ?? 0) >>> 0;
  }

  readUint32(offset: number): number {
    // TIMERn_STATUS: the live count.
    for (let t = 0; t < 3; t++) if (offset === 0x10 + t * TIMER_STRIDE) return this.count(t, this.clock.nanos);
    return this.peek(offset);
  }

  writeUint32(offset: number, value: number): void {
    const timer = offset >= 0x04 && offset < 0x34 ? Math.floor((offset - 0x04) / TIMER_STRIDE) : -1;
    const before = timer >= 0 ? this.shape(timer) : 0;
    this.regs.set(offset, value >>> 0);
    if (timer >= 0 && this.shape(timer) !== before) this.anchorNs[timer] = this.clock.nanos;
    if (offset === 0x00) this.anchorNs.fill(this.clock.nanos);
    this.update();
  }

  private shape(t: number): number {
    return (this.peek(0x04 + t * TIMER_STRIDE) & 0xffffff) ^ ((this.peek(0x08 + t * TIMER_STRIDE) & 0x1f) << 24);
  }

  /** A timer's tick length and period in ticks, or undefined while it is stopped. */
  private timing(t: number): { tickNs: number; period: number } | undefined {
    const cfg0 = this.peek(0x04 + t * TIMER_STRIDE);
    const cfg1 = this.peek(0x08 + t * TIMER_STRIDE);
    if (((cfg1 >>> 3) & 3) !== 1) return undefined; // only up counting
    if ((cfg1 & 7) === 0) return undefined; // stopped
    const group = (this.peek(0x00) & 0xff) + 1;
    const pre = (cfg0 & 0xff) + 1;
    const period = ((cfg0 >>> 8) & 0xffff) + 1;
    return { tickNs: (1e9 * group * pre) / SOURCE_HZ, period };
  }

  private count(t: number, ns: number): number {
    const tm = this.timing(t);
    if (!tm) return 0;
    return Math.floor((ns - this.anchorNs[t]) / tm.tickNs + 1e-9) % tm.period;
  }

  private timerOf(op: number): number {
    return (this.peek(0x38) >>> (op * 2)) & 3;
  }

  /** Events of a generator in one up-count period, in order: [tick, action]. */
  private events(op: number, gen: number, period: number): [number, number][] {
    const g = GEN_BASE + op * OPERATOR_STRIDE;
    const act = this.peek(g + 0x14 + gen * 4);
    const cmpA = this.peek(g + 0x04) & 0xffff;
    const cmpB = this.peek(g + 0x08) & 0xffff;
    const out: [number, number][] = [
      [0, act & 3],
      [cmpA, (act >>> 4) & 3],
      [cmpB, (act >>> 6) & 3],
      [period - 1, (act >>> 2) & 3],
    ];
    return out.filter(([tick, a]) => a !== 0 && tick < period).sort((x, y) => x[0] - y[0]);
  }

  private apply(level: 0 | 1, action: number): 0 | 1 {
    return action === 1 ? 0 : action === 2 ? 1 : action === 3 ? ((1 - level) as 0 | 1) : level;
  }

  private configured(op: number, gen: number): boolean {
    return this.regs.has(GEN_BASE + op * OPERATOR_STRIDE + 0x14 + gen * 4);
  }

  private levelAt(op: number, gen: number, ns: number): 0 | 1 | undefined {
    if (!this.configured(op, gen)) return undefined;
    const t = this.timerOf(op);
    const tm = this.timing(t);
    if (!tm) return 0;
    const evs = this.events(op, gen, tm.period);
    // The level a whole period leaves behind, starting low, is where the next starts.
    let level: 0 | 1 = 0;
    for (const [, a] of evs) level = this.apply(level, a);
    const c = this.count(t, ns);
    for (const [tick, a] of evs) if (tick <= c) level = this.apply(level, a);
    return level;
  }

  private nextEdge(op: number, gen: number, ns: number): number | undefined {
    if (!this.configured(op, gen)) return undefined;
    const t = this.timerOf(op);
    const tm = this.timing(t);
    if (!tm) return undefined;
    const evs = this.events(op, gen, tm.period);
    if (evs.length === 0) return undefined;
    const periodNs = tm.period * tm.tickNs;
    const anchor = this.anchorNs[t];
    const start = anchor + Math.floor((ns - anchor) / periodNs + 1e-9) * periodNs;
    let best: number | undefined;
    for (const k of [0, 1]) {
      for (const [tick] of evs) {
        const when = start + k * periodNs + tick * tm.tickNs;
        if (when > ns + 1e-6 && (best === undefined || when < best)) best = when;
      }
    }
    return best;
  }

  private update(): void {
    const now = this.clock.nanos;
    for (let i = 0; i < 6; i++) {
      const level = this.levelAt(i >> 1, i & 1, now);
      if (level === this.levels[i]) continue;
      this.levels[i] = level;
      if (level !== undefined) this.gpio.driveSignal(160 + 6 * this.unit + i, level);
    }
  }

  nextInterruptChangeNanos(): number | undefined {
    const now = this.clock.nanos;
    let soonest: number | undefined;
    for (let i = 0; i < 6; i++) {
      const at = this.nextEdge(i >> 1, i & 1, now);
      if (at !== undefined && (soonest === undefined || at < soonest)) soonest = at;
    }
    return soonest;
  }

  assertedInterruptSources(): number[] {
    this.update();
    return [];
  }
}
