// analogWrite() on the SAMD21 boards produces real PWM on the pin it names.
//
// The Arduino SAMD core hands the pad to a TCC or TC on peripheral function E
// or F, sets the timer to normal PWM with a 16-bit top, and writes the compare
// value — through the buffered CCB register once the timer is running. Each of
// those steps has to land for an LED to dim, so this compiles real firmware
// and measures the pads:
//   * every PWM pin used carries the duty analogWrite() asked for (v / 256),
//     at the ~732 Hz a 48 MHz clock over 65536 counts gives;
//   * a second analogWrite() on a running timer changes the duty;
//   * pins on different timers, and on different channels of one, are
//     independent.
//
// Compiled for real; skips without arduino-cli and the SAMD cores.

import { compileProject } from '../server/compiler/compilerService';
import { detectArduinoCli } from '../server/compiler/arduinoCli';
import { Samd21Runner } from '../src/simulation/samd21/samd21Runner';
import { getBoardDefinition } from '../src/boards/definitions';
import { runnerPinIndex } from '../src/simulation/boardRunner';
import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject, inst, wire, code } from '../src/project/templates';

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

// Arduino pin number, the board label it is printed as, and which timer
// channel the variant puts it on (for the record; the test measures the pad).
const boards = [
  {
    id: 'board.adafruit-feather', fqbn: 'adafruit:samd:adafruit_feather_m0',
    pins: [[5, 'D5', 'TC3/WO1'], [6, 'D6', 'TCC0/WO6'], [9, 'D9', 'TCC1/WO1'], [10, 'D10', 'TC3/WO0'], [11, 'D11', 'TCC2/WO0'], [12, 'D12', 'TCC0/WO3'], [13, 'D13', 'TCC2/WO1'], [17, 'A3', 'TCC0/WO0']],
  },
  {
    id: 'board.adafruit-qtpy', fqbn: 'adafruit:samd:adafruit_qtpy_m0',
    pins: [[2, 'A2', 'TCC0/WO0'], [3, 'A3', 'TCC0/WO1'], [4, 'SDA', 'TCC2/WO0'], [9, 'MISO', 'TCC1/WO3'], [10, 'MOSI', 'TCC0/WO2']],
  },
  {
    id: 'board.seeed-xiao', fqbn: 'Seeeduino:samd:seeed_XIAO_m0',
    pins: [[1, 'A1', 'TCC0/WO0'], [2, 'A2', 'TCC0/WO2'], [6, 'TX', 'TC4/WO0'], [8, 'A8', 'TCC1/WO1'], [10, 'A10', 'TCC1/WO0']],
  },
] as const;

const VALUES = [32, 64, 96, 128, 160, 192, 224, 240];

for (const b of boards) {
  console.log(`\n--- ${b.id}`);
  const def = getBoardDefinition(b.id)!;
  const pins = b.pins.map(([n, label, timer], i) => ({ n, label, timer, value: VALUES[i] }));
  const sketch = `const int PINS[] = { ${pins.map((p) => p.n).join(', ')} };
const int VALUES[] = { ${pins.map((p) => p.value).join(', ')} };
const int COUNT = ${pins.length};
bool swapped = false;
void setup() {
  for (int i = 0; i < COUNT; i++) analogWrite(PINS[i], VALUES[i]);
}
void loop() {
  if (!swapped && millis() > 1000) {
    swapped = true;
    for (int i = 0; i < COUNT; i++) analogWrite(PINS[i], 255 - VALUES[i]);
  }
}
`;
  const built = await compileProject({ fqbn: b.fqbn, boardId: b.id, files: [{ name: 'sketch.ino', content: sketch }] }, false);
  if (!built.success || !built.firmware) {
    console.log(`SKIP: ${b.id} did not build here (${built.error ?? 'no firmware'})`);
    skipped++;
    continue;
  }
  const runner = new Samd21Runner(built.firmware.data);
  const pads = pins.map((p) => runnerPinIndex(def, p.label)!);
  check(pads.every((pad) => pad !== undefined), `every pin resolves to a pad (${pads.join(', ')})`);

  runner.runFor(300);
  runner.snapshot(); // start a clean measuring window
  const t0 = runner.snapshot().toggles.slice();
  runner.runFor(500);
  let snap = runner.snapshot();
  pins.forEach((p, i) => {
    const pad = pads[i];
    const duty = snap.duty[pad];
    const toggles = snap.toggles[pad] - t0[pad];
    const want = p.value / 256;
    check(runner.isOutput(pad) && Math.abs(duty - want) < 0.01, `${p.label} (${p.timer}, pad ${pad}): analogWrite(${p.value}) gives duty ${duty.toFixed(3)} (want ${want.toFixed(3)})`);
    // 48 MHz / 65536 = 732 Hz: two edges a period, ~732 in half a second.
    check(toggles >= 700 && toggles <= 765, `   at the timer's ~732 Hz (${toggles} edges in 0.5 s)`);
  });

  runner.runFor(400); // past the swap at 1 s
  runner.snapshot();
  runner.runFor(300);
  snap = runner.snapshot();
  pins.forEach((p, i) => {
    const want = (255 - p.value) / 256;
    const duty = snap.duty[pads[i]];
    check(Math.abs(duty - want) < 0.01, `${p.label}: a second analogWrite on the running timer changes it to ${duty.toFixed(3)} (want ${want.toFixed(3)})`);
  });
  runner.dispose();
}

