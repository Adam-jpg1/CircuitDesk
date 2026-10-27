// The SAMD21's TCC0-2 and TC3-7, as far as analogWrite() needs them: normal
// (single-slope) PWM, driving the pads that the PORT multiplexer hands them.
//
// Edges are real. Each running timer schedules its own period start on the
// simulation clock, raises every channel whose compare value is above zero,
// and lowers each one at its compare match, so a pad routed to a timer toggles
// at the timer's frequency with the duty CC / (TOP + 1) — which is what the
// duty trackers, an LED's brightness and anything reading the pin see.
//
// Not modelled: the other waveform modes (MFRQ, NFRQ, dual-slope), captures,
// dead time, the pattern generator and the timers' interrupts. Servo and
// tone() use those, so they still do nothing on these boards.

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

const PRESCALER = [1, 2, 4, 8, 16, 64, 256, 1024];
const WAVEGEN_NPWM = 2;
/** Faster than this and the edges are spaced out to it: the duty is kept, the frequency is not. */
const MIN_PERIOD_NS = 2_000;

interface Alarm {
  schedule(ns: number): void;
  cancel(): void;
}

export interface TimerHost {
  clockHz: number;
  createAlarm(callback: () => void): Alarm;
  /** A waveform output changed level. */
  outputsChanged(): void;
}

export class Samd21Timer {
  readonly block: RegisterBlock;
  readonly isTcc: boolean;
  /** Compare channels: TCC0 has four, TCC1 and TCC2 two, each TC two. */
  private readonly channels: number;
  private readonly levels: boolean[];
  private readonly pendingCc: (number | undefined)[];
  private readonly periodAlarm: Alarm;
  private readonly matchAlarms: Alarm[];
  private running = false;

  constructor(readonly index: number, base: number, private readonly host: TimerHost) {
    this.isTcc = index < 3;
    this.channels = index === 0 ? 4 : 2;
    this.block = new RegisterBlock(this.isTcc ? `TCC${index}` : `TC${index}`, base, 0x400);
    this.levels = new Array(this.channels).fill(false);
    this.pendingCc = new Array(this.channels).fill(undefined);
    this.periodAlarm = host.createAlarm(() => this.periodStart());
    this.matchAlarms = Array.from({ length: this.channels }, (_, ch) => host.createAlarm(() => this.match(ch)));

    const b = this.block;
    b.on(0x00, {
      width: 4,
      read: () => b.peek(0x00, 4) & ~1,
      write: (v) => {
        if (v & 1) {
          b.bytes.fill(0);
          this.pendingCc.fill(undefined);
        }
        this.reconfigure();
      },
    });
    if (this.isTcc) {
      b.on(0x08, { width: 4, read: () => 0 }); // SYNCBUSY
      b.on(0x3c, { width: 4, write: () => this.reconfigure() }); // WAVE
      b.on(0x40, { width: 4, write: () => this.reconfigure() }); // PER
      for (let ch = 0; ch < this.channels; ch++) {
        b.on(0x44 + ch * 4, { width: 4, write: () => this.reconfigure() }); // CC
        // CCB: buffered, copied into CC at the next update, as analogWrite() relies on.
        b.on(0x70 + ch * 4, { width: 4, write: (v) => (this.pendingCc[ch] = v & 0xffffff) });
      }
    } else {
      b.on(0x0f, { width: 1, read: () => 0 }); // STATUS: never SYNCBUSY
      b.on(0x14, { width: 1, write: () => this.reconfigure() }); // PER (8-bit mode)
      b.on(0x18, { width: 4, write: () => this.reconfigure() }); // CC0/CC1, at every width
    }
  }

  /** The level waveform output `wo` drives, while the timer is generating PWM. */
  output(wo: number): boolean | undefined {
    if (!this.running) return undefined;
    return this.levels[wo % this.channels];
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

  private get top(): number {
    if (this.isTcc) return this.block.peek(0x40, 4) & 0xffffff;
    return this.tcMode === 1 ? this.block.peek(0x14, 1) : 0xffff;
  }

  private cc(ch: number): number {
    if (this.isTcc) return this.block.peek(0x44 + ch * 4, 4) & 0xffffff;
    return this.tcMode === 1 ? this.block.peek(0x18 + ch, 1) : this.block.peek(0x18 + ch * 2, 2);
  }

  private inverted(ch: number): boolean {
    return this.isTcc ? ((this.block.peek(0x3c, 4) >>> (16 + ch)) & 1) === 1 : false;
  }

  private get tickNs(): number {
    return (PRESCALER[(this.ctrla >>> 8) & 0x7] * 1e9) / this.host.clockHz;
  }

  private reconfigure(): void {
    const generating = this.enabled && this.wavegen === WAVEGEN_NPWM && (this.isTcc || this.tcMode !== 2);
    if (generating && !this.running) {
      this.running = true;
      this.periodStart();
    } else if (!generating && this.running) {
      this.running = false;
      this.periodAlarm.cancel();
      for (const alarm of this.matchAlarms) alarm.cancel();
      this.levels.fill(false);
      this.host.outputsChanged();
    }
    // A running timer takes a new compare value at its next period, as the
    // hardware's update does; nothing to do here.
  }

  /** UPDATE: buffered values land, every channel with a compare above zero goes high. */
  private periodStart(): void {
    if (!this.running) return;
    for (let ch = 0; ch < this.channels; ch++) {
      const pending = this.pendingCc[ch];
      if (pending !== undefined) {
        this.block.poke(0x44 + ch * 4, pending, 4);
        this.pendingCc[ch] = undefined;
      }
    }
    const top = this.top;
    const span = top + 1;
    const periodNs = Math.max(MIN_PERIOD_NS, span * this.tickNs);
    for (let ch = 0; ch < this.channels; ch++) {
      const cc = this.cc(ch);
      this.matchAlarms[ch].cancel();
      const high = cc > 0;
      this.levels[ch] = high !== this.inverted(ch);
      if (cc > 0 && cc < span) this.matchAlarms[ch].schedule((periodNs * cc) / span);
    }
    this.host.outputsChanged();
    this.periodAlarm.schedule(periodNs);
  }

  /** Compare match: the channel's output falls (rises, with its polarity inverted). */
  private match(ch: number): void {
    if (!this.running) return;
    this.levels[ch] = this.inverted(ch);
    this.host.outputsChanged();
  }
}
