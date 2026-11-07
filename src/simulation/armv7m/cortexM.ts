// An ARMv7-M processor: the Cortex-M3, M4 and M7 in one interpreter.
//
// Written from the ARMv7-M Architecture Reference Manual (ARM DDI 0403E):
// the Thumb and Thumb-2 instruction sets in full, the IT block, exclusive
// access, the system control space (NVIC, SysTick, SCB, the DWT cycle
// counter), exception entry and return with the eight-byte stack alignment and
// the extended floating-point frame, and sleep on WFI/WFE. The floating-point
// unit is in ./fpu.ts: FPv4-SP on an M4F, FPv5 with double precision on an M7.
//
// What a chip adds is memory and peripherals, through ArmChip. Timing is one
// cycle per instruction with the documented extra cycles for loads, taken
// branches, multiplies and divides — close enough that millis() and delay()
// keep real time, which is what a sketch can observe.
//
// A taken branch costs two cycles: one, and a single-cycle pipeline refill,
// which is what the Arduino cores' cycle-counted delay loops are calibrated
// against (three cycles for a subs/bne pair).
//
// Not modelled: the MPU (its registers read back what was written and nothing
// is enforced), caches (their maintenance operations are accepted and do
// nothing, because a simulated memory is always coherent), debug halting,
// and lazy floating-point state preservation (the extended frame is stacked
// eagerly, which software cannot tell apart).

import type { ArmChip, CortexMConfig, MemoryRegion } from './bus';
import { executeFp } from './fpu';

/** Firmware did something the processor faults on, and the fault is not survivable here. */
export class ArmFault extends Error {
  constructor(message: string, readonly pc: number) {
    super(`${message} (PC 0x${(pc >>> 0).toString(16).padStart(8, '0')})`);
  }
}

const EXC = {
  NMI: 2,
  HARDFAULT: 3,
  MEMMANAGE: 4,
  BUSFAULT: 5,
  USAGEFAULT: 6,
  SVCALL: 11,
  DEBUGMON: 12,
  PENDSV: 14,
  SYSTICK: 15,
} as const;

interface FastRegion extends MemoryRegion {
  view: DataView;
}

/** A 32 × 32 → 64 bit unsigned multiply, as [low, high]. */
export function umul64(a: number, b: number): [number, number] {
  const aL = a & 0xffff;
  const aH = a >>> 16;
  const bL = b & 0xffff;
  const bH = b >>> 16;
  const ll = aL * bL;
  const lh = aL * bH;
  const hl = aH * bL;
  const hh = aH * bH;
  const mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff);
  const lo = (((mid & 0xffff) << 16) | (ll & 0xffff)) >>> 0;
  const hi = (hh + (lh >>> 16) + (hl >>> 16) + Math.floor(mid / 0x10000)) >>> 0;
  return [lo, hi];
}

/** Signed 32 × 32 → 64. */
export function smul64(a: number, b: number): [number, number] {
  const [lo, hi] = umul64(a >>> 0, b >>> 0);
  let h = hi;
  if (a & 0x80000000) h = (h - (b >>> 0)) >>> 0;
  if (b & 0x80000000) h = (h - (a >>> 0)) >>> 0;
  return [lo, h];
}

/** 64-bit add of (hi:lo) pairs. */
function add64(lo1: number, hi1: number, lo2: number, hi2: number): [number, number] {
  const lo = (lo1 >>> 0) + (lo2 >>> 0);
  const carry = lo > 0xffffffff ? 1 : 0;
  return [lo >>> 0, (hi1 + hi2 + carry) >>> 0];
}

function sub64(lo1: number, hi1: number, lo2: number, hi2: number): [number, number] {
  const lo = (lo1 >>> 0) - (lo2 >>> 0);
  const borrow = lo < 0 ? 1 : 0;
  return [lo >>> 0, (hi1 - hi2 - borrow) >>> 0];
}

const sx8 = (v: number) => (v << 24) >> 24;
const sx16 = (v: number) => (v << 16) >> 16;

export class CortexM {
  /** R0-R15. R13 is the active stack pointer; the banked one is held below. */
  readonly r = new Uint32Array(16);
  n = 0;
  z = 0;
  c = 0;
  v = 0;
  q = 0;
  /** APSR.GE, from the parallel add and subtract instructions. */
  ge = 0;
  itstate = 0;
  /** The exception number being handled, 0 in thread mode. */
  ipsr = 0;
  /** The stack pointer not currently in R13. */
  private otherSp = 0;
  control = 0;
  primask = 0;
  faultmask = 0;
  basepri = 0;

  /** S0-S31 as raw bits; D0-D15 overlay them. */
  readonly fpRegs = new Uint32Array(32);
  readonly fpSingle = new Float32Array(this.fpRegs.buffer);
  readonly fpDouble = new Float64Array(this.fpRegs.buffer);
  fpscr = 0;

  /** Cycles executed since reset. */
  cycles = 0;
  /** WFI or WFE: nothing executes until an interrupt (or event) arrives. */
  sleeping = false;
  private eventRegister = false;
  private exclusive = false;

  // System control block
  vtor = 0;
  private aircrPrigroup = 0;
  private scr = 0;
  private ccr = 0x200; // STKALIGN
  private shcsr = 0;
  private cfsr = 0;
  private hfsr = 0;
  cpacr = 0;
  private fpccr = 0xc0000000; // ASPEN | LSPEN
  private fpcar = 0;
  private fpdscr = 0;
  private demcr = 0;
  private dwtCtrl = 0x40000000;
  private dwtCycBase = 0;
  private dwtCycAt = 0;
  private readonly mpuRegs = new Uint32Array(16);
  private actlr = 0;

  // NVIC and system exceptions, indexed by exception number.
  private readonly excCount: number;
  private readonly priority: Uint8Array;
  private readonly pending: Uint8Array;
  private readonly active: Uint8Array;
  private readonly enabled: Uint8Array;
  /** Level of each interrupt line, for sources that stay asserted until serviced. */
  private readonly irqLine: Uint8Array;
  private readonly priorityMask: number;
  /** Set when anything that could make an exception takeable changes. */
  private recheck = true;

  // SysTick
  private stCsr = 0;
  private stRvr = 0;
  /** Cycle at which the counter was last (re)loaded, and the value it held then. */
  private stLoadCycle = 0;
  private stLoadValue = 0;
  /** Cycle at which the counter next wraps to zero, or Infinity when stopped. */
  private stNextWrap = Infinity;
  /** SysTick's clock when CLKSOURCE = 0, as a divisor of the CPU's. */
  systickExternalDivisor = 8;

  private regions: FastRegion[] = [];
  private lastRegion: FastRegion | null = null;
  /** The operand value of PC: the current instruction's address plus 4. */
  private pcOperand = 0;
  /** Address of the instruction being executed. */
  private pc = 0;
  private itAdvance = true;

  /** Called when firmware runs BKPT: semihosting and debug traps. */
  onBreakpoint: ((imm: number) => boolean) | null = null;

  constructor(
    readonly chip: ArmChip,
    readonly config: CortexMConfig,
  ) {
    this.excCount = 16 + config.irqCount;
    this.priority = new Uint8Array(this.excCount);
    this.pending = new Uint8Array(this.excCount);
    this.active = new Uint8Array(this.excCount);
    this.enabled = new Uint8Array(this.excCount);
    this.irqLine = new Uint8Array(this.excCount);
    this.priorityMask = (0xff << (8 - config.priorityBits)) & 0xff;
    this.refreshRegions();
  }

