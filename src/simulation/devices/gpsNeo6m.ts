// NEO-6M GPS — NMEA sentences over a real UART, from simulated coordinates.
//
// Two rules shape this file.
//
// The position is ALWAYS simulated and configured on the part. Nothing here
// reads a host location, a geolocation API, an IP lookup or a timezone. A GPS
// in a simulator is a thing that emits sentences describing wherever the user
// said it is, and reaching for the real location would be both a privacy
// problem and useless — you cannot test a route by standing still.
//
// The sentences go out through the UART link, one byte at a time, at the
// configured baud. A sketch parses them with TinyGPS++ or by hand exactly as it
// would on a bench, and a sketch with the wrong baud gets rubbish.
//
// GGA and RMC are emitted because between them they carry everything a normal
// sketch reads: fix quality, satellite count, altitude, position, speed, course
// and date. Both carry a real NMEA checksum, computed rather than stubbed,
// because a parser that validates checksums must not reject them — and a model
// that emitted a wrong one would be found only by the strictest library.
//
// NOT modelled: the UBX binary protocol and any configuration through it (a
// sketch that reconfigures the module over UBX is talking to something that
// does not answer), almanac and ephemeris, per-satellite detail beyond the
// count, DOP beyond a fixed plausible value, and cold/warm start timing.

import { DEFAULT_UART, type UartConfig, type UartPeripheral } from './uartEndpoint';
import type { DeviceSnapshot } from './types';

/** Everything the user can set about where this receiver thinks it is. */
export interface GpsFix {
  latitude: number;
  longitude: number;
  altitudeMetres: number;
  /** Ground speed in knots, which is what NMEA carries. */
  speedKnots: number;
  /** True course over ground, degrees. */
  headingDegrees: number;
  satellites: number;
  hasFix: boolean;
  /** Simulated UTC, as epoch milliseconds. Never the host clock. */
  utcMillis: number;
}

export const DEFAULT_GPS_FIX: GpsFix = {
  // Somewhere unambiguous and obviously synthetic rather than anyone's home:
  // the Greenwich prime meridian marker.
  latitude: 51.4779,
  longitude: -0.0015,
  altitudeMetres: 45,
  speedKnots: 0,
  headingDegrees: 0,
  satellites: 9,
  hasFix: true,
  utcMillis: Date.UTC(2024, 5, 1, 12, 0, 0),
};

/** How often a NEO-6M emits its sentence set, at the default 1 Hz. */
const DEFAULT_INTERVAL_MS = 1000;

export class GpsNeo6mDevice implements UartPeripheral {
  readonly instanceId: string;
  fix: GpsFix = { ...DEFAULT_GPS_FIX };
  private config: UartConfig = { ...DEFAULT_UART };
  private intervalMs = DEFAULT_INTERVAL_MS;

  private queue: number[] = [];
  private lastEmitUs = -1;
  private sentences = 0;
  private receivedFromBoard = 0;
  private log: string[] = [];

  constructor(instanceId: string, baud = 9600) {
    this.instanceId = instanceId;
    this.config = { ...DEFAULT_UART, baud };
  }

  uartConfig(): UartConfig {
    return this.config;
  }

  setBaud(baud: number): void {
    this.config = { ...this.config, baud };
  }

  /**
   * Bytes from the board.
   *
   * A NEO-6M accepts configuration, and this model does not implement it. The
   * bytes are counted so the inspector can say a sketch tried, rather than the
   * traffic vanishing and the sketch's silence looking like a wiring fault.
   */
  onByteFromBoard(_byte: number, _atUs: number): void {
    this.receivedFromBoard++;
  }

  takeBytesForBoard(nowUs: number): number[] {
    if (this.lastEmitUs < 0 || nowUs - this.lastEmitUs >= this.intervalMs * 1000) {
      this.lastEmitUs = nowUs;
      this.emitSentences();
    }
    const out = this.queue;
    this.queue = [];
    return out;
  }

  private emitSentences(): void {
    // The clock advances with the emission, so a sketch reading the time from
    // successive sentences sees it move.
    this.fix.utcMillis += this.intervalMs;
    for (const sentence of [this.gga(), this.rmc()]) {
      for (let i = 0; i < sentence.length; i++) this.queue.push(sentence.charCodeAt(i));
    }
    this.sentences += 2;
  }

  // ---- NMEA construction ----

  /** Degrees to the ddmm.mmmm NMEA form, with its hemisphere letter. */
  private static coordinate(value: number, isLatitude: boolean): { field: string; hemi: string } {
    const abs = Math.abs(value);
    const degrees = Math.floor(abs);
    const minutes = (abs - degrees) * 60;
    const width = isLatitude ? 2 : 3;
    const field = `${String(degrees).padStart(width, '0')}${minutes.toFixed(4).padStart(7, '0')}`;
    const hemi = isLatitude ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W';
    return { field, hemi };
  }

  private utcFields(): { time: string; date: string } {
    const d = new Date(this.fix.utcMillis);
    const p2 = (n: number) => String(n).padStart(2, '0');
    return {
      time: `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}.00`,
      date: `${p2(d.getUTCDate())}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCFullYear() % 100)}`,
    };
  }

  private gga(): string {
    const { time } = this.utcFields();
    const lat = GpsNeo6mDevice.coordinate(this.fix.latitude, true);
    const lon = GpsNeo6mDevice.coordinate(this.fix.longitude, false);
    const quality = this.fix.hasFix ? 1 : 0;
    const body =
      `GPGGA,${time},${this.fix.latitude === 0 && !this.fix.hasFix ? '' : lat.field},${lat.hemi},` +
      `${lon.field},${lon.hemi},${quality},${String(this.fix.satellites).padStart(2, '0')},` +
      `0.9,${this.fix.altitudeMetres.toFixed(1)},M,46.9,M,,`;
    return `$${body}*${checksum(body)}\r\n`;
  }

  private rmc(): string {
    const { time, date } = this.utcFields();
    const lat = GpsNeo6mDevice.coordinate(this.fix.latitude, true);
    const lon = GpsNeo6mDevice.coordinate(this.fix.longitude, false);
    const status = this.fix.hasFix ? 'A' : 'V';
    const body =
      `GPRMC,${time},${status},${lat.field},${lat.hemi},${lon.field},${lon.hemi},` +
      `${this.fix.speedKnots.toFixed(2)},${this.fix.headingDegrees.toFixed(2)},${date},,,` +
      `${this.fix.hasFix ? 'A' : 'N'}`;
    return `$${body}*${checksum(body)}\r\n`;
  }

  // ---- inspection ----

  get sentenceCount(): number {
    return this.sentences;
  }
  get bytesFromBoard(): number {
    return this.receivedFromBoard;
  }
  /** The next sentence pair as text, for tests and the inspector. */
  peekSentences(): string {
    return `${this.gga()}${this.rmc()}`;
  }

  reset(): void {
    this.queue = [];
    this.lastEmitUs = -1;
    this.sentences = 0;
    this.receivedFromBoard = 0;
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `NEO-6M: ${this.fix.hasFix ? `fix, ${this.fix.satellites} sats` : 'no fix'}, ` +
        `${this.fix.latitude.toFixed(5)}, ${this.fix.longitude.toFixed(5)}, ` +
        `${this.config.baud} baud, ${this.sentences} sentence(s) sent`,
      log: [...this.log],
    };
  }
}

/** NMEA checksum: XOR of everything between the $ and the *, as two hex digits. */
export function checksum(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum ^= body.charCodeAt(i);
  return sum.toString(16).toUpperCase().padStart(2, '0');
}
