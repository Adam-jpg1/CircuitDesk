// The factory MAC in eFuse, for the RISC-V ESP32 parts.
//
// ESP-IDF reads the base MAC from the eFuse block's RD_MAC_SYS words: bytes
// 5..2 in the first (0x44), bytes 1..0 in the low half of the second (0x48),
// and reverses them. Nothing else in eFuse is modelled here; every other word
// reads zero, as it did before this block existed. The MAC matters once a
// board joins a network: it is the board's identity there, and each board on
// a canvas needs its own.

import type { Peripheral } from './peripheral';

export class EfuseMac implements Peripheral {
  readonly name = 'efuse';
  readonly size = 0x200;
  private mac: readonly number[] = [0x24, 0x0a, 0xc4, 0x12, 0x34, 0x56];

  constructor(readonly base: number) {}

  setMac(mac: readonly number[]): void {
    this.mac = mac;
  }

  readUint32(offset: number): number {
    const m = this.mac;
    if (offset === 0x44) return ((m[2] << 24) | (m[3] << 16) | (m[4] << 8) | m[5]) >>> 0;
    if (offset === 0x48) return ((m[0] << 8) | m[1]) >>> 0;
    return 0;
  }

  writeUint32(): void {}
}

/** Where each chip's eFuse block is (soc/reg_base.h). */
export const EFUSE_BASE = { esp32c3: 0x60008800, esp32c6: 0x600b0800 } as const;
