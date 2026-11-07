// The mask ROM's soft-float and integer helper routines, for the ESP32-C3 and
// ESP32-C6.
//
// Neither chip has a floating-point unit, so GCC compiles every float and
// double operation into a call — a + b on doubles is __adddf3 — and both
// chips' linker scripts send those calls into the mask ROM (the C3 through
// esp32c3.rom.libgcc.ld, the C6 through esp32c6.rom.rvfp.ld). None of them
// was provided, so the first floating-point operation in any sketch stopped
// it with an unimplemented-ROM-call error: map(), a sensor's conversion
// formula, a servo library's angle arithmetic.
//
// Each routine here implements the documented libgcc contract (the GCC
// internals manual's "Soft float library routines"). Nothing is taken from the
// ROM, which is not published, nor from libgcc's source. JavaScript numbers
// are IEEE-754 binary64 with round-to-nearest-even, so +, -, × and ÷ on
// doubles give exactly the correctly rounded results libgcc does. Single
// precision rounds the double result to binary32 (Math.fround), which for
// these four operations is provably the same as rounding once; the one place
// that would double-round — a 64-bit integer to float — rounds explicitly.
//
// ABI (RV32, ilp32 soft-float): a double is a register pair, low word first —
// a0:a1, then a2:a3 — and is returned in a0:a1; a float is one register; a
// 64-bit integer is a pair like a double.

import type { RomFunction, RomHandler } from '../esp32c3/romFunctions';

const A0 = 10;
const scratch = new DataView(new ArrayBuffer(8));

function toDouble(lo: number, hi: number): number {
  scratch.setUint32(0, lo >>> 0, true);
  scratch.setUint32(4, hi >>> 0, true);
  return scratch.getFloat64(0, true);
}

function toFloat(word: number): number {
  scratch.setUint32(0, word >>> 0, true);
  return scratch.getFloat32(0, true);
}

function floatBits(value: number): number {
  scratch.setFloat32(0, value, true);
  return scratch.getUint32(0, true) | 0;
}

function returnDouble(registers: Int32Array, value: number): number {
  scratch.setFloat64(0, value, true);
  registers[A0] = scratch.getUint32(0, true) | 0;
  registers[A0 + 1] = scratch.getUint32(4, true) | 0;
  return registers[A0];
}

function return64(registers: Int32Array, value: bigint): number {
  const v = BigInt.asUintN(64, value);
  registers[A0] = Number(v & 0xffffffffn) | 0;
  registers[A0 + 1] = Number(v >> 32n) | 0;
  return registers[A0];
}

const int64 = (lo: number, hi: number) => BigInt.asIntN(64, (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0));
const uint64 = (lo: number, hi: number) => (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);

/** a op b on doubles. */
const d2 = (op: (a: number, b: number) => number): RomHandler => ({ args, registers }) =>
  returnDouble(registers, op(toDouble(args[0], args[1]), toDouble(args[2], args[3])));

/** a op b on floats, rounded once to binary32. */
const f2 = (op: (a: number, b: number) => number): RomHandler => ({ args }) => floatBits(Math.fround(op(toFloat(args[0]), toFloat(args[1]))));

// Comparisons, as libgcc defines their results: __eq/__ne give zero only when
// equal; __lt/__le give <0, 0, >0 and +1 when unordered (so neither a < b nor
// a <= b holds); __gt/__ge the same with -1 when unordered.
const order = (a: number, b: number, unordered: number) => (Number.isNaN(a) || Number.isNaN(b) ? unordered : a < b ? -1 : a > b ? 1 : 0);
const dcmp = (unordered: number): RomHandler => ({ args }) => order(toDouble(args[0], args[1]), toDouble(args[2], args[3]), unordered);
const fcmp = (unordered: number): RomHandler => ({ args }) => order(toFloat(args[0]), toFloat(args[1]), unordered);

/** Truncation toward zero into a signed or unsigned range, saturating; NaN gives the largest value. */
function toInt(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return max;
  const t = Math.trunc(value);
  return t < min ? min : t > max ? max : t;
}

function toInt64(value: number, min: bigint, max: bigint): bigint {
  if (Number.isNaN(value)) return max;
  if (value <= Number(min)) return min;
  if (value >= Number(max)) return max;
  return BigInt(Math.trunc(value));
}

