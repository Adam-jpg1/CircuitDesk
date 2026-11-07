// The RP2040 boot ROM's soft-float ('SF') and double ('SD') tables —
// independently implemented, in JavaScript, behind trap stubs.
//
// The Pico SDK does floating point by calling through two tables of function
// pointers it finds in the boot ROM. Raspberry Pi's routines behind them
// (mufplib) cannot be redistributed here, so until now the tables were simply
// absent and any sketch doing float math — analogWrite() included, which
// computes its divisor in floating point — stopped with an explanation.
//
// What the SDK needs is the *interface*: which slot does what, with which
// arguments and results. That is public — the RP2040 datasheet's ROM chapter
// documents each entry's contract, and the table offsets are the SDK's own
// BSD-3-Clause header (pico/bootrom/sf_table.h). This file implements those
// contracts from scratch. Nothing of mufplib was consulted, copied or
// translated: each entry is computed with the host's IEEE arithmetic.
//
// The ROM stub (bootStub.ts) points every table slot at two instructions,
// `bkpt #code; bx lr`. rp2040js reports the breakpoint, the runner calls
// romFloatCall() with the core's registers, and the `bx lr` returns to the
// caller with the result in place — the AAPCS convention the SDK calls with:
// a float in r0 (a second in r1), a double in r0:r1 (a second in r2:r3), an
// integer bit count n after them, 64-bit results in r0:r1.
//
// Precision. Add, subtract, multiply, divide and square root are exact to the
// last bit: a double result rounded once to single is correctly rounded, since
// a double carries more than twice a float's 24 bits plus two. The 64-bit
// integer conversions round to odd at 53 bits before rounding to single, so
// they are rounded once too. The transcendentals use the host's libm, which is
// at least as accurate as the ROM's.
//
// Conversions to integer round towards minus infinity and saturate, which is
// the ROM's documented behaviour and what the SDK's wrappers build their
// C-style truncating conversions on.

/** First breakpoint code of each table; the slot index (offset / 4) is added. */
export const SF_TRAP_BASE = 0x80;
export const SD_TRAP_BASE = 0xc0;
/** Thirty-two slots each: the V2 table size, 0x80 bytes. */
export const ROM_FLOAT_SLOTS = 32;

export interface RomFloatCore {
  registers: Uint32Array | number[];
  N: boolean;
  Z: boolean;
  C: boolean;
  V: boolean;
}

const f32 = new Float32Array(1);
const f32bits = new Uint32Array(f32.buffer);
const f64 = new Float64Array(1);
const f64words = new Uint32Array(f64.buffer); // little-endian: [lo, hi]

const asFloat = (bits: number): number => {
  f32bits[0] = bits;
  return f32[0];
};
/** Rounds to single precision (nearest, ties to even) and returns the bits. */
const floatBits = (x: number): number => {
  f32[0] = x;
  return f32bits[0];
};
const asDouble = (lo: number, hi: number): number => {
  f64words[0] = lo;
  f64words[1] = hi;
  return f64[0];
};
const doubleWords = (x: number): [number, number] => {
  f64[0] = x;
  return [f64words[0], f64words[1]];
};

const TWO_31 = 2 ** 31;
const TWO_32 = 2 ** 32;
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;

/** Round towards minus infinity, saturating to a signed 32-bit integer. NaN gives 0. */
function toInt32(x: number): number {
  if (Number.isNaN(x)) return 0;
  const v = Math.floor(x);
  if (v >= TWO_31) return 0x7fffffff;
  if (v < -TWO_31) return 0x80000000;
  return v >>> 0;
}

/** Round towards minus infinity, saturating to an unsigned 32-bit integer. NaN gives 0. */
function toUint32(x: number): number {
  if (Number.isNaN(x)) return 0;
  const v = Math.floor(x);
  if (v >= TWO_32) return 0xffffffff;
  if (v < 0) return 0;
  return v >>> 0;
}

function toInt64(x: number): [number, number] {
  if (Number.isNaN(x)) return [0, 0];
  let v: bigint;
  if (x >= 2 ** 63) v = INT64_MAX;
  else if (x < -(2 ** 63)) v = INT64_MIN;
  else v = BigInt(Math.floor(x));
  const u = BigInt.asUintN(64, v);
  return [Number(u & 0xffffffffn), Number(u >> 32n)];
}

