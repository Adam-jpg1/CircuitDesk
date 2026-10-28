// RP2040 ROM and UF2 invariants.
//
// This suite covers the parts of the RP2040 work that need no toolchain: that
// the independently written boot ROM stub is self-consistent, that rp2040js
// ships no ROM image of its own, that Thumb code really executes out of the
// XIP window, and that the UF2 reader rejects everything malformed.
//
// Real compiled firmware — blink, GPIO input, UART, reset and bounded
// execution — is exercised in tests/rp2040.firmware.mts, which needs the
// compiler backend. The direct ROM ABI unit tests are in
// tests/rp2040.romabi.mts.
//
// Requires rp2040js (MIT, no bundled ROM). Sections needing it are skipped
// with a clear message when it is unavailable.

import { buildBootStub, ROM_FUNC_CODES, ROM_FUNC_NAMES, ROM_DATA_CODES } from '../src/simulation/rp2040/bootStub';
import { ROM_FLOAT_SLOTS } from '../src/simulation/rp2040/romFloat';
import { parseUf2 } from './harness/picoMachine.mts';

const BASE = process.env.CIRCUITDESK_URL ?? 'http://localhost:3411';
const FLASH_BASE = 0x10000000;
const RP2040_FAMILY_ID = 0xe48bff56;
const CYCLE_NS = 1e9 / 125e6;

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function skip(msg: string) {
  console.log('SKIP:', msg);
  skipped++;
}

/** Loads rp2040js only if it is installed, so the suite degrades cleanly. */
async function loadRp2040js(): Promise<any | null> {
  try {
    return await import('rp2040js');
  } catch {
    return null;
  }
}

// ---------- 1. The boot stub is self-consistent and ROM-free ----------
{
  const stub = buildBootStub();
  check(stub.rom.length === 4096, `the stub fills the 16 KB ROM region (${stub.rom.length} words)`);

  const bytes = new Uint8Array(stub.rom.buffer);
  const dv = new DataView(bytes.buffer);
  check(
    bytes[0x10] === 'M'.charCodeAt(0) && bytes[0x11] === 'u'.charCodeAt(0),
    'the documented ROM magic is present at offset 0x10',
  );
  check(dv.getUint16(0x14, true) === stub.functionTableAddress, 'offset 0x14 points at the function table');
  check((dv.getUint16(0x18, true) & ~1) === stub.functions.rom_table_lookup, 'offset 0x18 points at rom_table_lookup');
  check((dv.getUint16(0x18, true) & 1) === 1, 'the lookup pointer carries the Thumb bit');

  // Every advertised entry must resolve to code inside the ROM region.
  let entries = 0;
  for (let a = stub.functionTableAddress; ; a += 4) {
    const code = dv.getUint16(a, true);
    if (code === 0) break;
    const addr = dv.getUint16(a + 2, true);
    check((addr & 1) === 1, `function table entry ${ROM_FUNC_NAMES[code] ?? code} is a Thumb pointer`);
    check((addr & ~1) < 4096 * 4, `function table entry ${ROM_FUNC_NAMES[code] ?? code} lands inside the ROM`);
    entries++;
  }
  check(
    entries === 14,
    `the memory, flash, and bit-helper routines are advertised (${entries})`,
  );

  const advertised = new Set<number>();
  for (let a = stub.functionTableAddress; dv.getUint16(a, true) !== 0; a += 4) advertised.add(dv.getUint16(a, true));
  // The float and double tables are data, found through the data table: every
  // slot a trap stub of our own (bkpt; bx lr), none of them mufplib, and the
  // slot count in the byte two before each table, where the SDK checks it.
  const dataTable = dv.getUint16(0x16, true);
  const published = new Map<number, number>();
  for (let a = dataTable; dv.getUint16(a, true) !== 0; a += 4) published.set(dv.getUint16(a, true), dv.getUint16(a + 2, true));
  for (const [name, value] of Object.entries(ROM_DATA_CODES)) {
    const table = published.get(value);
    check(table !== undefined, `the ${name} is published in the data table`);
    if (table === undefined) continue;
    check(dv.getUint8(table - 2) === ROM_FLOAT_SLOTS, `${name} declares ${ROM_FLOAT_SLOTS} slots`);
    let traps = 0;
    for (let slot = 0; slot < ROM_FLOAT_SLOTS; slot++) {
      const entry = dv.getUint32(table + slot * 4, true);
      const at = entry & ~1;
      if ((entry & 1) === 1 && (dv.getUint16(at, true) & 0xff00) === 0xbe00 && dv.getUint16(at + 2, true) === 0x4770) traps++;
    }
    check(traps === ROM_FLOAT_SLOTS, `every ${name} slot is a Thumb pointer to bkpt; bx lr (${traps})`);
  }
  check(dv.getUint8(0x13) === 3, `the ROM reports version 3, so the SDK takes every slot from the tables (${dv.getUint8(0x13)})`);
  // The flash writers are traps the runner answers (EEPROM.commit() needs them;
  // tests/boards.eepromInterrupts.mts runs it across a reset).
  for (const name of ['flash_range_erase', 'flash_range_program'] as const) {
    check(advertised.has(ROM_FUNC_CODES[name]), `${name} is advertised`);
  }
  // Nor is anything advertised that has no implementation behind it.
  for (const name of ['reset_usb_boot', 'wait_for_vector'] as const) {
    check(!advertised.has(ROM_FUNC_CODES[name]), `${name} is not advertised, because it is not implemented`);
  }
}

