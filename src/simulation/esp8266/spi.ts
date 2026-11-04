// The ESP8266's SPI0, the flash controller at 0x60000200 (spi_register.h).
//
// The SDK and the Arduino core drive it directly for a few things the ROM's
// flash routines do not cover — reading the JEDEC ID, the status register —
// by setting one command bit in SPI_CMD (0x00) and waiting for it to clear.
// Each command finishes at once here: RDID (bit 28) leaves the ID in W0
// (0x40), RDSR (bit 27) the status (always idle) in SPI_RD_STATUS (0x10),
// READ (bit 31) the bytes SPI_ADDR (0x04: address, length in bits 31:24)
// names in W0..W15. Everything else is storage.

import type { Peripheral } from '../espRiscv/peripheral';
import type { SerialNorFlash } from '../esp32c3/spiFlash';
import type { SpiMode } from '../devices/types';

const RDID = 1 << 28;
const RDSR = 1 << 27;
const READ = 1 << 31;

export class Esp8266FlashSpi implements Peripheral {
  readonly name = 'spi0';
  readonly base = 0x60000200;
  readonly size = 0x100;
  private readonly regs = new Uint32Array(0x40);

  constructor(private readonly flash: SerialNorFlash) {}

  reset(): void {
    this.regs.fill(0);
  }

  readUint32(offset: number): number {
    return offset === 0 ? 0 : this.regs[(offset >> 2) & 0x3f];
  }

  writeUint32(offset: number, value: number): void {
    this.regs[(offset >> 2) & 0x3f] = value >>> 0;
    if (offset !== 0) return;
    const id = this.flash.id;
    if (value & RDID) this.regs[0x10] = (id.manufacturer | (id.memoryType << 8) | (id.capacity << 16)) >>> 0;
    if (value & RDSR) this.regs[0x04] = 0;
    if (value & READ) {
      const addr = this.regs[1] & 0xffffff;
      const len = Math.min(64, this.regs[1] >>> 24);
      const f = this.flash.bytes;
      for (let i = 0; i < 16; i++) {
        let w = 0;
        for (let b = 0; b < 4; b++) {
          const k = i * 4 + b;
          if (k < len) w |= (f[(addr + k) % f.length] ?? 0xff) << (8 * b);
        }
        this.regs[0x10 + i] = w >>> 0;
      }
    }
  }
}

/**
 * SPI1, the HSPI master Arduino's SPI library drives (pads 12 MISO, 13
 * MOSI, 14 SCK). A transfer is the "user" command: SPI_CMD's USR bit (18)
 * clocks the MOSI phase's bits (SPI_USER1 bits 25:17, plus one) out of W0
 * (or W8, SPIUMOSIH) and, full duplex, the same count back in, each byte
 * least-significant first in its word. SPI_CTRL bit 26 sends each byte LSB
 * first. The mode comes from SPI_USER's clock-edge bit 7 and SPI_PIN's idle
 * polarity bit 29, undoing the Arduino core's swap of CPHA when CPOL is set.
 */
export class Esp8266Hspi implements Peripheral {
  readonly name = 'spi1';
  readonly base = 0x60000100;
  readonly size = 0x100;
  private readonly regs = new Uint32Array(0x40);

  constructor(private readonly bus: () => { transfer(mosi: number, mode: SpiMode, lsbFirst: boolean): number } | null) {}

  reset(): void {
    this.regs.fill(0);
  }

  readUint32(offset: number): number {
    return offset === 0 ? 0 : this.regs[(offset >> 2) & 0x3f];
  }

  writeUint32(offset: number, value: number): void {
    this.regs[(offset >> 2) & 0x3f] = value >>> 0;
    if (offset !== 0 || !(value & (1 << 18))) return;
    const user = this.regs[0x1c >> 2];
    const user1 = this.regs[0x20 >> 2];
    const cpol = (this.regs[0x2c >> 2] >>> 29) & 1;
    const edge = (user >>> 7) & 1;
    const cpha = cpol ? edge ^ 1 : edge;
    const mode = ((cpol << 1) | cpha) as SpiMode;
    const lsbFirst = ((this.regs[0x08 >> 2] >>> 26) & 1) === 1;
    const mosi = (user >>> 27) & 1;
    const miso = (user >>> 28) & 1;
    if (!mosi && !miso) return;
    const bits = ((mosi ? user1 >>> 17 : user1 >>> 8) & 0x1ff) + 1;
    const bytes = Math.ceil(bits / 8);
    const outBase = 0x10 + ((user >>> 25) & 1 ? 8 : 0);
    const inBase = 0x10 + ((user >>> 24) & 1 ? 8 : 0);
    const received: number[] = [];
    const bus = this.bus();
    for (let i = 0; i < bytes && i < 64; i++) {
      const out = mosi ? (this.regs[outBase + (i >> 2)] >>> ((i & 3) * 8)) & 0xff : 0xff;
      received.push(bus ? bus.transfer(out, mode, lsbFirst) & 0xff : 0xff);
    }
    if (!miso && !(user & 1)) return;
    for (let i = 0; i < received.length; i++) {
      const w = inBase + (i >> 2);
      const shift = (i & 3) * 8;
      this.regs[w] = ((this.regs[w] & ~(0xff << shift)) | (received[i] << shift)) >>> 0;
    }
  }
}
