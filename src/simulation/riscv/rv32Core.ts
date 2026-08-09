// A focused RV32 interpreter.
//
// WHY THIS EXISTS
//
// The ESP32-C3 is a RISC-V part, so CircuitDesk needs an RV32 execution core to
// run its firmware honestly. The available options were surveyed before writing
// any of this:
//
//   * The mature browser-capable emulators are QEMU builds (GPLv2) or projects
//     licensed AGPLv3. Neither is compatible with how CircuitDesk is
//     distributed, and the licensing route established for the RP2040 work —
//     permissive dependencies only, nothing restricted — applies here too.
//   * The permissively licensed JavaScript RISC-V projects are teaching
//     exercises: partial instruction coverage, no compressed extension, no CSR
//     support. None of them runs real compiled firmware.
//   * npm's `riscv` package is an encoding-table helper, not an emulator.
//
// So this is written from the RISC-V specifications, which are public and
// freely available. The instruction set is a published standard, not anyone's
// implementation, and nothing here is derived from another emulator's source.
//
// It is deliberately generic. Nothing in this file knows what an ESP32-C3 is:
// memory and peripherals arrive through the `Bus` interface, so the same core
// serves any RV32 target CircuitDesk adds later (ESP32-C6, ESP32-H2, CH32V and
// so on).
//
// Coverage is RV32IMC_Zicsr: the base integer set, multiply/divide, the
// compressed 16-bit encodings, and enough CSR plumbing for a trap handler to
// exist. That is the set real ESP32-C3 firmware is built against; anything the
// firmware turns out to need beyond it is added from a trace of the actual
// image rather than from a guess about what might be used.

/** Anything the core can read and write. Peripherals implement this too. */
export interface Bus {
  readUint8(address: number): number;
  readUint16(address: number): number;
  readUint32(address: number): number;
  writeUint8(address: number, value: number): void;
  writeUint16(address: number, value: number): void;
  writeUint32(address: number, value: number): void;
}

/** Raised when the core cannot continue, always with a diagnosable reason. */
export class RiscvFault extends Error {
  constructor(
    message: string,
    readonly pc: number,
    readonly instruction: number,
  ) {
    super(`${message} (pc=0x${(pc >>> 0).toString(16)}, instr=0x${(instruction >>> 0).toString(16)})`);
    this.name = 'RiscvFault';
  }
}

// Machine-mode CSR numbers used by startup code.
const CSR_MSTATUS = 0x300;
const CSR_MISA = 0x301;
const CSR_MIE = 0x304;
const CSR_MTVEC = 0x305;
const CSR_MSCRATCH = 0x340;
const CSR_MEPC = 0x341;
const CSR_MCAUSE = 0x342;
const CSR_MTVAL = 0x343;
const CSR_MIP = 0x344;
const CSR_MCYCLE = 0xb00;
const CSR_MINSTRET = 0xb02;
const CSR_MCYCLEH = 0xb80;
const CSR_MINSTRETH = 0xb82;
const CSR_MVENDORID = 0xf11;
const CSR_MARCHID = 0xf12;
const CSR_MIMPID = 0xf13;
const CSR_MHARTID = 0xf14;

/**
 * misa for RV32IMC: MXL=1 in the top two bits, then the extension letters.
 * Firmware reads this to discover what it is running on.
 */
const MISA_RV32IMC = (1 << 30) | (1 << 2) | (1 << 8) | (1 << 12);

export class Rv32Core {
  /** x0..x31. x0 is hardwired to zero and writes to it are discarded. */
  readonly registers = new Int32Array(32);
  pc = 0;

  /** Retired instruction count, which also drives the cycle CSRs. */
  instructionsRetired = 0;

  /** True once a WFI has parked the core until an interrupt arrives. */
  waiting = false;

  private csr = new Map<number, number>();

  /**
   * Chip-specific control registers, supplied by whoever owns this core.
   *
   * RISC-V reserves a range of CSR numbers for implementations to define, and
   * real parts use it — the ESP32-C3 puts its performance counters there. The
   * core cannot know what those mean, so it asks. Returning undefined leaves
   * the generic behaviour in place.
   */
  customCsrRead?: (number_: number) => number | undefined;

  /** Returns true when the chip handled the write itself. */
  customCsrWrite?: (number_: number, value: number) => boolean;

