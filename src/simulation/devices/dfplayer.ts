// DFPlayer Mini — the serial protocol, and the playback state it drives.
//
// Every DFPlayer command is a ten-byte frame: 0x7E, version, length, command,
// feedback flag, two parameter bytes, a two-byte checksum, 0xEF. The checksum
// is the negated sum of bytes 1..6, and a real module ignores a frame whose
// checksum is wrong. That matters more than it sounds: hand-rolled DFPlayer
// code gets the checksum wrong constantly, and a model that accepted anything
// starting with 0x7E would make broken code look correct.
//
// So frames are parsed properly, bad checksums are counted and dropped, and the
// playback state is driven only by frames that were actually valid.
//
// NOT modelled, and not claimed: audio. Nothing decodes an MP3, nothing
// produces sound, and there is no file system — a track number is a number.
// What IS modelled is the state a sketch can read back: whether it is playing,
// which track, the volume, and the equaliser setting. The busy pin follows
// playback, because sketches use it to wait for a track to end.

import { DEFAULT_UART, type UartConfig, type UartPeripheral } from './uartEndpoint';
import type { DeviceSnapshot } from './types';

const FRAME_START = 0x7e;
const FRAME_END = 0xef;
const FRAME_LENGTH = 10;

export const DFPLAYER_CMD = {
  NEXT: 0x01,
  PREVIOUS: 0x02,
  PLAY_TRACK: 0x03,
  VOLUME_UP: 0x04,
  VOLUME_DOWN: 0x05,
  SET_VOLUME: 0x06,
  SET_EQ: 0x07,
  RESET: 0x0c,
  PLAY: 0x0d,
  PAUSE: 0x0e,
  PLAY_FOLDER: 0x0f,
  STOP: 0x16,
  QUERY_STATUS: 0x42,
  QUERY_VOLUME: 0x43,
  QUERY_CURRENT: 0x4c,
} as const;

export type PlaybackState = 'stopped' | 'playing' | 'paused';

export class DfPlayerDevice implements UartPeripheral {
  readonly instanceId: string;
  private config: UartConfig;

  private state: PlaybackState = 'stopped';
  private track = 0;
  private volume = 15;
  private equaliser = 0;
  /** How many tracks the simulated card holds. A track past it does not play. */
  private trackCount = 10;

  private inbound: number[] = [];
  private outbound: number[] = [];

  private frames = 0;
  private badChecksums = 0;
  private unknownCommands: number[] = [];
  private log: string[] = [];

  constructor(instanceId: string, baud = 9600) {
    this.instanceId = instanceId;
    // The DFPlayer is fixed at 9600 in hardware; the property exists so a
    // mis-set sketch still behaves like a mis-set sketch.
    this.config = { ...DEFAULT_UART, baud };
  }

  uartConfig(): UartConfig {
    return this.config;
  }
  setBaud(baud: number): void {
    this.config = { ...this.config, baud };
  }
  setTrackCount(count: number): void {
    this.trackCount = Math.max(0, Math.floor(count));
  }

  onByteFromBoard(byte: number): void {
    // Resynchronise on the framing bytes rather than assuming alignment. A
    // sketch that sends a truncated frame — a reset mid-write, a buffer that
    // ran out — must not desynchronise the module for ever, so a ten-byte
    // window that does not end in 0xEF is not a frame: its leading start byte
    // was inside the truncated one, and the scan moves to the next 0x7E.
    if (this.inbound.length === 0 && byte !== FRAME_START) return;
    this.inbound.push(byte);

    while (this.inbound.length >= FRAME_LENGTH) {
      if (this.inbound[FRAME_LENGTH - 1] === FRAME_END) {
        this.acceptFrame(this.inbound.splice(0, FRAME_LENGTH));
        continue;
      }
      this.inbound.shift();
      while (this.inbound.length > 0 && this.inbound[0] !== FRAME_START) this.inbound.shift();
    }
  }

  takeBytesForBoard(): number[] {
    const out = this.outbound;
    this.outbound = [];
    return out;
  }

  private acceptFrame(frame: number[]): void {
    if (frame[0] !== FRAME_START || frame[FRAME_LENGTH - 1] !== FRAME_END) {
      this.note('frame with a bad start or end byte');
      return;
    }
    const expected = checksumOf(frame);
    const given = (frame[7] << 8) | frame[8];
    if (((expected - given) & 0xffff) !== 0) {
      // A real module ignores this. Counted rather than dropped silently,
      // because a wrong checksum is the single most common DFPlayer bug and a
      // sketch whose commands vanish deserves to be told why.
      this.badChecksums++;
      this.note(`checksum mismatch: sent 0x${given.toString(16)}, expected 0x${expected.toString(16)}`);
      return;
    }

    this.frames++;
    const command = frame[3];
    const param = (frame[5] << 8) | frame[6];
    this.execute(command, param);
  }

