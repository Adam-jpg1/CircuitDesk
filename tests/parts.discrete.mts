// Discrete parts that used to be wiring only: transistors, a MOSFET, diodes,
// a level shifter, a capacitor, a speaker and a pulse sensor.
//
// Each is driven by real compiled firmware on the AVR emulator through the
// real circuit binding, and checked by what a learner would look at: an LED
// lit or dark and how bright, the voltage on a net, the number analogRead()
// returns, the note a speaker plays, the beats a sketch counts.

import { compileProject } from '../server/compiler/compilerService';
import { AVRRunner, F_CPU } from '../src/simulation/avrRunner';
import { CircuitBinding, emptyControls, type ComponentVisualState, type NetLevel } from '../src/simulation/circuitSim';
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

let seq = 0;
const uid = (p: string) => `${p}${++seq}`;
const part = (definitionId: string, properties: Record<string, unknown> = {}): ComponentInstance => ({
  id: uid('c'), definitionId, x: 0, y: 0, rotation: 0, properties, simulationState: {},
});

interface Bench {
  project: CircuitProject;
  board: ComponentInstance;
  add(definitionId: string, properties?: Record<string, unknown>): ComponentInstance;
  wire(a: ComponentInstance, ap: string, b: ComponentInstance, bp: string): void;
}
function bench(): Bench {
  const project = emptyProject('parts');
  const board = part('board.arduino-uno');
  project.boardInstances.push(board);
  return {
    project,
    board,
    add(definitionId, properties = {}) {
      const p = part(definitionId, properties);
      project.componentInstances.push(p);
      return p;
    },
    wire(a, ap, b, bp) {
      project.connections.push({
        id: uid('w'), sourceComponentId: a.id, sourcePinId: ap, targetComponentId: b.id, targetPinId: bp,
        netId: '', color: '#000', points: [], routing: 'smooth',
      } as CircuitProject['connections'][number]);
    },
  };
}

interface Run {
  serial: () => string;
  visuals: () => Map<string, ComponentVisualState>;
  levels: () => Map<string, NetLevel>;
  net: (inst: ComponentInstance, pinId: string) => NetLevel | undefined;
  advance: (ms: number) => void;
}

async function start(b: Bench, sketch: string): Promise<Run | null> {
  const built = await compileProject({ fqbn: 'arduino:avr:uno', boardId: 'board.arduino-uno', files: [{ name: 'sketch.ino', content: sketch }] }, false);
  if (!built.firmware) {
    console.log(`SKIP: the sketch did not build here (${built.errors?.[0]?.message ?? built.error})`);
    skipped++;
    return null;
  }
  const runner = new AVRRunner(built.firmware.data);
  let text = '';
  runner.onSerialByte = (byte) => (text += String.fromCharCode(byte));
  const binding = new CircuitBinding(b.project, runner);
  const controls = emptyControls();
  let last = binding.update(controls);
  const lookup = binding as unknown as { netOfInstancePin(id: string, pin: string): string | undefined };
  return {
    serial: () => text,
    visuals: () => last.visuals,
    levels: () => last.netLevels,
    net: (inst, pinId) => {
      const id = lookup.netOfInstancePin(inst.id, pinId);
      return id ? last.netLevels.get(id) : undefined;
    },
    advance: (ms) => {
      const target = runner.cpu.cycles + (ms / 1000) * F_CPU;
      while (runner.cpu.cycles < target) {
        runner.runToCycles(runner.cpu.cycles + F_CPU / 1000);
        last = binding.update(controls);
      }
    },
  };
}

const lastNumber = (text: string, key: string) => {
  const all = [...text.matchAll(new RegExp(`${key} (-?\\d+)`, 'g'))];
  return all.length ? Number(all[all.length - 1][1]) : NaN;
};

// ------------------------------------------------------------------ NPN
section('an NPN transistor switches an LED on its low side');
{
  const b = bench();
  const rb = b.add('comp.resistor', { resistance: 1000 });
  const q = b.add('comp.transistor-npn');
  const rl = b.add('comp.resistor', { resistance: 220 });
  const led = b.add('comp.led');
  b.wire(b.board, 'D9', rb, 'p1');
  b.wire(rb, 'p2', q, 'base');
  b.wire(q, 'emitter', b.board, 'GND_PWR1');
  b.wire(b.board, '5V', rl, 'p1');
  b.wire(rl, 'p2', led, 'anode');
  b.wire(led, 'cathode', q, 'collector');
  const run = await start(b, `void setup(){ pinMode(9, OUTPUT); }
void loop(){
  digitalWrite(9, HIGH); delay(300);
  digitalWrite(9, LOW); delay(300);
  analogWrite(9, 64); delay(600);
  while (1);
}`);
  if (run) {
    run.advance(150);
    check(run.visuals().get(led.id)?.ledOn === true, 'base driven high: the transistor conducts and the LED lights');
    check(run.visuals().get(q.id)?.on === true, 'and the transistor reports itself conducting');
    run.advance(300);
    check(run.visuals().get(led.id)?.ledOn !== true, 'base low: the LED goes dark');
    check(run.net(q, 'collector')?.volts == null || (run.net(q, 'collector')!.volts ?? 0) > 2, 'and the collector is no longer pulled down');
    run.advance(450);
    const brightness = run.visuals().get(led.id)?.brightness ?? 0;
    check(Math.abs(brightness - 0.25) < 0.08, `PWM 64/255 on the base dims the LED to about a quarter (${brightness.toFixed(2)})`);
  }
}

