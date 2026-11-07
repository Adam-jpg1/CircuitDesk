// The i.MX RT1062's Periodic Interrupt Timer: four 32-bit down-counters on
// the peripheral clock, one shared interrupt.
//
// The Teensy 4 core's IntervalTimer runs on it, and tone() runs on
// IntervalTimer, so without it both were silent. Each channel counts LDVAL+1
// ticks of PERCLK (24 MHz: the core selects the oscillator, undivided), sets
// TIF, reloads, and counts again; TIE routes TIF to the PIT interrupt. A new
// LDVAL takes effect at the next reload, as the reference manual says;
// enabling a channel starts it from LDVAL. Chained mode (CHN) and the
// lifetime timer are not modelled — IntervalTimer uses neither.

import type { EventQueue, Periph } from '../armv7m/peripherals';

/** PERCLK as the Teensy 4 core sets it up: the 24 MHz oscillator, divided by one. */
export const PIT_CLOCK_HZ = 24_000_000;

const MCR = 0x000;
const MCR_MDIS = 1 << 1;
const CH_BASE = 0x100;
const LDVAL = 0x0;
const CVAL = 0x4;
const TCTRL = 0x8;
const TFLG = 0xc;
const TEN = 1 << 0;
const TIE = 1 << 1;
const TIF = 1 << 0;

interface PitHost {
  readonly hz: number;
  readonly events: EventQueue;
  readonly cycles: () => number;
  setIrq(on: boolean): void;
}

export class Pit {
  private readonly cancel: ((() => void) | null)[] = [null, null, null, null];
  /** The CPU cycle each running channel last reloaded at, and its period then. */
  private readonly start = [0, 0, 0, 0];
  private readonly period = [0, 0, 0, 0];

  constructor(
    private readonly host: PitHost,
    private readonly p: Periph,
  ) {
    p.init(MCR, MCR_MDIS);
    p.reg(MCR, undefined, (v, previous) => {
      // Only a change of MDIS starts or stops the timers: IntervalTimer
      // writes MCR on every begin(), and a running channel keeps counting.
      if ((v ^ previous) & MCR_MDIS) for (let ch = 0; ch < 4; ch++) this.restart(ch);
    });
    for (let ch = 0; ch < 4; ch++) {
      const base = CH_BASE + ch * 0x10;
      p.reg(base + LDVAL);
      p.reg(base + CVAL, () => this.current(ch));
      p.reg(base + TCTRL, undefined, (v, previous) => {
        // Enabling starts the count from LDVAL; disabling stops it. Rewriting
        // TCTRL with TEN already set (to change TIE) leaves the count alone.
        if (!(v & TEN)) this.stop(ch);
        else if (!(previous & TEN) || !this.cancel[ch]) this.restart(ch);
        this.updateIrq();
      });
      p.reg(base + TFLG, undefined, (v, previous) => {
        // TIF is cleared by writing a 1; writing 0 leaves it.
        p.poke(base + TFLG, previous & ~v & TIF);
        this.updateIrq();
      });
    }
  }

  private running(ch: number): boolean {
    return !(this.p.peek(MCR) & MCR_MDIS) && (this.p.peek(CH_BASE + ch * 0x10 + TCTRL) & TEN) !== 0;
  }

  /** LDVAL+1 PIT ticks, in CPU cycles. */
  private cyclesFor(ch: number): number {
    const ticks = (this.p.peek(CH_BASE + ch * 0x10 + LDVAL) >>> 0) + 1;
    return Math.max(1, Math.round((ticks * this.host.hz) / PIT_CLOCK_HZ));
  }

  private stop(ch: number): void {
    this.cancel[ch]?.();
    this.cancel[ch] = null;
  }

  private restart(ch: number): void {
    this.stop(ch);
    if (!this.running(ch)) return;
    this.arm(ch);
  }

  /**
   * Counts LDVAL+1 ticks from `from` (now, when the channel is started). A
   * reload counts from the moment the previous count reached zero, not from
   * when the simulator got round to it, so a periodic timer does not drift.
   */
  private arm(ch: number, from = this.host.cycles()): void {
    const period = this.cyclesFor(ch);
    const due = from + period;
    this.start[ch] = from;
    this.period[ch] = period;
    this.cancel[ch] = this.host.events.scheduleAt(due, () => {
      this.cancel[ch] = null;
      this.p.poke(CH_BASE + ch * 0x10 + TFLG, TIF);
      this.updateIrq();
      // Reload with whatever LDVAL holds now.
      if (this.running(ch)) this.arm(ch, due);
    });
  }

  /** CVAL: the ticks left before this channel next reaches zero. */
  private current(ch: number): number {
    if (!this.cancel[ch]) return this.p.peek(CH_BASE + ch * 0x10 + LDVAL) >>> 0;
    const elapsed = this.host.cycles() - this.start[ch];
    const left = Math.max(0, this.period[ch] - elapsed);
    return Math.floor((left * PIT_CLOCK_HZ) / this.host.hz) >>> 0;
  }

  private updateIrq(): void {
    let on = false;
    for (let ch = 0; ch < 4; ch++) {
      const base = CH_BASE + ch * 0x10;
      if (this.p.peek(base + TFLG) & TIF && this.p.peek(base + TCTRL) & TIE) on = true;
    }
    this.host.setIrq(on);
  }
}
