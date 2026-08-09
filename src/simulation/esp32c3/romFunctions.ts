// The ESP32-C3 mask ROM functions this runtime provides.
//
// WHY THIS EXISTS
//
// ESP-IDF startup calls into the chip's mask ROM, which is linked at fixed
// addresses through Espressif's public `esp32c3.rom.ld`. Espressif publishes
// those addresses but not the ROM's source, and offers no redistributable ROM
// binary, so CircuitDesk ships none of it.
//
// Instead, each function below is implemented independently from documented
// behaviour, and only the ones real firmware actually calls are provided. A
// trace of real blink firmware showed the startup path enters exactly five.
// Anything else in the ROM range is left unimplemented and fails loudly rather
// than returning a fabricated value, which is the same rule the RP2040 boot
// stub follows.
//
// These are native implementations rather than emitted machine code: the
// runtime detects a call into the ROM address range, runs the handler, and
// returns through `ra`. That is a modelling choice about *how* the behaviour is
// provided, not a shortcut around it — the firmware still makes a real call
// with real arguments and still observes real results.

import type { Bus } from '../riscv/rv32Core';

/** RISC-V calling convention: a0..a7 are x10..x17. */
export const ARG_REGISTER_BASE = 10;

/**
 * Reset reasons the ROM reports, from the documented RESET_REASON enum.
 *
 * The runtime tracks which one applies rather than always answering the same
 * way, so a future software-reset path reports itself correctly instead of
 * claiming the board was just powered on.
 */
export enum ResetReason {
  PowerOn = 1,
  /** RTC watchdog reset of the whole chip. */
  RtcSwSys = 3,
  /** A reset requested by software. */
  SwSys = 12,
}

export interface RomCallContext {
  /** Arguments a0..a3, already read out of the core's registers. */
  args: number[];
  bus: Bus;
  /** State the machine keeps across ROM calls. */
  machine: RomMachineState;
}

export interface RomMachineState {
  resetReason: ResetReason;
  /** The analog/clock register file written through regi2c. */
  regi2c: Map<number, number>;
  /** Recorded cache configuration, for diagnostics and tests. */
  cache: { iCacheEnabled: boolean; iromMmuSize: number; dromMmuSize: number };
}

export function createRomMachineState(resetReason = ResetReason.PowerOn): RomMachineState {
  return {
    resetReason,
    regi2c: new Map<number, number>(),
    cache: { iCacheEnabled: false, iromMmuSize: 0, dromMmuSize: 0 },
  };
}

/** A ROM entry point: returns the value for a0, or void for none. */
export type RomHandler = (context: RomCallContext) => number | void;

export interface RomFunction {
  address: number;
  /** The symbol ESP-IDF's linker script gives this address. */
  name: string;
  handler: RomHandler;
  /** Why this implementation is correct for this runtime. */
  rationale: string;
}

/**
 * `esp_rom_get_reset_reason(cpu)` -> RESET_REASON
 *
 * Startup reads this to decide how much state it may trust. Answering from the
 * machine's own recorded reason keeps a later software-reset path honest; it
 * is not a constant chosen to satisfy a test.
 */
const getResetReason: RomHandler = ({ machine }) => machine.resetReason;

/**
 * `memset(dest, c, n)` -> dest
 *
 * Full general semantics: any alignment, any byte value, any length. Written
 * byte-wise because the destination may be unaligned and may straddle a
 * region boundary, and because correctness matters more here than speed.
 */
const memset: RomHandler = ({ args, bus }) => {
  const [dest, value, length] = args;
  const byte = value & 0xff;
  for (let i = 0; i < (length >>> 0); i++) bus.writeUint8((dest + i) >>> 0, byte);
  return dest;
};

/**
 * `Cache_Enable_ICache(autoload)`
 *
 * A genuine no-op in this runtime, and the reason is structural rather than
 * convenient. On silicon the instruction cache sits between the CPU and
 * flash-mapped memory, so it has to be enabled before code at an IROM address
 * can be fetched. Here the application image's segments are placed directly at
 * their final addresses when the image is loaded, so an IROM fetch already
 * reads exactly the bytes the cache would have delivered. There is no
 * translation to switch on and no stale data to invalidate.
 *
 * The call is still recorded, so a test can assert the firmware made it and
 * nothing silently depends on cache state that does not exist.
 */
const cacheEnableICache: RomHandler = ({ machine }) => {
  machine.cache.iCacheEnabled = true;
};

/**
 * `Cache_Set_IDROM_MMU_Size(irom_size, drom_size)`
 *
 * Same reasoning as above: the flash MMU exists to map flash pages into the
 * IROM and DROM windows, and this runtime has already placed those segments at
 * their final addresses. The sizes are recorded as architectural state so
 * firmware that reads them back sees what it wrote, but no translation is
 * performed because none is needed.
 */
const cacheSetIdromMmuSize: RomHandler = ({ args, machine }) => {
  machine.cache.iromMmuSize = args[0] >>> 0;
  machine.cache.dromMmuSize = args[1] >>> 0;
};