/**
 * A 64-bit integer to binary32, rounded once, to nearest-even. Going through a
 * double first would round twice for integers above 2^53.
 */
function bigToFloat(value: bigint): number {
  const negative = value < 0n;
  let v = negative ? -value : value;
  if (v < 2n ** 53n) return Math.fround(negative ? -Number(v) : Number(v));
  const bits = v.toString(2).length;
  const drop = BigInt(bits - 24);
  const kept = v >> drop;
  const rest = v & ((1n << drop) - 1n);
  const half = 1n << (drop - 1n);
  let mantissa = kept;
  if (rest > half || (rest === half && (kept & 1n) === 1n)) mantissa += 1n;
  v = mantissa << drop;
  return Math.fround(negative ? -Number(v) : Number(v));
}

/** x to the integer power m, by the square-and-multiply order libgcc documents, so rounding matches. */
function powi(x: number, m: number, round: (v: number) => number): number {
  let n = Math.abs(m);
  let y = n % 2 ? x : 1;
  while ((n = Math.floor(n / 2))) {
    x = round(x * x);
    if (n % 2) y = round(y * x);
  }
  return m < 0 ? round(1 / y) : y;
}

const clz64 = (v: bigint) => (v === 0n ? 64 : 64 - v.toString(2).length);

const HANDLERS: Record<string, { handler: RomHandler; rationale: string }> = {
  __adddf3: { handler: d2((a, b) => a + b), rationale: 'Double addition, correctly rounded.' },
  __subdf3: { handler: d2((a, b) => a - b), rationale: 'Double subtraction, correctly rounded.' },
  __muldf3: { handler: d2((a, b) => a * b), rationale: 'Double multiplication, correctly rounded.' },
  __divdf3: { handler: d2((a, b) => a / b), rationale: 'Double division, correctly rounded.' },
  __addsf3: { handler: f2((a, b) => a + b), rationale: 'Float addition, rounded once to binary32.' },
  __subsf3: { handler: f2((a, b) => a - b), rationale: 'Float subtraction, rounded once to binary32.' },
  __mulsf3: { handler: f2((a, b) => a * b), rationale: 'Float multiplication, rounded once to binary32.' },
  __divsf3: { handler: f2((a, b) => a / b), rationale: 'Float division, rounded once to binary32.' },
  __negdf2: {
    handler: ({ args, registers }) => {
      registers[A0] = args[0];
      registers[A0 + 1] = (args[1] ^ 0x80000000) | 0;
      return registers[A0];
    },
    rationale: 'Flips the sign bit, NaN payload included.',
  },
  __negsf2: { handler: ({ args }) => (args[0] ^ 0x80000000) | 0, rationale: 'Flips the sign bit.' },
  __extendsfdf2: { handler: ({ args, registers }) => returnDouble(registers, toFloat(args[0])), rationale: 'Float to double, exact.' },
  __truncdfsf2: { handler: ({ args }) => floatBits(Math.fround(toDouble(args[0], args[1]))), rationale: 'Double to float, round to nearest-even.' },
  __fixdfsi: { handler: ({ args }) => toInt(toDouble(args[0], args[1]), -2147483648, 2147483647) | 0, rationale: 'Truncates toward zero, saturating.' },
  __fixsfsi: { handler: ({ args }) => toInt(toFloat(args[0]), -2147483648, 2147483647) | 0, rationale: 'Truncates toward zero, saturating.' },
  __fixunsdfsi: { handler: ({ args }) => toInt(toDouble(args[0], args[1]), 0, 4294967295) | 0, rationale: 'Truncates toward zero into 0..2^32-1.' },
  __fixunssfsi: { handler: ({ args }) => toInt(toFloat(args[0]), 0, 4294967295) | 0, rationale: 'Truncates toward zero into 0..2^32-1.' },
  __fixdfdi: {
    handler: ({ args, registers }) => return64(registers, toInt64(toDouble(args[0], args[1]), -(2n ** 63n), 2n ** 63n - 1n)),
    rationale: 'Double to 64-bit integer, truncating and saturating.',
  },
  __fixsfdi: {
    handler: ({ args, registers }) => return64(registers, toInt64(toFloat(args[0]), -(2n ** 63n), 2n ** 63n - 1n)),
    rationale: 'Float to 64-bit integer, truncating and saturating.',
  },
  __fixunssfdi: {
    handler: ({ args, registers }) => return64(registers, toInt64(toFloat(args[0]), 0n, 2n ** 64n - 1n)),
    rationale: 'Float to unsigned 64-bit integer, truncating and saturating.',
  },
  __floatsidf: { handler: ({ args, registers }) => returnDouble(registers, args[0] | 0), rationale: 'Signed int to double, exact.' },
  __floatunsidf: { handler: ({ args, registers }) => returnDouble(registers, args[0] >>> 0), rationale: 'Unsigned int to double, exact.' },
  __floatsisf: { handler: ({ args }) => floatBits(Math.fround(args[0] | 0)), rationale: 'Signed int to float, round to nearest-even.' },
  __floatunsisf: { handler: ({ args }) => floatBits(Math.fround(args[0] >>> 0)), rationale: 'Unsigned int to float, round to nearest-even.' },
  __floatdidf: { handler: ({ args, registers }) => returnDouble(registers, Number(int64(args[0], args[1]))), rationale: '64-bit int to double, rounded once.' },
  __floatundidf: { handler: ({ args, registers }) => returnDouble(registers, Number(uint64(args[0], args[1]))), rationale: 'Unsigned 64-bit int to double, rounded once.' },
  __floatdisf: { handler: ({ args }) => floatBits(bigToFloat(int64(args[0], args[1]))), rationale: '64-bit int to float, rounded once.' },
  __floatundisf: { handler: ({ args }) => floatBits(bigToFloat(uint64(args[0], args[1]))), rationale: 'Unsigned 64-bit int to float, rounded once.' },
  __eqdf2: { handler: dcmp(1), rationale: 'Zero when equal; unordered is unequal.' },
  __nedf2: { handler: dcmp(1), rationale: 'Zero when equal; unordered is unequal.' },
  __ltdf2: { handler: dcmp(1), rationale: 'Negative when less; unordered gives +1.' },
  __ledf2: { handler: dcmp(1), rationale: 'Non-positive when less or equal; unordered gives +1.' },
  __gtdf2: { handler: dcmp(-1), rationale: 'Positive when greater; unordered gives -1.' },
  __gedf2: { handler: dcmp(-1), rationale: 'Non-negative when greater or equal; unordered gives -1.' },
  __eqsf2: { handler: fcmp(1), rationale: 'Zero when equal; unordered is unequal.' },
  __nesf2: { handler: fcmp(1), rationale: 'Zero when equal; unordered is unequal.' },
  __ltsf2: { handler: fcmp(1), rationale: 'Negative when less; unordered gives +1.' },
  __lesf2: { handler: fcmp(1), rationale: 'Non-positive when less or equal; unordered gives +1.' },
  __gtsf2: { handler: fcmp(-1), rationale: 'Positive when greater; unordered gives -1.' },
  __gesf2: { handler: fcmp(-1), rationale: 'Non-negative when greater or equal; unordered gives -1.' },
  __unorddf2: {
    handler: ({ args }) => (Number.isNaN(toDouble(args[0], args[1])) || Number.isNaN(toDouble(args[2], args[3])) ? 1 : 0),
    rationale: 'Nonzero when either is NaN.',
  },
  __unordsf2: { handler: ({ args }) => (Number.isNaN(toFloat(args[0])) || Number.isNaN(toFloat(args[1])) ? 1 : 0), rationale: 'Nonzero when either is NaN.' },
  __powidf2: {
    handler: ({ args, registers }) => returnDouble(registers, powi(toDouble(args[0], args[1]), args[2] | 0, (v) => v)),
    rationale: 'Double to an integer power, multiplying in libgcc\'s documented order.',
  },
  __powisf2: {
    handler: ({ args }) => floatBits(powi(toFloat(args[0]), args[1] | 0, Math.fround)),
    rationale: 'Float to an integer power, each product rounded to binary32.',
  },
  // Integer helpers the C3's ROM provides alongside. RV32IMC has M, so GCC
  // rarely emits the 32-bit ones; a division by zero answers as the M
  // extension's instructions do.
  __divsi3: { handler: ({ args }) => (args[1] === 0 ? -1 : args[0] === -2147483648 && args[1] === -1 ? args[0] : (args[0] / args[1]) | 0), rationale: 'Signed division, truncating.' },
  __modsi3: { handler: ({ args }) => (args[1] === 0 ? args[0] : args[0] === -2147483648 && args[1] === -1 ? 0 : args[0] % args[1] | 0), rationale: 'Signed remainder.' },
  __udivsi3: { handler: ({ args }) => (args[1] === 0 ? -1 : Math.floor((args[0] >>> 0) / (args[1] >>> 0)) | 0), rationale: 'Unsigned division.' },
  __umodsi3: { handler: ({ args }) => (args[1] === 0 ? args[0] : (args[0] >>> 0) % (args[1] >>> 0) | 0), rationale: 'Unsigned remainder.' },
  __mulsi3: { handler: ({ args }) => Math.imul(args[0], args[1]), rationale: 'Low 32 bits of the product.' },
  __clzdi2: { handler: ({ args }) => clz64(uint64(args[0], args[1])), rationale: 'Leading zeros of a 64-bit value.' },
  __ctzdi2: {
    handler: ({ args }) => {
      const v = uint64(args[0], args[1]);
      return v === 0n ? 64 : (v & -v).toString(2).length - 1;
    },
    rationale: 'Trailing zeros of a 64-bit value.',
  },
  __popcountdi2: { handler: ({ args }) => [...uint64(args[0], args[1]).toString(2)].filter((c) => c === '1').length, rationale: 'Set bits of a 64-bit value.' },
  __bswapdi2: {
    handler: ({ args, registers }) => {
      const swap = (w: number) => (((w & 0xff) << 24) | ((w & 0xff00) << 8) | ((w >>> 8) & 0xff00) | (w >>> 24)) | 0;
      const lo = swap(args[1]);
      registers[A0 + 1] = swap(args[0]);
      registers[A0] = lo;
      return lo;
    },
    rationale: 'Reverses the eight bytes.',
  },
  __paritysi2: {
    handler: ({ args }) => {
      let v = args[0] >>> 0;
      let p = 0;
      while (v) {
        p ^= v & 1;
        v >>>= 1;
      }
      return p;
    },
    rationale: 'Parity of the set bits.',
  },
  __clrsbsi2: {
    handler: ({ args }) => {
      const v = args[0] | 0;
      return Math.clz32(v < 0 ? ~v : v) - 1;
    },
    rationale: 'Redundant sign bits.',
  },
  __clrsbdi2: {
    handler: ({ args }) => {
      const v = int64(args[0], args[1]);
      return clz64(BigInt.asUintN(64, v < 0n ? ~v : v)) - 1;
    },
    rationale: 'Redundant sign bits of a 64-bit value.',
  },
  __udivmoddi4: {
    handler: ({ args, registers, bus }) => {
      const n = uint64(args[0], args[1]);
      const d = uint64(args[2], args[3]);
      const q = d === 0n ? 2n ** 64n - 1n : n / d;
      const r = d === 0n ? n : n % d;
      const remainder = args[4] >>> 0;
      if (remainder) {
        bus.writeUint32(remainder, Number(r & 0xffffffffn));
        bus.writeUint32(remainder + 4, Number(r >> 32n));
      }
      return return64(registers, q);
    },
    rationale: 'Unsigned 64-bit quotient, with the remainder stored through the pointer when one is given.',
  },
};

