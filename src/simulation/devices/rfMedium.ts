// The radio medium: one shared volume of air for every RF part on the canvas.
//
// The same argument as the infrared medium, for the same reason. A radio does
// not send a packet to another radio — it transmits, and whoever is listening
// on the same band and channel at the same moment either receives it or does
// not. Nothing here knows which module is meant to be talking to which, so a
// transmitter cannot reach a receiver it should not, and two transmitters that
// key up together destroy each other's packets rather than being queued.
//
// This is deliberately shared by every radio family. An nRF24L01, an SX1278
// and a bare 433 MHz ASK pair have nothing in common at the register level and
// everything in common here: a band, a channel, a start and an end on the
// simulated clock, an identity, and some bytes. Building one medium means the
// second radio family is a register map rather than another channel model, and
// means a collision between two radios of DIFFERENT families on the same band
// is representable — which is the case a per-family design silently loses.
//
// WHAT IS NOT MODELLED, and must not be invented later without hardware to
// check it against:
//
//   distance, position, and path loss    There is no geometry here. Every
//                                        receiver on the band hears every
//                                        transmitter at full strength or not
//                                        at all.
//   RSSI, LQI, SNR, sensitivity          No signal strength exists to report.
//                                        A radio model asked for RSSI must say
//                                        it does not know, not return a
//                                        plausible number.
//   antennas, orientation, obstacles     Nothing.
//   fading, multipath, interference      Nothing outside the parts on canvas.
//   regulatory duty cycles               Nothing.
//
// Those omissions are the honest kind: a range figure invented here would be
// a number users would design around, and it would be wrong.
//
// What IS modelled is the part that decides whether firmware works: who was
// transmitting, when, on what channel, with what bytes, and what happens when
// two of them overlap.

/** A radio band. Parts on different bands cannot hear each other at all. */
export type RfBand = string;

/**
 * The one band every radio here shares, with the CHANNEL carrying the actual
 * centre frequency in kilohertz.
 *
 * One numbering for every family on purpose. An nRF24 on channel 76 is at
 * 2 476 000 kHz and a LoRa module at 433 MHz is at 433 000 kHz, so they cannot
 * interfere — but a LoRa module and a bare OOK transmitter both sitting on
 * 433 920 kHz can, and do. Energy is energy; whether a receiver can DEMODULATE
 * what it hears is a separate question, answered by the modulation field in
 * `match`.
 *
 * Simplification, stated rather than hidden: channels are compared for
 * equality, not for overlapping bandwidth. Two radios a few kilohertz apart do
 * not interfere here even though real ones would.
 */
export const RF_BAND = 'radio';

export interface RfTransmission {
  /** Monotonic, so a receiver can say which ones it has already taken. */
  readonly id: number;
  readonly transmitterId: string;
  readonly band: RfBand;
  /** Channel index. Its meaning belongs to the family — 0..125 on an nRF24. */
  readonly channel: number;
  readonly startUs: number;
  readonly endUs: number;
  readonly payload: Uint8Array;
  /**
   * Family-specific fields a receiver must also match: a pipe address, a LoRa
   * sync word, a data rate. Compared as plain equality, because every radio
   * that has such a field treats a mismatch as "not for me".
   */
  readonly match: Readonly<Record<string, string | number>>;
}

export interface RfReception {
  readonly transmission: RfTransmission;
  /**
   * True when something else was on the same band and channel while this was
   * in the air. A colliding packet is delivered — a receiver has to be able to
   * see that something arrived broken — but no radio model may treat it as
   * good data.
   */
  readonly collided: boolean;
}

/** What a receiver is listening for. */
export interface RfListener {
  band: RfBand;
  channel: number;
  match: Readonly<Record<string, string | number>>;
}

function matchesFields(
  wanted: Readonly<Record<string, string | number>>,
  have: Readonly<Record<string, string | number>>,
): boolean {
  for (const [key, want] of Object.entries(wanted)) {
    if (have[key] !== want) return false;
  }
  return true;
}

function matches(listener: RfListener, t: RfTransmission): boolean {
  if (listener.band !== t.band || listener.channel !== t.channel) return false;
  return matchesFields(listener.match, t.match);
}

export class RfMedium {
  private transmissions: RfTransmission[] = [];
  /**
   * Carrier that is on now and whose end is not known yet.
   *
   * A packet radio hands over a whole transmission with both ends, because it
   * knows the payload and the data rate. A bare on-off-keyed transmitter does
   * not: its carrier is on because a pin is high, and nothing can say when the
   * sketch will drop it. So it opens a mark and closes it later — the same
   * shape the infrared medium needs, for the same reason.
   */
  private open = new Map<string, { startUs: number; channel: number; match: Readonly<Record<string, string | number>> }>();
  private nextId = 1;
  private collisions = 0;

  /**
   * Puts a transmission in the air.
   *
   * `endUs` is the moment the last bit leaves, computed by the caller from the
   * data rate and the payload length — the medium does not guess at airtime,
   * because airtime is a property of the modulation and belongs to the radio.
   */
  transmit(t: Omit<RfTransmission, 'id'>): RfTransmission {
    const record: RfTransmission = { ...t, id: this.nextId++ };
    this.transmissions.push(record);
    return record;
  }

  /** Turns the carrier on, with no end yet. See `open`. */
  beginLive(transmitterId: string, channel: number, startUs: number, match: Readonly<Record<string, string | number>>): void {
    if (this.open.has(transmitterId)) return;
    this.open.set(transmitterId, { startUs, channel, match });
  }

