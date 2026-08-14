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

function matches(listener: RfListener, t: RfTransmission): boolean {
  if (listener.band !== t.band || listener.channel !== t.channel) return false;
  for (const [key, want] of Object.entries(listener.match)) {
    if (t.match[key] !== want) return false;
  }
  return true;
}

export class RfMedium {
  private transmissions: RfTransmission[] = [];
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
    this.nextId = 1;
    this.collisions = 0;
  }
}
