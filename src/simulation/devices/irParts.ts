// The two ends of the infrared channel: a demodulating receiver and a remote.
//
// Neither of them talks to the other. The remote puts marks into the shared
// medium; the receiver asks the medium whether it is being illuminated and
// pulls its output pin low if it is. Nothing in this file knows which receiver
// a remote is "for", because a remote in a real room does not either.
//
// The receiver decodes what it saw as well, but only for the inspector. The
// firmware's copy of the data comes from the pin, decoded by the sketch's own
// timing code — see the note on decodeNecMarks. If the decode here were the
// path into a sketch, a sketch with completely wrong timing would still work,
// and the channel would be proving nothing at all.

import { NEC_CARRIER_HZ, NEC_TIMING, atTime, decodeNecMarks, necFrameMarks, necRepeatMarks, type RelativeMark } from './necCodec';
import type { DeviceSnapshot } from './types';

/** A gap longer than this ends a burst, so the receiver can decode it. */
const BURST_GAP_US = 20000;

export class IrReceiverDevice {
  readonly instanceId: string;
  /** The centre of the module's bandpass. A TSOP38238 is 38 kHz. */
  centreHz: number;

  private low = false;
  private markStartUs = -1;
  private lastEdgeUs = -1;
  private burst: RelativeMark[] = [];

  private frames = 0;
  private repeats = 0;
  private undecodable = 0;
  private lastResult = 'nothing received yet';
  private lastAddress: number | null = null;
  private lastCommand: number | null = null;
  private log: string[] = [];

  constructor(instanceId: string, centreHz = NEC_CARRIER_HZ) {
    this.instanceId = instanceId;
    this.centreHz = centreHz;
  }

  /** True while the module is hearing its carrier — its output is active low. */
  get outputLow(): boolean {
    return this.low;
  }

  /**
   * The demodulated output changing state, at a moment on the timeline.
   *
   * The pump calls this at every transition it schedules; the pin follows the
   * same edges. Idempotent, because the medium's transition list can contain
   * points where the union does not actually change.
   */
  setIlluminated(illuminated: boolean, us: number): void {
    if (illuminated === this.low) return;
    if (illuminated) {
      if (this.lastEdgeUs >= 0 && us - this.lastEdgeUs > BURST_GAP_US) this.flush();
      this.markStartUs = us;
    } else if (this.markStartUs >= 0) {
      this.burst.push({ startUs: this.markStartUs, endUs: us });
      this.markStartUs = -1;
    }
    this.low = illuminated;
    this.lastEdgeUs = us;
  }

  /** Decodes a burst that has gone quiet. Called from the settle. */
  flushIfIdle(us: number): void {
    if (this.burst.length === 0 || this.low) return;
    if (this.lastEdgeUs >= 0 && us - this.lastEdgeUs <= BURST_GAP_US) return;
    this.flush();
  }

  private flush(): void {
    if (this.burst.length === 0) return;
    const base = this.burst[0].startUs;
    const relative = this.burst.map((m) => ({ startUs: m.startUs - base, endUs: m.endUs - base }));
    this.burst = [];

    const decoded = decodeNecMarks(relative);
    if (decoded.kind === 'frame') {
      this.frames++;
      this.lastAddress = decoded.frame.address;
      this.lastCommand = decoded.frame.command;
      this.lastResult =
        `NEC${decoded.frame.extended ? ' (extended)' : ''} address 0x${decoded.frame.address.toString(16)}, ` +
        `command 0x${decoded.frame.command.toString(16)}`;
    } else if (decoded.kind === 'repeat') {
      this.repeats++;
      this.lastResult = 'NEC repeat (a button being held)';
    } else {
      this.undecodable++;
      this.lastResult = `undecodable: ${decoded.reason}`;
    }
    this.note(this.lastResult);
  }

  get frameCount(): number {
    return this.frames;
  }
  get repeatCount(): number {
    return this.repeats;
  }
  get undecodableCount(): number {
    return this.undecodable;
  }
  get address(): number | null {
    return this.lastAddress;
  }
  get command(): number | null {
    return this.lastCommand;
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  reset(): void {
    this.low = false;
    this.markStartUs = -1;
    this.lastEdgeUs = -1;
    this.burst = [];
    this.frames = 0;
    this.repeats = 0;
    this.undecodable = 0;
    this.lastResult = 'nothing received yet';
    this.lastAddress = null;
    this.lastCommand = null;
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `IR receiver — ${Math.round(this.centreHz / 1000)} kHz, output ${this.low ? 'LOW (carrier)' : 'HIGH (idle)'}, ` +
        `${this.frames} frame(s), ${this.repeats} repeat(s)` +
        (this.undecodable ? `, ${this.undecodable} undecodable` : '') +
        ` — last: ${this.lastResult}`,
      log: [...this.log],
    };
  }
}

