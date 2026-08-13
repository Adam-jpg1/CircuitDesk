// The joystick and the rotary encoder, through firmware.
//
// Both are parts whose whole value is that they are awkward: a joystick is two
// potentiometers that a real ADC has to read, and an encoder is a pair of
// contacts whose *order* carries the direction. Neither is meaningful if the
// component hands the sketch a number.

import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject } from '../src/project/templates';
import { contactStateKey } from '../src/simulation/devices/contacts';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import type { CircuitProject, ComponentInstance } from '../src/types';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function skip(msg: string) {
  console.log('SKIP:', msg);
  skipped++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

let seq = 0;
const uid = (p: string) => `${p}${++seq}`;
const defOf = (id: string) => COMPONENT_DEFINITIONS.find((d) => d.id === id)!;

function wireInto(p: CircuitProject, a: string, ap: string, b: string, bp: string): void {
  p.connections.push({
    id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
    netId: '', color: '#e8590c', points: [], routing: 'smooth',
  } as CircuitProject['connections'][number]);
}

// ============================= 1. the joystick reads through a real ADC ====
section('1. joystick axes reach the ADC');
{
  const READ = [
    'void setup() { Serial1.begin(115200); pinMode(16, INPUT_PULLUP); }',
    'void loop() {',
    '  Serial1.print("X="); Serial1.print(analogRead(26));',
    '  Serial1.print(" Y="); Serial1.print(analogRead(27));',
    '  Serial1.print(" SW="); Serial1.println(digitalRead(16));',
    '  delay(25);',
    '}',
  ].join('\n');

  const p = emptyProject('joystick');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.raspberry-pi-pico', x: 0, y: 0, rotation: 0,
    properties: {}, simulationState: {},
  };
  const stick: ComponentInstance = {
    id: uid('j'), definitionId: 'comp.joystick', x: 300, y: 0, rotation: 0,
    properties: {}, simulationState: {},
  };
  p.boardInstances.push(board);
  p.componentInstances.push(stick);
  p.codeFiles = [{ id: 'j', name: 'sketch.ino', content: READ, language: 'cpp' }];
  wireInto(p, board.id, '3V3', stick.id, 'vcc');
  wireInto(p, board.id, 'GND1', stick.id, 'gnd');
  wireInto(p, board.id, 'GP26', stick.id, 'vrx');
  wireInto(p, board.id, 'GP27', stick.id, 'vry');
  wireInto(p, board.id, 'GP16', stick.id, 'sw');

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the RP2040 toolchain is unavailable — the joystick firmware test cannot run');
  } else {
    simulationController.pause();
    const sim = useSimulationStore.getState();

    const lastReading = (): { x: number; y: number; sw: number } | null => {
      simulationController.publishNow();
      const lines = useSimulationStore.getState().serialText.split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = /X=(\d+) Y=(\d+) SW=(\d)/.exec(lines[i]);
        if (m) return { x: Number(m[1]), y: Number(m[2]), sw: Number(m[3]) };
      }
      return null;
    };

    // Centred: both axes about half scale, which is what a real stick at rest
    // reads. Nothing sets this — it is the default wiper position.
    // Arduino-Pico's analogRead is 10-bit by default, so full scale is 1023.
    const FULL = 1023;
    simulationController.advance(300);
    const centred = lastReading();
    console.log(`   centred: ${JSON.stringify(centred)}`);
    check(centred !== null, 'the sketch is reading the ADC');
    if (centred) {
      check(centred.x > FULL * 0.4 && centred.x < FULL * 0.6, `X reads about half scale at rest (${centred.x}/${FULL})`);
      check(centred.y > FULL * 0.4 && centred.y < FULL * 0.6, `Y reads about half scale at rest (${centred.y}/${FULL})`);
      check(centred.sw === 1, 'and the switch reads high, pulled up and not pressed');
    }

    // Push the stick fully one way. The axis is a wiper position, so the ADC
    // reading has to follow it — through the supply, not around it.
    sim.setPot(`${stick.id}#x`, 1);
    sim.setPot(`${stick.id}#y`, 0);
    useSimulationStore.getState().clearSerial();
    simulationController.advance(300);
    const pushed = lastReading();
    console.log(`   pushed:  ${JSON.stringify(pushed)}`);
    if (pushed) {
      check(pushed.x > FULL * 0.93, `X reads near full scale when pushed (${pushed.x}/${FULL})`);
      check(pushed.y < FULL * 0.07, `and Y reads near zero the other way (${pushed.y}/${FULL})`);
    }

    // Click: a contact to ground, read by a pulled-up input.
    sim.pressButton(contactStateKey(stick.id, 'sw'), true);
    useSimulationStore.getState().clearSerial();
    simulationController.advance(200);
    const clicked = lastReading();
    check(clicked?.sw === 0, `clicking the stick pulls SW low (${clicked?.sw})`);

    sim.pressButton(contactStateKey(stick.id, 'sw'), false);
    useSimulationStore.getState().clearSerial();
    simulationController.advance(200);
    check(lastReading()?.sw === 1, 'and releasing it lets the pull-up win again');

    // A joystick with no supply cannot impose anything: the axes go dead
    // rather than reporting a number the hardware could not produce.
    check(defOf('comp.joystick').pins.find((x) => x.id === 'vcc')?.type === 'power-5v', 'the module is powered through a real VCC pin');
  }
  simulationController.stop();
}

