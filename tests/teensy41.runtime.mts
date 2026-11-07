// The Teensy 4.1, running real firmware from the Teensy 4 core on the ARMv7-M
// core (as a Cortex-M7) and the i.MX RT1062 model, with Serial over the
// simulated USB OTG controller. Built at the core's 60 MHz speed setting.
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

const def = getBoardDefinition('board.teensy41')!;
const FQBN = 'teensy:avr:teensy41:speed=60';
check(def.simulation?.supported === true && def.simulation.engine === 'armv7m', 'the Teensy 4.1 is a simulated board on the ARMv7-M engine');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Runner = any;
async function boot(sketch: string): Promise<{ r: Runner; out: () => string } | null> {
  const built = await compileProject({ fqbn: FQBN, boardId: def.id, files: [{ name: 'sketch.ino', content: sketch }] }, false);
  if (!built.firmware) {
    console.log(`SKIP: the Teensy 4.1 sketch did not build here (${built.errors?.[0]?.message ?? built.error ?? built.stderr?.slice(0, 200)})`);
    skipped++;
    return null;
  }
  check(built.firmware.format === 'bin', 'the artifact is a raw binary');
  const r: Runner = await getSimulatorAdapter(def)!.createRunner(built.firmware, def);
  // Serial is the USB port; Serial1 (the UART on pins 0/1) is reported separately.
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
  const b = await boot(`void setup() { unsigned long u0 = micros(); delayMicroseconds(500); unsigned long du = micros() - u0;
  unsigned long b0 = millis(); ${WAIT} Serial.print("teensy ready after "); Serial.println(millis() - b0);
  unsigned long t0 = millis(); delay(1000); Serial.print("ms "); Serial.println(millis() - t0);
  Serial.print("us "); Serial.println(du);
  float f = 1.5f; for (int i = 0; i < 10; i++) f = f * 1.25f + 0.5f; Serial.print("f "); Serial.println(f, 3); }
void loop() { if (Serial.available()) { int c = Serial.read(); Serial.print("got "); Serial.println((char)c); } }`);
  if (b) {
    const t0 = performance.now();
    run(b.r, 1400);
    const wall = performance.now() - t0;
    const up = Number(last(b.out(), /ready after (\d+)/g));
    check(b.out().includes('teensy ready'), 'the core starts up, the USB port enumerates and Serial prints to the monitor');
    // The core itself waits 300 ms before and after starting USB, as on the board.
    check(up < 500, `while (!Serial) returns once the host opens the port (${up} ms after setup())`);
    const ms = Number(last(b.out(), /ms (\d+)/g));
    check(ms >= 1000 && ms <= 1001, `delay(1000) takes 1000 ms of simulated time (${ms})`);
    const us = Number(last(b.out(), /us (\d+)/g));
    check(us >= 499 && us <= 510, `delayMicroseconds(500) takes 500 µs, counted on the cycle counter (${us})`);
    let f = Math.fround(1.5);
    for (let i = 0; i < 10; i++) f = Math.fround(Math.fround(f * 1.25) + 0.5);
    check(last(b.out(), /f ([\d.]+)/g) === f.toFixed(3), `single-precision arithmetic on the FPU (${last(b.out(), /f ([\d.]+)/g)})`);
    console.log(`   1.4 s simulated in ${(wall / 1000).toFixed(2)} s`);
    b.r.queueSerialInput('Q');
    run(b.r, 50);
    check(/got Q/.test(b.out()), 'bytes typed in the monitor reach Serial.read() over USB');
  }
}

section('Serial1, the UART on pins 0/1');
{
  const b = await boot(`void setup() { Serial1.begin(9600); Serial1.println("on serial1"); }
void loop() { if (Serial1.available()) { Serial1.write(Serial1.read() + 1); } }`);
  if (b) {
    let heard = '';
    b.r.onSerialByte = (byte: number) => (heard += String.fromCharCode(byte));
    // setup() starts after the core's own 300 ms USB start-up delay.
    run(b.r, 500);
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
void loop() { Serial.print("a "); Serial.print(analogRead(A0)); analogReadResolution(12); Serial.print(' '); Serial.println(analogRead(A0)); analogReadResolution(10); delay(20); }`);
  if (b) {
    const ch = runnerAdcChannel(def, 'D14')!;
    check(ch === 18 && b.r.adcChannelForPin(pin('D14')) === 18, `A0 (pin 14) is the ADC input on GPIO1_18 (${ch})`);
    b.r.setAnalogVolts(ch, 1.65);
    run(b.r, 600);
    const [a10, a12] = (last(b.out(), /a (\d+ \d+)/g) ?? '').split(' ').map(Number);
    check(Math.abs(a10 - 512) <= 2, `1.65 V reads half of 3.3 V at 10 bits (${a10})`);
    check(Math.abs(a12 - 2048) <= 4, `and at 12 bits (${a12})`);
  }
}

section('digital input and pull-ups');
{
  const b = await boot(`void setup() { ${WAIT} pinMode(2, INPUT_PULLUP); pinMode(3, INPUT); }
void loop() { Serial.print("d "); Serial.print(digitalRead(2)); Serial.println(digitalRead(3)); delay(10); }`);
  if (b) {
    run(b.r, 500);
    check(last(b.out(), /d (\d\d)/g)?.[0] === '1', 'an unconnected INPUT_PULLUP pin reads HIGH');
    check(b.r.digitalPinLevel(pin('D2')) === 'input-pullup', 'and is reported as a pulled-up input');
    b.r.setDigitalInput(pin('D2'), false);
    b.r.setDigitalInput(pin('D3'), true);
    run(b.r, 50);
    check(last(b.out(), /d (\d\d)/g) === '01', `the circuit's levels are what digitalRead sees (${last(b.out(), /d (\d\d)/g)})`);
  }
}

