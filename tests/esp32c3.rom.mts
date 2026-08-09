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
  installRomLayout,
  ETS_ROM_LAYOUT_ADDRESS,
  ETS_ROM_LAYOUT_POINTER,
  SOC_DRAM_HIGH,
  SOC_DRAM_LOW,
  SOC_ROM_STACK_START,
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

// ---------- 7. guest callbacks and qsort ----------
//
// qsort's comparator is firmware code, so the runtime has to be able to call
// into the guest and use the answer. These build tiny RISC-V comparators by
// hand and sort real arrays through the real ROM entry point.
{
  const { Esp32C3Machine } = await import('../src/simulation/esp32c3/esp32c3Machine');
  const machine = new Esp32C3Machine();

  // Somewhere to put code and data. IRAM and DRAM are both plain memory here.
  const CODE = 0x40381000;
  const DATA = 0x3fc81000;
  const emit = (address: number, words: number[]) => words.forEach((w, i) => machine.writeUint32(address + i * 4, w));

  // int ascending(const int *a, const int *b) { return *a - *b; }
  //   lw a2,0(a0); lw a3,0(a1); sub a0,a2,a3; ret
  const ASCENDING = CODE;
  emit(ASCENDING, [0x00052603, 0x0005a683, 0x40d60533, 0x00008067]);

  // int descending(const int *a, const int *b) { return *b - *a; }
  const DESCENDING = CODE + 0x100;
  emit(DESCENDING, [0x00052603, 0x0005a683, 0x40c68533, 0x00008067]);

  // A comparator on the low byte only, to prove element width is respected.
  //   lbu a2,0(a0); lbu a3,0(a1); sub a0,a2,a3; ret
  const BY_BYTE = CODE + 0x200;
  emit(BY_BYTE, [0x00054603, 0x0005c683, 0x40d60533, 0x00008067]);

  machine.core.registers[2] = 0x3fcde710;

  // The callback mechanism on its own, before qsort uses it.
  machine.writeUint32(DATA, 7);
  machine.writeUint32(DATA + 4, 3);
  const direct = machine.callGuestFunction(ASCENDING, [DATA, DATA + 4]);
  check(direct.value === 4, `a guest callback returns its own result (${direct.value})`);
  check(direct.instructions === 4, `the callback really executed its instructions (${direct.instructions})`);

  // Caller state must survive: a ROM function is mid-flight when this happens.
  machine.core.registers[5] = 0x1234;
  machine.core.pc = 0x40382000;
  const savedSp = machine.core.registers[2];
  machine.callGuestFunction(DESCENDING, [DATA, DATA + 4]);
  check(machine.core.registers[5] === 0x1234, 'a callback leaves the caller\'s registers untouched');
  check(machine.core.pc === 0x40382000, 'a callback leaves the caller\'s program counter untouched');
  check(machine.core.registers[2] === savedSp, 'a callback restores the stack pointer');

  // A runaway callback is stopped rather than hanging the run.
  const SPIN = CODE + 0x300;
  emit(SPIN, [0x0000006f]); // j .
  let spun = false;
  try {
    machine.callGuestFunction(SPIN, [], { maxInstructions: 500 });
  } catch (err) {
    spun = err instanceof Error && /did not return/.test(err.message);
  }
  check(spun, 'a callback that never returns is abandoned with an explanation');
  check(machine.core.pc === 0x40382000, 'even an abandoned callback restores the caller');

  /** Sorts an array of 32-bit words through the real ROM qsort entry. */
  const sortWords = (values: number[], comparator: number): number[] => {
    values.forEach((v, i) => machine.writeUint32(DATA + i * 4, v));
    const entry = ESP32C3_ROM_FUNCTIONS.find((f) => f.name === 'qsort')!;
    entry.handler({
      args: [DATA, values.length, 4, comparator, 0, 0],
      bus: machine,
      machine: machine.romState,
      registers: machine.core.registers,
      callGuest: (address, callArgs, options) => machine.callGuestFunction(address, callArgs, options),
    });
    return values.map((_, i) => machine.readUint32(DATA + i * 4) | 0);
  };

  check(
    sortWords([5, 3, 9, 1, 7], ASCENDING).join(',') === '1,3,5,7,9',
    `qsort orders by the firmware's comparator (${sortWords([5, 3, 9, 1, 7], ASCENDING).join(',')})`,
  );
  check(
    sortWords([5, 3, 9, 1, 7], DESCENDING).join(',') === '9,7,5,3,1',
    'a different comparator gives a different order, so the ordering is genuinely the firmware\'s',
  );
  check(sortWords([4, 4, 4], ASCENDING).join(',') === '4,4,4', 'equal elements are handled');
  check(sortWords([1, 2, 3, 4], ASCENDING).join(',') === '1,2,3,4', 'an already sorted array is left alone');
  check(sortWords([9, 8, 7, 6, 5, 4, 3, 2, 1], ASCENDING).join(',') === '1,2,3,4,5,6,7,8,9', 'a fully reversed array sorts');
  check(sortWords([42], ASCENDING).join(',') === '42', 'a single element is a no-op');
  check(sortWords([-5, 3, -1], ASCENDING).join(',') === '-5,-1,3', 'negative values sort correctly');

  // Nothing outside the array may be touched — the bug that corrupted a
  // caller's neighbouring data and made ESP-IDF report an impossible memory
  // region overlap.
  const GUARD = DATA + 0x100;
  machine.writeUint32(GUARD, 0xdeadbeef);
  machine.writeUint32(GUARD + 4, 0xfeedface);
  sortWords([3, 1, 2], ASCENDING);
  check(machine.readUint32(GUARD) === 0xdeadbeef, 'qsort writes nothing past the end of the array');
  check(machine.readUint32(GUARD + 4) === 0xfeedface, 'and nothing further past it either');

  // Element width is honoured: sorting bytes must move bytes, not words.
  for (let i = 0; i < 4; i++) machine.writeUint8(DATA + i, [4, 2, 3, 1][i]);
  const qsortEntry = ESP32C3_ROM_FUNCTIONS.find((f) => f.name === 'qsort')!;
  qsortEntry.handler({
    args: [DATA, 4, 1, BY_BYTE, 0, 0],
    bus: machine,
    machine: machine.romState,
    registers: machine.core.registers,
    callGuest: (address, callArgs, options) => machine.callGuestFunction(address, callArgs, options),
  });
  check(
    [0, 1, 2, 3].map((i) => machine.readUint8(DATA + i)).join(',') === '1,2,3,4',
    `qsort respects an element width of one byte (${[0, 1, 2, 3].map((i) => machine.readUint8(DATA + i)).join(',')})`,
  );
}

