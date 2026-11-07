// FlexSPI's IP command interface, as the Teensy 4 core uses it to write the
// QSPI flash the sketch runs from.
//
// The core's EEPROM emulation (cores/teensy4/eeprom.c) keeps its data in the
// last sectors of that flash and changes it with IP commands: it writes a
// one-instruction sequence into LUT entry 60 (a flash command byte, maybe an
// address phase and a data phase), sets IPCR0/IPCR1 to the address and the
// data size, triggers it with IPCMD, and for a page program feeds the data
// eight bytes at a time through the TX FIFO each time IPTXWE says there is
// room. The command byte decides what happens to the flash array here:
//
//   06 write enable            nothing to do
//   05 read status             RX FIFO gets 0: never busy
//   02, 12, 32, 34, 38 program each byte ANDed into the array (NOR flash
//                              programs only 1 -> 0)
//   20, 21 sector erase 4 KB   0xFF
//   52 block erase 32 KB       0xFF
//   D8, DC block erase 64 KB   0xFF
//
// Anything else completes at once and changes nothing, as before. The AHB
// read path is the plain memory region, so what the sketch reads back is the
// array as these commands left it.

import type { Periph } from '../armv7m/peripherals';

const MCR0 = 0x00;
const INTR = 0x14;
const IPCR0 = 0xa0;
const IPCR1 = 0xa4;
const IPCMD = 0xb0;
const IPRXFCR = 0xb8;
const IPTXFCR = 0xbc;
const STS0 = 0xe4;
const RFDR = 0x100;
const TFDR = 0x180;
const LUT = 0x200;

const IPCMDDONE = 1 << 0;
const IPTXWE = 1 << 6;
const IPRXWA = 1 << 5;
const FIFO_BYTES = 8;

const PROGRAM = new Set([0x02, 0x12, 0x32, 0x34, 0x38]);
const ERASE: Record<number, number> = { 0x20: 0x1000, 0x21: 0x1000, 0x52: 0x8000, 0xd8: 0x10000, 0xdc: 0x10000 };

export class FlexSpi {
  /** A page program waiting for data: where the next byte goes, and how many are left. */
  private writing: { at: number; left: number } | null = null;

  constructor(
    private readonly p: Periph,
    /** The flash array the AHB window maps, or null for a port with nothing attached. */
    private readonly flash: Uint8Array | null,
  ) {
    p.reg(MCR0, () => p.peek(MCR0) & ~1); // software reset completes at once
    p.reg(STS0, () => 0x3); // sequencer and arbiter idle
    p.init(INTR, IPCMDDONE);
    p.reg(INTR, undefined, (v, previous) => {
      // Write 1 to clear. Clearing IPTXWE is how software says it has filled the TX FIFO.
      p.poke(INTR, previous & ~v);
      if (v & IPTXWE && this.writing) this.takeTxFifo();
    });
    p.reg(IPCMD, undefined, (v) => {
      if (v & 1) this.trigger();
    });
    p.reg(IPRXFCR, undefined, () => p.poke(IPRXFCR, 0));
    p.reg(IPTXFCR, undefined, () => p.poke(IPTXFCR, 0));
  }

  private trigger(): void {
    const p = this.p;
    const seq = (p.peek(IPCR1) >>> 16) & 0xf;
    const size = p.peek(IPCR1) & 0xffff;
    const address = p.peek(IPCR0) & 0x00ffffff;
    // The first instruction of the sequence: opcode in bits 15-10, operand in 7-0.
    const first = p.peek(LUT + seq * 16) & 0xffff;
    const command = (first >>> 10) === 0x01 ? first & 0xff : -1;
    const flash = this.flash;
    this.writing = null;
    if (flash && PROGRAM.has(command) && size > 0) {
      this.writing = { at: address, left: size };
      p.poke(INTR, (p.peek(INTR) & ~IPCMDDONE) | IPTXWE);
      return;
    }
    if (flash && command in ERASE) {
      const span = ERASE[command];
      const start = address & ~(span - 1);
      if (start < flash.length) flash.fill(0xff, start, Math.min(flash.length, start + span));
    } else if (command === 0x05) {
      p.poke(RFDR, 0); // status: not busy, writes not enabled
      p.poke(INTR, p.peek(INTR) | IPRXWA);
    }
    p.poke(INTR, p.peek(INTR) | IPCMDDONE);
  }

  /** Up to a FIFO's worth of the data being programmed. */
  private takeTxFifo(): void {
    const w = this.writing!;
    const flash = this.flash!;
    const n = Math.min(FIFO_BYTES, w.left);
    for (let k = 0; k < n; k++) {
      const byte = (this.p.peek(TFDR + (k & ~3)) >>> ((k & 3) * 8)) & 0xff;
      if (w.at < flash.length) flash[w.at] &= byte;
      w.at++;
    }
    w.left -= n;
    if (w.left > 0) {
      this.p.poke(INTR, this.p.peek(INTR) | IPTXWE);
    } else {
      this.writing = null;
      this.p.poke(INTR, this.p.peek(INTR) | IPCMDDONE);
    }
  }
}
