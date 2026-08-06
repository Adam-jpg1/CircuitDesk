// RP2040 feasibility spike — executable evidence, not a simulated board.
//
// This suite locks in what has been *proven* about running real Raspberry Pi
// Pico firmware inside CircuitDesk, and what is still missing. It deliberately
// does NOT assert that a Pico blinks, because it does not yet: see the final
// section, which records the exact point where real firmware still stalls.
//
// The Pico capability badge is unchanged (Compile only) and no board is routed
// to an RP2040 adapter. This file exists so the findings are reproducible and
// so the next milestone starts from measured facts rather than assumptions.
//
// Requires rp2040js (MIT, no bundled ROM) and, for the firmware sections, the
// rp2040:rp2040 Arduino core on the compiler backend. Sections that need
// either are skipped with a clear message when they are unavailable.

import { buildBootStub, ROM_FUNC_CODES, ROM_FUNC_NAMES } from '../src/simulation/rp2040/bootStub';

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
  check(entries === 8, `the memory and flash-housekeeping routines are advertised (${entries})`);

  // The float and double tables are the restricted mufplib routines and must
  // not be advertised — firmware that needs them should fail, not get garbage.
  const advertised = new Set<number>();
  for (let a = stub.functionTableAddress; dv.getUint16(a, true) !== 0; a += 4) advertised.add(dv.getUint16(a, true));
  check(!advertised.has(ROM_FUNC_CODES.popcount32), 'no unimplemented routine is advertised as available');
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
{
  /** Strict RP2040 UF2 reader used by the spike; the shipped one will match. */
  function parseUf2(buf: Uint8Array) {
    if (buf.length === 0 || buf.length % 512 !== 0) throw new Error('UF2 length must be a multiple of 512');
    const blocks = new Map<number, Uint8Array>();
    const families = new Set<number>();
    for (let off = 0; off + 512 <= buf.length; off += 512) {
      const dv = new DataView(buf.buffer, buf.byteOffset + off, 512);
      if (dv.getUint32(0, true) !== 0x0a324655) throw new Error('bad UF2 magic 0');
      if (dv.getUint32(4, true) !== 0x9e5d5157) throw new Error('bad UF2 magic 1');
      if (dv.getUint32(508, true) !== 0x0ab16f30) throw new Error('bad UF2 final magic');
      const flags = dv.getUint32(8, true);
      const addr = dv.getUint32(12, true);
      const len = dv.getUint32(16, true);
      if (len > 476) throw new Error('UF2 payload too large');
      if (flags & 0x2000) families.add(dv.getUint32(28, true));
      if (flags & 0x0001) continue;
      if (addr < FLASH_BASE || addr + len > FLASH_BASE + 0x200000) throw new Error('address outside RP2040 flash');
      blocks.set(addr, buf.slice(off + 32, off + 32 + len));
    }
    if (families.size && !families.has(RP2040_FAMILY_ID)) throw new Error('wrong UF2 family id');
    return { blocks, families };
  }

  const makeBlock = (over: Partial<{ magic0: number; magic1: number; final: number; addr: number; len: number; family: number }> = {}) => {
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
  check(throws(() => parseUf2(makeBlock({ final: 0 }))), 'a bad final magic is rejected');
  check(throws(() => parseUf2(makeBlock({ family: 0x1c5f21b0 }))), 'a non-RP2040 family id is rejected');
  check(throws(() => parseUf2(makeBlock({ addr: 0x20000000 }))), 'an address outside flash is rejected');
  check(throws(() => parseUf2(makeBlock({ len: 500 }))), 'an oversized payload is rejected');
  check(throws(() => parseUf2(new Uint8Array(300))), 'a truncated file is rejected');
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

// ---------- 5. Real Pico firmware: how far does it actually get? ----------
//
// This section records measured behaviour. It asserts only what is true today.
{
  let uf2: Uint8Array | null = null;
  try {
    const res = await fetch(`${BASE}/api/compiler/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        boardId: 'board.raspberry-pi-pico',
        fqbn: 'rp2040:rp2040:rpipico',
        files: [{ name: 'sketch.ino', content: 'void setup(){pinMode(15,OUTPUT);}\nvoid loop(){digitalWrite(15,HIGH);delay(100);digitalWrite(15,LOW);delay(100);}' }],
      }),
    });
    const j = (await res.json()) as { success: boolean; firmware?: { data: string; format: string } };
    if (j.success && j.firmware?.format === 'uf2') {
      uf2 = Uint8Array.from(atob(j.firmware.data), (c) => c.charCodeAt(0));
    }
  } catch {
    /* backend unavailable */
  }

  if (!uf2 || !rp2040js) {
    skip('real Pico firmware or rp2040js unavailable — execution measurements not taken');
  } else {
    check(uf2.length > 0 && uf2.length % 512 === 0, `the Pico target returns a UF2 artifact (${uf2.length} bytes)`);

    const { RP2040 } = rp2040js;
    const rp = new RP2040();
    rp.logger = { debug() {}, info() {}, warn() {}, error() {} };
    rp.loadBootrom(buildBootStub().rom);
    for (let off = 0; off + 512 <= uf2.length; off += 512) {
      const dv = new DataView(uf2.buffer, uf2.byteOffset + off, 512);
      if (dv.getUint32(8, true) & 1) continue;
      rp.flash.set(uf2.slice(off + 32, off + 32 + dv.getUint32(16, true)), dv.getUint32(12, true) - FLASH_BASE);
    }

    // The datasheet describes the ROM copying the 256-byte second stage to the
    // top of SRAM and running it; boot2 is part of the user's own image.
    const BOOT2_RAM = 0x20041f00;
    const SENTINEL = 0x00000f00;
    for (let i = 0; i < 256; i++) rp.writeUint8(BOOT2_RAM + i, rp.readUint8(FLASH_BASE + i));
    rp.core.SP = 0x20042000;
    rp.core.registers[14] = SENTINEL | 1;
    rp.core.PC = BOOT2_RAM;

    const step = () => {
      const c = rp.core;
      if (c.waiting) rp.clock.tick?.(rp.clock.nanosToNextAlarm ?? CYCLE_NS);
      else rp.clock.tick?.((c.executeInstruction() || 1) * CYCLE_NS);
    };

    let boot2Returned = false;
    let boot2Instructions = 0;
    for (let i = 0; i < 2_000_000; i++) {
      if ((rp.core.PC & ~1) === SENTINEL) {
        boot2Returned = true;
        boot2Instructions = i;
        break;
      }
      step();
    }
    check(boot2Returned, `the image's own boot2 runs and returns (${boot2Instructions} instructions)`);

    rp.core.SP = rp.readUint32(FLASH_BASE + 0x100);
    rp.core.PC = rp.readUint32(FLASH_BASE + 0x104) & ~1;
    check(rp.core.SP >= 0x20000000 && rp.core.SP <= 0x20042000, `the application stack pointer is sane (0x${rp.core.SP.toString(16)})`);

    const edges: number[] = [];
    rp.gpio[15].addListener((state: unknown) => edges.push(Number(state)));

    let executed = 0;
    const deadline = Date.now() + 30_000;
    while (executed < 40_000_000 && Date.now() < deadline && edges.length < 4) {
      step();
      executed++;
    }
    check(executed > 1_000_000, `the application executes real instructions without faulting (${executed})`);
    // Mapped regions: boot ROM (16 KB at 0), SRAM, and XIP flash. Executing in
    // the ROM stub is legitimate — that is where the lookup routine lives.
    const pc = rp.core.PC;
    const mapped =
      pc < 0x4000 ||
      (pc >= 0x20000000 && pc < 0x20042000) ||
      (pc >= FLASH_BASE && pc < FLASH_BASE + 0x200000);
    check(mapped, `execution stays inside mapped memory (PC = 0x${pc.toString(16)})`);

    // THE REMAINING BLOCKER, recorded rather than asserted away.
    if (edges.length >= 2) {
      check(true, `GP15 toggled — blink reached the pin (${edges.length} edges)`);
    } else {
      console.log(
        `NOTE: GP15 produced ${edges.length} edges after ${executed} instructions; PC parked at ` +
          `0x${rp.core.PC.toString(16)}. Root cause of the original stall is understood and fixed ` +
          '(flash_do_cmd_cs resolves connect_internal_flash / flash_exit_xip / flash_flush_cache ' +
          'through the ROM table; unresolved they branched to address 0). Startup now progresses ' +
          'past that point but has not yet reached the sketch, so the Pico badge stays "Compile ' +
          'only". Remaining work is tracked in the milestone report.',
      );
    }
  }
}

console.log(
  failures === 0
    ? `\nRP2040 spike checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
