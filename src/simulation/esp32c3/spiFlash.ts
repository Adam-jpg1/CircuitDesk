// The SPI NOR flash on the module, and the controller that talks to it.
//
// An ESP32-C3-DevKitM-1 carries an ESP32-C3-MINI-1, and inside that module is
// a 4 MB SPI NOR flash on the chip's dedicated flash pins. ESP-IDF does not
// take its presence on trust: early in startup it reads the flash's JEDEC ID,
// picks a chip driver from it, reads the partition table, and refuses to
// continue if the flash does not answer. Without a flash there is no partition
// table, no NVS and no application description, so startup stops with
// "memspi: no response" — which is the correct thing for it to do.
//
// So the flash is modelled as what it is: a command-driven serial device with
// real contents. Reads return the bytes the toolchain actually wrote to that
// offset; an erase really sets bytes to 0xFF; a program really clears bits and
// cannot set them. Nothing is special-cased for any particular command
// sequence, and the same model serves the bootloader, the partition table
// reader and NVS.
//
// Commands and their encodings are the ones every JEDEC-compatible SPI NOR
// part implements, documented in the datasheet of the part modelled below.

/** JEDEC identification, as returned by command 0x9F. */
export interface JedecId {
  manufacturer: number;
  memoryType: number;
  /** Capacity byte: the flash holds 2^capacity bytes. */
  capacity: number;
}

/**
 * The part CircuitDesk models: a GigaDevice GD25Q32, 4 MB (32 Mbit).
 *
 * ESP32-C3-MINI-1 modules ship with a 4 MB SPI NOR die, and Espressif does not
 * fix which vendor's part that is — it varies by production batch, which is
 * exactly why ESP-IDF identifies the flash at runtime instead of assuming.
 * CircuitDesk therefore models one specific, real, widely used 4 MB part
 * rather than inventing an identifier, and drives it through the standard
 * command set that every one of those parts shares.
 */
export const GD25Q32_ID: JedecId = { manufacturer: 0xc8, memoryType: 0x40, capacity: 0x16 };

/** Standard SPI NOR opcodes. */
export const FLASH_COMMAND = {
  writeEnable: 0x06,
  writeDisable: 0x04,
  readStatus1: 0x05,
  readStatus2: 0x35,
  readStatus3: 0x15,
  writeStatus1: 0x01,
  writeStatus2: 0x31,
  writeStatus3: 0x11,
  readId: 0x9f,
  readSfdp: 0x5a,
  read: 0x03,
  fastRead: 0x0b,
  fastReadDualOutput: 0x3b,
  fastReadQuadOutput: 0x6b,
  fastReadDualIo: 0xbb,
  fastReadQuadIo: 0xeb,
  pageProgram: 0x02,
  quadPageProgram: 0x32,
  sectorErase: 0x20,
  blockErase32k: 0x52,
  blockErase64k: 0xd8,
  chipErase: 0xc7,
  chipEraseAlt: 0x60,
  releasePowerDown: 0xab,
  powerDown: 0xb9,
  resetEnable: 0x66,
  reset: 0x99,
  enterQpi: 0x38,
} as const;

/** Status register 1 bits. */
const STATUS_WIP = 1 << 0;
const STATUS_WEL = 1 << 1;

/** A page is the largest run a single program command can touch. */
export const FLASH_PAGE_SIZE = 256;
export const FLASH_SECTOR_SIZE = 4096;

export interface FlashRegion {
  /** Byte offset in flash. */
  offset: number;
  data: Uint8Array;
}

export class FlashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlashError';
  }
}

/**
 * A JEDEC-compatible serial NOR flash.
 *
 * Programming clears bits and never sets them, which is how NOR flash works
 * and is the reason erasing exists at all; software that programs over
 * unerased data sees the same corruption it would on hardware rather than a
 * clean overwrite.
 *
 * Erases and programs complete within the command, so the busy bit reads back
 * clear. Nothing observable depends on the delay — firmware polls the busy bit
 * and proceeds — and pretending to a duration this runtime cannot honour would
 * be inventing timing rather than modelling it.
 */
export class SerialNorFlash {
  readonly bytes: Uint8Array;
  readonly id: JedecId;

  /** Status registers 1 to 3, as the part presents them. */
  private status = new Uint8Array(3);

  constructor(options: { sizeBytes?: number; id?: JedecId; regions?: FlashRegion[] } = {}) {
    this.id = options.id ?? GD25Q32_ID;
    const size = options.sizeBytes ?? 1 << this.id.capacity;
    this.bytes = new Uint8Array(size);
    this.bytes.fill(0xff);
    for (const region of options.regions ?? []) this.write(region.offset, region.data);
  }

  get sizeBytes(): number {
    return this.bytes.length;
  }

  /** Places content as a programmer would, without going through commands. */
  write(offset: number, data: Uint8Array): void {
    if (offset < 0 || offset + data.length > this.bytes.length) {
      throw new FlashError(
        `A ${data.length} byte region at 0x${offset.toString(16)} does not fit in ${this.bytes.length} bytes of flash.`,
      );
    }
    this.bytes.set(data, offset);
  }

  /** Returns the part to its power-on state with the write latch clear. */
  reset(): void {
    this.status.fill(0);
  }

  private get writeEnabled(): boolean {
    return (this.status[0] & STATUS_WEL) !== 0;
  }

  private erase(from: number, length: number): void {
    // A program or erase without the write-enable latch is ignored by the
    // hardware. Silently doing it anyway would hide a real firmware bug.
    if (!this.writeEnabled) return;
    const start = from & ~(length - 1);
    this.bytes.fill(0xff, start, Math.min(start + length, this.bytes.length));
    this.status[0] &= ~STATUS_WEL;
  }

