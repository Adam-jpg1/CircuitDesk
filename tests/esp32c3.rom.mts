// The ESP32-C3 ROM functions, tested directly against their ABI.
//
// These run before any firmware does, so a later firmware failure is a
// firmware or peripheral problem rather than a ROM one. Every case exercises
// the documented contract, not the one value a particular sketch happens to
// need.

import {
  ESP32C3_ROM_FUNCTIONS,
  buildRomTable,
  createRomMachineState,
  isRomAddress,
  regi2cKey,
  ResetReason,
  ROM_START,
  ROM_END,
  UnimplementedRomCallError,
  type RomFunction,
} from '../src/simulation/esp32c3/romFunctions';
import type { Bus } from '../src/simulation/riscv/rv32Core';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

class Memory implements Bus {
  readonly bytes = new Uint8Array(0x10000);
  readUint8(a: number) {
    return this.bytes[a & 0xffff];
  }
  readUint16(a: number) {
    return this.bytes[a & 0xffff] | (this.bytes[(a + 1) & 0xffff] << 8);
  }
  readUint32(a: number) {
    return (this.readUint16(a) | (this.readUint16(a + 2) << 16)) >>> 0;
  }
  writeUint8(a: number, v: number) {
    this.bytes[a & 0xffff] = v & 0xff;
  }
  writeUint16(a: number, v: number) {
    this.writeUint8(a, v);
    this.writeUint8(a + 1, v >> 8);
  }
  writeUint32(a: number, v: number) {
    this.writeUint16(a, v);
    this.writeUint16(a + 2, v >>> 16);
  }
}

const table = buildRomTable();
const byName = (name: string): RomFunction => {
  const found = ESP32C3_ROM_FUNCTIONS.find((f) => f.name === name);
  if (!found) throw new Error(`no ROM function named ${name}`);
  return found;
};

/** Calls a ROM function the way the runtime will: arguments in, a0 out. */
function call(name: string, args: number[], state = createRomMachineState(), bus: Bus = new Memory()): number {
  const result = byName(name).handler({ args, bus, machine: state });
  return typeof result === 'number' ? result >>> 0 : 0;
}

// ---------- 1. the table itself ----------
{
  check(ESP32C3_ROM_FUNCTIONS.length >= 5, `the five traced startup functions are provided (${ESP32C3_ROM_FUNCTIONS.length} entries)`);
  for (const name of [
    'esp_rom_get_reset_reason',
    'memset',
    'Cache_Enable_ICache',
    'Cache_Set_IDROM_MMU_Size',
    'esp_rom_regi2c_write_mask',
  ]) {
    const fn = ESP32C3_ROM_FUNCTIONS.find((f) => f.name === name);
    check(!!fn, `${name} is implemented`);
    check(!!fn && isRomAddress(fn.address), `${name} sits in the ROM address range`);
    check(!!fn && fn.rationale.length > 20, `${name} records why its implementation is correct`);
  }
  check(table.size === ESP32C3_ROM_FUNCTIONS.length, 'every entry is reachable by address');
  check(isRomAddress(ROM_START) && !isRomAddress(ROM_END), 'the ROM range is half-open');
  check(!isRomAddress(0x42000000), 'a flash-mapped address is not mistaken for ROM');
  check(!isRomAddress(0x3fc80000), 'a DRAM address is not mistaken for ROM');

  // Addresses must be distinct, or one entry would shadow another.
  check(new Set(ESP32C3_ROM_FUNCTIONS.map((f) => f.address)).size === ESP32C3_ROM_FUNCTIONS.length, 'no two entries share an address');
}

// ---------- 2. esp_rom_get_reset_reason ----------
{
  check(call('esp_rom_get_reset_reason', [0]) === ResetReason.PowerOn, 'a freshly powered machine reports a power-on reset');

  // The point of tracking state rather than returning a constant.
  const afterSoftware = createRomMachineState(ResetReason.SwSys);
  check(
    call('esp_rom_get_reset_reason', [0], afterSoftware) === ResetReason.SwSys,
    'a software reset is reported as a software reset, not as power-on',
  );
  check(ResetReason.PowerOn !== ResetReason.SwSys, 'the two reasons are distinguishable');
  // The argument is the CPU index; a single-core part answers the same either way.
  check(call('esp_rom_get_reset_reason', [1]) === ResetReason.PowerOn, 'the CPU argument does not change the answer on a single-core part');
}