  constructor(readonly bus: Bus) {
    this.reset(0);
  }

  reset(entryPoint: number): void {
    this.registers.fill(0);
    this.pc = entryPoint >>> 0;
    this.instructionsRetired = 0;
    this.waiting = false;
    this.csr = new Map<number, number>([
      [CSR_MISA, MISA_RV32IMC],
      [CSR_MVENDORID, 0],
      [CSR_MARCHID, 0],
      [CSR_MIMPID, 0],
      [CSR_MHARTID, 0],
      [CSR_MSTATUS, 0],
      [CSR_MIE, 0],
      [CSR_MIP, 0],
      [CSR_MTVEC, 0],
      [CSR_MEPC, 0],
      [CSR_MCAUSE, 0],
      [CSR_MTVAL, 0],
      [CSR_MSCRATCH, 0],
    ]);
  }

  /** Reads a register, honouring x0's hardwired zero. */
  reg(index: number): number {
    return index === 0 ? 0 : this.registers[index];
  }

  private setReg(index: number, value: number): void {
    if (index !== 0) this.registers[index] = value | 0;
  }

  readCsr(number_: number): number {
    switch (number_) {
      // The counters are derived rather than stored, so they always agree with
      // how much has actually executed.
      case CSR_MCYCLE:
      case CSR_MINSTRET:
        return this.instructionsRetired | 0;
      case CSR_MCYCLEH:
      case CSR_MINSTRETH:
        return Math.floor(this.instructionsRetired / 0x100000000) | 0;
      default: {
        const custom = this.customCsrRead?.(number_);
        return custom !== undefined ? custom | 0 : (this.csr.get(number_) ?? 0);
      }
    }
  }

  writeCsr(number_: number, value: number): void {
    switch (number_) {
      // Read-only identification and counters.
      case CSR_MISA:
      case CSR_MVENDORID:
      case CSR_MARCHID:
      case CSR_MIMPID:
      case CSR_MHARTID:
      case CSR_MCYCLE:
      case CSR_MCYCLEH:
      case CSR_MINSTRET:
      case CSR_MINSTRETH:
        return;
      default:
        if (this.customCsrWrite?.(number_, value | 0)) return;
        this.csr.set(number_, value | 0);
    }
  }

  /**
   * Raises a trap, which is what an interrupt or an ECALL does.
   *
   * `mtvec`'s low two bits select the mode: 0 is direct (every trap enters at
   * BASE) and 1 is vectored (interrupts enter at BASE + 4 * cause).
   *
   * `epc` is what the handler will return to. The two kinds of trap need
   * different values and the spec is precise about it: a synchronous exception
   * records the address of the offending instruction, so a handler can examine
   * or restart it (and an ECALL handler advances past it itself), while an
   * interrupt records the instruction that has not run yet. Since `step()`
   * advances the program counter before executing, a synchronous trap has to
   * pass the instruction's own address rather than letting this default.
   */
  trap(cause: number, value = 0, isInterrupt = false, epc = this.pc): void {
    this.writeCsr(CSR_MEPC, epc);
    this.writeCsr(CSR_MCAUSE, isInterrupt ? (cause | 0x80000000) | 0 : cause);
    this.writeCsr(CSR_MTVAL, value);
    // Save the interrupt-enable bit into MPIE and clear MIE, as the spec says.
    const status = this.readCsr(CSR_MSTATUS);
    const mie = (status >> 3) & 1;
    this.writeCsr(CSR_MSTATUS, ((status & ~0x88) | (mie << 7)) | 0);
    const tvec = this.readCsr(CSR_MTVEC);
    const base = tvec & ~0x3;
    this.pc = ((tvec & 0x3) === 1 && isInterrupt ? base + 4 * cause : base) >>> 0;
    this.waiting = false;
  }

  /** True when an enabled interrupt is pending and globally unmasked. */
  get interruptPending(): boolean {
    const status = this.readCsr(CSR_MSTATUS);
    if (((status >> 3) & 1) === 0) return false;
    return (this.readCsr(CSR_MIE) & this.readCsr(CSR_MIP)) !== 0;
  }

