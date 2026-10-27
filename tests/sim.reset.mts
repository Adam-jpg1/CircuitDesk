// The workbench's reset button restarts the firmware, on every board.
//
// The button calls simulationController.reset(), which resets each board's
// runner. The AVR runner had no reset() at all, and the call was optional, so
// on the Uno, Nano, Mega, Leonardo and Pro Mini the button did nothing: the
// sketch carried on counting where it was. Each Simulated board here runs a
// sketch that counts on Serial, is reset mid-run, and has to count from the
// start again — from the reset, not from where it left off.

import { BOARD_DEFINITIONS } from '../src/boards/definitions';
import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject, inst, code } from '../src/project/templates';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

// Boards whose Serial is USB wait for the host, as a real sketch does, so the
// count is not printed before anyone is listening.
const SKETCH = `int n = 0;
void setup() {
  Serial.begin(115200);
  unsigned long start = millis();
  while (!Serial && millis() - start < 2000) delay(10);
}
void loop() { Serial.println(n++); delay(50); }
`;

const numbers = () =>
  (useSimulationStore.getState().serialText ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number);

const simulated = BOARD_DEFINITIONS.filter((b) => b.supportLevel === 'simulated' && b.simulation?.supported);
check(simulated.length >= 14, `every Simulated board is covered (${simulated.length})`);

for (const board of simulated) {
  console.log(`\n--- ${board.id}`);
  const p = emptyProject(`reset ${board.id}`);
  p.boardInstances = [inst(board.id, 0, 0)];
  p.codeFiles = [code('sketch.ino', SKETCH)];
  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    console.log(`SKIP: ${board.id} did not build or start here`);
    skipped++;
    continue;
  }
  simulationController.pause();
  for (let t = 0; t < 1500 && simulationController.advance(50); t += 50);
  simulationController.publishNow();
  const before = numbers();
  const reached = Math.max(...before);
  check(reached >= 10, `the sketch is counting before the reset (reached ${reached})`);

  simulationController.reset();
  check(useSimulationStore.getState().status !== 'error', `reset() does not fail (${useSimulationStore.getState().error ?? 'no error'})`);
  check(simulationController.hasFirmware, 'and the firmware is still loaded');
  for (let t = 0; t < 1200 && simulationController.advance(50); t += 50);
  simulationController.publishNow();
  const after = numbers();
  check(after.length >= 5, `it runs again after the reset (${after.length} lines)`);
  check(after.length > 0 && after[0] <= 1, `and counts from the start, not from ${reached} (first number ${after[0]})`);
  check(after.every((value, i) => i === 0 || value === after[i - 1] + 1), 'one run, not two interleaved');
  simulationController.stop();
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