// ---------- 8. the ROM layout structure ESP-IDF reads before creating the heap ----------
//
// This reproduces the exact failure it fixes. ESP-IDF's
// soc_get_available_memory_regions() reserves
// [ets_rom_layout_p->dram0_rtos_reserved_start, SOC_DRAM_HIGH). With no
// structure present, the pointer reads zero, the dereference reads address 4,
// and the reservation comes out as [0, SOC_DRAM_HIGH) — a region covering all
// of memory, which overlaps every other reservation and panics startup.
{
  /** What ESP-IDF actually computes, expressed as the two loads it performs. */
  const readReservedStart = (bus: Bus): number => {
    const layout = bus.readUint32(ETS_ROM_LAYOUT_POINTER);
    return bus.readUint32((layout + 4) >>> 0);
  };

  const bare = new Memory();
  check(
    readReservedStart(bare) === 0,
    'without the structure the reservation starts at 0x00000000 — the panic this fixes',
  );

  const memory = new Memory();
  installRomLayout(memory);

  const pointer = memory.readUint32(ETS_ROM_LAYOUT_POINTER);
  check(pointer === ETS_ROM_LAYOUT_ADDRESS, 'ets_rom_layout_p points at the installed structure');

  const reservedStart = readReservedStart(memory);
  check(reservedStart !== 0, 'the reserved region no longer starts at zero');
  check(
    reservedStart > SOC_DRAM_LOW && reservedStart < SOC_DRAM_HIGH,
    `dram0_rtos_reserved_start lies inside DRAM (0x${reservedStart.toString(16)})`,
  );
  check(
    reservedStart === SOC_ROM_STACK_START,
    'and equals the documented ROM stack start, the boundary above which ROM memory sits',
  );

  // The reservation must leave usable heap below it, or startup would find no
  // memory even though the check passed.
  check(SOC_ROM_STACK_START - SOC_DRAM_LOW > 0x30000, 'the reservation leaves the bulk of DRAM allocatable');

  // The ROM stack itself has to sit inside the region being reserved,
  // otherwise the heap would be handed memory the ROM is still using.
  const stackSentry = memory.readUint32((pointer + 8) >>> 0);
  const stackTop = memory.readUint32((pointer + 12) >>> 0);
  check(stackSentry < SOC_ROM_STACK_START, 'the stack sentry is below the reserved boundary');
  check(stackTop <= SOC_DRAM_HIGH, 'the stack top is within DRAM');

  // Every field is populated, so a firmware reading a later one gets a
  // defined address rather than whatever happened to be in memory.
  let unset = 0;
  for (let i = 0; i < 40; i++) {
    if (memory.readUint32((pointer + i * 4) >>> 0) === 0) unset++;
  }
  check(unset === 0, `all ${40} layout fields are populated (${unset} left at zero)`);
}

console.log(failures === 0 ? '\nESP32-C3 ROM checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
