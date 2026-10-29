// Circuits with no board at all: a battery, wires and parts, solved the way
// they would behave on a bench.
//
// Each project is built the way the editor builds one and run through the
// same circuit binding the simulator uses, with no microcontroller — then
// through the simulation controller, to prove the live preview and Run both
// work on a canvas with nothing to compile.

import { CircuitBinding, emptyControls, type ComponentVisualState } from '../src/simulation/circuitSim';
import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject } from '../src/project/templates';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import { pinAbsolute } from '../src/canvas/geometry';
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
const defOf = (id: string) => COMPONENT_DEFINITIONS.find((d) => d.id === id)!;

interface Bench {
  project: CircuitProject;
  add(definitionId: string, properties?: Record<string, unknown>, at?: { x: number; y: number }): ComponentInstance;
  wire(a: ComponentInstance, ap: string, b: ComponentInstance, bp: string): void;
}
function bench(): Bench {
  const project = emptyProject('bench');
  return {
    project,
    add(definitionId, properties = {}, at = { x: 0, y: 0 }) {
      const inst: ComponentInstance = { id: uid('c'), definitionId, x: at.x, y: at.y, rotation: 0, properties, simulationState: {} };
      project.componentInstances.push(inst);
      return inst;
    },
    wire(a, ap, b, bp) {
      project.connections.push({
        id: uid('w'), sourceComponentId: a.id, sourcePinId: ap, targetComponentId: b.id, targetPinId: bp,
        netId: '', color: '#000', points: [], routing: 'smooth',
      } as CircuitProject['connections'][number]);
    },
  };
}

function solve(b: Bench, setup?: (c: ReturnType<typeof emptyControls>) => void, settleMs = 0) {
  const binding = new CircuitBinding(b.project, null);
  const controls = emptyControls();
  setup?.(controls);
  let out = binding.update(controls);
  for (let t = 0; t < settleMs; t += 10) {
    binding.advanceClock(10);
    out = binding.update(controls);
  }
  return { binding, visuals: out.visuals, levels: out.netLevels };
}
const led = (v: Map<string, ComponentVisualState>, inst: ComponentInstance) => v.get(inst.id) ?? {};

/** 9 V battery (+) → resistor → LED anode, LED cathode → battery (−). */
function batteryLed(opts: { ohms?: number | null; flipped?: boolean; color?: string } = {}) {
  const b = bench();
  const bat = b.add('comp.battery-9v');
  const l = b.add('comp.led', opts.color ? { color: opts.color } : {});
  const [anode, cathode] = opts.flipped ? ['cathode', 'anode'] : ['anode', 'cathode'];
  if (opts.ohms === null) {
    b.wire(bat, 'plus', l, anode);
  } else {
    const r = b.add('comp.resistor', { resistance: opts.ohms ?? 330 });
    b.wire(bat, 'plus', r, 'p1');
    b.wire(r, 'p2', l, anode);
  }
  b.wire(l, cathode, bat, 'minus');
  return { b, bat, l };
}

section('9 V battery, 330 Ω, red LED');
{
  const { b, l, bat } = batteryLed();
  const { visuals } = solve(b);
  const v = led(visuals, l);
  check(v.ledOn === true, 'the LED lights');
  check(Math.abs((v.currentMa ?? 0) - 20.2) < 0.5, `with about 20 mA through it (${v.currentMa?.toFixed(1)} mA)`);
  check((v.brightness ?? 0) > 0.95, `at full brightness (${v.brightness?.toFixed(2)})`);
  check(!v.burnt && !v.fault, 'and nothing is wrong');
  check(!led(visuals, bat).fault, 'the battery is not shorted');
}

section('the same circuit with the LED flipped');
{
  const { b, l } = batteryLed({ flipped: true });
  const v = led(solve(b).visuals, l);
  check(v.ledOn !== true, 'the LED stays off');
  check((v.currentMa ?? 1) < 0.001, `with no current (${v.currentMa?.toExponential(1)} mA)`);
  check(!v.burnt, 'and it is not damaged — reverse at 9 V is within what the model treats as safe');
}

section('the same circuit with no resistor');
{
  const { b, l } = batteryLed({ ohms: null });
  const v = led(solve(b).visuals, l);
  check(v.burnt === true, `the LED burns out (${v.currentMa?.toFixed(0)} mA)`);
  check(v.ledOn !== true, 'and is dark');
  check(/Burned out/.test(v.fault ?? '') && /resistor/.test(v.fault ?? ''), `and says why and what to do ("${v.fault}")`);
}

