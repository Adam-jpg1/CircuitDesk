// The Arduino Uno R4 Minima, running real firmware from the Arduino Renesas
// core on the ARMv7-M core and the RA4M1 model — with Serial on native USB,
// enumerated by a simulated host.
//
// Each sketch is compiled by the same compiler service the app uses and run
// through the same adapter, then checked by what it does: what it prints, how
// fast time passes, what its pins do, and what the parts on the canvas see.

import { compileProject } from '../server/compiler/compilerService';
import { getSimulatorAdapter } from '../src/simulation/adapters';
import { getBoardDefinition } from '../src/boards/definitions';
import { runnerPinIndex, runnerAdcChannel } from '../src/simulation/boardRunner';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { emptyProject } from '../src/project/templates';
import type { CircuitProject, ComponentInstance } from '../src/types';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

const def = getBoardDefinition('board.arduino-uno-r4')!;
const FQBN = 'arduino:renesas_uno:minima';
check(def.simulation?.supported === true && def.simulation.engine === 'armv7m', 'the Uno R4 Minima is a simulated board on the ARMv7-M engine');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Runner = any;
async function boot(sketch: string): Promise<{ r: Runner; out: () => string } | null> {
  const built = await compileProject({ fqbn: FQBN, boardId: def.id, files: [{ name: 'sketch.ino', content: sketch }] }, false);
  if (!built.firmware) {
    console.log(`SKIP: the Uno R4 sketch did not build here (${built.errors?.[0]?.message ?? built.error ?? built.stderr?.slice(0, 200)})`);
    skipped++;
    return null;
  }
  check(built.firmware.format === 'bin', 'the artifact is a raw binary');
  const r: Runner = await getSimulatorAdapter(def)!.createRunner(built.firmware, def);
  // Serial is the USB port; Serial1 (the UART on D0/D1) is reported separately.
  let text = '';
  r.onUsbSerialByte = (b: number) => (text += String.fromCharCode(b));
  return { r, out: () => text };
}
const run = (r: Runner, ms: number, slice = 5) => {
  for (let t = 0; t < ms; t += slice) r.runFor(slice);
};
const pin = (label: string) => runnerPinIndex(def, label)!;
const last = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => m[1]).at(-1);

const WAIT = 'Serial.begin(115200); { unsigned long s0 = millis(); while (!Serial && millis() - s0 < 2000) {} }';

section('boot, Serial over USB, and time');
{
  // delayMicroseconds is timed before USB starts: once it runs, the host's
  // transfers interrupt the delay, as they would on the real board.
  const b = await boot(`void setup() { unsigned long u0 = micros(); delayMicroseconds(500); unsigned long du = micros() - u0;
  unsigned long b0 = millis(); ${WAIT} Serial.print("r4 ready after "); Serial.println(millis() - b0);
  unsigned long t0 = millis(); delay(1000); Serial.print("ms "); Serial.println(millis() - t0);
  Serial.print("us "); Serial.println(du);
  float f = 1.5f; for (int i = 0; i < 10; i++) f = f * 1.25f + 0.5f; Serial.print("f "); Serial.println(f, 3); }
void loop() { if (Serial.available()) { int c = Serial.read(); Serial.print("got "); Serial.println((char)c); } }`);
  if (b) {
    const t0 = performance.now();
    run(b.r, 1400);
    const wall = performance.now() - t0;
    const up = Number(last(b.out(), /ready after (\d+)/g));
    check(b.out().includes('r4 ready'), 'the USB port enumerates and Serial prints to the monitor');
    check(up < 500, `while (!Serial) returns once the host opens the port (${up} ms)`);
    const ms = Number(last(b.out(), /ms (\d+)/g));
    check(ms >= 1000 && ms <= 1001, `delay(1000) takes 1000 ms of simulated time (${ms})`);
    const us = Number(last(b.out(), /us (\d+)/g));
    // FSP's loop is the 4 cycles it assumes, so the delay is exact; what is
    // above 500 is the call and micros() themselves, and the 1 ms AGT tick.
    check(us >= 500 && us <= 530, `delayMicroseconds(500) takes about 500 µs (${us})`);
    let f = Math.fround(1.5);
    for (let i = 0; i < 10; i++) f = Math.fround(Math.fround(f * 1.25) + 0.5);
    check(last(b.out(), /f ([\d.]+)/g) === f.toFixed(3), `single-precision arithmetic on the FPU (${last(b.out(), /f ([\d.]+)/g)})`);
    console.log(`   1.4 s simulated in ${(wall / 1000).toFixed(2)} s`);
    b.r.queueSerialInput('Q');
    run(b.r, 50);
    check(/got Q/.test(b.out()), 'bytes typed in the monitor reach Serial.read() over USB');
  }
}

