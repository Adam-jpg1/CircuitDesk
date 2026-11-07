// The Arduino Due, running real firmware from the Arduino SAM core on the
// ARMv7-M core and the SAM3X8E model.
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

const def = getBoardDefinition('board.arduino-due')!;
const FQBN = 'arduino:sam:arduino_due_x_dbg';
check(def.simulation?.supported === true && def.simulation.engine === 'armv7m', 'the Due is a simulated board on the ARMv7-M engine');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Runner = any;
async function boot(sketch: string): Promise<{ r: Runner; out: () => string } | null> {
  const built = await compileProject({ fqbn: FQBN, boardId: def.id, files: [{ name: 'sketch.ino', content: sketch }] }, false);
  if (!built.firmware) {
    console.log(`SKIP: the Due sketch did not build here (${built.errors?.[0]?.message ?? built.error ?? built.stderr?.slice(0, 200)})`);
    skipped++;
    return null;
  }
  check(built.firmware.format === 'bin', 'the artifact is a raw binary');
  const r: Runner = await getSimulatorAdapter(def)!.createRunner(built.firmware, def);
  let text = '';
  r.onSerialByte = (b: number) => (text += String.fromCharCode(b));
  return { r, out: () => text };
}
const run = (r: Runner, ms: number, slice = 5) => {
  for (let t = 0; t < ms; t += slice) r.runFor(slice);
};
const pin = (label: string) => runnerPinIndex(def, label)!;
const last = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => m[1]).at(-1);

section('boot, Serial and time');
{
  const b = await boot(`void setup() { Serial.begin(115200); Serial.println("due ready"); unsigned long t0 = millis(); delay(1000);
  Serial.print("ms "); Serial.println(millis() - t0); unsigned long u0 = micros(); delayMicroseconds(500); Serial.print("us "); Serial.println(micros() - u0); }
void loop() { if (Serial.available()) { int c = Serial.read(); Serial.print("got "); Serial.println((char)c); } }`);
  if (b) {
    const t0 = performance.now();
    run(b.r, 1300);
    const wall = performance.now() - t0;
    check(b.out().includes('due ready'), 'setup() runs and Serial prints');
    const ms = Number(last(b.out(), /ms (\d+)/g));
    check(ms >= 1000 && ms <= 1001, `delay(1000) takes 1000 ms of simulated time (${ms})`);
    const us = Number(last(b.out(), /us (\d+)/g));
    check(us >= 500 && us <= 510, `delayMicroseconds(500) takes about 500 µs (${us})`);
    console.log(`   1.3 s simulated in ${(wall / 1000).toFixed(2)} s`);
    b.r.queueSerialInput('Q');
    run(b.r, 50);
    check(/got Q/.test(b.out()), 'bytes typed in the monitor reach Serial.read()');
  }
}

section('analogRead');
{
  const b = await boot(`void setup() { Serial.begin(115200); }
void loop() { Serial.print("a "); Serial.println(analogRead(A0)); analogReadResolution(12); Serial.print("b "); Serial.println(analogRead(A0)); analogReadResolution(10); delay(20); }`);
  if (b) {
    const ch = runnerAdcChannel(def, 'A0')!;
    check(ch === 7 && b.r.adcChannelForPin(pin('A0')) === 7, `A0 is ADC channel 7 (PA16), as on the board (${ch})`);
    b.r.setAnalogVolts(ch, 1.65);
    run(b.r, 100);
    const a = Number(last(b.out(), /a (\d+)/g));
    const v12 = Number(last(b.out(), /b (\d+)/g));
    check(Math.abs(a - 512) <= 1, `1.65 V reads half scale at 10 bits (${a})`);
    check(Math.abs(v12 - 2048) <= 1, `and at 12 bits with analogReadResolution(12) (${v12})`);
  }
}

section('digital input and pull-ups');
{
  const b = await boot(`void setup() { Serial.begin(115200); pinMode(22, INPUT_PULLUP); pinMode(23, INPUT); }
void loop() { Serial.print("d "); Serial.print(digitalRead(22)); Serial.println(digitalRead(23)); delay(10); }`);
  if (b) {
    run(b.r, 50);
    check(last(b.out(), /d (\d\d)/g)?.[0] === '1', 'an unconnected INPUT_PULLUP pin reads HIGH');
    check(b.r.digitalPinLevel(pin('D22')) === 'input-pullup', 'and is reported as a pulled-up input');
    b.r.setDigitalInput(pin('D22'), false);
    b.r.setDigitalInput(pin('D23'), true);
    run(b.r, 50);
    check(last(b.out(), /d (\d\d)/g) === '01', `the circuit's levels are what digitalRead sees (${last(b.out(), /d (\d\d)/g)})`);
  }
}

section('analogWrite on the PWM controller and on the timers');
{
  const b = await boot(`void setup() { analogWrite(9, 64); analogWrite(2, 128); analogWrite(13, 191); } void loop() {}`);
  if (b) {
    run(b.r, 100);
    const before = b.r.snapshot();
    run(b.r, 200);
    const s = b.r.snapshot();
    const d9 = s.duty[pin('D9')];
    const d2 = s.duty[pin('D2')];
    const d13 = s.duty[pin('D13')];
    check(Math.abs(d9 - 64 / 255) < 0.02, `D9 (PWML4) runs at 64/255 (${d9.toFixed(3)})`);
    check(Math.abs(d2 - 128 / 255) < 0.02, `D2 (TIOA0) runs at 128/255 (${d2.toFixed(3)})`);
    check(Math.abs(d13 - 191 / 255) < 0.02, `D13 (TIOB0, the LED) runs at 191/255 (${d13.toFixed(3)})`);
    // Toggles count from the start of the run; the window is the difference.
    const toggles = s.toggles[pin('D9')] - before.toggles[pin('D9')];
    check(toggles >= 300 && toggles <= 700, `at about 1 kHz (${toggles} edges in 200 ms)`);
  }
}

