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
  /**
   * Calls a function inside the firmware.
   *
   * Provided for the ROM routines that take a firmware function pointer, such
   * as qsort's comparator. The callback genuinely executes; the runtime only
   * arranges the call.
   */
  callGuest: (address: number, args?: number[], options?: { maxInstructions?: number }) => {
    value: number;
    high: number;
    instructions: number;
  };
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
  /**
   * eFuse values this runtime reports.
   *
   * A DevKitM-1 carries an ESP32-C3-MINI-1 with the flash on the chip's
   * default pads and no pin override programmed, so these are the values the
   * real module reads back.
   */
  efuse: { flashGpioInfo: number; flashWpGpio: number };
  /** Bytes the ROM console has emitted, and bytes waiting to be read. */
  romConsole: number[];
  romConsoleRx: number[];
  romConsoleDivider: number;
  /** Seed state for the ROM's rand(), kept deterministic across runs. */
  randState: number;
}

export function createRomMachineState(resetReason = ResetReason.PowerOn): RomMachineState {
  return {
    resetReason,
    regi2c: new Map<number, number>(),
    cache: { iCacheEnabled: false, iromMmuSize: 0, dromMmuSize: 0 },
    cpuFrequencyMhz: 160,
    pendingDelayUs: 0,
    putc1: 0,
    efuse: { flashGpioInfo: 0, flashWpGpio: 0x3f },
    romConsole: [],
    romConsoleRx: [],
    romConsoleDivider: 0,
    randState: 1,
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

// The rest of the 64-bit and bit-counting helpers, which arrive as a family:
// once firmware links one of them the compiler will emit the others for the
// same expressions, so implementing them together avoids a stall per operator.
// A shift count is taken modulo 64, as libgcc's routines do.

const ashldi3: RomHandler = ({ args, registers }) =>
  return64(registers, asUnsigned64(args[0], args[1]) << BigInt(args[2] & 63));

const lshrdi3: RomHandler = ({ args, registers }) =>
  return64(registers, asUnsigned64(args[0], args[1]) >> BigInt(args[2] & 63));

const ashrdi3: RomHandler = ({ args, registers }) =>
  return64(registers, asSigned64(args[0], args[1]) >> BigInt(args[2] & 63));

const muldi3: RomHandler = ({ args, registers }) =>
  return64(registers, asUnsigned64(args[0], args[1]) * asUnsigned64(args[2], args[3]));

const negdi2: RomHandler = ({ args, registers }) => return64(registers, -asSigned64(args[0], args[1]));

/** Three-way comparison: 0 less, 1 equal, 2 greater. */
const cmpdi2: RomHandler = ({ args }) => {
  const a = asSigned64(args[0], args[1]);
  const b = asSigned64(args[2], args[3]);
  return a < b ? 0 : a === b ? 1 : 2;
};

const ucmpdi2: RomHandler = ({ args }) => {
  const a = asUnsigned64(args[0], args[1]);
  const b = asUnsigned64(args[2], args[3]);
  return a < b ? 0 : a === b ? 1 : 2;
};

/** Leading zeros of a 32-bit word; undefined at zero, so 32 is the safe answer. */
const clzsi2: RomHandler = ({ args }) => (args[0] === 0 ? 32 : Math.clz32(args[0] >>> 0));

const ctzsi2: RomHandler = ({ args }) => {
  const value = args[0] >>> 0;
  if (value === 0) return 32;
  let count = 0;
  while (((value >>> count) & 1) === 0) count++;
  return count;
};

const popcountsi2: RomHandler = ({ args }) => {
  let value = args[0] >>> 0;
  let count = 0;
  while (value !== 0) {
    count += value & 1;
    value >>>= 1;
  }
  return count;
};

/** Byte-swap a 32-bit word. */
const bswapsi2: RomHandler = ({ args }) => {
  const v = args[0] >>> 0;
  return (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | ((v >>> 24) & 0xff)) >>> 0;
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

/**
 * `esp_rom_efuse_get_flash_gpio_info()` -> packed pin assignment
 *
 * eFuse can override which pads the SPI flash is wired to, for modules that
 * route it differently. Zero means "the chip's default pins", which is what an
 * unprogrammed eFuse reads and what every ESP32-C3 module using the standard
 * layout — including the ESP32-C3-MINI-1 on a DevKitM-1 — actually reports.
 * This is the correct value for the modelled hardware, not a placeholder.
 */
const efuseGetFlashGpioInfo: RomHandler = ({ machine }) => machine.efuse.flashGpioInfo;

/** `esp_rom_efuse_get_flash_wp_gpio()` -> write-protect pad, or the default. */
const efuseGetFlashWpGpio: RomHandler = ({ machine }) => machine.efuse.flashWpGpio;

// ------------------------------------------------------- ROM UART output
//
// The ROM's own console path, which ESP-IDF uses for boot messages before the
// driver takes over. Characters are handed to a sink so those messages are
// visible; this is the ROM's UART, not an interception of Serial.print().

/** `esp_rom_output_tx_one_char(c)` -> 0 on success. */
const outputTxOneChar: RomHandler = ({ args, machine }) => {
  machine.romConsole.push(args[0] & 0xff);
  if (machine.romConsole.length > 8192) machine.romConsole.shift();
  return 0;
};

/**
 * `esp_rom_output_tx_wait_idle(uart_no)`
 *
 * Waits for the transmitter to drain. Characters here are consumed the moment
 * they are written, so the transmitter is never busy and the wait is already
 * satisfied when it is called. It is a no-op because the condition holds, not
 * because the call is being skipped.
 */
const outputTxWaitIdle: RomHandler = () => 0;

/** `esp_rom_output_flush_tx(uart_no)` — nothing is buffered, so nothing to flush. */
const outputFlushTx: RomHandler = () => 0;

/** `esp_rom_output_rx_one_char(&c)` -> 0 when a byte was read, 1 when empty. */
const outputRxOneChar: RomHandler = ({ args, bus, machine }) => {
  const byte = machine.romConsoleRx.shift();
  if (byte === undefined) return 1;
  bus.writeUint8(args[0] >>> 0, byte);
  return 0;
};

/** `uart_div_modify(uart_no, divider)` — records the ROM console's baud divider. */
const uartDivModify: RomHandler = ({ args, machine }) => {
  machine.romConsoleDivider = args[1] >>> 0;
  return 0;
};

/**
 * `esp_rom_route_intr_matrix(cpu, periph_source, cpu_interrupt)`
 *
 * The ESP32-C3 has far more interrupt sources than CPU interrupt lines, so a
 * matrix maps one to the other. Each peripheral source owns one word in the
 * matrix, at four bytes per source, holding the CPU line it is routed to.
 *
 * This performs the real write rather than recording the intent, so the
 * interrupt controller and anything reading the matrix back see the same
 * mapping the firmware established.
 */
const routeIntrMatrix: RomHandler = ({ args, bus }) => {
  const [, source, cpuInterrupt] = args;
  if (source < 0 || source >= INTERRUPT_MATRIX_SOURCES) return 0;
  bus.writeUint32((INTERRUPT_MATRIX_BASE + source * 4) >>> 0, cpuInterrupt >>> 0);
  return 0;
};

/** Interrupt matrix base and source count, from the C3's register map. */
const INTERRUPT_MATRIX_BASE = 0x600c2000;
const INTERRUPT_MATRIX_SOURCES = 62;

// The C3's RISC-V interrupt controller lives in the same block, above the
// per-source mapping words. These offsets are from its register map.
const INTC_ENABLE = 0x104;
const INTC_TYPE = 0x108;
const INTC_PRIORITY_BASE = 0x114;
const INTC_THRESHOLD = 0x194;

/**
 * The `esprv_*` family, which configures that controller.
 *
 * Each one performs the real register write, so the controller's state is the
 * firmware's own and anything that reads it back — including a later interrupt
 * dispatch — sees exactly what was configured.
 */
const intcEnable: RomHandler = ({ args, bus }) => {
  const address = (INTERRUPT_MATRIX_BASE + INTC_ENABLE) >>> 0;
  bus.writeUint32(address, (bus.readUint32(address) | (args[0] >>> 0)) >>> 0);
  return 0;
};

const intcDisable: RomHandler = ({ args, bus }) => {
  const address = (INTERRUPT_MATRIX_BASE + INTC_ENABLE) >>> 0;
  bus.writeUint32(address, (bus.readUint32(address) & ~(args[0] >>> 0)) >>> 0);
  return 0;
};

/** Interrupt type: 0 is level-triggered, 1 is edge-triggered. */
const intcSetType: RomHandler = ({ args, bus }) => {
  const [interrupt, type] = args;
  if (interrupt < 0 || interrupt > 31) return 0;
  const address = (INTERRUPT_MATRIX_BASE + INTC_TYPE) >>> 0;
  const current = bus.readUint32(address);
  bus.writeUint32(address, (type ? current | (1 << interrupt) : current & ~(1 << interrupt)) >>> 0);
  return 0;
};

/** Each CPU interrupt has its own priority word. */
const intcSetPriority: RomHandler = ({ args, bus }) => {
  const [interrupt, priority] = args;
  if (interrupt < 1 || interrupt > 31) return 0;
  bus.writeUint32((INTERRUPT_MATRIX_BASE + INTC_PRIORITY_BASE + (interrupt - 1) * 4) >>> 0, priority >>> 0);
  return 0;
};

/** Interrupts at or below the threshold are masked. */
const intcSetThreshold: RomHandler = ({ args, bus }) => {
  bus.writeUint32((INTERRUPT_MATRIX_BASE + INTC_THRESHOLD) >>> 0, args[0] >>> 0);
  return 0;
};

/**
 * `esp_rom_printf(format, ...)` -> characters written
 *
 * ESP-IDF's early boot log goes through this before the logging driver is up,
 * so implementing it properly turns the rest of startup from a guessing game
 * into a readable narrative. The output is the firmware's own text, formatted
 * from the firmware's own arguments — nothing is intercepted or invented.
 *
 * The RISC-V variadic convention puts the format string in a0 and the first
 * seven remaining arguments in a1..a7, after which they continue on the stack.
 * The ROM's printf is a reduced one: it supports the integer, string and
 * character conversions with a width and zero-padding, which is what the boot
 * messages use.
 */
const romPrintf: RomHandler = ({ args, bus, machine, registers }) => {
  const readString = (address: number): string => {
    let out = '';
    for (let i = 0; i < 512; i++) {
      const byte = bus.readUint8((address + i) >>> 0);
      if (byte === 0) break;
      out += String.fromCharCode(byte);
    }
    return out;
  };

  const format = readString(args[0] >>> 0);
  let argIndex = 0;
  const stackBase = registers[2] >>> 0;
  const nextArg = (): number => {
    // a1..a7 first, then the stack, which is where the eighth onward live.
    const value =
      argIndex < 7
        ? registers[ARG_REGISTER_BASE + 1 + argIndex] | 0
        : bus.readUint32((stackBase + (argIndex - 7) * 4) >>> 0) | 0;
    argIndex++;
    return value;
  };

  let out = '';
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== '%') {
      out += format[i];
      continue;
    }
    i++;
    if (format[i] === '%') {
      out += '%';
      continue;
    }
    // Flags and width, then an optional length modifier which does not change
    // the size of anything on a 32-bit target.
    let pad = ' ';
    if (format[i] === '-' || format[i] === '0') {
      if (format[i] === '0') pad = '0';
      i++;
    }
    let width = '';
    while (i < format.length && format[i] >= '0' && format[i] <= '9') width += format[i++];
    while (i < format.length && 'lhz'.includes(format[i])) i++;

    const conversion = format[i];
    let piece: string;
    switch (conversion) {
      case 'd':
      case 'i':
        piece = String(nextArg());
        break;
      case 'u':
        piece = String(nextArg() >>> 0);
        break;
      case 'x':
        piece = (nextArg() >>> 0).toString(16);
        break;
      case 'X':
        piece = (nextArg() >>> 0).toString(16).toUpperCase();
        break;
      case 'p':
        piece = '0x' + (nextArg() >>> 0).toString(16);
        break;
      case 'c':
        piece = String.fromCharCode(nextArg() & 0xff);
        break;
      case 's':
        piece = readString(nextArg() >>> 0);
        break;
      default:
        // An unrecognised conversion is reproduced verbatim rather than
        // silently consuming an argument and desynchronising the rest.
        piece = '%' + (conversion ?? '');
        break;
    }
    const target = Number.parseInt(width || '0', 10);
    out += piece.length >= target ? piece : pad.repeat(target - piece.length) + piece;
  }

  for (const character of out) {
    machine.romConsole.push(character.charCodeAt(0) & 0xff);
  }
  while (machine.romConsole.length > 8192) machine.romConsole.shift();
  return out.length;
};


// -------------------------------------------------------- ROM C library
//
// The ESP32-C3 ROM carries a slice of the C library, so ordinary firmware code
// calling itoa or strchr becomes a ROM call. Each is implemented from its
// standard signature. They are grouped because they arrive as a family: once
// one is linked the others usually follow, and stalling on each in turn would
// be a lot of round trips for behaviour that is entirely specified.

/** Reads a NUL-terminated string, bounded so a runaway pointer cannot hang. */
function readCString(bus: Bus, address: number, limit = 4096): string {
  let out = '';
  for (let i = 0; i < limit; i++) {
    const byte = bus.readUint8((address + i) >>> 0);
    if (byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

/** Writes a string plus its terminator. */
function writeCString(bus: Bus, address: number, text: string): void {
  for (let i = 0; i < text.length; i++) bus.writeUint8((address + i) >>> 0, text.charCodeAt(i) & 0xff);
  bus.writeUint8((address + text.length) >>> 0, 0);
}

/** `itoa(value, buffer, radix)` -> buffer. Signed in base 10, as specified. */
const itoa: RomHandler = ({ args, bus }) => {
  const [value, buffer, radix] = args;
  const base = radix === 0 ? 10 : radix;
  writeCString(bus, buffer >>> 0, base === 10 ? String(value | 0) : (value >>> 0).toString(base));
  return buffer;
};

/** `utoa(value, buffer, radix)` -> buffer. Always unsigned. */
const utoa: RomHandler = ({ args, bus }) => {
  const [value, buffer, radix] = args;
  writeCString(bus, buffer >>> 0, (value >>> 0).toString(radix === 0 ? 10 : radix));
  return buffer;
};

/** `atoi(s)` — leading space skipped, optional sign, digits until a non-digit. */
const atoi: RomHandler = ({ args, bus }) => {
  const parsed = Number.parseInt(readCString(bus, args[0] >>> 0).trim(), 10);
  return Number.isNaN(parsed) ? 0 : parsed | 0;
};

/**
 * `strtol(s, endptr, base)`
 *
 * Base 0 auto-detects, as the standard requires: a 0x prefix means 16, a
 * leading 0 means 8, anything else means 10. `endptr`, when given, receives the
 * address just past the digits consumed.
 */
const strtol: RomHandler = ({ args, bus }) => {
  const [start, endPointer, requestedBase] = args;
  const text = readCString(bus, start >>> 0);
  let index = 0;
  while (index < text.length && /\s/.test(text[index])) index++;
  const signIndex = index;
  if (text[index] === '+' || text[index] === '-') index++;
  let base = requestedBase | 0;
  if ((base === 0 || base === 16) && text.slice(index, index + 2).toLowerCase() === '0x') {
    base = 16;
    index += 2;
  } else if (base === 0) {
    base = text[index] === '0' ? 8 : 10;
  }
  const digitStart = index;
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, base);
  while (index < text.length && digits.includes(text[index].toLowerCase())) index++;
  const body = text.slice(digitStart, index);
  const parsed = body.length === 0 ? 0 : Number.parseInt(body, base);
  if (endPointer !== 0) {
    bus.writeUint32(endPointer >>> 0, ((start >>> 0) + (body.length === 0 ? 0 : index)) >>> 0);
  }
  return (text[signIndex] === '-' ? -parsed : parsed) | 0;
};

const strstr: RomHandler = ({ args, bus }) => {
  const haystackAddress = args[0] >>> 0;
  const at = readCString(bus, haystackAddress).indexOf(readCString(bus, args[1] >>> 0));
  return at < 0 ? 0 : (haystackAddress + at) >>> 0;
};

const strchr: RomHandler = ({ args, bus }) => {
  const address = args[0] >>> 0;
  const text = readCString(bus, address);
  const wanted = args[1] & 0xff;
  // Searching for NUL finds the terminator, which the standard requires.
  if (wanted === 0) return (address + text.length) >>> 0;
  const at = text.indexOf(String.fromCharCode(wanted));
  return at < 0 ? 0 : (address + at) >>> 0;
};

const strcat: RomHandler = ({ args, bus }) => {
  const dest = args[0] >>> 0;
  writeCString(bus, (dest + readCString(bus, dest).length) >>> 0, readCString(bus, args[1] >>> 0));
  return dest;
};

const strncat: RomHandler = ({ args, bus }) => {
  const dest = args[0] >>> 0;
  writeCString(bus, (dest + readCString(bus, dest).length) >>> 0, readCString(bus, args[1] >>> 0).slice(0, args[2] >>> 0));
  return dest;
};

/** `strlcpy(dst, src, size)` -> length of src, so truncation is detectable. */
const strlcpy: RomHandler = ({ args, bus }) => {
  const [dest, source, size] = args.map((v) => v >>> 0);
  const text = readCString(bus, source);
  if (size > 0) writeCString(bus, dest, text.slice(0, size - 1));
  return text.length;
};

const bzero: RomHandler = ({ args, bus }) => {
  const [dest, length] = args.map((v) => v >>> 0);
  for (let i = 0; i < length; i++) bus.writeUint8((dest + i) >>> 0, 0);
};

const absHandler: RomHandler = ({ args }) => Math.abs(args[0] | 0) | 0;
const isalnum: RomHandler = ({ args }) => (/[0-9a-z]/i.test(String.fromCharCode(args[0] & 0xff)) ? 1 : 0);
const isspace: RomHandler = ({ args }) => (/[ \t\n\v\f\r]/.test(String.fromCharCode(args[0] & 0xff)) ? 1 : 0);
const toupper: RomHandler = ({ args }) => String.fromCharCode(args[0] & 0xff).toUpperCase().charCodeAt(0);
const tolower: RomHandler = ({ args }) => String.fromCharCode(args[0] & 0xff).toLowerCase().charCodeAt(0);

/**
 * `rand()` and `srand(seed)`
 *
 * A deterministic sequence, seeded by the firmware. Determinism is the point:
 * numbers that differed between runs would make a failure impossible to
 * reproduce, and the standard promises the same sequence for the same seed.
 */
const randHandler: RomHandler = ({ machine }) => {
  machine.randState = (Math.imul(machine.randState, 1103515245) + 12345) >>> 0;
  return (machine.randState >>> 16) & 0x7fff;
};
const srandHandler: RomHandler = ({ args, machine }) => {
  machine.randState = args[0] >>> 0;
};

/**
 * `qsort(base, count, width, compare)`
 *
 * A genuine general sort: any base address, any element count, any element
 * width, sorting in place, ordering decided entirely by the firmware's own
 * comparator. Nothing assumes what is being sorted or that it arrives nearly
 * ordered — ESP-IDF sorts its own tables through this and the contents differ
 * per sketch.
 *
 * Insertion sort by adjacent swaps. The algorithm matters here for a reason
 * that is easy to get wrong: the comparator is firmware code that receives
 * *pointers*, so both addresses it is handed must be real elements of the
 * array. Holding a key aside in scratch memory would mean finding somewhere to
 * put it, and anywhere outside the array belongs to something else — doing
 * that corrupted the caller's neighbouring data and ESP-IDF reported the
 * damage as an overlapping memory region. Comparing and swapping neighbours
 * touches nothing but the array.
 *
 * A simple algorithm is also the right trade here: each comparison is a guest
 * call, which dominates the cost, and the tables ESP-IDF sorts are small.
 */
const qsort: RomHandler = ({ args, bus, callGuest }) => {
  const [base, count, width, compare] = args.map((v) => v >>> 0);
  if (count < 2 || width === 0) return 0;

  const swap = (a: number, b: number): void => {
    const addressA = (base + a * width) >>> 0;
    const addressB = (base + b * width) >>> 0;
    for (let i = 0; i < width; i++) {
      const left = bus.readUint8((addressA + i) >>> 0);
      bus.writeUint8((addressA + i) >>> 0, bus.readUint8((addressB + i) >>> 0));
      bus.writeUint8((addressB + i) >>> 0, left);
    }
  };

  for (let i = 1; i < count; i++) {
    for (let j = i; j > 0; j--) {
      // compare(previous, current) > 0 means they are out of order.
      const { value } = callGuest(compare, [(base + (j - 1) * width) >>> 0, (base + j * width) >>> 0]);
      if (value <= 0) break;
      swap(j - 1, j);
    }
  }
  return 0;
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
    address: 0x4000077c,
    name: '__ashldi3',
    handler: ashldi3,
    rationale: '64-bit left shift, count taken modulo 64 as libgcc does.',
  },
  {
    address: 0x40000830,
    name: '__lshrdi3',
    handler: lshrdi3,
    rationale: '64-bit logical right shift.',
  },
  {
    address: 0x40000780,
    name: '__ashrdi3',
    handler: ashrdi3,
    rationale: '64-bit arithmetic right shift, preserving the sign.',
  },
  {
    address: 0x4000084c,
    name: '__muldi3',
    handler: muldi3,
    rationale: '64-bit multiply, truncated to 64 bits.',
  },
  {
    address: 0x4000086c,
    name: '__negdi2',
    handler: negdi2,
    rationale: '64-bit negation.',
  },
  {
    address: 0x400007a0,
    name: '__cmpdi2',
    handler: cmpdi2,
    rationale: 'Signed three-way comparison returning 0, 1 or 2.',
  },
  {
    address: 0x400008a8,
    name: '__ucmpdi2',
    handler: ucmpdi2,
    rationale: 'Unsigned three-way comparison.',
  },
  {
    address: 0x4000079c,
    name: '__clzsi2',
    handler: clzsi2,
    rationale: 'Leading zero count of a 32-bit word.',
  },
  {
    address: 0x400007a8,
    name: '__ctzsi2',
    handler: ctzsi2,
    rationale: 'Trailing zero count of a 32-bit word.',
  },
  {
    address: 0x40000888,
    name: '__popcountsi2',
    handler: popcountsi2,
    rationale: 'Set-bit count of a 32-bit word.',
  },
  {
    address: 0x40000788,
    name: '__bswapsi2',
    handler: bswapsi2,
    rationale: '32-bit byte swap.',
  },
  {
    address: 0x40000374,
    name: 'strlen',
    handler: strlen,
    rationale: 'Counts bytes before the first NUL, bounded so an unterminated string cannot hang the run.',
  },
  {
    address: 0x400005e8,
    name: 'esprv_int_enable',
    handler: intcEnable,
    rationale: 'Sets the real enable bits in the interrupt controller.',
  },
  {
    address: 0x400005ec,
    name: 'esprv_int_disable',
    handler: intcDisable,
    rationale: 'Clears the real enable bits.',
  },
  {
    address: 0x400005f0,
    name: 'esprv_int_set_type',
    handler: intcSetType,
    rationale: 'Selects level or edge triggering per interrupt line.',
  },
  {
    address: 0x400005e0,
    name: 'esprv_int_set_priority',
    handler: intcSetPriority,
    rationale: 'Writes the per-line priority word.',
  },
  {
    address: 0x400005e4,
    name: 'esprv_int_set_threshold',
    handler: intcSetThreshold,
    rationale: 'Writes the masking threshold.',
  },
  {
    address: 0x400005f4,
    name: 'esp_rom_route_intr_matrix',
    handler: routeIntrMatrix,
    rationale: 'Performs the real matrix write so the routing is observable, not just recorded.',
  },
  {
    address: 0x40000448,
    name: 'itoa',
    handler: itoa,
    rationale: 'Signed for base 10, raw bit pattern for other bases, as the standard specifies.',
  },
  { address: 0x40000444, name: 'utoa', handler: utoa, rationale: 'Unsigned conversion in any radix.' },
  { address: 0x4000044c, name: 'atoi', handler: atoi, rationale: 'Leading space, optional sign, decimal digits.' },
  { address: 0x40000454, name: 'strtol', handler: strtol, rationale: 'Base 0 auto-detection and a correct endptr.' },
  { address: 0x40000378, name: 'strstr', handler: strstr, rationale: 'Returns a pointer into the haystack, or null.' },
  { address: 0x400003e0, name: 'strchr', handler: strchr, rationale: 'Finds the terminator when asked for NUL.' },
  { address: 0x400003d8, name: 'strcat', handler: strcat, rationale: 'Appends at the destination terminator.' },
  { address: 0x400003fc, name: 'strncat', handler: strncat, rationale: 'Bounded append.' },
  { address: 0x400003f0, name: 'strlcpy', handler: strlcpy, rationale: 'Returns the source length so truncation is detectable.' },
  { address: 0x4000037c, name: 'bzero', handler: bzero, rationale: 'Clears a range byte-wise.' },
  { address: 0x40000424, name: 'abs', handler: absHandler, rationale: 'Absolute value of a 32-bit integer.' },
  { address: 0x40000388, name: 'isalnum', handler: isalnum, rationale: 'ASCII classification.' },
  { address: 0x400003b0, name: 'isspace', handler: isspace, rationale: 'ASCII classification.' },
  { address: 0x400003b8, name: 'toupper', handler: toupper, rationale: 'ASCII case conversion.' },
  { address: 0x400003bc, name: 'tolower', handler: tolower, rationale: 'ASCII case conversion.' },
  { address: 0x4000043c, name: 'rand', handler: randHandler, rationale: 'Deterministic sequence so runs reproduce.' },
  { address: 0x40000440, name: 'srand', handler: srandHandler, rationale: 'Seeds that sequence.' },
  {
    address: 0x40000434,
    name: 'qsort',
    handler: qsort,
    rationale: 'General in-place sort of arbitrary elements, ordered by the firmware\'s own comparator.',
  },
  {
    address: 0x40000040,
    name: 'esp_rom_printf',
    handler: romPrintf,
    rationale: 'Formats the firmware\'s own boot messages from its own arguments; nothing is intercepted.',
  },
  {
    address: 0x40000068,
    name: 'esp_rom_output_tx_one_char',
    handler: outputTxOneChar,
    rationale: 'Feeds the ROM console sink so boot messages are visible.',
  },
  {
    address: 0x40000084,
    name: 'esp_rom_output_tx_wait_idle',
    handler: outputTxWaitIdle,
    rationale: 'The transmitter is never busy here, so the wait condition already holds.',
  },
  {
    address: 0x40000080,
    name: 'esp_rom_output_flush_tx',
    handler: outputFlushTx,
    rationale: 'Nothing is buffered, so there is nothing to flush.',
  },
  {
    address: 0x40000070,
    name: 'esp_rom_output_rx_one_char',
    handler: outputRxOneChar,
    rationale: 'Reports an empty receiver unless a byte has been queued.',
  },
  {
    address: 0x40000088,
    name: 'uart_div_modify',
    handler: uartDivModify,
    rationale: 'Records the ROM console divider so the configured rate is observable.',
  },
  {
    address: 0x4000071c,
    name: 'esp_rom_efuse_get_flash_gpio_info',
    handler: efuseGetFlashGpioInfo,
    rationale: 'Reports no pin override, which is what an ESP32-C3-MINI-1 with default flash pads reads back.',
  },
  {
    address: 0x4000072c,
    name: 'esp_rom_efuse_get_flash_wp_gpio',
    handler: efuseGetFlashWpGpio,
    rationale: 'Reports the default write-protect pad for the same module.',
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