  /** Sets or clears a machine interrupt pending bit. */
  setPending(bit: number, pending: boolean): void {
    const mip = this.readCsr(CSR_MIP);
    this.writeCsr(CSR_MIP, pending ? mip | (1 << bit) : mip & ~(1 << bit));
    if (pending) this.waiting = false;
  }

  /**
   * Executes one instruction and returns how many bytes it occupied.
   *
   * Compressed instructions are two bytes and everything else is four, which
   * matters because the caller advances a cycle counter per instruction, not
   * per byte.
   */
  step(): number {
    if (this.interruptPending) {
      const mask = this.readCsr(CSR_MIE) & this.readCsr(CSR_MIP);
      // Machine external (11), timer (7) and software (3), highest first.
      for (const bit of [11, 7, 3]) {
        if (mask & (1 << bit)) {
          this.trap(bit, 0, true);
          return 0;
        }
      }
    }
    if (this.waiting) return 0;

    const pc = this.pc >>> 0;
    const low = this.bus.readUint16(pc);
    // The bottom two bits distinguish 16-bit compressed encodings (any value
    // other than 0b11) from the 32-bit forms.
    if ((low & 0x3) !== 0x3) {
      this.pc = (pc + 2) >>> 0;
      this.executeCompressed(low, pc);
      this.instructionsRetired++;
      return 2;
    }
    const instruction = this.bus.readUint32(pc);
    this.pc = (pc + 4) >>> 0;
    this.execute(instruction, pc);
    this.instructionsRetired++;
    return 4;
  }

  // ------------------------------------------------------------ 32-bit forms

