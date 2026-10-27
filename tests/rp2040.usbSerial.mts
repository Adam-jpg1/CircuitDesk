// A Pico's Serial is USB, and now it reaches the monitor.
//
// On every Arduino-Pico board `Serial` is the USB CDC port and `Serial1` is
// UART0 on GP0/GP1. Only the UART was modelled, so the plain Serial.println()
// that nearly every Pico sketch uses printed nothing — the board looked dead.
// The runner now has a USB host on its socket: rp2040js enumerates the device
// on the machine's own clock and opens the port, and what the firmware sends
// goes to the monitor.
//
// What must not happen is the opposite mistake: USB bytes are not on any wire,
// so nothing wired to GP0 may hear them. The runner keeps the two streams
// apart and that is asserted directly.
//
// Compiled for real; skips without arduino-cli and the RP2040 core.

import { compileProject } from '../server/compiler/compilerService';
import { detectArduinoCli } from '../server/compiler/arduinoCli';
import { emptyProject, inst, code, bench } from '../src/project/templates';
import { Rp2040Runner } from '../src/simulation/rp2040/rp2040Runner';
import { runTest } from '../src/testing/testRunner';
import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';

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

const SKETCH = `void setup() {
  Serial.begin(115200);
  Serial1.begin(115200);
}
unsigned long n = 0;
void loop() {
  Serial.print("usb ");
  Serial.println(n);
  Serial1.print("uart ");
  Serial1.println(n);
  n++;
  while (Serial.available()) {
    int c = Serial.read();
    Serial.print("got ");
    Serial.println((char)c);
  }
  delay(50);
}
`;

const built = await compileProject(
  { fqbn: 'rp2040:rp2040:rpipico', boardId: 'board.raspberry-pi-pico', files: [{ name: 'sketch.ino', content: SKETCH }] },
  false,
);
if (!built.success || !built.firmware) {
  console.log(`SKIP: the RP2040 core is not available here (${built.error ?? 'no firmware'})`);
  process.exit(0);
}
const firmware = Uint8Array.from(atob(built.firmware.data), (c) => c.charCodeAt(0));

// ------------------------------------------------- the runner, directly
{
  const runner = new Rp2040Runner(firmware);
  let usb = '';
  let uart = '';
  runner.onUsbSerialByte = (b) => (usb += String.fromCharCode(b));
  runner.onSerialByte = (b) => (uart += String.fromCharCode(b));
  for (let t = 0; t < 1000; t += 10) runner.runFor(10);
  check(/usb \d+\r\n/.test(usb), `Serial reaches the USB host (${JSON.stringify(usb.slice(0, 24))}…)`);
  check(/uart \d+\r\n/.test(uart), 'Serial1 still reaches UART0');
  check(!usb.includes('uart') && !uart.includes('usb'), 'and neither stream carries the other: USB is not on the GP0 wire');
  runner.queueSerialInput('Z');
  for (let t = 0; t < 300; t += 10) runner.runFor(10);
  check(/got Z/.test(usb), 'what is typed into the monitor arrives at Serial.read()');
  runner.dispose();
}

// ------------------------------------------------- the live simulation
const p = emptyProject('USB serial');
p.boardInstances = [inst('board.raspberry-pi-pico', 0, 0)];
p.componentInstances = [];
p.connections = [];
p.codeFiles = [code('sketch.ino', SKETCH)];
p.tests = [bench('USB serial', '', [{ kind: 'serial-contains', text: 'usb 5', withinMs: 1500 }], { timeoutMs: 1500 })];

await simulationController.build(p);
const started = await simulationController.start();
check(started, 'the live simulation starts');
if (started) {
  simulationController.pause();
  simulationController.advance(800);
  simulationController.publishNow();
  const text = useSimulationStore.getState().serialText;
  check(/usb \d+/.test(text), 'the serial monitor shows what the sketch printed on Serial');
  simulationController.stop();
}

// ------------------------------------------------- the test bench
{
  const result = await runTest(p, { data: built.firmware.data, boardId: 'board.raspberry-pi-pico', format: built.firmware.format }, p.tests[0]);
  check(result.status === 'passed', `a bench's serial-contains sees Serial on a Pico (${result.status}${result.message ? ` — ${result.message}` : ''})`);
}

console.log(`\n--- ${failures} failing`);
process.exit(failures ? 1 : 0);