function bind(addresses: Record<string, number>): RomFunction[] {
  return Object.entries(addresses).map(([name, address]) => {
    const entry = HANDLERS[name];
    if (!entry) throw new Error(`No soft-float implementation for ${name}`);
    return { address: address >>> 0, name, ...entry };
  });
}

/** The C3's addresses, from esp32c3.rom.libgcc.ld. */
const ESP32C3_ADDRESSES: Record<string, number> = {
  __adddf3: 0x4000076c,
  __addsf3: 0x40000770,
  __bswapdi2: 0x40000784,
  __clrsbdi2: 0x40000790,
  __clrsbsi2: 0x40000794,
  __clzdi2: 0x40000798,
  __ctzdi2: 0x400007a4,
  __divdf3: 0x400007b0,
  __divsf3: 0x400007bc,
  __divsi3: 0x400007c0,
  __eqdf2: 0x400007c4,
  __eqsf2: 0x400007c8,
  __extendsfdf2: 0x400007cc,
  __fixdfdi: 0x400007d8,
  __fixdfsi: 0x400007dc,
  __fixsfdi: 0x400007e0,
  __fixsfsi: 0x400007e4,
  __fixunsdfsi: 0x400007e8,
  __fixunssfdi: 0x400007ec,
  __fixunssfsi: 0x400007f0,
  __floatdidf: 0x400007f4,
  __floatdisf: 0x400007f8,
  __floatsidf: 0x400007fc,
  __floatsisf: 0x40000800,
  __floatundidf: 0x40000804,
  __floatundisf: 0x40000808,
  __floatunsidf: 0x4000080c,
  __floatunsisf: 0x40000810,
  __gedf2: 0x40000818,
  __gesf2: 0x4000081c,
  __gtdf2: 0x40000820,
  __gtsf2: 0x40000824,
  __ledf2: 0x40000828,
  __lesf2: 0x4000082c,
  __ltdf2: 0x40000834,
  __ltsf2: 0x40000838,
  __modsi3: 0x40000840,
  __muldf3: 0x40000848,
  __mulsf3: 0x40000854,
  __mulsi3: 0x40000858,
  __nedf2: 0x40000864,
  __negdf2: 0x40000868,
  __negsf2: 0x40000870,
  __nesf2: 0x4000087c,
  __paritysi2: 0x40000880,
  __popcountdi2: 0x40000884,
  __powidf2: 0x4000088c,
  __powisf2: 0x40000890,
  __subdf3: 0x40000894,
  __subsf3: 0x40000898,
  __truncdfsf2: 0x400008a4,
  __udivmoddi4: 0x400008b0,
  __udivsi3: 0x400008b4,
  __umodsi3: 0x400008c0,
  __unorddf2: 0x400008c4,
  __unordsf2: 0x400008c8,
};

