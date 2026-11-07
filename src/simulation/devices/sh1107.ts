// SH1107 128×128 OLED controller, driven by real I2C traffic.
//
// Close enough to an SSD1306 to be mistaken for one and different enough that
// treating it as one produces a blank panel. The differences that matter:
//
//   • 128 rows, so sixteen pages, and the page opcode carries four bits
//     (0xB0-0xBF) rather than three;
//   • the column address is split 0x00-0x0F / 0x10-0x17, seven bits in total;
//   • the memory addressing mode is a *single* opcode — 0x20 page, 0x21
//     vertical — where the SSD1306 takes 0x20 followed by an argument byte.
//     A decoder that assumed the SSD1306 form would swallow the next command
//     as an argument and lose it;
//   • the display start line is 0xDC + argument, not 0x40 | line;
//   • there is no charge pump command; the DC-DC converter is 0xAD + argument.
//
// So this is its own decoder over the shared paged RAM. As everywhere else in
// this folder, an unknown opcode is counted and reported rather than ignored,
// and a panel firmware never wrote to stays dark.
//
// NOT modelled: contrast as actual brightness, the multiplex ratio's effect on
// which rows are scanned, and read-modify-write mode (0xE0/0xEE) — the last is
// recorded as unhandled rather than half-implemented.

import { PagedMonoRam } from './pagedMono';
import type { DeviceSnapshot, I2cDevice } from './types';

export const SH1107_WIDTH = 128;
export const SH1107_HEIGHT = 128;

/** The two addresses SH1107 breakouts are strapped to. */
export const SH1107_ADDRESSES = [0x3c, 0x3d] as const;

const CONTROL_DATA = 0x40;

type Mode = 'idle' | 'command' | 'data';

export class Sh1107Device implements I2cDevice {
  readonly instanceId: string;
  private readonly address: number;

  readonly panel = new PagedMonoRam(SH1107_WIDTH, SH1107_HEIGHT);

  private mode: Mode = 'idle';
  private reading = false;
  private pendingCommand = -1;

  private displayOn = false;
  private inverse = false;
  private allOn = false;
  private contrast = 0x80;
  private log: string[] = [];
  private unhandled: number[] = [];

  constructor(instanceId: string, address: number = SH1107_ADDRESSES[0]) {
    this.instanceId = instanceId;
    this.address = address;
  }

  matchesAddress(address: number): boolean {
    return address === this.address;
  }

  reset(): void {
    this.panel.reset();
    this.mode = 'idle';
    this.reading = false;
    this.pendingCommand = -1;
    this.displayOn = false;
    this.inverse = false;
    this.allOn = false;
    this.contrast = 0x80;
    this.log = [];
    this.unhandled = [];
  }

  start(_address: number, write: boolean): void {
    this.reading = !write;
    if (write) this.mode = 'idle';
  }

  stop(): void {
    this.mode = 'idle';
  }

  /** Status byte: bit 6 is BUSY (never busy here), bit 5 is display-off. */
  readByte(): number {
    return this.displayOn ? 0x00 : 0x20;
  }

  writeByte(value: number): boolean {
    if (this.reading) return false;
    if (this.mode === 'idle') {
      this.mode = (value & CONTROL_DATA) === CONTROL_DATA ? 'data' : 'command';
      return true;
    }
    if (this.mode === 'data') {
      this.panel.write(value);
      return true;
    }
    this.command(value & 0xff);
    return true;
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 60) this.log.shift();
  }

  private command(value: number): void {
    if (this.pendingCommand >= 0) {
      this.applyArgument(value);
      this.pendingCommand = -1;
      return;
    }

    // Column address, low nibble then high. Seven bits for 128 columns.
    if (value <= 0x0f) {
      this.panel.col = (this.panel.col & 0x70) | value;
      return;
    }
    if (value >= 0x10 && value <= 0x17) {
      this.panel.col = (this.panel.col & 0x0f) | ((value & 0x07) << 4);
      return;
    }
    // Page address: four bits, sixteen pages.
    if (value >= 0xb0 && value <= 0xbf) {
      this.panel.page = value & 0x0f;
      return;
    }

    switch (value) {
      case 0x20:
        this.panel.addressingMode = 'page';
        this.note('page addressing');
        return;
      case 0x21:
        this.panel.addressingMode = 'vertical';
        this.note('vertical addressing');
        return;
      case 0xa0:
        this.panel.segmentRemap = false;
        return;
      case 0xa1:
        this.panel.segmentRemap = true;
        this.note('segment remap');
        return;
      case 0xa4:
        this.allOn = false;
        return;
      case 0xa5:
        this.allOn = true;
        this.note('entire display on');
        return;
      case 0xa6:
        this.inverse = false;
        return;
      case 0xa7:
        this.inverse = true;
        this.note('inverse');
        return;
      case 0xae:
        this.displayOn = false;
        this.note('display off');
        return;
      case 0xaf:
        this.displayOn = true;
        this.note('display on');
        return;
      case 0xc0:
        this.panel.comScanReverse = false;
        return;
      case 0xc8:
        this.panel.comScanReverse = true;
        this.note('COM scan reversed');
        return;
      case 0xe3: // NOP
        return;
      // Commands that take one argument. Consumed so the byte stream stays in
      // step even where the argument has no visible effect here.
      case 0x81: // contrast
      case 0xa8: // multiplex ratio
      case 0xad: // DC-DC control
      case 0xd3: // display offset
      case 0xd5: // clock divide
      case 0xd9: // pre-charge
      case 0xdb: // VCOM deselect
      case 0xdc: // display start line
        this.pendingCommand = value;
        return;
      default:
        this.unhandled.push(value);
        this.note(`unhandled command 0x${value.toString(16)}`);
    }
  }

  private applyArgument(value: number): void {
    switch (this.pendingCommand) {
      case 0x81:
        this.contrast = value;
        return;
      case 0xdc:
        this.panel.startLine = value & 0x7f;
        this.note(`start line ${this.panel.startLine}`);
        return;
      case 0xad:
        this.note(value & 0x01 ? 'DC-DC on' : 'DC-DC off');
        return;
      default:
        // Accepted and consumed; no visible effect in simulation.
        return;
    }
  }

  /** True when the pixel is lit, accounting for display on/off, all-on and inverse. */
  pixel(x: number, y: number): boolean {
    if (!this.displayOn) return false;
    if (this.allOn) return true;
    const bit = this.panel.pixel(x, y);
    return this.inverse ? !bit : bit;
  }

  /** Packed 1-bit-per-pixel frame as the glass shows it, or null while off. */
  frame(): Uint8Array | null {
    return this.displayOn ? this.panel.orientedFrame() : null;
  }

  get isOn(): boolean {
    return this.displayOn;
  }
  get revision(): number {
    return this.panel.revision;
  }
  get litPixels(): number {
    if (!this.displayOn) return 0;
    if (this.allOn) return SH1107_WIDTH * SH1107_HEIGHT;
    const n = this.panel.litCount();
    return this.inverse ? SH1107_WIDTH * SH1107_HEIGHT - n : n;
  }
  get unhandledCommands(): number[] {
    return [...new Set(this.unhandled)];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `SH1107 @0x${this.address.toString(16)}: ${this.displayOn ? 'on' : 'off'}, ` +
        `${this.panel.dataBytes} data bytes, ${this.litPixels} lit pixels` +
        (this.unhandled.length ? `, ${this.unhandledCommands.length} unhandled command(s)` : ''),
      log: [...this.log],
    };
  }
}
