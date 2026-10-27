// The boot ROM float and double slots, one contract at a time.
//
// tests/rp2040.integration.mts checks what compiled sketches print. This
// checks the edges a sketch rarely reaches but a wrong implementation gets
// wrong: rounding direction and saturation of the integer conversions,
// single rounding of 64-bit integers, NaN in comparisons, and which registers
// carry 64-bit and paired results.

import { romFloatCall, SF_TRAP_BASE, SD_TRAP_BASE, type RomFloatCore } from '../src/simulation/rp2040/romFloat';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const f64 = new Float64Array(1);
const w64 = new Uint32Array(f64.buffer);
const fbits = (x: number) => ((f32[0] = x), u32[0]);
const fval = (bits: number) => ((u32[0] = bits), f32[0]);
const dwords = (x: number): [number, number] => ((f64[0] = x), [w64[0], w64[1]]);
const dval = (lo: number, hi: number) => ((w64[0] = lo), (w64[1] = hi), f64[0]);

function core(...regs: number[]): RomFloatCore {
  const registers = new Uint32Array(16);
  regs.forEach((v, i) => (registers[i] = v >>> 0));
  return { registers, N: false, Z: false, C: false, V: false };
}
const sf = (offset: number, c: RomFloatCore) => romFloatCall(SF_TRAP_BASE + offset / 4, c);
const sd = (offset: number, c: RomFloatCore) => romFloatCall(SD_TRAP_BASE + offset / 4, c);
const asInt = (v: number) => v | 0;

// Correct rounding of the basic operations.
{
  const c = core(fbits(1), fbits(3));
  sf(0x0c, c);
  check(c.registers[0] === fbits(1 / 3), 'fdiv(1, 3) is the correctly rounded single');
  const d = core(...dwords(0.1), ...dwords(0.2));
  sd(0x00, d);
  check(dval(d.registers[0], d.registers[1]) === 0.1 + 0.2, 'dadd(0.1, 0.2) is the IEEE double sum, in r0:r1');
}

// float2int rounds towards minus infinity and saturates — the SDK builds C's
// truncating (int) cast on that.
for (const [x, want] of [[2.7, 2], [-2.7, -3], [-0.5, -1], [3e9, 0x7fffffff], [-3e9, -0x80000000], [NaN, 0]] as const) {
  const c = core(fbits(x));
  sf(0x1c, c);
  check(asInt(c.registers[0]) === want, `float2int(${x}) = ${want} (${asInt(c.registers[0])})`);
}
{
  const c = core(fbits(-1.5));
  sf(0x24, c);
  check(c.registers[0] === 0, 'float2uint of a negative saturates to 0');
  const big = core(fbits(5e9));
  sf(0x24, big);
  check(big.registers[0] === 0xffffffff, 'float2uint above 2^32 saturates to 0xffffffff');
  const fix = core(fbits(0.5), 16);
  sf(0x20, fix);
  check(fix.registers[0] === 0x8000, 'float2fix(0.5, 16) is 0x8000, the datasheet example');
  const back = core(0x8000, 16);
  sf(0x30, back);
  check(fval(back.registers[0]) === 0.5, 'fix2float(0x8000, 16) is 0.5');
}

// 64-bit integers to single precision are rounded once: 2^53 + 2^29 + 1 lies
// just above the halfway point between two singles, which rounding via a
// double first (to 2^53 + 2^29, an exact tie) would get wrong.
{
  const v = (1n << 53n) + (1n << 29n) + 1n;
  const c = core(Number(v & 0xffffffffn), Number(v >> 32n));
  sf(0x5c, c);
  check(fval(c.registers[0]) === 2 ** 53 + 2 ** 30, `int642float(2^53 + 2^29 + 1) rounds up, once (${fval(c.registers[0])})`);
  const neg = -5n;
  const u = BigInt.asUintN(64, neg);
  const n = core(Number(u & 0xffffffffn), Number(u >> 32n));
  sf(0x5c, n);
  check(fval(n.registers[0]) === -5, 'int642float(-5) is -5');
  const i64 = core(fbits(-2.5));
  sf(0x6c, i64);
  check(BigInt.asIntN(64, (BigInt(i64.registers[1]) << 32n) | BigInt(i64.registers[0])) === -3n, 'float2int64(-2.5) is -3, in r0:r1');
}

// Comparisons, including the flags variant and an unordered NaN.
{
  const lt = core(fbits(1), fbits(2));
  sf(0x54, lt);
  check(asInt(lt.registers[0]) === -1, 'fcmp(1, 2) is -1');
  const flags = core(fbits(2), fbits(2));
  sf(0x14, flags);
  check(flags.Z && flags.C && !flags.N, 'the flags variant sets Z (and C) for equal values');
  const nan = core(fbits(NaN), fbits(1));
  sf(0x14, nan);
  check(!nan.Z && !nan.N && nan.C, 'NaN compares unordered: not equal, not less');
}

// Paired and widened results land in the registers the SDK reads.
{
  const c = core(...dwords(1));
  sd(0x48, c);
  check(dval(c.registers[0], c.registers[1]) === Math.sin(1) && dval(c.registers[2], c.registers[3]) === Math.cos(1), 'dsincos returns sin in r0:r1 and cos in r2:r3');
  const w = core(fbits(0.1));
  sf(0x7c, w);
  check(dval(w.registers[0], w.registers[1]) === fval(fbits(0.1)), 'float2double widens exactly, into r0:r1');
  const n = core(...dwords(0.1));
  sd(0x7c, n);
  check(n.registers[0] === fbits(0.1), 'double2float rounds to the nearest single');
}

check(!romFloatCall(0, core()) && !romFloatCall(0x7f, core()), 'other breakpoints (the SDK\'s panic) are not ours');

console.log(`\n--- ${failures} failing`);
process.exit(failures ? 1 : 0);
