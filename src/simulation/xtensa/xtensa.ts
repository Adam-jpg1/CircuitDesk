// An Xtensa core, as Espressif configures it: the ESP32's and ESP32-S3's LX6
// and LX7 (windowed registers, FPU, zero-overhead loops, MAC16 accumulator)
// and the ESP8266's LX106 (CALL0 ABI, no windows, no FPU).
//
// Written from the Xtensa Instruction Set Architecture Reference Manual. What
// it models is what Espressif's toolchain and ESP-IDF actually depend on:
//
//   * the 24- and 16-bit (density) encodings of the core, MUL32/MUL32_HIGH,
//     DIV32, MUL16, NSA, MIN/MAX, SEXT/CLAMPS, the boolean registers and the
//     single-precision FPU, S32C1I with SCOMPARE1, L32R;
//   * the windowed register file: CALLn/ENTRY/RETW, ROTW, MOVSP, and the
//     window overflow and underflow exceptions whose handlers IDF supplies,
//     with L32E/S32E, RFWO and RFWU;
//   * exceptions (user, kernel, double) with EPC1/EXCCAUSE/EXCVADDR/DEPC,
//     interrupts at levels 1 to 7 through their vectors with EPCn/EPSn/RFI,
//     the coprocessor-disabled exception lazy FPU switching relies on, and
//     CCOUNT/CCOMPARE timer interrupts;
//   * zero-overhead loops (LOOP, LOOPNEZ, LOOPGTZ with LBEG/LEND/LCOUNT).
//
// Memory is reached through the bus the SoC model provides. A call into the
// chip's mask ROM is handed to `rom` before the first ROM instruction runs,
// so the SoC can provide the ROM's documented behaviour natively.

export interface XtensaBus {
  read8(a: number): number;
  read16(a: number): number;
  read32(a: number): number;
  write8(a: number, v: number): void;
  write16(a: number, v: number): void;
  write32(a: number, v: number): void;
  /** Optional: the three bytes at an instruction address, little-endian. */
  fetch?(a: number): number;
}

export interface XtensaConfig {
  windowed: boolean;
  fpu: boolean;
  /** Number of physical address registers: 64 with windows, 16 without. */
  nareg: number;
  /** PS.EXCM masks interrupts up to this level (XCHAL_EXCM_LEVEL). */
  excmLevel: number;
  /** Interrupt level of each of the 32 interrupt numbers. */
  intLevel: number[];
  /** Interrupt numbers of the CCOMPARE0..2 timers (-1 where absent). */
  timerInt: number[];
  /** Vector offsets from VECBASE: level 2..7, kernel, user, double. */
  vectors: { level: Record<number, number>; kernel: number; user: number; double: number };
  prid: number;
  /** Reset VECBASE. */
  vecbase: number;
}

/** An exception raised while executing an instruction. */
class XtensaExc {
  constructor(
    readonly cause: number,
    readonly vaddr = 0,
  ) {}
}

/** A window overflow or underflow: the vector offset to take. */
class WindowExc {
  constructor(readonly vector: number) {}
}

export const EXC = {
  ILLEGAL: 0, SYSCALL: 1, INSTR_FETCH_ERROR: 2, LOAD_STORE_ERROR: 3, LEVEL1_INT: 4, ALLOCA: 5, DIVIDE_BY_ZERO: 6,
  PRIVILEGED: 8, LOAD_STORE_ALIGNMENT: 9, COPROCESSOR0_DISABLED: 32,
};

const PS_INTLEVEL = 0xf;
const PS_EXCM = 1 << 4;
const PS_UM = 1 << 5;
const PS_OWB_SHIFT = 8;
const PS_CALLINC_SHIFT = 16;
const PS_WOE = 1 << 18;

const B4CONST = [-1, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256];
const B4CONSTU = [32768, 65536, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256];

const sext = (v: number, bits: number) => (v << (32 - bits)) >> (32 - bits);

export class Xtensa {
  /** Physical address registers. */
  readonly phys: Uint32Array;
  windowBase = 0;
  windowStart = 1;
  pc = 0;
  ps = 0x1f;
  sar = 0;
  lbeg = 0;
  lend = 0;
  lcount = 0;
  br = 0;
  scompare1 = 0;
  litbase = 0;
  acclo = 0;
  acchi = 0;
  readonly m = new Uint32Array(4);
  readonly epc = new Uint32Array(8);
  readonly eps = new Uint32Array(8);
  readonly excsave = new Uint32Array(8);
  depc = 0;
  exccause = 0;
  excvaddr = 0;
  vecbase: number;
  cpenable = 0;
  intenable = 0;
  /** Latched interrupts: software (INTSET), timers, edge-triggered. */
  latched = 0;
  /** Level-triggered interrupt lines, as the SoC drives them. */
  lines = 0;
  readonly ccompare = new Uint32Array(3);
  threadptr = 0;
  fcr = 0;
  fsr = 0;
  readonly misc = new Uint32Array(4);
  atomctl = 0x28;
  memctl = 0;
  debugcause = 0;
  /** Special registers nothing reads meaningfully: stored and returned. */
  private readonly otherSr = new Map<number, number>();
  private readonly otherUr = new Map<number, number>();
  readonly fr = new Float32Array(16);
  private readonly fu = new Uint32Array(this.fr.buffer);
  /** Cycle count; CCOUNT is its low 32 bits plus an offset WSR CCOUNT sets. */
  cycles = 0;
  private ccountOffset = 0;
  /** In WAITI, until an interrupt is taken. */
  waiting = false;
  /** Set when firmware stops (BREAK with no debugger, an unhandled double exception...). */
  halted: string | null = null;
  /** Called with a ROM address the PC has reached; return true if handled. */
  rom: ((pc: number) => boolean) | null = null;
  romStart = 0;
  romEnd = 0;
  private nextPc = 0;
  private branched = false;

  constructor(
    readonly bus: XtensaBus,
    readonly config: XtensaConfig,
  ) {
    this.phys = new Uint32Array(config.nareg);
    this.vecbase = config.vecbase;
  }

  reset(pc: number): void {
    this.phys.fill(0);
    this.windowBase = 0;
    this.windowStart = 1;
    this.ps = 0x1f;
    this.pc = pc >>> 0;
    this.vecbase = this.config.vecbase;
    this.intenable = 0;
    this.latched = 0;
    this.cpenable = 0;
    this.lcount = 0;
    this.waiting = false;
    this.halted = null;
  }

  // ------------------------------------------------------------- registers

  /** a[i] in the current window. */
  a(i: number): number {
    return this.phys[(this.windowBase * 4 + i) & (this.config.nareg - 1)];
  }

  setA(i: number, v: number): void {
    this.phys[(this.windowBase * 4 + i) & (this.config.nareg - 1)] = v;
  }

  get ccount(): number {
    return (this.cycles + this.ccountOffset) >>> 0;
  }

  private get windows(): number {
    return this.config.nareg / 4;
  }

  private wsBit(wb: number): number {
    return 1 << (((wb % this.windows) + this.windows) % this.windows);
  }

