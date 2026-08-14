// Shared display RAM for page-addressed monochrome controllers.
//
// The SSD1306, the SH1107 and their relatives all organise the panel the same
// way: one byte per column per page, bit n of that byte being the pixel eight
// rows down. What differs between them is the *command set* — which opcode sets
// the page, how many bits of column address there are, whether the addressing
// mode is a two-byte command or a single opcode. So the geometry, the cursor
// and the orientation live here, and each controller keeps its own decoder.
//
// Orientation is modelled rather than ignored, because it is the difference
// between a driver's output appearing upright and appearing mirrored. Segment
// remap, COM scan direction and the display start line are all applied when a
// pixel is read out, exactly as the silicon applies them on the way to the
// glass — the RAM itself always holds what firmware wrote, unrotated, which is
// what makes a write and a read-back agree.

export type AddressingMode = 'horizontal' | 'vertical' | 'page';

export class PagedMonoRam {
  readonly width: number;
  readonly height: number;
  readonly pages: number;
  /** One byte per column per page; bit n = row (page * 8 + n). */
  readonly ram: Uint8Array;

  /** Bumped on every RAM change so the canvas knows when to repaint. */
  revision = 0;
  /** Data bytes accepted since reset, for the inspector. */
  dataBytes = 0;

  addressingMode: AddressingMode = 'page';
  colStart = 0;
  colEnd: number;
  pageStart = 0;
  pageEnd: number;
  col = 0;
  page = 0;

  /** Column order reversed (SSD1306 0xA1 / SH1107 0xA1). */
  segmentRemap = false;
  /** Row order reversed (0xC8 rather than 0xC0). */
  comScanReverse = false;
  /** Which RAM row is shown at the top of the panel. */
  startLine = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pages = height / 8;
    this.ram = new Uint8Array(width * this.pages);
    this.colEnd = width - 1;
    this.pageEnd = this.pages - 1;
  }

  reset(): void {
    this.ram.fill(0);
    this.addressingMode = 'page';
    this.colStart = 0;
    this.colEnd = this.width - 1;
    this.pageStart = 0;
    this.pageEnd = this.pages - 1;
    this.col = 0;
    this.page = 0;
    this.segmentRemap = false;
    this.comScanReverse = false;
    this.startLine = 0;
    this.dataBytes = 0;
    this.revision++;
  }

  /**
   * Stores one data byte at the cursor and advances it.
   *
   * The advance rule is the addressing mode's, not a convenience: page mode
   * wraps within the row and never moves down, horizontal mode wraps to the
   * next page, and vertical mode walks down the page window first. Getting this
   * wrong is how a simulated panel shows a correct frame drawn in the wrong
   * order.
   */
  write(value: number): void {
    const index = this.page * this.width + this.col;
    if (index >= 0 && index < this.ram.length) {
      this.ram[index] = value & 0xff;
      this.revision++;
    }
    this.dataBytes++;
    if (this.addressingMode === 'vertical') {
      this.page++;
      if (this.page > this.pageEnd) {
        this.page = this.pageStart;
        this.col = this.col >= this.colEnd ? this.colStart : this.col + 1;
      }
    } else {
      this.col++;
      if (this.col > this.colEnd) {
        this.col = this.colStart;
        if (this.addressingMode === 'horizontal') {
          this.page = this.page >= this.pageEnd ? this.pageStart : this.page + 1;
        }
      }
    }
  }

  /**
   * The pixel at a panel coordinate, after orientation.
   *
   * Panel column x is driven by segment (width-1-x) when the segments are
   * remapped; panel row y is driven by COM (height-1-y) when the scan direction
   * is reversed; and the start line rotates which RAM row that COM reads.
   */
  pixel(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    const col = this.segmentRemap ? this.width - 1 - x : x;
    const com = this.comScanReverse ? this.height - 1 - y : y;
    const row = (com + this.startLine) % this.height;
    return ((this.ram[(row >> 3) * this.width + col] >> (row & 7)) & 1) === 1;
  }

  /** Lit pixels in RAM. Orientation cannot change the count, so it is not applied. */
  litCount(): number {
    let n = 0;
    for (let i = 0; i < this.ram.length; i++) {
      let b = this.ram[i];
      while (b) {
        n += b & 1;
        b >>= 1;
      }
    }
    return n;
  }

  /**
   * The frame as the panel shows it: one byte per column per page, ready for a
   * canvas that walks rows.
   *
   * Returns the RAM itself when no orientation is in force, so the common case
   * costs nothing; otherwise a re-mapped copy, because the canvas draws what
   * the glass shows and firmware reads back what it wrote.
   */
  orientedFrame(): Uint8Array {
    if (!this.segmentRemap && !this.comScanReverse && this.startLine === 0) return this.ram;
    const out = new Uint8Array(this.ram.length);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.pixel(x, y)) out[(y >> 3) * this.width + x] |= 1 << (y & 7);
      }
    }
    return out;
  }
}
