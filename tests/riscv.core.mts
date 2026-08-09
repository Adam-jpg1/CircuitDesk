// The RV32 interpreter, tested against hand-assembled programs.
//
// Every case here is a real instruction encoding executed by the real core.
// The point is to know the core is right before any firmware is involved, so
// that a later failure on real firmware is a firmware or peripheral problem
// rather than a decoding one.
//
// Encodings are built by small helpers rather than copied as magic numbers, so
// a wrong field shows up as a wrong helper rather than as an unreadable
// constant.

import { Rv32Core, RiscvFault, type Bus } from '../src/simulation/riscv/rv32Core';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

/** Flat little-endian memory, which is all these programs need. */
class FlatMemory implements Bus {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  constructor(size = 64 * 1024) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }
  readUint8(a: number) {
    return this.bytes[a >>> 0] ?? 0;
  }
  readUint16(a: number) {
    return this.view.getUint16(a >>> 0, true);
  }
  readUint32(a: number) {
    return this.view.getUint32(a >>> 0, true);
  }
  writeUint8(a: number, v: number) {
    this.bytes[a >>> 0] = v & 0xff;
  }
  writeUint16(a: number, v: number) {
    this.view.setUint16(a >>> 0, v & 0xffff, true);
  }
  writeUint32(a: number, v: number) {
    this.view.setUint32(a >>> 0, v >>> 0, true);
  }
}

// ------------------------------------------------------------- encoders

