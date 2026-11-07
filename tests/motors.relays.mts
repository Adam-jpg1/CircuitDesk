// Relays: the coil moves the contacts, and the contacts are real contacts.
//
// This file exists because of something the matrix claimed and the code did not
// do. `comp.relay` was recorded as behavioural with the note "coil current
// switches modelled contacts", and named a test file that never mentioned it.
// What actually happened was that a `coilOn` flag reached the canvas and the
// contacts were never wired into the circuit at all — so a relay switching an
// LED lit nothing, and the part looked like it worked because the little
// indicator came on.
//
// A relay's contacts are electrically the same thing a switch's contacts are.
// The only difference is what moves them. So they now go through the same
// contact model, driven by the coil, and this file proves the load side
// actually switches rather than the indicator.

import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject } from '../src/project/templates';
import { contactsOf } from '../src/simulation/devices/contactRegistry';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import { COMPONENT_COVERAGE } from '../src/components-library/componentCoverage';
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
const defOf = (id: string) => COMPONENT_DEFINITIONS.find((d) => d.id === id);

const inst = (definitionId: string, x: number): ComponentInstance => ({
  id: uid('c'), definitionId, x, y: 0, rotation: 0, properties: {}, simulationState: {},
});

function wireInto(p: CircuitProject, a: string, ap: string, b: string, bp: string) {
  p.connections.push({
    id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
    netId: '', color: '#000', points: [], routing: 'smooth',
  } as CircuitProject['connections'][number]);
}

// ==================================== 1. contact topology is the real topology
section('1. the contacts a relay has');
{
  const spdt = defOf('comp.relay');
  check(spdt !== undefined, 'the SPDT relay is in the library');
  const spdtContacts = contactsOf('comp.relay', inst('comp.relay', 0));
  check(spdtContacts.length === 2, `an SPDT has two contacts (${spdtContacts.length})`);
  const nc = spdtContacts.find((c) => c.normallyClosed);
  check(nc !== undefined, 'one of which is normally closed');
  check(nc?.a === 'com' && nc?.b === 'nc', 'and it is the one joining COM to NC');

  const dpdt = defOf('comp.relay-dpdt');
  check(dpdt !== undefined, 'the DPDT relay is in the library');
  const dpdtContacts = contactsOf('comp.relay-dpdt', inst('comp.relay-dpdt', 0));
  check(dpdtContacts.length === 4, `a DPDT has four (${dpdtContacts.length})`);
  check(
    dpdtContacts.filter((c) => c.normallyClosed).length === 2,
    'two of which are normally closed — one per section',
  );
  // Two independent COMs is what makes it a double-pole part rather than two
  // contacts on one pole.
  const commons = new Set(dpdtContacts.map((c) => c.a));
  check(commons.size === 2, `on two separate commons (${[...commons].join(', ')})`);
}