// ---------- 3. memset, in full generality ----------
{
  const bus = new Memory();
  const state = createRomMachineState();

  check(call('memset', [0x100, 0xa5, 16], state, bus) === 0x100, 'memset returns the destination pointer');
  check(
    [...bus.bytes.slice(0x100, 0x110)].every((b) => b === 0xa5),
    'memset fills the requested range',
  );
  check(bus.bytes[0x0ff] === 0 && bus.bytes[0x110] === 0, 'memset writes nothing outside the range');

  // Unaligned start and unaligned length.
  call('memset', [0x201, 0x3c, 7], state, bus);
  check(bus.bytes[0x200] === 0, 'an unaligned memset leaves the byte before it alone');
  check(
    [...bus.bytes.slice(0x201, 0x208)].every((b) => b === 0x3c),
    'an unaligned memset fills every byte it should',
  );
  check(bus.bytes[0x208] === 0, 'an unaligned memset stops where it should');

  // Zero length must write nothing at all.
  bus.bytes[0x300] = 0x11;
  check(call('memset', [0x300, 0xff, 0], state, bus) === 0x300, 'a zero-length memset still returns the destination');
  check(bus.bytes[0x300] === 0x11, 'a zero-length memset writes nothing');

  // Only the low byte of the value is used, as C specifies.
  call('memset', [0x400, 0x1234, 4], state, bus);
  check(
    [...bus.bytes.slice(0x400, 0x404)].every((b) => b === 0x34),
    'memset uses only the low byte of the value',
  );

  // A value of zero is the common case and must actually clear.
  bus.bytes.fill(0xee, 0x500, 0x520);
  call('memset', [0x500, 0, 0x20], state, bus);
  check(
    [...bus.bytes.slice(0x500, 0x520)].every((b) => b === 0),
    'memset with zero clears the range',
  );

  // A length spanning several words, to catch an off-by-one in a chunked loop.
  call('memset', [0x600, 0x7f, 37], state, bus);
  check(bus.bytes[0x600] === 0x7f && bus.bytes[0x624] === 0x7f && bus.bytes[0x625] === 0, 'memset handles a length that is not a multiple of four');
}

// ---------- 4. the cache calls, and why they are no-ops ----------
{
  const state = createRomMachineState();
  check(!state.cache.iCacheEnabled, 'the instruction cache starts disabled, as it does at reset');
  call('Cache_Enable_ICache', [0], state);
  check(state.cache.iCacheEnabled, 'the call is recorded rather than silently ignored');

  call('Cache_Set_IDROM_MMU_Size', [0x10000, 0x8000], state);
  check(state.cache.iromMmuSize === 0x10000, `the IROM size is stored as architectural state (0x${state.cache.iromMmuSize.toString(16)})`);
  check(state.cache.dromMmuSize === 0x8000, `the DROM size is stored too (0x${state.cache.dromMmuSize.toString(16)})`);

  // Neither call may touch memory: the abstraction is that no translation is
  // needed, not that these functions do something invisible.
  const bus = new Memory();
  const before = bus.bytes.slice(0, 64).join(',');
  call('Cache_Enable_ICache', [1], state, bus);
  call('Cache_Set_IDROM_MMU_Size', [0x4000, 0x4000], state, bus);
  check(bus.bytes.slice(0, 64).join(',') === before, 'the cache calls write nothing to memory');
}