function toUint64(x: number): [number, number] {
  if (Number.isNaN(x) || x < 0) return [0, 0];
  const v = x >= 2 ** 64 ? UINT64_MAX : BigInt(Math.floor(x));
  return [Number(v & 0xffffffffn), Number(v >> 32n)];
}

const int64Of = (lo: number, hi: number): bigint => BigInt.asIntN(64, (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0));
const uint64Of = (lo: number, hi: number): bigint => (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);

/**
 * A 64-bit integer as a double, rounded to odd at 53 bits, so that a further
 * rounding to single precision is the correctly rounded single result.
 */
function roundToOdd(v: bigint): number {
  const negative = v < 0n;
  let a = negative ? -v : v;
  const bits = a.toString(2).length;
  if (bits <= 53) return Number(v);
  const shift = BigInt(bits - 53);
  const sticky = (a & ((1n << shift) - 1n)) !== 0n;
  a >>= shift;
  if (sticky) a |= 1n;
  const x = Number(a) * 2 ** Number(shift);
  return negative ? -x : x;
}

/** Sets N, Z, C and V as `cmp a, b` would for the ordering of a and b. */
function compareFlags(core: RomFloatCore, a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) {
    // Unordered: as an unsigned "higher", so lt/le/eq are all false.
    core.N = false;
    core.Z = false;
    core.C = true;
    core.V = false;
    return 1;
  }
  const order = a < b ? -1 : a > b ? 1 : 0;
  core.N = order < 0;
  core.Z = order === 0;
  core.C = order >= 0;
  core.V = false;
  return order;
}

/** Calls single-precision slot `slot` (offset / 4). Returns false for an unknown slot. */
function singleSlot(slot: number, core: RomFloatCore): boolean {
  const r = core.registers;
  const a = asFloat(r[0]);
  const b = asFloat(r[1]);
  const n = r[1] | 0;
  const set = (bits: number) => (r[0] = bits >>> 0);
  const set64 = ([lo, hi]: [number, number]) => {
    r[0] = lo >>> 0;
    r[1] = hi >>> 0;
  };
  switch (slot * 4) {
    case 0x00: set(floatBits(a + b)); break; // fadd
    case 0x04: set(floatBits(a - b)); break; // fsub
    case 0x08: set(floatBits(a * b)); break; // fmul
    case 0x0c: set(floatBits(a / b)); break; // fdiv
    case 0x10: // fcmp (fast)
    case 0x54: // fcmp (basic)
      set(compareFlags(core, a, b) >>> 0);
      break;
    case 0x14: compareFlags(core, a, b); break; // fcmp, result in the flags
    case 0x18: set(floatBits(Math.sqrt(a))); break; // fsqrt
    case 0x1c: set(toInt32(a)); break; // float2int
    case 0x20: set(toInt32(a * 2 ** n)); break; // float2fix
    case 0x24: set(toUint32(a)); break; // float2uint
    case 0x28: set(toUint32(a * 2 ** n)); break; // float2ufix
    case 0x2c: set(floatBits(r[0] | 0)); break; // int2float
    case 0x30: set(floatBits((r[0] | 0) / 2 ** n)); break; // fix2float
    case 0x34: set(floatBits(r[0] >>> 0)); break; // uint2float
    case 0x38: set(floatBits((r[0] >>> 0) / 2 ** n)); break; // ufix2float
    case 0x3c: set(floatBits(Math.cos(a))); break; // fcos
    case 0x40: set(floatBits(Math.sin(a))); break; // fsin
    case 0x44: set(floatBits(Math.tan(a))); break; // ftan
    case 0x48: // fsincos: sin in r0, cos in r1
      r[1] = floatBits(Math.cos(a)) >>> 0;
      set(floatBits(Math.sin(a)));
      break;
    case 0x4c: set(floatBits(Math.exp(a))); break; // fexp
    case 0x50: set(floatBits(Math.log(a))); break; // fln
    case 0x58: set(floatBits(Math.atan2(a, b))); break; // fatan2(y, x)
    case 0x5c: set(floatBits(roundToOdd(int64Of(r[0], r[1])))); break; // int642float
    case 0x60: set(floatBits(roundToOdd(int64Of(r[0], r[1])) / 2 ** (r[2] | 0))); break; // fix642float
    case 0x64: set(floatBits(roundToOdd(uint64Of(r[0], r[1])))); break; // uint642float
    case 0x68: set(floatBits(roundToOdd(uint64Of(r[0], r[1])) / 2 ** (r[2] | 0))); break; // ufix642float
    case 0x6c: set64(toInt64(a)); break; // float2int64
    case 0x70: set64(toInt64(a * 2 ** n)); break; // float2fix64
    case 0x74: set64(toUint64(a)); break; // float2uint64
    case 0x78: set64(toUint64(a * 2 ** n)); break; // float2ufix64
    case 0x7c: set64(doubleWords(a)); break; // float2double
    default:
      return false;
  }
  return true;
}

