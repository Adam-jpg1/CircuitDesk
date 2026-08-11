// Formatted output from the ESP32-C6's ROM C library.
//
// The C6 publishes newlib's printf family — `esp32c6.rom.newlib.ld` and
// `esp32c6.rom.newlib-normal.ld` — and its firmware calls into it once the
// logging driver is up, so `ESP_LOGI` from a sketch ends up here.
//
// The format parsing is shared with the C3's `esp_rom_printf`, because it is
// the same language and two copies would be two places for the same mistake.
// What differs is only where the arguments come from: registers for a variadic
// call, a `va_list` for the `v` forms.
//
// On RISC-V ILP32 a `va_list` is a plain pointer into the caller's argument
// area, walked four bytes at a time — with 64-bit arguments aligned to eight,
// which is why the reader below rounds up rather than simply advancing.
//
// Addresses are from those two linker scripts, in the same core the firmware
// was built with. No ROM code was read, disassembled or copied.

import { formatPrintf, readCString, type RomCallContext, type RomFunction, type RomHandler } from '../esp32c3/romFunctions';

/** Writes a string into a caller's buffer, truncating to `limit` including the NUL. */
function writeBounded(context: RomCallContext, buffer: number, limit: number, text: string): void {
  if (buffer === 0 || limit === 0) return;
  const room = Math.min(text.length, limit - 1);
  for (let i = 0; i < room; i++) context.bus.writeUint8((buffer + i) >>> 0, text.charCodeAt(i) & 0xff);
  context.bus.writeUint8((buffer + room) >>> 0, 0);
}

/**
 * Reads arguments from a `va_list`.
 *
 * The list is a pointer, so the reader owns a cursor into guest memory rather
 * than an index into registers.
 */
function vaReader(context: RomCallContext, list: number): () => number {
  let cursor = list >>> 0;
  return () => {
    const value = context.bus.readUint32(cursor) | 0;
    cursor = (cursor + 4) >>> 0;
    return value;
  };
}

/** Reads arguments from the registers, then the stack, as a variadic call does. */
function variadicReader(context: RomCallContext, firstRegister: number): () => number {
  let index = 0;
  const stack = context.registers[2] >>> 0;
  return () => {
    // a0..a7 are x10..x17; anything past them continues on the stack.
    const register = firstRegister + index;
    const value = register <= 17 ? context.registers[register] | 0 : context.bus.readUint32((stack + (register - 18) * 4) >>> 0) | 0;
    index++;
    return value;
  };
}

/** `vsnprintf(buffer, size, format, ap)` -> characters the result would have had. */
const vsnprintf: RomHandler = (context) => {
  const buffer = context.args[0] >>> 0;
  const size = context.args[1] >>> 0;
  const format = readCString(context.bus, context.args[2] >>> 0, 512);
  const text = formatPrintf(context.bus, format, vaReader(context, context.args[3] >>> 0));
  writeBounded(context, buffer, size, text);
  // The return value is the length the whole result would have had, not the
  // number of bytes written — which is how callers discover they need a bigger
  // buffer and try again.
  return text.length;
};

/** `snprintf(buffer, size, format, ...)` -> characters the result would have had. */
const snprintf: RomHandler = (context) => {
  const buffer = context.args[0] >>> 0;
  const size = context.args[1] >>> 0;
  const format = readCString(context.bus, context.args[2] >>> 0, 512);
  // The format is a2, so the first conversion argument is a3 = x13.
  const text = formatPrintf(context.bus, format, variadicReader(context, 13));
  writeBounded(context, buffer, size, text);
  return text.length;
};

/** `sprintf(buffer, format, ...)`, which is the same with no bound. */
const sprintf: RomHandler = (context) => {
  const buffer = context.args[0] >>> 0;
  const format = readCString(context.bus, context.args[1] >>> 0, 512);
  const text = formatPrintf(context.bus, format, variadicReader(context, 12));
  writeBounded(context, buffer, text.length + 1, text);
  return text.length;
};

/** `vsprintf(buffer, format, ap)`. */
const vsprintf: RomHandler = (context) => {
  const buffer = context.args[0] >>> 0;
  const format = readCString(context.bus, context.args[1] >>> 0, 512);
  const text = formatPrintf(context.bus, format, vaReader(context, context.args[2] >>> 0));
  writeBounded(context, buffer, text.length + 1, text);
  return text.length;
};

/**
 * `vprintf(format, ap)` and `printf(format, ...)`.
 *
 * These go to whatever the C library's stdout is bound to. This runtime has no
 * ROM console attached to the C6, so the text is kept where a trace and the
 * serial monitor can find it rather than being discarded — the same place the
 * C3's `esp_rom_printf` puts its output.
 */
const vprintf: RomHandler = (context) => {
  const format = readCString(context.bus, context.args[0] >>> 0, 512);
  const text = formatPrintf(context.bus, format, vaReader(context, context.args[1] >>> 0));
  emit(context, text);
  return text.length;
};

const printf: RomHandler = (context) => {
  const format = readCString(context.bus, context.args[0] >>> 0, 512);
  const text = formatPrintf(context.bus, format, variadicReader(context, 11));
  emit(context, text);
  return text.length;
};

function emit(context: RomCallContext, text: string): void {
  for (const character of text) context.machine.romConsole.push(character.charCodeAt(0) & 0xff);
  while (context.machine.romConsole.length > 8192) context.machine.romConsole.shift();
}

/**
 * The formatted-output entry points the C6's ROM publishes.
 *
 * newlib gives the integer-only variants their own names — `iprintf`,
 * `vsniprintf` and so on — because a build without floating-point support links
 * a smaller formatter. This runtime's formatter handles neither more nor less
 * either way, so both names reach the same implementation, which is the honest
 * arrangement rather than two copies that could drift.
 */
export const ESP32C6_ROM_NEWLIB: RomFunction[] = [
  {
    address: 0x400005f0,
    name: 'printf',
    handler: printf,
    rationale: 'Formats the firmware\'s own text from the firmware\'s own arguments.',
  },
  {
    address: 0x40000600,
    name: 'sprintf',
    handler: sprintf,
    rationale: 'Unbounded formatting into a caller\'s buffer.',
  },
  {
    address: 0x40000604,
    name: 'snprintf',
    handler: snprintf,
    rationale: 'Bounded, returning the length the whole result would have had.',
  },
  {
    address: 0x40000608,
    name: 'siprintf',
    handler: sprintf,
    rationale: 'newlib\'s integer-only name for sprintf; this formatter is the same either way.',
  },
  {
    address: 0x4000060c,
    name: 'sniprintf',
    handler: snprintf,
    rationale: 'And for snprintf.',
  },
  {
    address: 0x40000610,
    name: 'vprintf',
    handler: vprintf,
    rationale: 'The same as printf, with the arguments coming from a va_list rather than registers.',
  },
  {
    address: 0x40000614,
    name: 'viprintf',
    handler: vprintf,
    rationale: 'Its integer-only name.',
  },
  {
    address: 0x40000618,
    name: 'vsnprintf',
    handler: vsnprintf,
    rationale: 'Bounded formatting from a va_list, which is what ESP_LOG reaches.',
  },
  {
    address: 0x4000061c,
    name: 'vsniprintf',
    handler: vsnprintf,
    rationale: 'Its integer-only name.',
  },
];

// vfprintf, vfiprintf and asprintf sit in the same block and are deliberately
// absent: the first two write to a caller-supplied FILE and asprintf allocates
// its own buffer, and no firmware has been seen to reach any of them here.
// Adding an address without knowing a caller exists would be guessing.
void vsprintf;
