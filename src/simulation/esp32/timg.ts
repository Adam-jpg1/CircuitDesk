// The ESP32's two timer groups: two 64-bit general-purpose timers and the
// LACT timer each, the watchdog, and the RTC slow-clock calibration unit.
//
// Offsets and fields are from soc/esp32/register/soc/timer_group_reg.h. LACT
// matters most: ESP-IDF's esp_timer runs on TG0's LACT on this chip, so it is
// what millis(), micros() and every esp_timer callback are measured against.
// Arduino's timerBegin() runs on T0/T1 through the gptimer driver.
//
// Counters are derived from simulated time rather than incremented, so a
// counter reads exactly what its clock and divider say it should whenever it
// is read. The watchdogs are register storage: nothing a sketch does should
// starve them, and a watchdog reset is not something the simulator invents.

import type { InterruptingPeripheral, Peripheral, SimulatedClock } from '../espRiscv/peripheral';

const INT_ENA = 0x98, INT_RAW = 0x9c, INT_ST = 0xa0, INT_CLR = 0xa4;
const RTCCALICFG = 0x68, RTCCALICFG1 = 0x6c;

/** One counter: T0 at 0x00, T1 at 0x24, LACT at 0x70, all laid out alike. */
class Counter {
  config = 0;
  private base = 0;
  /** Simulated time the counter last started from `base`. */
  private since = 0;
  latched = 0;
  alarm = 0;
  load = 0;
  regs = new Uint32Array(16);

  constructor(
    readonly offset: number,
    readonly bit: number,
  ) {}

  enabled(): boolean {
    return (this.config >>> 31) === 1;
  }

  tickNs(apbHz: number): number {
    const div = (this.config >>> 13) & 0xffff;
    return (1e9 * (div === 0 ? 65536 : div < 2 ? 2 : div)) / apbHz;
  }

  value(now: number, apbHz: number): number {
    if (!this.enabled()) return this.base;
    const ticks = Math.floor((now - this.since) / this.tickNs(apbHz));
    const up = ((this.config >>> 30) & 1) === 1;
    const v = up ? this.base + ticks : this.base - ticks;
    // Wrapped only when it actually leaves the range: adding 2^64 to a double
    // would round away its low twelve bits.
    return v < 0 ? v + 2 ** 64 : v >= 2 ** 64 ? v - 2 ** 64 : v;
  }

  set(v: number, now: number): void {
    this.base = v;
    this.since = now;
  }

  /** Re-anchors so a divider or enable change applies from now on. */
  rebase(now: number, apbHz: number): void {
    this.base = this.value(now, apbHz);
    this.since = now;
  }

  alarmEnabled(): boolean {
    return ((this.config >>> 10) & 1) === 1;
  }

  /** Simulated time the counter reaches its alarm, if it is counting toward it. */
  alarmAt(now: number, apbHz: number): number | undefined {
    if (!this.enabled() || !this.alarmEnabled()) return undefined;
    const v = this.value(now, apbHz);
    const up = ((this.config >>> 30) & 1) === 1;
    const distance = up ? this.alarm - v : v - this.alarm;
    if (distance <= 0) return now;
    // Rounded up to the next whole tick.
    const tick = this.tickNs(apbHz);
    return this.since + Math.ceil(((up ? this.alarm - this.base : this.base - this.alarm)) * tick);
  }
}

export class Esp32TimerGroup implements Peripheral, InterruptingPeripheral {
  readonly size = 0x1000;
  private readonly counters: Counter[] = [new Counter(0x00, 0), new Counter(0x24, 1), new Counter(0x70, 3)];
  private raw = 0;
  private ena = 0;
  private readonly other = new Map<number, number>();

  constructor(
    readonly name: string,
    readonly base: number,
    private readonly clock: SimulatedClock,
    /** Interrupt sources of T0, T1, WDT and LACT, in that order. */
    private readonly sources: [number, number, number, number],
    private readonly apbHz: () => number,
  ) {}

  reset(): void {
    for (const c of this.counters) {
      c.config = 0;
      c.set(0, this.clock.nanos);
      c.latched = c.alarm = c.load = 0;
    }
    this.raw = this.ena = 0;
    this.other.clear();
  }

