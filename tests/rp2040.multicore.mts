// The RP2040's second core.
//
// Arduino-Pico starts core 1 whenever a sketch defines setup1() or loop1().
// Before the simulator ran a second core such a sketch never reached setup():
// core 0 waited forever on the boot ROM's launch handshake. Checked here, on
// compiled firmware:
//   * both cores run their own loops at their own rates, each on its own pin,
//     and each reads its own core number;
//   * the inter-core FIFO carries words both ways (rp2040.fifo);
//   * a mutex both cores take keeps a shared counter exact;
//   * EEPROM.commit() writes flash while core 1 runs (core 0 pauses it through
//     the FIFO interrupt first), and the value is there after a reset, with
//     both cores running again;
//   * rp2040.restartCore1() puts core 1 back through the ROM and setup1();
//   * the Pico W and XIAO RP2040 start their second core the same way.

import { compileProject } from '../server/compiler/compilerService';
import { detectArduinoCli } from '../server/compiler/arduinoCli';
import { Rp2040Runner } from '../src/simulation/rp2040/rp2040Runner';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const cli = await detectArduinoCli();
if (!cli.available) {
  console.log('SKIP: arduino-cli is not available here');
  process.exit(0);
}

const SKETCH = `#include <EEPROM.h>
mutex_t m;
volatile uint32_t shared = 0;
volatile bool core1Done = false;
volatile uint32_t setup1Runs = 0;
void setup() {
  Serial1.begin(115200);
  delay(30);
  Serial1.printf("core0 on %d\\n", rp2040.cpuid());
  pinMode(15, OUTPUT);
  EEPROM.begin(256);
  uint8_t boots = EEPROM.read(1) == 0xff ? 0 : EEPROM.read(1);
  EEPROM.write(1, boots + 1);
  Serial1.printf("commit %d boots %d\\n", EEPROM.commit(), boots + 1);
  for (int i = 0; i < 4000; i++) { mutex_enter_blocking(&m); shared++; mutex_exit(&m); }
  while (!core1Done) delay(1);
  Serial1.printf("shared %lu\\n", (unsigned long)shared);
}
int rounds = 0;
void loop() {
  digitalWrite(15, !digitalRead(15));
  if (rp2040.fifo.available()) {
    uint32_t v = rp2040.fifo.pop();
    Serial1.printf("core0 got %lu\\n", (unsigned long)v);
    rp2040.fifo.push(v * 10);
  }
  if (++rounds == 8) { Serial1.println("restarting core1"); rp2040.restartCore1(); }
  delay(100);
}
void setup1() {
  if (setup1Runs++ == 0) {
    mutex_init(&m);
    for (int i = 0; i < 4000; i++) { mutex_enter_blocking(&m); shared++; mutex_exit(&m); }
    core1Done = true;
  }
  pinMode(14, OUTPUT);
  delay(60);
  Serial1.printf("core1 on %d, setup1 run %lu\\n", rp2040.cpuid(), (unsigned long)setup1Runs);
}
uint32_t n = 0;
void loop1() {
  digitalWrite(14, !digitalRead(14));
  rp2040.fifo.push(++n);
  uint32_t back = rp2040.fifo.pop();
  Serial1.printf("core1 got %lu\\n", (unsigned long)back);
  delay(250);
}`;

async function boot(fqbn: string, boardId: string, content = SKETCH): Promise<Rp2040Runner | null> {
  const built = await compileProject({ fqbn, boardId, files: [{ name: 'sketch.ino', content }] }, false);
  if (!built.firmware) {
    console.log(`SKIP: ${boardId} did not build here (${built.errors?.[0]?.message ?? built.error ?? ''})`);
    return null;
  }
  const image = Uint8Array.from(Buffer.from(built.firmware.data, 'base64'));
  return new Rp2040Runner(image, { symbols: built.firmware.symbols });
}

