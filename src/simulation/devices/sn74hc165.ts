// 74HC165 8-bit parallel-in / serial-out shift register.
//
// The mirror image of the 74HC595, and the first device here that drives MISO
// from a plain logic part rather than a peripheral with a command set. Wire its
// QH to the board's MISO and its CP to SCK, and SPI.transfer(0) clocks eight
// bits out of it.
//
// Datasheet behaviour that is modelled because sketches depend on it:
//
//   • PL (parallel load, active low) is asynchronous — while PL is low the
//     register tracks the D0-D7 inputs continuously, and the value is captured
//     the moment PL returns high. A sketch that never pulses PL reads whatever
//     was last captured, not the current inputs.
//   • Data shifts out MSB first (QH carries D7), so the first bit on the wire
//     is the highest input.
//   • CE (clock enable, active low) gates the clock: held high, the register
//     does not shift at all.
//
// The parallel inputs are read from real net voltages, so buttons or sensors
// wired to D0-D7 are what firmware actually sees.

import type { DeviceSnapshot, SpiDevice, SpiMode } from './types';

/** Parallel input pin ids, D0 (LSB) through D7 (MSB / first out). */
export const HC165_INPUT_PINS = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'] as const;

/** Shifts on the rising clock edge, so modes 0 and 3 are the usable pair. */
const SUPPORTED_MODES: readonly SpiMode[] = [0, 3];

export class Sn74hc165Device implements SpiDevice {
  readonly instanceId: string;
  /** No chip select: it shifts whenever the clock runs and CE is low. */
  readonly csPinId = null;
  readonly supportedModes = SUPPORTED_MODES;

  /** Levels currently present on D0-D7, updated from net voltages each frame. */
  private inputs = 0;
  /** The captured shift register, which is what actually clocks out. */
  private shift = 0;
  private loadLow = false;
  private clockEnabled = true;
  private bytesShifted = 0;
  private captures = 0;
  private log: string[] = [];

  constructor(instanceId: string) {
    this.instanceId = instanceId;
  }

  // ---- pin-facing ----

  /** Sets the parallel inputs from the real net levels behind D0-D7. */
  setInputs(value: number): void {
    this.inputs = value & 0xff;
    // While PL is held low the register follows the inputs continuously.
    if (this.loadLow) this.shift = this.inputs;
  }

  /**
   * PL is active low and asynchronous. Data is captured on the low level and
   * frozen when it goes high again.
   */
  setParallelLoad(low: boolean): void {
    if (low === this.loadLow) return;
    this.loadLow = low;
    if (low) {
      this.shift = this.inputs;
    } else {
      this.captures++;
      this.note(`captured 0b${this.shift.toString(2).padStart(8, '0')}`);
    }
  }

  /** CE is active low; a high level stops the register shifting. */
  setClockEnable(low: boolean): void {
    this.clockEnabled = low;
  }

  // ---- bus-facing ----

  select(): void {
    /* no chip select on this part */
  }

  /**
   * Eight clock edges. QH presents the MSB first, and each edge moves the
   * register up, pulling in whatever DS is tied to (0 when unwired).
   */
  transfer(_mosi: number): number | null {
    if (!this.clockEnabled) return null; // clock inhibited: QH stays put
    const out = this.shift & 0xff;
    // Eight shifts leaves the register empty unless DS feeds it.
    this.shift = 0;
    this.bytesShifted++;
    return out;
  }

  // ---- inspection ----

  get parallelInputs(): number {
    return this.inputs;
  }

  get shiftRegister(): number {
    return this.shift;
  }

  get captureCount(): number {
    return this.captures;
  }

  get isLoading(): boolean {
    return this.loadLow;
  }

  get isClockEnabled(): boolean {
    return this.clockEnabled;
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  reset(): void {
    this.inputs = 0;
    this.shift = 0;
    this.loadLow = false;
    this.clockEnabled = true;
    this.bytesShifted = 0;
    this.captures = 0;
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    return {
      status:
        `74HC165: inputs 0b${this.inputs.toString(2).padStart(8, '0')}, ` +
        `${this.captures} capture(s), ${this.bytesShifted} byte(s) shifted out` +
        (this.clockEnabled ? '' : ', clock inhibited (CE high)'),
      log: [...this.log],
    };
  }
}
