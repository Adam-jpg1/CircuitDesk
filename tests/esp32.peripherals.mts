// The ESP32-C3 and ESP32-C6 peripherals Arduino sketches reach for, on
// compiled firmware.
//
// A feature matrix over every Simulated board found these two boards running
// GPIO, Serial and analogRead() and nothing else: analogWrite(), tone() and
// servos stopped on an unimplemented ROM call (the GPIO matrix routines) and
// then had no LED PWM controller to drive; Wire timed out, because ESP-IDF's
// i2c_master driver waits for an interrupt the controller never raised; SPI
// "worked" only because an unmodelled SPI2 read back zeros; and
// attachInterrupt() never fired. Each is now modelled from the chip's
// registers, and each is checked here at the pins and on the device buses:
//   * analogWrite(64) gives a 25% duty at the 1 kHz Arduino-ESP32 picks;
//   * tone(440) and tone(1000) toggle at those frequencies;
//   * ESP32Servo's write(0/90/180) gives its 544/1472/2400 µs pulses at 50 Hz,
//     as the library's 10-bit timer quantises them: 27, 75 and 122 of 1024
//     counts of 20 ms, which is 527.3, 1464.8 and 2382.8 µs on the chip too;
//   * RISING and FALLING interrupts count exactly their edges;
//   * a BMP280 on SDA/SCL answers its chip ID, an empty address NACKs, and an
//     SPI flash with CS on a GPIO returns its JEDEC ID.

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Runner = any;

const BOARDS = [
  {
    id: 'board.esp32-c3', fqbn: 'esp32:esp32:esp32c3', out: 'IO4', inA: 'IO5', inB: 'IO6', gnd: 'GND1', vcc: '3V3_1',
    sda: 'IO8', scl: 'IO9', sck: 'IO4', miso: 'IO5', mosi: 'IO6', cs: 'IO7',
  },
  {
    id: 'board.esp32-c6-devkitc-1', fqbn: 'esp32:esp32:esp32c6', out: 'IO4', inA: 'IO5', inB: 'IO6', gnd: 'GND1', vcc: '3V3_1',
    sda: 'IO23', scl: 'IO22', sck: 'IO21', miso: 'IO20', mosi: 'IO19', cs: 'IO18',
  },
] as const;

const num = (label: string) => label.replace(/^IO/, '');

async function boot(boardId: string, fqbn: string, sketch: string) {
  const built = await compileProject({ fqbn, boardId, files: [{ name: 'sketch.ino', content: sketch }] }, false);
  if (!built.firmware) {
    console.log(`SKIP: ${boardId} did not build here (${built.errors?.[0]?.message ?? ''})`);
    skipped++;
    return null;
  }
  const def = getBoardDefinition(boardId)!;
  const r: Runner = await getSimulatorAdapter(def)!.createRunner(built.firmware, def);
  let text = '';
  r.onSerialByte = (b: number) => (text += String.fromCharCode(b));
  return { r, def, out: () => text };
}

const run = (r: Runner, ms: number) => {
  for (let t = 0; t < ms; t += 10) r.runFor(10);
};

function edges(r: Runner, pad: number) {
  const rises: number[] = [];
  const falls: number[] = [];
  r.addPinListener((p: number, high: boolean) => {
    if (p === pad) (high ? rises : falls).push(r.timeMs);
  });
  return { rises, falls };
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);

