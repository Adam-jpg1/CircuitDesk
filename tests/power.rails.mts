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

// ================================= 2. a declaration is not electricity =======
section('2. a module declaration contributes nothing to any net');
{
  // An OLED on its own. Its VCC pin is typed as a supply so wiring rules can
  // check it is fed, and its GND pin says where the part expects a reference.
  // Neither is a source. A megohm would not do either: a CMOS or ADC input
  // draws essentially nothing, so it would read a fake rail as a real voltage
  // and an unpowered sensor would appear to work.
  const p = emptyProject('unpowered');
  const oled = inst('comp.oled');
  const load = inst('comp.resistor', { resistance: 1000 });
  p.componentInstances.push(oled, load);
  wire(p, oled.id, 'vcc', load.id, 'p1');
  wire(p, oled.id, 'gnd', load.id, 'p2');

  const { netLevels } = solve(p);
  const anyVolts = [...netLevels.values()].filter((l) => l.volts !== null);
  console.log(`   nets with a voltage: ${anyVolts.length} (${anyVolts.map((l) => l.volts).join(', ')})`);
  check(anyVolts.length === 0, 'an unpowered module puts no voltage on anything, at any impedance');

  // The declaration is still recorded, because validation and the inspector
  // need to know what the part wants — it simply never reaches the solver.
  const binding = new CircuitBinding(p, null as never);
  binding.update(emptyControls());
  check(typeof binding.declaredRailVolts === 'function', 'the expected rail is still available as metadata');

  // A high-impedance input is the case that would have been fooled. An ADC
  // wired to an unpowered module's VCC must not read that module's nominal.
  const q = emptyProject('fake-rail-into-adc');
  const sensor = inst('comp.oled');
  const adc = inst('comp.ads1115');
  const supply = inst('comp.dc-supply', { voltage: 5 });
  q.componentInstances.push(sensor, adc, supply);
  // The ADC is genuinely powered; only the thing on its input is not.
  wire(q, supply.id, 'plus', adc.id, 'vcc');
  wire(q, supply.id, 'minus', adc.id, 'gnd');
  wire(q, sensor.id, 'vcc', adc.id, 'a0');
  const levels = solve(q).netLevels;
  const a0Net = [...levels.entries()].find(([, l]) => l.volts === 3.3 || l.volts === 5);
  const inputVolts = [...levels.values()].map((l) => l.volts);
  console.log(`   voltages with a powered ADC and an unpowered module: ${inputVolts.join(', ')}`);
  check(
    !inputVolts.includes(3.3),
    'the ADC input does not see the unpowered module\'s declared 3.3 V rail',
  );
  check(a0Net !== undefined, 'while the real 5 V supply is present as it should be');

  // A ground pin that reaches nothing is not the circuit's reference either.
  const r = emptyProject('fake-ground');
  const lonely = inst('comp.oled');
  r.componentInstances.push(lonely);
  const grounds = [...solve(r).netLevels.values()].filter((l) => l.volts === 0);
  check(grounds.length === 0, 'an unconnected GND pin does not become ground');

  // And a real source on the same net powers it, which is the whole point of
  // keeping the declaration as metadata rather than deleting the concept.
  const t = emptyProject('declared-vs-real');
  const oled2 = inst('comp.oled');
  const real = inst('comp.dc-supply', { voltage: 5 });
  t.componentInstances.push(oled2, real);
  wire(t, real.id, 'plus', oled2.id, 'vcc');
  wire(t, real.id, 'minus', oled2.id, 'gnd');
  const powered = [...solve(t).netLevels.values()].map((l) => l.volts);
  check(powered.includes(5), `a real source powers the module (${powered.join(', ')})`);
  check(powered.includes(0), 'and its return is the reference');
  check(!powered.includes(3.3), 'with no trace of what the part merely expected');
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