// ---------- 5. esp_rom_regi2c_write_mask and its read side ----------
//
// The one that is genuinely not a no-op: startup configures the analog blocks
// through it and reads the values back.
{
  const state = createRomMachineState();
  const XTAL_BLOCK = 0x6d;
  const PLL_BLOCK = 0x67;

  // A whole-byte field.
  call('esp_rom_regi2c_write_mask', [XTAL_BLOCK, 0, 0x05, 7, 0, 0xa7], state);
  check(
    call('esp_rom_regi2c_read', [XTAL_BLOCK, 0, 0x05], state) === 0xa7,
    'a full-width masked write is read back whole',
  );

  // A narrow field must leave its neighbours untouched.
  call('esp_rom_regi2c_write_mask', [XTAL_BLOCK, 0, 0x05, 3, 2, 0x2], state);
  const merged = call('esp_rom_regi2c_read', [XTAL_BLOCK, 0, 0x05], state);
  check(merged === ((0xa7 & ~0x0c) | 0x08), `a narrow field merges into the existing byte (0x${merged.toString(16)})`);
  check(
    call('esp_rom_regi2c_read_mask', [XTAL_BLOCK, 0, 0x05, 3, 2], state) === 0x2,
    'the same field reads back through the masked read',
  );
  check(
    call('esp_rom_regi2c_read_mask', [XTAL_BLOCK, 0, 0x05, 7, 6], state) === ((0xa7 >> 6) & 0x3),
    'a neighbouring field is unchanged',
  );

  // Registers and blocks are independent.
  call('esp_rom_regi2c_write_mask', [PLL_BLOCK, 0, 0x05, 7, 0, 0x11], state);
  check(call('esp_rom_regi2c_read', [XTAL_BLOCK, 0, 0x05], state) === merged, 'a write to another block leaves this one alone');
  call('esp_rom_regi2c_write_mask', [XTAL_BLOCK, 0, 0x06, 7, 0, 0x22], state);
  check(call('esp_rom_regi2c_read', [XTAL_BLOCK, 0, 0x05], state) === merged, 'a write to another register leaves this one alone');
  check(regi2cKey(XTAL_BLOCK, 0x05) !== regi2cKey(PLL_BLOCK, 0x05), 'block and register together identify a location');

  // A single bit, which is what most clock configuration actually writes.
  call('esp_rom_regi2c_write_mask', [PLL_BLOCK, 0, 0x08, 4, 4, 1], state);
  check(call('esp_rom_regi2c_read_mask', [PLL_BLOCK, 0, 0x08, 4, 4], state) === 1, 'a single-bit field can be set');
  call('esp_rom_regi2c_write_mask', [PLL_BLOCK, 0, 0x08, 4, 4, 0], state);
  check(call('esp_rom_regi2c_read_mask', [PLL_BLOCK, 0, 0x08, 4, 4], state) === 0, 'and cleared again');

  // The whole-byte write form shares the same file.
  call('esp_rom_regi2c_write', [PLL_BLOCK, 0, 0x09, 0x5a], state);
  check(call('esp_rom_regi2c_read', [PLL_BLOCK, 0, 0x09], state) === 0x5a, 'the plain write form lands in the same register file');

  // An unread register reads as zero rather than undefined.
  check(call('esp_rom_regi2c_read', [PLL_BLOCK, 0, 0x7f], state) === 0, 'an untouched register reads as zero');

  // A nonsensical field is ignored rather than corrupting the byte.
  call('esp_rom_regi2c_write_mask', [PLL_BLOCK, 0, 0x09, 2, 5, 0xff], state);
  check(call('esp_rom_regi2c_read', [PLL_BLOCK, 0, 0x09], state) === 0x5a, 'an inverted bit range is rejected, not applied');
}

// ---------- 6. an unimplemented ROM call is refused with a usable message ----------
{
  const error = new UnimplementedRomCallError(0x40001234, 'ets_printf', 0x42000010);
  check(error.message.includes('0x40001234'), 'the error names the address');
  check(error.message.includes('ets_printf'), 'the error names the symbol when one is known');
  check(/licen[cs]/i.test(error.message), 'the error explains why the ROM is not simply included');
  check(!table.has(0x40001234), 'an address with no implementation is genuinely absent from the table');
}

console.log(failures === 0 ? '\nESP32-C3 ROM checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
