// Chip-selected ROM dispatch.
//
// The C3 and C6 publish different functions at the same addresses. 0x400008A8
// is __ucmpdi2 on a C3 and __bswapsi2 on a C6; 0x40000044 is ets_install_putc1
// on one and ets_get_cpu_frequency on the other. A dispatcher that looked up a
// bare address globally would not fault on the wrong chip's firmware — it would
// call the wrong routine and the damage would surface much later looking like
// an emulator bug.
//
// So these cases check the one property that makes the arrangement safe: the
// address never determines the function on its own.

import {
  romTableFor,
  dispatchRom,
  isAbsentOnChip,
  WrongChipRomTableError,
} from '../src/simulation/esp32c6/romDispatch';
import { UnimplementedRomCallError, ESP32C3_ROM_FUNCTIONS } from '../src/simulation/esp32c3/romFunctions';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const c3 = romTableFor('esp32c3');
const c6 = romTableFor('esp32c6');

// ---------- 1. two tables, each knowing whose it is ----------
{
  check(c3.chip === 'esp32c3' && c6.chip === 'esp32c6', 'each table names its own chip');
  check(c3.entries.size >= 90, `the C3 table has ${c3.entries.size} entry points`);
  check(c6.entries.size >= 80, `the C6 table has ${c6.entries.size}`);
  check(c6.absent.size > 0, `and records ${c6.absent.size} functions the C6 does not publish`);
}

// ---------- 2. the same address, two chips, two functions ----------
{
  const collisions: { address: number; onC3: string; onC6: string }[] = [];
  for (const [address, entry] of c6.entries) {
    const other = c3.entries.get(address);
    if (other && other.name !== entry.name) {
      collisions.push({ address, onC3: other.name, onC6: entry.name });
    }
  }
  check(collisions.length > 0, `${collisions.length} addresses mean different things on the two chips`);

  for (const collision of collisions.slice(0, 3)) {
    const viaC3 = dispatchRom(c3, 'esp32c3', collision.address);
    const viaC6 = dispatchRom(c6, 'esp32c6', collision.address);
    check(
      viaC3.name === collision.onC3 && viaC6.name === collision.onC6,
      `0x${collision.address.toString(16)} dispatches to ${collision.onC3} on a C3 and ${collision.onC6} on a C6`,
    );
    check(viaC3.handler !== viaC6.handler, 'and to genuinely different implementations, not the same one twice');
  }
}

// ---------- 3. a table from the wrong chip is refused ----------
{
  let refusedC6OnC3: string | null = null;
  try {
    dispatchRom(c6, 'esp32c3', 0x40000354);
  } catch (error) {
    refusedC6OnC3 = error instanceof WrongChipRomTableError ? (error as Error).message : `wrong error: ${error}`;
  }
  check(refusedC6OnC3 !== null, 'a C6 table handed to a C3 machine is refused');
  check(/esp32c3/.test(refusedC6OnC3 ?? '') && /esp32c6/.test(refusedC6OnC3 ?? ''), 'naming both chips in the message');

  let refusedC3OnC6: string | null = null;
  try {
    dispatchRom(c3, 'esp32c6', 0x40000354);
  } catch (error) {
    refusedC3OnC6 = error instanceof WrongChipRomTableError ? (error as Error).message : `wrong error: ${error}`;
  }
  check(refusedC3OnC6 !== null, 'and a C3 table handed to a C6 machine likewise');

  // The refusal must not depend on the address being unknown: this one is a
  // real entry point on both chips.
  check(c3.entries.has(0x40000354) && c6.entries.has(0x400004a8), 'both tables really do hold these addresses');
}