  private execute(instruction: number, pc: number): void {
    const opcode = instruction & 0x7f;
    const rd = (instruction >>> 7) & 0x1f;
    const funct3 = (instruction >>> 12) & 0x7;
    const rs1 = (instruction >>> 15) & 0x1f;
    const rs2 = (instruction >>> 20) & 0x1f;
    const funct7 = instruction >>> 25;

    switch (opcode) {
      case 0x37: // LUI
        this.setReg(rd, instruction & 0xfffff000);
        return;
      case 0x17: // AUIPC
        this.setReg(rd, (pc + (instruction & 0xfffff000)) | 0);
        return;
      case 0x6f: {
        // JAL
        const offset =
          ((instruction >> 31) << 20) |
          (((instruction >>> 12) & 0xff) << 12) |
          (((instruction >>> 20) & 0x1) << 11) |
          (((instruction >>> 21) & 0x3ff) << 1);
        this.setReg(rd, (pc + 4) | 0);
        this.pc = (pc + offset) >>> 0;
        return;
      }
      case 0x67: {
        // JALR — the target's low bit is cleared, which is how returns work.
        const target = (this.reg(rs1) + (instruction >> 20)) & ~1;
        this.setReg(rd, (pc + 4) | 0);
        this.pc = target >>> 0;
        return;
      }
      case 0x63: {
        // Conditional branches.
        const offset =
          ((instruction >> 31) << 12) |
          (((instruction >>> 7) & 0x1) << 11) |
          (((instruction >>> 25) & 0x3f) << 5) |
          (((instruction >>> 8) & 0xf) << 1);
        const a = this.reg(rs1);
        const b = this.reg(rs2);
        let take = false;
        switch (funct3) {
          case 0x0: take = a === b; break; // BEQ
          case 0x1: take = a !== b; break; // BNE
          case 0x4: take = a < b; break; // BLT
          case 0x5: take = a >= b; break; // BGE
          case 0x6: take = (a >>> 0) < (b >>> 0); break; // BLTU
          case 0x7: take = (a >>> 0) >= (b >>> 0); break; // BGEU
          default:
            throw new RiscvFault('unknown branch condition', pc, instruction);
        }
        if (take) this.pc = (pc + offset) >>> 0;
        return;
      }
      case 0x03: {
        // Loads.
        const address = (this.reg(rs1) + (instruction >> 20)) >>> 0;
        switch (funct3) {
          case 0x0: this.setReg(rd, (this.bus.readUint8(address) << 24) >> 24); return; // LB
          case 0x1: this.setReg(rd, (this.bus.readUint16(address) << 16) >> 16); return; // LH
          case 0x2: this.setReg(rd, this.bus.readUint32(address) | 0); return; // LW
          case 0x4: this.setReg(rd, this.bus.readUint8(address)); return; // LBU
          case 0x5: this.setReg(rd, this.bus.readUint16(address)); return; // LHU
          default:
            throw new RiscvFault('unknown load width', pc, instruction);
        }
      }
      case 0x23: {
        // Stores.
        const offset = ((instruction >> 25) << 5) | ((instruction >>> 7) & 0x1f);
        const address = (this.reg(rs1) + offset) >>> 0;
        const value = this.reg(rs2);
        switch (funct3) {
          case 0x0: this.bus.writeUint8(address, value & 0xff); return; // SB
          case 0x1: this.bus.writeUint16(address, value & 0xffff); return; // SH
          case 0x2: this.bus.writeUint32(address, value >>> 0); return; // SW
          default:
            throw new RiscvFault('unknown store width', pc, instruction);
        }
      }
      case 0x13: {
        // Register-immediate arithmetic.
        const immediate = instruction >> 20;
        const a = this.reg(rs1);
        switch (funct3) {
          case 0x0: this.setReg(rd, (a + immediate) | 0); return; // ADDI
          case 0x2: this.setReg(rd, a < immediate ? 1 : 0); return; // SLTI
          case 0x3: this.setReg(rd, (a >>> 0) < (immediate >>> 0) ? 1 : 0); return; // SLTIU
          case 0x4: this.setReg(rd, a ^ immediate); return; // XORI
          case 0x6: this.setReg(rd, a | immediate); return; // ORI
          case 0x7: this.setReg(rd, a & immediate); return; // ANDI
          case 0x1: this.setReg(rd, a << (rs2 & 0x1f)); return; // SLLI
          case 0x5:
            // SRLI and SRAI differ only in bit 30.
            this.setReg(rd, funct7 & 0x20 ? a >> (rs2 & 0x1f) : a >>> (rs2 & 0x1f));
            return;
          default:
            throw new RiscvFault('unknown immediate operation', pc, instruction);
        }
      }
      case 0x33: {
        const a = this.reg(rs1);
        const b = this.reg(rs2);
        if (funct7 === 0x01) {
          this.executeMulDiv(rd, funct3, a, b, pc, instruction);
          return;
        }
        switch (funct3) {
          case 0x0: this.setReg(rd, funct7 & 0x20 ? (a - b) | 0 : (a + b) | 0); return; // ADD/SUB
          case 0x1: this.setReg(rd, a << (b & 0x1f)); return; // SLL
          case 0x2: this.setReg(rd, a < b ? 1 : 0); return; // SLT
          case 0x3: this.setReg(rd, (a >>> 0) < (b >>> 0) ? 1 : 0); return; // SLTU
          case 0x4: this.setReg(rd, a ^ b); return; // XOR
          case 0x5: this.setReg(rd, funct7 & 0x20 ? a >> (b & 0x1f) : a >>> (b & 0x1f)); return; // SRL/SRA
          case 0x6: this.setReg(rd, a | b); return; // OR
          case 0x7: this.setReg(rd, a & b); return; // AND
          default:
            throw new RiscvFault('unknown register operation', pc, instruction);
        }
      }
      case 0x0f:
        // FENCE and FENCE.I. Nothing here reorders memory or caches
        // instructions, so both are correctly no-ops.
        return;
      case 0x73:
        this.executeSystem(instruction, rd, funct3, rs1, pc);
        return;
      default:
        throw new RiscvFault(`unimplemented opcode 0x${opcode.toString(16)}`, pc, instruction);
    }
  }

  /** The M extension. Division by zero and overflow follow the spec exactly. */
  private executeMulDiv(rd: number, funct3: number, a: number, b: number, pc: number, instruction: number): void {
    switch (funct3) {
      case 0x0: // MUL
        this.setReg(rd, Math.imul(a, b));
        return;
      case 0x1: // MULH
        this.setReg(rd, mulHigh(a, b, true, true));
        return;
      case 0x2: // MULHSU
        this.setReg(rd, mulHigh(a, b, true, false));
        return;
      case 0x3: // MULHU
        this.setReg(rd, mulHigh(a, b, false, false));
        return;
      case 0x4: // DIV
        if (b === 0) this.setReg(rd, -1);
        else if (a === -0x80000000 && b === -1) this.setReg(rd, -0x80000000);
        else this.setReg(rd, (a / b) | 0);
        return;
      case 0x5: // DIVU
        this.setReg(rd, b === 0 ? -1 : ((a >>> 0) / (b >>> 0)) | 0);
        return;
      case 0x6: // REM
        if (b === 0) this.setReg(rd, a);
        else if (a === -0x80000000 && b === -1) this.setReg(rd, 0);
        else this.setReg(rd, (a % b) | 0);
        return;
      case 0x7: // REMU
        this.setReg(rd, b === 0 ? a : ((a >>> 0) % (b >>> 0)) | 0);
        return;
      default:
        throw new RiscvFault('unknown M-extension operation', pc, instruction);
    }
  }

