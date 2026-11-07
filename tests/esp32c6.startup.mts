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

// Where a compiled C6 firmware build was left, if one was. There is no
// default: the path is whatever machine this was built on, and baking one in
// means every other machine silently checks a directory that cannot exist.
const SP = process.env.SP ?? '';
const dir = SP ? `${SP}/fw/c6blink/out` : '';

if (!dir || !existsSync(`${dir}/c6blink.ino.bin`) || !existsSync(`${dir}/c6blink.ino.map`)) {
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

  // The bound is 6 ms rather than 1 because of a periodic 5 ms gap that is the
  // Arduino core's own doing, not this runtime's. It is traced and asserted
  // below rather than tolerated.
  //
  // The bound still catches what matters: a tick rate wrong by any real factor
  // moves the average and the 90% band together, and an earlier systimer HAL
  // that wrote microseconds where ticks belonged produced gaps of 6.25 ms
  // rather than 105.
  check(worst <= 6, `and none far off it (worst deviation ${worst.toFixed(3)} ms)`);

  // ---------- the 5 ms gap is the Arduino core's periodic yield ----------
  //
  // Roughly one delay in twenty returns 5 ms late, always the twentieth. It is
  // not the timer: the systimer alarm, SysTickIsrHandler and xTaskIncrementTick
  // were each measured at exactly 1000 per second, 1.0000 ms apart, so every
  // tick this runtime produces reaches the scheduler's own counter.
  //
  // It is `yieldIfNecessary()` in the Arduino core's own main.cpp:
  //
  //   void yieldIfNecessary(void) {
  //     static uint64_t lastYield = 0;
  //     uint64_t now = millis();
  //     if ((now - lastYield) > 2000) { lastYield = now; vTaskDelay(5); }
  //   }
  //
  // called from loopTask under CONFIG_FREERTOS_UNICORE — which the C6 is —
  // before every loop(). Every two seconds the core deliberately gives up five
  // ticks so lower-priority tasks, the idle task among them, get to run and
  // feed the watchdog. A real ESP32-C6 does exactly this, so reproducing it is
  // the simulation being right rather than wrong, and a runtime that did *not*
  // show the gap would be the one to distrust.
  const lateGaps = settled.map((g, i) => [i, g] as const).filter(([, g]) => g - 100 > 1);
  check(lateGaps.length > 2, `the late gaps recur rather than happening once (${lateGaps.length} of them)`);
  check(
    lateGaps.every(([, g]) => Math.abs(g - 105) < 0.5),
    `and every one is 5 ms rather than an arbitrary amount (${lateGaps.map(([, g]) => g.toFixed(3)).slice(0, 4).join(', ')})`,
  );
  // Every 2000 ms, which is the interval yieldIfNecessary tests for. Two
  // consecutive late gaps are twenty ordinary 100 ms gaps apart.
  const spacing = lateGaps.slice(1).map(([i], k) => i - lateGaps[k][0]);
  check(
    spacing.length > 0 && spacing.every((n) => n === spacing[0]),
    `spaced evenly, one every ${spacing[0]} delays (${spacing.slice(0, 5).join(', ')})`,
  );
  check(
    spacing.length > 0 && Math.abs(spacing[0] * 100 - 2000) < 150,
    `which is one every ${(spacing[0] * 100) / 1000} seconds, the interval yieldIfNecessary tests for`,
  );
}

// ---------- the yield is a real vTaskDelay(5) from loopTask ----------
//
// The check above shows the shape; this one shows the cause, by watching the
// call itself. Without it the 5 ms could still be something else that happened
// to be periodic.
{
  const vTaskDelay = addressOf('vTaskDelay');
  const loopTask = map.get('loopTask(void*)');
  check(vTaskDelay !== undefined, 'the firmware exports vTaskDelay');
  check(loopTask !== undefined, 'and loopTask, which the Arduino core runs the sketch from');

  if (vTaskDelay !== undefined && loopTask !== undefined) {
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

    /** Every vTaskDelay call: how many ticks it asked for, and who asked. */
    const calls: { ms: number; ticks: number; fromLoopTask: boolean }[] = [];
    for (let i = 0; i < 12_000_000; i++) {
      const before = second.core.pc >>> 0;
      second.step();
      const after = second.core.pc >>> 0;
      if (after === vTaskDelay && after !== before) {
        const returnAddress = second.core.registers[1] >>> 0;
        calls.push({
          ms: second.nanos / 1e6,
          ticks: second.core.registers[10] | 0,
          // The compiler inlines loop() into loopTask, so a return address
          // inside loopTask covers both the core's own yield and the sketch's
          // delays. What separates them is what they ask for.
          fromLoopTask: returnAddress >= loopTask && returnAddress < loopTask + 0x100,
        });
      }
      if (second.nanos / 1e6 > 4400) break;
    }

    const sketchDelays = calls.filter((c) => c.ticks === 100);
    const yields = calls.filter((c) => c.ticks === 5);

    check(sketchDelays.length > 10, `the sketch's own delay(100) calls are seen (${sketchDelays.length})`);
    // Three amounts appear and no others: 100 from the sketch, 5 from the
    // core's periodic yield, and 0 — a plain "give up the CPU now" that
    // FreeRTOS treats as a yield with no delay, used once during startup.
    check(
      calls.every((c) => c.ticks === 100 || c.ticks === 5 || c.ticks === 0),
      `and nothing asks for any other amount (${[...new Set(calls.map((c) => c.ticks))].sort((a, b) => a - b).join(', ')} ticks)`,
    );
    check(
      calls.filter((c) => c.ticks === 0).length <= 2,
      `with the bare yield used only during startup (${calls.filter((c) => c.ticks === 0).length})`,
    );

    check(yields.length >= 2, `something calls vTaskDelay(5) of its own accord (${yields.length} times)`);
    check(yields.every((c) => c.fromLoopTask), 'and every one of them comes from loopTask, not from the sketch');
    const yieldGaps = yields.slice(1).map((c, i) => c.ms - yields[i].ms);
    check(
      yieldGaps.every((g) => g > 2000 && g < 2300),
      `at intervals just over the 2000 ms yieldIfNecessary waits for (${yieldGaps.map((g) => g.toFixed(0)).join(', ')} ms)`,
    );
    // The five-tick yields and the late gaps are the same events: one per two
    // seconds, and the sketch itself never asks for anything but 100.
    check(
      yields.length * 2 <= sketchDelays.length,
      `and they are rare against the sketch's own delays (${yields.length} yields, ${sketchDelays.length} delays)`,
    );
  }

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