function watch(r: Rp2040Runner) {
  let text = '';
  const toggles: Record<number, number> = {};
  r.onSerialByte = (b: number) => (text += String.fromCharCode(b));
  r.addPinListener((pin: number) => (toggles[pin] = (toggles[pin] ?? 0) + 1));
  return { out: () => text, toggles };
}

const run = (r: Rp2040Runner, ms: number) => {
  for (let t = 0; t < ms; t += 10) r.runFor(10);
};

console.log('\n--- Raspberry Pi Pico: setup1() and loop1() on the second core');
const r = await boot('rp2040:rp2040:rpipico', 'board.raspberry-pi-pico');
if (r) {
  const w = watch(r);
  const started = Date.now();
  run(r, 2000);
  const wall = (Date.now() - started) / 1000;
  const out = w.out();
  check(/core0 on 0/.test(out), `core 0 reaches setup() and reads its core number (${out.match(/core0 on \d/)?.[0] ?? 'nothing'})`);
  check(/core1 on 1, setup1 run 1/.test(out), `core 1 runs setup1() and reads its own (${out.match(/core1 on [^\n]*/)?.[0] ?? 'nothing'})`);
  check((w.toggles[15] ?? 0) >= 15 && (w.toggles[14] ?? 0) >= 6, `each core blinks its own pin at its own rate (GP15 ${w.toggles[15] ?? 0}, GP14 ${w.toggles[14] ?? 0} in 2 s)`);
  const pairs = [...out.matchAll(/core1 got (\d+)/g)].map((m) => +m[1]);
  // restartCore1() drains the FIFOs, as the SDK's launch does, so a word in flight then is dropped.
  check(
    pairs.length >= 4 && pairs[0] === 10 && pairs[1] === 20 && pairs.every((v, k) => v % 10 === 0 && (k === 0 || v > pairs[k - 1])) && /core0 got 1\n/.test(out),
    `the FIFO carries words both ways (${pairs.slice(0, 5).join(', ')})`,
  );
  check(/shared 8000/.test(out), `a mutex both cores take keeps a shared count exact (${out.match(/shared \d+/)?.[0] ?? 'nothing'})`);
  check(/commit 1 boots 1/.test(out), `EEPROM.commit() writes flash with core 1 running (${out.match(/commit[^\n]*/)?.[0] ?? 'nothing'})`);
  check(/restarting core1[\s\S]*core1 on 1, setup1 run 2/.test(out), 'rp2040.restartCore1() takes core 1 back through the ROM and setup1()');
  console.log(`(2 s simulated in ${wall.toFixed(1)} s)`);

  // A reset drops pin listeners (the controller adds its own back), so watch afresh.
  r.reset();
  const after = watch(r);
  run(r, 1500);
  check(/commit 1 boots 2/.test(after.out()), `after a reset the EEPROM value is still there (${after.out().match(/commit[^\n]*/)?.[0] ?? 'nothing'})`);
  check(
    /core1 on 1, setup1 run 1/.test(after.out()) && (after.toggles[14] ?? 0) > 0 && (after.toggles[15] ?? 0) > 0,
    `and both cores start again (GP14 ${after.toggles[14] ?? 0}, GP15 ${after.toggles[15] ?? 0})`,
  );
}

const SMALL = `void setup() { Serial1.begin(115200); }
void loop() { delay(200); }
void setup1() { delay(50); }
void loop1() { Serial1.printf("core %d\\n", rp2040.cpuid()); delay(200); }`;
for (const [fqbn, id] of [
  ['rp2040:rp2040:rpipicow', 'board.raspberry-pi-pico-w'],
  ['rp2040:rp2040:seeed_xiao_rp2040', 'board.seeed-xiao-rp2040'],
] as const) {
  console.log(`\n--- ${id}`);
  const b = await boot(fqbn, id, SMALL);
  if (!b) continue;
  const w = watch(b);
  run(b, 700);
  check(/core 1\n/.test(w.out()), `loop1() runs on core 1 (${JSON.stringify(w.out().slice(0, 40))})`);
}

console.log(`\n--- ${failures} failing`);
process.exit(failures ? 1 : 0);