// -------------------------------------------------------------- floating emitter
section('a transistor with its emitter unwired switches nothing');
{
  const b = bench();
  const rb = b.add('comp.resistor', { resistance: 1000 });
  const q = b.add('comp.transistor-npn');
  const led = b.add('comp.led');
  const rl = b.add('comp.resistor', { resistance: 220 });
  b.wire(b.board, 'D9', rb, 'p1');
  b.wire(rb, 'p2', q, 'base');
  b.wire(b.board, '5V', rl, 'p1');
  b.wire(rl, 'p2', led, 'anode');
  b.wire(led, 'cathode', q, 'collector');
  const run = await start(b, 'void setup(){ pinMode(9, OUTPUT); digitalWrite(9, HIGH); } void loop(){}');
  if (run) {
    run.advance(100);
    check(run.visuals().get(led.id)?.ledOn !== true, 'the LED stays dark: there is no path to ground');
  }
}

// ---------------------------------------------------------------- MOSFET
section('a logic-level MOSFET switches a load from a 3.3 V-level gate');
{
  const b = bench();
  const m = b.add('comp.mosfet');
  const rl = b.add('comp.resistor', { resistance: 220 });
  const led = b.add('comp.led');
  b.wire(b.board, 'D10', m, 'gate');
  b.wire(m, 'source', b.board, 'GND_PWR1');
  b.wire(b.board, '5V', rl, 'p1');
  b.wire(rl, 'p2', led, 'anode');
  b.wire(led, 'cathode', m, 'drain');
  const run = await start(b, `void setup(){ pinMode(10, OUTPUT); }
void loop(){ digitalWrite(10, HIGH); delay(200); digitalWrite(10, LOW); delay(200); analogWrite(10, 191); while(1); }`);
  if (run) {
    run.advance(100);
    check(run.visuals().get(led.id)?.ledOn === true, 'gate high: drain pulled to source, LED lit');
    check((run.net(m, 'drain')?.volts ?? 9) < 0.1, `the drain sits at the source (${run.net(m, 'drain')?.volts})`);
    run.advance(200);
    check(run.visuals().get(led.id)?.ledOn !== true, 'gate low: LED dark');
    run.advance(500);
    const brightness = run.visuals().get(led.id)?.brightness ?? 0;
    check(Math.abs(brightness - 0.75) < 0.08, `PWM 191/255 on the gate: about three quarters (${brightness.toFixed(2)})`);
  }
}

// ----------------------------------------------------------------- diodes
section('a diode conducts one way');
{
  const b = bench();
  const fwd = b.add('comp.diode');
  const rev = b.add('comp.diode');
  const r1 = b.add('comp.resistor', { resistance: 220 });
  const r2 = b.add('comp.resistor', { resistance: 220 });
  const ledF = b.add('comp.led');
  const ledR = b.add('comp.led');
  // Forward: D7 → anode, cathode → R → LED → GND.
  b.wire(b.board, 'D7', fwd, 'anode');
  b.wire(fwd, 'cathode', r1, 'p1');
  b.wire(r1, 'p2', ledF, 'anode');
  b.wire(ledF, 'cathode', b.board, 'GND_PWR1');
  // Reversed: D8 → cathode, anode → R → LED → GND.
  b.wire(b.board, 'D8', rev, 'cathode');
  b.wire(rev, 'anode', r2, 'p1');
  b.wire(r2, 'p2', ledR, 'anode');
  b.wire(ledR, 'cathode', b.board, 'GND_PWR2');
  // Diode isolation, as in a keypad: D2 reads through a diode whose cathode D3 drives.
  const iso = b.add('comp.diode');
  b.wire(b.board, 'D2', iso, 'anode');
  b.wire(iso, 'cathode', b.board, 'D3');
  const run = await start(b, `void setup(){
  Serial.begin(115200);
  pinMode(7, OUTPUT); pinMode(8, OUTPUT); digitalWrite(7, HIGH); digitalWrite(8, HIGH);
  pinMode(2, INPUT_PULLUP); pinMode(3, OUTPUT);
}
void loop(){
  digitalWrite(3, LOW); delay(20); Serial.print("low "); Serial.println(digitalRead(2));
  digitalWrite(3, HIGH); delay(20); Serial.print("high "); Serial.println(digitalRead(2));
}`);
  if (run) {
    run.advance(200);
    check(run.visuals().get(ledF.id)?.ledOn === true, 'forward biased: the LED behind it lights');
    const cathode = run.net(fwd, 'cathode')?.volts ?? 0;
    check(Math.abs(cathode - 4.3) < 0.05, `with a 0.7 V drop across it (cathode at ${cathode.toFixed(2)} V)`);
    check(run.visuals().get(ledR.id)?.ledOn !== true, 'reverse biased: nothing passes and the LED stays dark');
    check(lastNumber(run.serial(), 'low') === 0, 'a low cathode pulls the pulled-up anode pin low');
    check(lastNumber(run.serial(), 'high') === 1, 'a high cathode leaves it high: reverse bias does nothing');
  }
}

