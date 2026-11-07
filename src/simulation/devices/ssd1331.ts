// SSD1331 — 96x64 colour OLED, and the one that does not fit the TFT family.
//
// It shares the framebuffer with the ILI9341 and its relatives and nothing
// else. Its command set predates MIPI DCS: the address window is 0x15 (column)
// and 0x75 (row) rather than CASET/RASET, there is no RAMWR at all — pixel data
// simply follows once a window is set — and it has drawing commands the others
// do not, so the controller itself can fill a rectangle without firmware
// sending a single pixel.
//
// Those drawing commands are the reason this is worth modelling properly rather
// than approximating with the shared decoder. A sketch that calls
// `fillRect` on an SSD1331 library may send twelve bytes and expect a filled
// area; a model that only understood streamed pixels would show nothing and the
// user would have no way to tell why.
//
// NOT modelled: the dim and scroll commands (accepted, arguments consumed, no
// visual effect), master current, per-channel contrast as brightness, and the
// 8-bit 256-colour mode — only the 16-bit RGB565 format is decoded, and any
// other remap value is recorded as refused.

import { Rgb565Framebuffer, rgb565, swapRedBlue } from './framebuffer';
import type { ControlPinReader, DeviceSnapshot, SpiDevice, SpiMode } from './types';

export const SSD1331_WIDTH = 96;
export const SSD1331_HEIGHT = 64;

/** Commands, and how many argument bytes each takes. */
const COMMAND_ARGS: Record<number, number> = {
  0x15: 2, // set column address
  0x75: 2, // set row address
  0x81: 1, // contrast A
  0x82: 1, // contrast B
  0x83: 1, // contrast C
  0x87: 1, // master current
  0x8a: 1, // second pre-charge speed A
  0x8b: 1, // speed B
  0x8c: 1, // speed C
  0xa0: 1, // remap and colour depth
  0xa1: 1, // display start line
  0xa2: 1, // display offset
  0xa4: 0, // normal display
  0xa5: 0, // entire display on
  0xa6: 0, // entire display off
  0xa7: 0, // inverse display
  0xa8: 1, // multiplex ratio
  0xab: 1, // dim mode setting is 5 bytes on some revisions; 1 here per datasheet
  0xad: 1, // master configuration
  0xae: 0, // display off
  0xaf: 0, // display on
  0xb0: 1, // power save mode
  0xb1: 1, // phase 1 and 2 period
  0xb3: 1, // clock divide
  0xb8: 32, // gamma table
  0xb9: 0, // default gamma
  0xbb: 1, // pre-charge level
  0xbe: 1, // VCOMH
  0x21: 6, // draw line
  0x22: 10, // draw rectangle
  0x23: 6, // copy
  0x24: 4, // dim window
  0x25: 4, // clear window
  0x26: 1, // fill enable / disable
};

export class Ssd1331Device implements SpiDevice {
  readonly instanceId: string;
  readonly csPinId: string | null;
  readonly supportedModes: readonly SpiMode[] = [0];

  readonly fb = new Rgb565Framebuffer(SSD1331_WIDTH, SSD1331_HEIGHT);

  private readControl: ControlPinReader = () => undefined;

  private displayOn = false;
  private mode: 'normal' | 'all-on' | 'all-off' | 'inverse' = 'normal';
  /** True when the rectangle command fills rather than outlines. */
  private fillRects = false;

  private pending = -1;
  private args: number[] = [];
  private argsWanted = 0;
  private halfPixel = -1;

  private lastResetLevel: boolean | undefined;
  private unknown: number[] = [];
  private refusedRemaps: number[] = [];
  private log: string[] = [];

  constructor(instanceId: string, csPinId: string | null) {
    this.instanceId = instanceId;
    this.csPinId = csPinId;
  }

  attachControls(read: ControlPinReader): void {
    this.readControl = read;
  }

  settle(): void {
    const level = this.readControl('rst');
    if (level === undefined) return;
    if (this.lastResetLevel === true && level === false) {
      this.hardReset();
      this.note('hardware reset');
    }
    this.lastResetLevel = level;
  }

  select(active: boolean): void {
    if (!active) {
      this.halfPixel = -1;
      this.pending = -1;
      this.argsWanted = 0;
      this.args = [];
    }
  }

  transfer(mosi: number): number | null {
    const byte = mosi & 0xff;
    if (this.readControl('dc') === true) this.dataByte(byte);
    else this.commandByte(byte);
    return null;
  }

  private commandByte(value: number): void {
    // An argument byte sent with D/C low, which is how these parts are
    // normally driven — the whole command including its arguments goes out in
    // command mode.
    if (this.argsWanted > 0) {
      this.args.push(value);
      if (this.args.length >= this.argsWanted) {
        const cmd = this.pending;
        const args = this.args;
        this.pending = -1;
        this.argsWanted = 0;
        this.args = [];
        this.apply(cmd, args);
      }
      return;
    }

    const wanted = COMMAND_ARGS[value];
    if (wanted === undefined) {
      this.unknown.push(value);
      this.note(`unknown command 0x${value.toString(16)}`);
      return;
    }
    this.pending = value;
    this.argsWanted = wanted;
    this.args = [];
    if (wanted === 0) this.apply(value, []);
  }

  /** With a window set, data bytes are pixels — there is no RAMWR to wait for. */
  private dataByte(value: number): void {
    if (this.halfPixel < 0) {
      this.halfPixel = value;
      return;
    }
    const pixel = (this.halfPixel << 8) | value;
    this.halfPixel = -1;
    this.fb.writePixel(pixel);
  }