  /** Turns it off, turning the mark into an ordinary transmission. */
  endLive(transmitterId: string, endUs: number): void {
    const live = this.open.get(transmitterId);
    if (!live) return;
    this.open.delete(transmitterId);
    if (endUs > live.startUs) {
      this.transmissions.push({
        id: this.nextId++,
        transmitterId,
        band: RF_BAND,
        channel: live.channel,
        startUs: live.startUs,
        endUs,
        payload: new Uint8Array(0),
        match: live.match,
      });
    }
  }

  isLive(transmitterId: string): boolean {
    return this.open.has(transmitterId);
  }

  /**
   * Who a listener can hear at this instant.
   *
   * The waveform view of the medium, as against the packet view `completed`
   * gives. An on-off-keyed receiver has no notion of a packet — it has a
   * detector and an output pin, and it follows whatever energy is there.
   */
  energisedBy(listener: RfListener, us: number): string[] {
    const on = new Set<string>();
    for (const t of this.transmissions) {
      if (us < t.startUs || us >= t.endUs) continue;
      if (!matches(listener, t)) continue;
      on.add(t.transmitterId);
    }
    for (const [id, live] of this.open) {
      if (us < live.startUs || live.channel !== listener.channel) continue;
      if (!matchesFields(listener.match, live.match)) continue;
      on.add(id);
    }
    return [...on];
  }

  /**
   * Samples the waveform, counting a collision when more than one transmitter
   * is heard at once. The output does not change — a detector cannot tell two
   * sources apart — the count only lets an inspector explain the garbage.
   */
  sampleWaveform(listener: RfListener, us: number): { energised: boolean; sources: number } {
    const sources = this.energisedBy(listener, us).length;
    if (sources > 1) this.collisions++;
    return { energised: sources > 0, sources };
  }

  /** Every moment after `afterUs` at which a listener's carrier could change. */
  waveformTransitions(listener: RfListener, afterUs: number, untilUs: number): number[] {
    const points = new Set<number>();
    for (const t of this.transmissions) {
      if (!matches(listener, t)) continue;
      if (t.startUs > afterUs && t.startUs <= untilUs) points.add(t.startUs);
      if (t.endUs > afterUs && t.endUs <= untilUs) points.add(t.endUs);
    }
    for (const live of this.open.values()) {
      if (live.channel !== listener.channel || !matchesFields(listener.match, live.match)) continue;
      if (live.startUs > afterUs) points.add(live.startUs);
    }
    return [...points].sort((a, b) => a - b);
  }

  /** Start times of open marks, for a receiver that has not reached them. */
  openStarts(listener: RfListener): number[] {
    const starts: number[] = [];
    for (const live of this.open.values()) {
      if (live.channel !== listener.channel || !matchesFields(listener.match, live.match)) continue;
      starts.push(live.startUs);
    }
    return starts;
  }

  /** Everything still in the air at this instant, on any band. */
  airborne(us: number): RfTransmission[] {
    return this.transmissions.filter((t) => us >= t.startUs && us < t.endUs);
  }

  /** True when two transmissions shared a band, a channel and a moment. */
  private overlaps(t: RfTransmission): boolean {
    return this.transmissions.some(
      (other) =>
        other.id !== t.id &&
        other.band === t.band &&
        other.channel === t.channel &&
        other.startUs < t.endUs &&
        t.startUs < other.endUs,
    );
  }

  /**
   * Transmissions that finished in `(afterId, now]` and match this listener.
   *
   * Keyed on the transmission id rather than on time so a receiver that was
   * not polled for several slices does not lose packets that completed while
   * it was not looking — which is what a real FIFO is for.
   */
  completed(listener: RfListener, afterId: number, nowUs: number): RfReception[] {
    const out: RfReception[] = [];
    for (const t of this.transmissions) {
      if (t.id <= afterId) continue;
      if (t.endUs > nowUs) continue;
      if (!matches(listener, t)) continue;
      const collided = this.overlaps(t);
      if (collided) this.collisions++;
      out.push({ transmission: t, collided });
    }
    return out.sort((a, b) => a.transmission.id - b.transmission.id);
  }

  /**
   * Whether a receiver would be deaf to this transmitter, and why.
   *
   * Exists so a radio model can tell the inspector "your channels differ"
   * instead of a sketch simply receiving nothing — a wrong channel is the
   * single most common radio mistake and the least visible one.
   */
  explainMismatch(listener: RfListener, t: RfTransmission): string | null {
    if (listener.band !== t.band) return `different band (${listener.band} vs ${t.band})`;
    if (listener.channel !== t.channel) {
      return `different channel (listening on ${listener.channel}, sent on ${t.channel})`;
    }
    for (const [key, want] of Object.entries(listener.match)) {
      if (t.match[key] !== want) return `${key} differs (expected ${want}, sent ${t.match[key] ?? 'nothing'})`;
    }
    return null;
  }

  /** The most recent transmission from anyone, for the inspector. */
  get lastTransmission(): RfTransmission | undefined {
    return this.transmissions[this.transmissions.length - 1];
  }
  get transmissionCount(): number {
    return this.transmissions.length;
  }
  get collisionCount(): number {
    return this.collisions;
  }
  /** The highest id issued, which is where a fresh receiver starts looking. */
  get latestId(): number {
    return this.nextId - 1;
  }

  /** Drops transmissions that ended before `beforeUs`. */
  prune(beforeUs: number): void {
    // A packet is kept a little past its end so a receiver polled one slice
    // late still finds it, and so the overlap test still sees its neighbours.
    this.transmissions = this.transmissions.filter((t) => t.endUs >= beforeUs);
  }

  reset(): void {
    this.transmissions = [];
    this.open.clear();
    this.nextId = 1;
    this.collisions = 0;
  }
}
