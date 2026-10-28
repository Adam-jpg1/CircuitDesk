// The SAMD21's TCC0-2 and TC3-7: counters on the simulated clock, their
// compare matches and overflows, the interrupts those raise, and the
// waveform outputs that the PORT multiplexer hands to pads.
//
// A running timer counts at the CPU clock over its prescaler, and nothing is
// stepped per tick: COUNT is worked out from the time whenever it is read, and
// one alarm is set for the next thing that happens — a compare match or the
// counter wrapping at TOP. At each, the timer raises its interrupt flags (MCx,
// OVF), takes its interrupt line to the NVIC if INTEN allows, and moves its
// outputs:
//   * normal PWM (NPWM): every channel with a compare value above zero goes
//     high when the counter wraps and low at its match, so a pad toggles at
//     the timer's frequency with duty CC / (TOP + 1) — analogWrite();
//   * match frequency (MFRQ): TOP is CC0, and WO0 toggles each time the
//     counter reaches it.
// Arduino's Servo library runs a TC in NPWM with the MC0 interrupt, reading
// COUNT and setting CC0 a pulse width ahead each time; tone() runs TC5 in
// MFRQ with MC0 and toggles the pin from the handler. Both need exactly this.
//
// TOP is PER on a TCC and on a TC in 8-bit mode, the counter's maximum on a TC
// in 16- or 32-bit mode, and CC0 in MFRQ. Not modelled: counting down,
// one-shot, the dual-slope modes, captures, events, dead time and the pattern
// generator.

import { RegisterBlock } from './registerBlock';

/** TCC0-2 are timers 0-2 and TC3-7 are timers 3-7, as the Arduino core numbers them. */
export type TimerOutput = readonly [timer: number, waveformOutput: number];

/**
 * Which timer output each pad carries on peripheral functions E and F, from
 * the datasheet's I/O multiplexing table. Pads are group * 32 + bit.
 */
export const TIMER_FUNCTION_E: Record<number, TimerOutput> = {
  0: [2, 0], 1: [2, 1], 4: [0, 0], 5: [0, 1], 6: [1, 0], 7: [1, 1],
  8: [0, 0], 9: [0, 1], 10: [1, 0], 11: [1, 1], 12: [2, 0], 13: [2, 1],
  14: [3, 0], 15: [3, 1], 16: [2, 0], 17: [2, 1], 18: [3, 0], 19: [3, 1],
  20: [7, 0], 21: [7, 1], 22: [4, 0], 23: [4, 1], 24: [5, 0], 25: [5, 1],
  30: [1, 0], 31: [1, 1],
  32: [7, 0], 33: [7, 1], 34: [6, 0], 35: [6, 1], 40: [4, 0], 41: [4, 1],
  42: [5, 0], 43: [5, 1], 44: [4, 0], 45: [4, 1], 46: [5, 0], 47: [5, 1],
  48: [6, 0], 49: [6, 1], 54: [7, 0], 55: [7, 1], 62: [0, 0], 63: [0, 1],
};
export const TIMER_FUNCTION_F: Record<number, TimerOutput> = {
  8: [1, 2], 9: [1, 3], 10: [0, 2], 11: [0, 3], 12: [0, 6], 13: [0, 7],
  14: [0, 4], 15: [0, 5], 16: [0, 6], 17: [0, 7], 18: [0, 2], 19: [0, 3],
  20: [0, 6], 21: [0, 7], 22: [0, 4], 23: [0, 5], 24: [1, 2], 25: [1, 3],
  42: [0, 4], 43: [0, 5], 44: [0, 6], 45: [0, 7], 48: [0, 4], 49: [0, 5],
  62: [1, 2], 63: [1, 3],
};

/** NVIC line of TCC0; TCC1, TCC2 and TC3-7 follow it (datasheet table 11-3). */
export const TCC0_IRQ = 15;

const PRESCALER = [1, 2, 4, 8, 16, 64, 256, 1024];
const WAVEGEN_MFRQ = 1;
const WAVEGEN_NPWM = 2;
/**
 * Faster than this and a period is spaced out to it: a PWM's duty is kept, its
 * frequency is not. Nothing in the Arduino core comes near it.
 */
const MIN_PERIOD_NS = 2_000;

/** INTFLAG bits: OVF is bit 0 on both; MCx is bit 4 + x on a TC, 16 + x on a TCC. */
const OVF = 1;

interface Alarm {
  schedule(ns: number): void;
  cancel(): void;
}

export interface TimerHost {
  clockHz: number;
  createAlarm(callback: () => void): Alarm;
  /** The simulation clock, in nanoseconds. */
  nowNs(): number;
  /** A waveform output changed level. */
  outputsChanged(): void;
  /** Raises or lowers a timer's NVIC line. */
  setInterrupt(irq: number, pending: boolean): void;
}