section('Serial1, the UART on D0/D1');
{
  const b = await boot(`void setup() { Serial1.begin(9600); Serial1.println("on serial1"); }
void loop() { if (Serial1.available()) { Serial1.write(Serial1.read() + 1); } }`);
  if (b) {
    let heard = '';
    b.r.onSerialByte = (byte: number) => (heard += String.fromCharCode(byte));
    run(b.r, 100);
    check(heard.includes('on serial1'), `its bytes go out on TX (${JSON.stringify(heard)})`);
    check(Math.abs(b.r.uartBaudRate - 9600) < 100, `at the baud firmware set (${b.r.uartBaudRate})`);
    heard = '';
    b.r.queueUartInput('ABC');
    run(b.r, 100);
    check(heard === 'BCD', `bytes arriving on RX reach Serial1.read() (${JSON.stringify(heard)})`);
    check(!b.out().includes('on serial1'), 'and none of it appears on the USB Serial');
  }
}

section('analogRead');
{
  const b = await boot(`void setup() { ${WAIT} }
void loop() { Serial.print("a "); Serial.println(analogRead(A0)); analogReadResolution(14); Serial.print("b "); Serial.println(analogRead(A0)); analogReadResolution(10); delay(20); }`);
  if (b) {
    const ch = runnerAdcChannel(def, 'A0')!;
    check(ch === 9 && b.r.adcChannelForPin(pin('A0')) === 9, `A0 is AN009 (P014), as on the board (${ch})`);
    b.r.setAnalogVolts(ch, 2.5);
    run(b.r, 300);
    const a = Number(last(b.out(), /a (\d+)/g));
    const v14 = Number(last(b.out(), /b (\d+)/g));
    check(Math.abs(a - 512) <= 1, `2.5 V reads half scale at 10 bits against 5 V (${a})`);
    check(Math.abs(v14 - 8192) <= 2, `and at 14 bits with analogReadResolution(14) (${v14})`);
  }
}

section('digital input and pull-ups');
{
  const b = await boot(`void setup() { ${WAIT} pinMode(2, INPUT_PULLUP); pinMode(4, INPUT); }
void loop() { Serial.print("d "); Serial.print(digitalRead(2)); Serial.println(digitalRead(4)); delay(10); }`);
  if (b) {
    run(b.r, 300);
    check(last(b.out(), /d (\d\d)/g)?.[0] === '1', 'an unconnected INPUT_PULLUP pin reads HIGH');
    check(b.r.digitalPinLevel(pin('D2')) === 'input-pullup', 'and is reported as a pulled-up input');
    b.r.setDigitalInput(pin('D2'), false);
    b.r.setDigitalInput(pin('D4'), true);
    run(b.r, 50);
    check(last(b.out(), /d (\d\d)/g) === '01', `the circuit's levels are what digitalRead sees (${last(b.out(), /d (\d\d)/g)})`);
  }
}