/** The C6's addresses, from esp32c6.rom.rvfp.ld. */
const ESP32C6_ADDRESSES: Record<string, number> = {
  __bswapdi2: 0x400008a4,
  __clrsbdi2: 0x400008b0,
  __clrsbsi2: 0x400008b4,
  __clzdi2: 0x400008b8,
  __ctzdi2: 0x400008c4,
  __divdf3: 0x400008d0,
  __divsf3: 0x400008dc,
  __divsi3: 0x400008e0,
  __modsi3: 0x40000960,
  __mulsi3: 0x40000978,
  __negdf2: 0x40000988,
  __negsf2: 0x40000990,
  __paritysi2: 0x400009a0,
  __popcountdi2: 0x400009a4,
  __powidf2: 0x400009ac,
  __powisf2: 0x400009b0,
  __udivmoddi4: 0x400009d0,
  __udivsi3: 0x400009d4,
  __umodsi3: 0x400009e0,
  __unorddf2: 0x400009e4,
  __unordsf2: 0x400009e8,
  __adddf3: 0x400009f4,
  __addsf3: 0x400009f8,
  __eqdf2: 0x400009fc,
  __eqsf2: 0x40000a00,
  __extendsfdf2: 0x40000a04,
  __fixdfdi: 0x40000a08,
  __fixdfsi: 0x40000a0c,
  __fixsfdi: 0x40000a10,
  __fixsfsi: 0x40000a14,
  __fixunsdfsi: 0x40000a18,
  __fixunssfdi: 0x40000a1c,
  __fixunssfsi: 0x40000a20,
  __floatdidf: 0x40000a24,
  __floatdisf: 0x40000a28,
  __floatsidf: 0x40000a2c,
  __floatsisf: 0x40000a30,
  __floatundidf: 0x40000a34,
  __floatundisf: 0x40000a38,
  __floatunsidf: 0x40000a3c,
  __floatunsisf: 0x40000a40,
  __gedf2: 0x40000a44,
  __gesf2: 0x40000a48,
  __gtdf2: 0x40000a4c,
  __gtsf2: 0x40000a50,
  __ledf2: 0x40000a54,
  __lesf2: 0x40000a58,
  __ltdf2: 0x40000a5c,
  __ltsf2: 0x40000a60,
  __muldf3: 0x40000a64,
  __mulsf3: 0x40000a68,
  __nedf2: 0x40000a6c,
  __nesf2: 0x40000a70,
  __subdf3: 0x40000a74,
  __subsf3: 0x40000a78,
  __truncdfsf2: 0x40000a7c,
};

export const ESP32C3_ROM_SOFT_FLOAT: RomFunction[] = bind(ESP32C3_ADDRESSES);
export const ESP32C6_ROM_SOFT_FLOAT: RomFunction[] = bind(ESP32C6_ADDRESSES);
