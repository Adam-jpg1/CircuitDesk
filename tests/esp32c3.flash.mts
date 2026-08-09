// The SPI NOR flash and the controller that reaches it.
//
// ESP-IDF refuses to boot without a flash that answers, so these check the
// behaviours it depends on: identification, reads that return what was
// programmed, and the erase-before-program rule that makes NOR flash NOR
// flash. The controller is driven exactly as firmware drives it — build a
// transaction in the registers, set the start bit, read the result back — so a
// decode error shows up here rather than as a mysterious boot failure.

import {
  SerialNorFlash,
  GD25Q32_ID,
  FLASH_COMMAND,
  FLASH_PAGE_SIZE,
  FLASH_SECTOR_SIZE,
  FlashError,
  createFlashFromBuild,
  ESP32C3_FLASH_LAYOUT,
} from '../src/simulation/esp32c3/spiFlash';
import { SpiMemController } from '../src/simulation/esp32c3/spiMem';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const bytes = (...values: number[]) => Uint8Array.from(values);

// ---------- 1. the device itself ----------
{
  const flash = new SerialNorFlash();
  check(flash.sizeBytes === 4 * 1024 * 1024, `the modelled part is 4 MB (${flash.sizeBytes} bytes)`);
  check(
    flash.bytes.every((b) => b === 0xff),
    'an unprogrammed flash reads as 0xFF everywhere',
  );

  const id = flash.transfer(FLASH_COMMAND.readId, 0, bytes(), 3);
  check(
    id[0] === GD25Q32_ID.manufacturer && id[1] === GD25Q32_ID.memoryType && id[2] === GD25Q32_ID.capacity,
    `RDID returns the part's identifier (${[...id].map((b) => b.toString(16)).join(' ')})`,
  );
  check(1 << id[2] === flash.sizeBytes, 'and its capacity byte decodes to the actual size');

  // A program needs the write-enable latch, exactly as on hardware.
  flash.transfer(FLASH_COMMAND.pageProgram, 0x100, bytes(0xaa), 0);
  check(flash.transfer(FLASH_COMMAND.read, 0x100, bytes(), 1)[0] === 0xff, 'a program without WREN does nothing');

  flash.transfer(FLASH_COMMAND.writeEnable, 0, bytes(), 0);
  flash.transfer(FLASH_COMMAND.pageProgram, 0x100, bytes(0xaa, 0x55), 0);
  const read = flash.transfer(FLASH_COMMAND.read, 0x100, bytes(), 2);
  check(read[0] === 0xaa && read[1] === 0x55, 'a program after WREN writes the bytes');
  check(
    flash.transfer(FLASH_COMMAND.readStatus1, 0, bytes(), 1)[0] === 0,
    'the write-enable latch clears once the program finishes',
  );

  // NOR programming clears bits and cannot set them.
  flash.transfer(FLASH_COMMAND.writeEnable, 0, bytes(), 0);
  flash.transfer(FLASH_COMMAND.pageProgram, 0x100, bytes(0xff), 0);
  check(
    flash.transfer(FLASH_COMMAND.read, 0x100, bytes(), 1)[0] === 0xaa,
    'programming 0xFF over 0xAA leaves 0xAA — a program cannot set bits back',
  );

  flash.transfer(FLASH_COMMAND.writeEnable, 0, bytes(), 0);
  flash.transfer(FLASH_COMMAND.pageProgram, 0x100, bytes(0x0f), 0);
  check(
    flash.transfer(FLASH_COMMAND.read, 0x100, bytes(), 1)[0] === 0x0a,
    'programming 0x0F over 0xAA gives 0x0A, the bitwise AND',
  );

  // An erase restores the whole sector.
  flash.transfer(FLASH_COMMAND.writeEnable, 0, bytes(), 0);
  flash.transfer(FLASH_COMMAND.sectorErase, 0x100, bytes(), 0);
  check(flash.transfer(FLASH_COMMAND.read, 0x100, bytes(), 1)[0] === 0xff, 'a sector erase restores 0xFF');

  // The erase covers the sector the address falls in, not a range starting there.
  flash.transfer(FLASH_COMMAND.writeEnable, 0, bytes(), 0);
  flash.transfer(FLASH_COMMAND.pageProgram, 0x000, bytes(0x11), 0);
  flash.transfer(FLASH_COMMAND.writeEnable, 0, bytes(), 0);
  flash.transfer(FLASH_COMMAND.sectorErase, 0x800, bytes(), 0);
  check(
    flash.transfer(FLASH_COMMAND.read, 0x000, bytes(), 1)[0] === 0xff,
    'erasing an address inside a sector erases the whole sector',
  );

  // A neighbouring sector must survive it.
  flash.transfer(FLASH_COMMAND.writeEnable, 0, bytes(), 0);
  flash.transfer(FLASH_COMMAND.pageProgram, FLASH_SECTOR_SIZE, bytes(0x22), 0);
  flash.transfer(FLASH_COMMAND.writeEnable, 0, bytes(), 0);
  flash.transfer(FLASH_COMMAND.sectorErase, 0, bytes(), 0);
  check(
    flash.transfer(FLASH_COMMAND.read, FLASH_SECTOR_SIZE, bytes(), 1)[0] === 0x22,
    'and leaves the next sector alone',
  );

  // A program wraps within its page rather than spilling into the next.
  flash.transfer(FLASH_COMMAND.writeEnable, 0, bytes(), 0);
  flash.transfer(FLASH_COMMAND.pageProgram, FLASH_PAGE_SIZE - 1, bytes(0x01, 0x02), 0);
  check(
    flash.transfer(FLASH_COMMAND.read, FLASH_PAGE_SIZE, bytes(), 1)[0] === 0xff,
    'a program running past the end of a page does not touch the next page',
  );
  check(flash.transfer(FLASH_COMMAND.read, 0, bytes(), 1)[0] === 0x02, 'it wraps to the start of its own page instead');

  let refused = false;
  try {
    flash.transfer(0x7c, 0, bytes(), 0);
  } catch (error) {
    refused = error instanceof FlashError && /0x7c/.test((error as Error).message);
  }
  check(refused, 'an unimplemented flash command is refused by name rather than ignored');
}