export class Samd21Timer {
  readonly block: RegisterBlock;
  readonly isTcc: boolean;
  /** Compare channels: TCC0 has four, TCC1 and TCC2 two, each TC two. */
  private readonly channels: number;
  private readonly levels: boolean[];
  private readonly pendingCc: (number | undefined)[];
  private readonly alarm: Alarm;
  private running = false;
  /** COUNT at `anchorNs`; while running it advances from there with time. */
  private anchorCount = 0;
  private anchorNs = 0;
  private intflag = 0;
  private inten = 0;

  constructor(readonly index: number, base: number, private readonly host: TimerHost) {
    this.isTcc = index < 3;
    this.channels = index === 0 ? 4 : 2;
    this.block = new RegisterBlock(this.isTcc ? `TCC${index}` : `TC${index}`, base, 0x400);
    this.levels = new Array(this.channels).fill(false);
    this.pendingCc = new Array(this.channels).fill(undefined);
    this.alarm = host.createAlarm(() => this.fire());

    const b = this.block;
    b.on(0x00, {
      width: 4,
      read: () => b.peek(0x00, 4) & ~1,
      write: (v) => {
        if (v & 1) {
          b.bytes.fill(0);
          this.pendingCc.fill(undefined);
          this.anchorCount = 0;
          this.intflag = 0;
          this.inten = 0;
          this.updateIrq();
        }
        this.reconfigure();
      },
    });
    const flags = this.isTcc ? { clr: 0x24, set: 0x28, flag: 0x2c, width: 4 as const } : { clr: 0x0c, set: 0x0d, flag: 0x0e, width: 1 as const };
    b.on(flags.clr, { width: flags.width, read: () => this.inten, write: (v) => { this.inten &= ~v; this.updateIrq(); } });
    b.on(flags.set, { width: flags.width, read: () => this.inten, write: (v) => { this.inten |= v; this.updateIrq(); } });
    b.on(flags.flag, { width: flags.width, read: () => this.intflag, write: (v) => { this.intflag &= ~v; this.updateIrq(); } });
    if (this.isTcc) {
      b.on(0x08, { width: 4, read: () => 0 }); // SYNCBUSY
      b.on(0x34, { width: 4, read: () => this.count(), write: (v) => this.setCount(v) });
      b.on(0x3c, { width: 4, write: () => this.reconfigure() }); // WAVE
      b.on(0x40, { width: 4, write: () => this.reconfigure() }); // PER
      for (let ch = 0; ch < this.channels; ch++) {
        b.on(0x44 + ch * 4, { width: 4, write: () => this.reconfigure() }); // CC
        // CCB: buffered, copied into CC at the next update, as analogWrite() relies on.
        b.on(0x70 + ch * 4, { width: 4, write: (v) => (this.pendingCc[ch] = v & 0xffffff) });
      }
    } else {
      b.on(0x0f, { width: 1, read: () => 0 }); // STATUS: never SYNCBUSY
      // COUNT, at the counter's width: one byte, a halfword or (32-bit mode) a word.
      b.on(0x10, { width: 4, read: () => this.count(), write: (v) => this.setCount(v) });
      b.on(0x14, { width: 1, write: () => this.reconfigure() }); // PER (8-bit mode)
      b.on(0x18, { width: 4, write: () => this.reconfigure() }); // CC0/CC1, at every width
      b.on(0x1c, { width: 4, write: () => this.reconfigure() }); // CC1 in 32-bit mode
    }
  }

  /** The level waveform output `wo` drives, while the timer is generating a waveform. */
  output(wo: number): boolean | undefined {
    if (!this.running) return undefined;
    const wavegen = this.wavegen;
    if (wavegen === WAVEGEN_NPWM) return this.levels[wo % this.channels];
    if (wavegen === WAVEGEN_MFRQ && wo % this.channels === 0) return this.levels[0];
    return undefined;
  }

  private get ctrla(): number {
    return this.block.peek(0x00, 4);
  }

  private get enabled(): boolean {
    return (this.ctrla & 0x2) !== 0;
  }

  private get wavegen(): number {
    return this.isTcc ? this.block.peek(0x3c, 4) & 0x7 : (this.ctrla >>> 5) & 0x3;
  }

  /** TC counter width: 0 = 16-bit, 1 = 8-bit, 2 = 32-bit. */
  private get tcMode(): number {
    return (this.ctrla >>> 2) & 0x3;
  }

  private get max(): number {
    if (this.isTcc) return 0xffffff;
    return this.tcMode === 1 ? 0xff : this.tcMode === 2 ? 0xffffffff : 0xffff;
  }

  private get top(): number {
    if (this.wavegen === WAVEGEN_MFRQ) return this.cc(0);
    if (this.isTcc) return this.block.peek(0x40, 4) & 0xffffff;
    return this.tcMode === 1 ? this.block.peek(0x14, 1) : this.max;
  }

  private cc(ch: number): number {
    if (this.isTcc) return this.block.peek(0x44 + ch * 4, 4) & 0xffffff;
    if (this.tcMode === 1) return this.block.peek(0x18 + ch, 1);
    if (this.tcMode === 2) return this.block.peek(0x18 + ch * 4, 4);
    return this.block.peek(0x18 + ch * 2, 2);
  }