section('analogWrite on the GPT timers');
{
  const b = await boot(`void setup() { analogWrite(9, 64); analogWrite(3, 128); analogWrite(11, 191); } void loop() {}`);
  if (b) {
    run(b.r, 300);
    const before = b.r.snapshot();
    run(b.r, 200);
    const s = b.r.snapshot();
    const d9 = s.duty[pin('D9')];
    const d3 = s.duty[pin('D3')];
    const d11 = s.duty[pin('D11')];
    check(Math.abs(d9 - 64 / 255) < 0.02, `D9 (GPT7 B) runs at 64/255 (${d9.toFixed(3)})`);
    check(Math.abs(d3 - 128 / 255) < 0.02, `D3 (GPT1 B) runs at 128/255 (${d3.toFixed(3)})`);
    check(Math.abs(d11 - 191 / 255) < 0.02, `D11 (GPT1 A) runs at 191/255 (${d11.toFixed(3)})`);
    const toggles = s.toggles[pin('D9')] - before.toggles[pin('D9')];
    console.log(`   D9 made ${toggles} edges in 200 ms`);
    check(toggles >= 100, `at a steady PWM frequency (${toggles} edges in 200 ms)`);
  }
}

section('attachInterrupt');
{
  const b = await boot(`volatile int r = 0, c = 0; void onR() { r++; } void onC() { c++; }
void setup() { ${WAIT} pinMode(2, INPUT_PULLUP); pinMode(3, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(2), onR, RISING); attachInterrupt(digitalPinToInterrupt(3), onC, CHANGE); }
void loop() { Serial.print("i "); Serial.print(r); Serial.print(' '); Serial.println(c); delay(20); }`);
  if (b) {
    run(b.r, 300);
    for (let k = 0; k < 6; k++) {
      b.r.setDigitalInput(pin('D2'), false);
      b.r.setDigitalInput(pin('D3'), false);
      run(b.r, 3, 1);
      b.r.setDigitalInput(pin('D2'), true);
      b.r.setDigitalInput(pin('D3'), true);
      run(b.r, 3, 1);
    }
    run(b.r, 100);
    const got = last(b.out(), /i (\d+ \d+)/g);
    check(got === '6 12', `RISING counts 6 rises and CHANGE counts 12 changes (${got})`);
  }
}

section('Servo and tone');
{
  const b = await boot(`#include <Servo.h>
Servo s; void setup() { s.attach(6); s.writeMicroseconds(1500); tone(8, 1000); } void loop() {}`);
  if (b) {
    run(b.r, 300);
    const before = b.r.snapshot();
    run(b.r, 200);
    const s = b.r.snapshot();
    const w = s.pulseWidthUs[pin('D6')];
    const edges = s.toggles[pin('D6')] - before.toggles[pin('D6')];
    check(Math.abs(w - 1500) < 15, `Servo: a 1500 µs pulse (${w.toFixed(1)} µs)`);
    check(edges >= 18 && edges <= 22, `every 20 ms (${edges} edges in 200 ms)`);
    const toneEdges = s.toggles[pin('D8')] - before.toggles[pin('D8')];
    check(toneEdges >= 390 && toneEdges <= 410, `tone(8, 1000) toggles D8 at 1 kHz (${toneEdges} edges in 200 ms)`);
  }
}

section('EEPROM, kept in the data flash');
{
  const b = await boot(`#include <EEPROM.h>
void setup() { ${WAIT} Serial.print("before "); Serial.println(EEPROM.read(7)); EEPROM.write(7, 42);
  Serial.print("after "); Serial.println(EEPROM.read(7)); }
void loop() {}`);
  if (b) {
    run(b.r, 600);
    check(/before 255/.test(b.out()) && /after 42/.test(b.out()), `EEPROM.write then EEPROM.read (${JSON.stringify(b.out().replace(/r4 ready.*\r\n/, '').trim())})`);
    const data: Uint8Array = b.r.mcu.dataFlash;
    check(data.includes(42), 'and the byte is in the simulated data flash');
  }
}