section('a burned-out LED stays burned out until the circuit changes');
{
  const { b, l } = batteryLed({ ohms: null });
  const { binding } = solve(b);
  const again = binding.update(emptyControls()).visuals;
  check(led(again, l).burnt === true, 'solving the same circuit again: still burned out');
  const fixed = batteryLed();
  check(led(solve(fixed.b).visuals, fixed.l).burnt !== true, 'a rebuilt circuit with a resistor has a working LED');
}

section('brightness follows current');
{
  const r1 = batteryLed({ ohms: 330 });
  const r2 = batteryLed({ ohms: 10_000 });
  const r3 = batteryLed({ ohms: 1_000_000 });
  const b1 = led(solve(r1.b).visuals, r1.l).brightness ?? 0;
  const b2 = led(solve(r2.b).visuals, r2.l).brightness ?? 0;
  const b3 = led(solve(r3.b).visuals, r3.l).brightness ?? 0;
  check(b1 > b2 && b2 > b3, `330 Ω > 10 kΩ > 1 MΩ (${b1.toFixed(2)}, ${b2.toFixed(2)}, ${b3.toFixed(3)})`);
  // A modern LED really does glow faintly at a few microamps.
  check(b3 < 0.05, `through a megohm it barely glows (${b3.toFixed(3)})`);
}

section('a blue LED needs more voltage than a red one');
{
  const b = bench();
  const cells = b.add('comp.battery-aa'); // 3 V
  const r = b.add('comp.resistor', { resistance: 100 });
  const red = b.add('comp.led', { color: 'red' });
  const blue = b.add('comp.led', { color: 'blue' });
  b.wire(cells, 'plus', r, 'p1');
  b.wire(r, 'p2', red, 'anode');
  b.wire(red, 'cathode', cells, 'minus');
  const b2 = bench();
  const cells2 = b2.add('comp.battery-aa');
  const r2 = b2.add('comp.resistor', { resistance: 100 });
  const blue2 = b2.add('comp.led', { color: 'blue' });
  b2.wire(cells2, 'plus', r2, 'p1');
  b2.wire(r2, 'p2', blue2, 'anode');
  b2.wire(blue2, 'cathode', cells2, 'minus');
  void blue;
  check(led(solve(b).visuals, red).ledOn === true, '3 V lights a red LED');
  check(led(solve(b2).visuals, blue2).ledOn !== true, 'but not a blue one through a resistor');
}

section('on a breadboard: battery on the rails, resistor and LED in the strips');
{
  const b = bench();
  const board = b.add('comp.breadboard-half', {}, { x: 0, y: 0 });
  const bbDef = defOf('comp.breadboard-half');
  const hole = (id: string) => pinAbsolute(board, bbDef, bbDef.pins.find((p) => p.id === id)!);
  /** Places a part so the given pin sits exactly in the given hole. */
  const placeAt = (definitionId: string, pinId: string, holeId: string, props: Record<string, unknown> = {}) => {
    const d = defOf(definitionId);
    const pin = d.pins.find((p) => p.id === pinId)!;
    const h = hole(holeId);
    return b.add(definitionId, props, { x: h.x - pin.x, y: h.y - pin.y });
  };
  const bat = b.add('comp.battery-9v', {}, { x: -200, y: 0 });
  b.wire(bat, 'plus', board, 'rail-top-plus-1');
  b.wire(bat, 'minus', board, 'rail-top-minus-1');
  // Jumper from the + rail into column 3; the resistor spans columns 3 to 7.
  b.wire(board, 'rail-top-plus-3', board, 'a3');
  const r = placeAt('comp.resistor', 'p1', 'c3', { resistance: 330 });
  // The LED's anode in column 7 with the resistor, its cathode in column 8.
  const l = placeAt('comp.led', 'anode', 'e7');
  b.wire(board, 'a8', board, 'rail-top-minus-8');

  const { visuals, binding } = solve(b);
  const graph = (binding as unknown as { graph: { seated: Map<string, string> } }).graph;
  const seatOf = (inst: ComponentInstance, pin: string) => graph.seated.get(`${inst.id}:${pin}`)?.split(':')[1];
  check(seatOf(r, 'p1') === 'c3', `the resistor's first leg is in c3 (${seatOf(r, 'p1')})`);
  check(seatOf(r, 'p2') === 'c7', `its second leg bends into c7 (${seatOf(r, 'p2')})`);
  check(seatOf(l, 'anode') === 'e7' && seatOf(l, 'cathode') === 'e8', `the LED sits in e7 and e8 (${seatOf(l, 'anode')}, ${seatOf(l, 'cathode')})`);
  const v = led(visuals, l);
  check(v.ledOn === true, `and the LED lights (${v.currentMa?.toFixed(1)} mA)`);

  // Across the centre channel a strip is a different net.
  const b2 = bench();
  const board2 = b2.add('comp.breadboard-half');
  const bat2 = b2.add('comp.battery-9v', {}, { x: -200, y: 0 });
  b2.wire(bat2, 'plus', board2, 'e5');
  b2.wire(bat2, 'minus', board2, 'j9');
  const r2 = b2.add('comp.resistor', { resistance: 330 });
  const l2 = b2.add('comp.led', {}, { x: -400, y: 0 });
  b2.wire(board2, 'f5', r2, 'p1'); // other side of the channel from the battery
  b2.wire(r2, 'p2', l2, 'anode');
  b2.wire(l2, 'cathode', board2, 'g9');
  check(led(solve(b2).visuals, l2).ledOn !== true, 'a strip does not cross the centre channel: e5 and f5 are not connected');
}

