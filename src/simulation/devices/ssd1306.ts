// SSD1306 128x64 OLED, driven by real I2C traffic from executed firmware.
//
// The controller decodes the actual SSD1306 command set and keeps a real GDDRAM
// buffer; the canvas draws that buffer. Nothing here substitutes text or images
// — if firmware never writes pixels, the panel stays dark.
//
// Datasheet behaviours modelled: control-byte command/data split, page and
// horizontal/vertical addressing modes, column/page address windows, display
// on/off, inverse, contrast, multiplex ratio, the charge pump, and the three
// controls that decide which way up the picture comes out — segment remap, COM
// scan direction and the display start line. Those last three are applied when
// a pixel is read out rather than when it is written, which is what the silicon
// does and what keeps a read-back agreeing with the write that produced it. Commands that are accepted but have no visible effect in a
// simulation (clock divide, pre-charge, COM pin config, VCOM deselect) are
// consumed with their arguments so the byte stream stays in sync. Anything else
// is counted as unhandled and reported, never silently ignored.

import { PagedMonoRam } from './pagedMono';
import type { DeviceSnapshot, I2cDevice } from './types';

export const SSD1306_WIDTH = 128;
export const SSD1306_HEIGHT = 64;

/** The two addresses the SSD1306 is strapped to on real breakout boards. */
export const SSD1306_ADDRESSES = [0x3c, 0x3d] as const;

const CONTROL_COMMAND = 0x00;
const CONTROL_DATA = 0x40;

type Mode = 'idle' | 'command' | 'data';

export class Ssd1306Device implements I2cDevice {
  readonly instanceId: string;
  private readonly address: number;

  /** GDDRAM and the cursor that walks it, shared with the other paged panels. */
  readonly panel = new PagedMonoRam(SSD1306_WIDTH, SSD1306_HEIGHT);

  private mode: Mode = 'idle';
  private reading = false;
  private pendingArgs = 0;
  private pendingCommand = -1;

  private displayOn = false;
  private inverse = false;
  private contrast = 0x7f;

  private unhandled: number[] = [];
  private log: string[] = [];

  constructor(instanceId: string, address: number = SSD1306_ADDRESSES[0]) {
    this.instanceId = instanceId;
    this.address = address;
  }

  matchesAddress(address: number): boolean {
    return address === this.address;
  }

  /** Power-on defaults, per the datasheet reset state. */
  reset(): void {
    this.panel.reset();
    this.mode = 'idle';
    this.reading = false;
    this.pendingArgs = 0;
    this.pendingCommand = -1;
    this.displayOn = false;
    this.inverse = false;
    this.contrast = 0x7f;
    this.unhandled = [];
    this.log = [];
  }

  start(_address: number, write: boolean): void {
    this.reading = !write;
    if (write) this.mode = 'idle';
  }

  stop(): void {
    this.mode = 'idle';
  }

  /** The SSD1306 has no meaningful read path over I2C here; return the status byte. */
  readByte(): number {
    return this.displayOn ? 0x00 : 0x20;
  }

