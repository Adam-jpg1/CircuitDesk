// The ESP32-C6's ROM flash driver.
//
// The fourth family the C6's mask ROM publishes and the C3's does not: the C3
// links `esp_flash` into the application, and the C6 boots on the ROM's copy.
// Startup calls `spi_flash_guard_set` before it has done anything else with the
// flash, so without these a C6 stops there.
//
// Written from the documented interfaces in `esp_flash.h`, `esp_spi_flash.h`
// and `spi_flash_mmap.h`. No ROM code was read, disassembled or copied.
//
// Two things make this honest rather than a set of success returns:
//
//   * Reads come from the same `SerialNorFlash` the cache reads through, so a
//     sketch that reads its own partition table gets the bytes that were
//     actually flashed, and a sketch that writes and reads back sees what it
//     wrote.
//   * `spi_flash_cache2phys` and its inverse go through the real flash MMU, by
//     the same index/content port the firmware itself would use. That matters
//     beyond tidiness: `esp_ota_get_running_partition` inverts this mapping to
//     find out which partition it is executing from, and an answer invented
//     here would make a sketch believe it was running from the wrong one.

import type { RomCallContext, RomFunction, RomHandler } from '../esp32c3/romFunctions';
import type { FlashBytes } from '../espRiscv/peripheral';
import { ESP32C6_SPI0_BASE } from './flashMmu';
import { ESP32C6_SOC, MMU_PAGE_SIZE } from '../espRiscv/soc';

/** ESP_OK, and the two error codes these entry points can return. */
const ESP_OK = 0;
const ESP_ERR_INVALID_ARG = 0x102;
const ESP_ERR_INVALID_SIZE = 0x104;

/** SPI_MEM_MMU_ITEM_CONTENT_REG / _INDEX_REG, relative to SPI0. */
const MMU_ITEM_CONTENT = ESP32C6_SPI0_BASE + 0x37c;
const MMU_ITEM_INDEX = ESP32C6_SPI0_BASE + 0x380;

const { entryCount, pageMask, vaddrMask, validity } = ESP32C6_SOC.mmu;
const MMU_VALID = validity.bit;

const STATE_KEY = 'esp32c6.flash';

interface RomFlashState {
  /** The guard callbacks the firmware registered around flash operations. */
  guard: number;
  /** The OS functions the mmap layer was given. */
  mmapOsFuncs: number;
  /** Pages the mmap layer was told the flash has. */
  mmapPageCount: number;
  /** Whether the driver has reported itself initialised. */
  driverInitialised: boolean;
  /** The device, kept here because a ROM handler is only handed the bus. */
  flash: FlashBytes | undefined;
}

function stateOf(context: RomCallContext): RomFlashState {
  let state = context.machine.chipState.get(STATE_KEY) as RomFlashState | undefined;
  if (!state) {
    state = { guard: 0, mmapOsFuncs: 0, mmapPageCount: 0, driverInitialised: false, flash: undefined };
    context.machine.chipState.set(STATE_KEY, state);
  }
  return state;
}

/**
 * Tells this family which flash device it is driving.
 *
 * Called when a C6 machine is assembled, and again after a reset, because the
 * chip-state bag is cleared with everything else.
 */
export function installRomFlashDevice(machineState: { chipState: Map<string, unknown> }, flash: FlashBytes | undefined): void {
  const state = (machineState.chipState.get(STATE_KEY) as RomFlashState | undefined) ?? {
    guard: 0,
    mmapOsFuncs: 0,
    mmapPageCount: 0,
    driverInitialised: false,
    flash: undefined,
  };
  state.flash = flash;
  machineState.chipState.set(STATE_KEY, state);
}

// -------------------------------------------------------------- MMU access

/** Reads one MMU entry through the port, which is the only way in on this part. */
function mmuEntry(context: RomCallContext, index: number): number {
  context.bus.writeUint32(MMU_ITEM_INDEX, index % entryCount);
  return context.bus.readUint32(MMU_ITEM_CONTENT) >>> 0;
}

/**
 * `spi_flash_cache2phys(cached)`.
 *
 * Returns the flash offset a cache address is mapped to, or
 * SPI_FLASH_CACHE2PHYS_FAIL for an unmapped page — the answer ESP-IDF treats as
 * a failure rather than a guess.
 */
const cache2phys: RomHandler = (context) => {
  const address = context.args[0] >>> 0;
  const { irom } = ESP32C6_SOC.memory;
  if (address < irom.start || address >= irom.end) return -1;
  const entry = mmuEntry(context, ((address & vaddrMask) >>> 16) % entryCount);
  if ((entry & MMU_VALID) === 0) return -1;
  return ((entry & pageMask) * MMU_PAGE_SIZE + (address & (MMU_PAGE_SIZE - 1))) >>> 0;
};

/**
 * `spi_flash_phys2cache(phys, memory)`.
 *
 * The inverse: the cache address a flash offset is visible at, found by asking
 * every entry rather than by assuming an identity mapping. The C6 has one
 * window serving both buses, so the `memory` argument does not select between
 * two ranges as it does on the C3.
 */