  private inverted(ch: number): boolean {
    return this.isTcc ? ((this.block.peek(0x3c, 4) >>> (16 + ch)) & 1) === 1 : false;
  }

  private mcFlag(ch: number): number {
    return 1 << ((this.isTcc ? 16 : 4) + ch);
  }

  /** One count, in ns, spaced out if a whole period would be shorter than MIN_PERIOD_NS. */
  private get tickNs(): number {
    const tick = (PRESCALER[(this.ctrla >>> 8) & 0x7] * 1e9) / this.host.clockHz;
    return Math.max(tick, MIN_PERIOD_NS / (this.top + 1));
  }

  private updateIrq(): void {
    this.host.setInterrupt(TCC0_IRQ + this.index, (this.intflag & this.inten) !== 0);
  }

  // ----------------------------------------------------------------- counting

  /** COUNT now. */
  private count(): number {
    if (!this.running) return this.anchorCount;
    const ticks = Math.floor((this.host.nowNs() - this.anchorNs) / this.tickNs + 1e-6);
    return (this.anchorCount + ticks) % (this.top + 1);
  }

  /** Moves the anchor to now, so a change of configuration counts on from here. */
  private rebase(): void {
    if (!this.running) return;
    const now = this.host.nowNs();
    const ticks = Math.floor((now - this.anchorNs) / this.tickNs + 1e-6);
    this.anchorCount = (this.anchorCount + ticks) % (this.top + 1);
    this.anchorNs += ticks * this.tickNs;
  }

  private setCount(value: number): void {
    this.rebase();
    this.anchorCount = (value >>> 0) % (this.max + 1);
    if (this.running) {
      this.anchorNs = this.host.nowNs();
      this.schedule();
    }
  }

  private reconfigure(): void {
    if (this.enabled && !this.running) {
      this.running = true;
      this.anchorNs = this.host.nowNs();
      this.anchorCount %= this.top + 1;
      if (this.anchorCount === 0) this.wrapped();
      this.host.outputsChanged();
      this.schedule();
    } else if (!this.enabled && this.running) {
      this.rebase();
      this.running = false;
      this.alarm.cancel();
      this.levels.fill(false);
      this.host.outputsChanged();
    } else if (this.running) {
      this.rebase();
      this.anchorCount %= this.top + 1;
      this.schedule();
    }
  }

  /** Ticks from the anchor to the next match or wrap, never zero. */
  private nextEvent(): number {
    const span = this.top + 1;
    let next = span - this.anchorCount;
    const ahead = (target: number) => {
      const d = target - this.anchorCount;
      return d > 0 ? d : d + span;
    };
    const mfrq = this.wavegen === WAVEGEN_MFRQ;
    for (let ch = mfrq ? 1 : 0; ch < this.channels; ch++) {
      const cc = this.cc(ch);
      if (cc < span) next = Math.min(next, ahead(cc));
    }
    return next;
  }

  private schedule(): void {
    this.alarm.cancel();
    if (!this.running) return;
    const at = this.anchorNs + this.nextEvent() * this.tickNs;
    this.alarm.schedule(Math.max(0, at - this.host.nowNs()));
  }

  /** The counter has reached the next event: do everything that happens at this count. */
  private fire(): void {
    if (!this.running) return;
    const span = this.top + 1;
    const ticks = this.nextEvent();
    this.anchorNs += ticks * this.tickNs;
    this.anchorCount = (this.anchorCount + ticks) % span;
    const count = this.anchorCount;
    if (count === 0) {
      this.intflag |= OVF;
      this.wrapped();
    }
    const wavegen = this.wavegen;
    for (let ch = 0; ch < this.channels; ch++) {
      const cc = this.cc(ch);
      // In MFRQ the counter clears on CC0 itself: the wrap is that match.
      const at = wavegen === WAVEGEN_MFRQ && ch === 0 ? 0 : cc;
      if (cc >= span || count !== at) continue;
      this.intflag |= this.mcFlag(ch);
      if (wavegen === WAVEGEN_NPWM && cc > 0) this.levels[ch] = this.inverted(ch);
      if (wavegen === WAVEGEN_MFRQ && ch === 0) this.levels[0] = !this.levels[0];
    }
    this.updateIrq();
    this.host.outputsChanged();
    this.schedule();
  }

  /** UPDATE: buffered compare values land, and every NPWM channel above zero goes high. */
  private wrapped(): void {
    for (let ch = 0; ch < this.channels; ch++) {
      const pending = this.pendingCc[ch];
      if (pending !== undefined) {
        this.block.poke(0x44 + ch * 4, pending, 4);
        this.pendingCc[ch] = undefined;
      }
    }
    if (this.wavegen === WAVEGEN_NPWM) {
      for (let ch = 0; ch < this.channels; ch++) this.levels[ch] = this.cc(ch) > 0 !== this.inverted(ch);
    }
  }
}
