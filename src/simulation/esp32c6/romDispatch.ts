// Choosing a ROM table by chip, which on these parts is not optional.
//
// The C3 and the C6 both publish their mask-ROM entry points, and the two sets
// overlap numerically while meaning different things. 0x40000434 is `qsort` on
// a C3; on a C6 the same address is a different routine entirely. A dispatcher
// that looked up a bare address in one global table would not fault when given
// the wrong chip's firmware — it would silently call the wrong function, and
// the damage would surface much later as something that looked like an
// emulator bug.
//
// So the address alone never determines the function. The chip determines the
// table, and the table determines the function.
//
// What is shared is the behaviour. `memset` means the same thing on both
// parts, and its implementation is written once; only the address it answers
// at is chip-specific.

import {
  ESP32C3_ROM_FUNCTIONS,
  UnimplementedRomCallError,
  type RomFunction,
} from '../esp32c3/romFunctions';
import { ESP32C6_ROM_ADDRESSES, NOT_PUBLISHED_ON_C6 } from './romAddresses';
import { ESP32C6_ROM_WATCHDOG } from './romWatchdog';
import { ESP32C6_ROM_HEAP } from './romHeap';
import { ESP32C6_ROM_SYSTIMER } from './romSysTimer';
import { ESP32C6_ROM_FLASH } from './romFlash';
import { ESP32C6_ROM_NEWLIB } from './romNewlib';
import { romGpioFunctions, ESP32C6_ROM_GPIO_LAYOUT, ESP32C6_ROM_GPIO_ADDRESSES } from '../espRiscv/romGpio';
import { ESP32C6_ROM_SOFT_FLOAT } from '../espRiscv/romSoftFloat';

/** Chips this runtime can dispatch ROM calls for. */
export type EspRomChip = 'esp32c3' | 'esp32c6';

export class WrongChipRomTableError extends Error {
  constructor(expected: EspRomChip, actual: EspRomChip) {
    super(
      `A ${actual} ROM table was given to an ${expected} machine. These parts publish different functions at the ` +
        'same addresses, so using one chip\'s table on another would call the wrong routine without failing. ' +
        'CircuitDesk refuses rather than guessing.',
    );
    this.name = 'WrongChipRomTableError';
  }
}

/** A ROM table that knows which chip it belongs to. */
export interface ChipRomTable {
  chip: EspRomChip;
  /** Entry points by address, for that chip only. */
  entries: Map<number, RomFunction>;
  /** Names this chip's ROM does not publish, recorded so a call fails clearly. */
  absent: ReadonlySet<string>;
}

/**
 * Builds the C6 table from the shared implementations.
 *
 * Every entry takes its behaviour from the C3 function of the same name and
 * its address from the C6's own linker scripts. A name the C6 does not publish
 * is left out rather than given the C3's address — the whole point.
 */
function buildEsp32C6Table(): ChipRomTable {
  const byName = new Map(ESP32C3_ROM_FUNCTIONS.map((f) => [f.name, f]));
  const entries = new Map<number, RomFunction>();
  for (const [name, address] of Object.entries(ESP32C6_ROM_ADDRESSES)) {
    const shared = byName.get(name);
    if (!shared) continue;
    entries.set(address >>> 0, {
      address: address >>> 0,
      name: shared.name,
      handler: shared.handler,
      rationale: shared.rationale,
    });
  }
  // Entry points this part publishes and the C3 does not, so they have no
  // shared implementation to borrow. The watchdog HAL is the whole of it: the
  // C3 links its own copy into the application, and the C6's ROM provides one.
  // The GPIO routines are shared too, but bound to the C6's own block addresses
  // and field widths rather than borrowed by name.
  const gpio = romGpioFunctions(ESP32C6_ROM_GPIO_LAYOUT, ESP32C6_ROM_GPIO_ADDRESSES);
  for (const entry of [...ESP32C6_ROM_WATCHDOG, ...ESP32C6_ROM_HEAP, ...ESP32C6_ROM_SYSTIMER, ...ESP32C6_ROM_FLASH, ...ESP32C6_ROM_NEWLIB, ...gpio, ...ESP32C6_ROM_SOFT_FLOAT]) {
    entries.set(entry.address >>> 0, entry);
  }
  return { chip: 'esp32c6', entries, absent: new Set(NOT_PUBLISHED_ON_C6) };
}

function buildEsp32C3Table(): ChipRomTable {
  return {
    chip: 'esp32c3',
    entries: new Map(ESP32C3_ROM_FUNCTIONS.map((f) => [f.address >>> 0, f])),
    absent: new Set(),
  };
}

const TABLES: Record<EspRomChip, () => ChipRomTable> = {
  esp32c3: buildEsp32C3Table,
  esp32c6: buildEsp32C6Table,
};

/** The ROM table for a chip. Never call this with a guess. */
export function romTableFor(chip: EspRomChip): ChipRomTable {
  return TABLES[chip]();
}

/**
 * Looks up a ROM entry point, refusing a table that belongs to another chip.
 *
 * The chip is passed as well as the table so the mismatch is caught here
 * rather than becoming a wrong call. It is cheap, and it is the one check that
 * makes the whole arrangement safe.
 */
export function dispatchRom(table: ChipRomTable, chip: EspRomChip, address: number): RomFunction {
  if (table.chip !== chip) throw new WrongChipRomTableError(chip, table.chip);
  const entry = table.entries.get(address >>> 0);
  if (entry) return entry;
  throw new UnimplementedRomCallError(address >>> 0, undefined, 0);
}

/** True when a name is implemented for the C3 but not published by the C6. */
export function isAbsentOnChip(table: ChipRomTable, name: string): boolean {
  return table.absent.has(name);
}