section('an open circuit');
{
  const b = bench();
  const bat = b.add('comp.battery-9v');
  const r = b.add('comp.resistor', { resistance: 330 });
  const l = b.add('comp.led');
  b.wire(bat, 'plus', r, 'p1');
  b.wire(r, 'p2', l, 'anode');
  const v = led(solve(b).visuals, l);
  check(v.ledOn !== true && !v.burnt, 'with the cathode unwired: off, no current, no crash');
}

section('parts with no source at all');
{
  const b = bench();
  const r = b.add('comp.resistor');
  const l = b.add('comp.led');
  b.wire(r, 'p2', l, 'anode');
  const { visuals, binding } = solve(b);
  check(led(visuals, l).ledOn !== true, 'floating: the LED is simply off');
  check(binding.electrical.voltages.size === 0, 'and no net is given a made-up voltage');
}

section('a short across the battery');
{
  const b = bench();
  const bat = b.add('comp.battery-9v');
  b.wire(bat, 'plus', bat, 'minus');
  const v = led(solve(b).visuals, bat);
  check(/Short circuit/.test(v.fault ?? ''), `the battery warns of a short ("${v.fault}")`);
  check(Number.isFinite(v.currentMa ?? NaN), `and the current is a real number (${((v.currentMa ?? 0) / 1000).toFixed(1)} A), not infinity`);
}

section('a switch in the loop');
{
  const b = bench();
  const bat = b.add('comp.battery-9v');
  const sw = b.add('comp.toggle-switch');
  const r = b.add('comp.resistor', { resistance: 330 });
  const l = b.add('comp.led');
  b.wire(bat, 'plus', sw, 'com');
  b.wire(sw, 'no', r, 'p1');
  b.wire(r, 'p2', l, 'anode');
  b.wire(l, 'cathode', bat, 'minus');
  check(led(solve(b).visuals, l).ledOn !== true, 'switch off: dark');
  check(led(solve(b, (c) => c.toggleStates.set(sw.id, true)).visuals, l).ledOn === true, 'switch on: lit');
}

section('a push button in the loop');
{
  const b = bench();
  const bat = b.add('comp.battery-9v');
  const btn = b.add('comp.push-button');
  const r = b.add('comp.resistor', { resistance: 330 });
  const l = b.add('comp.led');
  b.wire(bat, 'plus', btn, '1a');
  b.wire(btn, '2a', r, 'p1');
  b.wire(r, 'p2', l, 'anode');
  b.wire(l, 'cathode', bat, 'minus');
  check(led(solve(b).visuals, l).ledOn !== true, 'released: dark');
  check(led(solve(b, (c) => c.pressedButtons.add(btn.id)).visuals, l).ledOn === true, 'held: lit');
}