const phys2cache: RomHandler = (context) => {
  const physical = context.args[0] >>> 0;
  const page = Math.floor(physical / MMU_PAGE_SIZE);
  const { irom } = ESP32C6_SOC.memory;
  for (let index = 0; index < entryCount; index++) {
    const entry = mmuEntry(context, index);
    if ((entry & MMU_VALID) === 0) continue;
    if ((entry & pageMask) !== page) continue;
    return (irom.start + index * MMU_PAGE_SIZE + (physical % MMU_PAGE_SIZE)) >>> 0;
  }
  return -1;
};

// ------------------------------------------------------------ esp_flash API

/** `esp_flash_get_size(chip, out_size)`. */
const getSize: RomHandler = (context) => {
  const flash = stateOf(context).flash;
  const out = context.args[1] >>> 0;
  if (!flash) return ESP_ERR_INVALID_ARG;
  if (out !== 0) context.bus.writeUint32(out, flash.sizeBytes >>> 0);
  return ESP_OK;
};

/** `spi_flash_get_chip_size()`, the older call that returns the size directly. */
const getChipSize: RomHandler = (context) => stateOf(context).flash?.sizeBytes ?? 0;

/**
 * `esp_flash_read(chip, buffer, address, length)`.
 *
 * The bytes really come from the flash device, so what a sketch reads back is
 * what was flashed — or what it wrote a moment ago.
 */
const readFlash: RomHandler = (context) => {
  const flash = stateOf(context).flash;
  if (!flash) return ESP_ERR_INVALID_ARG;
  const buffer = context.args[1] >>> 0;
  const address = context.args[2] >>> 0;
  const length = context.args[3] >>> 0;
  if (address + length > flash.sizeBytes) return ESP_ERR_INVALID_SIZE;
  for (let i = 0; i < length; i++) context.bus.writeUint8((buffer + i) >>> 0, flash.bytes[address + i]);
  return ESP_OK;
};

/**
 * `esp_flash_read_id(chip, out_id)`.
 *
 * The identifier is the device's own, in the order a JEDEC read returns it:
 * manufacturer, then the two type bytes.
 */
const readId: RomHandler = (context) => {
  const flash = stateOf(context).flash as { id?: { manufacturer: number; memoryType: number; capacity: number } } | undefined;
  const out = context.args[1] >>> 0;
  if (!flash?.id) return ESP_ERR_INVALID_ARG;
  if (out !== 0) {
    context.bus.writeUint32(out, ((flash.id.manufacturer << 16) | (flash.id.memoryType << 8) | flash.id.capacity) >>> 0);
  }
  return ESP_OK;
};

const chipDriverInitialised: RomHandler = (context) => (stateOf(context).flash ? 1 : 0);

// ---------------------------------------------------------------- the rest

const guardSet: RomHandler = (context) => {
  stateOf(context).guard = context.args[0] >>> 0;
  return ESP_OK;
};

const guardGet: RomHandler = (context) => stateOf(context).guard;

const mmapOsFuncSet: RomHandler = (context) => {
  stateOf(context).mmapOsFuncs = context.args[0] >>> 0;
  return ESP_OK;
};

const mmapPageNumInit: RomHandler = (context) => {
  stateOf(context).mmapPageCount = context.args[0] >>> 0;
  return ESP_OK;
};

/**
 * `spi_flash_mmap_get_free_pages(memory)`.
 *
 * Counted from the real MMU table rather than reported as a constant, so a
 * firmware that maps a partition and asks again gets a smaller answer.
 */
const mmapFreePages: RomHandler = (context) => {
  let free = 0;
  for (let index = 0; index < entryCount; index++) {
    if ((mmuEntry(context, index) & MMU_VALID) === 0) free++;
  }
  return free;
};

/**
 * The cache is always on in this runtime.
 *
 * `rom_spi_flash_disable_cache` and its partner exist so a driver can write to
 * flash while running from it. Nothing here executes out of a stale cache line
 * — the cache windows read through the MMU on every access rather than from a
 * copy — so there is no window to close, and saying so is the truthful answer
 * rather than pretending to a state this machine does not have.
 */
const cacheEnabled: RomHandler = () => 1;

/** Accepts the disable/restore pair without pretending to a cache state. */
const cacheNoop: RomHandler = () => ESP_OK;

/**
 * Attaching the flash, selecting its pads, fixing dummy cycles and switching
 * quad mode are all configuration of the SPI controller and the pads.
 *
 * The controller is modelled, the flash device behind it is modelled, and this
 * runtime reads the device through the MMU rather than through a timed serial
 * transaction — so the number of dummy cycles and whether the bus is running in
 * quad mode change nothing observable. They are accepted rather than refused,
 * and nothing claims the bus timing is simulated.
 */
const configurationNoop: RomHandler = () => ESP_OK;