section('analogWrite');
{
  // Pin 9 is a FlexPWM output, pin 10 a QuadTimer one.
  const b = await boot(`void setup() { analogWrite(9, 64); analogWrite(10, 191); } void loop() {}`);
  if (b) {
    run(b.r, 500);
    const before = b.r.snapshot();
    run(b.r, 200);
    const s = b.r.snapshot();
    const d9 = s.duty[pin('D9')];
    const d10 = s.duty[pin('D10')];
    check(Math.abs(d9 - 64 / 255) < 0.02, `pin 9 (FlexPWM2) runs at 64/255 (${d9.toFixed(3)})`);
    check(Math.abs(d10 - 191 / 255) < 0.02, `pin 10 (QuadTimer1) runs at 191/255 (${d10.toFixed(3)})`);
    const toggles = s.toggles[pin('D9')] - before.toggles[pin('D9')];
    check(toggles >= 100, `as a steady PWM (${toggles} edges in 200 ms)`);
  }
}

section('attachInterrupt');
{
  const b = await boot(`volatile int r = 0, c = 0; void onR() { r++; } void onC() { c++; }
void setup() { ${WAIT} pinMode(2, INPUT_PULLUP); pinMode(3, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(2), onR, RISING); attachInterrupt(digitalPinToInterrupt(3), onC, CHANGE); }
void loop() { Serial.print("i "); Serial.print(r); Serial.print(' '); Serial.println(c); delay(20); }`);
  if (b) {
    run(b.r, 500);
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

section('on the canvas: an LED on pin 13, an I2C EEPROM on Wire and an SPI flash');
{
  let seq = 0;
  const uid = (p: string) => `${p}${++seq}`;
  const project: CircuitProject = emptyProject('teensy41');
  const board: ComponentInstance = { id: uid('b'), definitionId: 'board.teensy41', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {} };
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
  wire(board, '3V3_1', ee, 'vcc');
  wire(board, 'GND2', ee, 'gnd');
  wire(board, 'D18', ee, 'sda');
  wire(board, 'D19', ee, 'scl');
  const flash = part('comp.spi-flash');
  wire(board, '3V3_1', flash, 'vcc');
  wire(board, 'GND2', flash, 'gnd');
  wire(board, 'D10', flash, 'cs');
  wire(board, 'D11', flash, 'mosi');
  wire(board, 'D12', flash, 'miso');
  wire(board, 'D13', flash, 'sck');

  // The LED shares D13 with SCK, as on the board itself, so it blinks only
  // once the SPI work is done and the pin is handed back.
  const b = await boot(`#include <Wire.h>
#include <SPI.h>
void setup() { ${WAIT} Wire.begin();
  Wire.beginTransmission(0x50); Wire.write(0); Wire.write(5); Wire.write(0xA7); Wire.write(0x5C); int e = Wire.endTransmission(); delay(10);
  Wire.beginTransmission(0x50); Wire.write(0); Wire.write(5); Wire.endTransmission(); Wire.requestFrom(0x50, 1);
  int v = Wire.available() ? Wire.read() : -1;
  Wire.beginTransmission(0x50); Wire.write(0); Wire.write(5); Wire.endTransmission(); Wire.requestFrom(0x50, 2);
  int v2 = Wire.read(); int v3 = Wire.read();
  Serial.print("ee "); Serial.print(e); Serial.print(' '); Serial.print(v); Serial.print(' '); Serial.print(v2); Serial.print(' '); Serial.println(v3);
  Wire.beginTransmission(0x51); Serial.print("absent "); Serial.println(Wire.endTransmission());
  pinMode(10, OUTPUT); digitalWrite(10, HIGH); SPI.begin();
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  digitalWrite(10, LOW); SPI.transfer(0x9F); uint8_t m = SPI.transfer(0); uint8_t t = SPI.transfer(0); digitalWrite(10, HIGH);
  SPI.endTransaction(); SPI.end();
  Serial.print("jedec "); Serial.print(m, HEX); Serial.print(' '); Serial.println(t, HEX);
  pinMode(13, OUTPUT); }
void loop() { digitalWrite(13, HIGH); delay(100); digitalWrite(13, LOW); delay(100); }`);
  if (b) {
    const binding = new CircuitBinding(project, b.r);
    const controls = emptyControls();
    const states: boolean[] = [];
    for (let t = 0; t < 1600; t += 5) {
      b.r.runFor(5);
      states.push(binding.update(controls).visuals.get(led.id)?.ledOn === true);
    }
    check(/ee 0 167 167 92/.test(b.out()), `Wire writes to the EEPROM part and reads one and two bytes back (${last(b.out(), /(ee .*)\r/g)})`);
    check(/absent 2/.test(b.out()), `an address with nothing on the bus is NACKed (${last(b.out(), /(absent .*)\r/g)})`);
    check(/jedec EF 40/.test(b.out()), `SPI reads the flash part's JEDEC ID (${last(b.out(), /(jedec .*)\r/g)})`);
    const flips = states.slice(-150).filter((s, i, a) => i > 0 && s !== a[i - 1]).length;
    check(flips >= 4, `the LED on pin 13 blinks on the canvas (${flips} changes in 750 ms)`);
  }
}

section('IntervalTimer, tone(), Servo and EEPROM');
// IntervalTimer and tone() run on the PIT; Servo is Teensy's own library;
// EEPROM is emulated in the last sectors of the QSPI flash, changed through
// FlexSPI IP commands. 3000 writes to one address fill an EEPROM sector
// (2048 two-byte entries), so the emulation has to erase and compact one.
{
  const b = await boot(`#include <Servo.h>
#include <EEPROM.h>
IntervalTimer it;
volatile uint32_t ticks = 0;
void tick() { ticks++; }
Servo sv;
void setup() {
  ${WAIT}
  it.begin(tick, 1000);
  tone(9, 1000);
  sv.attach(6);
  sv.write(90);
  for (int i = 0; i < 3000; i++) EEPROM.write(0, i & 0xff);
  for (int a = 1; a < 40; a++) EEPROM.write(a, a * 3);
  bool ok = EEPROM.read(0) == (2999 & 0xff);
  for (int a = 1; a < 40; a++) ok = ok && EEPROM.read(a) == a * 3;
  Serial.print("eeprom "); Serial.println(ok ? "ok" : "bad");
  uint32_t t0 = ticks; delay(500); Serial.print("ticks "); Serial.println(ticks - t0);
}
void loop() {}`);
  if (b) {
    const edges: number[] = [];
    const tonePad = pin('D9');
    b.r.addPinListener((p: number, high: boolean) => {
      if (p === tonePad && high) edges.push(b.r.timeMs);
    });
    run(b.r, 2500, 20);
    check(/eeprom ok/.test(b.out()), `EEPROM keeps every write, through a sector rollover (${last(b.out(), /(eeprom \w+)/g) ?? 'nothing'})`);
    const ticks = Number(last(b.out(), /ticks (\d+)/g) ?? 0);
    check(ticks >= 499 && ticks <= 501, `IntervalTimer at 1 ms fires 500 times in 500 ms (${ticks})`);
    const recent = edges.slice(-40);
    const period = recent.length > 2 ? (recent.at(-1)! - recent[0]) / (recent.length - 1) : 0;
    check(Math.abs(period - 1) < 0.01, `tone(9, 1000) makes a 1 kHz square wave (${period.toFixed(4)} ms period)`);
    const width = b.r.snapshot().pulseWidthUs[pin('D6')];
    check(width > 1400 && width < 1600, `Servo.write(90) makes a 1.5 ms pulse on pin 6 (${width?.toFixed(0)} us)`);
  }
}

section('EEPROM survives the reset button');
{
  const b = await boot(`#include <EEPROM.h>
void setup() {
  ${WAIT}
  int boots = EEPROM.read(100) == 0xff ? 1 : EEPROM.read(100) + 1;
  EEPROM.write(100, boots);
  Serial.print("boot "); Serial.println(boots);
}
void loop() {}`);
  if (b) {
    run(b.r, 800, 20);
    const first = last(b.out(), /boot (\d+)/g);
    b.r.reset();
    run(b.r, 800, 20);
    const second = last(b.out(), /boot (\d+)/g);
    check(first === '1' && second === '2', `a value written before the reset is read after it (boot ${first}, then boot ${second})`);
  }
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
