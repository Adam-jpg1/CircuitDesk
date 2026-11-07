// A Leonardo's Serial is USB, and now it is there.
//
// The ATmega32U4 has no UART behind `Serial`: it is a CDC port the chip's own
// USB controller presents to the computer. Without a model of that controller
// a Leonardo sketch's Serial.println() printed nothing and `while (!Serial);`
// — in nearly every Leonardo example — never returned.
//
// The Arduino core's USBCore.cpp runs unmodified against the register model in
// src/simulation/avr/usb32u4.ts, and a modelled host enumerates it the way a
// computer does. So this checks what a user would: the wait returns, what is
// printed arrives, what is typed is read, and none of it leaks onto USART1 —
// the pins D0/D1 that a wire could be on.
//
// Compiled for real; skips without arduino-cli.

import { compileProject } from '../server/compiler/compilerService';
import { detectArduinoCli } from '../server/compiler/arduinoCli';
import { AVRRunner } from '../src/simulation/avrRunner';
import { AVR_BOARD_PROFILES } from '../src/boards/pinMaps';
import { emptyProject, inst, code, bench } from '../src/project/templates';
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

const SKETCH = `void setup() {
  Serial.begin(9600);
  Serial1.begin(9600);
  while (!Serial);
  Serial.println("leonardo usb ready");
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
  { fqbn: 'arduino:avr:leonardo', boardId: 'board.arduino-leonardo', files: [{ name: 'sketch.ino', content: SKETCH }] },
  false,
);
check(built.success && !!built.firmware, 'a Leonardo sketch using Serial compiles');
if (!built.firmware) process.exit(1);
const LEO = Object.values(AVR_BOARD_PROFILES).find((p) => p.mcu === 'atmega32u4')!;

// ------------------------------------------------- the runner, directly
{
  const runner = new AVRRunner(built.firmware.data, LEO);
  let usb = '';
  let uart = '';
  runner.onUsbSerialByte = (b) => (usb += String.fromCharCode(b));
  runner.onSerialByte = (b) => (uart += String.fromCharCode(b));
  for (let ms = 0; ms < 500; ms += 10) runner.runFor(10);
  check(usb.startsWith('leonardo usb ready\r\n'), `while (!Serial) returns once the host opens the port, and the first line arrives (${JSON.stringify(usb.slice(0, 22))})`);
  check(/usb \d+\r\n/.test(usb), 'what loop() prints keeps arriving');
  check(/^uart 0\r\n/.test(uart), 'Serial1 still goes out on USART1');
  check(!usb.includes('uart') && !uart.includes('usb'), 'and neither stream carries the other: USB is not on D0/D1');
  runner.queueSerialInput('K');
  for (let ms = 0; ms < 200; ms += 10) runner.runFor(10);
  check(/got K/.test(usb), 'what is typed into the monitor arrives at Serial.read()');
}

// A sketch that never touches Serial is unaffected by the port being there.
{
  const blink = await compileProject(
    {
      fqbn: 'arduino:avr:leonardo',
      boardId: 'board.arduino-leonardo',
      files: [{ name: 'sketch.ino', content: 'void setup(){ pinMode(13, OUTPUT); }\nvoid loop(){ digitalWrite(13, HIGH); delay(20); digitalWrite(13, LOW); delay(20); }\n' }],
    },
    false,
  );
  const runner = new AVRRunner(blink.firmware!.data, LEO);
  for (let ms = 0; ms < 300; ms += 10) runner.runFor(10);
  check(runner.snapshot().toggles[13] >= 10, `a blink on D13 still blinks (${runner.snapshot().toggles[13]} toggles)`);
}

// ------------------------------------------------- the live simulation
const p = emptyProject('Leonardo USB serial');
p.boardInstances = [inst('board.arduino-leonardo', 0, 0)];
p.componentInstances = [];
p.connections = [];
p.codeFiles = [code('sketch.ino', SKETCH)];
p.tests = [bench('USB serial', '', [{ kind: 'serial-contains', text: 'leonardo usb ready', withinMs: 800 }], { timeoutMs: 800 })];

await simulationController.build(p);
const started = await simulationController.start();
check(started, 'the live simulation starts');
if (started) {
  simulationController.pause();
  simulationController.advance(500);
  simulationController.publishNow();
  check(/leonardo usb ready/.test(useSimulationStore.getState().serialText), 'the serial monitor shows what the sketch printed on Serial');
  simulationController.stop();
}

// ------------------------------------------------- the test bench
{
  const result = await runTest(p, { data: built.firmware.data, boardId: 'board.arduino-leonardo', format: built.firmware.format }, p.tests[0]);
  check(result.status === 'passed', `a bench's serial-contains sees Serial on a Leonardo (${result.status}${result.message ? ` — ${result.message}` : ''})`);
}

console.log(`\n--- ${failures} failing`);
process.exit(failures ? 1 : 0);