  private counterAt(offset: number): [Counter, number] | undefined {
    for (const c of this.counters) {
      if (c.offset === 0x70) {
        // LACT has one more register than T0/T1 (LACTRTC at +4), so the rest sit a word later.
        if (offset < 0x70 || offset >= 0x98) continue;
        const r = offset - 0x70;
        return [c, r === 0 ? 0 : r === 4 ? 0x24 : r - 4];
      }
      if (offset >= c.offset && offset < c.offset + 0x24) return [c, offset - c.offset];
    }
    return undefined;
  }

  /** Fires any alarm whose time has come. */
  private update(): void {
    const now = this.clock.nanos;
    const hz = this.apbHz();
    for (const c of this.counters) {
      const at = c.alarmAt(now, hz);
      if (at === undefined || at > now) continue;
      this.raw |= 1 << c.bit;
      // The alarm disarms itself; auto-reload restarts from the load value.
      c.config &= ~(1 << 10);
      if ((c.config >>> 29) & 1) c.set(c.load, now);
    }
  }

  readUint32(offset: number): number {
    this.update();
    const hit = this.counterAt(offset);
    if (hit) {
      const [c, r] = hit;
      switch (r) {
        case 0x00: return c.config >>> 0;
        case 0x04: return c.latched % 2 ** 32;
        case 0x08: return Math.floor(c.latched / 2 ** 32) >>> 0;
        case 0x0c: return 0;
        case 0x10: return c.alarm % 2 ** 32;
        case 0x14: return Math.floor(c.alarm / 2 ** 32) >>> 0;
        case 0x18: return c.load % 2 ** 32;
        case 0x1c: return Math.floor(c.load / 2 ** 32) >>> 0;
        default: return c.regs[r >> 2] ?? 0;
      }
    }
    switch (offset) {
      case INT_ENA: return this.ena;
      case INT_RAW: return this.raw;
      case INT_ST: return this.raw & this.ena;
      // Calibration is always finished: RDY, with the value written on start.
      case RTCCALICFG: return ((this.other.get(offset) ?? 0) | (1 << 15)) >>> 0;
      default: return this.other.get(offset) ?? 0;
    }
  }

  writeUint32(offset: number, value: number): void {
    this.update();
    value >>>= 0;
    const now = this.clock.nanos;
    const hz = this.apbHz();
    const hit = this.counterAt(offset);
    if (hit) {
      const [c, r] = hit;
      switch (r) {
        case 0x00:
          c.rebase(now, hz);
          c.config = value;
          return;
        case 0x0c: c.latched = c.value(now, hz); return;
        case 0x10: c.alarm = (c.alarm - (c.alarm % 2 ** 32)) + value; return;
        case 0x14: c.alarm = (c.alarm % 2 ** 32) + value * 2 ** 32; return;
        case 0x18: c.load = (c.load - (c.load % 2 ** 32)) + value; return;
        case 0x1c: c.load = (c.load % 2 ** 32) + value * 2 ** 32; return;
        case 0x20: c.set(c.load, now); return;
        default: c.regs[r >> 2] = value; return;
      }
    }
    switch (offset) {
      case INT_ENA: this.ena = value & 0xf; return;
      case INT_CLR: this.raw &= ~value; return;
      case INT_RAW: case INT_ST: return;
      case RTCCALICFG:
        this.other.set(offset, value);
        if (value >>> 31) {
          // XTAL cycles counted over the requested number of slow-clock
          // cycles: the 150 kHz internal RC against a 40 MHz crystal.
          const cycles = (value >>> 16) & 0x7fff;
          this.other.set(RTCCALICFG1, (Math.round((cycles * 40e6) / 150e3) << 7) >>> 0);
        }
        return;
      default: this.other.set(offset, value);
    }
  }

  assertedInterruptSources(): number[] {
    this.update();
    const out: number[] = [];
    const st = this.raw & this.ena;
    for (let i = 0; i < 4; i++) if ((st >>> i) & 1) out.push(this.sources[i]);
    return out;
  }

  nextInterruptChangeNanos(): number | undefined {
    const now = this.clock.nanos;
    const hz = this.apbHz();
    let soonest: number | undefined;
    for (const c of this.counters) {
      const at = c.alarmAt(now, hz);
      if (at !== undefined && (soonest === undefined || at < soonest)) soonest = at;
    }
    return soonest;
  }
}
