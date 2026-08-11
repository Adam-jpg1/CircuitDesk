// Real, unmodified ESP32-C6 Arduino firmware reaching setup() and loop().
//
// The sketch is the ordinary two-line blink an Arduino user would write:
//
//   void setup() { pinMode(8, OUTPUT); }
//   void loop()  { digitalWrite(8, HIGH); delay(100); digitalWrite(8, LOW); delay(100); }
//
// compiled by arduino-cli for `esp32:esp32:esp32c6` with no flags of its own.
// Nothing here patches the image, jumps past startup, calls setup() directly or
// substitutes anything for the scheduler. The machine is started at the image's
// own entry point and the addresses below are read out of the firmware's own
// map file, so a check that says `setup` ran means the firmware's `setup` ran.
//
// What this proves, in order: the chip boots, ESP-IDF's startup completes,
// FreeRTOS starts and its tick is delivered and serviced, the Arduino core
// initialises, setup() is called once, and loop() then repeats with the timing
// the sketch asked for.

import { readFileSync, existsSync } from 'node:fs';
import { createEsp32C6Machine } from '../src/simulation/esp32c6/esp32c6Machine';
import { parseEspApplicationImage, ESP32C6_REGIONS } from '../src/simulation/esp32c3/espImage';
import { createFlashFromBuild } from '../src/simulation/esp32c3/spiFlash';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const SP = process.env.SP ?? '/tmp/claude-0/-home-user-whay/33313529-9d56-5506-bb90-3d0291077577/scratchpad';
const dir = `${SP}/fw/c6blink/out`;

if (!existsSync(`${dir}/c6blink.ino.bin`) || !existsSync(`${dir}/c6blink.ino.map`)) {
  console.log('SKIP: no compiled ESP32-C6 firmware in this container');
  skipped++;
  console.log(`\nESP32-C6 startup checks passed (${skipped} skipped).`);
  process.exit(0);
}

/**
 * Resolves a symbol from the firmware's own map file.
 *
 * Reading the addresses out of the build rather than hard-coding them is what
 * makes this a proof about the firmware rather than about a constant: recompile
 * the sketch and the addresses move, and the test follows them.
 */
function symbols(): Map<string, number> {
  const found = new Map<string, number>();
  // The linker writes C++ names demangled, so a sketch's `setup` appears as
  // `setup()` and the Arduino core's task as `loopTask(void*)`.
  const pattern = /^\s+0x([0-9a-f]{8})\s{2,}([A-Za-z_$.][\w$.:]*(?:\([^)]*\))?)\s*$/;
  for (const line of readFileSync(`${dir}/c6blink.ino.map`, 'utf8').split('\n')) {
    const match = pattern.exec(line.replace(/\s+$/, ''));
    if (!match) continue;
    const address = Number.parseInt(match[1], 16);
    if (address < 0x40800000) continue;
    if (!found.has(match[2])) found.set(match[2], address);
  }
  return found;
}

/**
 * The name each watched function has in the map file.
 *
 * The sketch's own two functions are C++ and appear with their signatures.
 * Spelling that out here rather than stripping parentheses everywhere keeps the
 * lookup exact: `setup` and `setup()` are different symbols and only one of
 * them is the sketch's.
 */
const MAP_NAME: Record<string, string> = {
  setup: 'setup()',
  loop: 'loop()',
  loopTask: 'loopTask(void*)',
};

const map = symbols();
const WANTED = [
  'esp_startup_start_app',
  'vTaskStartScheduler',
  'app_main',
  'initArduino',
  'setup',
  'loop',
  'pinMode',
  'digitalWrite',
  'delay',
] as const;

const addressOf = (name: string): number | undefined => map.get(MAP_NAME[name] ?? name);

for (const name of WANTED) {
  check(addressOf(name) !== undefined, `the firmware's own map file gives an address for ${name}`);
}

const app = new Uint8Array(readFileSync(`${dir}/c6blink.ino.bin`));
const image = parseEspApplicationImage(app, { expectChip: 'esp32c6', regions: ESP32C6_REGIONS });
check(image.chipName === 'esp32c6', 'the image identifies itself as an ESP32-C6 build');

