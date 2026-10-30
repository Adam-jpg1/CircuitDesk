// The BBC micro:bit V2, running real firmware from the Arduino nRF5 core on
// the ARMv7-M core and the nRF52833 model — including its own LED matrix and
// buttons A and B, driven through the same binding the canvas uses.
//
// Each sketch is compiled by the same compiler service the app uses and run
// through the same adapter, then checked by what it does: what it prints, how
// fast time passes, what its pins do, and what the parts on the canvas see.

import { compileProject } from '../server/compiler/compilerService';
import { getSimulatorAdapter } from '../src/simulation/adapters';
import { getBoardDefinition } from '../src/boards/definitions';
import { runnerPinIndex, runnerAdcChannel } from '../src/simulation/boardRunner';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { contactStateKey } from '../src/simulation/devices/contacts';
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

const def = getBoardDefinition('board.microbit')!;
const FQBN = 'sandeepmistry:nRF5:BBCmicrobitV2';
check(def.simulation?.supported === true && def.simulation.engine === 'armv7m', 'the micro:bit is a simulated board on the ARMv7-M engine');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Runner = any;
async function boot(sketch: string): Promise<{ r: Runner; out: () => string } | null> {
  const built = await compileProject({ fqbn: FQBN, boardId: def.id, files: [{ name: 'sketch.ino', content: sketch }] }, false);
  if (!built.firmware) {
    console.log(`SKIP: the micro:bit sketch did not build here (${built.errors?.[0]?.message ?? built.error ?? built.stderr?.slice(0, 200)})`);
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
  // delayMicroseconds is timed before anything is printed: once Serial is
  // sending, its interrupts land inside the delay, as on the real board.
  const b = await boot(`void setup() { unsigned long u0 = micros(); delayMicroseconds(500); unsigned long du = micros() - u0;
  Serial.begin(115200); Serial.println("microbit ready"); unsigned long t0 = millis(); delay(1000);
  Serial.print("ms "); Serial.println(millis() - t0); Serial.print("us "); Serial.println(du); }
void loop() { if (Serial.available()) { int c = Serial.read(); Serial.print("got "); Serial.println((char)c); } }`);
  if (b) {
    const t0 = performance.now();
    run(b.r, 1300);
    const wall = performance.now() - t0;
    check(b.out().includes('microbit ready'), 'setup() runs and Serial prints');
    const ms = Number(last(b.out(), /ms (\d+)/g));
    check(ms >= 1000 && ms <= 1001, `delay(1000) takes 1000 ms of simulated time (${ms})`);
    const us = Number(last(b.out(), /us (\d+)/g));
    // micros() on this core counts the 32 kHz RTC, so it moves in 30.5 µs steps.
    check(us >= 440 && us <= 540, `delayMicroseconds(500) takes about 500 µs, to micros()'s 30 µs resolution (${us})`);
    console.log(`   1.3 s simulated in ${(wall / 1000).toFixed(2)} s`);
    b.r.queueSerialInput('Q');
    run(b.r, 50);
    check(/got Q/.test(b.out()), 'bytes typed in the monitor reach Serial.read()');
  }
}

section('analogRead');
{
  const b = await boot(`void setup() { Serial.begin(115200); }
void loop() { Serial.print("a "); Serial.println(analogRead(0)); delay(20); }`);
  if (b) {
    const ch = runnerAdcChannel(def, 'P0')!;
    check(ch === 0 && b.r.adcChannelForPin(pin('P0')) === 0, `ring 0 is AIN0 (P0.02) (${ch})`);
    b.r.setAnalogVolts(ch, 1.5);
    run(b.r, 100);
    const a = Number(last(b.out(), /a (\d+)/g));
    // The core sets gain 1/5 against the 0.6 V reference: 3.0 V is full scale.
    check(Math.abs(a - 512) <= 1, `1.5 V reads half of the core's 3.0 V full scale at 10 bits (${a})`);
  }
}

section('digital input and pull-ups');
{
  const b = await boot(`void setup() { Serial.begin(115200); pinMode(8, INPUT_PULLUP); pinMode(9, INPUT); }
void loop() { Serial.print("d "); Serial.print(digitalRead(8)); Serial.println(digitalRead(9)); delay(10); }`);
  if (b) {
    run(b.r, 50);
    check(last(b.out(), /d (\d\d)/g)?.[0] === '1', 'an unconnected INPUT_PULLUP pin reads HIGH');
    check(b.r.digitalPinLevel(pin('P8')) === 'input-pullup', 'and is reported as a pulled-up input');
    b.r.setDigitalInput(pin('P8'), false);
    b.r.setDigitalInput(pin('P9'), true);
    run(b.r, 50);
    check(last(b.out(), /d (\d\d)/g) === '01', `the circuit's levels are what digitalRead sees (${last(b.out(), /d (\d\d)/g)})`);
  }
}

section('analogWrite');
{
  const b = await boot(`void setup() { analogWrite(0, 64); analogWrite(1, 191); } void loop() {}`);
  if (b) {
    run(b.r, 100);
    const before = b.r.snapshot();
    run(b.r, 200);
    const s = b.r.snapshot();
    const d0 = s.duty[pin('P0')];
    const d1 = s.duty[pin('P1')];
    check(Math.abs(d0 - 64 / 255) < 0.02, `ring 0 runs at 64/255 (${d0.toFixed(3)})`);
    check(Math.abs(d1 - 191 / 255) < 0.02, `ring 1 runs at 191/255 (${d1.toFixed(3)})`);
    const toggles = s.toggles[pin('P0')] - before.toggles[pin('P0')];
    check(toggles >= 100, `as a steady PWM (${toggles} edges in 200 ms)`);
  }
}

section('attachInterrupt');
{
  const b = await boot(`volatile int r = 0, c = 0; void onR() { r++; } void onC() { c++; }
void setup() { Serial.begin(115200); pinMode(8, INPUT_PULLUP); pinMode(12, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(8), onR, RISING); attachInterrupt(digitalPinToInterrupt(12), onC, CHANGE); }
void loop() { Serial.print("i "); Serial.print(r); Serial.print(' '); Serial.println(c); delay(20); }`);
  if (b) {
    run(b.r, 100);
    for (let k = 0; k < 6; k++) {
      b.r.setDigitalInput(pin('P8'), false);
      b.r.setDigitalInput(pin('P12'), false);
      run(b.r, 3, 1);
      b.r.setDigitalInput(pin('P8'), true);
      b.r.setDigitalInput(pin('P12'), true);
      run(b.r, 3, 1);
    }
    run(b.r, 100);
    const got = last(b.out(), /i (\d+ \d+)/g);
    check(got === '6 12', `RISING counts 6 rises and CHANGE counts 12 changes (${got})`);
  }
}

section('the LED matrix and buttons A and B, on the board');
{
  // A scanned display: each row in turn, a diagonal lit, and the middle LED
  // only while button A is held. Button B lights the bottom-right corner.
  const b = await boot(`const int ROW[5] = {21, 22, 23, 24, 25}; const int COL[5] = {4, 7, 3, 6, 10};
void setup() { for (int i = 0; i < 5; i++) { pinMode(ROW[i], OUTPUT); pinMode(COL[i], OUTPUT); digitalWrite(COL[i], HIGH); }
  pinMode(5, INPUT); pinMode(11, INPUT); }
void loop() {
  bool a = digitalRead(5) == LOW; bool bb = digitalRead(11) == LOW;
  for (int r = 0; r < 5; r++) {
    for (int c = 0; c < 5; c++) {
      bool on = (r == c && r != 2 && r != 4) || (r == 2 && c == 2 && a) || (r == 4 && c == 4 && bb) || (r == 0 && c == 4);
      digitalWrite(COL[c], on ? LOW : HIGH);
    }
    digitalWrite(ROW[r], HIGH); delay(2); digitalWrite(ROW[r], LOW);
  }
}`);
  if (b) {
    const project: CircuitProject = emptyProject('microbit');
    const board: ComponentInstance = { id: 'mb', definitionId: 'board.microbit', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {} };
    project.boardInstances.push(board);
    const binding = new CircuitBinding(project, b.r);
    const controls = emptyControls();
    const frame = () => {
      let v: number[] = [];
      for (let t = 0; t < 100; t += 50) {
        b.r.runFor(50);
        v = binding.update(controls).visuals.get('mb')?.matrix ?? [];
      }
      return v;
    };
    frame();
    const lit = (m: number[]) => m.map((x, i) => (x > 0.5 ? i : -1)).filter((i) => i >= 0).join(',');
    const idle = frame();
    check(lit(idle) === '0,4,6,18', `a scanned pattern lights the LEDs it should, at full brightness (${lit(idle)})`);
    controls.pressedButtons.add(contactStateKey('mb', 'A'));
    const withA = frame();
    check(lit(withA) === '0,4,6,12,18', `holding A lights the middle LED (${lit(withA)})`);
    check(binding.update(controls).visuals.get('mb')?.boardButtons?.includes('A') === true, 'and the board shows A held');
    controls.pressedButtons.delete(contactStateKey('mb', 'A'));
    controls.pressedButtons.add(contactStateKey('mb', 'B'));
    const withB = frame();
    check(lit(withB) === '0,4,6,18,24', `releasing A and holding B lights the corner instead (${lit(withB)})`);
  }
}

section('on the canvas: an I2C EEPROM on Wire (P19/P20)');
{
  let seq = 0;
  const uid = (p: string) => `${p}${++seq}`;
  const project: CircuitProject = emptyProject('microbit-ee');
  const board: ComponentInstance = { id: uid('b'), definitionId: 'board.microbit', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {} };
  project.boardInstances.push(board);
  const ee: ComponentInstance = { id: uid('c'), definitionId: 'comp.eeprom-24c', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {} };
  project.componentInstances.push(ee);
  const wire = (a: ComponentInstance, ap: string, b2: ComponentInstance, bp: string) =>
    project.connections.push({
      id: uid('w'), sourceComponentId: a.id, sourcePinId: ap, targetComponentId: b2.id, targetPinId: bp,
      netId: '', color: '#000', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  wire(board, '3V', ee, 'vcc');
  wire(board, 'GND', ee, 'gnd');
  wire(board, 'P20', ee, 'sda');
  wire(board, 'P19', ee, 'scl');
  const b = await boot(`#include <Wire.h>
void setup() { Serial.begin(115200); Wire.begin();
  Wire.beginTransmission(0x50); Wire.write((uint8_t)0); Wire.write((uint8_t)5); Wire.write((uint8_t)0xA7); Wire.write((uint8_t)0x5C); int e = Wire.endTransmission(); delay(10);
  Wire.beginTransmission(0x50); Wire.write((uint8_t)0); Wire.write((uint8_t)5); Wire.endTransmission(); Wire.requestFrom(0x50, 2);
  int v2 = Wire.read(); int v3 = Wire.read();
  Serial.print("ee "); Serial.print(e); Serial.print(' '); Serial.print(v2); Serial.print(' '); Serial.println(v3);
  Wire.beginTransmission(0x51); Serial.print("absent "); Serial.println(Wire.endTransmission()); }
void loop() {}`);
  if (b) {
    const binding = new CircuitBinding(project, b.r);
    const controls = emptyControls();
    for (let t = 0; t < 400; t += 5) {
      b.r.runFor(5);
      binding.update(controls);
    }
    check(/ee 0 167 92/.test(b.out()), `Wire writes to the EEPROM part and reads two bytes back (${last(b.out(), /(ee .*)\r/g)})`);
    check(/absent [12]/.test(b.out()), `an address with nothing on the bus is NACKed (${last(b.out(), /(absent .*)\r/g)})`);
  }
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
