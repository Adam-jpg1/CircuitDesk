// A character LCD wired straight to GPIOs — the LiquidCrystal wiring.
//
//   LiquidCrystal lcd(rs, en, d4, d5, d6, d7);
//
// This is the version in every starter kit, and it is not an I2C device at all:
// there is no bus, no address, and nothing to decode. The controller reacts to
// one thing, the falling edge of E, and what it reads at that instant is
// whatever the data pins happen to be holding. So this model does exactly that
// and nothing else — the HD44780 itself is shared with the backpack version.
//
// Two consequences that fall out of modelling the edge rather than the API, and
// that are the reason it is worth doing this way:
//
//   • a sketch that never wires or never drives E gets a blank panel, because
//     nothing ever latches. No amount of lcd.print() changes that.
//   • the four-bit initialisation dance is real. LiquidCrystal sends 0x30
//     three times and then 0x20 to select the four-wire interface; until that
//     0x20 arrives the controller is in its power-on eight-bit state and reads
//     one instruction per pulse. Skip it and the panel stays blank here too.
//
// Eight-bit wiring is supported as well: when all eight data lines are wired,
// one pulse carries one byte.
//
// NOT modelled: the R/W line's read path (a driver that polls the busy flag
// instead of delaying reads back an idle bus — every common library delays),
// contrast from the V0 pin, and the backlight pins, which are power rather than
// signal. See hd44780.ts for what the controller does and does not do.

import { Hd44780Controller } from './hd44780';
import type { DeviceSnapshot, SimDevice } from './types';

/** Data pin ids, high nibble first, as the part exposes them. */
export const LCD_DATA_PINS_4 = ['d4', 'd5', 'd6', 'd7'] as const;
export const LCD_DATA_PINS_8 = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'] as const;

export class Hd44780ParallelDevice implements SimDevice {
  readonly instanceId: string;
  readonly lcd: Hd44780Controller;

  /** Current level of each pin the panel reads, by component pin id. */
  private levels = new Map<string, boolean>();
  private enHigh = false;
  /** True once every one of d0-d3 has been seen driven, i.e. an 8-wire build. */
  private eightBitWired = false;
  private latches = 0;
  private log: string[] = [];

  constructor(instanceId: string, geometry: { columns?: number; rows?: number } = {}) {
    this.instanceId = instanceId;
    this.lcd = new Hd44780Controller(geometry);
  }

  get columns(): number {
    return this.lcd.columns;
  }
  get rows(): number {
    return this.lcd.rows;
  }

  /**
   * Declares how many data lines the wiring actually connects.
   *
   * The circuit knows this and the panel cannot infer it: an eight-bit driver's
   * first function set (0x38) has the same high nibble as a four-bit one's, so
   * nothing in the byte stream distinguishes them. Called by the binding when
   * the part is wired up.
   */
  setBusWidth(eightBit: boolean): void {
    if (eightBit === this.eightBitWired) return;
    this.eightBitWired = eightBit;
    if (eightBit) {
      this.lcd.declareEightBit();
      this.note('eight data lines wired');
    }
  }

  get isEightBit(): boolean {
    return this.eightBitWired;
  }

  /**
   * A pin the panel watches changed level.
   *
   * RS and the data lines are only *stored*; nothing happens until E falls,
   * which is the whole behaviour of the part. Levels are kept rather than
   * sampled on demand because the binding delivers edges, and the value that
   * matters is the one present at the instant of the edge.
   */
  onPinLevel(pinId: string, high: boolean): void {
    if (pinId === 'e') {
      const falling = this.enHigh && !high;
      this.enHigh = high;
      if (falling) this.latchNow();
      return;
    }
    this.levels.set(pinId, high);
  }

  /** Assembles the data lines into the byte the controller sees at the edge. */
  private latchNow(): void {
    const rs = this.levels.get('rs') === true;
    let bits = 0;
    if (this.eightBitWired) {
      LCD_DATA_PINS_8.forEach((pin, i) => {
        if (this.levels.get(pin)) bits |= 1 << i;
      });
    } else {
      // A four-wire panel carries the nibble on D4-D7, which are bits 4-7.
      LCD_DATA_PINS_4.forEach((pin, i) => {
        if (this.levels.get(pin)) bits |= 1 << (4 + i);
      });
    }
    this.latches++;
    this.lcd.latch(rs, bits, this.eightBitWired);
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  // ---- inspection ----

  get isDisplayOn(): boolean {
    return this.lcd.isDisplayOn;
  }
  get isInitialised(): boolean {
    return this.lcd.isInitialised;
  }
  get lines(): string[] {
    return this.lcd.lines;
  }
  row(index: number): string {
    return this.lcd.row(index);
  }
  get enablePulses(): number {
    return this.latches;
  }
  get unhandledCommands(): number[] {
    return this.lcd.unhandledCommands;
  }

  reset(): void {
    this.levels.clear();
    this.enHigh = false;
    this.latches = 0;
    this.log = [];
    this.lcd.reset();
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `LCD ${this.columns}x${this.rows} (parallel, ${this.eightBitWired ? '8' : '4'}-bit): ` +
        `${this.lcd.isDisplayOn ? 'on' : 'off'}${this.lcd.isInitialised ? '' : ', not initialised'}, ` +
        `${this.latches} E pulse(s)`,
      log: [...this.log, ...this.lcd.notes],
    };
  }
}
