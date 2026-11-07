// PIO runs on the simulated clock, so Servo and tone() work on RP2040 boards.
//
// Arduino-Pico generates a servo's pulse and a tone's square wave with PIO
// programs. rp2040js ran PIO from the host's wall clock, one instruction per
// step whatever the clock divider and delays, so neither moved a pin in
// simulated time. src/simulation/rp2040/pioClock.ts now steps each state
// machine by the cycles it is owed, and skips the identical passes of the
// counting loops those programs time pulses with — 200 million PIO
// instructions a simulated second would otherwise make a servo sketch crawl.
//
// From compiled firmware, through the live simulation where it matters:
//   * a servo on the canvas follows write() to 0, 90 and 180 degrees, and its
//     pulse is exactly what the core intends, every 20 ms;
//   * tone(440) is 440 Hz at half duty, and noTone() stops it;
//   * the same holds on the XIAO RP2040, whose D-labels are other pads;
//   * the loop skipping keeps PIO work small, so this stays fast.

import { compileProject } from '../server/compiler/compilerService';
import { detectArduinoCli } from '../server/compiler/arduinoCli';
import { getSimulatorAdapter } from '../src/simulation/adapters';
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

/**
 * Rising-to-falling widths (µs) and falling-to-falling periods (ms) on one
 * pad. Falling to falling, because the servo program ends its frame on the
 * falling edge: when the width changes, the rising edge moves by the change,
 * so rise-to-rise is 19.5 or 20.5 ms for that one frame, as on the chip.
 */
function measure(edges: [number, boolean][]) {
  const widths: { at: number; us: number }[] = [];
  const periods: number[] = [];
  let rise: number | undefined;
  let fall: number | undefined;
  for (const [t, high] of edges) {
    if (high) {
      rise = t;
    } else {
      if (rise !== undefined) widths.push({ at: t, us: (t - rise) * 1000 });
      if (fall !== undefined) periods.push(t - fall);
      fall = t;
    }
  }
  return { widths, periods };
}

for (const b of [
  { id: 'board.raspberry-pi-pico', fqbn: 'rp2040:rp2040:rpipico', servoPin: 'GP15', servoArg: '15', tonePin: 'GP14', toneArg: '14' },
  { id: 'board.seeed-xiao-rp2040', fqbn: 'rp2040:rp2040:seeed_xiao_rp2040', servoPin: 'D0', servoArg: 'D0', tonePin: 'D1', toneArg: 'D1' },
] as const) {
  console.log(`\n--- ${b.id}`);
  const def = getBoardDefinition(b.id)!;
  const servoPad = runnerPinIndex(def, b.servoPin)!;
  const tonePad = runnerPinIndex(def, b.tonePin)!;
  const sketch = `#include <Servo.h>
Servo s;
void setup() { s.attach(${b.servoArg}); s.write(0); tone(${b.toneArg}, 440); }
void loop() {
  unsigned long t = millis();
  s.write(t < 300 ? 0 : t < 600 ? 90 : 180);
  if (t > 700) noTone(${b.toneArg});
  delay(5);
}`;
  const built = await compileProject({ fqbn: b.fqbn, boardId: b.id, files: [{ name: 'sketch.ino', content: sketch }] }, false);
  if (!built.success || !built.firmware) {
    console.log(`SKIP: ${b.id} did not build here (${built.error ?? 'no firmware'})`);
    skipped++;
    continue;
  }
  const runner = await getSimulatorAdapter(def)!.createRunner(built.firmware, def);
  const servoEdges: [number, boolean][] = [];
  const toneEdges: [number, boolean][] = [];
  runner.addPinListener((pin, high) => {
    if (pin === servoPad) servoEdges.push([runner.timeMs, high]);
    if (pin === tonePad) toneEdges.push([runner.timeMs, high]);
  });
  const machines = (runner as unknown as { rp: { pio: { machines: { step(): void; enabled: boolean }[] }[] } }).rp.pio
    .flatMap((pio) => pio.machines);
  let pioSteps = 0;
  for (const machine of machines) {
    const original = machine.step.bind(machine);
    machine.step = () => {
      pioSteps++;
      original();
    };
  }
  const started = Date.now();
  for (let t = 0; t < 900; t += 10) runner.runFor(10);
  const wall = Date.now() - started;

  const servo = measure(servoEdges);
  const widthNear = (from: number, to: number) => servo.widths.filter((w) => w.at > from && w.at < to).map((w) => Math.round(w.us));
  const at0 = widthNear(100, 290);
  const at90 = widthNear(400, 590);
  const at180 = widthNear(700, 890);
  check(at0.length >= 8 && at0.every((w) => w === 1000), `write(0): 1000 µs pulses on ${b.servoPin} (${[...new Set(at0)].join(', ')})`);
  check(at90.length >= 8 && at90.every((w) => w === 1500), `write(90): 1500 µs (${[...new Set(at90)].join(', ')})`);
  check(at180.length >= 8 && at180.every((w) => w === 2000), `write(180): 2000 µs (${[...new Set(at180)].join(', ')})`);
  check(servo.periods.length >= 30 && servo.periods.every((p) => Math.abs(p - 20) < 0.01), `a frame every 20 ms (${[...new Set(servo.periods.map((p) => p.toFixed(3)))].join(', ')})`);

  const tone = measure(toneEdges.filter(([t]) => t < 690));
  const periods = tone.periods.slice(2);
  check(periods.length > 200 && periods.every((p) => Math.abs(p - 1000 / 440) < 0.002), `tone(440) is 440 Hz (${(1000 / periods[0]).toFixed(1)} Hz)`);
  check(tone.widths.slice(2).every((w) => Math.abs(w.us - 1e6 / 880) < 2), 'at half duty');
  check(!toneEdges.some(([t]) => t > 720), 'and noTone() stops it');

  check(pioSteps < 100_000, `PIO counting loops are skipped, not stepped (${pioSteps} PIO steps for 0.9 s)`);
  console.log(`   ${wall} ms of wall time for 900 ms simulated`);
  runner.dispose?.();
}

// On the canvas: the servo part turns to where the sketch points it.
{
  console.log('\n--- a servo on the canvas');
  const p = emptyProject('pico servo');
  const board = inst('board.raspberry-pi-pico', 0, 0);
  const servo = inst('comp.servo', 400, 40);
  p.boardInstances = [board];
  p.componentInstances = [servo];
  p.connections = [wire(servo, 'sig', board, 'GP15'), wire(servo, 'vcc', board, 'VBUS'), wire(servo, 'gnd', board, 'GND1')];
  p.codeFiles = [code('sketch.ino', `#include <Servo.h>
Servo s;
void setup() { s.attach(15); }
void loop() { unsigned long t = millis(); s.write(t < 400 ? 0 : t < 800 ? 90 : 180); delay(5); }`)];
  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    console.log('SKIP: the canvas build did not start');
    skipped++;
  } else {
    simulationController.pause();
    const angleAt = (ms: number) => {
      simulationController.advance(ms - useSimulationStore.getState().simTimeMs);
      simulationController.publishNow();
      return useSimulationStore.getState().visuals[servo.id]?.servoAngle;
    };
    simulationController.publishNow();
    const a0 = angleAt(350);
    const a90 = angleAt(750);
    const a180 = angleAt(1150);
    check(a0 !== undefined && Math.abs(a0) < 2, `the servo part shows 0° (${a0})`);
    check(a90 !== undefined && Math.abs(a90 - 90) < 2, `then 90° (${a90})`);
    check(a180 !== undefined && Math.abs(a180 - 180) < 2, `then 180° (${a180})`);
  }
  simulationController.stop();
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