  private executeSystem(instruction: number, rd: number, funct3: number, rs1: number, pc: number): void {
    const csrNumber = instruction >>> 20;
    if (funct3 === 0) {
      switch (csrNumber) {
        case 0x000: // ECALL
          this.trap(11, 0, false, pc);
          return;
        case 0x001: // EBREAK
          this.trap(3, 0, false, pc);
          return;
        case 0x302: {
          // MRET — restore the saved interrupt-enable bit and return.
          const status = this.readCsr(CSR_MSTATUS);
          const mpie = (status >> 7) & 1;
          this.writeCsr(CSR_MSTATUS, ((status & ~0x8) | (mpie << 3) | 0x80) | 0);
          this.pc = this.readCsr(CSR_MEPC) >>> 0;
          return;
        }
        case 0x105: // WFI — park until an interrupt arrives.
          this.waiting = true;
          return;
        default:
          // SFENCE.VMA and friends: no MMU here, so nothing to flush.
          if ((instruction >>> 25) === 0x09) return;
          throw new RiscvFault('unimplemented SYSTEM instruction', pc, instruction);
      }
    }

    // CSR read/modify/write. The immediate forms use rs1 as a 5-bit value.
    const old = this.readCsr(csrNumber);
    const operand = funct3 & 0x4 ? rs1 : this.reg(rs1);
    // A write is skipped when the source is x0 (or a zero immediate) for the
    // set/clear forms, which is how firmware reads a CSR without disturbing it.
    switch (funct3 & 0x3) {
      case 0x1: // CSRRW / CSRRWI
        this.writeCsr(csrNumber, operand);
        break;
      case 0x2: // CSRRS / CSRRSI
        if (rs1 !== 0) this.writeCsr(csrNumber, old | operand);
        break;
      case 0x3: // CSRRC / CSRRCI
        if (rs1 !== 0) this.writeCsr(csrNumber, old & ~operand);
        break;
      default:
        throw new RiscvFault('unknown CSR operation', pc, instruction);
    }
    this.setReg(rd, old);
  }

  // ------------------------------------------------------- compressed forms
  //
  // The C extension packs the most common instructions into 16 bits. Each case
  // below expands to the 32-bit operation it stands for.

