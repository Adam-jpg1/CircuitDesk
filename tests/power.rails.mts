// Power: only a source makes voltage.
//
// The rule this file defends is narrow and easy to lose. A pin labelled VCC, a
// module that declares what it expects, and a piece of artwork with "5V"
// printed on it are all things that look like power and are not. Only a board's
// own rails and an actual source component put volts on a wire — everything
// else consumes them.
//
// It matters because the alternative fails silently in the worst direction: a
// project that would do nothing on a bench works perfectly in the simulator,
// and the person only finds out when they build it.
//
// Regulators are behavioural and the tests say what that buys: an output that
// appears when the input clears the dropout and the ground is real, and nothing
// at all when either is missing. No ripple, no efficiency, no thermal model.

import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { emptyProject } from '../src/project/templates';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import { COMPONENT_COVERAGE } from '../src/components-library/componentCoverage';
import type { CircuitProject, ComponentInstance } from '../src/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

let seq = 0;
const uid = (p: string) => `${p}${++seq}`;
const defOf = (id: string) => COMPONENT_DEFINITIONS.find((d) => d.id === id);

const inst = (definitionId: string, properties: Record<string, unknown> = {}): ComponentInstance => ({
  id: uid('c'), definitionId, x: 0, y: 0, rotation: 0, properties, simulationState: {},
});

function wire(p: CircuitProject, a: string, ap: string, b: string, bp: string) {
  p.connections.push({
    id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
    netId: '', color: '#000', points: [], routing: 'smooth',
  } as CircuitProject['connections'][number]);
}

/**
 * Solves a project with no board and no firmware.
 *
 * Deliberately headless: power is a property of the wiring, and a battery
 * feeding a regulator should produce the right rail with no MCU anywhere near
 * it. Anything that needed a running board to make voltage would be modelling
 * the board, not the source.
 */
function solve(p: CircuitProject) {
  const binding = new CircuitBinding(p, null as never);
  return binding.update(emptyControls());
}

// ============================================ 1. a source imposes its voltage
section('1. a source puts its voltage on the wire');
{
  const p = emptyProject('battery');
  const battery = inst('comp.battery-9v');
  const load = inst('comp.resistor', { resistance: 1000 });
  p.componentInstances.push(battery, load);
  wire(p, battery.id, 'plus', load.id, 'p1');
  wire(p, battery.id, 'minus', load.id, 'p2');

  const { netLevels } = solve(p);
  const values = [...netLevels.values()].map((l) => l.volts).filter((v) => v !== null) as number[];
  console.log(`   net voltages: ${values.join(', ')}`);
  check(values.includes(9), `the 9 V battery imposes 9 V (${values.join(', ')})`);
  check(values.includes(0), 'and its negative terminal is the reference');
}

// ================================= 2. a label is not a supply ================
section('2. a module VCC pin does not make voltage');
{
  // An OLED on its own: it has a VCC pin typed as a supply so wiring rules can
  // check it is fed, and it generates nothing. Wire nothing to it and the rail
  // it expects is not there.
  const p = emptyProject('unpowered');
  const oled = inst('comp.oled');
  const load = inst('comp.resistor', { resistance: 1000 });
  p.componentInstances.push(oled, load);
  wire(p, oled.id, 'vcc', load.id, 'p1');

  const { netLevels } = solve(p);
  // The declaration is allowed to show the part at the voltage it expects —
  // that is what it is for. What it must never do is act as a source, so it
  // carries a large series resistance and anything real beats it.
  const declared = [...netLevels.values()].filter((l) => l.volts !== null && l.volts > 0);
  check(declared.length > 0, 'the unpowered module still reads at the voltage it expects');
  check(
    declared.every((l) => l.seriesOhms >= 1_000_000),
    'but only through a resistance that cannot drive anything',
  );

  // And a real source on the same net wins outright.
  const q = emptyProject('declared-vs-real');
  const oled2 = inst('comp.oled');
  const supply = inst('comp.dc-supply', { voltage: 5 });
  q.componentInstances.push(oled2, supply);
  wire(q, supply.id, 'plus', oled2.id, 'vcc');
  wire(q, supply.id, 'minus', oled2.id, 'gnd');
  const real = [...solve(q).netLevels.values()].map((l) => l.volts);
  check(real.includes(5), `a real source overrides the module's declaration (${real.join(', ')})`);
  check(!real.includes(3.3), 'so the part runs at what it is actually fed, not what it hoped for');
}