// ---------- 2. rp2040js is present, MIT, and ships no boot ROM ----------
const rp2040js = await loadRp2040js();
if (!rp2040js) {
  skip('rp2040js is not installed — engine sections cannot run');
} else {
  const { RP2040 } = rp2040js;
  const rp = new RP2040();
  check(rp.bootrom.length === 4096, `rp2040js allocates a 16 KB ROM region (${rp.bootrom.length} words)`);
  check(
    rp.bootrom.every((w: number) => w === 0),
    'rp2040js ships NO boot ROM image — the region is zero until we fill it',
  );
  check(typeof rp.loadBootrom === 'function', 'rp2040js exposes loadBootrom for a caller-supplied ROM');
}

// ---------- 3. Flash executes with a caller-supplied stub, no Pi ROM ----------
if (rp2040js) {
  const { RP2040 } = rp2040js;
  const rp = new RP2040();
  rp.logger = { debug() {}, info() {}, warn() {}, error() {} };
  rp.loadBootrom(buildBootStub().rom);

  // A hand-written Thumb program with a proper vector table.
  const img = new Uint8Array(0x200);
  const dv = new DataView(img.buffer);
  const entry = FLASH_BASE + 0x140;
  dv.setUint32(0x100, 0x20042000, true); // initial SP
  dv.setUint32(0x104, entry | 1, true); // reset handler
  dv.setUint16(0x140, 0x2001, true); // movs r0, #1
  dv.setUint16(0x142, 0x1c40, true); // adds r0, r0, #1
  dv.setUint16(0x144, 0xe7fd, true); // b .-2
  rp.flash.set(img, 0);

  rp.core.SP = rp.readUint32(FLASH_BASE + 0x100);
  rp.core.PC = rp.readUint32(FLASH_BASE + 0x104) & ~1;
  check(rp.core.SP === 0x20042000, `the stack pointer comes from the image's vector table (0x${rp.core.SP.toString(16)})`);
  check(rp.core.PC === entry, `the reset vector comes from the image's vector table (0x${rp.core.PC.toString(16)})`);

  for (let i = 0; i < 500; i++) rp.core.executeInstruction();
  check(rp.core.registers[0] > 100, `Thumb code really retires instructions from flash (r0 = ${rp.core.registers[0]})`);
  check(
    rp.core.PC >= FLASH_BASE && rp.core.PC < FLASH_BASE + 0x1000,
    `execution stays inside flash (PC = 0x${rp.core.PC.toString(16)})`,
  );

  // The ROM lookup path the SDK uses must resolve through our own stub.
  const stub = buildBootStub();
  const tableAddr = rp.readUint16(0x14);
  check(tableAddr === stub.functionTableAddress, 'firmware reading offset 0x14 finds our function table');
  check(rp.readUint16(tableAddr) === ROM_FUNC_CODES.memcpy, 'the first advertised routine is memcpy');
}