// ---------- 4. an unknown address fails loudly ----------
{
  let failed = false;
  try {
    dispatchRom(c6, 'esp32c6', 0x40000354); // memset's C3 address, not its C6 one
  } catch (error) {
    failed = error instanceof UnimplementedRomCallError;
  }
  check(failed, "the C3's memset address is not a C6 entry point and is refused rather than guessed");

  let unknown = false;
  try {
    dispatchRom(c3, 'esp32c3', 0x4005fffc);
  } catch (error) {
    unknown = error instanceof UnimplementedRomCallError;
  }
  check(unknown, 'an address in no table at all fails loudly');
}

// ---------- 5. shared behaviour, chip-specific addresses ----------
//
// This is the arrangement the whole design exists for: one implementation of
// memset, answering at two different addresses.
{
  const byNameC3 = new Map([...c3.entries.values()].map((f) => [f.name, f]));
  const byNameC6 = new Map([...c6.entries.values()].map((f) => [f.name, f]));

  for (const name of ['memset', 'qsort', 'strlen', 'crc32_le', 'MD5Init']) {
    const onC3 = byNameC3.get(name);
    const onC6 = byNameC6.get(name);
    check(onC3 !== undefined && onC6 !== undefined, `${name} exists on both chips`);
    if (!onC3 || !onC6) continue;
    check(onC3.handler === onC6.handler, `${name} is one implementation shared by both`);
    check(
      onC3.address !== onC6.address,
      `at different addresses (C3 0x${onC3.address.toString(16)}, C6 0x${onC6.address.toString(16)})`,
    );
    check(
      dispatchRom(c6, 'esp32c6', onC6.address).name === name,
      `and the C6 address resolves to ${name}`,
    );
  }
}

// ---------- 6. functions the C6 does not publish ----------
{
  // The regi2c helpers, which the C6 publishes under no spelling at all: its
  // firmware reaches the analog master by writing MODEM_LPCON and I2C_ANA_MST
  // directly, so there is nothing to call.
  //
  // The interrupt-controller helpers were on this list until the C6's own
  // linker script showed them published as esprv_intc_int_*. They are checked
  // in the section below instead, by address.
  for (const name of ['esp_rom_regi2c_read', 'esp_rom_regi2c_write', 'esp_rom_efuse_get_flash_wp_gpio']) {
    check(isAbsentOnChip(c6, name), `${name} is recorded as absent on the C6`);
    const onC3 = ESP32C3_ROM_FUNCTIONS.find((f) => f.name === name);
    check(onC3 !== undefined, `while the C3 really does implement it`);
    if (!onC3) continue;
    // Its C3 address must not resolve to anything at all on a C6.
    let refused = false;
    try {
      dispatchRom(c6, 'esp32c6', onC3.address);
    } catch (error) {
      refused = error instanceof UnimplementedRomCallError;
    }
    check(refused, `and its C3 address resolves to nothing on a C6, rather than to a neighbour`);
  }
}

// ---------- 7. functions the C6 publishes under a different symbol ----------
//
// The same implementation must be reachable on both parts even where the two
// linker scripts spell the name differently, and it must be reachable at each
// chip's own address.
{
  for (const name of ['esprv_int_enable', 'esprv_int_set_threshold', 'esp_rom_set_cpu_ticks_per_us']) {
    check(!isAbsentOnChip(c6, name), `${name} is not recorded as absent on the C6`);
    const onC3 = ESP32C3_ROM_FUNCTIONS.find((f) => f.name === name);
    const onC6 = [...c6.entries.values()].find((f) => f.name === name);
    check(onC3 !== undefined && onC6 !== undefined, `and it is dispatchable on both parts`);
    if (!onC3 || !onC6) continue;
    check(onC3.handler === onC6.handler, `with one implementation serving both`);
    check(onC3.address !== onC6.address, `at different addresses (C3 0x${onC3.address.toString(16)}, C6 0x${onC6.address.toString(16)})`);
    check(dispatchRom(c6, 'esp32c6', onC6.address).name === name, `and the C6 address resolves to ${name}`);
  }
}

console.log(failures === 0 ? '\nESP32-C6 ROM dispatch checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