// ================================= 2. an executed sketch switching a real load
section('2. the coil switches a load, not an indicator');
{
  // The relay's COM is on the supply and its NO feeds an LED. If the contacts
  // were not in the circuit — which is exactly the bug this file was written
  // for — the LED would never light however the coil was driven.
  const SOURCE = [
    'void setup() { pinMode(7, OUTPUT); digitalWrite(7, LOW); }',
    'void loop() {',
    '  digitalWrite(7, millis() > 100 && millis() < 300 ? HIGH : LOW);',
    '}',
  ].join('\n');

  const p = emptyProject('relay');
  const board = inst('board.arduino-uno', 0);
  const relay = inst('comp.relay', 200);
  const led = inst('comp.led', 400);
  const resistor = inst('comp.resistor', 500);
  p.boardInstances.push(board);
  p.componentInstances.push(relay, led, resistor);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];

  wireInto(p, board.id, '5V', relay.id, 'vcc');
  wireInto(p, board.id, 'GND_TOP', relay.id, 'gnd');
  wireInto(p, board.id, 'D7', relay.id, 'in');
  // Load side: 5V -> COM, NO -> resistor -> LED -> ground.
  wireInto(p, board.id, '5V', relay.id, 'com');
  wireInto(p, relay.id, 'no', resistor.id, 'p1');
  wireInto(p, resistor.id, 'p2', led.id, 'anode');
  wireInto(p, led.id, 'cathode', board.id, 'GND_PWR1');

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the relay load test cannot run');
  } else {
    simulationController.pause();
    const ledOn = () => {
      simulationController.publishNow();
      const visuals = useSimulationStore.getState().visuals as Record<
        string,
        { ledOn?: boolean; coilOn?: boolean }
      >;
      return { led: visuals[led.id]?.ledOn === true, coil: visuals[relay.id]?.coilOn === true };
    };

    simulationController.advance(50);
    const rest = ledOn();
    console.log(`   t=50ms   coil ${rest.coil}, LED ${rest.led}`);
    check(!rest.coil, 'at rest the coil is off');
    check(!rest.led, 'and the load on NO is dark, because COM is joined to NC');

    simulationController.advance(150);
    const pulled = ledOn();
    console.log(`   t=200ms  coil ${pulled.coil}, LED ${pulled.led}`);
    check(pulled.coil, 'driving the coil energises it');
    check(pulled.led, 'and the load on NO lights — the contacts are genuinely in the circuit');

    simulationController.advance(200);
    const released = ledOn();
    console.log(`   t=400ms  coil ${released.coil}, LED ${released.led}`);
    check(!released.coil, 'releasing the coil de-energises it');
    check(!released.led, 'and the load goes out again');
  }
  simulationController.stop();
}

// ============================== 3. the normally-closed side is the other half
section('3. NC conducts at rest and opens when the coil pulls in');
{
  const SOURCE = [
    'void setup() { pinMode(7, OUTPUT); digitalWrite(7, LOW); }',
    'void loop() { digitalWrite(7, millis() > 150 ? HIGH : LOW); }',
  ].join('\n');

  const p = emptyProject('relay-nc');
  const board = inst('board.arduino-uno', 0);
  const relay = inst('comp.relay', 200);
  const led = inst('comp.led', 400);
  const resistor = inst('comp.resistor', 500);
  p.boardInstances.push(board);
  p.componentInstances.push(relay, led, resistor);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];

  wireInto(p, board.id, '5V', relay.id, 'vcc');
  wireInto(p, board.id, 'GND_TOP', relay.id, 'gnd');
  wireInto(p, board.id, 'D7', relay.id, 'in');
  wireInto(p, board.id, '5V', relay.id, 'com');
  wireInto(p, relay.id, 'nc', resistor.id, 'p1'); // the OTHER contact
  wireInto(p, resistor.id, 'p2', led.id, 'anode');
  wireInto(p, led.id, 'cathode', board.id, 'GND_PWR1');

  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the NC variant would not start');
  } else {
    simulationController.pause();
    const ledOn = () => {
      simulationController.publishNow();
      const visuals = useSimulationStore.getState().visuals as Record<string, { ledOn?: boolean }>;
      return visuals[led.id]?.ledOn === true;
    };
    simulationController.advance(80);
    check(ledOn(), 'a load on NC is lit at rest');
    simulationController.advance(200);
    check(!ledOn(), 'and goes out when the coil pulls the armature over');
  }
  simulationController.stop();
}

// ================================= 4. a relay whose ground was never wired ====
section('4. a coil with no return does not pull in');
{
  const SOURCE = ['void setup() { pinMode(7, OUTPUT); digitalWrite(7, HIGH); }', 'void loop() {}'].join('\n');

  const p = emptyProject('relay-nognd');
  const board = inst('board.arduino-uno', 0);
  const relay = inst('comp.relay', 200);
  const led = inst('comp.led', 400);
  const resistor = inst('comp.resistor', 500);
  p.boardInstances.push(board);
  p.componentInstances.push(relay, led, resistor);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];

  wireInto(p, board.id, '5V', relay.id, 'vcc');
  wireInto(p, board.id, 'D7', relay.id, 'in');
  // No GND on the relay: the coil has no return path.
  wireInto(p, board.id, '5V', relay.id, 'com');
  wireInto(p, relay.id, 'no', resistor.id, 'p1');
  wireInto(p, resistor.id, 'p2', led.id, 'anode');
  wireInto(p, led.id, 'cathode', board.id, 'GND_PWR1');

  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the no-ground variant would not start');
  } else {
    simulationController.pause();
    simulationController.advance(200);
    simulationController.publishNow();
    const visuals = useSimulationStore.getState().visuals as Record<string, { ledOn?: boolean }>;
    check(
      visuals[led.id]?.ledOn !== true,
      'a relay module whose ground was forgotten does not click, so the load stays dark',
    );
  }
  simulationController.stop();
}

