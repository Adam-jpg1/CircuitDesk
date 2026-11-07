// ESP.restart(), a crash, and what survives them, on the ESP32 family.
//
// Wi-Fi sketches restart the board all the time — after a failed connection,
// after saving new settings — and expect Preferences to still be there. Before
// this was checked: the ESP32 read its NVS pages from the wrong flash address
// (quad-I/O reads carry mode bits after the address), so Preferences never
// found what they had written; and the C3 and C6 stopped at ROM routines the
// restart path calls. Checked here, on compiled firmware, for each board:
//   * ESP.restart() reboots the sketch, and Preferences keep their value;
//   * esp_reset_reason() says it was a software restart (ESP_RST_SW);
//   * abort() prints the core's panic report and the board reboots after it,
//     reporting a panic (ESP_RST_PANIC).
// The ESP8266's restarts are checked in tests/esp8266.runtime.mts.

import { compileProject } from '../server/compiler/compilerService';
import { detectArduinoCli } from '../server/compiler/arduinoCli';
import { getSimulatorAdapter } from '../src/simulation/adapters';
import { getBoardDefinition } from '../src/boards/definitions';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const cli = await detectArduinoCli();
if (!cli.available) {
  console.log('SKIP: arduino-cli is not available here');
  process.exit(0);
}

const SKETCH = `#include <Preferences.h>
Preferences prefs;
void setup() {
  Serial.begin(115200);
  prefs.begin("boots", false);
  int n = prefs.getInt("n", 0) + 1;
  prefs.putInt("n", n);
  prefs.end();
  Serial.printf("boot %d reason %d\\n", n, (int)esp_reset_reason());
  delay(200);
  if (n < 3) ESP.restart();
  if (n == 3) abort();
}
void loop() { delay(100); }`;

// esp_reset_reason_t
const ESP_RST_POWERON = 1;
const ESP_RST_SW = 3;
const ESP_RST_PANIC = 4;

const BOARDS = [
  ['board.esp32-devkit', 'esp32:esp32:esp32'],
  ['board.esp32-s3', 'esp32:esp32:esp32s3'],
  ['board.esp32-c3', 'esp32:esp32:esp32c3'],
  ['board.esp32-c6-devkitc-1', 'esp32:esp32:esp32c6'],
] as const;

for (const [id, fqbn] of BOARDS) {
  if (process.env.ONLY && process.env.ONLY !== id) continue;
  const def = getBoardDefinition(id)!;
  console.log(`\n--- ${def.name}`);
  const built = await compileProject({ fqbn, boardId: def.serverTargetId ?? def.id, files: [{ name: 'sketch.ino', content: SKETCH }] }, false);
  if (!built.firmware) {
    console.log(`SKIP: ${id} did not build here (${built.error ?? ''})`);
    skipped++;
    continue;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r: any = await getSimulatorAdapter(def)!.createRunner(built.firmware, def);
  let out = '';
  r.onSerialByte = (b: number) => (out += String.fromCharCode(b));
  try {
    for (let t = 0; t < 4000; t += 20) r.runFor(20);
  } catch (e) {
    check(false, `the run completed (${(e as Error).message.slice(0, 200)})`);
    continue;
  }
  const boots = [...out.matchAll(/boot (\d+) reason (\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const seen = JSON.stringify(boots);
  check(r.fault == null, `nothing faulted (${r.fault ?? 'no fault'})`);
  check(boots[0]?.[0] === 1 && boots[0]?.[1] === ESP_RST_POWERON, `it powers up (${seen})`);
  check(boots[1]?.[0] === 2 && boots[2]?.[0] === 3, `ESP.restart() reboots it, and Preferences keep the count (${seen})`);
  check(boots[1]?.[1] === ESP_RST_SW && boots[2]?.[1] === ESP_RST_SW, `esp_reset_reason() reports a software restart (${seen})`);
  check(/abort\(\) was called/.test(out) && /Backtrace|Stack memory/.test(out), "abort() prints the core's panic report (a backtrace on Xtensa, the stack on RISC-V)");
  check(boots[3]?.[0] === 4 && boots[3]?.[1] === ESP_RST_PANIC, `and the board reboots after it, reporting a panic (${seen})`);
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
