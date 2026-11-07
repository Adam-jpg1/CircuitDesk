// Framebuffers for display controllers, and the windowed writes they all use.
//
// Every colour TFT in the library — ILI9341, ST7735, ST7789, GC9A01, SSD1331 —
// works the same way at this level, whatever its command set: firmware sets a
// column range and a row range, then streams pixels, and the controller walks
// that rectangle filling it in. Getting the walk wrong is the classic display
// bug, and it looks like a picture that is skewed, wrapped, or drawn into the
// wrong corner. So the walk lives here, once.
//
// What does NOT live here is the command set. Two controllers that share this
// buffer still decode their own opcodes, because they genuinely differ, and a
// shared decoder would let one accept the other's initialisation and appear to
// work. See tftController.ts for that split.
//
// Storage is RGB565 — two bytes per pixel — because that is what the wire
// carries and what the parts store. A 240x320 panel is therefore 150 KB, which
// is a normal typed array rather than something that needs managing. Colour is
// converted to 8-bit RGB only at the edge, when a renderer asks for it.

/** Packs 8-bit components into the 16-bit word a TFT stores. */
export function rgb565(r: number, g: number, b: number): number {
  return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
}

/**
 * Unpacks RGB565 to 8-bit components.
 *
 * The low bits are replicated rather than zero-filled, so full-scale stays full
 * scale: 0xFFFF has to come back as 255,255,255, and a naive shift gives
 * 248,252,248 — a white that is visibly not white next to anything else.
 */
export function unpack565(value: number): { r: number; g: number; b: number } {
  const r = (value >> 11) & 0x1f;
  const g = (value >> 5) & 0x3f;
  const b = value & 0x1f;
  return {
    r: (r << 3) | (r >> 2),
    g: (g << 2) | (g >> 4),
    b: (b << 3) | (b >> 2),
  };
}

/**
 * How the controller's memory-access control register maps writes onto glass.
 *
 * MADCTL is why a display library has a `setRotation`. The bits swap rows for
 * columns and mirror either axis, and a model that ignored them would draw a
 * rotated sketch upright — which sounds harmless until the sketch is drawing
 * something whose orientation is the whole point.
 */
export interface MemoryAccess {
  /** MY: rows are addressed bottom-to-top. */
  rowMirror: boolean;
  /** MX: columns are addressed right-to-left. */
  colMirror: boolean;
  /** MV: row and column addresses are exchanged. */
  exchange: boolean;
  /** BGR: the incoming pixel's red and blue components are swapped. */
  bgr: boolean;
}

export const DEFAULT_ACCESS: MemoryAccess = {
  rowMirror: false,
  colMirror: false,
  exchange: false,
  bgr: false,
};

export class Rgb565Framebuffer {
  /** Panel size in its native orientation, before any MADCTL exchange. */
  readonly width: number;
  readonly height: number;
  /** One RGB565 word per pixel, row-major in panel coordinates. */
  readonly pixels: Uint16Array;

  /** Bumped on every pixel change so a renderer knows when to repaint. */
  revision = 0;
  /** Pixels accepted since reset, for the inspector. */
  written = 0;

  access: MemoryAccess = { ...DEFAULT_ACCESS };

