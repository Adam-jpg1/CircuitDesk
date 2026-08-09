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
  /** Arguments a0..a5, already read out of the core's registers. */
  args: number[];
  bus: Bus;
  /** State the machine keeps across ROM calls. */
  machine: RomMachineState;
  /**
   * The core's register file, for the few functions whose result does not fit
   * in a0 — the 64-bit division helpers return a pair in a0 and a1.
   */
  registers: Int32Array;
}

export interface RomMachineState {
  resetReason: ResetReason;
  /** The analog/clock register file written through regi2c. */
  regi2c: Map<number, number>;
  /** Recorded cache configuration, for diagnostics and tests. */
  cache: { iCacheEnabled: boolean; iromMmuSize: number; dromMmuSize: number };
  /** What ets_get_cpu_frequency() reports, in MHz. */
  cpuFrequencyMhz: number;
  /** Microseconds a ROM delay asked for, which the runner turns into time. */
  pendingDelayUs: number;
  /** Character sink the ROM's printf was told to use. */
  putc1: number;
}

export function createRomMachineState(resetReason = ResetReason.PowerOn): RomMachineState {
  return {
    resetReason,
    regi2c: new Map<number, number>(),
    cache: { iCacheEnabled: false, iromMmuSize: 0, dromMmuSize: 0 },
    cpuFrequencyMhz: 160,
    pendingDelayUs: 0,
    putc1: 0,
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

// ------------------------------------------------- compiler runtime helpers
//
// The ESP32-C3 ROM carries the parts of libgcc and the C library that ESP-IDF
// links against, so a division of two 64-bit integers in ordinary firmware
// becomes a ROM call. These are implemented from their published signatures,
// not from Espressif's code.
//
// On RV32 a 64-bit argument occupies a register pair, low half first: the two
// arguments arrive as (a0, a1) and (a2, a3), and the result is returned the
// same way. BigInt does the arithmetic because a 64-bit quotient does not fit
// in a JavaScript number exactly.

const asUnsigned64 = (low: number, high: number): bigint => (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
const asSigned64 = (low: number, high: number): bigint => BigInt.asIntN(64, asUnsigned64(low, high));

function return64(registers: Int32Array, value: bigint): number {
  const masked = BigInt.asUintN(64, value);
  registers[ARG_REGISTER_BASE] = Number(masked & 0xffffffffn) | 0;
  registers[ARG_REGISTER_BASE + 1] = Number((masked >> 32n) & 0xffffffffn) | 0;
  return registers[ARG_REGISTER_BASE];
}

/**
 * Division by zero.
 *
 * The C standard leaves it undefined and libgcc's helpers do not trap, so the
 * all-ones result these return matches what the real routines produce rather
 * than raising an exception the firmware has no handler for.
 */
const DIV_BY_ZERO = 0xffffffffffffffffn;

const udivdi3: RomHandler = ({ args, registers }) => {
  const divisor = asUnsigned64(args[2], args[3]);
  const dividend = asUnsigned64(args[0], args[1]);
  return return64(registers, divisor === 0n ? DIV_BY_ZERO : dividend / divisor);
};

const umoddi3: RomHandler = ({ args, registers }) => {
  const divisor = asUnsigned64(args[2], args[3]);
  const dividend = asUnsigned64(args[0], args[1]);
  return return64(registers, divisor === 0n ? dividend : dividend % divisor);
};

const divdi3: RomHandler = ({ args, registers }) => {
  const divisor = asSigned64(args[2], args[3]);
  const dividend = asSigned64(args[0], args[1]);
  if (divisor === 0n) return return64(registers, DIV_BY_ZERO);
  // BigInt division already truncates toward zero, which is what C requires.
  return return64(registers, dividend / divisor);
};

const moddi3: RomHandler = ({ args, registers }) => {
  const divisor = asSigned64(args[2], args[3]);
  const dividend = asSigned64(args[0], args[1]);
  if (divisor === 0n) return return64(registers, dividend);
  return return64(registers, dividend % divisor);
};

/** `strlen(s)` — bytes before the first NUL. */
const strlen: RomHandler = ({ args, bus }) => {
  let length = 0;
  while (bus.readUint8((args[0] + length) >>> 0) !== 0) {
    length++;
    // A string with no terminator would otherwise run the whole address space.
    if (length > 0x10000) break;
  }
  return length;
};

/**
 * `ets_get_cpu_frequency()` -> MHz
 *
 * Answers from the machine's own clock model rather than a constant, so a
 * firmware that changes the CPU frequency sees its own value.
 */
const getCpuFrequency: RomHandler = ({ machine }) => machine.cpuFrequencyMhz;

/**
 * `esp_rom_delay_us(us)`
 *
 * A busy-wait on hardware. Here the caller advances simulated time instead, so
 * the delay is recorded and the machine's clock is moved forward by the runner
 * — spinning through millions of emulated instructions to burn a microsecond
 * would only make the simulation slower, not more accurate.
 */
const delayUs: RomHandler = ({ args, machine }) => {
  machine.pendingDelayUs += args[0] >>> 0;
};

/**
 * `ets_install_putc1(fn)`
 *
 * Records where the ROM's own printf would send characters. Nothing here calls
 * back into firmware, so the pointer is stored for diagnostics only.
 */
const installPutc1: RomHandler = ({ args, machine }) => {
  machine.putc1 = args[0] >>> 0;
};

/**
 * `esp_rom_set_cpu_ticks_per_us(ticks)`
 *
 * Tells the ROM how many CPU cycles make a microsecond, so its delay loop
 * spins the right number of times. Startup calls it whenever it changes the
 * CPU frequency, so storing the value keeps the machine's own clock model and
 * the ROM's agreeing with each other.
 */
const setCpuTicksPerUs: RomHandler = ({ args, machine }) => {
  machine.cpuFrequencyMhz = Math.max(1, args[0] >>> 0);
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
    address: 0x400008ac,
    name: '__udivdi3',
    handler: udivdi3,
    rationale: '64-bit unsigned division from its published signature, via BigInt for exactness.',
  },
  {
    address: 0x400008bc,
    name: '__umoddi3',
    handler: umoddi3,
    rationale: '64-bit unsigned remainder, matching libgcc\'s divide-by-zero behaviour.',
  },
  {
    address: 0x400007b4,
    name: '__divdi3',
    handler: divdi3,
    rationale: '64-bit signed division, truncating toward zero as C requires.',
  },
  {
    address: 0x4000083c,
    name: '__moddi3',
    handler: moddi3,
    rationale: '64-bit signed remainder, taking the dividend\'s sign.',
  },
  {
    address: 0x40000374,
    name: 'strlen',
    handler: strlen,
    rationale: 'Counts bytes before the first NUL, bounded so an unterminated string cannot hang the run.',
  },
  {
    address: 0x40000588,
    name: 'esp_rom_set_cpu_ticks_per_us',
    handler: setCpuTicksPerUs,
    rationale: 'Stores the CPU frequency so the machine and the ROM delay loop agree.',
  },
  {
    address: 0x40000584,
    name: 'ets_get_cpu_frequency',
    handler: getCpuFrequency,
    rationale: 'Answers from the machine\'s own clock model rather than a constant.',
  },
  {
    address: 0x40000050,
    name: 'esp_rom_delay_us',
    handler: delayUs,
    rationale: 'Records the requested delay; the runner advances simulated time instead of spinning.',
  },
  {
    address: 0x40000044,
    name: 'ets_install_putc1',
    handler: installPutc1,
    rationale: 'Stores the ROM printf character sink for diagnostics; nothing calls back into firmware.',
  },
  {
    address: 0x40000524,
    name: 'Cache_Suspend_ICache',
    handler: ({ machine }) => {
      machine.cache.iCacheEnabled = false;
      return 0;
    },
    rationale: 'Same structural no-op as enabling it: there is no translation to suspend.',
  },
  {
    address: 0x40000528,
    name: 'Cache_Resume_ICache',
    handler: ({ machine }) => {
      machine.cache.iCacheEnabled = true;
    },
    rationale: 'Pairs with Cache_Suspend_ICache; recorded rather than ignored.',
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