/** One key on the virtual remote: what it says, and what it sends. */
export interface RemoteKey {
  key: string;
  label: string;
  command: number;
}

/**
 * The button set of the 21-key remote that ships with every starter kit.
 *
 * These are NEC command bytes — protocol data, published in every tutorial
 * that uses one of these remotes — so a sketch written against a real kit
 * recognises the codes this sends. The remote itself is a simulator affordance
 * and carries no maker's name, because it is not a copy of any one product.
 */
export const STARTER_REMOTE_KEYS: readonly RemoteKey[] = [
  { key: 'ch-minus', label: 'CH−', command: 0x45 },
  { key: 'ch', label: 'CH', command: 0x46 },
  { key: 'ch-plus', label: 'CH+', command: 0x47 },
  { key: 'prev', label: '|◀◀', command: 0x44 },
  { key: 'next', label: '▶▶|', command: 0x40 },
  { key: 'play', label: '▶||', command: 0x43 },
  { key: 'minus', label: '−', command: 0x07 },
  { key: 'plus', label: '+', command: 0x15 },
  { key: 'eq', label: 'EQ', command: 0x09 },
  { key: 'zero', label: '0', command: 0x16 },
  { key: 'hundred', label: '100+', command: 0x19 },
  { key: 'two-hundred', label: '200+', command: 0x0d },
  { key: 'one', label: '1', command: 0x0c },
  { key: 'two', label: '2', command: 0x18 },
  { key: 'three', label: '3', command: 0x5e },
  { key: 'four', label: '4', command: 0x08 },
  { key: 'five', label: '5', command: 0x1c },
  { key: 'six', label: '6', command: 0x5a },
  { key: 'seven', label: '7', command: 0x42 },
  { key: 'eight', label: '8', command: 0x52 },
  { key: 'nine', label: '9', command: 0x4a },
];

export class IrRemoteDevice {
  readonly instanceId: string;
  address = 0x00;
  extended = false;
  carrierHz = NEC_CARRIER_HZ;

  /** Frame-start time per held key, which is what NEC's repeat period is from. */
  private lastFrameUs = new Map<string, number>();
  private sent = 0;
  private repeats = 0;
  private lastKey: RemoteKey | null = null;
  private log: string[] = [];

  constructor(instanceId: string) {
    this.instanceId = instanceId;
  }

  /**
   * Turns the currently-held buttons into bursts to put in the medium.
   *
   * A press sends one frame. Holding sends a repeat code — not the frame again
   * — every 108 ms measured from the previous burst's start, which is what the
   * hardware does and what makes "one press, one action" sketches work.
   *
   * The period is honoured to the settle's resolution, so a repeat lands within
   * a millisecond of where hardware would put it. That is well inside any
   * decoder's tolerance and is not claimed to be exact.
   */
  update(pressed: ReadonlySet<string>, nowUs: number): RelativeMark[][] {
    const bursts: RelativeMark[][] = [];
    for (const button of STARTER_REMOTE_KEYS) {
      if (!pressed.has(button.key)) continue;
      const last = this.lastFrameUs.get(button.key);
      if (last === undefined) {
        bursts.push(atTime(necFrameMarks(this.address, button.command, this.extended), nowUs));
        this.lastFrameUs.set(button.key, nowUs);
        this.sent++;
        this.lastKey = button;
        this.note(`${button.label} → command 0x${button.command.toString(16)}`);
      } else if (nowUs - last >= NEC_TIMING.repeatPeriodUs) {
        bursts.push(atTime(necRepeatMarks(), nowUs));
        this.lastFrameUs.set(button.key, nowUs);
        this.repeats++;
      }
    }
    for (const key of [...this.lastFrameUs.keys()]) {
      if (!pressed.has(key)) this.lastFrameUs.delete(key);
    }
    return bursts;
  }

  get sentCount(): number {
    return this.sent;
  }
  get repeatCount(): number {
    return this.repeats;
  }
  get lastButton(): RemoteKey | null {
    return this.lastKey;
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  reset(): void {
    this.lastFrameUs.clear();
    this.sent = 0;
    this.repeats = 0;
    this.lastKey = null;
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `IR remote — NEC address 0x${this.address.toString(16)}${this.extended ? ' (extended)' : ''}, ` +
        `${Math.round(this.carrierHz / 1000)} kHz, ${this.sent} press(es), ${this.repeats} repeat(s)` +
        (this.lastKey ? ` — last ${this.lastKey.label}` : ''),
      log: [...this.log],
    };
  }
}