// Every pin a board badges PWM produces it. One at a time: on the real chip
// some share a timer channel (the QT Py's RX and MISO are both TCC1 CC1), so
// two different values at once would be a test of the wrong thing.
const SKETCH_NAME: Record<string, Record<string, string>> = {
  'board.adafruit-qtpy': { TX: '6', RX: '7' },
  'board.seeed-xiao': { TX: '6', RX: '7' },
};
for (const b of boards) {
  const def = getBoardDefinition(b.id)!;
  const badged = def.pins.filter((p) => p.capabilities.includes('pwm' as never));
  console.log(`\n--- ${b.id}: each of ${badged.map((p) => p.id).join(', ')}`);
  const names = badged.map((p) => SKETCH_NAME[b.id]?.[p.id] ?? (/^D\d+$/.test(p.id) ? p.id.slice(1) : p.id));
  const sketch = `const int PINS[] = { ${names.join(', ')} };
const int COUNT = ${names.length};
int current = -1;
void loop() {
  int slot = millis() / 200;
  if (slot != current && slot < COUNT) {
    if (current >= 0) { pinMode(PINS[current], OUTPUT); digitalWrite(PINS[current], LOW); }
    current = slot;
    analogWrite(PINS[current], 77);
  }
}
void setup() {}
`;
  const built = await compileProject({ fqbn: b.fqbn, boardId: b.id, files: [{ name: 'sketch.ino', content: sketch }] }, false);
  if (!built.success || !built.firmware) {
    console.log(`SKIP: ${b.id} did not build here (${built.error ?? 'no firmware'})`);
    skipped++;
    continue;
  }
  const runner = new Samd21Runner(built.firmware.data);
  badged.forEach((pin, i) => {
    const pad = runnerPinIndex(def, pin.id)!;
    const start = i * 200 + 60;
    runner.runFor(start - runner.timeMs);
    runner.snapshot();
    runner.runFor(120);
    const duty = runner.snapshot().duty[pad];
    check(Math.abs(duty - 77 / 256) < 0.01, `${pin.id} (pad ${pad}): analogWrite(77) gives duty ${duty.toFixed(3)}`);
  });
  runner.dispose();
}

// On the canvas: an LED on a PWM pin is as bright as the duty.
{
  console.log('\n--- an LED on the canvas, dimmed by analogWrite');
  const p = emptyProject('feather pwm');
  const board = inst('board.adafruit-feather', 0, 0);
  const r = inst('comp.resistor', 400, 40, { resistance: 220 });
  const led = inst('comp.led', 460, 40, { color: 'red' });
  p.boardInstances = [board];
  p.componentInstances = [r, led];
  p.connections = [wire(board, 'D10', r, 'p1'), wire(r, 'p2', led, 'anode'), wire(led, 'cathode', board, 'GND1')];
  p.codeFiles = [code('sketch.ino', 'void setup() { analogWrite(10, 64); }\nvoid loop() {}\n')];
  simulationController.stop();
  const report = await simulationController.build(p);
  if (report.anyRunnable && (await simulationController.start())) {
    simulationController.pause();
    simulationController.advance(600);
    simulationController.publishNow();
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      simulationController.advance(50);
      simulationController.publishNow();
      sum += useSimulationStore.getState().visuals[led.id]?.brightness ?? 0;
    }
    const brightness = sum / 10;
    check(Math.abs(brightness - 0.25) < 0.05, `the LED on D10 glows at a quarter brightness (${brightness.toFixed(3)})`);
  } else {
    console.log('SKIP: the canvas build did not start');
    skipped++;
  }
  simulationController.stop();
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