  /**
   * Runs one command and returns the bytes it clocked back out.
   *
   * `address` is meaningful only for the commands that take one, and `mosi`
   * carries the bytes the controller sent after the address.
   */
  transfer(command: number, address: number, mosi: Uint8Array, misoLength: number): Uint8Array {
    const miso = new Uint8Array(misoLength);
    const C = FLASH_COMMAND;

    switch (command) {
      case C.writeEnable:
        this.status[0] |= STATUS_WEL;
        return miso;
      case C.writeDisable:
        this.status[0] &= ~STATUS_WEL;
        return miso;

      case C.readStatus1:
      case C.readStatus2:
      case C.readStatus3: {
        const index = command === C.readStatus1 ? 0 : command === C.readStatus2 ? 1 : 2;
        // A status register read repeats for as long as the controller keeps
        // clocking, which is what the part does.
        miso.fill(this.status[index] & ~STATUS_WIP);
        return miso;
      }

      case C.writeStatus1:
      case C.writeStatus2:
      case C.writeStatus3: {
        if (!this.writeEnabled) return miso;
        const index = command === C.writeStatus1 ? 0 : command === C.writeStatus2 ? 1 : 2;
        for (let i = 0; i < mosi.length && index + i < 3; i++) this.status[index + i] = mosi[i];
        this.status[0] &= ~STATUS_WEL;
        return miso;
      }

      case C.readId: {
        const identifier = [this.id.manufacturer, this.id.memoryType, this.id.capacity];
        for (let i = 0; i < miso.length; i++) miso[i] = identifier[i % identifier.length];
        return miso;
      }

      case C.readSfdp:
        // This model publishes no SFDP table. A part without one answers 0xFF,
        // and ESP-IDF falls back to the identification it already has.
        miso.fill(0xff);
        return miso;

      case C.read:
      case C.fastRead:
      case C.fastReadDualOutput:
      case C.fastReadQuadOutput:
      case C.fastReadDualIo:
      case C.fastReadQuadIo:
        for (let i = 0; i < miso.length; i++) {
          // Reads wrap at the end of the die, as the part does.
          miso[i] = this.bytes[(address + i) % this.bytes.length];
        }
        return miso;

      case C.pageProgram:
      case C.quadPageProgram: {
        if (!this.writeEnabled) return miso;
        const pageBase = address - (address % FLASH_PAGE_SIZE);
        for (let i = 0; i < mosi.length; i++) {
          // A program that runs past the end of a page wraps to its start
          // rather than spilling into the next one.
          const target = pageBase + (((address % FLASH_PAGE_SIZE) + i) % FLASH_PAGE_SIZE);
          if (target >= this.bytes.length) continue;
          // NOR programming can only clear bits.
          this.bytes[target] &= mosi[i];
        }
        this.status[0] &= ~STATUS_WEL;
        return miso;
      }

      case C.sectorErase:
        this.erase(address, FLASH_SECTOR_SIZE);
        return miso;
      case C.blockErase32k:
        this.erase(address, 32 * 1024);
        return miso;
      case C.blockErase64k:
        this.erase(address, 64 * 1024);
        return miso;
      case C.chipErase:
      case C.chipEraseAlt:
        this.erase(0, this.bytes.length);
        return miso;

      case C.releasePowerDown:
        // Answers the electronic signature, which is the capacity byte on
        // parts that implement the short form.
        miso.fill(this.id.capacity);
        return miso;

      case C.powerDown:
      case C.resetEnable:
      case C.enterQpi:
        return miso;
      case C.reset:
        this.reset();
        return miso;

      default:
        throw new FlashError(
          `The firmware sent SPI flash command 0x${command.toString(16)}, which CircuitDesk's flash model does not ` +
            'implement. Please report it so the behaviour can be added.',
        );
    }
  }
}

// ------------------------------------------------------------- flash contents

/**
 * Where an ESP32-C3 Arduino build places each of its artifacts.
 *
 * These offsets are the ones the core's own flashing recipe uses, not a
 * convention chosen here: bootloader at 0, partition table at 0x8000, the OTA
 * selection block at 0xE000 and the application at 0x10000.
 */
export const ESP32C3_FLASH_LAYOUT = {
  bootloader: 0x0,
  partitionTable: 0x8000,
  otaSelect: 0xe000,
  application: 0x10000,
} as const;

export interface Esp32C3FlashContents {
  bootloader?: Uint8Array;
  partitionTable?: Uint8Array;
  otaSelect?: Uint8Array;
  application: Uint8Array;
}

/**
 * Builds the flash a build would be programmed onto.
 *
 * Anything not supplied is left erased, which is what an unwritten region of a
 * real flash reads as.
 */
export function createFlashFromBuild(contents: Esp32C3FlashContents, sizeBytes?: number): SerialNorFlash {
  const regions: FlashRegion[] = [];
  const add = (offset: number, data: Uint8Array | undefined): void => {
    if (data && data.length > 0) regions.push({ offset, data });
  };
  add(ESP32C3_FLASH_LAYOUT.bootloader, contents.bootloader);
  add(ESP32C3_FLASH_LAYOUT.partitionTable, contents.partitionTable);
  add(ESP32C3_FLASH_LAYOUT.otaSelect, contents.otaSelect);
  add(ESP32C3_FLASH_LAYOUT.application, contents.application);
  return new SerialNorFlash({ sizeBytes, regions });
}