  /** CALLINC from the return address a CALLn left in a0 of the callee. */
  private rotate(n: number): void {
    this.windowBase = (((this.windowBase + n) % this.windows) + this.windows) % this.windows;
  }

  /**
   * The window overflow check: before an instruction touches a[r], the frames
   * r reaches into (window units 1 .. r/4 above WindowBase) must be free.
   */
  private windowCheck(r: number): void {
    if (!this.config.windowed || r < 4 || !(this.ps & PS_WOE) || this.ps & PS_EXCM) return;
    const units = r >> 2;
    for (let k = 1; k <= units; k++) {
      if (!(this.windowStart & this.wsBit(this.windowBase + k))) continue;
      // Frame k up is live: spill it. Its size is the distance to the next live frame.
      let size = 1;
      while (size < 3 && !(this.windowStart & this.wsBit(this.windowBase + k + size))) size++;
      const owb = this.windowBase;
      this.rotate(k);
      this.ps = (this.ps & ~(0xf << PS_OWB_SHIFT)) | (owb << PS_OWB_SHIFT) | PS_EXCM;
      this.epc[1] = this.pc;
      throw new WindowExc(size === 1 ? 0x00 : size === 2 ? 0x80 : 0x100);
    }
  }

  // ------------------------------------------------------------ interrupts

  private currentLevel(): number {
    const il = this.ps & PS_INTLEVEL;
    return this.ps & PS_EXCM ? Math.max(il, this.config.excmLevel) : il;
  }

  get interrupt(): number {
    return (this.latched | this.lines) >>> 0;
  }

  /** The highest pending enabled interrupt level above the current one, or 0. */
  pendingLevel(): number {
    const pending = this.interrupt & this.intenable;
    if (!pending) return 0;
    let best = 0;
    for (let i = 0; i < 32; i++) if (pending & (1 << i)) best = Math.max(best, this.config.intLevel[i]);
    return best > this.currentLevel() ? best : 0;
  }

  private takeInterrupt(level: number): void {
    this.waiting = false;
    if (level === 1) {
      this.raiseGeneral(EXC.LEVEL1_INT, 0, this.pc);
      return;
    }
    this.epc[level] = this.pc;
    this.eps[level] = this.ps;
    this.ps = (this.ps & ~PS_INTLEVEL) | level | PS_EXCM;
    this.pc = (this.vecbase + this.config.vectors.level[level]) >>> 0;
  }

  private raiseGeneral(cause: number, vaddr: number, pc: number): void {
    if (this.ps & PS_EXCM) {
      this.depc = pc;
      this.exccause = cause;
      this.pc = (this.vecbase + this.config.vectors.double) >>> 0;
      return;
    }
    this.epc[1] = pc;
    this.exccause = cause;
    this.excvaddr = vaddr;
    const user = (this.ps & PS_UM) !== 0;
    this.ps |= PS_EXCM;
    this.pc = (this.vecbase + (user ? this.config.vectors.user : this.config.vectors.kernel)) >>> 0;
  }

  /** CCOMPARE match: latch the timer's interrupt. Called by the SoC as cycles pass. */
  checkTimers(): void {
    // Done inline in step() for speed; kept for SoCs that advance time while waiting.
  }

  private lastCcount = 0;

  private timers(): void {
    const now = this.ccount;
    const before = this.lastCcount;
    this.lastCcount = now;
    for (let i = 0; i < 3; i++) {
      const n = this.config.timerInt[i];
      if (n < 0) continue;
      const c = this.ccompare[i];
      // Crossed c between the previous count and this one (32-bit wrap aware).
      if (((c - before) >>> 0) > 0 && ((c - before) >>> 0) <= ((now - before) >>> 0)) this.latched |= 1 << n;
    }
  }

