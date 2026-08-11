// The ESP32-C3's SPI memory controllers, SPI0 and SPI1.
//
// SPI1 is the one software drives directly. ESP-IDF builds a transaction in
// its registers — command, address, dummy cycles, how many bits go out and how
// many come back — then sets a start bit and polls until the hardware clears
// it. So this is not a register file with a status bit bolted on: the whole
// point is that the register contents describe a real command, and this block
// executes exactly that command against the flash device and puts exactly its
// answer back where the firmware will read it.
//
// SPI0 is the cache's own controller. Firmware configures it but never runs
// transactions through it, so it is a register file elsewhere; the mapping it
// performs is modelled where the image is loaded.
//
// Register offsets and bit positions are the documented ones from the ESP32-C3
// technical reference manual.

import type { FlashMapper, FlashOwner, Peripheral } from '../espRiscv/peripheral';
import { FLASH_COMMAND, type SerialNorFlash } from './spiFlash';

export const SPI_MEM_BASE = {
  spi0: 0x60003000,
  spi1: 0x60002000,
} as const;

const CMD = 0x00;
const ADDR = 0x04;
const USER = 0x18;
const USER1 = 0x1c;
const USER2 = 0x20;
const MOSI_DLEN = 0x24;
const MISO_DLEN = 0x28;
const RD_STATUS = 0x2c;
const W0 = 0x58;
const REGISTER_BUFFER_WORDS = 16;

/** CMD register bits, each a self-clearing command trigger. */
const CMD_FLASH_READ = 1 << 31;
const CMD_FLASH_WREN = 1 << 30;
const CMD_FLASH_WRDI = 1 << 29;
const CMD_FLASH_RDID = 1 << 28;
const CMD_FLASH_RDSR = 1 << 27;
const CMD_FLASH_WRSR = 1 << 26;
const CMD_FLASH_PP = 1 << 25;
const CMD_FLASH_SE = 1 << 24;
const CMD_FLASH_BE = 1 << 23;
const CMD_FLASH_CE = 1 << 22;
const CMD_FLASH_DP = 1 << 21;
const CMD_FLASH_RES = 1 << 20;
const CMD_FLASH_HPM = 1 << 19;
const CMD_USR = 1 << 18;

/** USER register phase-enable bits. */
const USER_COMMAND = 1 << 31;
const USER_ADDR = 1 << 30;
const USER_MISO = 1 << 28;
const USER_MOSI = 1 << 27;
const USER_MOSI_HIGHPART = 1 << 25;
const USER_MISO_HIGHPART = 1 << 24;

/** A decoded transaction, exposed so tests and traces can see what was asked. */
export interface SpiFlashTransaction {
  command: number;
  address: number;
  /** Bytes sent to the device after the address. */
  mosi: Uint8Array;
  /** Bytes the device returned. */
  miso: Uint8Array;
}

/** SPI1, the controller ESP-IDF drives to reach the flash. */
export class SpiMemController implements Peripheral, FlashOwner {
  /** This block owns the flash device the cache reads through. */
  readonly isFlashOwner = true;
  readonly name = 'spi1';
  /**
   * SPI1's base, which the two parts swap: 0x60002000 on the C3, 0x60003000 on
   * the C6. The register layout is the same, so only this differs.
   */
  readonly base: number;
  readonly size = 0x1000;

  private readonly registers = new Map<number, number>();

  /** The most recent transactions, bounded so a long run cannot grow without limit. */
  readonly recent: SpiFlashTransaction[] = [];
  private readonly recentLimit = 64;

  constructor(
    readonly flash: SerialNorFlash,
    base = SPI_MEM_BASE.spi1,
  ) {
    this.base = base;
  }

  readUint32(offset: number): number {
    return (this.registers.get(offset) ?? 0) >>> 0;
  }

  writeUint32(offset: number, value: number): void {
    this.registers.set(offset, value >>> 0);
    if (offset === CMD) this.execute(value >>> 0);
  }

  reset(): void {
    this.registers.clear();
    this.recent.length = 0;
    this.flash.reset();
  }

  peek(offset: number): number {
    return (this.registers.get(offset) ?? 0) >>> 0;
  }

  // ---------------------------------------------------------------- execution

