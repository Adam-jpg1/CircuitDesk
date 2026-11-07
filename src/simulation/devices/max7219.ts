// MAX7219 — eight-digit LED driver, used as an 8×8 matrix.
//
// The part takes sixteen-bit words over SPI: an address byte then a data byte,
// latched on the rising edge of CS. Its digit registers are the matrix rows,
// so what appears on the display is literally what firmware clocked in — there
// is no framebuffer the simulator fills in on the part's behalf.
//
// Chaining is real. A MAX7219 shifts whatever it receives out of its DOUT pin,
// so a controller driving four of them sends four words per update and the
// first word ends up in the last device. That is modelled by passing the
// displaced word along the chain rather than by giving each device its own
// chip select, which is what makes the usual "why is my text on the wrong
// panel" mistake reproducible.
//
// NOT modelled: intensity as actual brightness (the register is stored and
// reported, but every lit segment draws the same), scan-limit's effect on
// multiplex duty, the display-test register's blink timing, and BCD decode
// mode's font (decode mode is recorded and reported rather than applied).

import type { DeviceSnapshot, SpiDevice, SpiMode } from './types';

export const MAX7219_REG = {
  NOOP: 0x00,
  DIGIT0: 0x01,
  DIGIT7: 0x08,
  DECODE_MODE: 0x09,
  INTENSITY: 0x0a,
  SCAN_LIMIT: 0x0b,
  SHUTDOWN: 0x0c,
  DISPLAY_TEST: 0x0f,
} as const;

export class Max7219Device implements SpiDevice {
  readonly instanceId: string;
  readonly csPinId: string | null;
  /** The datasheet specifies mode 0 only, and the part is clocked on rising SCK. */
  readonly supportedModes: readonly SpiMode[] = [0];

  /** One byte per digit — the rows of the matrix. */
  private digits = new Uint8Array(8);
  private decodeMode = 0;
  private intensity = 0;
  private scanLimit = 7;
  private shutdown = true;
  private displayTest = false;

  /** Bytes received since CS fell. */
  private shiftIn: number[] = [];
  /** CS as last seen, so only a real edge starts or latches a word. */
  private selected = false;
  /** What this device pushed out of DOUT during the current transaction. */
  private shiftOut: number[] = [];
  private log: string[] = [];
  private unknown: number[] = [];
  writeCounter = 0;

  constructor(instanceId: string, csPinId: string | null) {
    this.instanceId = instanceId;
    this.csPinId = csPinId;
  }

  /** SPI is byte-at-a-time; the part needs two to make a word. */
  transfer(byte: number): number | null {
    this.shiftIn.push(byte & 0xff);
    // A daisy-chained part passes the byte it is displacing to the next one.
    // With a two-byte buffer that is the byte from two transfers ago.
    const displaced = this.shiftIn.length > 2 ? this.shiftIn[this.shiftIn.length - 3] : 0;
    this.shiftOut.push(displaced);
    return displaced;
  }

  /**
   * CS rising latches the last word received.
   *
   * Only the *last* two bytes matter: in a chain, earlier words have already
   * been shifted through to the devices further along.
   *
   * The bus re-asserts selection before every byte, so a repeated select is
   * not an edge: treating it as one would throw away the address byte before
   * the data byte arrived, and no word would ever latch.
   */
  select(selected: boolean): void {
    if (selected === this.selected) return;
    this.selected = selected;
    if (selected) {
      this.shiftIn = [];
      this.shiftOut = [];
      return;
    }
    if (this.shiftIn.length >= 2) {
      const address = this.shiftIn[this.shiftIn.length - 2];
      const data = this.shiftIn[this.shiftIn.length - 1];
      this.write(address, data);
    }
    this.shiftIn = [];
  }

  private write(address: number, data: number): void {
    const reg = address & 0x0f;
    if (reg >= MAX7219_REG.DIGIT0 && reg <= MAX7219_REG.DIGIT7) {
      this.digits[reg - 1] = data & 0xff;
      this.writeCounter++;
      return;
    }
    switch (reg) {
      case MAX7219_REG.NOOP:
        return;
      case MAX7219_REG.DECODE_MODE:
        this.decodeMode = data & 0xff;
        return;
      case MAX7219_REG.INTENSITY:
        this.intensity = data & 0x0f;
        return;
      case MAX7219_REG.SCAN_LIMIT:
        this.scanLimit = data & 0x07;
        return;
      case MAX7219_REG.SHUTDOWN:
        this.shutdown = (data & 1) === 0;
        this.log.push(this.shutdown ? 'shutdown' : 'awake');
        return;
      case MAX7219_REG.DISPLAY_TEST:
        this.displayTest = (data & 1) === 1;
        return;
      default:
        this.unknown.push(reg);
    }
  }

  /**
   * The lit pixels, row-major, as the panel shows them.
   *
   * Shutdown blanks the display without losing the digit registers, and
   * display-test lights everything — both real behaviours that firmware uses.
   */
  get pixels(): Uint8Array {
    if (this.displayTest) return new Uint8Array(8).fill(0xff);
    if (this.shutdown) return new Uint8Array(8);
    const out = new Uint8Array(8);
    for (let row = 0; row <= this.scanLimit && row < 8; row++) out[row] = this.digits[row];
    return out;
  }

  get isAwake(): boolean {
    return !this.shutdown;
  }

  get litCount(): number {
    let n = 0;
    for (const row of this.pixels) {
      for (let bit = 0; bit < 8; bit++) if ((row >> bit) & 1) n++;
    }
    return n;
  }

  /** Intensity as written. Stored and reported; not applied to brightness. */
  get intensityLevel(): number {
    return this.intensity;
  }

  get decodeModeValue(): number {
    return this.decodeMode;
  }

  reset(): void {
    this.digits.fill(0);
    this.decodeMode = 0;
    this.intensity = 0;
    this.scanLimit = 7;
    this.shutdown = true;
    this.displayTest = false;
    this.shiftIn = [];
    this.selected = false;
  }

  snapshot(): DeviceSnapshot {
    return {
      status: this.shutdown ? 'shutdown' : `${this.litCount} pixels lit, intensity ${this.intensity}`,
      log: [...this.log.slice(-16), ...(this.unknown.length ? [`${this.unknown.length} unknown register(s)`] : [])],
    };
  }
}