section('a potentiometer as a dimmer');
{
  const b = bench();
  const bat = b.add('comp.battery-9v');
  const pot = b.add('comp.potentiometer', { resistance: 10_000 });
  const r = b.add('comp.resistor', { resistance: 330 });
  const l = b.add('comp.led');
  b.wire(bat, 'plus', pot, 't1');
  b.wire(pot, 'wiper', r, 'p1');
  b.wire(r, 'p2', l, 'anode');
  b.wire(l, 'cathode', bat, 'minus');
  const at = (pos: number) => led(solve(b, (c) => c.potPositions.set(pot.id, pos)).visuals, l);
  const full = at(0);
  const half = at(0.5);
  const most = at(0.95);
  check((full.currentMa ?? 0) > (half.currentMa ?? 0) && (half.currentMa ?? 0) > (most.currentMa ?? 0),
    `turning the knob changes the current (${full.currentMa?.toFixed(1)} → ${half.currentMa?.toFixed(2)} → ${most.currentMa?.toFixed(2)} mA)`);
  check((full.brightness ?? 0) > (most.brightness ?? 0), 'and the brightness');
}

section('a buzzer and a motor on a battery');
{
  const b = bench();
  const bat = b.add('comp.battery-9v');
  const bz = b.add('comp.buzzer');
  b.wire(bat, 'plus', bz, 'plus');
  b.wire(bz, 'minus', bat, 'minus');
  check(solve(b).visuals.get(bz.id)?.buzzerOn === true, 'the buzzer sounds');
  const b2 = bench();
  const bat2 = b2.add('comp.battery-9v');
  const bz2 = b2.add('comp.buzzer');
  b2.wire(bat2, 'plus', bz2, 'minus');
  b2.wire(bz2, 'plus', bat2, 'minus');
  check(solve(b2).visuals.get(bz2.id)?.buzzerOn !== true, 'reversed, its driver does not run');

  const b3 = bench();
  const cells = b3.add('comp.battery-aa');
  const m = b3.add('comp.dc-motor');
  b3.wire(cells, 'plus', m, 'm1');
  b3.wire(m, 'm2', cells, 'minus');
  const run = solve(b3, undefined, 500);
  const motor = run.binding.motorFor(m.id);
  check(motor?.isTurning === true && motor.direction === 'forward', `the motor spins up on its own clock (${motor?.direction}, ${(motor?.magnitude ?? 0).toFixed(2)})`);
}

section('LEDs in series share the current');
{
  const b = bench();
  const bat = b.add('comp.battery-9v');
  const r = b.add('comp.resistor', { resistance: 330 });
  const l1 = b.add('comp.led');
  const l2 = b.add('comp.led', { color: 'green' });
  b.wire(bat, 'plus', r, 'p1');
  b.wire(r, 'p2', l1, 'anode');
  b.wire(l1, 'cathode', l2, 'anode');
  b.wire(l2, 'cathode', bat, 'minus');
  const v = solve(b).visuals;
  const i1 = led(v, l1).currentMa ?? 0;
  const i2 = led(v, l2).currentMa ?? 0;
  check(led(v, l1).ledOn === true && led(v, l2).ledOn === true, 'both light');
  check(Math.abs(i1 - i2) < 0.01 && i1 < 15, `with the same, smaller current (${i1.toFixed(1)} mA each)`);
}

section('the simulation controller: no board needed');
{
  const { b, l } = batteryLed();
  simulationController.previewCircuit(b.project);
  const store = useSimulationStore.getState();
  check(store.circuitLive === true, 'the circuit is live without pressing Run');
  check(useSimulationStore.getState().visuals[l.id]?.ledOn === true, 'and the LED is lit in the published frame');
  const ok = await simulationController.start();
  check(ok && useSimulationStore.getState().status === 'running', 'Run on a canvas with no board runs the circuit');
  simulationController.advance(20);
  simulationController.publishNow();
  check(useSimulationStore.getState().visuals[l.id]?.ledOn === true, 'and the LED stays lit while running');
  simulationController.pause();
  check(useSimulationStore.getState().status === 'paused', 'pause works');
  await simulationController.reset();
  check(useSimulationStore.getState().status === 'paused', 'reset works');
  simulationController.stop();
  check(useSimulationStore.getState().status === 'stopped' && useSimulationStore.getState().circuitLive, 'stop returns to the live circuit');
  check(useSimulationStore.getState().visuals[l.id]?.ledOn === true, 'which still shows the LED lit');
  simulationController.closeProject();
  check(!useSimulationStore.getState().circuitLive, 'closing the project ends it');
}

console.log(`\n--- ${failures} failing`);
process.exit(failures ? 1 : 0);
