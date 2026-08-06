// Direct unit tests for the independently written RP2040 boot ROM stub.
//
// These call each advertised ROM routine the way firmware does — resolve it
// through rom_table_lookup, branch to the returned Thumb pointer, read the
// result out of r0 — and compare against a JavaScript reference. No firmware
// is involved, so a failure here points at the stub and nothing else.
//
// The ROM interface used is the public one documented in RP2040 datasheet
// section 2.8. See src/simulation/rp2040/bootStub.ts for why Raspberry Pi's
// own ROM image is not used.

import { buildBootStub, ROM_FUNC_CODES } from '../src/simulation/rp2040/bootStub';
import { loadRp2040js, PicoMachine } from './harness/picoMachine.mts';
import { Tracer } from './harness/trace.mts';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const rp2040js = await loadRp2040js();
if (!rp2040js) {
  console.log('SKIP: rp2040js is not installed — ROM ABI tests cannot run');
  skipped++;
} else {
  const { RP2040 } = rp2040js;
  const stub = buildBootStub();
  const machine = new PicoMachine(RP2040);
  const rp = machine.rp;

  /** An address in the ROM header block that holds no code. */
  const RETURN_SENTINEL = 0x00000f00;
  const STACK_TOP = 0x20042000;

  /**
   * Invokes a Thumb routine exactly as compiled firmware would: arguments in
   * r0..r3, return address in LR, result in r0. Bounded, so a routine that
   * fails to return is reported rather than hanging the suite.
   */
  function call(addr: number, args: number[]): number {
    rp.core.SP = STACK_TOP;
    args.forEach((v, i) => {
      rp.core.registers[i] = v >>> 0;
    });
    rp.core.registers[14] = RETURN_SENTINEL | 1;
    rp.core.PC = addr & ~1;
    for (let i = 0; i < 5000; i++) {
      if ((rp.core.PC & ~1) === RETURN_SENTINEL) return rp.core.registers[0] >>> 0;
      rp.core.executeInstruction();
    }
    throw new Error(`0x${addr.toString(16)} did not return within 5000 instructions`);
  }

  /** rom_table_lookup(table, code), reading the table pointer from 0x14. */
  const lookup = (code: number) => call(stub.functions.rom_table_lookup, [rp.readUint16(0x14), code]);

  // ---------- 1. Every advertised routine resolves through the table ----------
  const advertised = [
    'memcpy',
    'memcpy44',
    'memset',
    'memset4',
    'connect_internal_flash',
    'flash_exit_xip',
    'flash_flush_cache',
    'flash_enter_cmd_xip',
    'clz32',
    'ctz32',
    'popcount32',
    'reverse32',
  ] as const;

  for (const name of advertised) {
    const got = lookup(ROM_FUNC_CODES[name]);
    check(got !== 0, `${name}: rom_table_lookup resolves it (0x${got.toString(16)})`);
    check((got & 1) === 1, `${name}: the returned pointer carries the Thumb bit`);
    check((got & ~1) < 4096 * 4, `${name}: the pointer lands inside the 16 KB ROM`);
  }

  // ---------- 2. An unknown code fails cleanly ----------
  //
  // This is the defect that produced the 0x108 stall: an unresolved lookup
  // must return the documented 0, and must do so by terminating.
  let terminated = true;
  let unknown = 0;
  try {
    unknown = lookup(0xffe0);
  } catch {
    terminated = false;
  }
  check(terminated, 'an unknown function code terminates instead of looping');
  check(unknown === 0, `an unknown function code returns the documented 0 (got ${unknown})`);

  // ---------- 3. The bit helpers match a reference implementation ----------
  const clz = (v: number) => (v === 0 ? 32 : Math.clz32(v));
  const ctz = (v: number) => {
    if (v === 0) return 32;
    let n = 0;
    while (!((v >>> n) & 1)) n++;
    return n;
  };
  const popcount = (v: number) => {
    let n = 0;
    for (let i = 0; i < 32; i++) if ((v >>> i) & 1) n++;
    return n;
  };
  const reverse = (v: number) => {
    let r = 0;
    for (let i = 0; i < 32; i++) r = ((r << 1) | ((v >>> i) & 1)) >>> 0;
    return r >>> 0;
  };

  const clzAddr = lookup(ROM_FUNC_CODES.clz32);
  const ctzAddr = lookup(ROM_FUNC_CODES.ctz32);
  const popAddr = lookup(ROM_FUNC_CODES.popcount32);
  const revAddr = lookup(ROM_FUNC_CODES.reverse32);

  const vectors = [0, 1, 2, 3, 0x80000000, 0xffffffff, 0x12345678, 0x0000ff00, 0xdeadbeef, 0x00000010, 0x7fffffff];
  for (const v of vectors) {
    const hex = `0x${(v >>> 0).toString(16)}`;
    check(call(clzAddr, [v]) === clz(v >>> 0), `clz32(${hex}) = ${clz(v >>> 0)}`);
    check(call(ctzAddr, [v]) === ctz(v >>> 0), `ctz32(${hex}) = ${ctz(v >>> 0)}`);
    check(call(popAddr, [v]) === popcount(v >>> 0), `popcount32(${hex}) = ${popcount(v >>> 0)}`);
    check(call(revAddr, [v]) === reverse(v >>> 0), `reverse32(${hex}) = 0x${reverse(v >>> 0).toString(16)}`);
  }

  // ---------- 4. The memory routines move the bytes they claim to ----------
  const src = 0x20001000;
  const dst = 0x20002000;
  for (let i = 0; i < 64; i++) rp.writeUint8(src + i, (i * 7 + 1) & 0xff);
  rp.writeUint8(dst + 64, 0x5a); // a guard byte just past the copy

  const memcpyAddr = lookup(ROM_FUNC_CODES.memcpy);
  const returned = call(memcpyAddr, [dst, src, 64]);
  check(returned === dst, 'memcpy returns the destination pointer');
  let copied = true;
  for (let i = 0; i < 64; i++) if (rp.readUint8(dst + i) !== ((i * 7 + 1) & 0xff)) copied = false;
  check(copied, 'memcpy copies every byte');
  check(rp.readUint8(dst + 64) === 0x5a, 'memcpy writes nothing past n bytes');
  check(call(memcpyAddr, [dst, src, 0]) === dst, 'memcpy with n = 0 returns without writing');

  const memsetAddr = lookup(ROM_FUNC_CODES.memset);
  call(memsetAddr, [dst, 0xa5, 16]);
  check(rp.readUint8(dst) === 0xa5 && rp.readUint8(dst + 15) === 0xa5, 'memset fills the requested range');
  check(rp.readUint8(dst + 16) === ((16 * 7 + 1) & 0xff), 'memset writes nothing past n bytes');

  // The word-aligned variants share the byte implementations, which is only
  // sound if they behave identically for aligned inputs.
  check(call(lookup(ROM_FUNC_CODES.memcpy44), [dst, src, 32]) === dst, 'memcpy44 behaves as memcpy for aligned input');
  call(lookup(ROM_FUNC_CODES.memset4), [dst, 0x00, 32]);
  check(rp.readUint8(dst) === 0 && rp.readUint8(dst + 31) === 0, 'memset4 behaves as memset for aligned input');

  // ---------- 5. Calling convention is respected ----------
  check(rp.core.SP === STACK_TOP, 'the stack pointer is restored after a ROM call');
  for (const name of ['connect_internal_flash', 'flash_exit_xip', 'flash_flush_cache', 'flash_enter_cmd_xip'] as const) {
    let ok = true;
    try {
      call(lookup(ROM_FUNC_CODES[name]), [0, 0, 0]);
    } catch {
      ok = false;
    }
    check(ok, `${name} returns to its caller`);
  }

  // ---------- 6. Hand-written Thumb runs from flash ----------
  //
  // Proves the engine executes real instructions out of the XIP region before
  // any compiled firmware is involved.
  {
    const bare = new PicoMachine(RP2040);
    const img = new Uint8Array(0x200);
    const dv = new DataView(img.buffer);
    const entry = 0x10000000 + 0x140;
    dv.setUint32(0x100, STACK_TOP, true);
    dv.setUint32(0x104, entry | 1, true);
    dv.setUint16(0x140, 0x2001, true); // movs r0, #1
    dv.setUint16(0x142, 0x1c40, true); // adds r0, r0, #1
    dv.setUint16(0x144, 0xe7fd, true); // b .-2
    bare.rp.flash.set(img, 0);
    bare.rp.core.SP = bare.rp.readUint32(0x10000100);
    bare.rp.core.PC = bare.rp.readUint32(0x10000104) & ~1;
    check(bare.rp.core.PC === entry, `the reset vector comes from the image (0x${bare.rp.core.PC.toString(16)})`);
    const result = bare.run({ maxInstructions: 500, maxWallMs: 5_000 });
    check(result.instructions === 500, 'a bounded run retires exactly the requested instructions');
    check(bare.rp.core.registers[0] > 100, `hand-written Thumb really executes from flash (r0 = ${bare.rp.core.registers[0]})`);
  }

  // ---------- 7. The trace harness itself works ----------
  //
  // A tracer that cannot detect a runaway loop is worse than none, so the
  // detector is tested against a program that is deliberately stuck.
  {
    const stuck = new PicoMachine(RP2040);
    const img = new Uint8Array(0x200);
    const dv = new DataView(img.buffer);
    dv.setUint32(0x100, STACK_TOP, true);
    dv.setUint32(0x104, (0x10000140 | 1) >>> 0, true);
    dv.setUint16(0x140, 0xe7fe, true); // b . — an infinite loop
    stuck.rp.flash.set(img, 0);
    stuck.rp.core.SP = STACK_TOP;
    stuck.rp.core.PC = 0x10000140;

    const tracer = new Tracer({ capacity: 8, registers: [0, 1], repeatLimit: 50 });
    tracer.addSymbol(0x10000140, 'spin');
    const result = stuck.run({ trace: tracer, maxInstructions: 100_000, maxWallMs: 5_000 });
    check(result.reason === 'trace', `the tracer stops a runaway loop (reason: ${result.reason})`);
    check(tracer.stopRequested && !!tracer.stopReason, `the stop reason is reported: ${tracer.stopReason}`);
    check(result.instructions < 100, `the loop is caught early (${result.instructions} instructions)`);
    check(tracer.entries.length === 8, `the ring buffer is bounded to its capacity (${tracer.entries.length})`);
    check(tracer.recordedCount > 8, `entries beyond capacity are counted, not retained (${tracer.recordedCount})`);
    const hot = tracer.hottest(1)[0];
    check(hot?.pc === 0x10000140, 'the hottest address is the spinning instruction');
    check(hot?.symbol === 'spin', 'addresses are annotated with their symbol');
    check(tracer.format(3).includes('<spin>'), 'the formatted trace names the symbol');
  }

  // ---------- 8. PC-range filtering ----------
  {
    const filtered = new PicoMachine(RP2040);
    const img = new Uint8Array(0x200);
    const dv = new DataView(img.buffer);
    dv.setUint16(0x140, 0x2001, true); // movs r0, #1
    dv.setUint16(0x142, 0x1c40, true); // adds r0, r0, #1
    dv.setUint16(0x144, 0xe7fd, true); // b .-2
    filtered.rp.flash.set(img, 0);
    filtered.rp.core.SP = STACK_TOP;
    filtered.rp.core.PC = 0x10000140;

    const tracer = new Tracer({ capacity: 1024, ranges: [{ start: 0x10000142, end: 0x10000144, name: 'adds' }] });
    filtered.run({ trace: tracer, maxInstructions: 300, maxWallMs: 5_000 });
    check(tracer.observed === 300, `every step is observed (${tracer.observed})`);
    check(tracer.recordedCount > 0 && tracer.recordedCount < 300, `only in-range steps are recorded (${tracer.recordedCount})`);
    check(
      tracer.entries.every((e) => e.pc === 0x10000142),
      'no out-of-range address is recorded',
    );
  }
}

console.log(
  failures === 0
    ? `\nRP2040 ROM ABI checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
