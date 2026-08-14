// The infrared medium: one shared volume of air that every IR part sees.
//
// This exists so that IR is a channel rather than a message bus. A remote does
// not "send a code to a receiver" — it flashes an LED, and every receiver in
// the room sees the light or does not. Nothing here knows about NEC, about
// commands, or about which part is meant to be talking to which. That is the
// whole point: a transmitter cannot address a receiver, so it cannot reach one
// it should not, and two transmitters in the same room interfere exactly the
// way two transmitters in a real room interfere.
//
// What a burst of IR actually is: an LED switched on and off at a carrier
// frequency, in marks (carrier present) separated by spaces (carrier absent).
// A demodulating receiver — the three-legged TSOP module every project uses —
// has a bandpass filter around its own centre frequency and pulls its output
// LOW while it hears that carrier. So the medium stores marks with the carrier
// they were sent at, and a receiver asks whether it is being illuminated at a
// moment, given its own centre frequency.
//
// Collisions are not a special case and are not flagged as an error. Two
// remotes pressed at once produce the union of their marks, a receiver
// demodulates that union, and whatever decodes it gets nonsense — which is
// what happens on a coffee table. The count is kept only so an inspector can
// explain a frame that failed to decode.
//
// NOT modelled, and not claimed: distance, angle, beam width, ambient sunlight
// or fluorescent interference, LED current or brightness, receiver AGC
// recovery time, and the burst-length limits real AGC imposes on continuous
// carriers. Every emitter is heard by every receiver whose passband matches,
// at full strength, or not at all. There is no path loss here to be wrong
// about, which is deliberate: an invented distance model would be a number
// users would trust.

/** One mark: carrier present, from `startUs` until `endUs`, at `carrierHz`. */
export interface IrMark {
  emitterId: string;
  startUs: number;
  endUs: number;
  carrierHz: number;
}

/**
 * How far a receiver's centre frequency may be from a carrier and still hear
 * it. A TSOP38238's bandpass is a few kHz wide around 38 kHz; ±20 % means a
 * 36–40 kHz remote is heard and a 56 kHz one is not, which is the distinction
 * that matters when someone wonders why their remote does nothing.
 */
export const CARRIER_PASSBAND = 0.2;

export function carrierHeard(centreHz: number, carrierHz: number): boolean {
  if (centreHz <= 0) return false;
  return Math.abs(carrierHz - centreHz) / centreHz <= CARRIER_PASSBAND;
}

export class IrMedium {
  private marks: IrMark[] = [];
  private collisions = 0;
  private emitted = 0;

  /**
   * Adds a burst of marks from one emitter.
   *
   * Marks are absolute microseconds on the shared timeline, because two
   * emitters have to be comparable — relative timing per emitter would make
   * overlap unanswerable.
   */
  emit(emitterId: string, carrierHz: number, marks: readonly { startUs: number; endUs: number }[]): void {
    for (const m of marks) {
      if (m.endUs <= m.startUs) continue;
      this.marks.push({ emitterId, carrierHz, startUs: m.startUs, endUs: m.endUs });
    }
    this.emitted++;
  }

  /** How many distinct emitters a receiver at `centreHz` can hear right now. */
  litBy(centreHz: number, us: number): string[] {
    const lit = new Set<string>();
    for (const m of this.marks) {
      if (us < m.startUs || us >= m.endUs) continue;
      if (!carrierHeard(centreHz, m.carrierHz)) continue;
      lit.add(m.emitterId);
    }
    return [...lit];
  }

  /**
   * Samples the medium, counting a collision when more than one emitter is
   * heard at once. The receiver's output does not change — it is a photodiode
   * behind a filter and cannot tell two sources apart — the count only lets an
   * inspector say why a frame decoded to rubbish.
   */
  sample(centreHz: number, us: number): { illuminated: boolean; sources: number } {
    const sources = this.litBy(centreHz, us).length;
    if (sources > 1) this.collisions++;
    return { illuminated: sources > 0, sources };
  }

  /** True if any heard emitter is lit at `us`. */
  illuminated(centreHz: number, us: number): boolean {
    return this.litBy(centreHz, us).length > 0;
  }

  /**
   * Every moment after `afterUs` at which illumination could change, in order.
   *
   * The union of two overlapping bursts has fewer transitions than the marks
   * do — one mark ending inside another changes nothing — so some of these are
   * re-evaluations that find the same level. That is harmless: a receiver
   * scheduling a pin change to the level it already has is a no-op, and the
   * alternative is computing the union in closed form for a saving nobody
   * would notice.
   */
  transitionsAfter(centreHz: number, afterUs: number, untilUs: number): number[] {
    const points = new Set<number>();
    for (const m of this.marks) {
      if (!carrierHeard(centreHz, m.carrierHz)) continue;
      if (m.startUs > afterUs && m.startUs <= untilUs) points.add(m.startUs);
      if (m.endUs > afterUs && m.endUs <= untilUs) points.add(m.endUs);
    }
    return [...points].sort((a, b) => a - b);
  }

  /** The last moment any pending mark ends, for bounding a schedule. */
  latestEnd(): number {
    let last = 0;
    for (const m of this.marks) last = Math.max(last, m.endUs);
    return last;
  }

  /** Drops marks that ended before `beforeUs`, so a long run does not grow. */
  prune(beforeUs: number): void {
    if (this.marks.length === 0) return;
    this.marks = this.marks.filter((m) => m.endUs >= beforeUs);
  }

  get markCount(): number {
    return this.marks.length;
  }
  get burstCount(): number {
    return this.emitted;
  }
  get collisionCount(): number {
    return this.collisions;
  }

  reset(): void {
    this.marks = [];
    this.collisions = 0;
    this.emitted = 0;
  }
}