for (const b of BOARDS) {
  console.log(`\n=== ${b.id}`);

  // ------------------------------------------------------------ analogWrite
  {
    const s = await boot(b.id, b.fqbn, `void setup() { analogWrite(${num(b.out)}, 64); } void loop() {}`);
    if (s) {
      const pad = runnerPinIndex(s.def, b.out)!;
      const e = edges(s.r, pad);
      run(s.r, 600);
      const recent = e.rises.filter((t) => t > s.r.timeMs - 100);
      const hz = 1000 / ((recent.at(-1)! - recent[0]) / (recent.length - 1));
      const highs = recent.slice(0, -1).map((rise) => (e.falls.find((f) => f > rise)! - rise));
      const duty = median(highs) / (1000 / hz);
      check(Math.abs(hz - 1000) < 10, `analogWrite() runs the pin at ${hz.toFixed(1)} Hz (Arduino-ESP32's 1 kHz)`);
      check(Math.abs(duty - 0.25) < 0.01, `with the 25% duty 64/256 asks for (${(duty * 100).toFixed(1)}%)`);
    }
  }

  // ------------------------------------------------------------------- tone
  {
    const s = await boot(b.id, b.fqbn, `void setup() { Serial.begin(115200); }
void loop() {
  if (!Serial.available()) return;
  int c = Serial.read();
  if (c == 'a') tone(${num(b.out)}, 440);
  if (c == 'b') tone(${num(b.out)}, 1000);
  if (c == 'x') noTone(${num(b.out)});
}`);
    if (s) {
      const pad = runnerPinIndex(s.def, b.out)!;
      const e = edges(s.r, pad);
      run(s.r, 600);
      for (const [key, hz] of [['a', 440], ['b', 1000]] as const) {
        s.r.queueSerialInput(key);
        run(s.r, 300);
        const recent = e.rises.filter((t) => t > s.r.timeMs - 150);
        const f = 1000 / ((recent.at(-1)! - recent[0]) / (recent.length - 1));
        check(Math.abs(f - hz) / hz < 0.01, `tone(${hz}) toggles at ${f.toFixed(1)} Hz`);
      }
      s.r.queueSerialInput('x');
      run(s.r, 100);
      const at = e.rises.length;
      run(s.r, 100);
      check(e.rises.length === at, 'noTone() stops it');
    }
  }

  // ------------------------------------------------------------- ESP32Servo
  {
    const s = await boot(b.id, b.fqbn, `#include <ESP32Servo.h>
Servo sv;
void setup() { Serial.begin(115200); sv.attach(${num(b.out)}); sv.write(0); }
void loop() { if (Serial.available()) { int a = Serial.parseInt(); while (Serial.available()) Serial.read(); sv.write(a); } }`);
    if (s) {
      const pad = runnerPinIndex(s.def, b.out)!;
      const e = edges(s.r, pad);
      const widths = (from: number) =>
        median(e.rises.filter((t) => t > from).map((rise) => ((e.falls.find((f) => f > rise) ?? NaN) - rise) * 1000).filter((w) => !Number.isNaN(w)));
      run(s.r, 700);
      const recent = e.rises.filter((t) => t > s.r.timeMs - 200);
      const period = (recent.at(-1)! - recent[0]) / (recent.length - 1);
      check(Math.abs(period - 20) < 0.3, `ESP32Servo pulses every ${period.toFixed(2)} ms (50 Hz)`);
      // The library's own arithmetic: floor(µs × 1024 / 20000) counts of a 20 ms period.
      const quantised = (us: number) => (Math.floor((us * 1024) / 20000) * 20000) / 1024;
      check(Math.abs(widths(s.r.timeMs - 200) - quantised(544)) < 2, `write(0) is ${widths(s.r.timeMs - 200).toFixed(1)} µs (544 → ${quantised(544).toFixed(1)})`);
      for (const [angle, us] of [[90, quantised(1472)], [180, quantised(2400)]] as const) {
        s.r.queueSerialInput(`${angle}\n`);
        run(s.r, 400);
        const w = widths(s.r.timeMs - 150);
        check(Math.abs(w - us) < 2, `write(${angle}) moves it to ${w.toFixed(1)} µs (${us.toFixed(1)})`);
      }
    }
  }

  // -------------------------------------------------------- attachInterrupt
  {
    const s = await boot(b.id, b.fqbn, `volatile int rises = 0, falls = 0;
void onRise() { rises++; }
void onFall() { falls++; }
void setup() {
  Serial.begin(115200);
  pinMode(${num(b.inA)}, INPUT_PULLUP);
  pinMode(${num(b.inB)}, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(${num(b.inA)}), onRise, RISING);
  attachInterrupt(digitalPinToInterrupt(${num(b.inB)}), onFall, FALLING);
}
void loop() { Serial.print("n "); Serial.print(rises); Serial.print(' '); Serial.println(falls); delay(20); }`);
    if (s) {
      const a = runnerPinIndex(s.def, b.inA)!;
      const c = runnerPinIndex(s.def, b.inB)!;
      run(s.r, 500);
      const pulse = (pad: number, n: number) => {
        for (let k = 0; k < n; k++) {
          s.r.setDigitalInput(pad, false);
          run(s.r, 2);
          s.r.setDigitalInput(pad, true);
          run(s.r, 2);
        }
      };
      pulse(a, 4);
      pulse(c, 3);
      run(s.r, 100);
      const n = [...s.out().matchAll(/n (\d+) (\d+)/g)].at(-1);
      check(n?.[1] === '4', `RISING on ${b.inA} counts its 4 rising edges (${n?.[1]})`);
      check(n?.[2] === '3', `FALLING on ${b.inB} counts its 3 falling edges (${n?.[2]})`);
    }
  }

  // ----------------------------------------------------- Wire and SPI devices
  {
    const p = emptyProject(`buses ${b.id}`);
    const board = inst(b.id, 0, 0);
    const bmp = inst('comp.bmp280', 400, 40);
    const flash = inst('comp.spi-flash', 400, 200);
    p.boardInstances = [board];
    p.componentInstances = [bmp, flash];
    p.connections = [
      wire(bmp, 'sda', board, b.sda), wire(bmp, 'scl', board, b.scl),
      wire(bmp, 'vcc', board, b.vcc), wire(bmp, 'gnd', board, b.gnd),
      wire(flash, 'sck', board, b.sck), wire(flash, 'mosi', board, b.mosi), wire(flash, 'miso', board, b.miso),
      wire(flash, 'cs', board, b.cs), wire(flash, 'vcc', board, b.vcc), wire(flash, 'gnd', board, b.gnd),
    ];
    p.codeFiles = [code('sketch.ino', `#include <Wire.h>
#include <SPI.h>
const int CS = ${num(b.cs)};
uint8_t reg(uint8_t addr, uint8_t r) {
  Wire.beginTransmission(addr);
  Wire.write(r);
  if (Wire.endTransmission(false) != 0) return 0xEE;
  Wire.requestFrom(addr, (uint8_t)1);
  return Wire.available() ? Wire.read() : 0xEF;
}
void setup() {
  Serial.begin(115200);
  Wire.begin();
  Serial.print("ID "); Serial.println(reg(0x76, 0xD0), HEX);
  Wire.beginTransmission(0x50);
  Serial.print("NOBODY "); Serial.println(Wire.endTransmission());
  pinMode(CS, OUTPUT);
  digitalWrite(CS, HIGH);
  SPI.begin();
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  digitalWrite(CS, LOW);
  SPI.transfer(0x9F);
  uint8_t a = SPI.transfer(0), m = SPI.transfer(0), c = SPI.transfer(0);
  digitalWrite(CS, HIGH);
  Serial.print("JEDEC "); Serial.print(a, HEX); Serial.print(' '); Serial.print(m, HEX); Serial.print(' '); Serial.println(c, HEX);
}
void loop() {}
`)];
    simulationController.stop();
    const report = await simulationController.build(p);
    if (!report.anyRunnable || !(await simulationController.start())) {
      console.log(`SKIP: ${b.id} did not build or start here`);
      skipped++;
    } else {
      simulationController.pause();
      for (let t = 0; t < 1500 && simulationController.advance(50); t += 50);
      simulationController.publishNow();
      const state = useSimulationStore.getState();
      const text = state.serialText ?? '';
      check(state.status !== 'error', `the bus sketch runs (${state.error ?? 'no error'})`);
      check(/ID 58/.test(text), `a BMP280 on ${b.sda}/${b.scl} answers its chip ID (${text.match(/ID \w+/)?.[0] ?? 'nothing'})`);
      check(/NOBODY 2/.test(text), `an address nobody answers NACKs (${text.match(/NOBODY \d+/)?.[0] ?? 'nothing'})`);
      check(/JEDEC EF 40 14/.test(text), `an SPI flash on SCK/MOSI/MISO returns its JEDEC ID (${text.match(/JEDEC[ \w]*/)?.[0] ?? 'nothing'})`);
      simulationController.stop();
    }
  }
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