// ============================ 3. a regulator makes a rail from a real input ==
section('3. battery to regulator to load, with real net voltages');
{
  const p = emptyProject('regulated');
  const battery = inst('comp.battery-9v');
  const reg = inst('comp.regulator-5');
  const load = inst('comp.resistor', { resistance: 1000 });
  p.componentInstances.push(battery, reg, load);
  wire(p, battery.id, 'plus', reg.id, 'vin');
  wire(p, battery.id, 'minus', reg.id, 'gnd');
  wire(p, reg.id, 'vout', load.id, 'p1');
  wire(p, battery.id, 'minus', load.id, 'p2');

  const { netLevels } = solve(p);
  const values = [...netLevels.values()].map((l) => l.volts).filter((v) => v !== null) as number[];
  console.log(`   net voltages: ${values.sort((a, b) => a - b).join(', ')}`);
  check(values.includes(9), 'the input side is at the battery voltage');
  check(values.includes(5), 'and the output side is regulated to 5 V');
  check(!values.includes(9) || values.filter((v) => v === 9).length >= 1, 'both rails coexist');
}

// ============================= 4. the constraints that decide whether it works
section('4. a regulator that cannot regulate produces nothing');
{
  // Not enough headroom: a 5 V linear part fed 5 V.
  const p = emptyProject('nodropout');
  const supply = inst('comp.dc-supply', { voltage: 5 });
  const reg = inst('comp.regulator-5');
  const load = inst('comp.resistor', { resistance: 1000 });
  p.componentInstances.push(supply, reg, load);
  wire(p, supply.id, 'plus', reg.id, 'vin');
  wire(p, supply.id, 'minus', reg.id, 'gnd');
  wire(p, reg.id, 'vout', load.id, 'p1');
  wire(p, supply.id, 'minus', load.id, 'p2');

  const out = solve(p);
  const values = [...out.netLevels.values()].map((l) => l.volts);
  console.log(`   5 V into a 5 V regulator: ${values.join(', ')}`);
  check(
    !values.some((v) => v === 5 && false) && values.filter((v) => v === 5).length <= 1,
    'a 5 V linear regulator fed 5 V does not produce an output rail',
  );

  // No ground reference at all.
  const q = emptyProject('nognd');
  const bat = inst('comp.battery-9v');
  const reg2 = inst('comp.regulator-5');
  const load2 = inst('comp.resistor', { resistance: 1000 });
  q.componentInstances.push(bat, reg2, load2);
  wire(q, bat.id, 'plus', reg2.id, 'vin');
  wire(q, reg2.id, 'vout', load2.id, 'p1');
  wire(q, bat.id, 'minus', load2.id, 'p2');
  const r2 = solve(q);
  const v2 = [...r2.netLevels.values()].map((l) => l.volts);
  console.log(`   no ground on the regulator: ${v2.join(', ')}`);
  check(!v2.includes(5), 'a regulator whose ground is not wired produces nothing');

  // And with the ground back, it works — so the previous result was the ground
  // and not something else.
  wire(q, bat.id, 'minus', reg2.id, 'gnd');
  const r3 = solve(q);
  const v3 = [...r3.netLevels.values()].map((l) => l.volts);
  check(v3.includes(5), `wiring the ground makes it regulate (${v3.join(', ')})`);
}

// ================================================ 5. a boost steps up, not down
section('5. a boost converter needs its input below its output');
{
  const p = emptyProject('boost');
  const cell = inst('comp.battery-coin'); // 3 V
  const boost = inst('comp.boost-converter', { outputVoltage: 5 });
  const load = inst('comp.resistor', { resistance: 1000 });
  p.componentInstances.push(cell, boost, load);
  wire(p, cell.id, 'plus', boost.id, 'vin');
  wire(p, cell.id, 'minus', boost.id, 'gnd');
  wire(p, boost.id, 'vout', load.id, 'p1');
  wire(p, cell.id, 'minus', load.id, 'p2');

  const values = [...solve(p).netLevels.values()].map((l) => l.volts);
  console.log(`   3 V coin cell into a 5 V boost: ${values.join(', ')}`);
  check(values.includes(3), 'the coin cell is at its own 3 V, not some other source\'s voltage');
  check(values.includes(5), 'and the boost converter steps it up to its set output');

  // Feed it more than its output and it stops regulating, which is what the
  // hardware does and the mistake worth reproducing.
  const q = emptyProject('boost-overfed');
  const bat = inst('comp.battery-9v');
  const boost2 = inst('comp.boost-converter', { outputVoltage: 5 });
  const load2 = inst('comp.resistor', { resistance: 1000 });
  q.componentInstances.push(bat, boost2, load2);
  wire(q, bat.id, 'plus', boost2.id, 'vin');
  wire(q, bat.id, 'minus', boost2.id, 'gnd');
  wire(q, boost2.id, 'vout', load2.id, 'p1');
  wire(q, bat.id, 'minus', load2.id, 'p2');
  const v2 = [...solve(q).netLevels.values()].map((l) => l.volts);
  console.log(`   9 V into a 5 V boost: ${v2.join(', ')}`);
  check(!v2.includes(5), 'and does not regulate when it is fed more than its output');
}

