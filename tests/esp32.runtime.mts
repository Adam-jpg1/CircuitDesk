// The ESP32 DevKit V1, running firmware from the Espressif Arduino core on the
// Xtensa core and the ESP32 model: both LX6 CPUs under ESP-IDF's own startup
// and FreeRTOS.
//
// Each sketch is compiled by the same compiler service the app uses and run
// through the same adapter, then checked by what it does: what it prints, how
// fast time passes, and what its pins do on the canvas.

import { compileProject } from '../server/compiler/compilerService';
import { getSimulatorAdapter } from '../src/simulation/adapters';
import { getBoardDefinition } from '../src/boards/definitions';
import { runnerPinIndex } from '../src/simulation/boardRunner';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

// Both Xtensa parts, each on its own board's labels: the sketches use GPIO 2,
// 4 and 18, which both chips have.
const BOARDS = [
  { id: 'board.esp32-devkit', fqbn: 'esp32:esp32:esp32', engine: 'esp32', led: 'D2', pullup: 'D4', pulldown: 'D18' },
  { id: 'board.esp32-s3', fqbn: 'esp32:esp32:esp32s3', engine: 'esp32s3', led: 'GPIO2', pullup: 'GPIO4', pulldown: 'GPIO18' },
] as const;

for (const B of BOARDS.filter((x) => !process.env.ONLY || x.id === process.env.ONLY)) {
  const def = getBoardDefinition(B.id)!;
  const FQBN = B.fqbn;
  check(def.supportLevel === 'simulated' && def.simulation?.engine === B.engine, `${def.name} is a simulated board on the ${B.engine} engine`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Runner = any;
  async function boot(sketch: string): Promise<{ r: Runner; out: () => string } | null> {
    const built = await compileProject({ fqbn: FQBN, boardId: def.serverTargetId ?? def.id, files: [{ name: 'sketch.ino', content: sketch }] }, false);
    if (!built.firmware) {
      console.log(`SKIP: the ESP32 sketch did not build here (${built.errors?.[0]?.message ?? built.error ?? built.stderr?.slice(0, 200)})`);
      skipped++;
      return null;
    }
    check(built.firmware.format === 'esp-image', 'the artifact is an ESP application image');
    const r: Runner = await getSimulatorAdapter(def)!.createRunner(built.firmware, def);
    let text = '';
    r.onSerialByte = (b: number) => (text += String.fromCharCode(b));
    return { r, out: () => text };
  }
  const run = (r: Runner, ms: number, slice = 5) => {
    for (let t = 0; t < ms; t += slice) r.runFor(slice);
  };
  const pin = (label: string) => runnerPinIndex(def, label)!;
  const last = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => m[1]).at(-1);

  section(`${def.name}: boot, Serial, time and floating point`);
  {
    const b = await boot(`void setup() { Serial.begin(115200); Serial.println("esp32 ready");
    Serial.print("cores "); Serial.println(ESP.getChipCores());
    Serial.print("mhz "); Serial.println(getCpuFrequencyMhz());
    unsigned long u0 = micros(); delayMicroseconds(500); unsigned long du = micros() - u0;
    unsigned long t0 = millis(); delay(1000); Serial.print("ms "); Serial.println(millis() - t0);
    Serial.print("us "); Serial.println(du);
    float f = 1.5f; for (int i = 0; i < 10; i++) f = f * 1.25f + 0.5f; Serial.print("f "); Serial.println(f, 3);
    volatile double d = 2.0; d = sqrt(d) * 3.0 / 7.0; Serial.print("d "); Serial.println(d, 9);
    volatile long long big = 123456789012LL; big = big / 7 + big % 13; Serial.print("ll "); Serial.println((long)(big % 1000000)); }
  void loop() { if (Serial.available()) { int c = Serial.read(); Serial.print("got "); Serial.println((char)c); } }`);
    if (b) {
      const t0 = performance.now();
      run(b.r, 1300);
      const wall = performance.now() - t0;
      check(b.out().includes('esp32 ready'), `the core starts, both CPUs come up and Serial prints (${JSON.stringify(b.out().slice(0, 60))})`);
      check(last(b.out(), /cores (\d+)/g) === '2', 'ESP.getChipCores() reports both cores');
      check(last(b.out(), /mhz (\d+)/g) === '240', `the CPU runs at the 240 MHz the core configures (${last(b.out(), /mhz (\d+)/g)})`);
      const ms = Number(last(b.out(), /ms (\d+)/g));
      check(ms >= 999 && ms <= 1001, `delay(1000) takes 1000 ms of simulated time, to the FreeRTOS tick (${ms})`);
      const us = Number(last(b.out(), /us (\d+)/g));
      check(us >= 499 && us <= 510, `delayMicroseconds(500) takes 500 µs (${us})`);
      let f = Math.fround(1.5);
      for (let i = 0; i < 10; i++) f = Math.fround(Math.fround(f * 1.25) + 0.5);
      check(last(b.out(), /f ([\d.]+)/g) === f.toFixed(3), `single-precision arithmetic on the FPU (${last(b.out(), /f ([\d.]+)/g)})`);
      check(last(b.out(), /d ([\d.]+)/g) === ((Math.sqrt(2) * 3) / 7).toFixed(9), `double precision through the ROM's soft-float (${last(b.out(), /d ([\d.]+)/g)})`);
      const big = 123456789012n;
      check(last(b.out(), /ll (\d+)/g) === String((big / 7n + (big % 13n)) % 1000000n), '64-bit division through the ROM');
      console.log(`   1.3 s simulated in ${(wall / 1000).toFixed(2)} s`);
      b.r.queueSerialInput('Q');
      run(b.r, 50);
      check(b.out().includes('got Q'), 'a byte typed into the monitor reaches Serial.read()');
    }
  }

  section(`${def.name}: GPIO: blink, read a button`);
  {
    const b = await boot(`void setup() { pinMode(2, OUTPUT); pinMode(4, INPUT_PULLUP); pinMode(18, INPUT_PULLDOWN); Serial.begin(115200); }
  int last4 = -1;
  void loop() { digitalWrite(2, HIGH); delay(100); digitalWrite(2, LOW); delay(100);
    int v = digitalRead(4); if (v != last4) { Serial.print("d4 "); Serial.println(v); last4 = v; }
    static int last18 = -1; int w = digitalRead(18); if (w != last18) { Serial.print("d18 "); Serial.println(w); last18 = w; } }`);
    if (b) {
      const led = pin(B.led);
      const seen: boolean[] = [];
      b.r.addPinListener((p: number, high: boolean) => {
        if (p === led) seen.push(high);
      });
      run(b.r, 650);
      check(seen.filter((h) => h).length >= 3 && seen.filter((h) => !h).length >= 3, `${B.led} blinks (${seen.length} edges in 650 ms)`);
      check(b.r.digitalPinLevel(pin(B.pullup)) === 'input-pullup', `INPUT_PULLUP on ${B.pullup} is reported as a pulled-up input`);
      check(last(b.out(), /d4 (\d)/g) === '1', 'and reads high with nothing connected');
      check(last(b.out(), /d18 (\d)/g) === '0', `INPUT_PULLDOWN on ${B.pulldown} reads low`);
      b.r.setDigitalInput(pin(B.pullup), false);
      b.r.setDigitalInput(pin(B.pulldown), true);
      run(b.r, 300);
      check(last(b.out(), /d4 (\d)/g) === '0', `pulling ${B.pullup} low from the canvas reads 0`);
      check(last(b.out(), /d18 (\d)/g) === '1', `driving ${B.pulldown} high reads 1`);
    }
  }

}

console.log(`\n--- ${failures} failing${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failures ? 1 : 0);
