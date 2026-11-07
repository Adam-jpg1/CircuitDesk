// SAMD21 boards run real firmware.
//
// The Feather M0 and QT Py M0 were wiring-only. They now build with Adafruit's
// SAMD core and execute on a SAMD21 chip model over rp2040js's Cortex-M0+ core
// (the two chips share the CPU and nothing else). What a user tries first must
// hold on both, from real compiled firmware:
//   * the core's startup completes and setup() and loop() run;
//   * a pin blinks at the rate delay() asks for, on the pad the label means;
//   * Serial — native USB on these boards — reaches the monitor, waits for the
//     host in `while (!Serial)`, and reads what is typed;
//   * digitalRead sees a pull-up and an external drive, analogRead a voltage;
//   * Serial1 goes out of the board's UART, and only there;
//   * firmware built for something else is refused.
//
// Compiled for real; skips without arduino-cli and the adafruit:samd core.

import { compileProject } from '../server/compiler/compilerService';
import { detectArduinoCli } from '../server/compiler/arduinoCli';
import { Samd21Runner } from '../src/simulation/samd21/samd21Runner';
import { getBoardDefinition } from '../src/boards/definitions';
import { runnerPinIndex } from '../src/simulation/boardRunner';
import { getSimulatorAdapter } from '../src/simulation/adapters';

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

const boards = [
  { id: 'board.adafruit-feather', fqbn: 'adafruit:samd:adafruit_feather_m0', blink: 'D13', input: 'D12', analog: 'A1' },
  { id: 'board.adafruit-qtpy', fqbn: 'adafruit:samd:adafruit_qtpy_m0', blink: 'SCL', input: 'SDA', analog: 'A0' },
  { id: 'board.seeed-xiao', fqbn: 'Seeeduino:samd:seeed_XIAO_m0', blink: 'A8', input: 'A9', analog: 'A0' },
] as const;

for (const b of boards) {
  console.log(`\n--- ${b.id}`);
  const def = getBoardDefinition(b.id)!;
  check(def.supportLevel === 'simulated', `${b.id} is badged Simulated`);
  const blinkPad = runnerPinIndex(def, b.blink)!;
  const inputPad = runnerPinIndex(def, b.input)!;
  // The sketch uses the board's own names, which its variant defines.
  const sketch = `const int LED = ${b.blink === 'D13' ? 13 : b.blink === 'A8' ? 8 : b.blink};
const int IN = ${b.input === 'D12' ? 12 : b.input === 'A9' ? 9 : b.input};
void setup() {
  pinMode(LED, OUTPUT);
  pinMode(IN, INPUT_PULLUP);
  Serial.begin(115200);
  Serial1.begin(9600);
  while (!Serial);
  Serial.println("samd ready");
  Serial1.println("uart side");
}
unsigned long n = 0;
void loop() {
  digitalWrite(LED, HIGH);
  delay(50);
  digitalWrite(LED, LOW);
  delay(50);
  Serial.print("in=");
  Serial.print(digitalRead(IN));
  Serial.print(" a=");
  Serial.println(analogRead(${b.analog}));
  while (Serial.available()) {
    int c = Serial.read();
    Serial.print("got ");
    Serial.println((char)c);
  }
}
`;
  const built = await compileProject({ fqbn: b.fqbn, boardId: b.id, files: [{ name: 'sketch.ino', content: sketch }] }, false);
  if (!built.success || !built.firmware) {
    console.log(`SKIP: ${b.id} did not build here (${built.error ?? 'no firmware'})`);
    skipped++;
    continue;
  }
  check(built.firmware.format === 'intel-hex', `it builds to Intel HEX (${built.firmware.format})`);

  const runner = (await getSimulatorAdapter(def)!.createRunner(built.firmware, def)) as Samd21Runner;
  check(runner.engine === 'samd21', 'and the board\'s adapter runs it on the SAMD21 engine');
  let usb = '';
  let uart = '';
  runner.onUsbSerialByte = (x) => (usb += String.fromCharCode(x));
  runner.onSerialByte = (x) => (uart += String.fromCharCode(x));
  // The SAMD core's Serial reports "not connected" for the first 500 ms after
  // boot (to avoid a spurious open after an upload), so `while (!Serial)`
  // holds setup() that long, as on the board. The blink is measured after.
  for (let t = 0; t < 700; t += 20) runner.runFor(20);
  const before = runner.snapshot().toggles[blinkPad];
  for (let t = 0; t < 1000; t += 20) runner.runFor(20);
  const toggles = runner.snapshot().toggles[blinkPad] - before;
  check(toggles >= 18 && toggles <= 21, `${b.blink} (pad ${blinkPad}) blinks at the rate delay() asks for (${toggles} toggles in 1 s, ~20 expected)`);
  check(usb.startsWith('samd ready\r\n'), `while (!Serial) returns once the host opens the port, and Serial reaches the monitor (${JSON.stringify(usb.slice(0, 14))})`);
  check(/in=1 /.test(usb), 'INPUT_PULLUP reads high with nothing connected');
  check(/^uart side\r\n/.test(uart) && !usb.includes('uart side') && !uart.includes('samd'), `Serial1 goes out of the UART, and only there (${JSON.stringify(uart.slice(0, 12))})`);

  runner.setDigitalInput(inputPad, false);
  const channel = runner.adcChannelForPin(runnerPinIndex(def, b.analog)!);
  check(channel !== undefined, `${b.analog} has an ADC channel`);
  if (channel !== undefined) runner.setAnalogVolts(channel, 1.65);
  runner.queueSerialInput('K');
  usb = '';
  for (let t = 0; t < 400; t += 20) runner.runFor(20);
  check(/in=0 /.test(usb), 'driving the input low is read as 0');
  const reading = Number(/a=(\d+)/.exec(usb)?.[1] ?? NaN);
  check(reading >= 505 && reading <= 518, `analogRead of 1.65 V is half scale (${reading})`);
  check(/got K/.test(usb), 'what is typed into the monitor arrives at Serial.read()');
  runner.dispose();
}

// Firmware for something else is refused, not executed.
{
  const avr = await compileProject(
    { fqbn: 'arduino:avr:uno', boardId: 'board.arduino-uno', files: [{ name: 'sketch.ino', content: 'void setup(){}\nvoid loop(){}\n' }] },
    false,
  );
  if (avr.firmware) {
    let refused = false;
    try {
      new Samd21Runner(avr.firmware.data);
    } catch {
      refused = true;
    }
    check(refused, 'an Uno image (linked at 0, where these boards keep their bootloader) is refused');
  }
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