// ---------------------------------------------------------- level shifter
section('a level shifter translates 5 V logic to 3.3 V and back');
{
  const b = bench();
  const ls = b.add('comp.level-converter');
  b.wire(b.board, '5V', ls, 'hv');
  b.wire(b.board, '3V3', ls, 'lv');
  b.wire(b.board, 'GND_PWR1', ls, 'gnd_h');
  b.wire(b.board, 'D4', ls, 'hv1');
  // Channel 2 the other way: something on the low side drives it, D5 reads.
  b.wire(b.board, 'D6', ls, 'lv2');
  b.wire(ls, 'hv2', b.board, 'D5');
  const run = await start(b, `void setup(){ Serial.begin(115200); pinMode(4, OUTPUT); pinMode(6, OUTPUT); pinMode(5, INPUT); }
void loop(){
  digitalWrite(4, HIGH); digitalWrite(6, HIGH); delay(50); Serial.print("in "); Serial.println(digitalRead(5));
  digitalWrite(4, LOW); digitalWrite(6, LOW); delay(50); Serial.print("in "); Serial.println(digitalRead(5));
}`);
  if (run) {
    let sawHigh = false;
    let sawLow = false;
    let highVolts = NaN;
    for (let t = 0; t < 40; t++) {
      run.advance(5);
      const v = run.net(ls, 'lv1')?.volts;
      if (v != null && v > 1) {
        sawHigh = true;
        highVolts = v;
      }
      if (v === 0) sawLow = true;
    }
    check(sawHigh && Math.abs(highVolts - 3.3) < 0.01, `a 5 V high arrives on the low side as 3.3 V (${highVolts})`);
    check(sawLow, 'and a low arrives as 0 V');
    const seen = [...run.serial().matchAll(/in (\d)/g)].map((m) => m[1]);
    check(seen.includes('1') && seen.includes('0'), `the other channel carries the low side's levels up to a 5 V input (${seen.slice(-4).join(',')})`);
  }
}

// --------------------------------------------------------------- capacitor
section('a capacitor charges through a resistor with tau = R·C');
{
  const b = bench();
  const r = b.add('comp.resistor', { resistance: 10_000 });
  const c = b.add('comp.capacitor', { capacitance: 100 });
  b.wire(b.board, 'D6', r, 'p1');
  b.wire(r, 'p2', c, 'plus');
  b.wire(c, 'minus', b.board, 'GND_PWR1');
  b.wire(c, 'plus', b.board, 'A0');
  const run = await start(b, `void setup(){ Serial.begin(115200); pinMode(6, OUTPUT); digitalWrite(6, LOW); delay(100); digitalWrite(6, HIGH); }
void loop(){ Serial.print("a "); Serial.print(millis()); Serial.print(' '); Serial.println(analogRead(A0)); delay(50); }`);
  if (run) {
    run.advance(120);
    const start0 = lastNumber(run.serial(), 'a \\d+');
    run.advance(1000); // one time constant after D6 went high
    const oneTau = lastNumber(run.serial(), 'a \\d+');
    run.advance(4000);
    const settled = lastNumber(run.serial(), 'a \\d+');
    console.log(`   analogRead: ${start0} → ${oneTau} after ~1 s → ${settled} after ~5 s`);
    check(start0 < 100, `it starts discharged (${start0})`);
    check(Math.abs(oneTau - 647) < 70, `after one time constant it reads about 63 % of full scale (${oneTau}, expect ~647)`);
    check(settled > 1000, `after five it is all but full (${settled})`);
    const shown = run.visuals().get(c.id)?.readout?.[0] ?? '';
    check(/^4\.9\d V$/.test(shown), `the inspector shows its voltage (${shown})`);
  }
}