// ---------- 2. flash built from a real set of artifacts ----------
{
  const bootloader = new Uint8Array(64).fill(0xb0);
  const partitionTable = new Uint8Array(32).fill(0x50);
  const application = new Uint8Array(128).fill(0xa0);
  const flash = createFlashFromBuild({ bootloader, partitionTable, application });

  check(flash.bytes[ESP32C3_FLASH_LAYOUT.bootloader] === 0xb0, 'the bootloader lands at offset 0');
  check(flash.bytes[ESP32C3_FLASH_LAYOUT.partitionTable] === 0x50, 'the partition table lands at 0x8000');
  check(flash.bytes[ESP32C3_FLASH_LAYOUT.application] === 0xa0, 'the application lands at 0x10000');
  check(flash.bytes[ESP32C3_FLASH_LAYOUT.otaSelect] === 0xff, 'an artifact that was not supplied leaves erased flash');
}

// ---------- 3. the controller, driven the way firmware drives it ----------
{
  const CMD = 0x00;
  const ADDR = 0x04;
  const USER = 0x18;
  const USER1 = 0x1c;
  const USER2 = 0x20;
  const MOSI_DLEN = 0x24;
  const MISO_DLEN = 0x28;
  const W0 = 0x58;
  const USR = 1 << 18;

  const application = new Uint8Array(16);
  for (let i = 0; i < application.length; i++) application[i] = i + 1;
  const flash = createFlashFromBuild({ application });
  const controller = new SpiMemController(flash);

  /** Builds and runs a user transaction exactly as the flash driver does. */
  const run = (options: {
    command?: number;
    address?: number;
    addressBits?: number;
    mosi?: number[];
    misoBytes?: number;
  }): Uint8Array => {
    let user = 0;
    if (options.command !== undefined) {
      user |= 1 << 31;
      controller.writeUint32(USER2, ((8 - 1) << 28) | options.command);
    }
    if (options.address !== undefined) {
      const bits = options.addressBits ?? 24;
      user |= 1 << 30;
      controller.writeUint32(USER1, ((bits - 1) << 26) >>> 0);
      controller.writeUint32(ADDR, (options.address << (32 - bits)) >>> 0);
    }
    if (options.mosi) {
      user |= 1 << 27;
      controller.writeUint32(MOSI_DLEN, options.mosi.length * 8 - 1);
      for (let i = 0; i < options.mosi.length; i += 4) {
        let word = 0;
        for (let b = 0; b < 4; b++) word |= (options.mosi[i + b] ?? 0) << (b * 8);
        controller.writeUint32(W0 + (i >> 2) * 4, word >>> 0);
      }
    }
    if (options.misoBytes) {
      user |= 1 << 28;
      controller.writeUint32(MISO_DLEN, options.misoBytes * 8 - 1);
    }
    controller.writeUint32(USER, user >>> 0);
    controller.writeUint32(CMD, USR);

    const out = new Uint8Array(options.misoBytes ?? 0);
    for (let i = 0; i < out.length; i++) {
      out[i] = (controller.readUint32(W0 + (i >> 2) * 4) >>> ((i & 3) * 8)) & 0xff;
    }
    return out;
  };

  check(controller.readUint32(CMD) === 0, 'the start bit is clear once the transaction has run');

  const id = run({ command: FLASH_COMMAND.readId, misoBytes: 3 });
  check(
    id[0] === GD25Q32_ID.manufacturer && id[1] === GD25Q32_ID.memoryType && id[2] === GD25Q32_ID.capacity,
    `a user-mode RDID reaches the device and its answer reaches the buffer (${[...id].join(',')})`,
  );

  const data = run({ command: FLASH_COMMAND.read, address: ESP32C3_FLASH_LAYOUT.application, misoBytes: 8 });
  check(
    [...data].join(',') === '1,2,3,4,5,6,7,8',
    `a read returns the bytes actually at that offset (${[...data].join(',')})`,
  );

  // The address is clocked out most-significant bit first, so it sits at the
  // top of ADDR. Decoding it from the bottom would read the wrong place.
  const later = run({ command: FLASH_COMMAND.read, address: ESP32C3_FLASH_LAYOUT.application + 4, misoBytes: 4 });
  check([...later].join(',') === '5,6,7,8', 'and a different address returns different bytes');

  run({ command: FLASH_COMMAND.writeEnable });
  const status = run({ command: FLASH_COMMAND.readStatus1, misoBytes: 1 });
  check((status[0] & 0x2) !== 0, 'a write-enable through the controller sets the latch the device reports');

  run({ command: FLASH_COMMAND.pageProgram, address: 0x1000, mosi: [0xde, 0xad] });
  const programmed = run({ command: FLASH_COMMAND.read, address: 0x1000, misoBytes: 2 });
  check(programmed[0] === 0xde && programmed[1] === 0xad, 'data written to the buffer is programmed into the device');

  check(controller.recent.length > 0, 'transactions are recorded for diagnostics');
  check(
    controller.recent[controller.recent.length - 1].command === FLASH_COMMAND.read,
    'and the record names the command that ran',
  );
}

console.log(failures === 0 ? '\nESP32-C3 flash checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
