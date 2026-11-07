// 74HC595 8-bit serial-in / parallel-out shift register.
//
// This part is NOT an SPI peripheral — it has no chip select. It shifts on
// every SRCLK rising edge, so when its SRCLK is wired to the board's SCK it
// consumes every byte the SPI controller clocks out, including traffic meant
// for some other device on the same bus. That is exactly what happens on a
// breadboard, and the reason real designs rely on the latch: the outputs only
// change when RCLK rises, so bytes shifted for another chip pass through
// harmlessly as long as RCLK stays still.
//
// Modelled from the datasheet:
//   • SER    serial data, sampled on the SRCLK rising edge
//   • SRCLK  shift clock (supplied 8 edges at a time by an SPI byte)
//   • RCLK   storage-register clock: rising edge copies shift → storage
//   • OE     active-low output enable; high puts Q0-Q7 in high-impedance
//   • SRCLR  active-low shift-register clear (does NOT clear the storage
//            register — only a following RCLK rising edge makes that visible)
//   • QH'    serial overflow out, for daisy-chaining
//
// Q0-Q7 drive real net voltages through the AnalogDevice interface, so an LED
// wired to an output responds to bits the firmware genuinely shifted.

import type { AnalogDevice, DeviceSnapshot, SpiDevice, SpiMode } from './types';

/** Output pin ids in bit order: QA..QH (datasheet) = Q0..Q7 (common usage). */
export const HC595_OUTPUT_PINS = ['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'] as const;

/**
 * The shift register samples SER on the rising edge of SRCLK. Modes 0 and 3
 * both clock data out on the falling edge and are the two an SPI master can
 * use to feed it; modes 1 and 2 move the data edge and are a genuine wiring
 * mistake rather than something the part tolerates.
 */
const SUPPORTED_MODES: readonly SpiMode[] = [0, 3];

export class Sn74hc595Device implements SpiDevice, AnalogDevice {
  readonly instanceId: string;
  /** No chip select — see the file header. */
  readonly csPinId = null;
  readonly supportedModes = SUPPORTED_MODES;

  /** Voltage the device's own VCC rail sits at, used for output high level. */
  private readonly logicVolts: number;

  /** Internal shift register, MSB = the bit that reaches QH first. */
  private shift = 0;
  /** Storage (output) register — only RCLK moves shift into here. */
  private storage = 0;
  private outputEnabled = true;
  private bytesShifted = 0;
  private latches = 0;
  private log: string[] = [];

  constructor(instanceId: string, logicVolts = 5) {
    this.instanceId = instanceId;
    this.logicVolts = logicVolts;
  }

  /** Bits currently presented on Q0-Q7, or null while the outputs are Hi-Z. */
  get outputs(): number | null {
    return this.outputEnabled ? this.storage : null;
  }

  get shiftRegister(): number {
    return this.shift;
  }

  get latchCount(): number {
    return this.latches;
  }

  /** True when Qn is driven high. Hi-Z and low both read false. */
  outputHigh(bit: number): boolean {
    return this.outputEnabled && (this.storage & (1 << bit)) !== 0;
  }

  // ---- bus-facing ----

  select(): void {
    /* no chip select on this part */
  }

  /** Eight SRCLK edges' worth of SER data. Returns null: no MISO driver. */
  transfer(mosi: number): number | null {
    // First bit on the wire is the MSB, and it ends up furthest along the
    // register, so a whole byte simply becomes the low 8 bits.
    this.shift = mosi & 0xff;
    this.bytesShifted++;
    return null;
  }

  // ---- control pins, driven from real GPIO levels ----

  /** RCLK rising edge: publish the shift register on the outputs. */
  latch(): void {
    this.storage = this.shift;
    this.latches++;
    this.note(`latch 0b${this.storage.toString(2).padStart(8, '0')}`);
  }

  /** OE is active low: a high level puts every output into high impedance. */
  setOutputEnable(oeLow: boolean): void {
    if (this.outputEnabled === oeLow) return;
    this.outputEnabled = oeLow;
    this.note(oeLow ? 'outputs enabled' : 'outputs high-Z (OE high)');
  }

  /**
   * SRCLR is active low and clears the SHIFT register only. The outputs keep
   * their last latched value until the next RCLK rising edge, which is a
   * detail sketches routinely get wrong on real hardware too.
   */
  clearShiftRegister(): void {
    if (this.shift === 0) return;
    this.shift = 0;
    this.note('shift register cleared (SRCLR low)');
  }

  // ---- net-facing ----

  /** Volts this device drives onto one of its output pins, or null for Hi-Z. */
  analogOut(pinId: string): number | null {
    const bit = HC595_OUTPUT_PINS.indexOf(pinId as (typeof HC595_OUTPUT_PINS)[number]);
    if (bit < 0) return null;
    if (!this.outputEnabled) return null; // high impedance drives nothing
    return this.storage & (1 << bit) ? this.logicVolts : 0;
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 40) this.log.shift();
  }

  reset(): void {
    this.shift = 0;
    this.storage = 0;
    this.outputEnabled = true;
    this.bytesShifted = 0;
    this.latches = 0;
    this.log = [];
  }

  snapshot(): DeviceSnapshot {
    const bits = this.storage.toString(2).padStart(8, '0');
    return {
      status: this.outputEnabled
        ? `74HC595: Q7..Q0 = ${bits}, ${this.bytesShifted} byte(s) shifted, ${this.latches} latch(es)`
        : `74HC595: outputs high-Z (OE high), storage ${bits}`,
      log: [...this.log],
    };
  }
}