  /** Cycles until the next CCOMPARE match, for skipping time in WAITI. */
  cyclesToNextTimer(): number {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      if (this.config.timerInt[i] < 0) continue;
      if (!(this.intenable & (1 << this.config.timerInt[i]))) continue;
      const d = (this.ccompare[i] - this.ccount) >>> 0;
      best = Math.min(best, d === 0 ? 0x100000000 : d);
    }
    return best;
  }

  // ------------------------------------------------------------ execution

  /** Executes one instruction (or takes an interrupt). */
  step(): void {
    if (this.halted) return;
    const level = this.pendingLevel();
    if (level) this.takeInterrupt(level);
    if (this.waiting) {
      this.cycles++;
      this.timers();
      return;
    }
    const pc = this.pc;
    if (pc >= this.romStart && pc < this.romEnd && this.rom) {
      if (this.rom(pc)) {
        this.cycles += 4;
        this.timers();
        return;
      }
    }
    try {
      this.execute(pc);
    } catch (e) {
      if (e instanceof WindowExc) {
        this.pc = (this.vecbase + e.vector) >>> 0;
      } else if (e instanceof XtensaExc) {
        this.raiseGeneral(e.cause, e.vaddr, pc);
      } else throw e;
    }
    this.cycles++;
    this.timers();
  }

  /** Returns from a ROM function handled natively: a2 of the callee is the result. */
  romReturn(result?: number, resultHi?: number): void {
    const n = this.config.windowed ? (this.ps >>> PS_CALLINC_SHIFT) & 3 : 0;
    const base = n * 4;
    const ra = this.a(base);
    if (result !== undefined) this.setA(base + 2, result >>> 0);
    if (resultHi !== undefined) this.setA(base + 3, resultHi >>> 0);
    this.pc = this.config.windowed && n ? ((this.pc & 0xc0000000) | (ra & 0x3fffffff)) >>> 0 : ra >>> 0;
  }

  /** Argument i of a ROM function the PC has just entered (a2 + i of the callee). */
  romArg(i: number): number {
    const n = this.config.windowed ? (this.ps >>> PS_CALLINC_SHIFT) & 3 : 0;
    return this.a(n * 4 + 2 + i);
  }

  /** The callee's stack pointer (a1 of the caller: the window has not moved yet). */
  romSp(): number {
    return this.a(1);
  }

  private l32(a: number): number {
    return this.bus.read32((a & ~3) >>> 0) >>> 0;
  }

  private s32(a: number, v: number): void {
    this.bus.write32((a & ~3) >>> 0, v >>> 0);
  }

  private execute(pc: number): void {
    const bus = this.bus;
    const word = bus.fetch ? bus.fetch(pc) : bus.read8(pc) | (bus.read8(pc + 1) << 8) | (bus.read8(pc + 2) << 16);
    const b0 = word & 0xff;
    const op0 = b0 & 0xf;
    this.branched = false;
    if (op0 >= 8) {
      const b1 = (word >>> 8) & 0xff;
      this.nextPc = (pc + 2) >>> 0;
      this.narrow(op0, b0 >> 4, b1 & 0xf, b1 >> 4, pc);
    } else {
      const insn = word & 0xffffff;
      this.nextPc = (pc + 3) >>> 0;
      this.wide(insn, op0, pc);
    }
    let next = this.nextPc;
    if (!this.branched && next === this.lend && this.lcount !== 0 && !(this.ps & PS_EXCM)) {
      this.lcount = (this.lcount - 1) >>> 0;
      next = this.lbeg;
    }
    this.pc = next >>> 0;
  }

  private jump(target: number): void {
    this.nextPc = target >>> 0;
    this.branched = true;
  }

  private checkFpu(): void {
    if (!(this.cpenable & 1)) throw new XtensaExc(EXC.COPROCESSOR0_DISABLED);
  }

  private narrow(op0: number, t: number, s: number, r: number, pc: number): void {
    switch (op0) {
      case 8: // L32I.N at, as, r*4
        this.windowCheck(Math.max(s, t));
        this.setA(t, this.l32(this.a(s) + r * 4));
        return;
      case 9: // S32I.N
        this.windowCheck(Math.max(s, t));
        this.s32(this.a(s) + r * 4, this.a(t));
        return;
      case 10: // ADD.N
        this.windowCheck(Math.max(r, s, t));
        this.setA(r, (this.a(s) + this.a(t)) >>> 0);
        return;
      case 11: // ADDI.N
        this.windowCheck(Math.max(r, s));
        this.setA(r, (this.a(s) + (t === 0 ? -1 : t)) >>> 0);
        return;
      case 12: {
        if (!(t & 8)) {
          // MOVI.N as, imm7: -32..95
          this.windowCheck(s);
          let imm = ((t & 7) << 4) | r;
          if (imm >= 96) imm -= 128;
          this.setA(s, imm >>> 0);
          return;
        }
        // BEQZ.N / BNEZ.N as, pc + 4 + imm6
        this.windowCheck(s);
        const imm6 = ((t & 3) << 4) | r;
        const z = this.a(s) === 0;
        if ((t & 4) === 0 ? z : !z) this.jump(pc + 4 + imm6);
        return;
      }
      case 13:
        if (r === 0) {
          // MOV.N at, as
          this.windowCheck(Math.max(s, t));
          this.setA(t, this.a(s));
          return;
        }
        if (r === 15) {
          switch (t) {
            case 0: // RET.N
              this.jump(this.a(0));
              return;
            case 1: // RETW.N
              this.retw(pc);
              return;
            case 2: // BREAK.N
              this.breakpoint(pc, s, 0);
              return;
            case 3: // NOP.N
              return;
            case 6: // ILL.N
              throw new XtensaExc(EXC.ILLEGAL);
          }
        }
        throw new XtensaExc(EXC.ILLEGAL);
      default:
        throw new XtensaExc(EXC.ILLEGAL);
    }
  }

  private breakpoint(pc: number, s: number, t: number): void {
    // With no debugger attached, a BREAK is an unrecoverable stop: IDF reaches
    // one from abort(). Report it rather than spin.
    this.halted = `BREAK ${s},${t} at 0x${pc.toString(16)}`;
  }

  private retw(pc: number): void {
    const a0 = this.a(0);
    const n = a0 >>> 30;
    const ret = ((pc & 0xc0000000) | (a0 & 0x3fffffff)) >>> 0;
    if (!this.config.windowed || n === 0) throw new XtensaExc(EXC.ILLEGAL);
    const owb = this.windowBase;
    this.rotate(-n);
    if (this.windowStart & this.wsBit(this.windowBase)) {
      this.windowStart &= ~this.wsBit(owb);
      this.jump(ret);
      return;
    }
    // Window underflow: the caller's frame was spilled; its handler reloads it
    // and RFWU re-executes this RETW.
    this.ps = (this.ps & ~(0xf << PS_OWB_SHIFT)) | (owb << PS_OWB_SHIFT) | PS_EXCM;
    this.epc[1] = pc;
    throw new WindowExc(n === 1 ? 0x40 : n === 2 ? 0xc0 : 0x140);
  }

  private call(n: number, target: number, pc: number): void {
    if (n === 0) {
      this.setA(0, (pc + 3) >>> 0);
    } else {
      this.windowCheck(n * 4 + 3);
      this.setA(n * 4, ((n << 30) | ((pc + 3) & 0x3fffffff)) >>> 0);
      this.ps = (this.ps & ~(3 << PS_CALLINC_SHIFT)) | (n << PS_CALLINC_SHIFT);
    }
    this.jump(target);
  }

  private wide(insn: number, op0: number, pc: number): void {
    const t = (insn >> 4) & 0xf;
    const s = (insn >> 8) & 0xf;
    const r = (insn >> 12) & 0xf;
    const op1 = (insn >> 16) & 0xf;
    const op2 = (insn >> 20) & 0xf;
    switch (op0) {
      case 0:
        return this.qrst(insn, t, s, r, op1, op2, pc);
      case 1: {
        // L32R at, label: always backwards from the next aligned word.
        this.windowCheck(t);
        const imm16 = (insn >>> 8) & 0xffff;
        const addr = this.litbase & 1
          ? ((this.litbase & 0xfffff000) + ((0xfffc0000 | (imm16 << 2)) >>> 0)) >>> 0
          : (((pc + 3) & ~3) + ((0xfffc0000 | (imm16 << 2)) | 0)) >>> 0;
        this.setA(t, this.l32(addr));
        return;
      }
      case 2:
        return this.lsai(insn, t, s, r, pc);
      case 3:
        return this.lsci(insn, t, s, r);
      case 4:
        return this.mac16(insn, t, s, r, op1, op2);
      case 5: {
        const n = (insn >> 4) & 3;
        const off = sext(insn >>> 6, 18);
        this.call(n, ((pc & ~3) + (off << 2) + 4) >>> 0, pc);
        return;
      }
      case 6:
        return this.si(insn, t, s, r, pc);
      case 7:
        return this.branch(insn, t, s, r, pc);
      default:
        throw new XtensaExc(EXC.ILLEGAL);
    }
  }

  // ------------------------------------------------------------ QRST

  private qrst(insn: number, t: number, s: number, r: number, op1: number, op2: number, pc: number): void {
    switch (op1) {
      case 0:
        return this.rst0(t, s, r, op2, pc);
      case 1:
        return this.rst1(insn, t, s, r, op2);
      case 2:
        return this.rst2(t, s, r, op2);
      case 3:
        return this.rst3(t, s, r, op2, insn);
      case 4:
      case 5: {
        // EXTUI ar, at, shift, maskbits
        this.windowCheck(Math.max(r, t));
        const shift = ((op1 & 1) << 4) | s;
        const bits = op2 + 1;
        const v = this.a(t) >>> shift;
        this.setA(r, (bits >= 32 ? v : v & ((1 << bits) - 1)) >>> 0);
        return;
      }
      case 8: {
        // LSCX: LSX, LSXU, SSX, SSXU
        this.checkFpu();
        this.windowCheck(Math.max(s, t));
        const addr = (this.a(s) + this.a(t)) >>> 0;
        switch (op2) {
          case 0: this.fu[r] = this.l32(addr); return;
          case 1: this.fu[r] = this.l32(addr); this.setA(s, addr); return;
          case 4: this.s32(addr, this.fu[r]); return;
          case 5: this.s32(addr, this.fu[r]); this.setA(s, addr); return;
        }
        throw new XtensaExc(EXC.ILLEGAL);
      }
      case 9: {
        // L32E / S32E at, as, imm (negative offsets): window handlers only.
        this.windowCheck(Math.max(s, t));
        const off = ((r << 2) - 64) | 0;
        const addr = (this.a(s) + off) >>> 0;
        if (op2 === 0) this.setA(t, this.l32(addr));
        else if (op2 === 4) this.s32(addr, this.a(t));
        else throw new XtensaExc(EXC.ILLEGAL);
        return;
      }
      case 10:
        return this.fp0(t, s, r, op2);
      case 11:
        return this.fp1(t, s, r, op2);
      default:
        throw new XtensaExc(EXC.ILLEGAL);
    }
  }

  private rst0(t: number, s: number, r: number, op2: number, pc: number): void {
    switch (op2) {
      case 0:
        return this.st0(t, s, r, pc);
      case 1: this.windowCheck(Math.max(r, s, t)); this.setA(r, this.a(s) & this.a(t)); return; // AND
      case 2: this.windowCheck(Math.max(r, s, t)); this.setA(r, this.a(s) | this.a(t)); return; // OR
      case 3: this.windowCheck(Math.max(r, s, t)); this.setA(r, this.a(s) ^ this.a(t)); return; // XOR
      case 4:
        return this.st1(t, s, r);
      case 5:
        // TLB ops (IITLB, PITLB, WITLB, ...): no MMU to manage here.
        if (r === 3 || r === 11 || r === 5 || r === 13) this.windowCheck(t);
        return;
      case 6:
        this.windowCheck(Math.max(r, t));
        if (s === 0) this.setA(r, (-this.a(t)) >>> 0); // NEG
        else if (s === 1) this.setA(r, Math.abs(this.a(t) | 0) >>> 0); // ABS
        else throw new XtensaExc(EXC.ILLEGAL);
        return;
      case 8: this.windowCheck(Math.max(r, s, t)); this.setA(r, (this.a(s) + this.a(t)) >>> 0); return; // ADD
      case 9: this.windowCheck(Math.max(r, s, t)); this.setA(r, ((this.a(s) << 1) + this.a(t)) >>> 0); return; // ADDX2
      case 10: this.windowCheck(Math.max(r, s, t)); this.setA(r, ((this.a(s) << 2) + this.a(t)) >>> 0); return; // ADDX4
      case 11: this.windowCheck(Math.max(r, s, t)); this.setA(r, ((this.a(s) << 3) + this.a(t)) >>> 0); return; // ADDX8
      case 12: this.windowCheck(Math.max(r, s, t)); this.setA(r, (this.a(s) - this.a(t)) >>> 0); return; // SUB
      case 13: this.windowCheck(Math.max(r, s, t)); this.setA(r, ((this.a(s) << 1) - this.a(t)) >>> 0); return; // SUBX2
      case 14: this.windowCheck(Math.max(r, s, t)); this.setA(r, ((this.a(s) << 2) - this.a(t)) >>> 0); return; // SUBX4
      case 15: this.windowCheck(Math.max(r, s, t)); this.setA(r, ((this.a(s) << 3) - this.a(t)) >>> 0); return; // SUBX8
      default:
        throw new XtensaExc(EXC.ILLEGAL);
    }
  }

  private st0(t: number, s: number, r: number, pc: number): void {
    switch (r) {
      case 0: {
        const m = t >> 2;
        const n = t & 3;
        if (m === 2) {
          if (n === 0) return this.jump(this.a(0)); // RET
          if (n === 1) return this.retw(pc); // RETW
          if (n === 2) {
            this.windowCheck(s);
            return this.jump(this.a(s)); // JX
          }
        }
        if (m === 3) {
          // CALLXn as
          this.windowCheck(s);
          const target = this.a(s);
          this.call(n, target, pc);
          return;
        }
        throw new XtensaExc(EXC.ILLEGAL);
      }
      case 1: {
        // MOVSP at, as
        this.windowCheck(Math.max(s, t));
        if (this.config.windowed) {
          const wb = this.windowBase;
          const any = this.windowStart & (this.wsBit(wb - 3) | this.wsBit(wb - 2) | this.wsBit(wb - 1));
          if (!any) throw new XtensaExc(EXC.ALLOCA);
        }
        this.setA(t, this.a(s));
        return;
      }
      case 2:
        return; // ISYNC, RSYNC, ESYNC, DSYNC, EXCW, MEMW, EXTW, NOP
      case 3:
        if (t === 0) {
          switch (s) {
            case 0: // RFE
              this.ps &= ~PS_EXCM;
              return this.jump(this.epc[1]);
            case 1: // RFUE
              this.ps &= ~PS_EXCM;
              return this.jump(this.epc[1]);
            case 2: // RFDE
              return this.jump(this.depc);
            case 4: // RFWO
              this.windowStart &= ~this.wsBit(this.windowBase);
              this.windowBase = (this.ps >> PS_OWB_SHIFT) & 0xf;
              this.ps &= ~PS_EXCM;
              return this.jump(this.epc[1]);
            case 5: // RFWU
              this.windowStart |= this.wsBit(this.windowBase);
              this.windowBase = (this.ps >> PS_OWB_SHIFT) & 0xf;
              this.ps &= ~PS_EXCM;
              return this.jump(this.epc[1]);
          }
        } else if (t === 1) {
          // RFI level
          const level = s;
          this.ps = this.eps[level];
          return this.jump(this.epc[level]);
        }
        throw new XtensaExc(EXC.ILLEGAL);
      case 4:
        return this.breakpoint(pc, s, t);
      case 5:
        if (s === 0) throw new XtensaExc(EXC.SYSCALL);
        return; // SIMCALL: nothing to call
      case 6: {
        // RSIL at, level
        this.windowCheck(t);
        const old = this.ps;
        this.ps = (this.ps & ~PS_INTLEVEL) | s;
        this.setA(t, old);
        return;
      }
      case 7:
        // WAITI level
        this.ps = (this.ps & ~PS_INTLEVEL) | s;
        this.waiting = true;
        return;
      case 8:
      case 9:
      case 10:
      case 11: {
        // ANY4, ALL4, ANY8, ALL8 bt, bs
        const width = r < 10 ? 4 : 8;
        const bits = (this.br >> s) & ((1 << width) - 1);
        const all = (1 << width) - 1;
        const v = r === 8 || r === 10 ? bits !== 0 : bits === all;
        this.br = v ? this.br | (1 << t) : this.br & ~(1 << t);
        return;
      }
      default:
        throw new XtensaExc(EXC.ILLEGAL);
    }
  }

  private st1(t: number, s: number, r: number): void {
    switch (r) {
      case 0: this.windowCheck(s); this.sar = this.a(s) & 31; return; // SSR
      case 1: this.windowCheck(s); this.sar = 32 - (this.a(s) & 31); return; // SSL
      case 2: this.windowCheck(s); this.sar = (this.a(s) & 3) * 8; return; // SSA8L
      case 3: this.windowCheck(s); this.sar = 32 - (this.a(s) & 3) * 8; return; // SSA8B
      case 4: this.sar = s | ((t & 1) << 4); return; // SSAI
      case 6: this.windowCheck(Math.max(s, t)); this.setA(t, 0); return; // RER (external registers: none)
      case 7: this.windowCheck(Math.max(s, t)); return; // WER
      case 8: // ROTW
        if (this.config.windowed) this.rotate(sext(t, 4));
        return;
      case 14: {
        // NSA at, as
        this.windowCheck(Math.max(s, t));
        const v = this.a(s) | 0;
        const x = v < 0 ? ~v : v;
        this.setA(t, x === 0 ? 31 : Math.clz32(x) - 1);
        return;
      }
      case 15:
        // NSAU at, as
        this.windowCheck(Math.max(s, t));
        this.setA(t, Math.clz32(this.a(s)));
        return;
      default:
        throw new XtensaExc(EXC.ILLEGAL);
    }
  }

  private rst1(insn: number, t: number, s: number, r: number, op2: number): void {
    switch (op2) {
      case 0:
      case 1: {
        // SLLI ar, as, 32 - sa
        this.windowCheck(Math.max(r, s));
        const sa = 32 - (((op2 & 1) << 4) | t);
        this.setA(r, sa >= 32 ? 0 : (this.a(s) << sa) >>> 0);
        return;
      }
      case 2:
      case 3: {
        // SRAI ar, at, sa
        this.windowCheck(Math.max(r, t));
        const sa = ((op2 & 1) << 4) | s;
        this.setA(r, (this.a(t) | 0) >> sa >>> 0);
        return;
      }
      case 4:
        // SRLI ar, at, sa
        this.windowCheck(Math.max(r, t));
        this.setA(r, this.a(t) >>> s);
        return;
      case 6: {
        // XSR at, sr
        this.windowCheck(t);
        const sr = (insn >> 8) & 0xff;
        const old = this.rsr(sr);
        this.wsr(sr, this.a(t));
        this.setA(t, old);
        return;
      }
      case 8: {
        // SRC ar, as, at: funnel shift right of as:at by SAR
        this.windowCheck(Math.max(r, s, t));
        const hi = BigInt(this.a(s));
        const lo = BigInt(this.a(t));
        this.setA(r, Number((((hi << 32n) | lo) >> BigInt(this.sar)) & 0xffffffffn));
        return;
      }
      case 9:
        // SRL ar, at
        this.windowCheck(Math.max(r, t));
        this.setA(r, this.sar >= 32 ? 0 : this.a(t) >>> this.sar);
        return;
      case 10: {
        // SLL ar, as: shift left by 32 - SAR
        this.windowCheck(Math.max(r, s));
        const sa = 32 - this.sar;
        this.setA(r, sa >= 32 ? 0 : (this.a(s) << sa) >>> 0);
        return;
      }
      case 11:
        // SRA ar, at
        this.windowCheck(Math.max(r, t));
        this.setA(r, ((this.a(t) | 0) >> Math.min(31, this.sar)) >>> 0);
        return;
      case 12:
        // MUL16U
        this.windowCheck(Math.max(r, s, t));
        this.setA(r, Math.imul(this.a(s) & 0xffff, this.a(t) & 0xffff) >>> 0);
        return;
      case 13:
        // MUL16S
        this.windowCheck(Math.max(r, s, t));
        this.setA(r, Math.imul(sext(this.a(s), 16), sext(this.a(t), 16)) >>> 0);
        return;
      case 15:
        // IMP: LICT/SICT/... and RFDO/RFDD (debug): nothing to do.
        if (r === 14) return; // RFDD/RFDO
        return;
      default:
        throw new XtensaExc(EXC.ILLEGAL);
    }
  }

  private rst2(t: number, s: number, r: number, op2: number): void {
    const bool = (v: boolean) => (this.br = v ? this.br | (1 << r) : this.br & ~(1 << r));
    const bs = (this.br >> s) & 1;
    const bt = (this.br >> t) & 1;
    switch (op2) {
      case 0: bool(!!(bs & bt)); return; // ANDB
      case 1: bool(!!(bs & (bt ^ 1))); return; // ANDBC
      case 2: bool(!!(bs | bt)); return; // ORB
      case 3: bool(!!(bs | (bt ^ 1))); return; // ORBC
      case 4: bool(!!(bs ^ bt)); return; // XORB
    }
    this.windowCheck(Math.max(r, s, t));
    const a = this.a(s);
    const b = this.a(t);
    switch (op2) {
      case 8: this.setA(r, Math.imul(a, b) >>> 0); return; // MULL
      case 10: this.setA(r, Number((BigInt(a) * BigInt(b)) >> 32n)); return; // MULUH
      case 11: this.setA(r, Number(((BigInt(a | 0) * BigInt(b | 0)) >> 32n) & 0xffffffffn)); return; // MULSH
      case 12: // QUOU
        if (b === 0) throw new XtensaExc(EXC.DIVIDE_BY_ZERO);
        this.setA(r, Math.floor(a / b) >>> 0);
        return;
      case 13: // QUOS
        if (b === 0) throw new XtensaExc(EXC.DIVIDE_BY_ZERO);
        this.setA(r, (a | 0) === -0x80000000 && (b | 0) === -1 ? 0x80000000 : Math.trunc((a | 0) / (b | 0)) >>> 0);
        return;
      case 14: // REMU
        if (b === 0) throw new XtensaExc(EXC.DIVIDE_BY_ZERO);
        this.setA(r, (a % b) >>> 0);
        return;
      case 15: // REMS
        if (b === 0) throw new XtensaExc(EXC.DIVIDE_BY_ZERO);
        this.setA(r, (a | 0) === -0x80000000 && (b | 0) === -1 ? 0 : ((a | 0) % (b | 0)) >>> 0);
        return;
      default:
        throw new XtensaExc(EXC.ILLEGAL);
    }
  }

  private rst3(t: number, s: number, r: number, op2: number, insn: number): void {
    switch (op2) {
      case 0: {
        // RSR at, sr
        this.windowCheck(t);
        this.setA(t, this.rsr((insn >> 8) & 0xff));
        return;
      }
      case 1:
        // WSR at, sr
        this.windowCheck(t);
        this.wsr((insn >> 8) & 0xff, this.a(t));
        return;
      case 2: {
        // SEXT ar, as, t+7
        this.windowCheck(Math.max(r, s));
        this.setA(r, sext(this.a(s), t + 8) >>> 0);
        return;
      }
      case 3: {
        // CLAMPS ar, as, t+7
        this.windowCheck(Math.max(r, s));
        const v = this.a(s) | 0;
        const lim = 2 ** (t + 7);
        this.setA(r, Math.max(-lim, Math.min(lim - 1, v)) >>> 0);
        return;
      }
      case 4: this.windowCheck(Math.max(r, s, t)); this.setA(r, Math.min(this.a(s) | 0, this.a(t) | 0) >>> 0); return; // MIN
      case 5: this.windowCheck(Math.max(r, s, t)); this.setA(r, Math.max(this.a(s) | 0, this.a(t) | 0) >>> 0); return; // MAX
      case 6: this.windowCheck(Math.max(r, s, t)); this.setA(r, Math.min(this.a(s), this.a(t))); return; // MINU
      case 7: this.windowCheck(Math.max(r, s, t)); this.setA(r, Math.max(this.a(s), this.a(t))); return; // MAXU
      case 8: this.windowCheck(Math.max(r, s, t)); if (this.a(t) === 0) this.setA(r, this.a(s)); return; // MOVEQZ
      case 9: this.windowCheck(Math.max(r, s, t)); if (this.a(t) !== 0) this.setA(r, this.a(s)); return; // MOVNEZ
      case 10: this.windowCheck(Math.max(r, s, t)); if ((this.a(t) | 0) < 0) this.setA(r, this.a(s)); return; // MOVLTZ
      case 11: this.windowCheck(Math.max(r, s, t)); if ((this.a(t) | 0) >= 0) this.setA(r, this.a(s)); return; // MOVGEZ
      case 12: this.windowCheck(Math.max(r, s)); if (!((this.br >> t) & 1)) this.setA(r, this.a(s)); return; // MOVF
      case 13: this.windowCheck(Math.max(r, s)); if ((this.br >> t) & 1) this.setA(r, this.a(s)); return; // MOVT
      case 14: {
        // RUR ar, ur
        this.windowCheck(r);
        const ur = (s << 4) | t;
        this.setA(r, this.rur(ur));
        return;
      }
      case 15: {
        // WUR at, ur
        this.windowCheck(t);
        const ur = (r << 4) | s;
        this.wur(ur, this.a(t));
        return;
      }
    }
  }

  // ------------------------------------------------------- special registers

  rsr(sr: number): number {
    switch (sr) {
      case 0: return this.lbeg;
      case 1: return this.lend;
      case 2: return this.lcount;
      case 3: return this.sar;
      case 4: return this.br;
      case 5: return this.litbase;
      case 12: return this.scompare1;
      case 16: return this.acclo;
      case 17: return this.acchi;
      case 32: case 33: case 34: case 35: return this.m[sr - 32];
      case 72: return this.windowBase;
      case 73: return this.windowStart;
      case 97: return this.memctl;
      case 99: return this.atomctl;
      case 192: return this.depc;
      case 224: return this.cpenable;
      case 226: return this.interrupt;
      case 228: return this.intenable;
      case 230: return this.ps;
      case 231: return this.vecbase;
      case 232: return this.exccause;
      case 233: return this.debugcause;
      case 234: return this.ccount;
      case 235: return this.config.prid;
      case 238: return this.excvaddr;
      case 240: case 241: case 242: return this.ccompare[sr - 240];
      case 244: case 245: case 246: case 247: return this.misc[sr - 244];
    }
    if (sr >= 177 && sr <= 183) return this.epc[sr - 176];
    if (sr >= 194 && sr <= 199) return this.eps[sr - 192];
    if (sr >= 209 && sr <= 215) return this.excsave[sr - 208];
    return this.otherSr.get(sr) ?? 0;
  }

  wsr(sr: number, v: number): void {
    v >>>= 0;
    switch (sr) {
      case 0: this.lbeg = v; return;
      case 1: this.lend = v; return;
      case 2: this.lcount = v; return;
      case 3: this.sar = v & 0x3f; return;
      case 4: this.br = v & 0xffff; return;
      case 5: this.litbase = v; return;
      case 12: this.scompare1 = v; return;
      case 16: this.acclo = v; return;
      case 17: this.acchi = v & 0xff; return;
      case 32: case 33: case 34: case 35: this.m[sr - 32] = v; return;
      case 72: this.windowBase = v % this.windows; return;
      case 73: this.windowStart = v & ((1 << this.windows) - 1); return;
      case 97: this.memctl = v; return;
      case 99: this.atomctl = v; return;
      case 192: this.depc = v; return;
      case 224: this.cpenable = v & 0xff; return;
      case 226: this.latched |= v; return; // INTSET
      case 227: this.latched &= ~v; return; // INTCLEAR
      case 228: this.intenable = v; return;
      case 230: this.ps = v; return;
      case 231: this.vecbase = v; return;
      case 232: this.exccause = v; return;
      case 233: this.debugcause = v; return;
      case 234: this.ccountOffset = (v - this.cycles) | 0; this.lastCcount = v; return;
      case 238: this.excvaddr = v; return;
      case 240: case 241: case 242: {
        const i = sr - 240;
        this.ccompare[i] = v;
        // Writing CCOMPARE clears its pending timer interrupt.
        const n = this.config.timerInt[i];
        if (n >= 0) this.latched &= ~(1 << n);
        return;
      }
      case 244: case 245: case 246: case 247: this.misc[sr - 244] = v; return;
    }
    if (sr >= 177 && sr <= 183) { this.epc[sr - 176] = v; return; }
    if (sr >= 194 && sr <= 199) { this.eps[sr - 192] = v; return; }
    if (sr >= 209 && sr <= 215) { this.excsave[sr - 208] = v; return; }
    this.otherSr.set(sr, v);
  }

  rur(ur: number): number {
    if (ur === 231) return this.threadptr;
    if (ur === 232) return this.fcr;
    if (ur === 233) return this.fsr;
    return this.otherUr.get(ur) ?? 0;
  }

  wur(ur: number, v: number): void {
    if (ur === 231) this.threadptr = v >>> 0;
    else if (ur === 232) this.fcr = v & 0xfff;
    else if (ur === 233) this.fsr = v & 0xfff;
    else this.otherUr.set(ur, v >>> 0);
  }

  // --------------------------------------------------------- loads/stores

  private lsai(insn: number, t: number, s: number, r: number, pc: number): void {
    const imm8 = (insn >>> 16) & 0xff;
    switch (r) {
      case 0: this.windowCheck(Math.max(s, t)); this.setA(t, this.bus.read8((this.a(s) + imm8) >>> 0) & 0xff); return; // L8UI
      case 1: this.windowCheck(Math.max(s, t)); this.setA(t, this.bus.read16(((this.a(s) + (imm8 << 1)) & ~1) >>> 0) & 0xffff); return; // L16UI
      case 2: this.windowCheck(Math.max(s, t)); this.setA(t, this.l32(this.a(s) + (imm8 << 2))); return; // L32I
      case 4: this.windowCheck(Math.max(s, t)); this.bus.write8((this.a(s) + imm8) >>> 0, this.a(t) & 0xff); return; // S8I
      case 5: this.windowCheck(Math.max(s, t)); this.bus.write16(((this.a(s) + (imm8 << 1)) & ~1) >>> 0, this.a(t) & 0xffff); return; // S16I
      case 6: this.windowCheck(Math.max(s, t)); this.s32(this.a(s) + (imm8 << 2), this.a(t)); return; // S32I
      case 7:
        // CACHE: DPFR, DHWB, DHI, III, ... and the instruction prefetch hints. No caches here.
        if (t === 0 || t === 1 || t === 2 || t === 3 || t === 4 || t === 5 || t === 6 || t === 7 || t === 12 || t === 13 || t === 14 || t === 15) this.windowCheck(s);
        return;
      case 9: this.windowCheck(Math.max(s, t)); this.setA(t, sext(this.bus.read16(((this.a(s) + (imm8 << 1)) & ~1) >>> 0), 16) >>> 0); return; // L16SI
      case 10: this.windowCheck(t); this.setA(t, sext((s << 8) | imm8, 12) >>> 0); return; // MOVI
      case 11: this.windowCheck(Math.max(s, t)); this.setA(t, this.l32(this.a(s) + (imm8 << 2))); return; // L32AI
      case 12: this.windowCheck(Math.max(s, t)); this.setA(t, (this.a(s) + sext(imm8, 8)) >>> 0); return; // ADDI
      case 13: this.windowCheck(Math.max(s, t)); this.setA(t, (this.a(s) + (sext(imm8, 8) << 8)) >>> 0); return; // ADDMI
      case 14: {
        // S32C1I at, as, imm: store at if memory equals SCOMPARE1; at gets the old value
        this.windowCheck(Math.max(s, t));
        const addr = (this.a(s) + (imm8 << 2)) >>> 0;
        const old = this.l32(addr);
        if (old === this.scompare1) this.s32(addr, this.a(t));
        this.setA(t, old);
        return;
      }
      case 15: this.windowCheck(Math.max(s, t)); this.s32(this.a(s) + (imm8 << 2), this.a(t)); return; // S32RI
    }
    void pc;
    throw new XtensaExc(EXC.ILLEGAL);
  }

  private lsci(insn: number, t: number, s: number, r: number): void {
    this.checkFpu();
    this.windowCheck(s);
    const imm8 = (insn >>> 16) & 0xff;
    const addr = (this.a(s) + (imm8 << 2)) >>> 0;
    switch (r) {
      case 0: this.fu[t] = this.l32(addr); return; // LSI
      case 4: this.s32(addr, this.fu[t]); return; // SSI
      case 8: this.fu[t] = this.l32(addr); this.setA(s, addr); return; // LSIU
      case 12: this.s32(addr, this.fu[t]); this.setA(s, addr); return; // SSIU
    }
    throw new XtensaExc(EXC.ILLEGAL);
  }

  /** MAC16: the accumulator forms the toolchain's libraries use; the rest are illegal. */
  private mac16(insn: number, t: number, s: number, r: number, op1: number, op2: number): void {
    void insn;
    // MUL.AA.* / MULA.AA.* (op2 = 7, 8; op1 = half selection) — and LDINC/LDDEC.
    if (op2 === 0 && op1 === 0) {
      // LDINC mw, as
      this.windowCheck(s);
      const addr = (this.a(s) + 4) >>> 0;
      this.m[(r >> 2) & 3] = this.l32(addr);
      this.setA(s, addr);
      return;
    }
    if (op2 === 1 && op1 === 0) {
      // LDDEC mw, as
      this.windowCheck(s);
      const addr = (this.a(s) - 4) >>> 0;
      this.m[(r >> 2) & 3] = this.l32(addr);
      this.setA(s, addr);
      return;
    }
    if (op2 === 7) {
      // UMUL.AA.* / MUL.AA.*: acc = as.half * at.half
      this.windowCheck(Math.max(s, t));
      const hs = op1 & 2 ? this.a(s) >>> 16 : this.a(s) & 0xffff;
      const ht = op1 & 1 ? this.a(t) >>> 16 : this.a(t) & 0xffff;
      this.setAcc(BigInt(sext(hs, 16)) * BigInt(sext(ht, 16)));
      return;
    }
    if (op2 === 8) {
      // MULA.AA.*: acc += as.half * at.half
      this.windowCheck(Math.max(s, t));
      const hs = op1 & 2 ? this.a(s) >>> 16 : this.a(s) & 0xffff;
      const ht = op1 & 1 ? this.a(t) >>> 16 : this.a(t) & 0xffff;
      this.setAcc(this.acc() + BigInt(sext(hs, 16)) * BigInt(sext(ht, 16)));
      return;
    }
    throw new XtensaExc(EXC.ILLEGAL);
  }

  private acc(): bigint {
    const v = (BigInt(this.acchi & 0xff) << 32n) | BigInt(this.acclo >>> 0);
    return v & 0x8000000000n ? v - 0x10000000000n : v;
  }

  private setAcc(v: bigint): void {
    const m = v & 0xffffffffffn;
    this.acclo = Number(m & 0xffffffffn);
    this.acchi = Number(m >> 32n);
  }

  // ---------------------------------------------------------------- SI

  private si(insn: number, t: number, s: number, r: number, pc: number): void {
    const n = (insn >> 4) & 3;
    const m = (insn >> 6) & 3;
    switch (n) {
      case 0: {
        // J
        const off = sext(insn >>> 6, 18);
        this.jump((pc + 4 + off) >>> 0);
        return;
      }
      case 1: {
        // BZ: BEQZ, BNEZ, BLTZ, BGEZ as, pc + 4 + imm12
        this.windowCheck(s);
        const imm12 = sext(insn >>> 12, 12);
        const v = this.a(s) | 0;
        const take = m === 0 ? v === 0 : m === 1 ? v !== 0 : m === 2 ? v < 0 : v >= 0;
        if (take) this.jump((pc + 4 + imm12) >>> 0);
        return;
      }
      case 2: {
        // BI0: BEQI, BNEI, BLTI, BGEI as, b4const(r), pc + 4 + imm8
        this.windowCheck(s);
        const imm8 = sext(insn >>> 16, 8);
        const c = B4CONST[r];
        const v = this.a(s) | 0;
        const take = m === 0 ? v === c : m === 1 ? v !== c : m === 2 ? v < c : v >= c;
        if (take) this.jump((pc + 4 + imm8) >>> 0);
        return;
      }
      case 3: {
        if (m === 0) {
          // ENTRY as, imm12 * 8
          const imm = ((insn >>> 12) & 0xfff) << 3;
          if (!this.config.windowed) throw new XtensaExc(EXC.ILLEGAL);
          const callinc = (this.ps >>> PS_CALLINC_SHIFT) & 3;
          this.windowCheck(Math.max(s, callinc * 4 + s));
          const sp = (this.a(s) - imm) >>> 0;
          this.setA(callinc * 4 + s, sp);
          this.rotate(callinc);
          this.windowStart |= this.wsBit(this.windowBase);
          return;
        }
        if (m === 1) {
          const imm8 = (insn >>> 16) & 0xff;
          switch (r) {
            case 0: // BF bs
              if (!((this.br >> s) & 1)) this.jump((pc + 4 + sext(imm8, 8)) >>> 0);
              return;
            case 1: // BT bs
              if ((this.br >> s) & 1) this.jump((pc + 4 + sext(imm8, 8)) >>> 0);
              return;
            case 8:
            case 9:
            case 10: {
              // LOOP, LOOPNEZ, LOOPGTZ as, label
              this.windowCheck(s);
              const v = this.a(s);
              const end = (pc + 4 + imm8) >>> 0;
              this.lbeg = (pc + 3) >>> 0;
              this.lend = end;
              this.lcount = (v - 1) >>> 0;
              if ((r === 9 && v === 0) || (r === 10 && (v | 0) <= 0)) this.jump(end);
              return;
            }
          }
          throw new XtensaExc(EXC.ILLEGAL);
        }
        // BLTUI / BGEUI as, b4constu(r)
        this.windowCheck(s);
        const imm8 = sext(insn >>> 16, 8);
        const c = B4CONSTU[r];
        const v = this.a(s);
        const take = m === 2 ? v < c : v >= c;
        if (take) this.jump((pc + 4 + imm8) >>> 0);
        return;
      }
    }
  }

  private branch(insn: number, t: number, s: number, r: number, pc: number): void {
    this.windowCheck(Math.max(s, r === 6 || r === 7 || r === 14 || r === 15 ? s : t));
    const imm8 = sext(insn >>> 16, 8);
    const a = this.a(s);
    const b = this.a(t);
    let take: boolean;
    switch (r) {
      case 0: take = (a & b) === 0; break; // BNONE
      case 1: take = a === b; break; // BEQ
      case 2: take = (a | 0) < (b | 0); break; // BLT
      case 3: take = a < b; break; // BLTU
      case 4: take = (~a & b) === 0; break; // BALL
      case 5: take = ((a >>> (b & 31)) & 1) === 0; break; // BBC
      case 6:
      case 7: take = ((a >>> (((r & 1) << 4) | t)) & 1) === 0; break; // BBCI
      case 8: take = (a & b) !== 0; break; // BANY
      case 9: take = a !== b; break; // BNE
      case 10: take = (a | 0) >= (b | 0); break; // BGE
      case 11: take = a >= b; break; // BGEU
      case 12: take = (~a & b) !== 0; break; // BNALL
      case 13: take = ((a >>> (b & 31)) & 1) !== 0; break; // BBS
      default: take = ((a >>> (((r & 1) << 4) | t)) & 1) !== 0; // BBSI
    }
    if (take) this.jump((pc + 4 + imm8) >>> 0);
  }

  // --------------------------------------------------------------- FPU

  private f(i: number): number {
    return this.fr[i];
  }

  private setF(i: number, v: number): void {
    this.fr[i] = v;
  }

  /** Float to integer with FCR's rounding not applied: the instruction names its own rounding. */
  private toInt(v: number, scale: number, mode: 'round' | 'trunc' | 'floor' | 'ceil', unsigned: boolean): number {
    const x = v * 2 ** scale;
    if (Number.isNaN(x)) return unsigned ? 0xffffffff : 0x7fffffff;
    let y: number;
    switch (mode) {
      case 'round': {
        // Round half to even.
        const fl = Math.floor(x);
        const diff = x - fl;
        y = diff > 0.5 ? fl + 1 : diff < 0.5 ? fl : fl % 2 === 0 ? fl : fl + 1;
        break;
      }
      case 'trunc': y = Math.trunc(x); break;
      case 'floor': y = Math.floor(x); break;
      default: y = Math.ceil(x);
    }
    if (unsigned) {
      if (y >= 4294967296) return 0xffffffff;
      if (y < 0) return (y | 0) >>> 0;
      return y >>> 0;
    }
    if (y >= 2147483648) return 0x7fffffff;
    if (y < -2147483648) return 0x80000000;
    return y >>> 0;
  }

  private fp0(t: number, s: number, r: number, op2: number): void {
    this.checkFpu();
    const fround = Math.fround;
    switch (op2) {
      case 0: this.setF(r, this.f(s) + this.f(t)); return; // ADD.S
      case 1: this.setF(r, this.f(s) - this.f(t)); return; // SUB.S
      case 2: this.setF(r, this.f(s) * this.f(t)); return; // MUL.S
      case 4: this.setF(r, fround(this.f(r) + fround(this.f(s) * this.f(t)))); return; // MADD.S (fused on the part; close enough at single rounding)
      case 5: this.setF(r, fround(this.f(r) - fround(this.f(s) * this.f(t)))); return; // MSUB.S
      case 8: this.windowCheck(r); this.setA(r, this.toInt(this.f(s), t, 'round', false)); return; // ROUND.S
      case 9: this.windowCheck(r); this.setA(r, this.toInt(this.f(s), t, 'trunc', false)); return; // TRUNC.S
      case 10: this.windowCheck(r); this.setA(r, this.toInt(this.f(s), t, 'floor', false)); return; // FLOOR.S
      case 11: this.windowCheck(r); this.setA(r, this.toInt(this.f(s), t, 'ceil', false)); return; // CEIL.S
      case 12: this.windowCheck(s); this.setF(r, (this.a(s) | 0) / 2 ** t); return; // FLOAT.S
      case 13: this.windowCheck(s); this.setF(r, this.a(s) / 2 ** t); return; // UFLOAT.S
      case 14: this.windowCheck(r); this.setA(r, this.toInt(this.f(s), t, 'trunc', true)); return; // UTRUNC.S
      case 15:
        switch (t) {
          case 0: this.setF(r, this.f(s)); this.fu[r] = this.fu[s]; return; // MOV.S
          case 1: this.fu[r] = this.fu[s] & 0x7fffffff; return; // ABS.S
          case 4: this.windowCheck(r); this.setA(r, this.fu[s]); return; // RFR
          case 5: this.windowCheck(s); this.fu[r] = this.a(s); return; // WFR
          case 6: this.fu[r] = this.fu[s] ^ 0x80000000; return; // NEG.S
        }
    }
    throw new XtensaExc(EXC.ILLEGAL);
  }

  private fp1(t: number, s: number, r: number, op2: number): void {
    this.checkFpu();
    const a = this.f(s);
    const b = this.f(t);
    const un = Number.isNaN(a) || Number.isNaN(b);
    const setB = (v: boolean) => (this.br = v ? this.br | (1 << r) : this.br & ~(1 << r));
    switch (op2) {
      case 1: setB(un); return; // UN.S
      case 2: setB(!un && a === b); return; // OEQ.S
      case 3: setB(un || a === b); return; // UEQ.S
      case 4: setB(!un && a < b); return; // OLT.S
      case 5: setB(un || a < b); return; // ULT.S
      case 6: setB(!un && a <= b); return; // OLE.S
      case 7: setB(un || a <= b); return; // ULE.S
      case 8: this.windowCheck(t); if (this.a(t) === 0) this.fu[r] = this.fu[s]; return; // MOVEQZ.S
      case 9: this.windowCheck(t); if (this.a(t) !== 0) this.fu[r] = this.fu[s]; return; // MOVNEZ.S
      case 10: this.windowCheck(t); if ((this.a(t) | 0) < 0) this.fu[r] = this.fu[s]; return; // MOVLTZ.S
      case 11: this.windowCheck(t); if ((this.a(t) | 0) >= 0) this.fu[r] = this.fu[s]; return; // MOVGEZ.S
      case 12: if (!((this.br >> t) & 1)) this.fu[r] = this.fu[s]; return; // MOVF.S
      case 13: if ((this.br >> t) & 1) this.fu[r] = this.fu[s]; return; // MOVT.S
    }
    throw new XtensaExc(EXC.ILLEGAL);
  }
}