section('PWM through an RC filter reads as its average');
{
  const b = bench();
  const r = b.add('comp.resistor', { resistance: 10_000 });
  const c = b.add('comp.capacitor', { capacitance: 10 });
  b.wire(b.board, 'D6', r, 'p1');
  b.wire(r, 'p2', c, 'plus');
  b.wire(c, 'minus', b.board, 'GND_PWR1');
  b.wire(c, 'plus', b.board, 'A0');
  const run = await start(b, `void setup(){ Serial.begin(115200); analogWrite(6, 128); }
void loop(){ Serial.print("a "); Serial.println(analogRead(A0)); delay(20); }`);
  if (run) {
    run.advance(1200);
    const reads = [...run.serial().matchAll(/a (\d+)/g)].map((m) => Number(m[1])).slice(-10);
    const min = Math.min(...reads);
    const max = Math.max(...reads);
    check(Math.abs((min + max) / 2 - 514) < 40, `analogWrite(128) filtered reads about half scale (${min}..${max})`);
    check(max - min < 60, 'and holds steady rather than jumping between 0 and 1023');
  }
}

section('a charged capacitor holds its charge when nothing drives it');
{
  const b = bench();
  const c = b.add('comp.capacitor', { capacitance: 100 });
  const r = b.add('comp.resistor', { resistance: 1000 });
  b.wire(b.board, 'D6', r, 'p1');
  b.wire(r, 'p2', c, 'plus');
  b.wire(c, 'minus', b.board, 'GND_PWR1');
  b.wire(c, 'plus', b.board, 'A0');
  const run = await start(b, `void setup(){ Serial.begin(115200); pinMode(6, OUTPUT); digitalWrite(6, HIGH); delay(1000); pinMode(6, INPUT); }
void loop(){ Serial.print("a "); Serial.println(analogRead(A0)); delay(50); }`);
  if (run) {
    run.advance(2000);
    const held = lastNumber(run.serial(), 'a');
    check(held > 1000, `with the pin released it still reads charged (${held})`);
  }
}

// ----------------------------------------------------------------- speaker
section('a speaker plays the note tone() asks for');
{
  const b = bench();
  const spk = b.add('comp.speaker');
  b.wire(b.board, 'D8', spk, 'plus');
  b.wire(spk, 'minus', b.board, 'GND_PWR1');
  const run = await start(b, 'void setup(){ tone(8, 440); delay(400); tone(8, 1000); delay(400); noTone(8); } void loop(){}');
  if (run) {
    run.advance(350);
    const a = run.visuals().get(spk.id);
    check(a?.buzzerOn === true && Math.abs((a.value ?? 0) - 440) < 15, `tone(8, 440): it plays about 440 Hz (${a?.value?.toFixed(0)})`);
    run.advance(400);
    const hi = run.visuals().get(spk.id);
    check(Math.abs((hi?.value ?? 0) - 1000) < 30, `tone(8, 1000): about 1 kHz (${hi?.value?.toFixed(0)})`);
    run.advance(300);
    check(run.visuals().get(spk.id)?.buzzerOn !== true, 'noTone(): silent');
  }
}

// ------------------------------------------------------------ pulse sensor
section('a pulse sensor beats at the rate set on it');
{
  const b = bench();
  const ps = b.add('comp.pulse-sensor');
  b.wire(b.board, '5V', ps, 'vcc');
  b.wire(ps, 'gnd', b.board, 'GND_PWR1');
  b.wire(ps, 'sig', b.board, 'A1');
  // The PulseSensor library's own idea: a beat is a rise through a threshold.
  const run = await start(b, `int beats = 0; bool above = false; int lo = 1023, hi = 0;
void setup(){ Serial.begin(115200); }
void loop(){
  int v = analogRead(A1);
  if (v < lo) lo = v; if (v > hi) hi = v;
  if (!above && v > 650) { above = true; beats++; }
  if (above && v < 560) above = false;
  static unsigned long t = 0;
  if (millis() - t >= 500) { t = millis(); Serial.print("beats "); Serial.print(beats); Serial.print(" lo "); Serial.print(lo); Serial.print(" hi "); Serial.println(hi); }
  delay(2);
}`);
  if (run) {
    run.advance(10_000);
    const beats = lastNumber(run.serial(), 'beats');
    const lo = lastNumber(run.serial(), 'lo');
    const hi = lastNumber(run.serial(), 'hi');
    console.log(`   ${beats} beats in 10 s, signal ${lo}..${hi}`);
    check(beats >= 11 && beats <= 13, `72 BPM gives 12 beats in ten seconds (${beats})`);
    check(lo > 380 && lo < 512 && hi > 700 && hi < 830, `around a half-supply baseline, peaking about a quarter above it (${lo}..${hi})`);
  }
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
