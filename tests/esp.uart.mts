// Serial on the ESP32-C3 and ESP32-C6: the UART the IDF driver talks to.
//
// Before this, the two RISC-V ESP runners had no UART at all — a sketch's LED
// blinked and Serial.println() went nowhere, on three boards badged Simulated.
// What has to hold, on both chips:
//   * what is printed reaches the monitor, and nothing else arrives first;
//   * what is typed reaches Serial.read();
//   * Serial.flush() returns (the driver waits for TX_DONE);
//   * the line runs at the rate Serial.begin() asked for, so printing faster
//     than 9600 baud can carry takes as long as it would on the chip.
//
// Compiled for real; skips without arduino-cli and the ESP32 core.

import { compileProject } from '../server/compiler/compilerService';
import { detectArduinoCli } from '../server/compiler/arduinoCli';
import { createEsp32C3Runner } from '../src/simulation/espRiscvRunner';
import { createEsp32C6Runner } from '../src/simulation/esp32c6Runner';
import type { EspRiscvRunner } from '../src/simulation/espRiscvRunner';

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

const ECHO = `void setup() {
  Serial.begin(115200);
  Serial.println("esp ready");
}
void loop() {
  while (Serial.available()) {
    int c = Serial.read();
    Serial.print("got ");
    Serial.println((char)c);
  }
  delay(10);
}
`;

// 900 characters at 9600 baud is 9000 bit-times: about 0.94 s on the wire.
const PACED = `void setup() {
  Serial.begin(9600);
  Serial.println("start");
  Serial.flush();
  unsigned long t0 = millis();
  for (int i = 0; i < 30; i++) Serial.println("0123456789012345678901234567");
  Serial.flush();
  Serial.print("took ");
  Serial.println(millis() - t0);
}
void loop() {}
`;

const chips = [
  { name: 'ESP32-C3', fqbn: 'esp32:esp32:esp32c3', boardId: 'board.esp32-c3', create: createEsp32C3Runner },
  { name: 'ESP32-C6', fqbn: 'esp32:esp32:esp32c6', boardId: 'board.esp32-c6-devkitc-1', create: createEsp32C6Runner },
] as const;

async function runnerFor(chip: (typeof chips)[number], source: string): Promise<EspRiscvRunner | null> {
  const built = await compileProject({ fqbn: chip.fqbn, boardId: chip.boardId, files: [{ name: 'sketch.ino', content: source }] }, false);
  if (!built.success || !built.firmware) {
    console.log(`SKIP: ${chip.name} did not build here (${built.error ?? 'no firmware'})`);
    return null;
  }
  const image = Uint8Array.from(atob(built.firmware.data), (c) => c.charCodeAt(0));
  return chip.create(image, built.firmware.regions ?? []);
}

for (const chip of chips) {
  console.log(`\n--- ${chip.name}`);
  const echo = await runnerFor(chip, ECHO);
  if (echo) {
    let out = '';
    echo.onSerialByte = (b) => (out += String.fromCharCode(b));
    for (let t = 0; t < 400; t += 20) echo.runFor(20);
    check(out.startsWith('esp ready'), `the sketch's first line is the first thing on the monitor (${JSON.stringify(out.slice(0, 16))})`);
    echo.queueSerialInput('Q');
    for (let t = 0; t < 200; t += 20) echo.runFor(20);
    check(/got Q/.test(out), 'what is typed into the monitor arrives at Serial.read()');
    check(Math.round(echo.uartBaudRate ?? 0) > 114000 && Math.round(echo.uartBaudRate ?? 0) < 116500, `the line runs at the rate Serial.begin() asked for (${Math.round(echo.uartBaudRate ?? 0)})`);
    echo.dispose();
  }

  const paced = await runnerFor(chip, PACED);
  if (paced) {
    let out = '';
    paced.onSerialByte = (b) => (out += String.fromCharCode(b));
    for (let t = 0; t < 2500; t += 50) paced.runFor(50);
    const took = Number(/took (\d+)/.exec(out)?.[1] ?? NaN);
    check(/took \d+/.test(out), 'Serial.flush() returns, so the line after it is printed');
    check(took > 850 && took < 1100, `900 characters at 9600 baud take as long as the wire needs (${took} ms, ~940 expected)`);
    paced.dispose();
  }
}

console.log(`\n--- ${failures} failing`);
process.exit(failures ? 1 : 0);