section('attachInterrupt');
{
  const b = await boot(`volatile int r = 0, c = 0; void onR() { r++; } void onC() { c++; }
void setup() { Serial.begin(115200); pinMode(24, INPUT_PULLUP); pinMode(25, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(24), onR, RISING); attachInterrupt(digitalPinToInterrupt(25), onC, CHANGE); }
void loop() { Serial.print("i "); Serial.print(r); Serial.print(' '); Serial.println(c); delay(20); }`);
  if (b) {
    run(b.r, 100);
    for (let k = 0; k < 6; k++) {
      b.r.setDigitalInput(pin('D24'), false);
      b.r.setDigitalInput(pin('D25'), false);
      run(b.r, 3, 1);
      b.r.setDigitalInput(pin('D24'), true);
      b.r.setDigitalInput(pin('D25'), true);
      run(b.r, 3, 1);
    }
    run(b.r, 100);
    const got = last(b.out(), /i (\d+ \d+)/g);
    check(got === '6 12', `RISING counts 6 rises and CHANGE counts 12 changes (${got})`);
  }
}

section('Servo');
{
  const b = await boot(`#include <Servo.h>
Servo s; void setup() { s.attach(7); s.writeMicroseconds(1500); } void loop() {}`);
  if (b) {
    run(b.r, 200);
    const before = b.r.snapshot();
    run(b.r, 200);
    const s = b.r.snapshot();
    const w = s.pulseWidthUs[pin('D7')];
    const edges = s.toggles[pin('D7')] - before.toggles[pin('D7')];
    check(Math.abs(w - 1500) < 15, `a 1500 µs pulse (${w.toFixed(1)} µs)`);
    check(edges >= 18 && edges <= 22, `every 20 ms (${edges} edges in 200 ms)`);
  }
}

section('Serial1');
{
  const b = await boot(`void setup() { Serial1.begin(9600); Serial1.println("on serial1"); }
void loop() { if (Serial1.available()) { Serial1.write(Serial1.read() + 1); } }`);
  if (b) {
    const port = b.r.extraUarts.find((p: { name: string }) => p.name === 'Serial1');
    check(port && port.txPin === pin('D18') && port.rxPin === pin('D19'), 'Serial1 is on D18 (TX1) and D19 (RX1)');
    let heard = '';
    port.onTransmit = (byte: number) => (heard += String.fromCharCode(byte));
    run(b.r, 100);
    check(heard.includes('on serial1'), `its bytes go out on TX1 (${JSON.stringify(heard)})`);
    check(Math.abs(port.baudRate - 9600) < 50, `at the baud firmware set (${port.baudRate})`);
    heard = '';
    port.receive('ABC');
    run(b.r, 100);
    check(heard === 'BCD', `bytes arriving on RX1 reach Serial1.read() (${JSON.stringify(heard)})`);
  }
}

section('on the canvas: an LED on D13 and an I2C EEPROM on Wire');
{
  let seq = 0;
  const uid = (p: string) => `${p}${++seq}`;
  const project: CircuitProject = emptyProject('due');
  const board: ComponentInstance = { id: uid('b'), definitionId: 'board.arduino-due', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {} };
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
  wire(board, '3V3', ee, 'vcc');
  wire(board, 'GND2', ee, 'gnd');
  wire(board, 'D20', ee, 'sda');
  wire(board, 'D21', ee, 'scl');

  const b = await boot(`#include <Wire.h>
void setup() { Serial.begin(115200); pinMode(13, OUTPUT); Wire.begin();
  Wire.beginTransmission(0x50); Wire.write(0); Wire.write(5); Wire.write(0xA7); int e = Wire.endTransmission(); delay(10);
  Wire.beginTransmission(0x50); Wire.write(0); Wire.write(5); Wire.endTransmission(); Wire.requestFrom(0x50, 1);
  int v = Wire.available() ? Wire.read() : -1; Serial.print("ee "); Serial.print(e); Serial.print(' '); Serial.println(v);
  Wire.beginTransmission(0x51); Serial.print("absent "); Serial.println(Wire.endTransmission()); }
void loop() { digitalWrite(13, HIGH); delay(100); digitalWrite(13, LOW); delay(100); }`);
  if (b) {
    const binding = new CircuitBinding(project, b.r);
    const controls = emptyControls();
    const states: boolean[] = [];
    for (let t = 0; t < 600; t += 5) {
      b.r.runFor(5);
      states.push(binding.update(controls).visuals.get(led.id)?.ledOn === true);
    }
    check(/ee 0 167/.test(b.out()), `Wire writes a byte to the EEPROM part and reads it back (${last(b.out(), /(ee .*)\r/g)})`);
    check(/absent 2/.test(b.out()), 'an address with nothing on the bus is NACKed (endTransmission returns 2)');
    const flips = states.filter((s, i) => i > 0 && s !== states[i - 1]).length;
    check(flips >= 4, `the LED on D13 blinks on the canvas (${flips} changes in 600 ms)`);
  }
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
