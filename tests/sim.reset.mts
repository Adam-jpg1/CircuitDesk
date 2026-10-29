// The workbench's Reset button: the project goes back to how it was before Run
// was pressed, and starts again.
//
// It used to reset nothing at all on the AVR boards, then only the
// microcontrollers — so every part kept what the sketch last did to it until
// the restarted sketch changed it. Now each Simulated board runs a sketch that
// counts on Serial, is Reset mid-run, and has to count from the start again;
// and an LCD the sketch wrote to has to look as it did before Run.

import { BOARD_DEFINITIONS } from '../src/boards/definitions';
import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject, inst, code, wire } from '../src/project/templates';

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

  await simulationController.reset();
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

// The project goes back to how it was before Run: a display the sketch wrote
// to shows what it showed then — nothing — not the sketch's last frame, until
// the restarted sketch writes to it again.
{
  console.log('\n--- a display after Reset');
  const p = emptyProject('reset display');
  const uno = inst('board.arduino-uno', 0, 0);
  const lcd = inst('comp.lcd1602', 360, 40);
  p.boardInstances = [uno];
  p.componentInstances = [lcd];
  p.connections = [wire(lcd, 'sda', uno, 'A4'), wire(lcd, 'scl', uno, 'A5'), wire(lcd, 'vcc', uno, '5V'), wire(lcd, 'gnd', uno, 'GND_PWR1')];
  // The HD44780-over-PCF8574 protocol written out, as the creator projects do,
  // so the test needs no display library.
  p.codeFiles = [code('sketch.ino', `#include <Wire.h>
const byte LCD = 0x27;
void lcdNibble(byte bits, byte mode) {
  byte b = (bits & 0xF0) | mode | 0x08;
  Wire.beginTransmission(LCD); Wire.write(b | 0x04); Wire.write(b); Wire.endTransmission();
}
void lcdSend(byte v, byte mode) { lcdNibble(v, mode); lcdNibble(v << 4, mode); }
void lcdBegin() {
  delay(50);
  lcdNibble(0x30, 0); delay(5); lcdNibble(0x30, 0); delay(1); lcdNibble(0x30, 0); lcdNibble(0x20, 0);
  lcdSend(0x28, 0); lcdSend(0x0C, 0); lcdSend(0x06, 0); lcdSend(0x01, 0); delay(2);
}
int n = 0;
void setup() { Wire.begin(); delay(300); lcdBegin(); }
void loop() {
  char line[17];
  snprintf(line, sizeof line, "count %d", n++);
  lcdSend(0x80, 0);
  for (byte i = 0; i < 16; i++) lcdSend(line[i] ? line[i] : ' ', 0x01);
  delay(100);
}
`)];
  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    console.log('SKIP: the LCD sketch did not build or start here');
    skipped++;
  } else {
    const text = () => (useSimulationStore.getState().visuals[lcd.id]?.readout ?? []).join('|');
    const beforeRun = text();
    simulationController.pause();
    for (let t = 0; t < 2000 && simulationController.advance(50); t += 50);
    simulationController.publishNow();
    const running = text();
    check(/count \d+/.test(running), `the sketch writes to the display (${JSON.stringify(running)})`);
    await simulationController.reset();
    const afterReset = text();
    check(afterReset === beforeRun, `Reset puts the display back to how it was before Run (${JSON.stringify(afterReset)}, was ${JSON.stringify(beforeRun)})`);
    check(useSimulationStore.getState().status === 'paused', 'a paused run stays paused at its first instant');
    for (let t = 0; t < 2000 && simulationController.advance(50); t += 50);
    simulationController.publishNow();
    const counts = /count (\d+)/.exec(text())?.[1];
    check(counts !== undefined && Number(counts) < Number(/count (\d+)/.exec(running)?.[1] ?? 0) + 5, `and the restarted sketch draws again from the start (${JSON.stringify(text())})`);
    simulationController.stop();
  }
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
