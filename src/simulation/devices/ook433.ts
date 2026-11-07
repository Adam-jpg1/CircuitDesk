// The 433 MHz ASK/OOK pair — a wire that happens to be made of air.
//
// These modules have no protocol. The transmitter's DATA pin high means the
// carrier is on; low means it is off. The receiver's DATA pin follows whatever
// energy its detector hears. That is the whole device, and it is why they are
// used for everything from doorbells to garage doors with a different
// encoding in every one — the encoding lives in the sketch, not in the module.
//
// So this is modelled as a waveform, not as packets. Whatever the firmware
// puts on the transmitter's pin comes out of the receiver's pin, at the same
// timing, and an encoder like RCSwitch's works here because it is doing the
// same bit-banging it does on a bench. A packet-oriented model would have
// forced an encoding on the user and quietly broken every project that used a
// different one.
//
// The consequences of that honesty are worth stating, because they are what
// makes these modules infuriating in real life and this reproduces them:
//
//   * An idle receiver's output is NOT quiet on real hardware — its AGC winds
//     up and it produces noise. That noise is NOT modelled here; an idle
//     receiver reads low. This is the one place the model is kinder than the
//     hardware, and it is recorded rather than hidden.
//   * Two transmitters keyed at once produce the union of their carriers, and
//     whatever decodes it gets nonsense. Nothing arbitrates.
//   * A receiver on a different frequency hears nothing at all.
//
// NOT modelled, and not claimed: AGC behaviour and squelch, the noise floor,
// range, antenna length (the classic 17 cm quarter-wave), supply-voltage
// dependence, superregenerative receiver bandwidth, and any encoding
// whatsoever — no RCSwitch, no Manchester, no preamble.

/** What the modulation field says, so only an OOK part demodulates it. */
export const OOK_MODULATION = 'ook';
/** The frequency these modules are sold at, in kilohertz. */
export const OOK_DEFAULT_KHZ = 433_920;

import type { DeviceSnapshot } from './types';

export class Ook433Transmitter {
  readonly instanceId: string;
  frequencyKhz: number;

  private keyed = false;
  private marks = 0;
  private log: string[] = [];

  constructor(instanceId: string, frequencyKhz = OOK_DEFAULT_KHZ) {
    this.instanceId = instanceId;
    this.frequencyKhz = frequencyKhz;
  }

  get isKeyed(): boolean {
    return this.keyed;
  }
  get markCount(): number {
    return this.marks;
  }

  /** Called on a real edge of the DATA pin, not on a per-slice sample. */
  noteKeyed(high: boolean): void {
    if (high === this.keyed) return;
    this.keyed = high;
    if (high) this.marks++;
  }

  reset(): void {
    this.keyed = false;
    this.marks = 0;
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `433 MHz transmitter: ${(this.frequencyKhz / 1000).toFixed(2)} MHz, ` +
        `carrier ${this.keyed ? 'on' : 'off'}, ${this.marks} mark(s) sent`,
      log: [...this.log],
    };
  }
}

export class Ook433Receiver {
  readonly instanceId: string;
  frequencyKhz: number;

  private high = false;
  private edges = 0;
  /** Pulse widths, newest last, so the inspector can show what arrived. */
  private pulses: number[] = [];
  private lastEdgeUs = -1;
  private collisions = 0;
  private log: string[] = [];

  constructor(instanceId: string, frequencyKhz = OOK_DEFAULT_KHZ) {
    this.instanceId = instanceId;
    this.frequencyKhz = frequencyKhz;
  }

  /** True while the detector hears a carrier — the DATA pin follows this. */
  get outputHigh(): boolean {
    return this.high;
  }
  get edgeCount(): number {
    return this.edges;
  }
  get recentPulses(): number[] {
    return [...this.pulses];
  }
  get collisionCount(): number {
    return this.collisions;
  }

  setEnergised(energised: boolean, us: number, sources = 1): void {
    if (sources > 1) this.collisions++;
    if (energised === this.high) return;
    if (this.lastEdgeUs >= 0) {
      this.pulses.push(Math.round(us - this.lastEdgeUs));
      if (this.pulses.length > 80) this.pulses.shift();
    }
    this.high = energised;
    this.lastEdgeUs = us;
    this.edges++;
  }

  reset(): void {
    this.high = false;
    this.edges = 0;
    this.pulses = [];
    this.lastEdgeUs = -1;
    this.collisions = 0;
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    const recent = this.pulses.slice(-6).join(', ');
    return {
      status:
        `433 MHz receiver: ${(this.frequencyKhz / 1000).toFixed(2)} MHz, ` +
        `output ${this.high ? 'HIGH' : 'low'}, ${this.edges} edge(s)` +
        (this.collisions ? `, ${this.collisions} overlapping sample(s)` : '') +
        (recent ? `recent pulses ${recent} us` : ''),
      log: [...this.log],
    };
  }
}