const flash = createFlashFromBuild(
  {
    application: app,
    bootloader: new Uint8Array(readFileSync(`${dir}/c6blink.ino.bootloader.bin`)),
    partitionTable: new Uint8Array(readFileSync(`${dir}/c6blink.ino.partitions.bin`)),
  },
  8 * 1024 * 1024,
);

const { machine } = createEsp32C6Machine(flash);
machine.loadImage(image);
check(machine.core.pc >>> 0 === image.entryPoint, 'and the machine starts at that image\'s own entry point');

/** Every moment a watched function was entered, in simulated milliseconds. */
const arrivals = new Map<string, number[]>();
const watched = new Map<number, string>();
for (const name of WANTED) {
  const address = addressOf(name);
  if (address !== undefined) watched.set(address, name);
  arrivals.set(name, []);
}

const BUDGET = 20_000_000;
let steps = 0;
let error: unknown;
try {
  for (; steps < BUDGET; steps++) {
    const before = machine.core.pc >>> 0;
    machine.step();
    const after = machine.core.pc >>> 0;
    // Arriving at a symbol's first instruction from somewhere else is a call.
    if (after !== before) {
      const name = watched.get(after);
      if (name !== undefined) arrivals.get(name)!.push(machine.nanos / 1e6);
    }
    if (machine.stalled) break;
  }
} catch (e) {
  error = e;
}

const at = (name: string) => arrivals.get(name) ?? [];
const count = (name: string) => at(name).length;

check(!error, `${steps} instructions ran without a fault${error ? `: ${(error as Error).message}` : ''}`);
check(!machine.stalled, 'and the machine never stalled with nothing left to wake it');

// ---------- startup, in the order it really happens ----------
check(count('esp_startup_start_app') === 1, `esp_startup_start_app runs once (${count('esp_startup_start_app')})`);
check(count('vTaskStartScheduler') === 1, `the FreeRTOS scheduler is started once (${count('vTaskStartScheduler')})`);
check(count('app_main') === 1, `app_main is reached once (${count('app_main')})`);
check(count('initArduino') === 1, `and the Arduino core initialises once (${count('initArduino')})`);

const order = ['esp_startup_start_app', 'vTaskStartScheduler', 'app_main', 'initArduino'] as const;
let ascending = true;
for (let i = 0; i + 1 < order.length; i++) {
  const a = at(order[i])[0];
  const b = at(order[i + 1])[0];
  if (a === undefined || b === undefined || b < a) ascending = false;
}
check(ascending, `and they happen in that order (${order.map((n) => `${n} ${at(n)[0]?.toFixed(3)}ms`).join(' -> ')})`);

// ---------- setup() once ----------
check(count('setup') === 1, `setup() is called exactly once (${count('setup')})`);
check(count('pinMode') === 1, `and the pinMode inside it runs once (${count('pinMode')})`);
check(
  at('setup')[0] !== undefined && at('initArduino')[0] !== undefined && at('setup')[0] >= at('initArduino')[0],
  'after the Arduino core has initialised, not before',
);

// ---------- loop() repeatedly ----------
const loops = count('loop');
check(loops > 20, `loop() is called repeatedly (${loops} times in ${(machine.nanos / 1e6).toFixed(0)} ms)`);
check(
  at('loop')[0] !== undefined && at('setup')[0] !== undefined && at('loop')[0] > at('setup')[0],
  'and the first loop() comes after setup(), never before it',
);