  private colStart = 0;
  private colEnd: number;
  private rowStart = 0;
  private rowEnd: number;
  private col = 0;
  private row = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint16Array(width * height);
    this.colEnd = width - 1;
    this.rowEnd = height - 1;
  }

  reset(): void {
    this.pixels.fill(0);
    this.access = { ...DEFAULT_ACCESS };
    this.colStart = 0;
    this.colEnd = this.width - 1;
    this.rowStart = 0;
    this.rowEnd = this.height - 1;
    this.col = 0;
    this.row = 0;
    this.written = 0;
    this.revision++;
  }

  /**
   * The address window, in the orientation firmware is addressing.
   *
   * With MV set, a driver's "column" is the panel's row, so the ranges are
   * clamped against whichever axis they will actually walk. Out-of-range values
   * are clamped rather than rejected: real controllers ignore the excess and a
   * library that sets a window one pixel too large is common and harmless.
   */
  setColumnRange(start: number, end: number): void {
    const limit = (this.access.exchange ? this.height : this.width) - 1;
    this.colStart = Math.min(Math.max(start, 0), limit);
    this.colEnd = Math.min(Math.max(end, this.colStart), limit);
    this.col = this.colStart;
  }

  setRowRange(start: number, end: number): void {
    const limit = (this.access.exchange ? this.width : this.height) - 1;
    this.rowStart = Math.min(Math.max(start, 0), limit);
    this.rowEnd = Math.min(Math.max(end, this.rowStart), limit);
    this.row = this.rowStart;
  }

  /** Puts the write cursor back at the top-left of the window, as RAMWR does. */
  rewind(): void {
    this.col = this.colStart;
    this.row = this.rowStart;
  }

  /**
   * Writes one pixel at the cursor and advances it across, then down.
   *
   * The cursor stops at the bottom of the window rather than wrapping to the
   * top: a controller given more pixels than the window holds discards the
   * excess, and wrapping would silently overwrite the top of what was just
   * drawn.
   */
  writePixel(value565: number): void {
    if (this.row > this.rowEnd) return;
    const { x, y } = this.toPanel(this.col, this.row);
    if (x >= 0 && y >= 0 && x < this.width && y < this.height) {
      const packed = this.access.bgr ? swapRedBlue(value565) : value565;
      const index = y * this.width + x;
      if (this.pixels[index] !== packed) {
        this.pixels[index] = packed;
        this.revision++;
      }
      this.written++;
    }
    this.col++;
    if (this.col > this.colEnd) {
      this.col = this.colStart;
      this.row++;
    }
  }

  /**
   * Addressed coordinates to panel coordinates.
   *
   * This is the whole of MADCTL: exchange swaps the axes, then each mirror
   * flips one of them. Applied on the way in rather than on the way out, so the
   * buffer always holds the panel as it looks and a renderer needs to know
   * nothing about rotation.
   */
  private toPanel(col: number, row: number): { x: number; y: number } {
    let x = this.access.exchange ? row : col;
    let y = this.access.exchange ? col : row;
    if (this.access.colMirror) x = this.width - 1 - x;
    if (this.access.rowMirror) y = this.height - 1 - y;
    return { x, y };
  }

  /** The colour at a panel coordinate, as 8-bit components. */
  pixel(x: number, y: number): { r: number; g: number; b: number } {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return { r: 0, g: 0, b: 0 };
    return unpack565(this.pixels[y * this.width + x]);
  }

  /** Raw RGB565 at a panel coordinate, for tests that care about the exact word. */
  raw(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.pixels[y * this.width + x];
  }

  /** How many pixels are not black — a cheap "did anything get drawn". */
  get nonBlackCount(): number {
    let n = 0;
    for (let i = 0; i < this.pixels.length; i++) if (this.pixels[i] !== 0) n++;
    return n;
  }

  fill(value565: number): void {
    this.pixels.fill(value565);
    this.revision++;
  }

  /**
   * RGBA bytes for a canvas, in panel order.
   *
   * The renderer's job is to put this on screen with one image draw rather than
   * one node per pixel — a 240x320 panel is 76,800 pixels, and a DOM node each
   * would make the editor unusable. Building the array here keeps the
   * conversion next to the format that produced it.
   */
  toRgba(out?: Uint8ClampedArray): Uint8ClampedArray {
    const buf = out ?? new Uint8ClampedArray(this.width * this.height * 4);
    for (let i = 0; i < this.pixels.length; i++) {
      const { r, g, b } = unpack565(this.pixels[i]);
      const o = i * 4;
      buf[o] = r;
      buf[o + 1] = g;
      buf[o + 2] = b;
      buf[o + 3] = 255;
    }
    return buf;
  }
}

/** Swaps the red and blue fields of an RGB565 word, which is what BGR mode does. */
export function swapRedBlue(value: number): number {
  return ((value & 0x1f) << 11) | (value & 0x07e0) | ((value >> 11) & 0x1f);
}
