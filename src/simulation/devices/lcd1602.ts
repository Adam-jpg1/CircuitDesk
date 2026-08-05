// 16x2 character LCD on an I2C backpack: a PCF8574 I/O expander driving an
// HD44780 controller.
//
// This is two chips, and the split matters because it is where sketches
// actually go wrong. The PCF8574 has no registers at all — every byte written
// to its address lands directly on P0-P7. The common backpack wires those pins
// to the HD44780 as:
//
//   P0 = RS   P1 = RW   P2 = EN   P3 = backlight   P4..P7 = D4..D7
//
// so the HD44780 sees nothing until firmware toggles EN, and each byte arrives
// as two nibbles (high first) because the backpack only wires four data lines.
// A sketch that forgets the EN pulse, or sends 8-bit commands, genuinely gets
// nothing on the display here — exactly as on real hardware.
//
// The HD44780 side implements the instruction set a driver library uses:
// clear, home, entry mode, display/cursor control, shift, function set, and
// CGRAM/DDRAM addressing, with the real DDRAM layout (line 0 at 0x00, line 1
// at 0x40) so an off-screen write is off-screen here too.

import type { DeviceSnapshot, I2cDevice } from './types';

/** Backpacks ship at 0x27 (PCF8574) or 0x3F (PCF8574A). */
export const LCD1602_ADDRESSES = [0x27, 0x3f] as const;

export const LCD_COLUMNS = 16;
export const LCD_ROWS = 2;

// PCF8574 pin assignment used by every common backpack.
const BIT_RS = 0x01;
const BIT_EN = 0x04;
const BIT_BACKLIGHT = 0x08;

/** DDRAM address where each display line starts (HD44780 datasheet). */
const ROW_BASE = [0x00, 0x40];
const DDRAM_SIZE = 0x80;

export class Lcd1602Device implements I2cDevice {
  readonly instanceId: string;
  private readonly address: number;

  /** Last byte written to the expander, i.e. the current state of P0-P7. */
  private port = 0;
  /** Nibble accumulator: the HD44780 needs two EN pulses per byte. */
  private highNibble = 0;
  private haveHighNibble = false;
  /** 4-bit mode is only entered after the initialisation dance. */
  private fourBitMode = false;

  private ddram = new Uint8Array(DDRAM_SIZE).fill(0x20);
  private cursor = 0;
  private inCgram = false;
  private displayOn = false;
  private cursorOn = false;
  private blinkOn = false;
  private backlight = false;
  private entryIncrement = true;

  private unknownCommands: number[] = [];
  private log: string[] = [];

  constructor(instanceId: string, address: number = LCD1602_ADDRESSES[0]) {
    this.instanceId = instanceId;
    this.address = address;
  }

  matchesAddress(address: number): boolean {
    return address === this.address;
  }

  start(): void {
    /* the expander is stateless between transfers */
  }

  stop(): void {
    /* nothing latches on STOP */
  }

  /** Bytes go straight onto the expander pins; the LCD reacts to EN falling. */
  writeByte(value: number): boolean {
    const previous = this.port;
    this.port = value & 0xff;
    this.backlight = (this.port & BIT_BACKLIGHT) !== 0;
    // The HD44780 latches on the falling edge of E.
    if (previous & BIT_EN && !(this.port & BIT_EN)) this.latchNibble(previous);
    return true;
  }

  /** The PCF8574 can be read back, and returns its current pin state. */
  readByte(): number {
    return this.port;
  }

  private latchNibble(portAtEdge: number): void {
    const nibble = (portAtEdge >> 4) & 0x0f;
    const isData = (portAtEdge & BIT_RS) !== 0;

    if (!this.fourBitMode) {
      // During initialisation the controller is still in 8-bit mode and each
      // pulse carries one whole (high-nibble-only) instruction. 0x2 is the
      // function set that switches it to 4-bit operation.
      if (!isData && nibble === 0x02) {
        this.fourBitMode = true;
        this.haveHighNibble = false;
        this.note('entered 4-bit mode');
      }
      return;
    }

    if (!this.haveHighNibble) {
      this.highNibble = nibble;
      this.haveHighNibble = true;
      return;
    }
    this.haveHighNibble = false;
    const byte = (this.highNibble << 4) | nibble;
    if (isData) this.writeCharacter(byte);
    else this.execute(byte);
  }

  private execute(cmd: number): void {
    if (cmd & 0x80) {
      this.inCgram = false;
      this.cursor = cmd & 0x7f;
      return;
    }
    if (cmd & 0x40) {
      // CGRAM addressing: custom glyph bytes are accepted but the glyph shapes
      // are not rendered, which the capability text says outright.
      this.inCgram = true;
      return;
    }
    if (cmd & 0x20) {
      // Function set — the interface width is already settled by this point.
      return;
    }
    if (cmd & 0x10) {
      // Cursor / display shift. Only the cursor move is modelled.
      if ((cmd & 0x08) === 0) this.cursor = (this.cursor + (cmd & 0x04 ? 1 : -1)) & 0x7f;
      return;
    }
    if (cmd & 0x08) {
      this.displayOn = (cmd & 0x04) !== 0;
      this.cursorOn = (cmd & 0x02) !== 0;
      this.blinkOn = (cmd & 0x01) !== 0;
      return;
    }
    if (cmd & 0x04) {
      this.entryIncrement = (cmd & 0x02) !== 0;
      return;
    }
    if (cmd & 0x02) {
      this.cursor = 0;
      return;
    }
    if (cmd === 0x01) {
      this.ddram.fill(0x20);
      this.cursor = 0;
      this.note('display cleared');
      return;
    }
    this.unknownCommands.push(cmd);
  }

  private writeCharacter(byte: number): void {
    if (this.inCgram) return; // glyph data, not screen content
    this.ddram[this.cursor & 0x7f] = byte;
    this.cursor = (this.cursor + (this.entryIncrement ? 1 : -1)) & 0x7f;
  }

  // ---- inspection ----

  get isBacklit(): boolean {
    return this.backlight;
  }

  get isDisplayOn(): boolean {
    return this.displayOn;
  }

  get isFourBitMode(): boolean {
    return this.fourBitMode;
  }

  get unhandledCommands(): number[] {
    return [...new Set(this.unknownCommands)];
  }

  /** The 16 characters visible on one row, as the panel would show them. */
  row(index: number): string {
    if (index < 0 || index >= LCD_ROWS) return '';
    if (!this.displayOn) return ' '.repeat(LCD_COLUMNS);
    const base = ROW_BASE[index];
    let out = '';
    for (let i = 0; i < LCD_COLUMNS; i++) out += String.fromCharCode(this.ddram[base + i]);
    return out;
  }

  /** Both rows, for tests and the canvas. */
  get lines(): string[] {
    return [this.row(0), this.row(1)];
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  reset(): void {
    this.port = 0;
    this.highNibble = 0;
    this.haveHighNibble = false;
    this.fourBitMode = false;
    this.ddram.fill(0x20);
    this.cursor = 0;
    this.inCgram = false;
    this.displayOn = false;
    this.cursorOn = false;
    this.blinkOn = false;
    this.backlight = false;
    this.entryIncrement = true;
    this.unknownCommands = [];
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `LCD 16x2 @0x${this.address.toString(16)} — ${this.displayOn ? 'on' : 'off'}` +
        `${this.backlight ? ', backlit' : ''}${this.fourBitMode ? '' : ', not initialised'}` +
        (this.cursorOn ? ', cursor' : '') +
        (this.blinkOn ? ', blink' : ''),
      log: [...this.log],
    };
  }
}
