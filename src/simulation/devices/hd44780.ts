// The HD44780 character LCD controller, separated from whatever is driving it.
//
// This chip is reached two entirely different ways, and both are common:
//
//   • through a PCF8574 I2C backpack, where a byte written to the expander
//     lands on the controller's pins and the LCD reacts when EN falls;
//   • wired straight to GPIOs — RS, EN and four or eight data lines — which is
//     what LiquidCrystal(rs, en, d4, d5, d6, d7) does and what every Arduino
//     starter kit tells you to build.
//
// The controller is the same silicon in both cases, so it lives here on its
// own and the two front-ends only translate their wiring into `latch()`. That
// split is not tidiness: it is the reason the parallel panel behaves identically
// to the I2C one down to the initialisation dance, instead of being a second
// implementation that agrees with the first until it doesn't.
//
// Implemented: clear, home, entry mode, display/cursor control, cursor shift,
// function set (including the 4-bit/8-bit interface decision), and CGRAM and
// DDRAM addressing with the real address map — line 0 at 0x00, line 1 at 0x40,
// and a four-line module continuing those two at +0x14, which is why text
// written past column 20 on a 2004 appears on line three.
//
// NOT modelled: custom CGRAM glyph shapes (the bytes are accepted and the
// address tracked, but a custom character renders as whatever code point it
// was written as), display shift, the busy flag's timing, and cursor blink
// rate. Unknown instructions are recorded, never ignored.

/**
 * DDRAM address of each row.
 *
 * Two row buffers whatever the panel is; a four-line module gets rows three
 * and four by continuing rows one and two at +0x14.
 */
const ROW_BASE_2 = [0x00, 0x40];
const ROW_BASE_4 = [0x00, 0x40, 0x14, 0x54];
const DDRAM_SIZE = 0x80;

export const LCD_COLUMNS = 16;
export const LCD_ROWS = 2;

export class Hd44780Controller {
  /** Panel geometry. A 1602 and a 2004 are the same controller, different glass. */
  readonly columns: number;
  readonly rows: number;
  private readonly rowBase: number[];

  private ddram = new Uint8Array(DDRAM_SIZE).fill(0x20);
  private cursor = 0;
  private inCgram = false;
  private displayOn = false;
  private cursorOn = false;
  private blinkOn = false;
  private entryIncrement = true;

  /**
   * Interface width.
   *
   * Starts false and becomes true only when firmware sends the function set
   * that selects it. Until then the controller is in its 8-bit power-on state
   * and each EN pulse carries one whole instruction in the high nibble — which
   * is exactly why the initialisation dance exists, and why a sketch that skips
   * it gets a blank panel here as on a bench.
   */
  private fourBitMode = false;
  /** True once any function set has been seen, in either width. */
  private initialised = false;

  private highNibble = 0;
  private haveHighNibble = false;

  private unknownCommands: number[] = [];
  private log: string[] = [];

  constructor(geometry: { columns?: number; rows?: number } = {}) {
    this.columns = geometry.columns ?? LCD_COLUMNS;
    this.rows = geometry.rows ?? LCD_ROWS;
    this.rowBase = this.rows > 2 ? ROW_BASE_4 : ROW_BASE_2;
  }

  /**
   * One EN falling edge.
   *
   * `bits` is what was on the data lines at the edge: the high nibble in bits
   * 4-7 for a four-wire panel, or the whole byte for an eight-wire one. `rs`
   * separates an instruction from a character. Everything about assembling
   * nibbles into bytes is here, so a front-end never has to know.
   */
  latch(rs: boolean, bits: number, eightBitBus: boolean): void {
    if (eightBitBus && this.initialised && !this.fourBitMode) {
      // A fully wired eight-bit panel: one pulse, one byte.
      if (rs) this.writeCharacter(bits & 0xff);
      else this.execute(bits & 0xff);
      return;
    }

    const nibble = (bits >> 4) & 0x0f;

    if (!this.fourBitMode) {
      // Power-on 8-bit state: each pulse is one instruction in the high nibble.
      if (!rs && nibble === 0x02) {
        this.fourBitMode = true;
        this.initialised = true;
        this.haveHighNibble = false;
        this.note('entered 4-bit mode');
        return;
      }
      if (!rs && nibble === 0x03) {
        // The three 0x30 pulses that reset the interface. Recorded so a panel
        // that was never initialised can be told from one that was.
        this.initialised = true;
        return;
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
    if (rs) this.writeCharacter(byte);
    else this.execute(byte);
  }

  /**
   * Declares the bus width from a function set seen on an eight-wire panel.
   *
   * An eight-bit driver sends 0x38 (function set, 8-bit, two lines) as a whole
   * byte on its first pulse. Nothing about that byte's high nibble distinguishes
   * it from a four-bit sequence, so the front-end that knows how many data
   * lines are actually wired is the one that settles it.
   */
  declareEightBit(): void {
    this.initialised = true;
    this.fourBitMode = false;
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
      this.initialised = true;
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

  get isDisplayOn(): boolean {
    return this.displayOn;
  }
  get isFourBitMode(): boolean {
    return this.fourBitMode;
  }
  get isInitialised(): boolean {
    return this.initialised;
  }
  get isCursorOn(): boolean {
    return this.cursorOn;
  }
  get isBlinkOn(): boolean {
    return this.blinkOn;
  }
  get cursorAddress(): number {
    return this.cursor;
  }
  get unhandledCommands(): number[] {
    return [...new Set(this.unknownCommands)];
  }
  get notes(): string[] {
    return [...this.log];
  }

  /** The characters visible on one row, as the panel would show them. */
  row(index: number): string {
    if (index < 0 || index >= this.rows) return '';
    if (!this.displayOn) return ' '.repeat(this.columns);
    const base = this.rowBase[index];
    let out = '';
    for (let i = 0; i < this.columns; i++) out += String.fromCharCode(this.ddram[(base + i) % DDRAM_SIZE]);
    return out;
  }

  /** Every row, for tests and the canvas. */
  get lines(): string[] {
    return Array.from({ length: this.rows }, (_, i) => this.row(i));
  }

  note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  reset(): void {
    this.ddram.fill(0x20);
    this.cursor = 0;
    this.inCgram = false;
    this.displayOn = false;
    this.cursorOn = false;
    this.blinkOn = false;
    this.entryIncrement = true;
    this.fourBitMode = false;
    this.initialised = false;
    this.highNibble = 0;
    this.haveHighNibble = false;
    this.unknownCommands = [];
    this.log = [];
  }
}
