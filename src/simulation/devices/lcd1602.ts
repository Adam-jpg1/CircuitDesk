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
// The HD44780 side is not implemented here. It is the same silicon whether it
// is reached through a backpack or wired straight to GPIOs, so it lives in
// hd44780.ts and this file is only the expander: bytes onto pins, and an EN
// falling edge turned into a latch. What this class owns is the PCF8574's
// behaviour and the backpack's pin assignment — nothing about characters.

import { Hd44780Controller, LCD_COLUMNS, LCD_ROWS } from './hd44780';
import type { DeviceSnapshot, I2cDevice } from './types';

/** Backpacks ship at 0x27 (PCF8574) or 0x3F (PCF8574A). */
export const LCD1602_ADDRESSES = [0x27, 0x3f] as const;

export { LCD_COLUMNS, LCD_ROWS };

// PCF8574 pin assignment used by every common backpack.
const BIT_RS = 0x01;
const BIT_EN = 0x04;
const BIT_BACKLIGHT = 0x08;

export class Lcd1602Device implements I2cDevice {
  readonly instanceId: string;
  private readonly address: number;

  /** Last byte written to the expander, i.e. the current state of P0-P7. */
  private port = 0;
  private backlight = false;

  /** The chip behind the expander. */
  readonly lcd: Hd44780Controller;

  constructor(
    instanceId: string,
    address: number = LCD1602_ADDRESSES[0],
    geometry: { columns?: number; rows?: number } = {},
  ) {
    this.lcd = new Hd44780Controller(geometry);
    this.instanceId = instanceId;
    this.address = address;
  }

  get columns(): number {
    return this.lcd.columns;
  }
  get rows(): number {
    return this.lcd.rows;
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
    if (previous & BIT_EN && !(this.port & BIT_EN)) {
      // A backpack wires only D4-D7, so the panel is always four-bit.
      this.lcd.latch((previous & BIT_RS) !== 0, previous, false);
    }
    return true;
  }

  /** The PCF8574 can be read back, and returns its current pin state. */
  readByte(): number {
    return this.port;
  }

  // ---- inspection ----

  get isBacklit(): boolean {
    return this.backlight;
  }

  get isDisplayOn(): boolean {
    return this.lcd.isDisplayOn;
  }

  get isFourBitMode(): boolean {
    return this.lcd.isFourBitMode;
  }

  get unhandledCommands(): number[] {
    return this.lcd.unhandledCommands;
  }

  /** The characters visible on one row, as the panel would show them. */
  row(index: number): string {
    return this.lcd.row(index);
  }

  /** Every row, for tests and the canvas. */
  get lines(): string[] {
    return this.lcd.lines;
  }

  reset(): void {
    this.port = 0;
    this.backlight = false;
    this.lcd.reset();
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `LCD ${this.columns}x${this.rows} @0x${this.address.toString(16)}: ${this.lcd.isDisplayOn ? 'on' : 'off'}` +
        `${this.backlight ? ', backlit' : ''}${this.lcd.isFourBitMode ? '' : ', not initialised'}` +
        (this.lcd.isCursorOn ? ', cursor' : '') +
        (this.lcd.isBlinkOn ? ', blink' : ''),
      log: this.lcd.notes,
    };
  }
}