  private executeCompressed(instruction: number, pc: number): void {
    const op = instruction & 0x3;
    const funct3 = (instruction >>> 13) & 0x7;

    if (op === 0x0) {
      // Quadrant 0: stack-independent loads and stores off a register.
      const rdC = 8 + ((instruction >>> 2) & 0x7);
      const rs1C = 8 + ((instruction >>> 7) & 0x7);
      switch (funct3) {
        case 0x0: {
          // C.ADDI4SPN — the immediate is scrambled, per the spec's table.
          const immediate =
            (((instruction >>> 7) & 0xf) << 6) |
            (((instruction >>> 11) & 0x3) << 4) |
            (((instruction >>> 5) & 0x1) << 3) |
            (((instruction >>> 6) & 0x1) << 2);
          if (immediate === 0) throw new RiscvFault('illegal compressed instruction', pc, instruction);
          this.setReg(rdC, (this.reg(2) + immediate) | 0);
          return;
        }
        case 0x2: // C.LW
          this.setReg(rdC, this.bus.readUint32((this.reg(rs1C) + cwOffset(instruction)) >>> 0) | 0);
          return;
        case 0x6: // C.SW
          this.bus.writeUint32((this.reg(rs1C) + cwOffset(instruction)) >>> 0, this.reg(rdC) >>> 0);
          return;
        default:
          throw new RiscvFault('unimplemented compressed quadrant 0', pc, instruction);
      }
    }

    if (op === 0x1) {
      // Quadrant 1: arithmetic, branches and jumps.
      const rd = (instruction >>> 7) & 0x1f;
      switch (funct3) {
        case 0x0: // C.ADDI (C.NOP when rd is 0)
          this.setReg(rd, (this.reg(rd) + ciImmediate(instruction)) | 0);
          return;
        case 0x1: {
          // C.JAL — the only quadrant-1 form that links, and RV32 only.
          this.setReg(1, (pc + 2) | 0);
          this.pc = (pc + cjOffset(instruction)) >>> 0;
          return;
        }
        case 0x2: // C.LI
          this.setReg(rd, ciImmediate(instruction));
          return;
        case 0x3: {
          if (rd === 2) {
            // C.ADDI16SP. The immediate is scattered across the encoding and
            // sign-extended from bit 9 — note that only bit 12 carries the
            // sign, not the whole top nibble.
            const raw =
              (((instruction >>> 12) & 0x1) << 9) |
              (((instruction >>> 3) & 0x3) << 7) |
              (((instruction >>> 5) & 0x1) << 6) |
              (((instruction >>> 2) & 0x1) << 5) |
              (((instruction >>> 6) & 0x1) << 4);
            this.setReg(2, (this.reg(2) + ((raw << 22) >> 22)) | 0);
            return;
          }
          // C.LUI, sign-extended from bit 17 for the same reason.
          const raw = (((instruction >>> 12) & 0x1) << 17) | (((instruction >>> 2) & 0x1f) << 12);
          this.setReg(rd, (raw << 14) >> 14);
          return;
        }
        case 0x4: {
          // Shifts, ANDI, and the register-register group.
          const rs1C = 8 + ((instruction >>> 7) & 0x7);
          const kind = (instruction >>> 10) & 0x3;
          const shift = (((instruction >>> 12) & 0x1) << 5) | ((instruction >>> 2) & 0x1f);
          if (kind === 0) {
            this.setReg(rs1C, this.reg(rs1C) >>> shift); // C.SRLI
            return;
          }
          if (kind === 1) {
            this.setReg(rs1C, this.reg(rs1C) >> shift); // C.SRAI
            return;
          }
          if (kind === 2) {
            this.setReg(rs1C, this.reg(rs1C) & ciImmediate(instruction)); // C.ANDI
            return;
          }
          const rs2C = 8 + ((instruction >>> 2) & 0x7);
          switch ((instruction >>> 5) & 0x3) {
            case 0x0: this.setReg(rs1C, (this.reg(rs1C) - this.reg(rs2C)) | 0); return; // C.SUB
            case 0x1: this.setReg(rs1C, this.reg(rs1C) ^ this.reg(rs2C)); return; // C.XOR
            case 0x2: this.setReg(rs1C, this.reg(rs1C) | this.reg(rs2C)); return; // C.OR
            case 0x3: this.setReg(rs1C, this.reg(rs1C) & this.reg(rs2C)); return; // C.AND
            default:
              throw new RiscvFault('unimplemented compressed ALU form', pc, instruction);
          }
        }
        case 0x5: // C.J
          this.pc = (pc + cjOffset(instruction)) >>> 0;
          return;
        case 0x6: // C.BEQZ
          if (this.reg(8 + ((instruction >>> 7) & 0x7)) === 0) this.pc = (pc + cbOffset(instruction)) >>> 0;
          return;
        case 0x7: // C.BNEZ
          if (this.reg(8 + ((instruction >>> 7) & 0x7)) !== 0) this.pc = (pc + cbOffset(instruction)) >>> 0;
          return;
        default:
          throw new RiscvFault('unimplemented compressed quadrant 1', pc, instruction);
      }
    }

    // Quadrant 2: stack-pointer-relative access, jumps and moves.
    const rd = (instruction >>> 7) & 0x1f;
    const rs2 = (instruction >>> 2) & 0x1f;
    switch (funct3) {
      case 0x0: // C.SLLI
        this.setReg(rd, this.reg(rd) << ((((instruction >>> 12) & 0x1) << 5) | rs2));
        return;
      case 0x2: {
        // C.LWSP
        const offset =
          ((((instruction >>> 12) & 0x1) << 5) | (((instruction >>> 4) & 0x7) << 2) | (((instruction >>> 2) & 0x3) << 6));
        this.setReg(rd, this.bus.readUint32((this.reg(2) + offset) >>> 0) | 0);
        return;
      }
      case 0x6: {
        // C.SWSP
        const offset = ((((instruction >>> 9) & 0xf) << 2) | (((instruction >>> 7) & 0x3) << 6));
        this.bus.writeUint32((this.reg(2) + offset) >>> 0, this.reg(rs2) >>> 0);
        return;
      }
      case 0x4: {
        const bit12 = (instruction >>> 12) & 0x1;
        if (bit12 === 0) {
          if (rs2 === 0) {
            // C.JR
            this.pc = this.reg(rd) >>> 0 & ~1;
            return;
          }
          this.setReg(rd, this.reg(rs2)); // C.MV
          return;
        }
        if (rs2 === 0) {
          if (rd === 0) {
            this.trap(3, 0, false, pc); // C.EBREAK
            return;
          }
          // C.JALR
          const target = this.reg(rd) >>> 0 & ~1;
          this.setReg(1, (pc + 2) | 0);
          this.pc = target;
          return;
        }
        this.setReg(rd, (this.reg(rd) + this.reg(rs2)) | 0); // C.ADD
        return;
      }
      default:
        throw new RiscvFault('unimplemented compressed quadrant 2', pc, instruction);
    }
  }
}