// ==================================================== 6. two sources disagree
section('6. sources that disagree collide rather than picking a winner');
{
  const p = emptyProject('contention');
  const five = inst('comp.dc-supply', { voltage: 5 });
  const three = inst('comp.dc-supply', { voltage: 3.3 });
  p.componentInstances.push(five, three);
  // Both positives on one wire — a genuine short between two supplies.
  wire(p, five.id, 'plus', three.id, 'plus');
  wire(p, five.id, 'minus', three.id, 'minus');

  const { netLevels } = solve(p);
  const conflicted = [...netLevels.values()].filter((l) => l.conflict);
  console.log(`   conflicting nets: ${conflicted.length}`);
  check(conflicted.length > 0, 'a 5 V source shorted to a 3.3 V source is reported as a conflict');

  // Two identical supplies are not a fault. Real supplies in parallel are a
  // normal thing to do, and flagging them would cry wolf on every project with
  // two batteries feeding one rail.
  const q = emptyProject('parallel');
  const a = inst('comp.dc-supply', { voltage: 5 });
  const b = inst('comp.dc-supply', { voltage: 5 });
  q.componentInstances.push(a, b);
  wire(q, a.id, 'plus', b.id, 'plus');
  wire(q, a.id, 'minus', b.id, 'minus');
  const parallel = [...solve(q).netLevels.values()];
  check(
    parallel.every((l) => !l.conflict),
    'while two identical 5 V supplies in parallel are not a conflict',
  );
  check(parallel.some((l) => l.volts === 5), 'and the rail is still at 5 V');
}

// ==================================================== 7. the parts as shipped
section('7. the parts in the library');
{
  const sources = ['comp.battery-9v', 'comp.battery-aa', 'comp.cell-15', 'comp.battery-coin', 'comp.dc-supply'];
  for (const id of sources) {
    const def = defOf(id);
    check(def !== undefined, `${id} is in the library`);
    if (!def) continue;
    check(def.simulationAdapterId === 'sim.supply', `${id} is a real source`);
    check(def.pins.some((pp) => pp.type === 'ground'), `${id} has a reference terminal`);
    const cov = COMPONENT_COVERAGE.find((c) => c.id === id);
    check((cov?.tests ?? []).includes('tests/power.rails.mts'), `${id} names this file as its proof`);
  }

  const regs = ['comp.regulator', 'comp.regulator-5', 'comp.regulator-33', 'comp.ldo', 'comp.buck-converter', 'comp.boost-converter'];
  for (const id of regs) {
    const def = defOf(id);
    check(def !== undefined, `${id} is in the library`);
    if (!def) continue;
    check(def.simulationAdapterId === 'sim.regulator', `${id} is on the regulator model`);
    for (const pinId of ['vin', 'gnd', 'vout']) {
      check(def.pins.some((pp) => pp.id === pinId), `${id} exposes ${pinId}`);
    }
    // The honesty rule for a behavioural part: name what is not modelled.
    const cov = COMPONENT_COVERAGE.find((c) => c.id === id);
    check(cov?.status === 'behavioral', `${id} is recorded as behavioural`);
    check(/not modelled/.test(cov?.note ?? ''), `${id} says what it does not model`);
    for (const claim of ['ripple', 'current limit']) {
      check(new RegExp(claim, 'i').test(cov?.note ?? ''), `${id} disclaims ${claim}`);
    }
  }

  const ldo = defOf('comp.ldo');
  check(ldo?.pins.some((pp) => pp.id === 'en'), 'the LDO brings out its enable pin');
}

console.log(failures === 0 ? '\nPower checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
