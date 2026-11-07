// GP-SPI2, the general-purpose SPI master of the ESP32-C3 and ESP32-C6 —
// Arduino's SPI.
//
// Arduino-ESP32's SPI.transfer() fills the data buffer (W0-W15), sets the
// length in MS_DLEN, pulses CMD.UPDATE to latch the configuration, sets
// CMD.USR and spins until the controller clears it, then reads the received
// bits back out of the same buffer. Unmodelled, USR cleared at once (the
// register read as zero) and every transfer "received" the zeros it never
// sent, with no device seeing a byte.
//
// Here USR runs the transaction: each byte of the buffer goes out on the
// shared SPI device bus — the same models every other board drives — in the
// mode and bit order the registers set, and what the selected device answers
// replaces it, full duplex. The transfer completes at once (TRANS_DONE is
// raised); chip select is the firmware's own GPIO, as with Arduino's SPI.
// Register positions are from each chip's spi_reg.h; the two differ only in
// the base address and the width of the bit-order fields.

import type { Peripheral } from './peripheral';
import type { SpiMode } from '../devices/types';

export interface Spi2Layout {
  base: number;
  /** CTRL.RD_BIT_ORDER and CTRL.WR_BIT_ORDER positions; bit 0 of each field set means LSB first. */
  rdBitOrderShift: number;
  wrBitOrderShift: number;
}

export const ESP32C3_SPI2: Spi2Layout = { base: 0x60024000, rdBitOrderShift: 25, wrBitOrderShift: 26 };
export const ESP32C6_SPI2: Spi2Layout = { base: 0x60081000, rdBitOrderShift: 23, wrBitOrderShift: 25 };

/** Matrix signals of the SPI2 pins (FSPICLK, FSPID = MOSI, FSPIQ = MISO, FSPICS0), the same on both chips. */
export const FSPI_SIGNALS = { clk: 63, miso: 64, mosi: 65, cs0: 68 } as const;

const CMD = 0x00;
const CTRL = 0x08;
const USER = 0x10;
const MS_DLEN = 0x1c;
const MISC = 0x20;
const DMA_INT_RAW = 0x3c;
const W0 = 0x98;
const WORDS = 16;
const CMD_UPDATE = 1 << 23;
const CMD_USR = 1 << 24;
const USER_CK_OUT_EDGE = 1 << 9;
const MISC_CK_IDLE_EDGE = 1 << 29;
const TRANS_DONE = 1 << 12;

export interface Spi2Bus {
  /** One byte each way, with the mode and bit order the controller is set to. */
  transfer(mosi: number, mode: SpiMode, lsbFirst: boolean): number;
}

export class EspSpi2 implements Peripheral {
  readonly name = 'spi2';
  readonly size = 0x1000;
  readonly base: number;
  private readonly registers = new Map<number, number>();
  /** Bytes exchanged, for tests. */
  transfers = 0;

  constructor(private readonly layout: Spi2Layout, private readonly bus: () => Spi2Bus | null) {
    this.base = layout.base;
  }

  reset(): void {
    this.registers.clear();
    this.transfers = 0;
  }

  private peek(offset: number): number {
    return (this.registers.get(offset) ?? 0) >>> 0;
  }

  readUint32(offset: number): number {
    // UPDATE and USR clear themselves: the latch is instant and so is the transfer.
    if (offset === CMD) return this.peek(CMD) & ~(CMD_UPDATE | CMD_USR);
    return this.peek(offset);
  }

  writeUint32(offset: number, value: number): void {
    this.registers.set(offset, value >>> 0);
    if (offset === CMD && value & CMD_USR) this.run();
  }

  /**
   * SPI mode from the clock registers: MISC.CK_IDLE_EDGE is CPOL, and
   * USER.CK_OUT_EDGE is CPHA exclusive-or CPOL — how the IDF's
   * spi_ll_master_set_mode writes modes 0 to 3.
   */
  get mode(): SpiMode {
    const cpol = this.peek(MISC) & MISC_CK_IDLE_EDGE ? 1 : 0;
    const outEdge = this.peek(USER) & USER_CK_OUT_EDGE ? 1 : 0;
    return ((cpol << 1) | (outEdge ^ cpol)) as SpiMode;
  }

  private run(): void {
    const bits = (this.peek(MS_DLEN) & 0x3ffff) + 1;
    const bytes = Math.min(WORDS * 4, Math.ceil(bits / 8));
    const lsbFirst = ((this.peek(CTRL) >>> this.layout.wrBitOrderShift) & 1) === 1;
    const bus = this.bus();
    for (let i = 0; i < bytes; i++) {
      const word = W0 + (i >> 2) * 4;
      const shift = (i & 3) * 8;
      const mosi = (this.peek(word) >>> shift) & 0xff;
      // Nothing on the bus reads back the idle level of a pulled-up MISO.
      const miso = bus ? bus.transfer(mosi, this.mode, lsbFirst) & 0xff : 0xff;
      this.registers.set(word, ((this.peek(word) & ~(0xff << shift)) | (miso << shift)) >>> 0);
      this.transfers++;
    }
    this.registers.set(DMA_INT_RAW, this.peek(DMA_INT_RAW) | TRANS_DONE);
  }
}