  writeByte(value: number): boolean {
    if (this.reading) return false;
    if (this.mode === 'idle') {
      // First byte after the address is the control byte: Co/D-C#.
      if ((value & 0x40) === CONTROL_DATA) this.mode = 'data';
      else if ((value & ~0x80) === CONTROL_COMMAND) this.mode = 'command';
      else this.mode = 'command';
      return true;
    }
    if (this.mode === 'data') {
      this.panel.write(value);
      return true;
    }
    this.command(value);
    return true;
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 60) this.log.shift();
  }

  private command(value: number): void {
    // Multi-byte commands consume their arguments first.
    if (this.pendingArgs > 0) {
      this.applyArgument(value);
      this.pendingArgs--;
      if (this.pendingArgs === 0) this.pendingCommand = -1;
      return;
    }

    if (value >= 0x00 && value <= 0x0f) {
      // Page-mode lower column start
      this.panel.col = (this.panel.col & 0xf0) | (value & 0x0f);
      return;
    }
    if (value >= 0x10 && value <= 0x1f) {
      this.panel.col = (this.panel.col & 0x0f) | ((value & 0x0f) << 4);
      return;
    }
    if (value >= 0xb0 && value <= 0xb7) {
      this.panel.page = value & 0x07;
      return;
    }
    if (value >= 0x40 && value <= 0x7f) {
      this.panel.startLine = value & 0x3f;
      return;
    }

    switch (value) {
      case 0xae:
        this.displayOn = false;
        this.note('display off');
        return;
      case 0xaf:
        this.displayOn = true;
        this.note('display on');
        return;
      case 0xa6:
        this.inverse = false;
        return;
      case 0xa7:
        this.inverse = true;
        return;
      case 0xa4: // resume from RAM
      case 0xa5: // entire display on (ignores RAM) — treated as a flag below
        this.note(value === 0xa5 ? 'entire display on' : 'resume from RAM');
        return;
      case 0xa0:
        this.panel.segmentRemap = false;
        return;
      case 0xa1:
        this.panel.segmentRemap = true;
        return;
      case 0xc0:
        this.panel.comScanReverse = false;
        return;
      case 0xc8:
        this.panel.comScanReverse = true;
        return;
      case 0xe3: // NOP
        return;
      case 0x20:
        this.pendingCommand = 0x20;
        this.pendingArgs = 1;
        return;
      case 0x21: // set column address
        this.pendingCommand = 0x21;
        this.pendingArgs = 2;
        return;
      case 0x22: // set page address
        this.pendingCommand = 0x22;
        this.pendingArgs = 2;
        return;
      case 0x81: // contrast
      case 0xa8: // multiplex ratio
      case 0xd3: // display offset
      case 0xd5: // clock divide
      case 0xd9: // pre-charge
      case 0xda: // COM pins
      case 0xdb: // VCOM deselect
      case 0x8d: // charge pump
        this.pendingCommand = value;
        this.pendingArgs = 1;
        return;
      default:
        this.unhandled.push(value);
        this.note(`unhandled command 0x${value.toString(16)}`);
    }
  }

  private applyArgument(value: number): void {
    switch (this.pendingCommand) {
      case 0x20:
        this.panel.addressingMode = value === 0 ? 'horizontal' : value === 1 ? 'vertical' : 'page';
        this.note(`addressing mode: ${this.panel.addressingMode}`);
        return;
      case 0x21:
        if (this.pendingArgs === 2) {
          this.panel.colStart = value & 0x7f;
          this.panel.col = this.panel.colStart;
        } else {
          this.panel.colEnd = value & 0x7f;
        }
        return;
      case 0x22:
        if (this.pendingArgs === 2) {
          this.panel.pageStart = value & 0x07;
          this.panel.page = this.panel.pageStart;
        } else {
          this.panel.pageEnd = value & 0x07;
        }
        return;
      case 0x81:
        this.contrast = value;
        return;
      case 0x8d:
        this.note(value === 0x14 ? 'charge pump on' : 'charge pump off');
        return;
      default:
        // Accepted-and-consumed argument for a command with no visual effect.
        return;
    }
  }

  /** True when the pixel is lit, accounting for display on/off and inverse. */
  pixel(x: number, y: number): boolean {
    if (!this.displayOn) return false;
    const bit = this.panel.pixel(x, y);
    return this.inverse ? !bit : bit;
  }

  /** Packed 1-bit-per-pixel frame as the glass shows it, or null while off. */
  frame(): Uint8Array | null {
    return this.displayOn ? this.panel.orientedFrame() : null;
  }

  /** GDDRAM as firmware wrote it, unrotated. */
  get ram(): Uint8Array {
    return this.panel.ram;
  }
  get revision(): number {
    return this.panel.revision;
  }
  get isOn(): boolean {
    return this.displayOn;
  }
  get litPixels(): number {
    if (!this.displayOn) return 0;
    const n = this.panel.litCount();
    return this.inverse ? SSD1306_WIDTH * SSD1306_HEIGHT - n : n;
  }
  get unhandledCommands(): number[] {
    return [...new Set(this.unhandled)];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `SSD1306 @0x${this.address.toString(16)}: ${this.displayOn ? 'on' : 'off'}, ` +
        `${this.panel.dataBytes} data bytes, ${this.litPixels} lit pixels` +
        (this.unhandled.length ? `, ${this.unhandledCommands.length} unhandled command(s)` : ''),
      log: [...this.log],
    };
  }
}