/**
 * The flash entry points the C6's ROM publishes.
 *
 * Addresses are from `esp32c6.rom.spiflash.ld` in the same core the firmware
 * was built with, under the symbol that script gives each one. Only the ones
 * real firmware reaches are here; the rest of the family will be added when
 * something is shown to call them, rather than guessed at now.
 */
export const ESP32C6_ROM_FLASH: RomFunction[] = [
  {
    address: 0x400001c4,
    name: 'SelectSpiFunction',
    handler: configurationNoop,
    rationale: 'Pad selection for the flash bus, which this runtime reads through the MMU instead.',
  },
  {
    address: 0x400001c8,
    name: 'SetSpiDrvs',
    handler: configurationNoop,
    rationale: 'Pad drive strength, which has no observable effect without analog modelling.',
  },
  {
    address: 0x400001cc,
    name: 'Wait_SPI_Idle',
    handler: configurationNoop,
    rationale: 'The controller completes each transaction within the register write, so it is never busy.',
  },
  {
    address: 0x400001d0,
    name: 'spi_dummy_len_fix',
    handler: configurationNoop,
    rationale: 'Dummy-cycle tuning, which matters to bus timing and not to what is read.',
  },
  {
    address: 0x400001d4,
    name: 'Disable_QMode',
    handler: configurationNoop,
    rationale: 'Bus width; the device answers the same bytes either way here.',
  },
  {
    address: 0x400001d8,
    name: 'Enable_QMode',
    handler: configurationNoop,
    rationale: 'The same in the other direction.',
  },
  {
    address: 0x400001dc,
    name: 'spi_flash_attach',
    handler: configurationNoop,
    rationale: 'Binds the controller to the pads; the device is already attached in this machine.',
  },
  {
    address: 0x400001e0,
    name: 'spi_flash_get_chip_size',
    handler: getChipSize,
    rationale: 'Answers from the device rather than a constant, so a differently sized flash reports differently.',
  },
  {
    address: 0x400001e4,
    name: 'spi_flash_guard_set',
    handler: guardSet,
    rationale: 'Records the guard callbacks; firmware reads them back through the getter.',
  },
  {
    address: 0x400001e8,
    name: 'spi_flash_guard_get',
    handler: guardGet,
    rationale: 'Returns exactly what was set, rather than null.',
  },
  {
    address: 0x400001f0,
    name: 'rom_spi_flash_disable_cache',
    handler: cacheNoop,
    rationale: 'There is no stale cache line to close a window against in this machine.',
  },
  {
    address: 0x400001f4,
    name: 'rom_spi_flash_restore_cache',
    handler: cacheNoop,
    rationale: 'The matching restore.',
  },
  {
    address: 0x400001f8,
    name: 'spi_flash_cache_enabled',
    handler: cacheEnabled,
    rationale: 'The cache windows always read through the MMU here, so it is always on.',
  },
  {
    address: 0x40000200,
    name: 'esp_enable_cache_flash_wrap',
    handler: configurationNoop,
    rationale: 'Burst wrapping is a bus optimisation with no effect on the bytes delivered.',
  },
  {
    address: 0x40000204,
    name: 'spi_flash_mmap_os_func_set',
    handler: mmapOsFuncSet,
    rationale: 'Records the OS hooks the mmap layer was given.',
  },
  {
    address: 0x40000208,
    name: 'spi_flash_mmap_page_num_init',
    handler: mmapPageNumInit,
    rationale: 'Records how many pages firmware believes the flash has.',
  },
  {
    address: 0x4000021c,
    name: 'spi_flash_check_and_flush_cache',
    handler: cacheNoop,
    rationale: 'Nothing to flush: a cache read goes to the flash page on every access.',
  },
  {
    address: 0x40000220,
    name: 'spi_flash_mmap_get_free_pages',
    handler: mmapFreePages,
    rationale: 'Counted from the real MMU table, so mapping a partition changes the answer.',
  },
  {
    address: 0x40000224,
    name: 'spi_flash_cache2phys',
    handler: cache2phys,
    rationale: 'Inverts the real mapping, which is how firmware finds the partition it is running from.',
  },
  {
    address: 0x40000228,
    name: 'spi_flash_phys2cache',
    handler: phys2cache,
    rationale: 'Searches the real table rather than assuming an identity mapping.',
  },
  {
    address: 0x4000022c,
    name: 'esp_flash_chip_driver_initialized',
    handler: chipDriverInitialised,
    rationale: 'True only when a device is genuinely attached to this machine.',
  },
  {
    address: 0x40000230,
    name: 'esp_flash_read_id',
    handler: readId,
    rationale: 'Reports the device\'s own JEDEC identifier, in the order a read returns it.',
  },
  {
    address: 0x40000234,
    name: 'esp_flash_get_size',
    handler: getSize,
    rationale: 'The device\'s real size, which partition checks are made against.',
  },
  {
    address: 0x40000254,
    name: 'esp_flash_read',
    handler: readFlash,
    rationale: 'Copies real flash bytes into the caller\'s buffer through the bus.',
  },
];
