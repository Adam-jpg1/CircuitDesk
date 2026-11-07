// The STM32 Nucleo-64, running real firmware from the STM32duino core on the
// ARMv7-M core and the STM32F401RE model.
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

const def = getBoardDefinition('board.stm32-nucleo')!;
const FQBN = 'STMicroelectronics:stm32:Nucleo_64:pnum=NUCLEO_F401RE';
check(def.simulation?.supported === true && def.simulation.engine === 'armv7m', 'the Nucleo is a simulated board on the ARMv7-M engine');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Runner = any;
async function boot(sketch: string): Promise<{ r: Runner; out: () => string } | null> {
  const built = await compileProject({ fqbn: FQBN, boardId: def.id, files: [{ name: 'sketch.ino', content: sketch }] }, false);
  if (!built.firmware) {
    console.log(`SKIP: the Nucleo sketch did not build here (${built.errors?.[0]?.message ?? built.error ?? built.stderr?.slice(0, 200)})`);
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
  const b = await boot(`void setup() { Serial.begin(115200); Serial.println("nucleo ready"); unsigned long t0 = millis(); delay(1000);
  Serial.print("ms "); Serial.println(millis() - t0); unsigned long u0 = micros(); delayMicroseconds(500); Serial.print("us "); Serial.println(micros() - u0);
  float f = 1.5f; for (int i = 0; i < 10; i++) f = f * 1.25f + 0.5f; Serial.print("f "); Serial.println(f, 3); }
void loop() { if (Serial.available()) { int c = Serial.read(); Serial.print("got "); Serial.println((char)c); } }`);
  if (b) {
    const t0 = performance.now();
    run(b.r, 1300);
    const wall = performance.now() - t0;
    check(b.out().includes('nucleo ready'), 'setup() runs and Serial prints');
    const ms = Number(last(b.out(), /ms (\d+)/g));
    check(ms >= 1000 && ms <= 1001, `delay(1000) takes 1000 ms of simulated time (${ms})`);
    const us = Number(last(b.out(), /us (\d+)/g));
    check(us >= 500 && us <= 510, `delayMicroseconds(500) takes about 500 µs (${us})`);
    // The FPU is used: 1.5 -> x*1.25+0.5 ten times, in single precision.
    let f = Math.fround(1.5);
    for (let i = 0; i < 10; i++) f = Math.fround(Math.fround(f * 1.25) + 0.5);
    check(last(b.out(), /f ([\d.]+)/g) === f.toFixed(3), `single-precision arithmetic on the FPU (${last(b.out(), /f ([\d.]+)/g)}, want ${f.toFixed(3)})`);
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
    const ch = runnerAdcChannel(def, 'PA0')!;
    check(ch === 0 && b.r.adcChannelForPin(pin('PA0')) === 0, `A0 (PA0) is ADC channel 0 (${ch})`);
    b.r.setAnalogVolts(ch, 1.65);
    run(b.r, 100);
    const a = Number(last(b.out(), /a (\d+)/g));
    const v12 = Number(last(b.out(), /b (\d+)/g));
    check(Math.abs(a - 512) <= 1, `1.65 V reads half scale at 10 bits (${a})`);
    check(Math.abs(v12 - 2048) <= 1, `and at 12 bits with analogReadResolution(12) (${v12})`);
  }
}

section('digital input and pulls');
{
  const b = await boot(`void setup() { Serial.begin(115200); pinMode(2, INPUT_PULLUP); pinMode(4, INPUT_PULLDOWN); pinMode(5, INPUT); }
void loop() { Serial.print("d "); Serial.print(digitalRead(2)); Serial.print(digitalRead(4)); Serial.println(digitalRead(5)); delay(10); }`);
  if (b) {
    run(b.r, 50);
    check(last(b.out(), /d (\d\d\d)/g)?.slice(0, 2) === '10', `an unconnected INPUT_PULLUP pin reads HIGH and INPUT_PULLDOWN LOW (${last(b.out(), /d (\d\d\d)/g)})`);
    check(b.r.digitalPinLevel(pin('PA10')) === 'input-pullup', 'D2 is reported as a pulled-up input');
    b.r.setDigitalInput(pin('PA10'), false);
    b.r.setDigitalInput(pin('PB5'), true);
    b.r.setDigitalInput(pin('PB4'), true);
    run(b.r, 50);
    check(last(b.out(), /d (\d\d\d)/g) === '011', `the circuit's levels are what digitalRead sees (${last(b.out(), /d (\d\d\d)/g)})`);
  }
}

section('analogWrite on the timers');
{
  const b = await boot(`void setup() { analogWrite(9, 64); analogWrite(3, 128); analogWrite(11, 191); } void loop() {}`);
  if (b) {
    run(b.r, 100);
    const before = b.r.snapshot();
    run(b.r, 200);
    const s = b.r.snapshot();
    const d9 = s.duty[pin('PC7')];
    const d3 = s.duty[pin('PB3')];
    const d11 = s.duty[pin('PA7')];
    check(Math.abs(d9 - 64 / 255) < 0.02, `D9 (TIM3_CH2) runs at 64/255 (${d9.toFixed(3)})`);
    check(Math.abs(d3 - 128 / 255) < 0.02, `D3 (TIM2_CH2, a 32-bit timer) runs at 128/255 (${d3.toFixed(3)})`);
    check(Math.abs(d11 - 191 / 255) < 0.02, `D11 (TIM1_CH1N, a complementary output) runs at 191/255 (${d11.toFixed(3)})`);
    const toggles = s.toggles[pin('PC7')] - before.toggles[pin('PC7')];
    check(toggles >= 300 && toggles <= 500, `at about 1 kHz (${toggles} edges in 200 ms)`);
  }
}

section('attachInterrupt');
{
  const b = await boot(`volatile int r = 0, c = 0; void onR() { r++; } void onC() { c++; }
void setup() { Serial.begin(115200); pinMode(2, INPUT_PULLUP); pinMode(7, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(2), onR, RISING); attachInterrupt(digitalPinToInterrupt(7), onC, CHANGE); }
void loop() { Serial.print("i "); Serial.print(r); Serial.print(' '); Serial.println(c); delay(20); }`);
  if (b) {
    run(b.r, 100);
    for (let k = 0; k < 6; k++) {
      b.r.setDigitalInput(pin('PA10'), false);
      b.r.setDigitalInput(pin('PA8'), false);
      run(b.r, 3, 1);
      b.r.setDigitalInput(pin('PA10'), true);
      b.r.setDigitalInput(pin('PA8'), true);
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
    run(b.r, 200);
    const before = b.r.snapshot();
    run(b.r, 200);
    const s = b.r.snapshot();
    const w = s.pulseWidthUs[pin('PB10')];
    const edges = s.toggles[pin('PB10')] - before.toggles[pin('PB10')];
    check(Math.abs(w - 1500) < 15, `Servo: a 1500 µs pulse (${w.toFixed(1)} µs)`);
    check(edges >= 18 && edges <= 22, `every 20 ms (${edges} edges in 200 ms)`);
    const toneEdges = s.toggles[pin('PA9')] - before.toggles[pin('PA9')];
    check(toneEdges >= 390 && toneEdges <= 410, `tone(8, 1000) toggles D8 at 1 kHz (${toneEdges} edges in 200 ms)`);
  }
}

section('a second UART');
{
  // STM32duino 3.0's way to a second port: a Uart (its HardwareSerial) on its pins.
  const b = await boot(`Uart Uart1(PA10, PA9);
void setup() { Uart1.begin(9600); Uart1.println("on usart1"); }
void loop() { if (Uart1.available()) { Uart1.write(Uart1.read() + 1); } }`);
  if (b) {
    const port = b.r.extraUarts.find((p: { name: string }) => p.name === 'USART1');
    check(port && port.txPin === pin('PA9') && port.rxPin === pin('PA10'), 'USART1 is on PA9 (D8) and PA10 (D2)');
    let heard = '';
    port.onTransmit = (byte: number) => (heard += String.fromCharCode(byte));
    run(b.r, 100);
    check(heard.includes('on usart1'), `its bytes go out on TX (${JSON.stringify(heard)})`);
    check(Math.abs(port.baudRate - 9600) < 50, `at the baud firmware set (${port.baudRate})`);
    heard = '';
    port.receive('ABC');
    run(b.r, 100);
    check(heard === 'BCD', `bytes arriving on RX reach Uart1.read() (${JSON.stringify(heard)})`);
  }
}

section('EEPROM, emulated in flash');
{
  const b = await boot(`#include <EEPROM.h>
void setup() { Serial.begin(115200); Serial.print("before "); Serial.println(EEPROM.read(7)); EEPROM.write(7, 42);
  Serial.print("after "); Serial.println(EEPROM.read(7)); }
void loop() {}`);
  if (b) {
    run(b.r, 300);
    check(/before 255/.test(b.out()) && /after 42/.test(b.out()), `EEPROM.write then EEPROM.read (${JSON.stringify(b.out().trim())})`);
    const flash: Uint8Array = b.r.mcu.flash;
    // The core keeps its 8 KB EEPROM image at the very end of flash (0x0807E000), in sector 7.
    check(flash[0x7e000 + 7] === 42, `and the byte is in the last flash sector, erased and programmed (${flash[0x7e000 + 7]})`);
  }
}

section('on the canvas: an LED on D13 and an I2C EEPROM on Wire');
{
  let seq = 0;
  const uid = (p: string) => `${p}${++seq}`;
  const project: CircuitProject = emptyProject('nucleo');
  const board: ComponentInstance = { id: uid('b'), definitionId: 'board.stm32-nucleo', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {} };
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
  wire(board, 'PA5', r1, 'p1');
  wire(r1, 'p2', led, 'anode');
  wire(led, 'cathode', board, 'GND1');
  const ee = part('comp.eeprom-24c');
  wire(board, '3V3', ee, 'vcc');
  wire(board, 'GND2', ee, 'gnd');
  wire(board, 'PB9', ee, 'sda');
  wire(board, 'PB8', ee, 'scl');

  const b = await boot(`#include <Wire.h>
void setup() { Serial.begin(115200); pinMode(13, OUTPUT); Wire.begin();
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
    for (let t = 0; t < 600; t += 5) {
      b.r.runFor(5);
      states.push(binding.update(controls).visuals.get(led.id)?.ledOn === true);
    }
    const got = last(b.out(), /(ee .*)\r/g);
    check(/ee 0 167 167 92 255 167 92/.test(b.out()), `Wire writes to the EEPROM part and reads one, two and three bytes back (${got})`);
    check(/absent 2/.test(b.out()), `an address with nothing on the bus is NACKed (${last(b.out(), /(absent .*)\r/g)})`);
    const flips = states.filter((s, i) => i > 0 && s !== states[i - 1]).length;
    check(flips >= 4, `the LED on D13 blinks on the canvas (${flips} changes in 600 ms)`);
  }
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