  private apply(cmd: number, args: number[]): void {
    switch (cmd) {
      case 0x15:
        this.fb.setColumnRange(args[0], args[1]);
        return;
      case 0x75:
        this.fb.setRowRange(args[0], args[1]);
        return;
      case 0xae:
        this.displayOn = false;
        return;
      case 0xaf:
        this.displayOn = true;
        this.note('display on');
        return;
      case 0xa4:
        this.mode = 'normal';
        return;
      case 0xa5:
        this.mode = 'all-on';
        return;
      case 0xa6:
        this.mode = 'all-off';
        return;
      case 0xa7:
        this.mode = 'inverse';
        return;
      case 0xa0: {
        const v = args[0] ?? 0;
        // Bit 6 selects 65k colour. The 256-colour mode is not decoded, and
        // saying so is better than drawing the wrong colours.
        if ((v & 0x40) === 0) {
          this.refusedRemaps.push(v);
          this.note(`remap 0x${v.toString(16)} selects a colour depth this model does not decode`);
          return;
        }
        this.fb.access = {
          // Bit 1 mirrors the columns and bit 4 the rows. Bit 2 selects the
          // colour sequence: clear is RGB, set is BGR — which is the
          // difference between the two remap values every driver ships with
          // (0x72 and 0x76), and getting it backwards turns red into blue.
          colMirror: (v & 0x02) !== 0,
          rowMirror: (v & 0x10) !== 0,
          exchange: false,
          bgr: (v & 0x04) !== 0,
        };
        return;
      }
      case 0x26:
        this.fillRects = (args[0] & 0x01) !== 0;
        return;
      case 0x21:
        this.drawLine(args);
        return;
      case 0x22:
        this.drawRect(args);
        return;
      case 0x25:
        this.clearWindow(args);
        return;
      default:
        return; // accepted, consumed, no visual effect
    }
  }

  /** col0, row0, col1, row1, r, g, b — the colours are 6/6/6 scaled. */
  private drawLine(a: number[]): void {
    const color = rgb565(a[4] << 2, a[5] << 2, a[6] << 2);
    this.line(a[0], a[1], a[2], a[3], color);
  }

  /** col0, row0, col1, row1, outline rgb, fill rgb. */
  private drawRect(a: number[]): void {
    const outline = rgb565(a[4] << 2, a[5] << 2, a[6] << 2);
    const fill = rgb565(a[7] << 2, a[8] << 2, a[9] << 2);
    const x0 = Math.min(a[0], a[2]);
    const x1 = Math.max(a[0], a[2]);
    const y0 = Math.min(a[1], a[3]);
    const y1 = Math.max(a[1], a[3]);
    if (this.fillRects) {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.poke(x, y, fill);
    }
    this.line(x0, y0, x1, y0, outline);
    this.line(x0, y1, x1, y1, outline);
    this.line(x0, y0, x0, y1, outline);
    this.line(x1, y0, x1, y1, outline);
  }

  private clearWindow(a: number[]): void {
    const x0 = Math.min(a[0], a[2]);
    const x1 = Math.max(a[0], a[2]);
    const y0 = Math.min(a[1], a[3]);
    const y1 = Math.max(a[1], a[3]);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.poke(x, y, 0);
  }

  /** Bresenham, because the controller draws real lines rather than rectangles. */
  private line(x0: number, y0: number, x1: number, y1: number, color: number): void {
    let x = x0;
    let y = y0;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.poke(x, y, color);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /**
   * Writes one pixel from the drawing engine, through the same remap the
   * streamed pixel path uses.
   *
   * The graphic commands address RAM exactly as a pixel write does, so they
   * have to see the same column and row mapping. Bypassing it would make a
   * hardware-drawn rectangle appear in a different place from a rectangle drawn
   * by streaming pixels, which is a difference no real part has.
   */
  private poke(col: number, row: number, color: number): void {
    let x = this.fb.access.colMirror ? SSD1331_WIDTH - 1 - col : col;
    let y = this.fb.access.rowMirror ? SSD1331_HEIGHT - 1 - row : row;
    if (x < 0 || y < 0 || x >= SSD1331_WIDTH || y >= SSD1331_HEIGHT) return;
    const packed = this.fb.access.bgr ? swapRedBlue(color) : color;
    const index = y * SSD1331_WIDTH + x;
    if (this.fb.pixels[index] !== packed) {
      this.fb.pixels[index] = packed;
      this.fb.revision++;
    }
  }

  private hardReset(): void {
    this.fb.reset();
    this.displayOn = false;
    this.mode = 'normal';
    this.fillRects = false;
    this.pending = -1;
    this.args = [];
    this.argsWanted = 0;
    this.halfPixel = -1;
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  // ---- inspection ----

  get isVisible(): boolean {
    return this.displayOn;
  }
  get displayMode(): string {
    return this.mode;
  }
  get fillEnabled(): boolean {
    return this.fillRects;
  }
  get revision(): number {
    return this.fb.revision;
  }
  get unknownCommands(): number[] {
    return [...new Set(this.unknown)];
  }
  get refusedRemapValues(): number[] {
    return [...new Set(this.refusedRemaps)];
  }

  pixel(x: number, y: number): { r: number; g: number; b: number } {
    if (!this.displayOn || this.mode === 'all-off') return { r: 0, g: 0, b: 0 };
    if (this.mode === 'all-on') return { r: 255, g: 255, b: 255 };
    const c = this.fb.pixel(x, y);
    return this.mode === 'inverse' ? { r: 255 - c.r, g: 255 - c.g, b: 255 - c.b } : c;
  }

  reset(): void {
    this.hardReset();
    this.unknown = [];
    this.refusedRemaps = [];
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `SSD1331 96x64: ${this.displayOn ? this.mode : 'off'}, ` +
        `${this.fb.written} pixel(s) written` +
        (this.unknown.length ? `, ${this.unknownCommands.length} unknown command(s)` : ''),
      log: [...this.log],
    };
  }
}
