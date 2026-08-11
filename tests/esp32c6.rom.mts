// The ESP32-C6's ROM entry points, checked against the C3's.
//
// The temptation with two Espressif RISC-V parts is to reuse one ROM table for
// both. These cases exist to make that impossible to do by accident.
//
// The first draft of this file asserted that no C6 address coincides with a C3
// one. The data disproved it: several C6 entry points land exactly on a C3
// entry point belonging to a different function. That is worse than a clash,
// not better — using the wrong table would not fault, it would silently call
// the wrong routine — so the assertion was inverted to record the hazard
// instead of denying it.

import { ESP32C6_ROM_ADDRESSES, NOT_PUBLISHED_ON_C6 } from '../src/simulation/esp32c6/romAddresses';
import { ESP32C3_ROM_FUNCTIONS, ROM_START, ROM_END } from '../src/simulation/esp32c3/romFunctions';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const c3ByName = new Map(ESP32C3_ROM_FUNCTIONS.map((f) => [f.name, f.address]));
const c6 = Object.entries(ESP32C6_ROM_ADDRESSES);

// ---------- 1. the table is real ----------
{
  check(c6.length >= 70, `the C6 table has entries for ${c6.length} functions`);
  check(
    c6.every(([, address]) => address >= ROM_START && address < ROM_END),
    'every C6 address lies inside the mask-ROM window',
  );
  check(
    c6.every(([, address]) => address % 4 === 0),
    'and every one is word-aligned, as an entry point must be',
  );

  const addresses = c6.map(([, a]) => a);
  check(new Set(addresses).size === addresses.length, 'no two functions share an address');
}

// ---------- 2. the C6 is not the C3 ----------
{
  const shared = c6.filter(([name]) => c3ByName.has(name));
  check(shared.length >= 60, `${shared.length} functions are implemented for both parts`);

  // Nearly all of them move. A handful genuinely do not, which is a fact of
  // the two ROM layouts rather than a mistake, so the assertion is that the
  // overwhelming majority differ — not that none coincides.
  const identical = shared.filter(([name, address]) => c3ByName.get(name) === address);
  check(
    identical.length <= 2,
    `all but ${identical.length} of them move between the two chips (${identical.map(([n]) => n).join(', ') || 'none stayed'})`,
  );
  check(
    shared.length - identical.length >= 55,
    `${shared.length - identical.length} shared functions sit at different addresses on the two parts`,
  );

  // The two named in the table's own comment, so a regeneration that quietly
  // reverted to C3 values would be caught by name.
  check(ESP32C6_ROM_ADDRESSES.memset === 0x400004a8, `memset is at 0x400004a8 on the C6 (0x${ESP32C6_ROM_ADDRESSES.memset?.toString(16)})`);
  check(c3ByName.get('memset') === 0x40000354, 'and at 0x40000354 on the C3');
  check(ESP32C6_ROM_ADDRESSES.qsort === 0x40000588, `qsort is at 0x40000588 on the C6 (0x${ESP32C6_ROM_ADDRESSES.qsort?.toString(16)})`);
  check(c3ByName.get('qsort') === 0x40000434, 'and at 0x40000434 on the C3');

  // Some C6 addresses land exactly on a C3 entry point belonging to a
  // *different* function. That is the dangerous case and it is real: using the
  // wrong table would not fault, it would silently call the wrong routine. The
  // test records that this hazard exists, because it is the whole reason the
  // table has to be selected by chip rather than shared.
  const c3ByAddress = new Map(ESP32C3_ROM_FUNCTIONS.map((f) => [f.address, f.name]));
  const crossed = c6.filter(([name, a]) => c3ByAddress.has(a) && c3ByAddress.get(a) !== name);
  check(
    crossed.length > 0,
    `C6 addresses that are a different function on the C3 exist, so the tables can never be shared ` +
      `(${crossed.map(([n, a]) => `${n}=${c3ByAddress.get(a)}`).slice(0, 4).join(', ')}…)`,
  );
}

// ---------- 3. functions the C6 does not publish ----------
{
  check(NOT_PUBLISHED_ON_C6.length > 0, `${NOT_PUBLISHED_ON_C6.length} C3 functions are recorded as absent on the C6`);
  check(
    NOT_PUBLISHED_ON_C6.every((name) => !(name in ESP32C6_ROM_ADDRESSES)),
    'and none of them was given an address anyway',
  );
  check(
    NOT_PUBLISHED_ON_C6.every((name) => c3ByName.has(name)),
    'each names a function the C3 runtime really does implement',
  );

  // The interrupt controller is the clearest case: the C6's is a different
  // block, so the C3's esprv_int_* entry points have no counterpart.
  for (const name of ['esprv_int_enable', 'esprv_int_set_threshold']) {
    check(NOT_PUBLISHED_ON_C6.includes(name), `${name} is recorded as absent rather than reused`);
  }
}

// ---------- 4. the aliases the C6 publishes under older names ----------
{
  // The C6 exports the classic ets_/uart_ names where the C3 exports newer
  // esp_rom_ ones. Recording them under the name the runtime implements lets
  // one implementation serve both without renaming anything.
  for (const name of ['esp_rom_delay_us', 'esp_rom_printf', 'esp_rom_get_reset_reason']) {
    check(typeof ESP32C6_ROM_ADDRESSES[name] === 'number', `${name} has a C6 address through its older published name`);
    check(ESP32C6_ROM_ADDRESSES[name] > 0, `and it resolves to a real entry point`);
  }

  // rtc_get_reset_reason is where real C6 firmware stops first, so it has to
  // be present and has to be the address the spike observed.
  check(
    ESP32C6_ROM_ADDRESSES.esp_rom_get_reset_reason === 0x40000018,
    `the first ROM call real C6 firmware makes is mapped (0x${ESP32C6_ROM_ADDRESSES.esp_rom_get_reset_reason?.toString(16)})`,
  );
}

console.log(failures === 0 ? '\nESP32-C6 ROM address checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
