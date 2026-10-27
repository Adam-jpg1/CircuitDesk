// The circuit is there before the first instruction.
//
// On a bench, a joystick's wipers, a sensor's output and a pull-up are all on
// the pins the moment the board powers up. The simulator resolved the circuit
// only after each slice of firmware, so a sketch that read an input in its
// first millisecond read 0 V — a centred stick looked hard over, and the snake
// game turned on its own and started before anyone touched it.
//
// Held under both ways firmware runs: the test bench's runner and the live
// controller. Compiled for real; skips without arduino-cli.

import { compileProject } from '../server/compiler/compilerService';
import { detectArduinoCli } from '../server/compiler/arduinoCli';
import { emptyProject, inst, wire, code, bench } from '../src/project/templates';
import { runTest } from '../src/testing/testRunner';
import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const cli = await detectArduinoCli();
if (!cli.available || !cli.avrCoreInstalled) {
  console.log('SKIP: arduino-cli with the AVR core is not available here');
  process.exit(0);
}

// The very first thing the sketch does is read the stick.
const SKETCH = `int firstX, firstY;
void setup() {
  firstX = analogRead(A0);
  firstY = analogRead(A1);
  Serial.begin(115200);
  Serial.print("first ");
  Serial.print(firstX);
  Serial.print(" ");
  Serial.println(firstY);
}
void loop() {}
`;

const p = emptyProject('Power-up read');
const uno = inst('board.arduino-uno', 0, 200);
const stick = inst('comp.joystick', 300, 40);
p.boardInstances = [uno];
p.componentInstances = [stick];
p.connections = [
  wire(stick, 'vcc', uno, '5V'),
  wire(stick, 'gnd', uno, 'GND_PWR1'),
  wire(stick, 'vrx', uno, 'A0'),
  wire(stick, 'vry', uno, 'A1'),
];
p.codeFiles = [code('sketch.ino', SKETCH)];
p.tests = [bench('first read', '', [{ kind: 'serial-contains', text: 'first', withinMs: 300 }], { timeoutMs: 300 })];

const built = await compileProject({ fqbn: 'arduino:avr:uno', boardId: 'board.arduino-uno', files: [{ name: 'sketch.ino', content: SKETCH }] }, false);
check(built.success && !!built.firmware, 'the sketch compiles');
const firstRead = (text: string) => {
  const m = /first (\d+) (\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2])] : null;
};
const centred = (v: number[] | null) => v !== null && v.every((n) => n > 480 && n < 545);

if (built.firmware) {
  const result = await runTest(p, { data: built.firmware.data, boardId: 'board.arduino-uno', format: built.firmware.format }, p.tests[0]);
  const v = firstRead(result.serialOutput ?? '');
  check(centred(v), `under the test bench, the first read of a centred stick is half scale (${v?.join(', ') ?? 'nothing'})`);
}

await simulationController.build(p);
const started = await simulationController.start();
check(started, 'the live simulation starts');
if (started) {
  simulationController.pause();
  simulationController.advance(200);
  simulationController.publishNow();
  const v = firstRead(useSimulationStore.getState().serialText);
  check(centred(v), `live, the first read of a centred stick is half scale (${v?.join(', ') ?? 'nothing'})`);
  simulationController.stop();
}

console.log(`\n--- ${failures} failing`);
process.exit(failures ? 1 : 0);