// ============================================= 5. the DPDT moves both sections
section('5. both poles of a DPDT move together');
{
  const SOURCE = [
    'void setup() { pinMode(7, OUTPUT); digitalWrite(7, LOW); }',
    'void loop() { digitalWrite(7, millis() > 150 ? HIGH : LOW); }',
  ].join('\n');

  const p = emptyProject('dpdt');
  const board = inst('board.arduino-uno', 0);
  const relay = inst('comp.relay-dpdt', 200);
  const ledA = inst('comp.led', 400);
  const resA = inst('comp.resistor', 450);
  const ledB = inst('comp.led', 500);
  const resB = inst('comp.resistor', 550);
  p.boardInstances.push(board);
  p.componentInstances.push(relay, ledA, resA, ledB, resB);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];

  wireInto(p, board.id, '5V', relay.id, 'vcc');
  wireInto(p, board.id, 'GND_TOP', relay.id, 'gnd');
  wireInto(p, board.id, 'D7', relay.id, 'in');
  // Section A's NO and section B's NC, so one lights as the other goes out.
  wireInto(p, board.id, '5V', relay.id, 'com1');
  wireInto(p, relay.id, 'no1', resA.id, 'p1');
  wireInto(p, resA.id, 'p2', ledA.id, 'anode');
  wireInto(p, ledA.id, 'cathode', board.id, 'GND_PWR1');
  wireInto(p, board.id, '5V', relay.id, 'com2');
  wireInto(p, relay.id, 'nc2', resB.id, 'p1');
  wireInto(p, resB.id, 'p2', ledB.id, 'anode');
  wireInto(p, ledB.id, 'cathode', board.id, 'GND_PWR1');

  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the DPDT variant would not start');
  } else {
    simulationController.pause();
    const read = () => {
      simulationController.publishNow();
      const v = useSimulationStore.getState().visuals as Record<string, { ledOn?: boolean }>;
      return { a: v[ledA.id]?.ledOn === true, b: v[ledB.id]?.ledOn === true };
    };
    simulationController.advance(80);
    const rest = read();
    console.log(`   at rest: A(NO)=${rest.a} B(NC)=${rest.b}`);
    check(!rest.a && rest.b, 'at rest the NO load is dark and the NC load is lit');

    simulationController.advance(200);
    const on = read();
    console.log(`   energised: A(NO)=${on.a} B(NC)=${on.b}`);
    check(on.a && !on.b, 'and energising swaps both — one armature, two sections');
  }
  simulationController.stop();
}

// ==================================================== 6. the parts as shipped =
section('6. the parts in the library');
{
  for (const id of ['comp.relay', 'comp.relay-dpdt']) {
    const def = defOf(id);
    check(def !== undefined, `${id} is in the library`);
    if (!def) continue;
    check(def.simulationAdapterId === 'sim.relay', `${id} is on the relay adapter`);
    const cov = COMPONENT_COVERAGE.find((c) => c.id === id);
    check(cov?.status === 'behavioral', `${id} is recorded as behavioural`);
    check((cov?.tests ?? []).includes('tests/motors.relays.mts'), `${id} names this file as its proof`);
    // The claim that was previously untrue.
    check(/coil/i.test(cov?.note ?? ''), `${id} says the coil is what moves the contacts`);
    check(/flyback/i.test(cov?.note ?? ''), `${id} says flyback is not modelled`);
  }
}

console.log(
  failures === 0
    ? `\nRelay checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