  private execute(command: number, param: number): void {
    switch (command) {
      case DFPLAYER_CMD.PLAY_TRACK:
        this.playTrack(param);
        return;
      case DFPLAYER_CMD.PLAY_FOLDER:
        // High byte is the folder, low byte the track within it.
        this.playTrack(param & 0xff);
        return;
      case DFPLAYER_CMD.NEXT:
        this.playTrack(this.track + 1);
        return;
      case DFPLAYER_CMD.PREVIOUS:
        this.playTrack(this.track - 1);
        return;
      case DFPLAYER_CMD.PLAY:
        if (this.track > 0) this.state = 'playing';
        return;
      case DFPLAYER_CMD.PAUSE:
        if (this.state === 'playing') this.state = 'paused';
        return;
      case DFPLAYER_CMD.STOP:
        this.state = 'stopped';
        return;
      case DFPLAYER_CMD.SET_VOLUME:
        this.volume = Math.min(30, Math.max(0, param & 0xff));
        return;
      case DFPLAYER_CMD.VOLUME_UP:
        this.volume = Math.min(30, this.volume + 1);
        return;
      case DFPLAYER_CMD.VOLUME_DOWN:
        this.volume = Math.max(0, this.volume - 1);
        return;
      case DFPLAYER_CMD.SET_EQ:
        this.equaliser = param & 0xff;
        return;
      case DFPLAYER_CMD.RESET:
        this.state = 'stopped';
        this.track = 0;
        this.volume = 15;
        this.note('reset');
        return;
      case DFPLAYER_CMD.QUERY_STATUS:
        this.respond(0x42, this.state === 'playing' ? 0x0201 : 0x0200);
        return;
      case DFPLAYER_CMD.QUERY_VOLUME:
        this.respond(0x43, this.volume);
        return;
      case DFPLAYER_CMD.QUERY_CURRENT:
        this.respond(0x4c, this.track);
        return;
      default:
        this.unknownCommands.push(command);
        this.note(`unhandled command 0x${command.toString(16)}`);
    }
  }

  /** A track past the end of the card does not play, as on the hardware. */
  private playTrack(track: number): void {
    if (track < 1 || track > this.trackCount) {
      this.note(`track ${track} is not on the card (${this.trackCount} track(s))`);
      this.state = 'stopped';
      return;
    }
    this.track = track;
    this.state = 'playing';
  }

  private respond(command: number, param: number): void {
    const frame = [FRAME_START, 0xff, 0x06, command, 0x00, (param >> 8) & 0xff, param & 0xff, 0, 0, FRAME_END];
    const sum = checksumOf(frame);
    frame[7] = (sum >> 8) & 0xff;
    frame[8] = sum & 0xff;
    this.outbound.push(...frame);
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  // ---- inspection ----

  get playback(): PlaybackState {
    return this.state;
  }
  get currentTrack(): number {
    return this.track;
  }
  get currentVolume(): number {
    return this.volume;
  }
  get eq(): number {
    return this.equaliser;
  }
  /** The BUSY pin is low while a track is playing, which sketches poll. */
  get busyPinLow(): boolean {
    return this.state === 'playing';
  }
  get frameCount(): number {
    return this.frames;
  }
  get badChecksumCount(): number {
    return this.badChecksums;
  }
  get unknown(): number[] {
    return [...new Set(this.unknownCommands)];
  }

  reset(): void {
    this.state = 'stopped';
    this.track = 0;
    this.volume = 15;
    this.inbound = [];
    this.outbound = [];
    this.frames = 0;
    this.badChecksums = 0;
    this.unknownCommands = [];
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `DFPlayer Mini — ${this.state}${this.track ? ` track ${this.track}` : ''}, ` +
        `volume ${this.volume}/30, ${this.frames} frame(s)` +
        (this.badChecksums ? `, ${this.badChecksums} bad checksum(s)` : ''),
      log: [...this.log],
    };
  }
}

/** The DFPlayer checksum: negated sum of bytes 1 through 6. */
export function checksumOf(frame: number[]): number {
  let sum = 0;
  for (let i = 1; i <= 6; i++) sum += frame[i];
  return (-sum) & 0xffff;
}

/** Builds a command frame the way a library does, for tests and examples. */
export function dfplayerFrame(command: number, param = 0): number[] {
  const frame = [FRAME_START, 0xff, 0x06, command, 0x00, (param >> 8) & 0xff, param & 0xff, 0, 0, FRAME_END];
  const sum = checksumOf(frame);
  frame[7] = (sum >> 8) & 0xff;
  frame[8] = sum & 0xff;
  return frame;
}