section('on the canvas: an LED on D13 and an I2C EEPROM on Wire');
{
  let seq = 0;
  const uid = (p: string) => `${p}${++seq}`;
  const project: CircuitProject = emptyProject('r4');
  const board: ComponentInstance = { id: uid('b'), definitionId: 'board.arduino-uno-r4', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {} };
  project.boardInstances.push(board);
  const part = (definitionId: string, properties: Record<string, unknown> = {}) => {
    const p: ComponentInstance = { id: uid('c'), definitionId, x: 0, y: 0, rotation: 0, properties, simulationState: {} };
    project.componentInstances.push(p);
    return p;
  };
  const wire = (a: ComponentInstance, ap: string, b2: ComponentInstance, bp: string) =>
    project.connections.push({
      id: uid('w'), sourceComponentId: a.id, sourcePinId: ap, targetComponentId: b2.id, targetPinId: bp,
      netId: '', color: '#000', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  const r1 = part('comp.resistor', { resistance: 220 });
  const led = part('comp.led');
  wire(board, 'D13', r1, 'p1');
  wire(r1, 'p2', led, 'anode');
  wire(led, 'cathode', board, 'GND1');
  const ee = part('comp.eeprom-24c');
  wire(board, '5V', ee, 'vcc');
  wire(board, 'GND2', ee, 'gnd');
  wire(board, 'A4', ee, 'sda');
  wire(board, 'A5', ee, 'scl');

  const b = await boot(`#include <Wire.h>
void setup() { ${WAIT} pinMode(13, OUTPUT); Wire.begin();
  Wire.beginTransmission(0x50); Wire.write(0); Wire.write(5); Wire.write(0xA7); Wire.write(0x5C); int e = Wire.endTransmission(); delay(10);
  Wire.beginTransmission(0x50); Wire.write(0); Wire.write(5); Wire.endTransmission(); Wire.requestFrom(0x50, 1);
  int v = Wire.available() ? Wire.read() : -1;
  Wire.beginTransmission(0x50); Wire.write(0); Wire.write(5); Wire.endTransmission(); Wire.requestFrom(0x50, 2);
  int v2 = Wire.read(); int v3 = Wire.read();
  Wire.beginTransmission(0x50); Wire.write(0); Wire.write(4); Wire.endTransmission(); Wire.requestFrom(0x50, 3);
  int w1 = Wire.read(); int w2 = Wire.read(); int w3 = Wire.read();
  Serial.print("ee "); Serial.print(e); Serial.print(' '); Serial.print(v); Serial.print(' '); Serial.print(v2); Serial.print(' '); Serial.print(v3);
  Serial.print(' '); Serial.print(w1); Serial.print(' '); Serial.print(w2); Serial.print(' '); Serial.println(w3);
  Wire.beginTransmission(0x51); Serial.print("absent "); Serial.println(Wire.endTransmission()); }
void loop() { digitalWrite(13, HIGH); delay(100); digitalWrite(13, LOW); delay(100); }`);
  if (b) {
    const binding = new CircuitBinding(project, b.r);
    const controls = emptyControls();
    const states: boolean[] = [];
    for (let t = 0; t < 900; t += 5) {
      b.r.runFor(5);
      states.push(binding.update(controls).visuals.get(led.id)?.ledOn === true);
    }
    const got = last(b.out(), /(ee .*)\r/g);
    check(/ee 0 167 167 92 255 167 92/.test(b.out()), `Wire writes to the EEPROM part and reads one, two and three bytes back (${got})`);
    check(/absent 2/.test(b.out()), `an address with nothing on the bus is NACKed (${last(b.out(), /(absent .*)\r/g)})`);
    const flips = states.filter((s, i) => i > 0 && s !== states[i - 1]).length;
    check(flips >= 4, `the LED on D13 blinks on the canvas (${flips} changes in 900 ms)`);
  }
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