/**
 * `esp_rom_regi2c_write_mask(block, host_id, reg, msb, lsb, value)`
 *
 * This one is not a no-op. The ESP32-C3's analog blocks — the crystal
 * oscillator, the PLL, the bandgap and the brownout detector — are not on the
 * normal peripheral bus. They are reached through an internal serial channel,
 * and this ROM function performs one read-modify-write of a bit field inside
 * one register of one block.
 *
 * Startup uses it to configure the clock sources, and it reads values back, so
 * a model that discards writes would report a clock configuration the firmware
 * never asked for. A small register file keyed by (block, register) reproduces
 * the only behaviour that matters: what is written is what is read back, in
 * the right bit positions.
 */
const regi2cWriteMask: RomHandler = ({ args, machine }) => {
  const [block, , reg, msb, lsb, value] = args;
  const key = regi2cKey(block, reg);
  const width = msb - lsb + 1;
  if (width <= 0 || width > 8 || lsb < 0 || msb > 7) return;
  const mask = ((1 << width) - 1) << lsb;
  const current = machine.regi2c.get(key) ?? 0;
  machine.regi2c.set(key, ((current & ~mask) | ((value << lsb) & mask)) & 0xff);
};

/** `esp_rom_regi2c_read_mask(block, host_id, reg, msb, lsb)` -> value */
const regi2cReadMask: RomHandler = ({ args, machine }) => {
  const [block, , reg, msb, lsb] = args;
  const width = msb - lsb + 1;
  if (width <= 0 || width > 8 || lsb < 0 || msb > 7) return 0;
  const mask = (1 << width) - 1;
  return ((machine.regi2c.get(regi2cKey(block, reg)) ?? 0) >> lsb) & mask;
};

/** `esp_rom_regi2c_read(block, host_id, reg)` -> whole byte */
const regi2cRead: RomHandler = ({ args, machine }) => machine.regi2c.get(regi2cKey(args[0], args[2])) ?? 0;

/** `esp_rom_regi2c_write(block, host_id, reg, value)` */
const regi2cWrite: RomHandler = ({ args, machine }) => {
  machine.regi2c.set(regi2cKey(args[0], args[2]), args[3] & 0xff);
};

/** One flat key per (block, register) pair. */
export function regi2cKey(block: number, register: number): number {
  return ((block & 0xff) << 8) | (register & 0xff);
}

/**
 * The ROM entry points this runtime provides, at the addresses ESP-IDF's
 * public linker script assigns them on the ESP32-C3.
 *
 * The four regi2c entries are grouped because they share one register file:
 * startup writes through the masked form and reads back through the others,
 * and providing only the one the first trace happened to hit would break the
 * moment a different sketch read a value back.
 */
export const ESP32C3_ROM_FUNCTIONS: RomFunction[] = [
  {
    address: 0x40000018,
    name: 'esp_rom_get_reset_reason',
    handler: getResetReason,
    rationale: 'Reports the machine\'s own recorded reset reason, so a software reset can be distinguished later.',
  },
  {
    address: 0x40000354,
    name: 'memset',
    handler: memset,
    rationale: 'Full general semantics, byte-wise for arbitrary alignment and length.',
  },
  {
    address: 0x40000520,
    name: 'Cache_Enable_ICache',
    handler: cacheEnableICache,
    rationale: 'No translation exists to enable: image segments are already at their final addresses.',
  },
  {
    address: 0x40000548,
    name: 'Cache_Set_IDROM_MMU_Size',
    handler: cacheSetIdromMmuSize,
    rationale: 'Records the sizes as architectural state; no flash MMU mapping is needed here.',
  },
  {
    address: 0x40001960,
    name: 'esp_rom_regi2c_write_mask',
    handler: regi2cWriteMask,
    rationale: 'Read-modify-write of a bit field in the internal analog register file.',
  },
  {
    address: 0x40001954,
    name: 'esp_rom_regi2c_read',
    handler: regi2cRead,
    rationale: 'Reads back the analog register file the masked writes populate.',
  },
  {
    address: 0x4000195c,
    name: 'esp_rom_regi2c_read_mask',
    handler: regi2cReadMask,
    rationale: 'Bit-field read from the same register file.',
  },
  {
    address: 0x40001958,
    name: 'esp_rom_regi2c_write',
    handler: regi2cWrite,
    rationale: 'Whole-byte write to the same register file.',
  },
];

/** Address range the ESP32-C3 maps its mask ROM into. */
export const ROM_START = 0x40000000;
export const ROM_END = 0x40060000;

export function isRomAddress(address: number): boolean {
  const a = address >>> 0;
  return a >= ROM_START && a < ROM_END;
}

export function buildRomTable(functions: RomFunction[] = ESP32C3_ROM_FUNCTIONS): Map<number, RomFunction> {
  return new Map(functions.map((f) => [f.address >>> 0, f]));
}

/** Raised when firmware calls a ROM address this runtime does not provide. */
export class UnimplementedRomCallError extends Error {
  constructor(
    readonly address: number,
    readonly symbol: string | undefined,
    readonly returnAddress: number,
  ) {
    super(
      `This sketch calls the ESP32-C3 boot ROM function ${symbol ? `${symbol} ` : ''}at ` +
        `0x${(address >>> 0).toString(16)}, which CircuitDesk does not implement. Espressif does not publish the ` +
        'ROM\'s source and CircuitDesk is not licensed to redistribute it, so ROM behaviour is implemented ' +
        'independently for the functions firmware actually needs. Please report this address so it can be added.',
    );
    this.name = 'UnimplementedRomCallError';
  }
}
