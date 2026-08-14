// Nokia 5110 / PCD8544 — 84x48 monochrome LCD over a serial interface.
//
// Not I2C and not really SPI either: the part has a clock and a data line and
// no MISO at all, so it is driven as a write-only SPI target with a D/C line
// deciding whether the byte is a command or a byte of display RAM. It shares
// the paged layout the OLEDs use — one byte per column per bank, bit n being
// the pixel eight rows down — which is why the RAM comes from the same
// primitive rather than a second copy of the same idea.
//
// What is genuinely its own is the command set, and in particular the thing
// that catches everybody: the function-set byte has a PD bit and an H bit, and
// half the commands only exist while H is 1. Send the contrast command without
// setting H first and the part reads it as something else entirely — which is
// why a driver that forgets it produces a blank or a black screen. That is
// modelled, so it produces the same result here.
//
// NOT modelled: contrast (Vop) as actual darkness, temperature coefficient,
// bias as multiplex ratio, and power-down current. Each is accepted, stored and
// reported rather than silently dropped.

import { PagedMonoRam } from './pagedMono';
import type { ControlPinReader, DeviceSnapshot, SpiDevice, SpiMode } from './types';

export const PCD8544_WIDTH = 84;
export const PCD8544_HEIGHT = 48;

export class Pcd8544Device implements SpiDevice {
  readonly instanceId: string;
  readonly csPinId: string | null;
  /** Clocked on the rising edge with an idle-low clock. */
  readonly supportedModes: readonly SpiMode[] = [0];

  readonly panel = new PagedMonoRam(PCD8544_WIDTH, PCD8544_HEIGHT);

  private readControl: ControlPinReader = () => undefined;

  /** H bit of the function set: 0 = basic instruction set, 1 = extended. */
  private extended = false;
  private powerDown = false;
  /** Display control: blank, normal, all-on, or inverse. */
  private mode: 'blank' | 'normal' | 'all-on' | 'inverse' = 'blank';
  private vop = 0;
  private bias = 4;
  private tempCoefficient = 0;
  private verticalAddressing = false;

  private lastResetLevel: boolean | undefined;
  private unknown: number[] = [];
  private log: string[] = [];

  constructor(instanceId: string, csPinId: string | null) {
    this.instanceId = instanceId;
    this.csPinId = csPinId;
  }

  attachControls(read: ControlPinReader): void {
    this.readControl = read;
  }

  /** Samples RESET, which clears the controller on a low level. */
  settle(): void {
    const level = this.readControl('rst');
    if (level === undefined) return;
    if (this.lastResetLevel === true && level === false) {
      this.hardReset();
      this.note('hardware reset');
    }
    this.lastResetLevel = level;
  }

  select(_active: boolean): void {
    /* Nothing latches on the chip select: each byte stands alone. */
  }

  transfer(mosi: number): number | null {
    const byte = mosi & 0xff;
    // D/C high means display data. Unwired reads as command mode, so a part
    // whose D/C goes nowhere never shows pixels — which is the honest outcome.
    if (this.readControl('dc') === true) this.panel.write(byte);
    else this.command(byte);
    // The PCD8544 has no data output pin at all.
    return null;
  }

  private command(value: number): void {
    // Function set is available in either instruction set.
    if ((value & 0xf8) === 0x20) {
      this.powerDown = (value & 0x04) !== 0;
      this.verticalAddressing = (value & 0x02) !== 0;
      this.extended = (value & 0x01) !== 0;
      this.panel.addressingMode = this.verticalAddressing ? 'vertical' : 'horizontal';
      this.note(`function set: ${this.extended ? 'extended' : 'basic'}${this.powerDown ? ', power down' : ''}`);
      return;
    }

    if (this.extended) {
      // Extended set. These opcodes mean something else with H=0, which is the
      // whole reason the bit is modelled.
      if ((value & 0x80) === 0x80) {
        this.vop = value & 0x7f;
        return;
      }
      if ((value & 0xf8) === 0x10) {
        this.bias = value & 0x07;
        return;
      }
      if ((value & 0xfc) === 0x04) {
        this.tempCoefficient = value & 0x03;
        return;
      }
      this.unknown.push(value);
      this.note(`unhandled extended command 0x${value.toString(16)}`);
      return;
    }

    // Basic set.
    if ((value & 0xf8) === 0x08) {
      const d = (value & 0x04) !== 0;
      const e = (value & 0x01) !== 0;
      this.mode = d ? (e ? 'inverse' : 'normal') : e ? 'all-on' : 'blank';
      this.note(`display ${this.mode}`);
      return;
    }
    if ((value & 0xf8) === 0x40) {
      this.panel.page = value & 0x07;
      return;
    }
    if ((value & 0x80) === 0x80) {
      this.panel.col = value & 0x7f;
      return;
    }
    this.unknown.push(value);
    this.note(`unhandled command 0x${value.toString(16)}`);
  }

  private hardReset(): void {
    this.panel.reset();
    this.extended = false;
    this.powerDown = false;
    this.mode = 'blank';
    this.vop = 0;
    this.bias = 4;
    this.tempCoefficient = 0;
    this.verticalAddressing = false;
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  // ---- inspection ----

  /** True when the pixel is dark on the glass (this LCD lights its background). */
  pixel(x: number, y: number): boolean {
    if (this.powerDown || this.mode === 'blank') return false;
    if (this.mode === 'all-on') return true;
    const bit = this.panel.pixel(x, y);
    return this.mode === 'inverse' ? !bit : bit;
  }

  /** Packed frame for the canvas, or null while the panel shows nothing. */
  frame(): Uint8Array | null {
    if (this.powerDown || this.mode === 'blank') return null;
    return this.panel.orientedFrame();
  }

  get isOn(): boolean {
    return !this.powerDown && this.mode !== 'blank';
  }
  get isExtendedSet(): boolean {
    return this.extended;
  }
  get displayMode(): string {
    return this.mode;
  }
  get contrast(): number {
    return this.vop;
  }
  get biasSystem(): number {
    return this.bias;
  }
  get temperatureCoefficient(): number {
    return this.tempCoefficient;
  }
  get revision(): number {
    return this.panel.revision;
  }
  get litPixels(): number {
    if (!this.isOn) return 0;
    if (this.mode === 'all-on') return PCD8544_WIDTH * PCD8544_HEIGHT;
    const n = this.panel.litCount();
    return this.mode === 'inverse' ? PCD8544_WIDTH * PCD8544_HEIGHT - n : n;
  }
  get unhandledCommands(): number[] {
    return [...new Set(this.unknown)];
  }

  reset(): void {
    this.hardReset();
    this.unknown = [];
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `PCD8544 84x48 — ${this.powerDown ? 'powered down' : this.mode}, ` +
        `${this.panel.dataBytes} data byte(s), ${this.litPixels} lit` +
        (this.unknown.length ? `, ${this.unhandledCommands.length} unhandled command(s)` : ''),
      log: [...this.log],
    };
  }
}