  private execute(command: number): void {
    if ((command & CMD_USR) !== 0) this.runUserTransaction();
    else this.runDirectCommand(command);
    // Every trigger bit is self-clearing: the hardware clears it when the
    // operation finishes, and firmware polls for exactly that.
    this.registers.set(CMD, 0);
  }

  /**
   * Runs the transaction the USER registers describe.
   *
   * Each phase is enabled by its own bit, and its length is a register field
   * counting from zero — a bit-length field of 7 means eight bits. Getting
   * that off by one would send the wrong opcode width and the device would
   * answer nothing.
   */
  private runUserTransaction(): void {
    const user = this.peek(USER);
    const user1 = this.peek(USER1);
    const user2 = this.peek(USER2);

    let command = 0;
    if ((user & USER_COMMAND) !== 0) {
      const bits = ((user2 >>> 28) & 0xf) + 1;
      command = user2 & ((1 << bits) - 1);
    }

    let address = 0;
    if ((user & USER_ADDR) !== 0) {
      const bits = ((user1 >>> 26) & 0x3f) + 1;
      // The address sits in the most significant bits of ADDR, because the
      // hardware shifts it out starting from bit 31.
      address = bits >= 32 ? this.peek(ADDR) >>> 0 : this.peek(ADDR) >>> (32 - bits);
    }

    const mosiLength = (user & USER_MOSI) !== 0 ? Math.ceil(((this.peek(MOSI_DLEN) & 0x3ff) + 1) / 8) : 0;
    const misoLength = (user & USER_MISO) !== 0 ? Math.ceil(((this.peek(MISO_DLEN) & 0x3ff) + 1) / 8) : 0;

    const mosi = this.readBuffer((user & USER_MOSI_HIGHPART) !== 0, mosiLength);
    const miso = this.flash.transfer(command, address, mosi, misoLength);
    this.writeBuffer((user & USER_MISO_HIGHPART) !== 0, miso);
    this.record({ command, address, mosi, miso });
  }

  /**
   * Runs one of the fixed commands the CMD register can trigger on its own.
   *
   * These take their address from ADDR and their data from the same word
   * buffer as a user transaction, so they route to the same device.
   */
  private runDirectCommand(command: number): void {
    const address = this.peek(ADDR) & 0xffffff;
    // A direct read or program carries its byte count in the top byte of ADDR.
    const length = (this.peek(ADDR) >>> 24) & 0xff;
    const C = FLASH_COMMAND;

    const run = (opcode: number, mosi: Uint8Array, misoLength: number): Uint8Array => {
      const miso = this.flash.transfer(opcode, address, mosi, misoLength);
      this.record({ command: opcode, address, mosi, miso });
      return miso;
    };

    if ((command & CMD_FLASH_WREN) !== 0) run(C.writeEnable, new Uint8Array(0), 0);
    if ((command & CMD_FLASH_WRDI) !== 0) run(C.writeDisable, new Uint8Array(0), 0);
    if ((command & CMD_FLASH_RDID) !== 0) {
      // The hardware presents the identifier in the first word buffer.
      this.writeBuffer(false, run(C.readId, new Uint8Array(0), 3));
    }
    if ((command & CMD_FLASH_RDSR) !== 0) {
      this.registers.set(RD_STATUS, run(C.readStatus1, new Uint8Array(0), 1)[0]);
    }
    if ((command & CMD_FLASH_WRSR) !== 0) run(C.writeStatus1, Uint8Array.from([this.peek(RD_STATUS) & 0xff]), 0);
    if ((command & CMD_FLASH_PP) !== 0) run(C.pageProgram, this.readBuffer(false, length), 0);
    if ((command & CMD_FLASH_SE) !== 0) run(C.sectorErase, new Uint8Array(0), 0);
    if ((command & CMD_FLASH_BE) !== 0) run(C.blockErase64k, new Uint8Array(0), 0);
    if ((command & CMD_FLASH_CE) !== 0) run(C.chipErase, new Uint8Array(0), 0);
    if ((command & CMD_FLASH_DP) !== 0) run(C.powerDown, new Uint8Array(0), 0);
    if ((command & CMD_FLASH_RES) !== 0) run(C.releasePowerDown, new Uint8Array(0), 3);
    if ((command & CMD_FLASH_HPM) !== 0) run(C.releasePowerDown, new Uint8Array(0), 0);
    if ((command & CMD_FLASH_READ) !== 0) this.writeBuffer(false, run(C.read, new Uint8Array(0), length));
  }

