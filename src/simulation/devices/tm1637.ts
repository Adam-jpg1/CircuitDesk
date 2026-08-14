// TM1637 — four seven-segment digits on two wires, and not I2C.
//
// It looks like I2C from across the room: a clock line, a data line, start and
// stop conditions made the same way. It is not, and the difference is the whole
// reason a TM1637 needs its own model rather than an address on the I2C bus:
//
//   • there is no address. Every byte after a start is a command or data for
//     the one chip on those two wires;
//   • bits go out LEAST significant first, where I2C is most significant first.
//     A decoder that assumed I2C order would show every digit as a scrambled
//     pattern of the right segments;
//   • the ACK is driven by the chip on the ninth clock, but nothing addresses
//     it, so a wrong "address" cannot NACK — the failure mode of miswiring one
//     is a blank display, not a bus error.
//
// Because it is two plain GPIOs, the model is driven by pin edges rather than
// by a bus: data is sampled on the rising edge of the clock, and start and stop
// are recognised as data transitions while the clock is high. That is what
// makes an ordinary Arduino TM1637 sketch work here with no simulator-specific
// API — the library bit-bangs these two pins and this watches them.
//
// NOT modelled: the keypad scanning half of the chip (the TM1637 can read a
// key matrix; no common breakout wires it), the display-test mode, and
// brightness as actual luminance — the level is stored and reported, and the
// canvas shows a lit segment at one intensity.

import type { DeviceSnapshot, SimDevice } from './types';

/** Commands, by their top two bits. */
const CMD_DATA = 0x40;
const CMD_ADDRESS = 0xc0;
const CMD_DISPLAY = 0x80;

export const TM1637_DIGITS = 4;

type Phase = 'idle' | 'receiving';

export class Tm1637Device implements SimDevice {
  readonly instanceId: string;

  /** One segment byte per digit: bit 0 = A … bit 6 = G, bit 7 = colon/dp. */
  readonly digits = new Uint8Array(TM1637_DIGITS);

  private clk = true;
  private dio = true;
  private phase: Phase = 'idle';

  /** Bits of the byte being clocked in, LSB first. */
  private bitCount = 0;
  private current = 0;
  /** True while the chip is driving the ACK bit rather than the controller. */
  private inAck = false;

  private displayOn = false;
  private brightness = 0;
  /** Auto-increment (0x40) or fixed address (0x44). */
  private autoIncrement = true;
  /** Where the next data byte lands, set by the address command. */
  private cursor = 0;
  /** True once an address command has been seen since the last data command. */
  private addressed = false;

  private bytes = 0;
  private unknown: number[] = [];
  private log: string[] = [];
  revision = 0;

  constructor(instanceId: string) {
    this.instanceId = instanceId;
  }

  /**
   * A level change on one of the two pins.
   *
   * Order matters and is the protocol: a data transition while the clock is
   * high is a start or a stop, and a clock rising edge samples the data line.
   */
  onPinLevel(pinId: string, high: boolean): void {
    if (pinId === 'dio') {
      const previous = this.dio;
      this.dio = high;
      if (this.clk && previous !== high) {
        if (!high) this.start();
        else this.stop();
      }
      return;
    }
    if (pinId !== 'clk') return;
    const rising = !this.clk && high;
    this.clk = high;
    if (rising) this.clockEdge();
  }

  private start(): void {
    this.phase = 'receiving';
    this.bitCount = 0;
    this.current = 0;
    this.inAck = false;
  }

  /**
   * A stop condition ends the transaction, and with it the addressed data run.
   *
   * That boundary is what makes the next byte a command again rather than a
   * fifth digit. A model that kept accepting data after the stop would let a
   * sketch that writes four digits and then sets brightness overwrite a digit
   * with the brightness byte.
   */
  private stop(): void {
    this.phase = 'idle';
    this.bitCount = 0;
    this.current = 0;
    this.inAck = false;
    this.addressed = false;
  }

  private clockEdge(): void {
    if (this.phase !== 'receiving') return;

    if (this.inAck) {
      // The ninth clock. The chip pulls DIO low to acknowledge; nothing is
      // read from the controller here.
      this.inAck = false;
      this.bitCount = 0;
      this.current = 0;
      return;
    }

    // Least significant bit first — the difference from I2C that would
    // otherwise scramble every glyph.
    if (this.dio) this.current |= 1 << this.bitCount;
    this.bitCount++;

    if (this.bitCount === 8) {
      this.acceptByte(this.current & 0xff);
      this.inAck = true;
    }
  }

  private acceptByte(value: number): void {
    this.bytes++;

    // A data byte following an address command goes to the display.
    if (this.addressed) {
      this.digits[this.cursor % TM1637_DIGITS] = value;
      this.revision++;
      if (this.autoIncrement) this.cursor++;
      return;
    }

    const top = value & 0xc0;
    if (top === CMD_DATA) {
      this.autoIncrement = (value & 0x04) === 0;
      this.note(this.autoIncrement ? 'data: auto-increment' : 'data: fixed address');
      return;
    }
    if (top === CMD_ADDRESS) {
      this.cursor = value & 0x07;
      this.addressed = true;
      return;
    }
    if (top === CMD_DISPLAY) {
      this.displayOn = (value & 0x08) !== 0;
      this.brightness = value & 0x07;
      this.note(`display ${this.displayOn ? 'on' : 'off'}, brightness ${this.brightness}`);
      return;
    }
    this.unknown.push(value);
    this.note(`unhandled byte 0x${value.toString(16)}`);
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  // ---- inspection ----

  /** Segment bytes as the panel shows them, or all-dark while the display is off. */
  get shown(): Uint8Array {
    return this.displayOn ? this.digits : new Uint8Array(TM1637_DIGITS);
  }
  get isOn(): boolean {
    return this.displayOn;
  }
  get brightnessLevel(): number {
    return this.brightness;
  }
  get isAutoIncrement(): boolean {
    return this.autoIncrement;
  }
  get byteCount(): number {
    return this.bytes;
  }
  get unhandledBytes(): number[] {
    return [...new Set(this.unknown)];
  }

  /** Which segments of a digit are lit, as letters, for tests and the canvas. */
  segments(digit: number): string {
    if (!this.displayOn || digit < 0 || digit >= TM1637_DIGITS) return '';
    const byte = this.digits[digit];
    return ['a', 'b', 'c', 'd', 'e', 'f', 'g'].filter((_, i) => ((byte >> i) & 1) === 1).join('');
  }

  reset(): void {
    this.digits.fill(0);
    this.clk = true;
    this.dio = true;
    this.phase = 'idle';
    this.bitCount = 0;
    this.current = 0;
    this.inAck = false;
    this.displayOn = false;
    this.brightness = 0;
    this.autoIncrement = true;
    this.cursor = 0;
    this.addressed = false;
    this.bytes = 0;
    this.unknown = [];
    this.log = [];
    this.revision++;
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `TM1637 — ${this.displayOn ? `on, brightness ${this.brightness}` : 'off'}, ` +
        `${this.bytes} byte(s)` +
        (this.unknown.length ? `, ${this.unhandledBytes.length} unhandled` : ''),
      log: [...this.log],
    };
  }
}
