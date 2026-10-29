// The Cortex-M floating-point unit: FPv4-SP on the M4F, FPv5-D16 on the M7.
//
// Single-precision results are computed in double precision and rounded once
// to single, which is exactly IEEE-754 for add, subtract, multiply, divide and
// square root (a double carries more than twice a single's precision, so the
// double rounding is innocuous). Fused multiply-adds are rounded once from the
// exact result: in single precision by rounding the double sum to odd first,
// in double precision by an exact integer computation. Everything uses
// round-to-nearest-even except the integer conversions, which honour VCVT's
// round-toward-zero or, for VCVTR, the FPSCR rounding mode.

import type { CortexM } from './cortexM';

const f32 = Math.fround;
const scratch = new DataView(new ArrayBuffer(8));

function bitsOfDouble(v: number): [number, number] {
  scratch.setFloat64(0, v, true);
  return [scratch.getUint32(0, true), scratch.getUint32(4, true)];
}

function doubleOfBits(lo: number, hi: number): number {
  scratch.setUint32(0, lo >>> 0, true);
  scratch.setUint32(4, hi >>> 0, true);
  return scratch.getFloat64(0, true);
}

/** The exact error of a + b in double precision (TwoSum). */
function twoSumError(a: number, b: number, s: number): number {
  const bb = s - a;
  return a - (s - bb) + (b - bb);
}

/** a × b + c rounded once to single precision. a, b, c are singles. */
export function fmaSingle(a: number, b: number, c: number): number {
  const p = a * b; // exact: 24 + 24 bits fit a double's 53
  const s = p + c;
  if (!Number.isFinite(s) || s === 0) return f32(s);
  const e = twoSumError(p, c, s);
  if (e === 0) return f32(s);
  // Round to odd: if the double result is not exact, make its last bit 1 so
  // the final rounding to single cannot land on a false midpoint.
  const [lo, hi] = bitsOfDouble(s);
  if ((lo & 1) === 0) {
    const towardsE = (e > 0) === (s > 0) ? 1 : -1;
    const adjusted = lo + towardsE;
    const nlo = adjusted >>> 0;
    const nhi = adjusted < 0 ? hi - 1 : adjusted > 0xffffffff ? hi + 1 : hi;
    return f32(doubleOfBits(nlo, nhi));
  }
  return f32(s);
}

/** Decomposes a finite double into an exact integer mantissa and binary exponent. */
function decompose(v: number): [bigint, number] {
  const [lo, hi] = bitsOfDouble(v);
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e: number;
  if (exp === 0) e = -1074;
  else {
    mant |= 1n << 52n;
    e = exp - 1075;
  }
  if (hi >>> 31) mant = -mant;
  return [mant, e];
}

/** a × b + c rounded once to double precision. */
export function fmaDouble(a: number, b: number, c: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return a * b + c;
  if (a === 0 || b === 0) return a * b + c;
  if (c === 0) return a * b;
  const [ma, ea] = decompose(a);
  const [mb, eb] = decompose(b);
  const [mc, ec] = decompose(c);
  let mp = ma * mb;
  let ep = ea + eb;
  let m2 = mc;
  let e2 = ec;
  // Align exponents.
  if (ep > e2) {
    mp <<= BigInt(ep - e2);
    ep = e2;
  } else {
    m2 <<= BigInt(e2 - ep);
  }
  const sum = mp + m2;
  if (sum === 0n) return 0;
  // Round the exact integer sum × 2^ep to a double: shift to 53 significant
  // bits with round-half-even.
  const negative = sum < 0n;
  let mag = negative ? -sum : sum;
  let e = ep;
  const bits = mag.toString(2).length;
  if (bits > 53) {
    const drop = BigInt(bits - 53);
    const rest = mag & ((1n << drop) - 1n);
    const half = 1n << (drop - 1n);
    mag >>= drop;
    e += Number(drop);
    if (rest > half || (rest === half && (mag & 1n) === 1n)) mag += 1n;
  }
  const result = Number(mag) * 2 ** e;
  return negative ? -result : result;
}

function vfpExpandSingle(imm8: number): number {
  const bits = ((imm8 & 0x80) << 24) | (imm8 & 0x40 ? 0x3e000000 : 0x40000000) | ((imm8 & 0x3f) << 19);
  scratch.setUint32(0, bits >>> 0, true);
  return scratch.getFloat32(0, true);
}