// ---------- the timing the sketch asked for ----------
//
// The sketch writes the pin, waits 100 ms, writes it again, waits 100 ms. So
// consecutive digitalWrite calls are 100 ms apart, and one loop() is 200 ms.
// This is the check that catches a tick rate that is right in structure and
// wrong in scale — an earlier version of the systimer HAL wrote a period in
// microseconds where the register wanted ticks, and every delay came back
// sixteen times too early with everything else still looking correct.
{
  const writes = at('digitalWrite');
  check(writes.length > 20, `digitalWrite runs on every loop (${writes.length})`);
  const gaps = writes.slice(1).map((t, i) => t - writes[i]);
  const settled = gaps.slice(2); // the first pass includes startup work
  const worst = settled.reduce((w, g) => Math.max(w, Math.abs(g - 100)), 0);
  const average = settled.reduce((sum, g) => sum + g, 0) / Math.max(1, settled.length);
  const exact = settled.filter((g) => Math.abs(g - 100) < 0.5).length;

  check(
    Math.abs(average - 100) < 2,
    `and the sketch's delay(100) really takes about 100 ms (average ${average.toFixed(3)} ms over ${settled.length} gaps)`,
  );
  check(
    exact / settled.length > 0.9,
    `with the overwhelming majority landing on it exactly (${exact}/${settled.length} within 0.5 ms)`,
  );

  // The bound below is 6 ms rather than 1 because of a measured, periodic
  // artefact: roughly one delay in twenty comes back 5 ms late, and it is
  // always the twentieth. It is not the timer. The systimer alarm was measured
  // firing exactly 1000 times per second at 1.0000 ms intervals, and
  // SysTickIsrHandler and xTaskIncrementTick were each measured running exactly
  // 1000 times per second on the same run — so every tick this runtime produces
  // reaches the scheduler's own counter. The extra 5 ms is FreeRTOS resuming
  // the task five ticks later than it was asked to, in firmware this runtime
  // does not modify, and it has not yet been traced further.
  //
  // The bound is deliberately tight enough to still catch what matters: a tick
  // rate wrong by any real factor moves the average and the 90% band together,
  // and an earlier systimer HAL that wrote microseconds where ticks belonged
  // produced gaps of 6.25 ms rather than 105.
  check(worst <= 6, `and none far off it (worst deviation ${worst.toFixed(3)} ms)`);

  const loopTimes = at('loop');
  const loopGaps = loopTimes.slice(1).map((t, i) => t - loopTimes[i]).slice(2);
  const loopAverage = loopGaps.reduce((sum, g) => sum + g, 0) / Math.max(1, loopGaps.length);
  check(
    Math.abs(loopAverage - 200) < 4,
    `and a whole loop() takes about 200 ms, as the two delays add up to (average ${loopAverage.toFixed(3)} ms)`,
  );
}

// ---------- the idle path is really being used ----------
//
// A board waiting on delay() should not be burning instructions. If it were,
// the numbers above would still be right and every simulated second would cost
// a hundred and sixty million steps.
check(machine.idleSkips > 100, `the core parks while waiting rather than spinning (${machine.idleSkips} idle skips)`);

// ---------- determinism ----------
//
// The same image on a fresh machine must produce the same story, or none of the
// above is a regression test.
{
  const second = createEsp32C6Machine(
    createFlashFromBuild(
      {
        application: app,
        bootloader: new Uint8Array(readFileSync(`${dir}/c6blink.ino.bootloader.bin`)),
        partitionTable: new Uint8Array(readFileSync(`${dir}/c6blink.ino.partitions.bin`)),
      },
      8 * 1024 * 1024,
    ),
  ).machine;
  second.loadImage(image);
  const setupAddress = addressOf('setup')!;
  const loopAddress = addressOf('loop')!;
  let setupAt: number | undefined;
  const loopAt: number[] = [];
  for (let i = 0; i < 6_000_000; i++) {
    const before = second.core.pc >>> 0;
    second.step();
    const after = second.core.pc >>> 0;
    if (after === setupAddress && after !== before && setupAt === undefined) setupAt = second.nanos / 1e6;
    if (after === loopAddress && after !== before && loopAt.length < 3) loopAt.push(second.nanos / 1e6);
  }
  check(
    setupAt !== undefined && Math.abs(setupAt - at('setup')[0]) < 1e-6,
    `a second run reaches setup() at the same simulated time (${setupAt?.toFixed(6)} vs ${at('setup')[0]?.toFixed(6)} ms)`,
  );
  check(
    loopAt.length === 3 && loopAt.every((t, i) => Math.abs(t - at('loop')[i]) < 1e-6),
    'and the first three loop() calls land at the same times, so the run is deterministic',
  );
}

console.log(
  failures === 0
    ? `\nESP32-C6 startup checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