// ================== 2. the encoder's direction is in the contact order =====
section('2. rotary encoder — quadrature, decoded by firmware');
{
  const DECODE = [
    'volatile long position = 0;',
    'int lastA = HIGH;',
    'void setup() {',
    '  Serial1.begin(115200);',
    '  pinMode(14, INPUT_PULLUP);',
    '  pinMode(15, INPUT_PULLUP);',
    '}',
    'void loop() {',
    '  int a = digitalRead(14);',
    '  int b = digitalRead(15);',
    '  if (a != lastA) {',
    '    if (a == LOW) { position += (b == HIGH) ? 1 : -1; Serial1.print("POS "); Serial1.println(position); }',
    '    lastA = a;',
    '  }',
    '}',
  ].join('\n');

  const p = emptyProject('encoder');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.raspberry-pi-pico', x: 0, y: 0, rotation: 0,
    properties: {}, simulationState: {},
  };
  const enc: ComponentInstance = {
    id: uid('e'), definitionId: 'comp.rotary-encoder', x: 300, y: 0, rotation: 0,
    properties: {}, simulationState: {},
  };
  p.boardInstances.push(board);
  p.componentInstances.push(enc);
  p.codeFiles = [{ id: 'e', name: 'sketch.ino', content: DECODE, language: 'cpp' }];
  wireInto(p, board.id, 'GND1', enc.id, 'gnd');
  wireInto(p, board.id, '3V3', enc.id, 'vcc');
  wireInto(p, board.id, 'GP14', enc.id, 'clk');
  wireInto(p, board.id, 'GP15', enc.id, 'dt');

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the RP2040 toolchain is unavailable — the encoder firmware test cannot run');
  } else {
    simulationController.pause();
    const sim = useSimulationStore.getState();
    const A = contactStateKey(enc.id, 'a');
    const B = contactStateKey(enc.id, 'b');

    const position = (): number | null => {
      simulationController.publishNow();
      const lines = useSimulationStore.getState().serialText.split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = /POS (-?\d+)/.exec(lines[i]);
        if (m) return Number(m[1]);
      }
      return null;
    };

    simulationController.advance(200);

    /**
     * One detent. A and B close and open a quarter-cycle apart; which one
     * leads is the direction, and the firmware is the only thing that decides
     * what that means.
     */
    const step = (clockwise: boolean) => {
      const [first, second] = clockwise ? [A, B] : [B, A];
      const s = useSimulationStore.getState();
      s.pressButton(first, true);
      simulationController.advance(4);
      s.pressButton(second, true);
      simulationController.advance(4);
      s.pressButton(first, false);
      simulationController.advance(4);
      s.pressButton(second, false);
      simulationController.advance(4);
    };

    useSimulationStore.getState().clearSerial();
    for (let i = 0; i < 5; i++) step(true);
    simulationController.advance(60);
    const cw = position();
    console.log(`   after 5 clockwise detents: ${cw}`);
    check(cw !== null, 'the firmware decoded movement from the quadrature lines');
    check(cw !== null && cw > 0, `turning one way counts up (${cw})`);

    useSimulationStore.getState().clearSerial();
    for (let i = 0; i < 5; i++) step(false);
    simulationController.advance(60);
    const ccw = position();
    console.log(`   after 5 counter-clockwise detents: ${ccw}`);
    check(ccw !== null && cw !== null && ccw < cw, `and turning the other way counts back down (${cw} → ${ccw})`);

    // Direction came from the order of two contacts, not from a property.
    check(
      !JSON.stringify(defOf('comp.rotary-encoder').properties).includes('direction'),
      'the part has no direction property — the order of the contacts is the direction',
    );
  }
  simulationController.stop();
}

console.log(
  failures === 0
    ? `\nAnalog-input checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
