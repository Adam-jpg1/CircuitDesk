// The Feather M0 starter does what it says, on the canvas, from real firmware.
//
// The template is a user's first contact with a SAMD21 board, so each sentence
// of its description is checked through the live simulation: the LED on D10
// blinks, the potentiometer on A1 changes the rate (and reaches Serial, the
// USB port), and holding the button on D12 keeps the LED lit. Its own test
// bench passes, and reports the pin by the label printed on the board.
//
// Compiled for real; skips without arduino-cli and the adafruit:samd core.

import { compileProject } from '../server/compiler/compilerService';
import { detectArduinoCli } from '../server/compiler/arduinoCli';
import { PROJECT_TEMPLATES } from '../src/project/templates';
import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { runTest } from '../src/testing/testRunner';

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

const template = PROJECT_TEMPLATES.find((t) => t.id === 'tpl.feather-m0-blink');
check(template !== undefined, 'the Feather M0 starter exists');
if (!template) process.exit(1);
const p = template.build();
const led = p.componentInstances.find((c) => c.definitionId === 'comp.led')!;
const button = p.componentInstances.find((c) => c.definitionId === 'comp.push-button')!;
const pot = p.componentInstances.find((c) => c.definitionId === 'comp.potentiometer')!;

simulationController.stop();
const report = await simulationController.build(p);
check(report.builds[0]?.status === 'built', `it builds (${report.builds[0]?.detail})`);
check(await simulationController.start(), 'and starts');
simulationController.pause();

/** LED on/off transitions seen on the canvas over `ms`, sampled every 10 ms. */
function watch(ms: number): { flips: number; onFraction: number } {
  let last: boolean | undefined;
  let flips = 0;
  let on = 0;
  for (let t = 0; t < ms; t += 10) {
    simulationController.advance(10);
    simulationController.publishNow();
    const lit = useSimulationStore.getState().visuals[led.id]?.ledOn === true;
    if (lit) on++;
    if (last !== undefined && lit !== last) flips++;
    last = lit;
  }
  return { flips, onFraction: on / (ms / 10) };
}

useSimulationStore.getState().setPot(pot.id, 0);
watch(800); // past the core's half-second USB hold
const fast = watch(2000);
useSimulationStore.getState().setPot(pot.id, 1);
watch(700);
const slow = watch(2000);
console.log(`   knob at 0: ${fast.flips} flips in 2 s; knob at full: ${slow.flips} flips`);
check(fast.flips >= 20, 'with the knob down the LED blinks quickly (~60 ms half-period)');
check(slow.flips >= 4 && slow.flips <= fast.flips / 3, 'with the knob up it blinks several times slower');

simulationController.publishNow();
const serial = useSimulationStore.getState().serialText ?? '';
check(serial.includes('feather m0 ready'), 'Serial over USB reaches the monitor');
const knobs = [...serial.matchAll(/knob (\d+)/g)].map((m) => Number(m[1]));
check(knobs.includes(0) && knobs.some((k) => k >= 1015), `and reports the knob at both ends (${Math.min(...knobs)}..${Math.max(...knobs)})`);

useSimulationStore.getState().pressButton(button.id, true);
// The sketch looks at the button at the top of loop(), so a press lands once
// the blink in progress (up to ~630 ms with the knob up) has finished.
watch(800);
const held = watch(1000);
check(held.flips === 0 && held.onFraction === 1, `holding the button keeps the LED lit (${held.flips} flips, on ${held.onFraction})`);
useSimulationStore.getState().pressButton(button.id, false);
useSimulationStore.getState().resetInputs();
simulationController.stop();

// The template's own bench, through the runner a user's Test button uses.
const built = await compileProject({ fqbn: 'adafruit:samd:adafruit_feather_m0', boardId: 'board.adafruit-feather', files: [{ name: 'sketch.ino', content: p.codeFiles[0].content }] }, false);
if (built.firmware) {
  const result = await runTest(p, { data: built.firmware.data, boardId: 'board.adafruit-feather', format: built.firmware.format }, p.tests[0]);
  check(result.status === 'passed', `the template's bench passes (${result.assertionResults.map((a) => `${a.expected} -> ${a.actual}`).join('; ')})`);
  check(result.assertionResults.length > 0 && result.assertionResults.every((a) => a.expected.startsWith('D10 ')), 'and names the pin D10, as the board prints it, not pad 18');
} else {
  check(false, `the sketch compiles for the bench (${built.error})`);
}

console.log(`\n--- ${failures} failing`);
process.exit(failures ? 1 : 0);