// ------------------------------------------------------- immediate decoding
//
// The compressed encodings scatter immediate bits so the common cases fit in
// 16 bits. Each helper reassembles one of the spec's immediate layouts.

/** CI-format signed 6-bit immediate. */
function ciImmediate(instruction: number): number {
  return (((instruction >> 12) & 0x1 ? ~0x1f : 0) | ((instruction >>> 2) & 0x1f)) | 0;
}

/** CL/CS word offset: a zero-extended, word-scaled 5-bit field. */
function cwOffset(instruction: number): number {
  return (((instruction >>> 6) & 0x1) << 2) | (((instruction >>> 10) & 0x7) << 3) | (((instruction >>> 5) & 0x1) << 6);
}

/** CJ-format jump offset. */
function cjOffset(instruction: number): number {
  const value =
    (((instruction >>> 12) & 0x1) << 11) |
    (((instruction >>> 11) & 0x1) << 4) |
    (((instruction >>> 9) & 0x3) << 8) |
    (((instruction >>> 8) & 0x1) << 10) |
    (((instruction >>> 7) & 0x1) << 6) |
    (((instruction >>> 6) & 0x1) << 7) |
    (((instruction >>> 3) & 0x7) << 1) |
    (((instruction >>> 2) & 0x1) << 5);
  // Sign-extend from bit 11.
  return (value << 20) >> 20;
}

/** CB-format branch offset. */
function cbOffset(instruction: number): number {
  const value =
    (((instruction >>> 12) & 0x1) << 8) |
    (((instruction >>> 10) & 0x3) << 3) |
    (((instruction >>> 5) & 0x3) << 6) |
    (((instruction >>> 3) & 0x3) << 1) |
    (((instruction >>> 2) & 0x1) << 5);
  // Sign-extend from bit 8.
  return (value << 23) >> 23;
}

/**
 * High 32 bits of a 32x32 multiply.
 *
 * JavaScript's numbers cannot hold a 64-bit product exactly, so the operands
 * are split into 16-bit halves and recombined — the standard approach, and the
 * reason MULH needs its own function rather than a shift of Math.imul.
 */
function mulHigh(a: number, b: number, aSigned: boolean, bSigned: boolean): number {
  const aHigh = aSigned ? a >> 16 : a >>> 16;
  const aLow = a & 0xffff;
  const bHigh = bSigned ? b >> 16 : b >>> 16;
  const bLow = b & 0xffff;

  const lowLow = aLow * bLow;
  const middle1 = aHigh * bLow;
  const middle2 = aLow * bHigh;
  const highHigh = aHigh * bHigh;

  const carry = ((lowLow >>> 16) + (middle1 & 0xffff) + (middle2 & 0xffff)) / 0x10000;
  return (highHigh + Math.floor(middle1 / 0x10000) + Math.floor(middle2 / 0x10000) + Math.floor(carry)) | 0;
}
