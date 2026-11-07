// MCP3008 — 8-channel 10-bit SPI ADC.
//
// Same principle as the ADS1115 and a completely different protocol. There is
// no register map at all: the controller clocks in a start bit, a mode bit and
// three channel bits, and the part clocks out a null bit followed by ten data
// bits, MSB first. Everything about which channel is read and how the answer is
// framed lives in the bit positions of a three-byte transfer.
//
// Getting those positions right is the point. The usual sketch sends
// {0x01, (8 + channel) << 4, 0x00} and takes ((r[1] & 3) << 8) | r[2], and a
// model that answered with the right number in the wrong bits would produce
// readings that are plausible, wrong, and very hard to explain.
//
// The reference is real too: the result is the input scaled against VREF, so a
// part running on 3.3 V and one on 5 V give different counts for the same input
// voltage — which is the second most common source of confusion with these.
//
// NOT modelled: differential mode (the mode bit is decoded and a differential
// request is answered from the pair's difference, but the input-range rules of
// a real differential conversion are not), conversion time, and input
// impedance.

import type { ControlPinReader, DeviceSnapshot, SpiDevice, SpiMode } from './types';

export const MCP3008_CHANNELS = 8;

export class Mcp3008Device implements SpiDevice {
  readonly instanceId: string;
  readonly csPinId: string | null;
  /** The datasheet gives modes 0,0 and 1,1. */
  readonly supportedModes: readonly SpiMode[] = [0, 3];

  /** Volts on each channel, or null when the pin reaches nothing. */
  private inputs: (number | null)[] = new Array(MCP3008_CHANNELS).fill(null);
  /** Reference voltage, from the VREF pin. */
  private vref = 5;

  private selected = false;
  /** Bytes received since CS fell. */
  private phase = 0;
  private channel = 0;
  private differential = false;
  private result = 0;

  private conversions = 0;
  private unwiredReads = 0;
  private log: string[] = [];

  constructor(instanceId: string, csPinId: string | null) {
    this.instanceId = instanceId;
    this.csPinId = csPinId;
  }

  attachControls(_read: ControlPinReader): void {
    /* No control pins beyond the bus; VREF arrives through setReference. */
  }

  /** The binding supplies real net voltages; null means unwired. */
  setInputVolts(channel: number, volts: number | null): void {
    if (channel < 0 || channel >= MCP3008_CHANNELS) return;
    this.inputs[channel] = volts;
  }

  /** VREF from the wire. A part fed 3.3 V scales to 3.3 V, not to 5. */
  setReference(volts: number | null): void {
    if (volts !== null && volts > 0) this.vref = volts;
  }

  select(active: boolean): void {
    if (active === this.selected) return;
    this.selected = active;
    // A conversion is one CS-low transaction. Dropping CS mid-transfer abandons
    // it, exactly as the part does.
    this.phase = 0;
  }

  transfer(mosi: number): number | null {
    const byte = mosi & 0xff;
    const out = this.respond(this.phase, byte);
    this.phase++;
    return out;
  }

  /**
   * One byte of the three-byte transaction.
   *
   * Byte 0 carries the start bit and is answered with nothing meaningful.
   * Byte 1 carries the mode and channel in its top bits, and is answered with
   * the null bit and the top two data bits. Byte 2 is padding, answered with
   * the low eight bits.
   */
  private respond(phase: number, byte: number): number {
    if (phase === 0) {
      // The start bit. Anything without it is not a conversion request.
      if ((byte & 0x01) === 0) this.note(`transfer with no start bit (0x${byte.toString(16)})`);
      return 0;
    }
    if (phase === 1) {
      this.differential = (byte & 0x80) === 0;
      this.channel = (byte >> 4) & 0x07;
      this.result = this.convert();
      return (this.result >> 8) & 0x03;
    }
    if (phase === 2) return this.result & 0xff;
    // Beyond three bytes the part outputs nothing useful.
    return 0;
  }

  private convert(): number {
    this.conversions++;
    const volts = this.differential ? this.differentialVolts() : this.inputs[this.channel];
    if (volts === null) {
      // Unwired is not grounded. Counted so the inspector can say so rather
      // than a confident zero appearing in the sketch.
      this.unwiredReads++;
      return 0;
    }
    const counts = Math.round((volts / this.vref) * 1023);
    return Math.min(1023, Math.max(0, counts));
  }

  /** Differential pairs are (0,1), (2,3), (4,5), (6,7) by channel-select bits. */
  private differentialVolts(): number | null {
    const pair = this.channel >> 1;
    const inverted = (this.channel & 1) === 1;
    const a = this.inputs[pair * 2];
    const b = this.inputs[pair * 2 + 1];
    if (a === null || b === null) return null;
    return inverted ? b - a : a - b;
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  // ---- inspection ----

  get lastChannel(): number {
    return this.channel;
  }
  get lastResult(): number {
    return this.result;
  }
  get reference(): number {
    return this.vref;
  }
  get conversionCount(): number {
    return this.conversions;
  }
  get unwiredReadCount(): number {
    return this.unwiredReads;
  }

  reset(): void {
    this.phase = 0;
    this.channel = 0;
    this.result = 0;
    this.conversions = 0;
    this.unwiredReads = 0;
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `MCP3008: VREF ${this.vref.toFixed(2)} V, last CH${this.channel} = ${this.result}` +
        (this.unwiredReads ? `, ${this.unwiredReads} read(s) of an unwired channel` : ''),
      log: [...this.log],
    };
  }
}