  /** The 16-word data buffer, addressed from its low or high half. */
  private bufferBase(highPart: boolean): number {
    return W0 + (highPart ? (REGISTER_BUFFER_WORDS / 2) * 4 : 0);
  }

  private readBuffer(highPart: boolean, length: number): Uint8Array {
    const base = this.bufferBase(highPart);
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = (this.peek(base + (i >> 2) * 4) >>> ((i & 3) * 8)) & 0xff;
    }
    return out;
  }

  private writeBuffer(highPart: boolean, data: Uint8Array): void {
    const base = this.bufferBase(highPart);
    for (let i = 0; i < data.length; i += 4) {
      let word = 0;
      // Bytes the device did not supply are left as an erased flash would read.
      for (let b = 0; b < 4; b++) word |= (data[i + b] ?? 0xff) << (b * 8);
      this.registers.set(base + (i >> 2) * 4, word >>> 0);
    }
  }

  private record(transaction: SpiFlashTransaction): void {
    this.recent.push(transaction);
    if (this.recent.length > this.recentLimit) this.recent.shift();
  }
}

// ------------------------------------------------------------------ flash MMU

/** Where the flash MMU's page table is mapped. */
export const MMU_TABLE_BASE = 0x600c5000;

/** One entry per 64 KB page, shared by the instruction and data windows. */
export const MMU_ENTRY_COUNT = 128;
export const MMU_PAGE_SIZE = 0x10000;

/** Bit 8 marks an entry as not mapping anything. */
const MMU_INVALID = 1 << 8;
/** The remaining low bits hold the flash page number. */
const MMU_PAGE_MASK = 0xff;

/**
 * Only the low 23 bits of a cache address select a page; the rest selects
 * which window, and both windows share this one table.
 */
const MMU_VADDR_MASK = 0x7fffff;

/**
 * The flash MMU.
 *
 * The cache windows at 0x3C000000 and 0x42000000 do not hold anything of their
 * own: each 64 KB page of them is mapped, through this table, onto a 64 KB page
 * of the flash. That is what makes a 4 MB flash readable as if it were memory,
 * and it is also why ESP-IDF can ask which flash offset a given code address
 * came from — `spi_flash_cache2phys` reads this table and inverts the mapping.
 * Without it, `esp_ota_get_running_partition` cannot tell which partition it is
 * executing from and asserts.
 *
 * Entries are writable because firmware really does rewrite them: mapping a
 * partition at runtime is exactly this.
 */
export class FlashMmu implements Peripheral, FlashMapper {
  /** This block is the machine's flash MMU. */
  readonly isFlashMapper = true;
  readonly name = 'flash_mmu';
  readonly base = MMU_TABLE_BASE;
  readonly size = MMU_ENTRY_COUNT * 4;

  private readonly entries = new Uint32Array(MMU_ENTRY_COUNT);

  constructor() {
    this.reset();
  }

  reset(): void {
    this.entries.fill(MMU_INVALID);
  }

  readUint32(offset: number): number {
    return this.entries[(offset >>> 2) % MMU_ENTRY_COUNT] >>> 0;
  }

  writeUint32(offset: number, value: number): void {
    this.entries[(offset >>> 2) % MMU_ENTRY_COUNT] = value >>> 0;
  }

  /** Points a cache page at a flash page. */
  map(entry: number, flashPage: number): void {
    if (entry < 0 || entry >= MMU_ENTRY_COUNT) return;
    this.entries[entry] = flashPage & MMU_PAGE_MASK;
  }

  /** The entry a cache address falls in. */
  entryOf(address: number): number {
    return ((address & MMU_VADDR_MASK) >>> 16) % MMU_ENTRY_COUNT;
  }

  /**
   * Converts a cache address to a flash offset, or undefined when the page it
   * lands in is not mapped — which is the answer `spi_flash_cache2phys`
   * reports as a failure rather than a guess.
   */
  translate(address: number): number | undefined {
    const entry = this.entries[this.entryOf(address)];
    if ((entry & MMU_INVALID) !== 0) return undefined;
    return (entry & MMU_PAGE_MASK) * MMU_PAGE_SIZE + (address & (MMU_PAGE_SIZE - 1));
  }
}