function vfpExpandDouble(imm8: number): number {
  const hi = ((imm8 & 0x80) << 24) | (imm8 & 0x40 ? 0x3fc00000 : 0x40000000) | ((imm8 & 0x3f) << 16);
  return doubleOfBits(0, hi >>> 0);
}

/** Float to integer with saturation; mode 3 is round toward zero, 0 nearest, 1 +inf, 2 -inf. */
function toInt(v: number, signed: boolean, mode: number): number {
  if (Number.isNaN(v)) return 0;
  let r: number;
  switch (mode) {
    case 0: {
      const fl = Math.floor(v);
      const diff = v - fl;
      r = diff > 0.5 ? fl + 1 : diff < 0.5 ? fl : fl % 2 === 0 ? fl : fl + 1;
      break;
    }
    case 1:
      r = Math.ceil(v);
      break;
    case 2:
      r = Math.floor(v);
      break;
    default:
      r = Math.trunc(v);
  }
  if (signed) return Math.max(-0x80000000, Math.min(0x7fffffff, r)) >>> 0;
  return Math.max(0, Math.min(0xffffffff, r)) >>> 0;
}

function roundIntegral(v: number, mode: number): number {
  if (!Number.isFinite(v)) return v;
  switch (mode) {
    case 0: {
      const fl = Math.floor(v);
      const diff = v - fl;
      const r = diff > 0.5 ? fl + 1 : diff < 0.5 ? fl : fl % 2 === 0 ? fl : fl + 1;
      return r === 0 && v < 0 ? -0 : r;
    }
    case 1:
      return Math.ceil(v);
    case 2:
      return Math.floor(v);
    case 4: {
      // ties away from zero
      const r = Math.sign(v) * Math.round(Math.abs(v));
      return r === 0 && v < 0 ? -0 : r;
    }
    default:
      return Math.trunc(v);
  }
}

function compareFlags(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return 0x3; // C V
  if (a === b) return 0x6; // Z C
  if (a < b) return 0x8; // N
  return 0x2; // C
}