// ---------- 4. UF2 parsing rejects everything it should ----------
//
// This exercises the reader the harness and the application share, not a copy
// of it: a UF2 that is silently mis-parsed produces a firmware image whose
// failures look like simulator bugs.
{
  const makeBlock = (
    over: Partial<{ magic0: number; magic1: number; final: number; addr: number; len: number; family: number }> = {},
  ) => {
    const b = new Uint8Array(512);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, over.magic0 ?? 0x0a324655, true);
    dv.setUint32(4, over.magic1 ?? 0x9e5d5157, true);
    dv.setUint32(8, 0x2000, true);
    dv.setUint32(12, over.addr ?? FLASH_BASE, true);
    dv.setUint32(16, over.len ?? 256, true);
    dv.setUint32(28, over.family ?? RP2040_FAMILY_ID, true);
    dv.setUint32(508, over.final ?? 0x0ab16f30, true);
    return b;
  };

  const throws = (fn: () => unknown) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };

  check(!throws(() => parseUf2(makeBlock())), 'a well-formed RP2040 UF2 block parses');
  check(throws(() => parseUf2(makeBlock({ magic0: 0 }))), 'a bad first magic is rejected');
  check(throws(() => parseUf2(makeBlock({ magic1: 0 }))), 'a bad second magic is rejected');
  check(throws(() => parseUf2(makeBlock({ final: 0 }))), 'a bad final magic is rejected');
  check(throws(() => parseUf2(makeBlock({ family: 0x1c5f21b0 }))), 'a non-RP2040 family id is rejected');
  check(throws(() => parseUf2(makeBlock({ addr: 0x20000000 }))), 'an address outside flash is rejected');
  check(throws(() => parseUf2(makeBlock({ addr: FLASH_BASE + 0x1ffff00, len: 476 }))), 'a block running past the end of flash is rejected');
  check(throws(() => parseUf2(makeBlock({ len: 500 }))), 'an oversized payload is rejected');
  check(throws(() => parseUf2(new Uint8Array(300))), 'a truncated file is rejected');
  check(throws(() => parseUf2(new Uint8Array(0))), 'an empty file is rejected');
  // Intel HEX (the AVR artifact format) is text and must never parse as UF2.
  check(
    throws(() => parseUf2(new TextEncoder().encode(':100000000C9434000C943E000C943E000C943E0082\n'.repeat(16)))),
    'AVR Intel HEX is rejected outright',
  );
}

// ---------- 4b. The flash housekeeping routines resolve ----------
//
// flash_do_cmd_cs (the SDK's RAM-resident raw-flash-command routine) looks
// these three up through the ROM table before touching the SSI. Unresolved,
// it branches to address 0. They are no-ops here because the emulator has no
// physical QSPI device and no XIP cache — see bootStub.ts.
{
  const stub = buildBootStub();
  for (const name of ['connect_internal_flash', 'flash_exit_xip', 'flash_flush_cache', 'flash_enter_cmd_xip']) {
    check(typeof stub.functions[name] === 'number', `${name} has an implementation address`);
  }
  const dv = new DataView(new Uint8Array(stub.rom.buffer).buffer);
  const found = new Set<number>();
  for (let a = stub.functionTableAddress; dv.getUint16(a, true) !== 0; a += 4) found.add(dv.getUint16(a, true));
  for (const name of ['connect_internal_flash', 'flash_exit_xip', 'flash_flush_cache'] as const) {
    check(found.has(ROM_FUNC_CODES[name]), `${name} is advertised in the function table`);
  }
}

// ---------- 5. Real firmware ----------
//
// Real compiled firmware is executed in tests/rp2040.firmware.mts: six
// independently compiled sketches covering GPIO output on two pins at two
// intervals, GPIO input on the internal pull-up, the full GP0-GP28 range,
// UART transmission, reset and bounded execution. Duplicating a compile here
// would double the toolchain time for no additional coverage.

console.log(
  failures === 0
    ? `\nRP2040 spike checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