/** Calls double-precision slot `slot` (offset / 4). Returns false for an unknown slot. */
function doubleSlot(slot: number, core: RomFloatCore): boolean {
  const r = core.registers;
  const a = asDouble(r[0], r[1]);
  const b = asDouble(r[2], r[3]);
  const n = r[2] | 0;
  const set = (x: number) => {
    const [lo, hi] = doubleWords(x);
    r[0] = lo;
    r[1] = hi;
  };
  const set32 = (bits: number) => (r[0] = bits >>> 0);
  const set64 = ([lo, hi]: [number, number]) => {
    r[0] = lo >>> 0;
    r[1] = hi >>> 0;
  };
  switch (slot * 4) {
    case 0x00: set(a + b); break; // dadd
    case 0x04: set(a - b); break; // dsub
    case 0x08: set(a * b); break; // dmul
    case 0x0c: set(a / b); break; // ddiv
    case 0x10: // dcmp (fast)
    case 0x54: // dcmp (basic)
      set32(compareFlags(core, a, b) >>> 0);
      break;
    case 0x14: compareFlags(core, a, b); break; // dcmp, result in the flags
    case 0x18: set(Math.sqrt(a)); break; // dsqrt
    case 0x1c: set32(toInt32(a)); break; // double2int
    case 0x20: set32(toInt32(a * 2 ** n)); break; // double2fix
    case 0x24: set32(toUint32(a)); break; // double2uint
    case 0x28: set32(toUint32(a * 2 ** n)); break; // double2ufix
    case 0x2c: set(r[0] | 0); break; // int2double
    case 0x30: set((r[0] | 0) / 2 ** (r[1] | 0)); break; // fix2double
    case 0x34: set(r[0] >>> 0); break; // uint2double
    case 0x38: set((r[0] >>> 0) / 2 ** (r[1] | 0)); break; // ufix2double
    case 0x3c: set(Math.cos(a)); break; // dcos
    case 0x40: set(Math.sin(a)); break; // dsin
    case 0x44: set(Math.tan(a)); break; // dtan
    case 0x48: { // dsincos: sin in r0:r1, cos in r2:r3
      const [clo, chi] = doubleWords(Math.cos(a));
      set(Math.sin(a));
      r[2] = clo;
      r[3] = chi;
      break;
    }
    case 0x4c: set(Math.exp(a)); break; // dexp
    case 0x50: set(Math.log(a)); break; // dln
    case 0x58: set(Math.atan2(a, b)); break; // datan2(y, x)
    case 0x5c: set(Number(int64Of(r[0], r[1]))); break; // int642double
    case 0x60: set(Number(int64Of(r[0], r[1])) / 2 ** n); break; // fix642double
    case 0x64: set(Number(uint64Of(r[0], r[1]))); break; // uint642double
    case 0x68: set(Number(uint64Of(r[0], r[1])) / 2 ** n); break; // ufix642double
    case 0x6c: set64(toInt64(a)); break; // double2int64
    case 0x70: set64(toInt64(a * 2 ** n)); break; // double2fix64
    case 0x74: set64(toUint64(a)); break; // double2uint64
    case 0x78: set64(toUint64(a * 2 ** n)); break; // double2ufix64
    case 0x7c: set32(floatBits(a)); break; // double2float
    default:
      return false;
  }
  return true;
}

/**
 * Handles a ROM float trap. Returns true when `code` was one of ours, false
 * for any other breakpoint (the SDK's panic(), a sketch's own bkpt), which
 * the caller leaves alone.
 */
export function romFloatCall(code: number, core: RomFloatCore): boolean {
  if (code >= SF_TRAP_BASE && code < SF_TRAP_BASE + ROM_FLOAT_SLOTS) return singleSlot(code - SF_TRAP_BASE, core);
  if (code >= SD_TRAP_BASE && code < SD_TRAP_BASE + ROM_FLOAT_SLOTS) return doubleSlot(code - SD_TRAP_BASE, core);
  return false;
}