export function executeFp(core: CortexM, hw1: number, hw2: number): number {
  const s = core.fpSingle;
  const d = core.fpDouble;
  const regs = core.fpRegs;
  const dp = ((hw2 >> 8) & 1) === 1;
  const D = (hw1 >> 6) & 1;
  const Vd = (hw2 >> 12) & 0xf;
  const N = (hw2 >> 7) & 1;
  const Vn = hw1 & 0xf;
  const M = (hw2 >> 5) & 1;
  const Vm = hw2 & 0xf;
  const sd = (Vd << 1) | D;
  const sn = (Vn << 1) | N;
  const sm = (Vm << 1) | M;
  const dd = (D << 4) | Vd;
  const dn = (N << 4) | Vn;
  const dm = (M << 4) | Vm;
  const top = hw1 >> 8;

  if (dp && core.config.fpu !== 'dp' && (top & 0xfe) === 0xee && ((hw2 >> 4) & 1) === 0) {
    core.fpUndefined(hw1, hw2);
  }

  // FPv5 (M7): VSEL, VMAXNM/VMINNM, VRINTA/N/P/M, VCVTA/N/P/M — all 0xFE prefix.
  if (top === 0xfe) {
    if (core.config.fpu !== 'dp') core.fpUndefined(hw1, hw2);
    const opc = (hw1 >> 4) & 0xb;
    if ((hw1 & 0xff80) === 0xfe00 && ((hw2 >> 4) & 1) === 0) {
      // VSEL: cc = hw1 bits 5:4 → EQ, VS, GE, GT
      const cc = (hw1 >> 4) & 3;
      const take = [core.z === 1, core.v === 1, core.n === core.v, core.z === 0 && core.n === core.v][cc];
      if (dp) d[dd] = take ? d[dn] : d[dm];
      else regs[sd] = take ? regs[sn] : regs[sm];
      return 1;
    }
    if ((hw1 & 0xffb0) === 0xfe80 && ((hw2 >> 4) & 1) === 0) {
      const min = (hw2 >> 6) & 1;
      const a = dp ? d[dn] : s[sn];
      const b = dp ? d[dm] : s[sm];
      let r: number;
      if (Number.isNaN(a)) r = b;
      else if (Number.isNaN(b)) r = a;
      else r = min ? Math.min(a, b) : Math.max(a, b);
      if (dp) d[dd] = r;
      else s[sd] = r;
      return 1;
    }
    if ((hw1 & 0xffbc) === 0xfeb8 && ((hw2 >> 6) & 1) === 1) {
      // VRINTA/N/P/M: rm = hw1 bits 1:0 → A N P M
      const rm = hw1 & 3;
      const mode = [4, 0, 1, 2][rm];
      if (dp) d[dd] = roundIntegral(d[dm], mode);
      else s[sd] = roundIntegral(s[sm], mode);
      return 1;
    }
    if ((hw1 & 0xffbc) === 0xfebc && ((hw2 >> 6) & 1) === 1) {
      // VCVTA/N/P/M to integer
      const rm = hw1 & 3;
      const mode = [4, 0, 1, 2][rm];
      const signed = ((hw2 >> 7) & 1) === 1;
      const v = dp ? d[dm] : s[sm];
      const r = roundIntegral(v, mode);
      regs[sd] = toInt(r, signed, 3);
      return 1;
    }
    void opc;
    core.fpUndefined(hw1, hw2);
  }

  // Extension register load/store and 64-bit transfers: 1110 110x
  if ((top & 0xfe) === 0xec) {
    const op = (hw1 >> 4) & 0x1f;
    const rn = hw1 & 0xf;
    const imm8 = hw2 & 0xff;
    if ((op & 0x1e) === 0x04) {
      // VMOV between two core registers and two singles / one double
      const toCore = (op & 1) === 1;
      const rt = (hw2 >> 12) & 0xf;
      const rt2 = hw1 & 0xf;
      if (dp) {
        const idx = dm * 2;
        if (toCore) {
          core.r[rt] = regs[idx];
          core.r[rt2] = regs[idx + 1];
        } else {
          regs[idx] = core.r[rt];
          regs[idx + 1] = core.r[rt2];
        }
      } else {
        if (toCore) {
          core.r[rt] = regs[sm];
          core.r[rt2] = regs[(sm + 1) & 31];
        } else {
          regs[sm] = core.r[rt];
          regs[(sm + 1) & 31] = core.r[rt2];
        }
      }
      return 2;
    }
    const p = (op >> 4) & 1;
    const u = (op >> 3) & 1;
    const w = (op >> 1) & 1;
    const load = (op & 1) === 1;
    if (p === 1 && w === 0) {
      // VLDR / VSTR
      const base = rn === 15 ? core.alignedPc : core.r[rn];
      const address = (u ? base + imm8 * 4 : base - imm8 * 4) >>> 0;
      if (dp) {
        if (load) {
          regs[dd * 2] = core.read32(address);
          regs[dd * 2 + 1] = core.read32(address + 4);
        } else {
          core.write32(address, regs[dd * 2]);
          core.write32(address + 4, regs[dd * 2 + 1]);
        }
      } else if (load) regs[sd] = core.read32(address);
      else core.write32(address, regs[sd]);
      return 2;
    }
    // VLDM / VSTM (IA with optional writeback, DB with writeback): VPUSH / VPOP
    const words = imm8;
    const base = core.r[rn];
    let address = u ? base : (base - words * 4) >>> 0;
    const first = dp ? dd * 2 : sd;
    for (let i = 0; i < words; i++) {
      const reg = (first + i) & 31;
      if (load) regs[reg] = core.read32(address);
      else core.write32(address, regs[reg]);
      address = (address + 4) >>> 0;
    }
    if (w) core.r[rn] = u ? (base + words * 4) >>> 0 : (base - words * 4) >>> 0;
    return 1 + words;
  }

  if ((top & 0xff) !== 0xee) core.fpUndefined(hw1, hw2);

  if ((hw2 >> 4) & 1) {
    // 8, 16 and 32-bit transfers between core and extension registers
    const l = (hw1 >> 4) & 1;
    const c = (hw2 >> 8) & 1;
    const a = (hw1 >> 5) & 7;
    const rt = (hw2 >> 12) & 0xf;
    if (c === 0 && a === 0) {
      if (l) core.r[rt] = regs[sn];
      else regs[sn] = core.coreReg(rt);
      return 1;
    }
    if (c === 0 && a === 7) {
      if (l) {
        if (Vn === 1) {
          if (rt === 15) core.copyFpFlags();
          else core.r[rt] = core.fpscr;
        } else if (Vn === 0) core.r[rt] = core.config.fpu === 'dp' ? 0x41023040 : 0x41023040; // FPSID
        else if (Vn === 6) core.r[rt] = core.config.fpu === 'dp' ? 0x11000011 : 0x11000011; // MVFR1
        else if (Vn === 7) core.r[rt] = core.config.fpu === 'dp' ? 0x10110221 : 0x10110021; // MVFR0
        else core.r[rt] = 0;
      } else if (Vn === 1) core.fpscr = core.coreReg(rt) & 0xf7c0009f;
      return 1;
    }
    if (c === 1 && (a & 3) === 0 && ((hw2 >> 5) & 3) === 0) {
      // VMOV.32 Dd[x], Rt / Rt, Dn[x]
      const x = (hw1 >> 5) & 1;
      const reg = dn * 2 + x;
      if (l) core.r[rt] = regs[reg];
      else regs[reg] = core.coreReg(rt);
      return 1;
    }
    core.fpUndefined(hw1, hw2);
  }

  // Data processing
  const opc1 = ((hw1 >> 5) & 4) | ((hw1 >> 4) & 3);
  const op = (hw2 >> 6) & 1;
  const get = (i: number, isDouble: boolean) => (isDouble ? d[i] : s[i]);
  const put = (v: number) => {
    if (dp) d[dd] = v;
    else s[sd] = v;
  };
  const rd = dp ? d[dd] : s[sd];
  const rn = dp ? d[dn] : s[sn];
  const rm = dp ? d[dm] : s[sm];
  const round = dp ? (v: number) => v : f32;
  switch (opc1) {
    case 0: {
      const prod = round(rn * rm);
      put(op ? round(rd - prod) : round(rd + prod));
      return 3;
    }
    case 1: {
      const prod = round(rn * rm);
      // op=1 VNMLA: -d - n*m ; op=0 VNMLS: -d + n*m
      put(op ? round(-rd - prod) : round(-rd + prod));
      return 3;
    }
    case 2: {
      const prod = round(rn * rm);
      put(op ? -prod : prod);
      return 1;
    }
    case 3:
      put(op ? round(rn - rm) : round(rn + rm));
      return 1;
    case 4:
      if (op) core.fpUndefined(hw1, hw2);
      put(round(rn / rm));
      return dp ? 30 : 14;
    case 5: {
      // VFNMA (op=1): -d - n*m ; VFNMS (op=0): -d + n*m  (fused)
      const fma = dp ? fmaDouble : fmaSingle;
      put(op ? fma(-rn, rm, -rd) : fma(rn, rm, -rd));
      return 3;
    }
    case 6: {
      // VFMA (op=0): d + n*m ; VFMS (op=1): d - n*m  (fused)
      const fma = dp ? fmaDouble : fmaSingle;
      put(op ? fma(-rn, rm, rd) : fma(rn, rm, rd));
      return 3;
    }
    default:
      break;
  }

  // opc1 = 1x11: the other operations
  const opc2 = hw1 & 0xf;
  const opc3 = (hw2 >> 6) & 3;
  if ((opc3 & 1) === 0) {
    // VMOV immediate
    const imm8 = ((hw1 & 0xf) << 4) | (hw2 & 0xf);
    put(dp ? vfpExpandDouble(imm8) : vfpExpandSingle(imm8));
    return 1;
  }
  switch (opc2) {
    case 0x0:
      if (opc3 === 1) {
        // VMOV register
        if (dp) {
          regs[dd * 2] = regs[dm * 2];
          regs[dd * 2 + 1] = regs[dm * 2 + 1];
        } else regs[sd] = regs[sm];
      } else if (dp) {
        regs[dd * 2] = regs[dm * 2];
        regs[dd * 2 + 1] = regs[dm * 2 + 1] & 0x7fffffff;
      } else regs[sd] = regs[sm] & 0x7fffffff; // VABS
      return 1;
    case 0x1:
      if (opc3 === 1) {
        // VNEG
        if (dp) {
          regs[dd * 2] = regs[dm * 2];
          regs[dd * 2 + 1] = regs[dm * 2 + 1] ^ 0x80000000;
        } else regs[sd] = regs[sm] ^ 0x80000000;
        return 1;
      }
      put(round(Math.sqrt(rm))); // VSQRT
      return dp ? 30 : 14;
    case 0x2:
    case 0x3: {
      // VCVTB / VCVTT between half and single
      const top16 = (hw2 >> 7) & 1;
      if (opc2 === 0x2) {
        const half = top16 ? regs[sm] >>> 16 : regs[sm] & 0xffff;
        s[sd] = halfToFloat(half);
      } else {
        const h = floatToHalf(s[sm]);
        regs[sd] = top16 ? ((regs[sd] & 0xffff) | (h << 16)) >>> 0 : ((regs[sd] & 0xffff0000) | h) >>> 0;
      }
      return 1;
    }
    case 0x4:
    case 0x5: {
      // VCMP / VCMPE, against a register or zero
      const b = opc2 === 0x5 ? 0 : rm;
      const flags = compareFlags(rd, b);
      core.fpscr = ((core.fpscr & 0x0fffffff) | (flags << 28)) >>> 0;
      return 1;
    }
    case 0x6: {
      // VRINTR (op... opc3=01) / VRINTZ (opc3=11)
      if (core.config.fpu !== 'dp') core.fpUndefined(hw1, hw2);
      const mode = opc3 === 3 ? 3 : (core.fpscr >> 22) & 3;
      put(roundIntegral(rm, mode));
      return 1;
    }
    case 0x7: {
      if (opc3 === 3) {
        // VCVT between single and double
        if (dp) s[sd] = f32(d[dm]);
        else d[dd] = s[sm];
        return 1;
      }
      // VRINTX
      if (core.config.fpu !== 'dp') core.fpUndefined(hw1, hw2);
      put(roundIntegral(rm, (core.fpscr >> 22) & 3));
      return 1;
    }
    case 0x8: {
      // VCVT integer → float: source is Sm as an integer
      const signed = ((hw2 >> 7) & 1) === 1;
      const raw = regs[sm];
      const value = signed ? raw | 0 : raw >>> 0;
      put(dp ? value : f32(value));
      return 1;
    }
    case 0xa:
    case 0xb:
    case 0xe:
    case 0xf: {
      // VCVT between float and fixed point (in place, Sd/Dd)
      const toFixed = (opc2 & 4) !== 0;
      const unsigned = (opc2 & 1) === 1;
      const sx = (hw2 >> 7) & 1; // 1 = 32-bit fixed, 0 = 16-bit
      const imm4i = ((hw2 & 0xf) << 1) | ((hw2 >> 5) & 1);
      const size = sx ? 32 : 16;
      const fbits = size - imm4i;
      if (toFixed) {
        const v = (dp ? d[dd] : s[sd]) * 2 ** fbits;
        let r = toInt(v, !unsigned, 3);
        if (size === 16) {
          const lim = unsigned ? [0, 0xffff] : [-0x8000, 0x7fff];
          const n = unsigned ? r >>> 0 : r | 0;
          const c = Math.max(lim[0], Math.min(lim[1], n));
          r = unsigned ? c : c & 0xffff;
        }
        if (dp) {
          regs[dd * 2] = r >>> 0;
          regs[dd * 2 + 1] = 0;
        } else regs[sd] = r >>> 0;
      } else {
        const raw = dp ? regs[dd * 2] : regs[sd];
        let n: number;
        if (size === 16) n = unsigned ? raw & 0xffff : ((raw & 0xffff) << 16) >> 16;
        else n = unsigned ? raw >>> 0 : raw | 0;
        const v = n / 2 ** fbits;
        if (dp) d[dd] = v;
        else s[sd] = v;
      }
      return 1;
    }
    case 0xc:
    case 0xd: {
      // VCVT/VCVTR float → integer, result in Sd
      const signed = opc2 === 0xd;
      const mode = (hw2 >> 7) & 1 ? 3 : (core.fpscr >> 22) & 3;
      const value = dp ? d[dm] : s[sm];
      regs[sd] = toInt(value, signed, mode === 3 ? 3 : [0, 1, 2, 3][mode]);
      return 1;
    }
    default:
      void get;
      core.fpUndefined(hw1, hw2);
  }
}

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

function floatToHalf(v: number): number {
  if (Number.isNaN(v)) return 0x7e00;
  const sign = v < 0 || Object.is(v, -0) ? 0x8000 : 0;
  const a = Math.abs(v);
  if (a === Infinity) return sign | 0x7c00;
  if (a >= 65520) return sign | 0x7c00;
  if (a < 2 ** -24 / 2) return sign;
  let exp = Math.floor(Math.log2(a));
  if (exp < -14) {
    const frac = Math.round(a / 2 ** -24);
    return sign | frac;
  }
  let frac = Math.round((a / 2 ** exp - 1) * 1024);
  if (frac === 1024) {
    frac = 0;
    exp++;
  }
  return sign | ((exp + 15) << 10) | frac;
}