const rType = (funct7: number, rs2: number, rs1: number, funct3: number, rd: number, opcode: number) =>
  ((funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode) >>> 0;
const iType = (imm: number, rs1: number, funct3: number, rd: number, opcode: number) =>
  (((imm & 0xfff) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode) >>> 0;
const sType = (imm: number, rs2: number, rs1: number, funct3: number, opcode: number) =>
  ((((imm >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | ((imm & 0x1f) << 7) | opcode) >>> 0;
const bType = (imm: number, rs2: number, rs1: number, funct3: number, opcode: number) =>
  ((((imm >> 12) & 1) << 31) |
    (((imm >> 5) & 0x3f) << 25) |
    (rs2 << 20) |
    (rs1 << 15) |
    (funct3 << 12) |
    (((imm >> 1) & 0xf) << 8) |
    (((imm >> 11) & 1) << 7) |
    opcode) >>> 0;
const uType = (imm: number, rd: number, opcode: number) => ((imm & 0xfffff000) | (rd << 7) | opcode) >>> 0;
const jType = (imm: number, rd: number, opcode: number) =>
  ((((imm >> 20) & 1) << 31) |
    (((imm >> 1) & 0x3ff) << 21) |
    (((imm >> 11) & 1) << 20) |
    (((imm >> 12) & 0xff) << 12) |
    (rd << 7) |
    opcode) >>> 0;

const ADDI = (rd: number, rs1: number, imm: number) => iType(imm, rs1, 0x0, rd, 0x13);
const LUI = (rd: number, imm: number) => uType(imm, rd, 0x37);

/** Loads a program at address 0 and runs it for a bounded number of steps. */
function runProgram(words: number[], steps: number, setup?: (core: Rv32Core) => void): Rv32Core {
  const memory = new FlatMemory();
  const core = new Rv32Core(memory);
  words.forEach((w, i) => memory.writeUint32(i * 4, w));
  core.reset(0);
  setup?.(core);
  for (let i = 0; i < steps; i++) core.step();
  return core;
}

// ---------- 1. base integer arithmetic ----------
{
  const core = runProgram(
    [
      ADDI(1, 0, 100), // x1 = 100
      ADDI(2, 0, -8), // x2 = -8
      rType(0x00, 2, 1, 0x0, 3, 0x33), // ADD  x3 = x1 + x2
      rType(0x20, 2, 1, 0x0, 4, 0x33), // SUB  x4 = x1 - x2
      rType(0x00, 2, 1, 0x7, 5, 0x33), // AND  x5
      rType(0x00, 2, 1, 0x6, 6, 0x33), // OR   x6
      rType(0x00, 2, 1, 0x4, 7, 0x33), // XOR  x7
    ],
    7,
  );
  check(core.reg(1) === 100, `ADDI loads a positive immediate (${core.reg(1)})`);
  check(core.reg(2) === -8, `ADDI sign-extends a negative immediate (${core.reg(2)})`);
  check(core.reg(3) === 92, `ADD (${core.reg(3)})`);
  check(core.reg(4) === 108, `SUB (${core.reg(4)})`);
  check(core.reg(5) === (100 & -8), `AND (${core.reg(5)})`);
  check(core.reg(6) === (100 | -8), `OR (${core.reg(6)})`);
  check(core.reg(7) === (100 ^ -8), `XOR (${core.reg(7)})`);
}

// ---------- 2. x0 is hardwired to zero ----------
{
  const core = runProgram([ADDI(0, 0, 1234)], 1);
  check(core.reg(0) === 0, 'writes to x0 are discarded');
}

// ---------- 3. shifts, comparisons and upper immediates ----------
{
  const core = runProgram(
    [
      ADDI(1, 0, -1), // x1 = 0xFFFFFFFF
      iType(4, 1, 0x5, 2, 0x13), // SRLI x2 = x1 >>> 4
      iType(0x404, 1, 0x5, 3, 0x13), // SRAI x3 = x1 >> 4
      iType(4, 1, 0x1, 4, 0x13), // SLLI x4 = x1 << 4
      ADDI(5, 0, 5),
      rType(0x00, 5, 1, 0x2, 6, 0x33), // SLT  x6 = (x1 < 5) signed  -> 1
      rType(0x00, 5, 1, 0x3, 7, 0x33), // SLTU x7 = (x1 < 5) unsigned -> 0
      LUI(8, 0xabcde000), // LUI
      uType(0x1000, 9, 0x17), // AUIPC at pc = 32
    ],
    9,
  );
  check(core.reg(2) === 0x0fffffff, `SRLI is a logical shift (0x${(core.reg(2) >>> 0).toString(16)})`);
  check(core.reg(3) === -1, `SRAI is arithmetic (${core.reg(3)})`);
  check(core.reg(4) === -16, `SLLI (${core.reg(4)})`);
  check(core.reg(6) === 1, `SLT treats the operands as signed (${core.reg(6)})`);
  check(core.reg(7) === 0, `SLTU treats them as unsigned (${core.reg(7)})`);
  check((core.reg(8) >>> 0) === 0xabcde000, `LUI (0x${(core.reg(8) >>> 0).toString(16)})`);
  check((core.reg(9) >>> 0) === 0x1000 + 32, `AUIPC adds the immediate to its own address (0x${(core.reg(9) >>> 0).toString(16)})`);
}

// ---------- 4. loads and stores of every width ----------
{
  const memory = new FlatMemory();
  const core = new Rv32Core(memory);
  const program = [
    LUI(1, 0x1000), // x1 = 0x1000, the scratch address
    ADDI(2, 0, -3), // x2 = 0xFFFFFFFD
    sType(0, 2, 1, 0x2, 0x23), // SW  [x1] = x2
    iType(0, 1, 0x2, 3, 0x03), // LW  x3
    iType(0, 1, 0x0, 4, 0x03), // LB  x4  (sign-extends 0xFD -> -3)
    iType(0, 1, 0x4, 5, 0x03), // LBU x5  (0xFD -> 253)
    iType(0, 1, 0x1, 6, 0x03), // LH  x6  (0xFFFD -> -3)
    iType(0, 1, 0x5, 7, 0x03), // LHU x7  (0xFFFD -> 65533)
    ADDI(8, 0, 0x7a),
    sType(4, 8, 1, 0x0, 0x23), // SB  [x1+4] = 0x7A
    iType(4, 1, 0x4, 9, 0x03), // LBU x9
  ];
  program.forEach((w, i) => memory.writeUint32(i * 4, w));
  core.reset(0);
  for (let i = 0; i < program.length; i++) core.step();

  check((core.reg(3) >>> 0) === 0xfffffffd, `LW round-trips a word (0x${(core.reg(3) >>> 0).toString(16)})`);
  check(core.reg(4) === -3, `LB sign-extends (${core.reg(4)})`);
  check(core.reg(5) === 253, `LBU zero-extends (${core.reg(5)})`);
  check(core.reg(6) === -3, `LH sign-extends (${core.reg(6)})`);
  check(core.reg(7) === 65533, `LHU zero-extends (${core.reg(7)})`);
  check(core.reg(9) === 0x7a, `SB writes a single byte (0x${core.reg(9).toString(16)})`);
  check(memory.readUint8(0x1005) === 0, 'SB leaves the neighbouring byte alone');
}

// ---------- 5. branches ----------
{
  // Skip one instruction when equal, so x2 stays 0 and x3 becomes 7.
  const core = runProgram(
    [
      ADDI(1, 0, 5),
      bType(8, 1, 1, 0x0, 0x63), // BEQ x1, x1, +8
      ADDI(2, 0, 99), // skipped
      ADDI(3, 0, 7),
    ],
    3,
  );
  check(core.reg(2) === 0, 'a taken BEQ skips the instruction after it');
  check(core.reg(3) === 7, 'execution resumes at the branch target');

  // BLT is signed and BLTU is not, which is the classic place to get it wrong.
  const signed = runProgram(
    [
      ADDI(1, 0, -1),
      ADDI(2, 0, 1),
      bType(8, 2, 1, 0x4, 0x63), // BLT  -1 < 1  -> taken
      ADDI(3, 0, 1), // skipped
      bType(8, 2, 1, 0x6, 0x63), // BLTU 0xFFFFFFFF < 1 -> not taken
      ADDI(4, 0, 1), // executed
    ],
    5,
  );
  check(signed.reg(3) === 0, 'BLT compares as signed');
  check(signed.reg(4) === 1, 'BLTU compares as unsigned');
}

// ---------- 6. jumps and linkage ----------
{
  const core = runProgram(
    [
      jType(8, 1, 0x6f), // JAL x1, +8  (x1 = 4)
      ADDI(2, 0, 99), // skipped
      ADDI(3, 0, 7),
    ],
    2,
  );
  check(core.reg(1) === 4, `JAL links the return address (${core.reg(1)})`);
  check(core.reg(2) === 0, 'JAL skips over the instruction it jumped past');
  check(core.reg(3) === 7, 'JAL lands on its target');

  // JALR clears the low bit of the computed target, which is what makes
  // returning through a link register safe.
  const jalr = runProgram([ADDI(1, 0, 9), iType(0, 1, 0x0, 5, 0x67)], 2);
  check(jalr.pc === 8, `JALR clears the target's low bit (pc = ${jalr.pc})`);
  check(jalr.reg(5) === 8, `JALR links the following address (${jalr.reg(5)})`);
}

// ---------- 7. the M extension ----------
{
  const core = runProgram(
    [
      ADDI(1, 0, -7),
      ADDI(2, 0, 3),
      rType(0x01, 2, 1, 0x0, 3, 0x33), // MUL
      rType(0x01, 2, 1, 0x4, 4, 0x33), // DIV
      rType(0x01, 2, 1, 0x6, 5, 0x33), // REM
      rType(0x01, 2, 1, 0x5, 6, 0x33), // DIVU
      rType(0x01, 2, 1, 0x7, 7, 0x33), // REMU
      rType(0x01, 1, 1, 0x1, 8, 0x33), // MULH  (-7 * -7)
      rType(0x01, 1, 1, 0x3, 9, 0x33), // MULHU
    ],
    9,
  );
  check(core.reg(3) === -21, `MUL (${core.reg(3)})`);
  check(core.reg(4) === -2, `DIV truncates toward zero (${core.reg(4)})`);
  check(core.reg(5) === -1, `REM takes the dividend's sign (${core.reg(5)})`);
  check(core.reg(6) === Math.floor(0xfffffff9 / 3), `DIVU is unsigned (${core.reg(6) >>> 0})`);
  check(core.reg(7) === 0xfffffff9 % 3, `REMU is unsigned (${core.reg(7)})`);
  check(core.reg(8) === 0, `MULH of two small negatives is zero (${core.reg(8)})`);
  check((core.reg(9) >>> 0) === 0xfffffff2, `MULHU keeps the unsigned high word (0x${(core.reg(9) >>> 0).toString(16)})`);

  // The spec pins down these two edge cases exactly.
  const edge = runProgram(
    [
      ADDI(1, 0, 5),
      rType(0x01, 0, 1, 0x4, 2, 0x33), // DIV by zero -> -1
      rType(0x01, 0, 1, 0x6, 3, 0x33), // REM by zero -> dividend
      LUI(4, 0x80000000), // x4 = INT_MIN
      ADDI(5, 0, -1),
      rType(0x01, 5, 4, 0x4, 6, 0x33), // DIV overflow -> INT_MIN
      rType(0x01, 5, 4, 0x6, 7, 0x33), // REM overflow -> 0
    ],
    7,
  );
  check(edge.reg(2) === -1, 'division by zero yields all ones, as the spec requires');
  check(edge.reg(3) === 5, 'remainder by zero yields the dividend');
  check(edge.reg(6) === -0x80000000, 'signed division overflow yields INT_MIN');
  check(edge.reg(7) === 0, 'signed remainder overflow yields zero');
}

// ---------- 8. the compressed extension ----------
{
  // Compressed instructions are 16 bits, so they are written directly here.
  const memory = new FlatMemory();
  const core = new Rv32Core(memory);
  // c.li x8, 5      -> 0x4415
  // c.li x9, 3      -> 0x448d
  // c.add x8, x9    -> 0x9426
  // c.mv  x10, x8   -> 0x8522
  const halfwords = [0x4415, 0x448d, 0x9426, 0x8522];
  halfwords.forEach((h, i) => memory.writeUint16(i * 2, h));
  core.reset(0);
  const widths: number[] = [];
  for (let i = 0; i < halfwords.length; i++) widths.push(core.step());

  check(
    widths.every((w) => w === 2),
    `compressed instructions advance the program counter by two bytes (${widths.join(',')})`,
  );
  check(core.reg(8) === 8, `c.li then c.add (x8 = ${core.reg(8)})`);
  check(core.reg(9) === 3, `c.li (x9 = ${core.reg(9)})`);
  check(core.reg(10) === 8, `c.mv copies a register (x10 = ${core.reg(10)})`);

  // Mixing widths must keep the program counter aligned to what each form uses.
  const mixed = new FlatMemory();
  const mixedCore = new Rv32Core(mixed);
  mixed.writeUint16(0, 0x4415); // c.li x8, 5      (2 bytes)
  mixed.writeUint32(2, ADDI(11, 8, 1)); // addi x11, x8, 1 (4 bytes)
  mixed.writeUint16(6, 0x4491); // c.li x9, 4
  mixedCore.reset(0);
  const mixedWidths = [mixedCore.step(), mixedCore.step(), mixedCore.step()];
  check(mixedWidths.join(',') === '2,4,2', `16- and 32-bit forms interleave correctly (${mixedWidths.join(',')})`);
  check(mixedCore.reg(11) === 6, `a 32-bit instruction after a compressed one decodes correctly (${mixedCore.reg(11)})`);
}

// ---------- 9. CSRs and traps ----------
{
  const core = runProgram(
    [
      ADDI(1, 0, 0x123),
      iType(0x340, 1, 0x1, 2, 0x73), // CSRRW mscratch, x1  -> x2 gets the old value
      iType(0x340, 0, 0x2, 3, 0x73), // CSRRS mscratch, x0  -> read without writing
      iType(0x301, 0, 0x2, 4, 0x73), // CSRRS misa, x0
    ],
    4,
  );
  check(core.reg(2) === 0, 'CSRRW returns the previous value');
  check(core.reg(3) === 0x123, `a CSR keeps what was written to it (0x${core.reg(3).toString(16)})`);
  const misa = core.reg(4) >>> 0;
  check((misa >>> 30) === 1, 'misa reports a 32-bit machine');
  check((misa & (1 << 8)) !== 0, 'misa reports the I extension');
  check((misa & (1 << 12)) !== 0, 'misa reports the M extension');
  check((misa & (1 << 2)) !== 0, 'misa reports the C extension');

  // A trap must save the return address and enter mtvec.
  const trapping = runProgram(
    [
      LUI(1, 0x8000), // x1 = 0x8000
      iType(0x305, 1, 0x1, 0, 0x73), // CSRRW mtvec, x1
      iType(0x000, 0, 0x0, 0, 0x73), // ECALL
    ],
    3,
  );
  check(trapping.pc === 0x8000, `ECALL enters the handler at mtvec (0x${trapping.pc.toString(16)})`);
  check(trapping.readCsr(0x341) === 8, `mepc records the faulting instruction (${trapping.readCsr(0x341)})`);
  check(trapping.readCsr(0x342) === 11, `mcause records an environment call (${trapping.readCsr(0x342)})`);
}

// ---------- 10. WFI and interrupts ----------
{
  const memory = new FlatMemory();
  const core = new Rv32Core(memory);
  memory.writeUint32(0, iType(0x105, 0, 0x0, 0, 0x73)); // WFI
  memory.writeUint32(4, ADDI(1, 0, 42));
  core.reset(0);
  core.step();
  check(core.waiting, 'WFI parks the core');
  const before = core.instructionsRetired;
  core.step();
  core.step();
  check(core.instructionsRetired === before, 'a parked core retires no instructions');

  // An enabled, pending, unmasked interrupt wakes it and enters the handler.
  core.writeCsr(0x305, 0x9000); // mtvec
  core.writeCsr(0x300, 0x8); // mstatus.MIE
  core.writeCsr(0x304, 1 << 7); // mie: machine timer
  core.setPending(7, true);
  check(!core.waiting, 'a pending interrupt wakes the core');
  core.step();
  check(core.pc === 0x9000, `the interrupt enters the handler (0x${core.pc.toString(16)})`);
  check((core.readCsr(0x342) >>> 31) === 1, 'mcause marks it as an interrupt');
  check((core.readCsr(0x342) & 0x7fffffff) === 7, 'mcause records the timer cause');
  check(((core.readCsr(0x300) >> 3) & 1) === 0, 'entering a trap clears the global interrupt enable');
}

// ---------- 11. unknown instructions fault rather than silently continue ----------
{
  const memory = new FlatMemory();
  const core = new Rv32Core(memory);
  memory.writeUint32(0, 0x0000007f); // an opcode nothing implements
  core.reset(0);
  let fault: unknown;
  try {
    core.step();
  } catch (err) {
    fault = err;
  }
  check(fault instanceof RiscvFault, 'an unimplemented opcode raises a fault');
  check(
    fault instanceof RiscvFault && fault.message.includes('0x0'),
    `the fault names the program counter and the encoding (${(fault as Error).message})`,
  );
}

// ---------- 12. a loop that actually computes something ----------
{
  // Sum 1..10 with a real backward branch, which exercises the whole pipeline.
  const core = runProgram(
    [
      ADDI(1, 0, 0), // total
      ADDI(2, 0, 1), // i
      ADDI(3, 0, 11), // limit
      bType(16, 3, 2, 0x0, 0x63), // loop: BEQ i, limit -> done
      rType(0x00, 2, 1, 0x0, 1, 0x33), // total += i
      ADDI(2, 2, 1), // i++
      jType(-12, 0, 0x6f), // J loop
      ADDI(4, 0, 1), // done
    ],
    200,
  );
  check(core.reg(1) === 55, `a real loop computes the right answer (sum 1..10 = ${core.reg(1)})`);
  check(core.reg(4) === 1, 'the loop exits through its branch');
  check(core.instructionsRetired > 30, `the loop really iterated (${core.instructionsRetired} instructions)`);
}

console.log(failures === 0 ? '\nRV32 core checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