  /** Re-reads the chip's plain-memory regions; call after changing them. */
  refreshRegions(): void {
    this.regions = this.chip.regions.map((r) => ({ ...r, view: new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength) }));
    this.lastRegion = null;
  }

  // ---------------------------------------------------------------- reset

  /** Loads SP and PC from the vector table at `vtor`, as the reset sequence does. */
  reset(vtor = this.vtor): void {
    this.r.fill(0);
    this.n = this.z = this.c = this.v = this.q = this.ge = 0;
    this.itstate = 0;
    this.ipsr = 0;
    this.control = 0;
    this.primask = this.faultmask = this.basepri = 0;
    this.fpRegs.fill(0);
    this.fpscr = 0;
    this.sleeping = false;
    this.eventRegister = false;
    this.exclusive = false;
    this.pending.fill(0);
    this.active.fill(0);
    this.enabled.fill(0);
    this.irqLine.fill(0);
    this.priority.fill(0);
    this.vtor = vtor >>> 0;
    this.stCsr = this.stRvr = 0;
    this.stNextWrap = Infinity;
    this.cpacr = 0;
    this.fpccr = 0xc0000000;
    this.r[14] = 0xffffffff;
    this.r[13] = this.read32(this.vtor) & ~3;
    this.otherSp = 0;
    this.r[15] = this.read32(this.vtor + 4) & ~1;
    this.recheck = true;
  }

  // -------------------------------------------------------------- memory

  private region(address: number): FastRegion | null {
    const last = this.lastRegion;
    if (last && address >= last.start && address < last.end) return last;
    for (const r of this.regions) {
      if (address >= r.start && address < r.end) {
        this.lastRegion = r;
        return r;
      }
    }
    return null;
  }

  read8(address: number): number {
    address >>>= 0;
    const r = this.region(address);
    if (r) return r.bytes[address - r.start];
    return this.slowRead(address, 1) & 0xff;
  }

  read16(address: number): number {
    address >>>= 0;
    const r = this.region(address);
    if (r && address + 2 <= r.end) return r.view.getUint16(address - r.start, true);
    if (address & 1) return this.read8(address) | (this.read8(address + 1) << 8);
    return this.slowRead(address, 2) & 0xffff;
  }

  read32(address: number): number {
    address >>>= 0;
    const r = this.region(address);
    if (r && address + 4 <= r.end) return r.view.getUint32(address - r.start, true);
    if (address & 3) return (this.read16(address) | (this.read16(address + 2) << 16)) >>> 0;
    return this.slowRead(address, 4) >>> 0;
  }

  write8(address: number, value: number): void {
    address >>>= 0;
    const r = this.region(address);
    if (r) {
      if (!r.readOnly) r.bytes[address - r.start] = value;
      else this.chip.write(address, value & 0xff, 1);
      return;
    }
    this.slowWrite(address, value & 0xff, 1);
  }

  write16(address: number, value: number): void {
    address >>>= 0;
    const r = this.region(address);
    if (r && address + 2 <= r.end) {
      if (!r.readOnly) r.view.setUint16(address - r.start, value, true);
      else this.chip.write(address, value & 0xffff, 2);
      return;
    }
    if (address & 1) {
      this.write8(address, value);
      this.write8(address + 1, value >>> 8);
      return;
    }
    this.slowWrite(address, value & 0xffff, 2);
  }

  write32(address: number, value: number): void {
    address >>>= 0;
    const r = this.region(address);
    if (r && address + 4 <= r.end) {
      if (!r.readOnly) r.view.setUint32(address - r.start, value >>> 0, true);
      else this.chip.write(address, value >>> 0, 4);
      return;
    }
    if (address & 3) {
      this.write16(address, value);
      this.write16(address + 2, value >>> 16);
      return;
    }
    this.slowWrite(address, value >>> 0, 4);
  }

  private bitband(address: number): { word: number; bit: number } | null {
    if (this.config.variant === 'm7') return null;
    if (address >= 0x22000000 && address < 0x24000000) {
      const off = address - 0x22000000;
      return { word: 0x20000000 + ((off >>> 5) & ~3), bit: (off >>> 2) & 31 };
    }
    if (address >= 0x42000000 && address < 0x44000000) {
      const off = address - 0x42000000;
      return { word: 0x40000000 + ((off >>> 5) & ~3), bit: (off >>> 2) & 31 };
    }
    return null;
  }

  private slowRead(address: number, width: 1 | 2 | 4): number {
    if (address >= 0xe0000000) {
      const sys = this.readSystemSpace(address, width);
      if (sys !== undefined) return sys;
      return this.chip.readSystem?.(address, width) ?? 0;
    }
    const bb = this.bitband(address);
    if (bb) return (this.read32(bb.word) >>> bb.bit) & 1;
    return this.chip.read(address, width);
  }

  private slowWrite(address: number, value: number, width: 1 | 2 | 4): void {
    if (address >= 0xe0000000) {
      if (this.writeSystemSpace(address, value, width)) return;
      this.chip.writeSystem?.(address, value, width);
      return;
    }
    const bb = this.bitband(address);
    if (bb) {
      const word = this.read32(bb.word);
      this.write32(bb.word, value & 1 ? word | (1 << bb.bit) : word & ~(1 << bb.bit));
      return;
    }
    this.chip.write(address, value, width);
  }

  // ------------------------------------------------- system control space

  private readSystemSpace(address: number, width: 1 | 2 | 4): number | undefined {
    const word = (address & ~3) >>> 0;
    const shift = (address & 3) * 8;
    const value = this.readSystemWord(word);
    if (value === undefined) return undefined;
    const mask = width === 4 ? 0xffffffff : width === 2 ? 0xffff : 0xff;
    return (value >>> shift) & mask;
  }

  private writeSystemSpace(address: number, value: number, width: 1 | 2 | 4): boolean {
    // Byte-addressed priority registers.
    if (address >= 0xe000e400 && address < 0xe000e400 + this.config.irqCount) {
      for (let i = 0; i < width; i++) this.setPriority(16 + (address - 0xe000e400) + i, (value >>> (8 * i)) & 0xff);
      return true;
    }
    if (address >= 0xe000ed18 && address < 0xe000ed24) {
      for (let i = 0; i < width; i++) {
        const exc = 4 + (address - 0xe000ed18) + i;
        if (exc >= 4 && exc <= 15) this.setPriority(exc, (value >>> (8 * i)) & 0xff);
      }
      return true;
    }
    const word = (address & ~3) >>> 0;
    if (width !== 4) {
      // A narrower write to a word register merges into what is there.
      const old = this.readSystemWord(word);
      if (old === undefined) return false;
      const shift = (address & 3) * 8;
      const mask = (width === 2 ? 0xffff : 0xff) << shift;
      return this.writeSystemWord(word, ((old & ~mask) | ((value << shift) & mask)) >>> 0);
    }
    return this.writeSystemWord(word, value >>> 0);
  }

  private readSystemWord(a: number): number | undefined {
    if (a >= 0xe000e100 && a < 0xe000e140) return this.bitsOf(this.enabled, (a - 0xe000e100) * 8);
    if (a >= 0xe000e180 && a < 0xe000e1c0) return this.bitsOf(this.enabled, (a - 0xe000e180) * 8);
    if (a >= 0xe000e200 && a < 0xe000e240) return this.bitsOf(this.pending, (a - 0xe000e200) * 8);
    if (a >= 0xe000e280 && a < 0xe000e2c0) return this.bitsOf(this.pending, (a - 0xe000e280) * 8);
    if (a >= 0xe000e300 && a < 0xe000e340) return this.bitsOf(this.active, (a - 0xe000e300) * 8);
    if (a >= 0xe000e400 && a < 0xe000e5f0) {
      let v = 0;
      for (let i = 0; i < 4; i++) v |= (this.priority[16 + a - 0xe000e400 + i] ?? 0) << (8 * i);
      return v >>> 0;
    }
    if (a >= 0xe000ed18 && a < 0xe000ed24) {
      let v = 0;
      for (let i = 0; i < 4; i++) {
        const exc = 4 + a - 0xe000ed18 + i;
        v |= (exc <= 15 ? this.priority[exc] : 0) << (8 * i);
      }
      return v >>> 0;
    }
    if (a >= 0xe000ed90 && a < 0xe000edd0) return this.mpuRegs[(a - 0xe000ed90) >> 2];
    switch (a) {
      case 0xe000e004:
        return Math.max(0, Math.ceil(this.config.irqCount / 32) - 1);
      case 0xe000e008:
        return this.actlr;
      case 0xe000e010: {
        const v = this.stCsr;
        // COUNTFLAG clears on read.
        this.updateSystick();
        const flag = this.stCsr & 0x10000;
        this.stCsr &= ~0x10000;
        return (v & ~0x10000) | flag;
      }
      case 0xe000e014:
        return this.stRvr;
      case 0xe000e018:
        return this.systickValue();
      case 0xe000e01c:
        return 0x40000000; // no reference clock calibration value
      case 0xe000ed00:
        return this.config.cpuid;
      case 0xe000ed04:
        return this.icsr();
      case 0xe000ed08:
        return this.vtor;
      case 0xe000ed0c:
        return (0xfa050000 | (this.aircrPrigroup << 8)) >>> 0;
      case 0xe000ed10:
        return this.scr;
      case 0xe000ed14:
        return this.ccr;
      case 0xe000ed24:
        return this.shcsr;
      case 0xe000ed28:
        return this.cfsr;
      case 0xe000ed2c:
        return this.hfsr;
      case 0xe000ed30:
      case 0xe000ed34:
      case 0xe000ed38:
      case 0xe000ed3c:
        return 0;
      case 0xe000ed78: // CLIDR (M7)
        return this.config.variant === 'm7' ? 0x09000003 : 0;
      case 0xe000ed7c: // CTR
        return this.config.variant === 'm7' ? 0x8303c003 : 0;
      case 0xe000ed80: // CCSIDR
        return this.config.variant === 'm7' ? 0xf01fe019 : 0;
      case 0xe000ed84:
        return 0;
      case 0xe000ed88:
        return this.cpacr;
      case 0xe000edfc:
        return this.demcr;
      case 0xe000ef34:
        return this.fpccr;
      case 0xe000ef38:
        return this.fpcar;
      case 0xe000ef3c:
        return this.fpdscr;
      case 0xe000ef40: // MVFR0
        return this.config.fpu === 'dp' ? 0x10110221 : this.config.fpu === 'sp' ? 0x10110021 : 0;
      case 0xe000ef44: // MVFR1
        return this.config.fpu ? 0x11000011 : 0;
      case 0xe000ef48: // MVFR2
        return this.config.fpu === 'dp' ? 0x00000040 : 0;
      case 0xe0001000:
        return this.dwtCtrl;
      case 0xe0001004:
        return this.dwtCycles();
      case 0xe0001fb4: // DWT LSR: unlocked
        return 0;
      default:
        if (a >= 0xe0001000 && a < 0xe0002000) return 0;
        if (a >= 0xe0000000 && a < 0xe0001000) return 1; // ITM: stimulus ports always ready
        if (a >= 0xe000ef50 && a < 0xe000ef80) return 0;
        if (a >= 0xe000e000 && a < 0xe000f000) return 0;
        if (a >= 0xe0002000 && a < 0xe0040000) return 0; // FPB, TPIU and the like
        return undefined;
    }
  }

  private writeSystemWord(a: number, v: number): boolean {
    if (a >= 0xe000e100 && a < 0xe000e140) return this.setBits(this.enabled, (a - 0xe000e100) * 8, v, true);
    if (a >= 0xe000e180 && a < 0xe000e1c0) return this.setBits(this.enabled, (a - 0xe000e180) * 8, v, false);
    if (a >= 0xe000e200 && a < 0xe000e240) return this.setBits(this.pending, (a - 0xe000e200) * 8, v, true);
    if (a >= 0xe000e280 && a < 0xe000e2c0) return this.setBits(this.pending, (a - 0xe000e280) * 8, v, false);
    if (a >= 0xe000e300 && a < 0xe000e340) return true;
    if (a >= 0xe000e400 && a < 0xe000e5f0) {
      for (let i = 0; i < 4; i++) this.setPriority(16 + a - 0xe000e400 + i, (v >>> (8 * i)) & 0xff);
      return true;
    }
    if (a >= 0xe000ed90 && a < 0xe000edd0) {
      this.mpuRegs[(a - 0xe000ed90) >> 2] = v;
      return true;
    }
    switch (a) {
      case 0xe000e008:
        this.actlr = v;
        return true;
      case 0xe000e010:
        this.updateSystick();
        this.stCsr = (this.stCsr & 0x10000) | (v & 0x7);
        this.scheduleSystick(this.systickValue());
        return true;
      case 0xe000e014:
        this.stRvr = v & 0xffffff;
        return true;
      case 0xe000e018:
        // Any write clears the counter and COUNTFLAG; it reloads on the next tick.
        this.stCsr &= ~0x10000;
        this.scheduleSystick(0);
        return true;
      case 0xe000ed04:
        this.writeIcsr(v);
        return true;
      case 0xe000ed08:
        this.vtor = (v & 0xffffff80) >>> 0;
        return true;
      case 0xe000ed0c:
        if (v >>> 16 !== 0x05fa) return true;
        this.aircrPrigroup = (v >>> 8) & 7;
        if (v & 0x4) this.onSystemReset?.();
        this.recheck = true;
        return true;
      case 0xe000ed10:
        this.scr = v & 0x16;
        return true;
      case 0xe000ed14:
        this.ccr = v;
        return true;
      case 0xe000ed24:
        this.shcsr = v;
        return true;
      case 0xe000ed28:
        this.cfsr &= ~v;
        return true;
      case 0xe000ed2c:
        this.hfsr &= ~v;
        return true;
      case 0xe000ed88:
        this.cpacr = v;
        return true;
      case 0xe000edfc:
        this.demcr = v;
        return true;
      case 0xe000ef00: // STIR
        this.setPendingException(16 + (v & 0x1ff));
        return true;
      case 0xe000ef34:
        this.fpccr = (this.fpccr & 0x3ff) | (v & 0xc0000000) | (v & 0x1ff);
        return true;
      case 0xe000ef38:
        this.fpcar = v & ~7;
        return true;
      case 0xe000ef3c:
        this.fpdscr = v & 0x07c00000;
        return true;
      case 0xe0001000:
        this.dwtCycBase = this.dwtCycles();
        this.dwtCycAt = this.cycles;
        this.dwtCtrl = (this.dwtCtrl & 0xfffffffe) | (v & 1);
        return true;
      case 0xe0001004:
        this.dwtCycBase = v;
        this.dwtCycAt = this.cycles;
        return true;
      default:
        if (a >= 0xe0000000 && a < 0xe0040000) return true; // ITM, DWT, FPB, cache maintenance, ...: accepted
        return false;
    }
  }

  /** Called when firmware requests a system reset through AIRCR.SYSRESETREQ. */
  onSystemReset: (() => void) | null = null;

  private dwtCycles(): number {
    if (!(this.dwtCtrl & 1)) return this.dwtCycBase >>> 0;
    return (this.dwtCycBase + (this.cycles - this.dwtCycAt)) >>> 0;
  }

  private bitsOf(arr: Uint8Array, first: number): number {
    let v = 0;
    for (let i = 0; i < 32; i++) if (arr[16 + first + i]) v |= 1 << i;
    return v >>> 0;
  }

  private setBits(arr: Uint8Array, first: number, v: number, set: boolean): boolean {
    for (let i = 0; i < 32; i++) {
      if (!(v & (1 << i))) continue;
      const exc = 16 + first + i;
      if (exc >= this.excCount) continue;
      arr[exc] = set ? 1 : 0;
    }
    this.recheck = true;
    if (set && arr === this.pending) this.wake();
    return true;
  }

  private setPriority(exc: number, value: number): void {
    if (exc >= this.excCount) return;
    this.priority[exc] = value & this.priorityMask;
    this.recheck = true;
  }

  private icsr(): number {
    let v = this.ipsr & 0x1ff;
    let pendingNum = 0;
    let best = Infinity;
    for (let e = 2; e < this.excCount; e++) {
      if (this.pending[e] && (e < 16 || this.enabled[e])) {
        const p = this.excPriority(e);
        if (p < best) {
          best = p;
          pendingNum = e;
        }
      }
    }
    v |= pendingNum << 12;
    if (pendingNum >= 16) v |= 1 << 22;
    if (this.pending[EXC.PENDSV]) v |= 1 << 28;
    if (this.pending[EXC.SYSTICK]) v |= 1 << 26;
    if (this.pending[EXC.NMI]) v |= 1 << 31;
    let activeCount = 0;
    for (let e = 1; e < this.excCount; e++) if (this.active[e]) activeCount++;
    if (activeCount <= 1) v |= 1 << 11; // RETTOBASE
    return v >>> 0;
  }

  private writeIcsr(v: number): void {
    if (v & (1 << 31)) this.setPendingException(EXC.NMI);
    if (v & (1 << 28)) this.setPendingException(EXC.PENDSV);
    if (v & (1 << 27)) this.pending[EXC.PENDSV] = 0;
    if (v & (1 << 26)) this.setPendingException(EXC.SYSTICK);
    if (v & (1 << 25)) this.pending[EXC.SYSTICK] = 0;
    this.recheck = true;
  }

  // ------------------------------------------------------------- SysTick

  private systickTickCycles(): number {
    return this.stCsr & 4 ? 1 : this.systickExternalDivisor;
  }

  private systickValue(): number {
    if (!(this.stCsr & 1) || this.stNextWrap === Infinity) return this.stLoadValue;
    // Between reaching zero and the reload on the next tick, it reads zero.
    if (this.cycles < this.stLoadCycle) return 0;
    const elapsed = Math.floor((this.cycles - this.stLoadCycle) / this.systickTickCycles());
    return Math.max(0, this.stLoadValue - elapsed);
  }

  /** Starts counting down from `value` now. */
  private scheduleSystick(value: number): void {
    this.stLoadCycle = this.cycles;
    this.stLoadValue = value;
    if (!(this.stCsr & 1)) {
      this.stNextWrap = Infinity;
      return;
    }
    // From `value`, it reaches zero after `value` ticks. At zero already, it
    // reloads on the next tick (updateSystick), with no COUNTFLAG for this zero.
    this.stNextWrap = this.cycles + value * this.systickTickCycles();
  }

  private updateSystick(): void {
    while (this.cycles >= this.stNextWrap) {
      const at = this.stNextWrap;
      if (this.stLoadValue !== 0) {
        // Reached zero: COUNTFLAG, and the interrupt if enabled.
        this.stCsr |= 0x10000;
        if (this.stCsr & 2) this.setPendingException(EXC.SYSTICK);
      }
      // The counter sits at zero for one tick and reloads on the next, so a
      // period is RVR+1 ticks (ARMv7-M ARM B3.3: "RELOAD ... N-1 for a
      // period of N"). A reload value of zero stops the counter at zero.
      const tick = this.systickTickCycles();
      this.stLoadCycle = at + tick;
      this.stLoadValue = this.stRvr;
      if (this.stRvr === 0) {
        this.stNextWrap = Infinity;
        this.stLoadValue = 0;
        break;
      }
      this.stNextWrap = at + (this.stRvr + 1) * tick;
    }
  }

  /** Cycles until the next thing the core itself has scheduled (SysTick), for sleeping. */
  cyclesToNextEvent(): number {
    return this.stNextWrap === Infinity ? Infinity : Math.max(1, this.stNextWrap - this.cycles);
  }

  // ---------------------------------------------------------- exceptions

  /** Pends an external interrupt line. */
  setIrq(irq: number, pending: boolean): void {
    const exc = 16 + irq;
    if (exc >= this.excCount) return;
    if (pending) {
      if (!this.pending[exc]) {
        this.pending[exc] = 1;
        this.recheck = true;
      }
      if (this.enabled[exc]) this.wake();
    }
  }

  /**
   * Drives an interrupt line as a level, which is what every peripheral here
   * does: asserted while its enabled status flags are set. A rising level
   * pends the interrupt, and a level still high when its handler returns pends
   * it again — the NVIC's behaviour for level-sensitive sources.
   */
  setIrqLevel(irq: number, high: boolean): void {
    const exc = 16 + irq;
    if (exc >= this.excCount) return;
    const was = this.irqLine[exc];
    this.irqLine[exc] = high ? 1 : 0;
    if (high && !was) this.setIrq(irq, true);
  }

  /** Whether an IRQ is pending in the NVIC (for level-sensitive sources that re-pend). */
  irqPending(irq: number): boolean {
    return this.pending[16 + irq] === 1;
  }

  irqEnabled(irq: number): boolean {
    return this.enabled[16 + irq] === 1;
  }

  setPendingException(exc: number): void {
    if (exc >= this.excCount) return;
    this.pending[exc] = 1;
    this.recheck = true;
    this.wake();
  }

  private wake(): void {
    if (this.sleeping) this.sleeping = false;
  }

  private excPriority(exc: number): number {
    if (exc === 1) return -3;
    if (exc === EXC.NMI) return -2;
    if (exc === EXC.HARDFAULT) return -1;
    return this.priority[exc];
  }

  private groupPriority(p: number): number {
    if (p < 0) return p;
    const subBits = this.aircrPrigroup + 1;
    return (p >> subBits) << subBits;
  }

  /** The priority the processor is executing at: active handlers and the masks. */
  private executionPriority(): number {
    let prio = 256;
    for (let e = 2; e < this.excCount; e++) {
      if (this.active[e]) prio = Math.min(prio, this.groupPriority(this.excPriority(e)));
    }
    if (this.basepri) prio = Math.min(prio, this.groupPriority(this.basepri));
    if (this.primask) prio = Math.min(prio, 0);
    if (this.faultmask) prio = Math.min(prio, -1);
    return prio;
  }

  /** The pending exception that would preempt now, or 0. */
  private takeable(): number {
    let best = 0;
    let bestPrio = Infinity;
    for (let e = 2; e < this.excCount; e++) {
      if (!this.pending[e]) continue;
      if (e >= 16 && !this.enabled[e]) continue;
      if (e === EXC.MEMMANAGE || e === EXC.BUSFAULT || e === EXC.USAGEFAULT) {
        if (!(this.shcsr & (1 << (16 + e - EXC.MEMMANAGE)))) continue;
      }
      const p = this.excPriority(e);
      if (p < bestPrio) {
        bestPrio = p;
        best = e;
      }
    }
    if (!best) return 0;
    return this.groupPriority(bestPrio) < this.executionPriority() ? best : 0;
  }

  /** Whether any interrupt is pending that would wake WFI (even if masked by PRIMASK). */
  private wakeable(): boolean {
    for (let e = 2; e < this.excCount; e++) {
      if (this.pending[e] && (e < 16 || this.enabled[e])) return true;
    }
    return false;
  }

  private get fpActive(): boolean {
    return (this.control & 4) !== 0;
  }

  private enterException(exc: number, returnAddress: number): void {
    const extended = this.config.fpu !== undefined && this.fpActive && (this.fpccr & 0x80000000) !== 0;
    const frameSize = extended ? 0x68 : 0x20;
    const sp = this.r[13];
    const align = (this.ccr & 0x200) !== 0 && (sp & 4) !== 0;
    const frame = ((sp - frameSize) & ~(this.ccr & 0x200 ? 7 : 3)) >>> 0;
    const xpsr = this.xpsr() & ~(1 << 9);
    this.write32(frame, this.r[0]);
    this.write32(frame + 4, this.r[1]);
    this.write32(frame + 8, this.r[2]);
    this.write32(frame + 12, this.r[3]);
    this.write32(frame + 16, this.r[12]);
    this.write32(frame + 20, this.r[14]);
    this.write32(frame + 24, returnAddress);
    this.write32(frame + 28, xpsr | (align ? 1 << 9 : 0));
    if (extended) {
      for (let i = 0; i < 16; i++) this.write32(frame + 0x20 + i * 4, this.fpRegs[i]);
      this.write32(frame + 0x60, this.fpscr);
    }
    this.r[13] = frame;
    const handlerMode = this.ipsr !== 0;
    let excReturn: number;
    if (handlerMode) excReturn = 0xfffffff1;
    else if (this.control & 2) excReturn = 0xfffffffd;
    else excReturn = 0xfffffff9;
    if (extended) excReturn &= ~0x10;
    this.r[14] = excReturn >>> 0;

    // Handler mode always runs on MSP.
    if (!handlerMode && this.control & 2) {
      const psp = this.r[13];
      this.r[13] = this.otherSp;
      this.otherSp = psp;
    }
    this.control &= ~2;
    if (extended) this.control &= ~4;
    this.ipsr = exc;
    this.pending[exc] = 0;
    this.active[exc] = 1;
    this.itstate = 0;
    this.r[15] = this.read32(this.vtor + exc * 4) & ~1;
    this.recheck = true;
    this.exclusive = false;
  }

  private exceptionReturn(excReturn: number): void {
    const exc = this.ipsr;
    this.active[exc] = 0;
    if (exc >= 16 && this.irqLine[exc]) this.pending[exc] = 1;
    // Let a handler that re-pends its own source (level interrupts) be seen.
    const toThread = (excReturn & 8) !== 0;
    const usePsp = (excReturn & 4) !== 0;
    const extended = (excReturn & 0x10) === 0;
    // Switch to the stack the frame is on.
    let sp: number;
    if (toThread && usePsp) {
      // Currently on MSP (handler mode); PSP is the banked one.
      sp = this.otherSp;
      this.otherSp = this.r[13];
    } else {
      sp = this.r[13];
    }
    const frame = sp >>> 0;
    this.r[0] = this.read32(frame);
    this.r[1] = this.read32(frame + 4);
    this.r[2] = this.read32(frame + 8);
    this.r[3] = this.read32(frame + 12);
    this.r[12] = this.read32(frame + 16);
    this.r[14] = this.read32(frame + 20);
    const pc = this.read32(frame + 24);
    const xpsr = this.read32(frame + 28);
    let frameSize = 0x20;
    if (extended) {
      for (let i = 0; i < 16; i++) this.fpRegs[i] = this.read32(frame + 0x20 + i * 4);
      this.fpscr = this.read32(frame + 0x60);
      frameSize = 0x68;
    }
    const newSp = (frame + frameSize + (xpsr & (1 << 9) ? 4 : 0)) >>> 0;
    this.r[13] = newSp;
    if (toThread) {
      this.control = usePsp ? this.control | 2 : this.control & ~2;
    }
    this.control = extended ? this.control | 4 : this.control & ~4;
    this.setXpsr(xpsr);
    this.ipsr = toThread ? 0 : xpsr & 0x1ff;
    this.r[15] = pc & ~1;
    this.recheck = true;
    this.exclusive = false;
    if (toThread && this.scr & 2) this.sleeping = true; // SLEEPONEXIT
  }

  // ----------------------------------------------------------------- PSR

  xpsr(): number {
    return (
      ((this.n << 31) |
        (this.z << 30) |
        (this.c << 29) |
        (this.v << 28) |
        (this.q << 27) |
        ((this.itstate & 3) << 25) |
        (1 << 24) |
        ((this.ge & 0xf) << 16) |
        (((this.itstate >> 2) & 0x3f) << 10) |
        (this.ipsr & 0x1ff)) >>>
      0
    );
  }

  private setXpsr(v: number): void {
    this.n = (v >>> 31) & 1;
    this.z = (v >>> 30) & 1;
    this.c = (v >>> 29) & 1;
    this.v = (v >>> 28) & 1;
    this.q = (v >>> 27) & 1;
    this.ge = (v >>> 16) & 0xf;
    this.itstate = ((v >>> 25) & 3) | (((v >>> 10) & 0x3f) << 2);
  }

  private apsrWrite(v: number, mask: number): void {
    if (mask & 2) {
      this.n = (v >>> 31) & 1;
      this.z = (v >>> 30) & 1;
      this.c = (v >>> 29) & 1;
      this.v = (v >>> 28) & 1;
      this.q = (v >>> 27) & 1;
    }
    if (mask & 1) this.ge = (v >>> 16) & 0xf;
  }

  // ----------------------------------------------------------- execution

  /** Executes one instruction (or takes one exception). Returns the cycles it took. */
  step(): number {
    if (this.recheck) {
      this.recheck = false;
      this.updateSystick();
      const exc = this.takeable();
      if (exc) {
        this.sleeping = false;
        this.enterException(exc, this.r[15]);
        this.cycles += 12;
        return 12;
      }
    }
    if (this.cycles >= this.stNextWrap) {
      this.updateSystick();
      if (this.recheck) return this.step();
    }
    if (this.sleeping) return 0;

    const pc = this.r[15];
    this.pc = pc;
    this.pcOperand = (pc + 4) >>> 0;
    const hw1 = this.read16(pc);
    let cycles: number;
    const it = this.itstate & 0xf;
    this.itAdvance = it !== 0;
    if ((hw1 & 0xe000) === 0xe000 && (hw1 & 0x1800) !== 0) {
      const hw2 = this.read16(pc + 2);
      this.r[15] = (pc + 4) >>> 0;
      if (it && !this.cond(this.itstate >> 4)) cycles = 1;
      else cycles = this.exec32(hw1, hw2);
    } else {
      this.r[15] = (pc + 2) >>> 0;
      if (it && !this.cond(this.itstate >> 4) && (hw1 & 0xff00) !== 0xbe00) cycles = 1;
      else cycles = this.exec16(hw1);
    }
    if (this.itAdvance) {
      if ((this.itstate & 7) === 0) this.itstate = 0;
      else this.itstate = (this.itstate & 0xe0) | ((this.itstate << 1) & 0x1f);
    }
    this.cycles += cycles;
    return cycles;
  }

  /** Called by the chip when something it models asserts an interrupt. Equivalent to setIrq. */
  wakeForEvent(): void {
    this.eventRegister = true;
    this.wake();
  }

  /** Runs until `cycles` more have elapsed or the core sleeps with nothing scheduled. */
  run(cycles: number): number {
    const target = this.cycles + cycles;
    while (this.cycles < target) {
      if (this.sleeping) {
        // Nothing to do until SysTick or the chip wakes it: jump the clock.
        const next = Math.min(target, this.stNextWrap);
        this.cycles = next;
        this.updateSystick();
        if (this.recheck && this.wakeable()) this.sleeping = false;
        if (this.sleeping) break;
        continue;
      }
      this.step();
    }
    return this.cycles;
  }

  private cond(c: number): boolean {
    let r: boolean;
    switch (c >> 1) {
      case 0:
        r = this.z === 1;
        break;
      case 1:
        r = this.c === 1;
        break;
      case 2:
        r = this.n === 1;
        break;
      case 3:
        r = this.v === 1;
        break;
      case 4:
        r = this.c === 1 && this.z === 0;
        break;
      case 5:
        r = this.n === this.v;
        break;
      case 6:
        r = this.n === this.v && this.z === 0;
        break;
      default:
        return true;
    }
    return c & 1 ? !r : r;
  }

  private get inIT(): boolean {
    return (this.itstate & 0xf) !== 0;
  }

  /** Register read, with PC reading as the current instruction + 4. */
  private reg(n: number): number {
    return n === 15 ? this.pcOperand : this.r[n];
  }

  private branchTo(address: number): void {
    this.r[15] = (address & ~1) >>> 0;
  }

  /** BX, BLX, POP {PC}, LDR PC: interworking, and exception return from a handler. */
  private bxWritePc(address: number): void {
    address >>>= 0;
    if (this.ipsr !== 0 && address >= 0xf0000000) {
      this.exceptionReturn(address);
      return;
    }
    if (!(address & 1)) throw new ArmFault('Branch to an ARM-state address: the Cortex-M only runs Thumb code', this.pc);
    this.r[15] = (address & ~1) >>> 0;
  }

  private undefined16(op: number): never {
    throw new ArmFault(`Undefined or unimplemented instruction 0x${op.toString(16).padStart(4, '0')}`, this.pc);
  }

  private undefined32(hw1: number, hw2: number): never {
    throw new ArmFault(
      `Undefined or unimplemented instruction 0x${hw1.toString(16).padStart(4, '0')} 0x${hw2.toString(16).padStart(4, '0')}`,
      this.pc,
    );
  }

  // ------------------------------------------------------- ALU helpers

  private setNZ(v: number): void {
    this.n = (v >>> 31) & 1;
    this.z = (v >>> 0) === 0 ? 1 : 0;
  }

  /** x + y + carry, setting C and V when `flags`. */
  private addWithCarry(x: number, y: number, carry: number, flags: boolean): number {
    const ux = x >>> 0;
    const uy = y >>> 0;
    const unsigned = ux + uy + carry;
    const result = unsigned >>> 0;
    if (flags) {
      this.setNZ(result);
      this.c = unsigned > 0xffffffff ? 1 : 0;
      const sx = x | 0;
      const sy = y | 0;
      const signed = sx + sy + carry;
      this.v = signed !== (result | 0) ? 1 : 0;
    }
    return result;
  }

  /** Shift_C: (result, carry) for the four shift types plus RRX (type 3, amount 0). */
  private shiftC(value: number, type: number, amount: number, carryIn: number): [number, number] {
    value >>>= 0;
    if (amount === 0 && type !== 4) return [value, carryIn];
    switch (type) {
      case 0: // LSL
        if (amount >= 32) return [0, amount === 32 ? value & 1 : 0];
        return [(value << amount) >>> 0, (value >>> (32 - amount)) & 1];
      case 1: // LSR
        if (amount >= 32) return [0, amount === 32 ? value >>> 31 : 0];
        return [value >>> amount, (value >>> (amount - 1)) & 1];
      case 2: // ASR
        if (amount >= 32) {
          const s = value >>> 31;
          return [s ? 0xffffffff : 0, s];
        }
        return [(value >> amount) >>> 0, ((value | 0) >> (amount - 1)) & 1];
      case 3: {
        // ROR
        const a = amount & 31;
        const result = a === 0 ? value : ((value >>> a) | (value << (32 - a))) >>> 0;
        return [result, result >>> 31];
      }
      default: // RRX
        return [((carryIn << 31) | (value >>> 1)) >>> 0, value & 1];
    }
  }

  /** DecodeImmShift: (type, amount) with the encoding's special cases. */
  private decodeShift(type: number, imm5: number): [number, number] {
    switch (type) {
      case 0:
        return [0, imm5];
      case 1:
        return [1, imm5 === 0 ? 32 : imm5];
      case 2:
        return [2, imm5 === 0 ? 32 : imm5];
      default:
        return imm5 === 0 ? [4, 1] : [3, imm5];
    }
  }

  /** ThumbExpandImm_C. */
  private expandImm(imm12: number): [number, number] {
    if ((imm12 >> 10) === 0) {
      const b = imm12 & 0xff;
      switch ((imm12 >> 8) & 3) {
        case 0:
          return [b, this.c];
        case 1:
          return [((b << 16) | b) >>> 0, this.c];
        case 2:
          return [((b << 24) | (b << 8)) >>> 0, this.c];
        default:
          return [((b << 24) | (b << 16) | (b << 8) | b) >>> 0, this.c];
      }
    }
    const unrotated = 0x80 | (imm12 & 0x7f);
    const rot = (imm12 >> 7) & 0x1f;
    const result = ((unrotated >>> rot) | (unrotated << (32 - rot))) >>> 0;
    return [result, result >>> 31];
  }

  // ---------------------------------------------------- 16-bit Thumb

  private exec16(op: number): number {
    const flags = !this.inIT;
    switch (op >> 12) {
      case 0x0:
      case 0x1: {
        const opc = (op >> 11) & 3;
        if (opc !== 3) {
          // LSL/LSR/ASR (immediate)
          const rd = op & 7;
          const rm = (op >> 3) & 7;
          const imm5 = (op >> 6) & 0x1f;
          const [type, amount] = this.decodeShift(opc, imm5);
          const [res, carry] = this.shiftC(this.r[rm], type, amount, this.c);
          this.r[rd] = res;
          if (flags) {
            this.setNZ(res);
            this.c = carry;
          }
          return 1;
        }
        const rd = op & 7;
        const rn = (op >> 3) & 7;
        const value = (op >> 6) & 7;
        const operand = op & 0x400 ? value : this.r[value];
        if (op & 0x200) this.r[rd] = this.addWithCarry(this.r[rn], ~operand >>> 0, 1, flags);
        else this.r[rd] = this.addWithCarry(this.r[rn], operand, 0, flags);
        return 1;
      }
      case 0x2:
      case 0x3: {
        const rdn = (op >> 8) & 7;
        const imm8 = op & 0xff;
        switch ((op >> 11) & 3) {
          case 0:
            this.r[rdn] = imm8;
            if (flags) this.setNZ(imm8);
            break;
          case 1:
            this.addWithCarry(this.r[rdn], ~imm8 >>> 0, 1, true);
            break;
          case 2:
            this.r[rdn] = this.addWithCarry(this.r[rdn], imm8, 0, flags);
            break;
          default:
            this.r[rdn] = this.addWithCarry(this.r[rdn], ~imm8 >>> 0, 1, flags);
        }
        return 1;
      }
      case 0x4: {
        if ((op & 0xfc00) === 0x4000) return this.dataProcessing16(op, flags);
        if ((op & 0xfc00) === 0x4400) return this.specialData16(op);
        // LDR (literal)
        const rt = (op >> 8) & 7;
        const address = ((this.pcOperand & ~3) + (op & 0xff) * 4) >>> 0;
        this.r[rt] = this.read32(address);
        return 2;
      }
      case 0x5: {
        const rt = op & 7;
        const rn = (op >> 3) & 7;
        const rm = (op >> 6) & 7;
        const address = (this.r[rn] + this.r[rm]) >>> 0;
        switch ((op >> 9) & 7) {
          case 0:
            this.write32(address, this.r[rt]);
            break;
          case 1:
            this.write16(address, this.r[rt]);
            break;
          case 2:
            this.write8(address, this.r[rt]);
            break;
          case 3:
            this.r[rt] = sx8(this.read8(address)) >>> 0;
            break;
          case 4:
            this.r[rt] = this.read32(address);
            break;
          case 5:
            this.r[rt] = this.read16(address);
            break;
          case 6:
            this.r[rt] = this.read8(address);
            break;
          default:
            this.r[rt] = sx16(this.read16(address)) >>> 0;
        }
        return 2;
      }
      case 0x6: {
        const rt = op & 7;
        const rn = (op >> 3) & 7;
        const address = (this.r[rn] + ((op >> 6) & 0x1f) * 4) >>> 0;
        if (op & 0x800) this.r[rt] = this.read32(address);
        else this.write32(address, this.r[rt]);
        return 2;
      }
      case 0x7: {
        const rt = op & 7;
        const rn = (op >> 3) & 7;
        const address = (this.r[rn] + ((op >> 6) & 0x1f)) >>> 0;
        if (op & 0x800) this.r[rt] = this.read8(address);
        else this.write8(address, this.r[rt]);
        return 2;
      }
      case 0x8: {
        const rt = op & 7;
        const rn = (op >> 3) & 7;
        const address = (this.r[rn] + ((op >> 6) & 0x1f) * 2) >>> 0;
        if (op & 0x800) this.r[rt] = this.read16(address);
        else this.write16(address, this.r[rt]);
        return 2;
      }
      case 0x9: {
        const rt = (op >> 8) & 7;
        const address = (this.r[13] + (op & 0xff) * 4) >>> 0;
        if (op & 0x800) this.r[rt] = this.read32(address);
        else this.write32(address, this.r[rt]);
        return 2;
      }
      case 0xa: {
        const rd = (op >> 8) & 7;
        const imm = (op & 0xff) * 4;
        this.r[rd] = op & 0x800 ? (this.r[13] + imm) >>> 0 : ((this.pcOperand & ~3) + imm) >>> 0;
        return 1;
      }
      case 0xb:
        return this.misc16(op);
      case 0xc: {
        const rn = (op >> 8) & 7;
        const list = op & 0xff;
        let address = this.r[rn];
        let count = 0;
        if (op & 0x800) {
          for (let i = 0; i < 8; i++) {
            if (list & (1 << i)) {
              this.r[i] = this.read32(address);
              address += 4;
              count++;
            }
          }
          if (!(list & (1 << rn))) this.r[rn] = address >>> 0;
        } else {
          for (let i = 0; i < 8; i++) {
            if (list & (1 << i)) {
              this.write32(address, this.r[i]);
              address += 4;
              count++;
            }
          }
          this.r[rn] = address >>> 0;
        }
        return 1 + count;
      }
      case 0xd: {
        const c = (op >> 8) & 0xf;
        if (c === 0xe) this.undefined16(op);
        if (c === 0xf) {
          this.setPendingException(EXC.SVCALL);
          // SVC is taken synchronously, before the next instruction.
          const exc = EXC.SVCALL;
          this.enterException(exc, this.r[15]);
          return 3;
        }
        if (!this.cond(c)) return 1;
        this.branchTo(this.pcOperand + (sx8(op & 0xff) << 1));
        return 2;
      }
      case 0xe: {
        if (op & 0x800) this.undefined16(op);
        const imm11 = op & 0x7ff;
        this.branchTo(this.pcOperand + (((imm11 << 21) >> 21) << 1));
        return 2;
      }
      default:
        this.undefined16(op);
    }
  }

  private dataProcessing16(op: number, flags: boolean): number {
    const rdn = op & 7;
    const rm = (op >> 3) & 7;
    const a = this.r[rdn];
    const b = this.r[rm];
    switch ((op >> 6) & 0xf) {
      case 0x0: // AND
        this.r[rdn] = a & b;
        if (flags) this.setNZ(this.r[rdn]);
        return 1;
      case 0x1: // EOR
        this.r[rdn] = a ^ b;
        if (flags) this.setNZ(this.r[rdn]);
        return 1;
      case 0x2:
      case 0x3:
      case 0x4:
      case 0x7: {
        const type = { 2: 0, 3: 1, 4: 2, 7: 3 }[(op >> 6) & 0xf]!;
        const [res, carry] = this.shiftC(a, type, b & 0xff, this.c);
        this.r[rdn] = res;
        if (flags) {
          this.setNZ(res);
          this.c = carry;
        }
        return 1;
      }
      case 0x5: // ADC
        this.r[rdn] = this.addWithCarry(a, b, this.c, flags);
        return 1;
      case 0x6: // SBC
        this.r[rdn] = this.addWithCarry(a, ~b >>> 0, this.c, flags);
        return 1;
      case 0x8: // TST
        this.setNZ(a & b);
        return 1;
      case 0x9: // RSB #0
        this.r[rdn] = this.addWithCarry(~b >>> 0, 0, 1, flags);
        return 1;
      case 0xa: // CMP
        this.addWithCarry(a, ~b >>> 0, 1, true);
        return 1;
      case 0xb: // CMN
        this.addWithCarry(a, b, 0, true);
        return 1;
      case 0xc: // ORR
        this.r[rdn] = a | b;
        if (flags) this.setNZ(this.r[rdn]);
        return 1;
      case 0xd: // MUL
        this.r[rdn] = Math.imul(a, b) >>> 0;
        if (flags) this.setNZ(this.r[rdn]);
        return 1;
      case 0xe: // BIC
        this.r[rdn] = a & ~b;
        if (flags) this.setNZ(this.r[rdn]);
        return 1;
      default: // MVN
        this.r[rdn] = ~b >>> 0;
        if (flags) this.setNZ(this.r[rdn]);
        return 1;
    }
  }

  private specialData16(op: number): number {
    const rm = (op >> 3) & 0xf;
    const rdn = (op & 7) | ((op >> 4) & 8);
    switch ((op >> 8) & 3) {
      case 0: {
        const result = (this.reg(rdn) + this.reg(rm)) >>> 0;
        if (rdn === 15) {
          this.branchTo(result);
          return 3;
        }
        this.r[rdn] = result;
        return 1;
      }
      case 1:
        this.addWithCarry(this.reg(rdn), ~this.reg(rm) >>> 0, 1, true);
        return 1;
      case 2: {
        const value = this.reg(rm);
        if (rdn === 15) {
          this.branchTo(value);
          return 3;
        }
        this.r[rdn] = value;
        return 1;
      }
      default: {
        const target = this.reg(rm);
        if (op & 0x80) this.r[14] = ((this.r[15]) | 1) >>> 0; // BLX: return address is the next instruction
        this.bxWritePc(target);
        return 3;
      }
    }
  }

  private misc16(op: number): number {
    switch ((op >> 8) & 0xf) {
      case 0x0: {
        const imm = (op & 0x7f) * 4;
        this.r[13] = op & 0x80 ? (this.r[13] - imm) >>> 0 : (this.r[13] + imm) >>> 0;
        return 1;
      }
      case 0x1:
      case 0x3:
      case 0x9:
      case 0xb: {
        // CBZ / CBNZ
        const rn = op & 7;
        const imm = (((op >> 9) & 1) << 6) | (((op >> 3) & 0x1f) << 1);
        const nonzero = (op & 0x800) !== 0;
        if ((this.r[rn] !== 0) === nonzero) {
          this.branchTo(this.pcOperand + imm);
          return 2;
        }
        return 1;
      }
      case 0x2: {
        const rd = op & 7;
        const m = this.r[(op >> 3) & 7];
        switch ((op >> 6) & 3) {
          case 0:
            this.r[rd] = sx16(m & 0xffff) >>> 0;
            break;
          case 1:
            this.r[rd] = sx8(m & 0xff) >>> 0;
            break;
          case 2:
            this.r[rd] = m & 0xffff;
            break;
          default:
            this.r[rd] = m & 0xff;
        }
        return 1;
      }
      case 0x4:
      case 0x5: {
        // PUSH
        const list = (op & 0xff) | (op & 0x100 ? 0x4000 : 0);
        let count = 0;
        for (let i = 0; i < 16; i++) if (list & (1 << i)) count++;
        let address = (this.r[13] - 4 * count) >>> 0;
        this.r[13] = address;
        for (let i = 0; i < 16; i++) {
          if (list & (1 << i)) {
            this.write32(address, this.r[i]);
            address += 4;
          }
        }
        return 1 + count;
      }
      case 0x6: {
        if ((op & 0xffe8) === 0xb660) {
          // CPS
          const disable = (op & 0x10) !== 0;
          if (op & 2) this.primask = disable ? 1 : 0;
          if (op & 1) this.faultmask = disable ? 1 : 0;
          this.recheck = true;
          return 1;
        }
        this.undefined16(op);
        break;
      }
      case 0xa: {
        const rd = op & 7;
        const m = this.r[(op >> 3) & 7];
        switch ((op >> 6) & 3) {
          case 0:
            this.r[rd] = this.rev(m);
            break;
          case 1:
            this.r[rd] = this.rev16(m);
            break;
          case 3:
            this.r[rd] = sx16(((m & 0xff) << 8) | ((m >> 8) & 0xff)) >>> 0;
            break;
          default:
            this.undefined16(op);
        }
        return 1;
      }
      case 0xc:
      case 0xd: {
        // POP
        const list = (op & 0xff) | (op & 0x100 ? 0x8000 : 0);
        let address = this.r[13];
        let count = 0;
        for (let i = 0; i < 15; i++) {
          if (list & (1 << i)) {
            this.r[i] = this.read32(address);
            address += 4;
            count++;
          }
        }
        if (list & 0x8000) {
          const target = this.read32(address);
          address += 4;
          this.r[13] = address >>> 0;
          this.bxWritePc(target);
          return 4 + count;
        }
        this.r[13] = address >>> 0;
        return 1 + count;
      }
      case 0xe: {
        // BKPT
        const handled = this.onBreakpoint?.(op & 0xff);
        if (!handled) throw new ArmFault(`Breakpoint #${op & 0xff}: the firmware stopped itself (a failed assertion, or a debugger trap)`, this.pc);
        return 1;
      }
      case 0xf: {
        if (op & 0xf) {
          // IT
          this.itstate = op & 0xff;
          this.itAdvance = false;
          return 1;
        }
        switch ((op >> 4) & 0xf) {
          case 0: // NOP
          case 1: // YIELD
            return 1;
          case 2: // WFE
            if (this.eventRegister) this.eventRegister = false;
            else if (!this.wakeable()) this.sleeping = true;
            return 1;
          case 3: // WFI
            if (!this.wakeable()) this.sleeping = true;
            return 1;
          case 4: // SEV
            this.eventRegister = true;
            return 1;
          default:
            return 1;
        }
      }
      default:
        this.undefined16(op);
    }
    return 1;
  }

  private rev(v: number): number {
    return (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24)) >>> 0;
  }

  private rev16(v: number): number {
    return (((v & 0x00ff00ff) << 8) | ((v >>> 8) & 0x00ff00ff)) >>> 0;
  }

  // ------------------------------------------------------ 32-bit Thumb-2

  private exec32(hw1: number, hw2: number): number {
    const op1 = (hw1 >> 11) & 3;
    if (op1 === 1) {
      if ((hw1 & 0x0640) === 0x0000) return this.loadStoreMultiple(hw1, hw2);
      if ((hw1 & 0x0640) === 0x0040) return this.loadStoreDualExclusive(hw1, hw2);
      if ((hw1 & 0x0600) === 0x0200) return this.dataProcessingShifted(hw1, hw2);
      return this.coprocessor(hw1, hw2);
    }
    if (op1 === 2) {
      if (hw2 & 0x8000) return this.branchMisc(hw1, hw2);
      if (hw1 & 0x0200) return this.dataProcessingPlain(hw1, hw2);
      return this.dataProcessingModified(hw1, hw2);
    }
    // op1 === 3
    const op2 = (hw1 >> 4) & 0x7f;
    if ((op2 & 0x71) === 0x00) return this.storeSingle(hw1, hw2);
    if ((op2 & 0x67) === 0x01) return this.loadByteHalf(hw1, hw2, false);
    if ((op2 & 0x67) === 0x03) return this.loadByteHalf(hw1, hw2, true);
    if ((op2 & 0x67) === 0x05) return this.loadWord(hw1, hw2);
    if ((op2 & 0x70) === 0x20) return this.dataProcessingRegister(hw1, hw2);
    if ((op2 & 0x78) === 0x30) return this.multiply(hw1, hw2);
    if ((op2 & 0x78) === 0x38) return this.longMultiply(hw1, hw2);
    if (op2 & 0x40) return this.coprocessor(hw1, hw2);
    this.undefined32(hw1, hw2);
  }

  private loadStoreMultiple(hw1: number, hw2: number): number {
    const op = (hw1 >> 7) & 3;
    const load = (hw1 & 0x10) !== 0;
    const wback = (hw1 & 0x20) !== 0;
    const rn = hw1 & 0xf;
    const list = hw2 & 0xffff;
    let count = 0;
    for (let i = 0; i < 16; i++) if (list & (1 << i)) count++;
    let address: number;
    if (op === 1) address = this.r[rn];
    else if (op === 2) address = (this.r[rn] - 4 * count) >>> 0;
    else this.undefined32(hw1, hw2);
    const start = address;
    let pcTarget: number | null = null;
    for (let i = 0; i < 16; i++) {
      if (!(list & (1 << i))) continue;
      if (load) {
        const value = this.read32(address);
        if (i === 15) pcTarget = value;
        else this.r[i] = value;
      } else {
        this.write32(address, this.reg(i));
      }
      address += 4;
    }
    if (wback && !(load && list & (1 << rn))) {
      this.r[rn] = op === 1 ? address >>> 0 : start;
    }
    if (pcTarget !== null) {
      this.bxWritePc(pcTarget);
      return 4 + count;
    }
    return 1 + count;
  }

  private loadStoreDualExclusive(hw1: number, hw2: number): number {
    const op1 = (hw1 >> 7) & 3;
    const op2 = (hw1 >> 4) & 3;
    const rn = hw1 & 0xf;
    const rt = (hw2 >> 12) & 0xf;
    if (op1 === 0 && op2 === 0) {
      // STREX
      const rd = (hw2 >> 8) & 0xf;
      const address = (this.r[rn] + (hw2 & 0xff) * 4) >>> 0;
      if (this.exclusive) {
        this.write32(address, this.r[rt]);
        this.r[rd] = 0;
      } else {
        this.r[rd] = 1;
      }
      this.exclusive = false;
      return 2;
    }
    if (op1 === 0 && op2 === 1) {
      // LDREX
      this.r[rt] = this.read32((this.r[rn] + (hw2 & 0xff) * 4) >>> 0);
      this.exclusive = true;
      return 2;
    }
    if (op1 === 1 && op2 === 0) {
      // STREXB / STREXH
      const rd = hw2 & 0xf;
      const op3 = (hw2 >> 4) & 0xf;
      if (this.exclusive) {
        if (op3 === 4) this.write8(this.r[rn], this.r[rt]);
        else if (op3 === 5) this.write16(this.r[rn], this.r[rt]);
        else this.undefined32(hw1, hw2);
        this.r[rd] = 0;
      } else {
        this.r[rd] = 1;
      }
      this.exclusive = false;
      return 2;
    }
    if (op1 === 1 && op2 === 1) {
      const op3 = (hw2 >> 4) & 0xf;
      if (op3 === 0 || op3 === 1) {
        // TBB / TBH
        const rm = hw2 & 0xf;
        const base = this.reg(rn);
        const index = this.r[rm];
        const offset = op3 === 0 ? this.read8((base + index) >>> 0) : this.read16((base + index * 2) >>> 0);
        this.branchTo(this.pcOperand + offset * 2);
        return 4;
      }
      if (op3 === 4) {
        this.r[rt] = this.read8(this.r[rn]);
        this.exclusive = true;
        return 2;
      }
      if (op3 === 5) {
        this.r[rt] = this.read16(this.r[rn]);
        this.exclusive = true;
        return 2;
      }
      this.undefined32(hw1, hw2);
    }
    // LDRD / STRD (immediate and literal)
    const p = (hw1 >> 8) & 1;
    const u = (hw1 >> 7) & 1;
    const w = (hw1 >> 5) & 1;
    const load = (hw1 >> 4) & 1;
    const rt2 = (hw2 >> 8) & 0xf;
    const imm = (hw2 & 0xff) * 4;
    const base = rn === 15 ? this.pcOperand & ~3 : this.r[rn];
    const offsetAddr = (u ? base + imm : base - imm) >>> 0;
    const address = p ? offsetAddr : base;
    if (load) {
      this.r[rt] = this.read32(address);
      this.r[rt2] = this.read32(address + 4);
    } else {
      this.write32(address, this.r[rt]);
      this.write32(address + 4, this.r[rt2]);
    }
    if (w && rn !== 15) this.r[rn] = offsetAddr;
    return 3;
  }

  /** The shared body of the modified-immediate and shifted-register data processing ops. */
  private dataOp(op: number, rn: number, rd: number, s: boolean, operand: number, carry: number, hw1: number, hw2: number): number {
    const a = this.reg(rn);
    let result: number;
    switch (op) {
      case 0x0: // AND / TST
        result = (a & operand) >>> 0;
        if (rd === 15 && s) {
          this.setNZ(result);
          this.c = carry;
          return 1;
        }
        break;
      case 0x1: // BIC
        result = (a & ~operand) >>> 0;
        break;
      case 0x2: // ORR / MOV
        result = rn === 15 ? operand >>> 0 : (a | operand) >>> 0;
        break;
      case 0x3: // ORN / MVN
        result = rn === 15 ? ~operand >>> 0 : (a | ~operand) >>> 0;
        break;
      case 0x4: // EOR / TEQ
        result = (a ^ operand) >>> 0;
        if (rd === 15 && s) {
          this.setNZ(result);
          this.c = carry;
          return 1;
        }
        break;
      case 0x8: // ADD / CMN
        if (rd === 15 && s) {
          this.addWithCarry(a, operand, 0, true);
          return 1;
        }
        this.r[rd] = this.addWithCarry(a, operand, 0, s);
        return 1;
      case 0xa: // ADC
        this.r[rd] = this.addWithCarry(a, operand, this.c, s);
        return 1;
      case 0xb: // SBC
        this.r[rd] = this.addWithCarry(a, ~operand >>> 0, this.c, s);
        return 1;
      case 0xd: // SUB / CMP
        if (rd === 15 && s) {
          this.addWithCarry(a, ~operand >>> 0, 1, true);
          return 1;
        }
        this.r[rd] = this.addWithCarry(a, ~operand >>> 0, 1, s);
        return 1;
      case 0xe: // RSB
        this.r[rd] = this.addWithCarry(~a >>> 0, operand, 1, s);
        return 1;
      default:
        this.undefined32(hw1, hw2);
    }
    this.r[rd] = result;
    if (s) {
      this.setNZ(result);
      this.c = carry;
    }
    return 1;
  }

  private dataProcessingModified(hw1: number, hw2: number): number {
    const op = (hw1 >> 5) & 0xf;
    const s = (hw1 & 0x10) !== 0;
    const rn = hw1 & 0xf;
    const rd = (hw2 >> 8) & 0xf;
    const imm12 = (((hw1 >> 10) & 1) << 11) | (((hw2 >> 12) & 7) << 8) | (hw2 & 0xff);
    const [operand, carry] = this.expandImm(imm12);
    return this.dataOp(op, rn, rd, s, operand, carry, hw1, hw2);
  }

  private dataProcessingShifted(hw1: number, hw2: number): number {
    const op = (hw1 >> 5) & 0xf;
    const s = (hw1 & 0x10) !== 0;
    const rn = hw1 & 0xf;
    const rd = (hw2 >> 8) & 0xf;
    const rm = hw2 & 0xf;
    const imm5 = (((hw2 >> 12) & 7) << 2) | ((hw2 >> 6) & 3);
    const type = (hw2 >> 4) & 3;
    if (op === 0x6) {
      // PKHBT / PKHTB
      const [t, amount] = this.decodeShift(type & 2, imm5);
      const [shifted] = this.shiftC(this.r[rm], t, amount, this.c);
      const a = this.r[rn];
      this.r[rd] = type & 2 ? ((a & 0xffff0000) | (shifted & 0xffff)) >>> 0 : ((shifted & 0xffff0000) | (a & 0xffff)) >>> 0;
      return 1;
    }
    const [t, amount] = this.decodeShift(type, imm5);
    const [operand, carry] = this.shiftC(this.reg(rm), t, amount, this.c);
    return this.dataOp(op, rn, rd, s, operand, carry, hw1, hw2);
  }

  private dataProcessingPlain(hw1: number, hw2: number): number {
    const op = (hw1 >> 4) & 0x1f;
    const rn = hw1 & 0xf;
    const rd = (hw2 >> 8) & 0xf;
    const imm3 = (hw2 >> 12) & 7;
    const imm2 = (hw2 >> 6) & 3;
    const i = (hw1 >> 10) & 1;
    switch (op) {
      case 0x00: {
        // ADDW / ADR
        const imm12 = (i << 11) | (imm3 << 8) | (hw2 & 0xff);
        this.r[rd] = rn === 15 ? ((this.pcOperand & ~3) + imm12) >>> 0 : (this.r[rn] + imm12) >>> 0;
        return 1;
      }
      case 0x0a: {
        // SUBW / ADR (subtract)
        const imm12 = (i << 11) | (imm3 << 8) | (hw2 & 0xff);
        this.r[rd] = rn === 15 ? ((this.pcOperand & ~3) - imm12) >>> 0 : (this.r[rn] - imm12) >>> 0;
        return 1;
      }
      case 0x04: {
        // MOVW
        this.r[rd] = (rn << 12) | (i << 11) | (imm3 << 8) | (hw2 & 0xff);
        return 1;
      }
      case 0x0c: {
        // MOVT
        const imm16 = (rn << 12) | (i << 11) | (imm3 << 8) | (hw2 & 0xff);
        this.r[rd] = ((this.r[rd] & 0xffff) | (imm16 << 16)) >>> 0;
        return 1;
      }
      case 0x10:
      case 0x12: {
        // SSAT (and SSAT16 when the shift is zero and op is 0x12)
        const satImm = (hw2 & 0x1f) + 1;
        const shiftN = (imm3 << 2) | imm2;
        if (op === 0x12 && shiftN === 0) {
          const v = this.r[rn];
          const lo = this.satS(sx16(v & 0xffff), satImm);
          const hi = this.satS(sx16(v >>> 16), satImm);
          this.r[rd] = ((lo & 0xffff) | (hi << 16)) >>> 0;
          return 1;
        }
        const [operand] = this.shiftC(this.r[rn], op & 2 ? 2 : 0, shiftN === 0 && op & 2 ? 32 : shiftN, this.c);
        this.r[rd] = this.satS(operand | 0, satImm) >>> 0;
        return 1;
      }
      case 0x14: {
        // SBFX
        const lsb = (imm3 << 2) | imm2;
        const width = (hw2 & 0x1f) + 1;
        this.r[rd] = (((this.r[rn] << (32 - lsb - width)) >> (32 - width)) >>> 0);
        return 1;
      }
      case 0x16: {
        // BFI / BFC
        const lsb = (imm3 << 2) | imm2;
        const msb = hw2 & 0x1f;
        if (msb < lsb) return 1;
        const width = msb - lsb + 1;
        const mask = width === 32 ? 0xffffffff : ((1 << width) - 1) << lsb;
        const source = rn === 15 ? 0 : this.r[rn] << lsb;
        this.r[rd] = ((this.r[rd] & ~mask) | (source & mask)) >>> 0;
        return 1;
      }
      case 0x18:
      case 0x1a: {
        // USAT (and USAT16)
        const satImm = hw2 & 0x1f;
        const shiftN = (imm3 << 2) | imm2;
        if (op === 0x1a && shiftN === 0) {
          const v = this.r[rn];
          const lo = this.satU(sx16(v & 0xffff), satImm);
          const hi = this.satU(sx16(v >>> 16), satImm);
          this.r[rd] = ((lo & 0xffff) | (hi << 16)) >>> 0;
          return 1;
        }
        const [operand] = this.shiftC(this.r[rn], op & 2 ? 2 : 0, shiftN === 0 && op & 2 ? 32 : shiftN, this.c);
        this.r[rd] = this.satU(operand | 0, satImm) >>> 0;
        return 1;
      }
      case 0x1c: {
        // UBFX
        const lsb = (imm3 << 2) | imm2;
        const width = (hw2 & 0x1f) + 1;
        this.r[rd] = width >= 32 ? this.r[rn] >>> lsb : ((this.r[rn] >>> lsb) % 2 ** width) >>> 0;
        return 1;
      }
      default:
        this.undefined32(hw1, hw2);
    }
  }

  private satS(value: number, bits: number): number {
    const max = 2 ** (bits - 1) - 1;
    const min = -(2 ** (bits - 1));
    if (value > max) {
      this.q = 1;
      return max;
    }
    if (value < min) {
      this.q = 1;
      return min;
    }
    return value;
  }

  private satU(value: number, bits: number): number {
    const max = 2 ** bits - 1;
    if (value > max) {
      this.q = 1;
      return max;
    }
    if (value < 0) {
      this.q = 1;
      return 0;
    }
    return value;
  }

  private branchMisc(hw1: number, hw2: number): number {
    const op1 = (hw2 >> 12) & 7;
    const op = (hw1 >> 4) & 0x7f;
    if (op1 & 1) {
      // B (T4) / BL
      const s = (hw1 >> 10) & 1;
      const j1 = (hw2 >> 13) & 1;
      const j2 = (hw2 >> 11) & 1;
      const i1 = ~(j1 ^ s) & 1;
      const i2 = ~(j2 ^ s) & 1;
      let imm = (s << 24) | (i1 << 23) | (i2 << 22) | ((hw1 & 0x3ff) << 12) | ((hw2 & 0x7ff) << 1);
      imm = (imm << 7) >> 7;
      if (op1 & 4) this.r[14] = (this.r[15] | 1) >>> 0;
      this.branchTo(this.pcOperand + imm);
      return op1 & 4 ? 3 : 2;
    }
    if ((op & 0x38) !== 0x38) {
      // B<cond> (T3)
      const c = (hw1 >> 6) & 0xf;
      if (!this.cond(c)) return 1;
      const s = (hw1 >> 10) & 1;
      const j1 = (hw2 >> 13) & 1;
      const j2 = (hw2 >> 11) & 1;
      let imm = (s << 20) | (j2 << 19) | (j1 << 18) | ((hw1 & 0x3f) << 12) | ((hw2 & 0x7ff) << 1);
      imm = (imm << 11) >> 11;
      this.branchTo(this.pcOperand + imm);
      return 2;
    }
    if ((op & 0x7e) === 0x38) {
      // MSR
      const rn = hw1 & 0xf;
      const sysm = hw2 & 0xff;
      const mask = (hw2 >> 10) & 3;
      this.msr(sysm, this.r[rn], mask);
      return 1;
    }
    if (op === 0x3a) {
      // hints
      switch (hw2 & 0xff) {
        case 2:
          if (this.eventRegister) this.eventRegister = false;
          else if (!this.wakeable()) this.sleeping = true;
          return 1;
        case 3:
          if (!this.wakeable()) this.sleeping = true;
          return 1;
        case 4:
          this.eventRegister = true;
          return 1;
        default:
          return 1;
      }
    }
    if (op === 0x3b) {
      // CLREX, DSB, DMB, ISB
      if (((hw2 >> 4) & 0xf) === 2) this.exclusive = false;
      return 1;
    }
    if ((op & 0x7e) === 0x3e) {
      // MRS
      const rd = (hw2 >> 8) & 0xf;
      this.r[rd] = this.mrs(hw2 & 0xff);
      return 1;
    }
    if (op === 0x7f && (op1 & 5) === 0) this.undefined32(hw1, hw2); // UDF
    this.undefined32(hw1, hw2);
  }

  private msr(sysm: number, value: number, mask: number): void {
    if (sysm <= 3) {
      this.apsrWrite(value, mask === 0 ? 2 : mask);
      return;
    }
    const privileged = this.ipsr !== 0 || !(this.control & 1);
    if (!privileged) return;
    switch (sysm) {
      case 8:
        if (this.ipsr === 0 && this.control & 2) this.otherSp = value & ~3;
        else this.r[13] = value & ~3;
        break;
      case 9:
        if (this.ipsr === 0 && this.control & 2) this.r[13] = value & ~3;
        else this.otherSp = value & ~3;
        break;
      case 16:
        this.primask = value & 1;
        break;
      case 17:
        this.basepri = value & this.priorityMask;
        break;
      case 18: {
        const v = value & this.priorityMask;
        if (v !== 0 && (v < this.basepri || this.basepri === 0)) this.basepri = v;
        break;
      }
      case 19:
        if (this.executionPriority() > -1) this.faultmask = value & 1;
        break;
      case 20: {
        if (this.ipsr === 0) {
          const newSpsel = value & 2;
          if (newSpsel !== (this.control & 2)) {
            const current = this.r[13];
            this.r[13] = this.otherSp;
            this.otherSp = current;
          }
          this.control = (this.control & ~3) | (value & 3);
        } else {
          this.control = (this.control & ~1) | (value & 1);
        }
        if (this.config.fpu) this.control = (this.control & ~4) | (value & 4);
        break;
      }
      default:
        break;
    }
    this.recheck = true;
  }

  private mrs(sysm: number): number {
    switch (sysm) {
      case 0:
        return this.xpsr() & 0xf80f0000;
      case 1:
        return (this.xpsr() & 0xf80f0000) | (this.ipsr & 0x1ff);
      case 2:
        return this.xpsr() & 0xf80f0000;
      case 3:
        return (this.xpsr() & 0xf80f0000) | (this.ipsr & 0x1ff);
      case 5:
      case 7:
        return this.ipsr & 0x1ff;
      case 6:
        return 0;
      case 8:
        return this.ipsr === 0 && this.control & 2 ? this.otherSp : this.r[13];
      case 9:
        return this.ipsr === 0 && this.control & 2 ? this.r[13] : this.otherSp;
      case 16:
        return this.primask;
      case 17:
      case 18:
        return this.basepri;
      case 19:
        return this.faultmask;
      case 20:
        return this.ipsr === 0 ? this.control : this.control & ~2;
      default:
        return 0;
    }
  }

  // Loads and stores

  /** Address for the 32-bit single-item load/store encodings, with writeback applied. */
  private singleAddress(hw1: number, hw2: number, scale: number): number {
    const rn = hw1 & 0xf;
    if (hw1 & 0x80) {
      // imm12
      return (this.r[rn] + (hw2 & 0xfff)) >>> 0;
    }
    if ((hw2 & 0x0fc0) === 0) {
      // register, LSL #imm2
      const rm = hw2 & 0xf;
      return (this.r[rn] + (this.r[rm] << ((hw2 >> 4) & 3))) >>> 0;
    }
    // imm8 with P/U/W (and the unprivileged T variant, P=1 U=1 W=0)
    const imm8 = hw2 & 0xff;
    const p = (hw2 >> 10) & 1;
    const u = (hw2 >> 9) & 1;
    const w = (hw2 >> 8) & 1;
    const base = this.r[rn];
    const offset = (u ? base + imm8 : base - imm8) >>> 0;
    if (w) this.writebackPending = { rn, value: offset };
    void scale;
    return p ? offset : base;
  }

  private writebackPending: { rn: number; value: number } | null = null;

  private finishWriteback(): void {
    const wb = this.writebackPending;
    if (wb) {
      this.r[wb.rn] = wb.value;
      this.writebackPending = null;
    }
  }

  private storeSingle(hw1: number, hw2: number): number {
    const rt = (hw2 >> 12) & 0xf;
    const size = (hw1 >> 5) & 3;
    const value = this.r[rt];
    const address = this.singleAddress(hw1, hw2, size);
    if (size === 0) this.write8(address, value);
    else if (size === 1) this.write16(address, value);
    else if (size === 2) this.write32(address, value);
    else this.undefined32(hw1, hw2);
    this.finishWriteback();
    return 2;
  }

  private loadByteHalf(hw1: number, hw2: number, half: boolean): number {
    const rt = (hw2 >> 12) & 0xf;
    const signed = (hw1 & 0x100) !== 0;
    const rn = hw1 & 0xf;
    let address: number;
    if (rn === 15) {
      const imm12 = hw2 & 0xfff;
      address = (hw1 & 0x80 ? (this.pcOperand & ~3) + imm12 : (this.pcOperand & ~3) - imm12) >>> 0;
    } else {
      address = this.singleAddress(hw1, hw2, half ? 1 : 0);
    }
    if (rt === 15) {
      // PLD / PLI and other hints
      this.writebackPending = null;
      return 1;
    }
    let value = half ? this.read16(address) : this.read8(address);
    if (signed) value = (half ? sx16(value) : sx8(value)) >>> 0;
    this.finishWriteback();
    this.r[rt] = value;
    return 2;
  }

  private loadWord(hw1: number, hw2: number): number {
    const rt = (hw2 >> 12) & 0xf;
    const rn = hw1 & 0xf;
    let address: number;
    if (rn === 15) {
      const imm12 = hw2 & 0xfff;
      address = (hw1 & 0x80 ? (this.pcOperand & ~3) + imm12 : (this.pcOperand & ~3) - imm12) >>> 0;
    } else {
      address = this.singleAddress(hw1, hw2, 2);
    }
    const value = this.read32(address);
    this.finishWriteback();
    if (rt === 15) {
      this.bxWritePc(value);
      return 4;
    }
    this.r[rt] = value;
    return 2;
  }

  // Register data processing, multiplies, divides

  private dataProcessingRegister(hw1: number, hw2: number): number {
    const op1 = (hw1 >> 4) & 0xf;
    const op2 = (hw2 >> 4) & 0xf;
    const rn = hw1 & 0xf;
    const rd = (hw2 >> 8) & 0xf;
    const rm = hw2 & 0xf;
    if ((op1 & 0x8) === 0 && op2 === 0) {
      // LSL/LSR/ASR/ROR (register)
      const type = (op1 >> 1) & 3;
      const s = (op1 & 1) !== 0;
      const [res, carry] = this.shiftC(this.r[rn], type, this.r[rm] & 0xff, this.c);
      this.r[rd] = res;
      if (s) {
        this.setNZ(res);
        this.c = carry;
      }
      return 1;
    }
    if ((op1 & 0x8) === 0 && op2 & 0x8) {
      // Extend and add: SXTAH SXTH UXTAH UXTH SXTAB16 SXTB16 UXTAB16 UXTB16 SXTAB SXTB UXTAB UXTB
      const rot = ((hw2 >> 4) & 3) * 8;
      const m = this.r[rm];
      const rotated = rot ? ((m >>> rot) | (m << (32 - rot))) >>> 0 : m;
      const add = rn === 15 ? 0 : this.r[rn];
      switch (op1) {
        case 0:
          this.r[rd] = (add + sx16(rotated & 0xffff)) >>> 0;
          break;
        case 1:
          this.r[rd] = (add + (rotated & 0xffff)) >>> 0;
          break;
        case 2: {
          const lo = ((add & 0xffff) + sx8(rotated & 0xff)) & 0xffff;
          const hi = ((add >>> 16) + sx8((rotated >>> 16) & 0xff)) & 0xffff;
          this.r[rd] = (lo | (hi << 16)) >>> 0;
          break;
        }
        case 3: {
          const lo = ((add & 0xffff) + (rotated & 0xff)) & 0xffff;
          const hi = ((add >>> 16) + ((rotated >>> 16) & 0xff)) & 0xffff;
          this.r[rd] = (lo | (hi << 16)) >>> 0;
          break;
        }
        case 4:
          this.r[rd] = (add + sx8(rotated & 0xff)) >>> 0;
          break;
        case 5:
          this.r[rd] = (add + (rotated & 0xff)) >>> 0;
          break;
        default:
          this.undefined32(hw1, hw2);
      }
      return 1;
    }
    if ((op1 & 0x8) && (op2 & 0x8) === 0) return this.parallelAddSub(hw1, hw2);
    if ((op1 & 0xc) === 0x8 && (op2 & 0xc) === 0x8) {
      // Miscellaneous: QADD QDADD QSUB QDSUB REV REV16 RBIT REVSH SEL CLZ
      const a = this.r[rn];
      const b = this.r[rm];
      const op = ((op1 & 3) << 2) | (op2 & 3);
      switch (op) {
        case 0x0:
          this.r[rd] = this.satS((b | 0) + (a | 0), 32) >>> 0;
          break;
        case 0x1:
          this.r[rd] = this.satS((b | 0) + this.satS(2 * (a | 0), 32), 32) >>> 0;
          break;
        case 0x2:
          this.r[rd] = this.satS((b | 0) - (a | 0), 32) >>> 0;
          break;
        case 0x3:
          this.r[rd] = this.satS((b | 0) - this.satS(2 * (a | 0), 32), 32) >>> 0;
          break;
        case 0x4:
          this.r[rd] = this.rev(a);
          break;
        case 0x5:
          this.r[rd] = this.rev16(a);
          break;
        case 0x6: {
          let v = a;
          let out = 0;
          for (let i = 0; i < 32; i++) {
            out = (out << 1) | (v & 1);
            v >>>= 1;
          }
          this.r[rd] = out >>> 0;
          break;
        }
        case 0x7:
          this.r[rd] = sx16(((a & 0xff) << 8) | ((a >> 8) & 0xff)) >>> 0;
          break;
        case 0x8: {
          let out = 0;
          for (let i = 0; i < 4; i++) {
            const lane = 0xff << (8 * i);
            out |= (this.ge & (1 << i) ? a : b) & lane;
          }
          this.r[rd] = out >>> 0;
          break;
        }
        case 0xc:
          this.r[rd] = Math.clz32(a);
          break;
        default:
          this.undefined32(hw1, hw2);
      }
      return 1;
    }
    this.undefined32(hw1, hw2);
  }

  /** SADD16, UQSUB8, SHASX and the rest of the parallel family. */
  private parallelAddSub(hw1: number, hw2: number): number {
    const op1 = (hw1 >> 4) & 7;
    const unsigned = ((hw2 >> 6) & 1) === 1;
    const kind = (hw2 >> 4) & 3; // 0 plain (sets GE), 1 saturating, 2 halving
    const rn = hw1 & 0xf;
    const rd = (hw2 >> 8) & 0xf;
    const rm = hw2 & 0xf;
    const a = this.r[rn];
    const b = this.r[rm];
    const bits = op1 === 0 || op1 === 4 ? 8 : 16;
    const mask = bits === 8 ? 0xff : 0xffff;
    const lane = (v: number, i: number) => {
      const raw = (v >>> (i * bits)) & mask;
      return unsigned ? raw : bits === 8 ? sx8(raw) : sx16(raw);
    };
    let sums: number[];
    let isAdd: boolean[];
    switch (op1) {
      case 0: // ADD8
        sums = [0, 1, 2, 3].map((i) => lane(a, i) + lane(b, i));
        isAdd = [true, true, true, true];
        break;
      case 4: // SUB8
        sums = [0, 1, 2, 3].map((i) => lane(a, i) - lane(b, i));
        isAdd = [false, false, false, false];
        break;
      case 1: // ADD16
        sums = [lane(a, 0) + lane(b, 0), lane(a, 1) + lane(b, 1)];
        isAdd = [true, true];
        break;
      case 5: // SUB16
        sums = [lane(a, 0) - lane(b, 0), lane(a, 1) - lane(b, 1)];
        isAdd = [false, false];
        break;
      case 2: // ASX
        sums = [lane(a, 0) - lane(b, 1), lane(a, 1) + lane(b, 0)];
        isAdd = [false, true];
        break;
      case 6: // SAX
        sums = [lane(a, 0) + lane(b, 1), lane(a, 1) - lane(b, 0)];
        isAdd = [true, false];
        break;
      default:
        this.undefined32(hw1, hw2);
    }
    const lanes = sums.length;
    let result = 0;
    let ge = 0;
    sums.forEach((sum, i) => {
      let r: number;
      if (kind === 0) {
        r = sum;
        const set = unsigned ? (isAdd[i] ? sum >= 2 ** bits : sum >= 0) : sum >= 0;
        if (set) ge |= (bits === 8 ? 1 : 3) << (i * (bits === 8 ? 1 : 2));
      } else if (kind === 1) {
        const lo = unsigned ? 0 : -(2 ** (bits - 1));
        const hi = unsigned ? 2 ** bits - 1 : 2 ** (bits - 1) - 1;
        r = Math.max(lo, Math.min(hi, sum));
      } else {
        r = Math.floor(sum / 2);
      }
      result |= (r & mask) << (i * bits);
    });
    void lanes;
    if (kind === 0) this.ge = ge;
    this.r[rd] = result >>> 0;
    return 1;
  }

  private multiply(hw1: number, hw2: number): number {
    const op1 = (hw1 >> 4) & 7;
    const op2 = (hw2 >> 4) & 3;
    const rn = hw1 & 0xf;
    const ra = (hw2 >> 12) & 0xf;
    const rd = (hw2 >> 8) & 0xf;
    const rm = hw2 & 0xf;
    const a = this.r[rn];
    const b = this.r[rm];
    const acc = ra === 15 ? 0 : this.r[ra];
    switch (op1) {
      case 0:
        if (op2 === 0) this.r[rd] = (Math.imul(a, b) + acc) >>> 0; // MLA / MUL
        else if (op2 === 1) this.r[rd] = (acc - Math.imul(a, b)) >>> 0; // MLS
        else this.undefined32(hw1, hw2);
        return 2;
      case 1: {
        // SMULxy / SMLAxy
        const x = op2 & 2 ? sx16(a >>> 16) : sx16(a & 0xffff);
        const y = op2 & 1 ? sx16(b >>> 16) : sx16(b & 0xffff);
        const product = x * y;
        const sum = product + (acc | 0);
        if (ra !== 15 && sum !== (sum | 0)) this.q = 1;
        this.r[rd] = sum >>> 0;
        return 1;
      }
      case 2:
      case 4: {
        // SMUAD/SMLAD (2), SMUSD/SMLSD (4)
        const swap = (op2 & 1) !== 0;
        const bb = swap ? ((b >>> 16) | (b << 16)) >>> 0 : b;
        const p1 = sx16(a & 0xffff) * sx16(bb & 0xffff);
        const p2 = sx16(a >>> 16) * sx16(bb >>> 16);
        const r = op1 === 2 ? p1 + p2 + (acc | 0) : p1 - p2 + (acc | 0);
        if (r !== (r | 0)) this.q = 1;
        this.r[rd] = r >>> 0;
        return 1;
      }
      case 3: {
        // SMULWy / SMLAWy
        const y = op2 & 1 ? sx16(b >>> 16) : sx16(b & 0xffff);
        const [lo, hi] = smul64(a, y);
        const product = ((lo >>> 16) | (hi << 16)) | 0;
        const sum = product + (acc | 0);
        if (ra !== 15 && sum !== (sum | 0)) this.q = 1;
        this.r[rd] = sum >>> 0;
        return 1;
      }
      case 5:
      case 6: {
        // SMMUL/SMMLA (5), SMMLS (6); bit 4 of op2 rounds
        const [lo, hi] = smul64(a, b);
        let [rlo, rhi] = [lo, hi];
        if (op1 === 5) [rlo, rhi] = add64(lo, hi, 0, acc);
        else [rlo, rhi] = sub64(0, acc, lo, hi);
        if (op2 & 1) [rlo, rhi] = add64(rlo, rhi, 0x80000000, 0);
        this.r[rd] = rhi >>> 0;
        return 2;
      }
      case 7: {
        // USAD8 / USADA8
        let sum = 0;
        for (let i = 0; i < 4; i++) sum += Math.abs(((a >>> (8 * i)) & 0xff) - ((b >>> (8 * i)) & 0xff));
        this.r[rd] = (sum + acc) >>> 0;
        return 1;
      }
      default:
        this.undefined32(hw1, hw2);
    }
  }

  private longMultiply(hw1: number, hw2: number): number {
    const op1 = (hw1 >> 4) & 7;
    const op2 = (hw2 >> 4) & 0xf;
    const rn = hw1 & 0xf;
    const rdLo = (hw2 >> 12) & 0xf;
    const rdHi = (hw2 >> 8) & 0xf;
    const rm = hw2 & 0xf;
    const a = this.r[rn];
    const b = this.r[rm];
    switch (op1) {
      case 0: {
        const [lo, hi] = smul64(a, b);
        this.r[rdLo] = lo;
        this.r[rdHi] = hi;
        return 2;
      }
      case 1: {
        // SDIV
        const d = b | 0;
        const n = a | 0;
        this.r[rdHi] = d === 0 ? 0 : n === -0x80000000 && d === -1 ? 0x80000000 : Math.trunc(n / d) >>> 0;
        return 6;
      }
      case 2: {
        const [lo, hi] = umul64(a, b);
        this.r[rdLo] = lo;
        this.r[rdHi] = hi;
        return 2;
      }
      case 3: {
        // UDIV
        this.r[rdHi] = b === 0 ? 0 : Math.floor(a / b) >>> 0;
        return 6;
      }
      case 4: {
        if (op2 === 0) {
          // SMLAL
          const [lo, hi] = smul64(a, b);
          const [rlo, rhi] = add64(lo, hi, this.r[rdLo], this.r[rdHi]);
          this.r[rdLo] = rlo;
          this.r[rdHi] = rhi;
          return 2;
        }
        if ((op2 & 0xc) === 0x8) {
          // SMLALxy
          const x = op2 & 2 ? sx16(a >>> 16) : sx16(a & 0xffff);
          const y = op2 & 1 ? sx16(b >>> 16) : sx16(b & 0xffff);
          const p = x * y;
          const [rlo, rhi] = add64(p >>> 0, p < 0 ? 0xffffffff : 0, this.r[rdLo], this.r[rdHi]);
          this.r[rdLo] = rlo;
          this.r[rdHi] = rhi;
          return 1;
        }
        if ((op2 & 0xe) === 0xc) {
          // SMLALD
          const swap = (op2 & 1) !== 0;
          const bb = swap ? ((b >>> 16) | (b << 16)) >>> 0 : b;
          const p = sx16(a & 0xffff) * sx16(bb & 0xffff) + sx16(a >>> 16) * sx16(bb >>> 16);
          const [rlo, rhi] = add64(p >>> 0, p < 0 ? 0xffffffff : Math.floor(p / 0x100000000), this.r[rdLo], this.r[rdHi]);
          this.r[rdLo] = rlo;
          this.r[rdHi] = rhi;
          return 1;
        }
        this.undefined32(hw1, hw2);
        break;
      }
      case 5: {
        // SMLSLD
        const swap = (op2 & 1) !== 0;
        const bb = swap ? ((b >>> 16) | (b << 16)) >>> 0 : b;
        const p = sx16(a & 0xffff) * sx16(bb & 0xffff) - sx16(a >>> 16) * sx16(bb >>> 16);
        const [rlo, rhi] = add64(p >>> 0, p < 0 ? 0xffffffff : 0, this.r[rdLo], this.r[rdHi]);
        this.r[rdLo] = rlo;
        this.r[rdHi] = rhi;
        return 1;
      }
      case 6: {
        if (op2 === 0) {
          // UMLAL
          const [lo, hi] = umul64(a, b);
          const [rlo, rhi] = add64(lo, hi, this.r[rdLo], this.r[rdHi]);
          this.r[rdLo] = rlo;
          this.r[rdHi] = rhi;
          return 2;
        }
        if (op2 === 6) {
          // UMAAL
          const [lo, hi] = umul64(a, b);
          let [rlo, rhi] = add64(lo, hi, this.r[rdLo], 0);
          [rlo, rhi] = add64(rlo, rhi, this.r[rdHi], 0);
          this.r[rdLo] = rlo;
          this.r[rdHi] = rhi;
          return 2;
        }
        this.undefined32(hw1, hw2);
        break;
      }
      default:
        this.undefined32(hw1, hw2);
    }
    return 1;
  }

  private coprocessor(hw1: number, hw2: number): number {
    const coproc = (hw2 >> 8) & 0xf;
    if ((coproc & 0xe) !== 0xa || !this.config.fpu) {
      throw new ArmFault(`Coprocessor instruction (cp${coproc}): no such coprocessor on this chip`, this.pc);
    }
    if (((this.cpacr >> 20) & 0xf) !== 0xf) {
      throw new ArmFault('Floating-point instruction with the FPU disabled (CPACR): the firmware never enabled it', this.pc);
    }
    if (this.fpccr & 0x80000000) this.control |= 4; // FPCA: this context now has FP state
    return executeFp(this, hw1, hw2);
  }

  /** For the FPU: sets APSR NZCV from FPSCR (VMRS APSR_nzcv, FPSCR). */
  copyFpFlags(): void {
    this.n = (this.fpscr >>> 31) & 1;
    this.z = (this.fpscr >>> 30) & 1;
    this.c = (this.fpscr >>> 29) & 1;
    this.v = (this.fpscr >>> 28) & 1;
  }

  /** For the FPU: the operand value of a core register. */
  coreReg(n: number): number {
    return this.reg(n);
  }

  /** For the FPU: base address of literal-relative accesses. */
  get alignedPc(): number {
    return this.pcOperand & ~3;
  }

  /** For the FPU: raise an undefined-instruction fault for an encoding it does not know. */
  fpUndefined(hw1: number, hw2: number): never {
    this.undefined32(hw1, hw2);
  }

  /** The address of the instruction executing, for diagnostics. */
  get currentPc(): number {
    return this.pc;
  }
}
