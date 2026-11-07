// The ESP32's general-purpose SPI masters, HSPI (SPI2) and VSPI (SPI3).
//
// Arduino-ESP32's SPI library (esp32-hal-spi.c) drives these registers itself:
// the bytes into W0-W15, the bit count into MOSI_DLEN, CMD.USR set, a spin
// until the controller clears it, the answer read back from W0-W15. Here USR
// runs the transaction on the shared SPI device bus in the mode and bit order
// the registers set, full duplex, and completes at once. Chip select is the
// sketch's own GPIO. Offsets from soc/esp32/register/soc/spi_reg.h; the mode
// mapping is esp32-hal-spi.c's spiSetDataMode (PIN.CK_IDLE_EDGE is CPOL,
// USER.CK_OUT_EDGE is CPHA exclusive-or CPOL). DMA is not modelled.

import type { Peripheral } from '../espRiscv/peripheral';
import type { Spi2Bus } from '../espRiscv/spi2';
import type { SpiMode } from '../devices/types';

const CMD = 0x00, CTRL = 0x08, USER = 0x1c, MOSI_DLEN = 0x28, PIN = 0x34, W0 = 0x80;
const CMD_USR = 1 << 18;

/** Matrix signals of each controller's clock, MOSI, MISO and CS0 (gpio_sig_map.h). */
export const ESP32_SPI_SIGNALS = {
  hspi: { clk: 8, miso: 9, mosi: 10, cs0: 11 },
  vspi: { clk: 63, miso: 64, mosi: 65, cs0: 68 },
} as const;

export class Esp32Spi implements Peripheral {
  readonly size = 0x1000;
  private readonly regs = new Map<number, number>();
  transfers = 0;

  constructor(
    readonly name: string,
    readonly base: number,
    private readonly bus: () => Spi2Bus | null,
  ) {}

  reset(): void {
    this.regs.clear();
    this.transfers = 0;
  }

  private peek(offset: number): number {
    return (this.regs.get(offset) ?? 0) >>> 0;
  }

  readUint32(offset: number): number {
    if (offset === CMD) return this.peek(CMD) & ~CMD_USR;
    return this.peek(offset);
  }

  writeUint32(offset: number, value: number): void {
    this.regs.set(offset, value >>> 0);
    if (offset === CMD && value & CMD_USR) this.run();
  }

  get mode(): SpiMode {
    const cpol = (this.peek(PIN) >>> 29) & 1;
    const out = (this.peek(USER) >>> 7) & 1;
    return ((cpol << 1) | (out ^ cpol)) as SpiMode;
  }

  private run(): void {
    const bits = (this.peek(MOSI_DLEN) & 0xffffff) + 1;
    const bytes = Math.min(64, Math.ceil(bits / 8));
    const lsbFirst = ((this.peek(CTRL) >>> 26) & 1) === 1;
    const bus = this.bus();
    for (let i = 0; i < bytes; i++) {
      const word = W0 + (i >> 2) * 4;
      const shift = (i & 3) * 8;
      const mosi = (this.peek(word) >>> shift) & 0xff;
      const miso = bus ? bus.transfer(mosi, this.mode, lsbFirst) & 0xff : 0xff;
      this.regs.set(word, ((this.peek(word) & ~(0xff << shift)) | (miso << shift)) >>> 0);
      this.transfers++;
    }
  }
}
