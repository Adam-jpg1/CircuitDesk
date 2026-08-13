// Digital logic, through actual circuit nets.
//
// The easy version of this test asks the evaluator for a truth table, which
// proves the arithmetic and nothing else. What matters is that a gate wired to
// a rail reads that rail, drives its output onto a wire, and that a second
// gate downstream sees it — so almost everything here goes through
// CircuitBinding and checks resolved net voltages.

import { emptyProject } from '../src/project/templates';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import { LOGIC_PARTS } from '../src/simulation/devices/logicParts';
import { andOf, orOf, xorOf, notOf, tristate, schmitt, levelOf } from '../src/simulation/devices/logicIc';
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

/**
 * A bench: one 5V supply, one ground, and whatever parts a test adds.
 *
 * Rails come from a battery rather than a board so these tests exercise the
 * logic without needing firmware — the parts are powered the same way they
 * would be from a board's 5V pin.
 */
class Bench {
  readonly project: CircuitProject = emptyProject('logic');
  readonly supply: ComponentInstance;
  private binding: CircuitBinding | null = null;

  constructor() {
    this.supply = this.add('comp.battery-aa');
    this.project.componentInstances = [this.supply];
    // A 5V rail: the AA cell part is the supply model, set to 5V.
    this.supply.properties = { voltage: 5 };
  }

  add(definitionId: string, properties: Record<string, unknown> = {}): ComponentInstance {
    const inst: ComponentInstance = {
      id: uid('u'), definitionId, x: 0, y: 0, rotation: 0, properties, simulationState: {},
    };
    this.project.componentInstances.push(inst);
    this.binding = null;
    return inst;
  }

  wire(a: ComponentInstance, ap: string, b: ComponentInstance, bp: string): void {
    this.project.connections.push({
      id: uid('w'), sourceComponentId: a.id, sourcePinId: ap, targetComponentId: b.id, targetPinId: bp,
      netId: '', color: '#e8590c', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
    this.binding = null;
  }

  /** Powers a logic part from the bench rails. */
  power(part: ComponentInstance): ComponentInstance {
    this.wire(this.supply, 'plus', part, 'vcc');
    this.wire(this.supply, 'minus', part, 'gnd');
    return part;
  }

  /** Ties a pin high or low through the rails. */
  tie(part: ComponentInstance, pin: string, high: boolean): void {
    this.wire(this.supply, high ? 'plus' : 'minus', part, pin);
  }

  /** Solves and returns the resolved voltage on a part's pin, or null. */
  volts(part: ComponentInstance, pin: string): number | null {
    if (!this.binding) this.binding = new CircuitBinding(this.project, null);
    const { netLevels } = this.binding.update(emptyControls());
    const graph = (this.binding as unknown as { graph: { netOf: Map<string, string> } }).graph;
    const netId = graph.netOf.get(`${part.id}:${pin}`);
    if (!netId) return null;
    return netLevels.get(netId)?.volts ?? null;
  }

  /** The logic level on a pin, resolved against a 5V supply. */
  level(part: ComponentInstance, pin: string): 0 | 1 | 'x' {
    const v = this.volts(part, pin);
    if (v === null) return 'x';
    if (v <= 1.5) return 0;
    if (v >= 3.5) return 1;
    return 'x';
  }

  /** Solves twice, so sequential parts see one clock transition. */
  settle(): void {
    if (!this.binding) this.binding = new CircuitBinding(this.project, null);
    this.binding.update(emptyControls());
  }
}

// ================================================ 1. gate algebra, directly ==
section('1. the algebra propagates uncertainty rather than swallowing it');
{
  check(andOf([1, 1]) === 1 && andOf([1, 0]) === 0, 'AND of definite inputs is definite');
  check(andOf([0, 'x']) === 0, 'AND with a zero is zero even if the other input is unknown');
  check(andOf([1, 'x']) === 'x', 'but AND with a one and an unknown is unknown');
  check(orOf([1, 'x']) === 1, 'OR with a one is one regardless');
  check(orOf([0, 'x']) === 'x', 'and OR with a zero and an unknown is unknown');
  check(xorOf([1, 'x']) === 'x', 'XOR cannot decide with any unknown input');
  check(notOf('x') === 'x', 'NOT of unknown is unknown, not one');
  check(tristate(1, 0, true) === 1 && tristate(1, 1, true) === 'z', 'an active-low enable releases the output');
  check(tristate(1, 'x', false) === 'z', 'an unknown enable releases rather than guesses');
  check(levelOf(null, 5) === 'x', 'an undriven net is unknown');
  check(levelOf(4.8, 5) === 1 && levelOf(0.2, 5) === 0, 'clear voltages resolve');
  check(levelOf(2.5, 5) === 'x', 'and a mid-rail voltage is genuinely indeterminate');

  // Hysteresis: the same voltage gives different answers depending on history.
  check(schmitt(2.6, 5, 0) === 0, 'rising through 2.6V has not yet crossed the upper threshold');
  check(schmitt(2.6, 5, 1) === 1, 'but falling through 2.6V has not yet crossed the lower one');
  check(schmitt(3.5, 5, 0) === 1 && schmitt(1.5, 5, 1) === 0, 'and the thresholds do trip');
}

// ============================================= 2. a gate through real wires ==
section('2. a 74HC08 wired to rails');
{
  const b = new Bench();
  const ic = b.power(b.add('comp.74hc08'));
  b.tie(ic, '1a', true);
  b.tie(ic, '1b', true);
  b.tie(ic, '2a', true);
  b.tie(ic, '2b', false);
  b.tie(ic, '3a', false);
  b.tie(ic, '3b', false);

  check(b.level(ic, '1y') === 1, `gate 1: HIGH AND HIGH drives its output high (${b.volts(ic, '1y')}V)`);
  check(b.level(ic, '2y') === 0, `gate 2: HIGH AND LOW drives low (${b.volts(ic, '2y')}V)`);
  check(b.level(ic, '3y') === 0, 'gate 3: LOW AND LOW drives low');
  // Gate 4's inputs are not wired at all.
  check(b.level(ic, '4y') === 'x', 'gate 4: unwired inputs leave the output undriven, not low');
}

// =========================================== 3. every gate in every package ==
section('3. all four gates in each quad package, on their datasheet pins');
{
  const cases: { id: string; fn: (a: boolean, bb: boolean) => boolean }[] = [
    { id: 'comp.74hc00', fn: (a, bb) => !(a && bb) },
    { id: 'comp.74hc02', fn: (a, bb) => !(a || bb) },
    { id: 'comp.74hc08', fn: (a, bb) => a && bb },
    { id: 'comp.74hc32', fn: (a, bb) => a || bb },
    { id: 'comp.74hc86', fn: (a, bb) => a !== bb },
  ];
  for (const { id, fn } of cases) {
    let wrong = 0;
    let tested = 0;
    for (const [av, bv] of [[false, false], [false, true], [true, false], [true, true]] as const) {
      const b = new Bench();
      const ic = b.power(b.add(id));
      for (const n of [1, 2, 3, 4]) {
        b.tie(ic, `${n}a`, av);
        b.tie(ic, `${n}b`, bv);
      }
      for (const n of [1, 2, 3, 4]) {
        tested++;
        const expected = fn(av, bv) ? 1 : 0;
        if (b.level(ic, `${n}y`) !== expected) wrong++;
      }
    }
    check(wrong === 0, `${id}: all four gates correct across the truth table (${tested - wrong}/${tested})`);
  }

  // The hex inverter, all six.
  const b = new Bench();
  const ic = b.power(b.add('comp.74hc04'));
  for (const n of [1, 2, 3, 4, 5, 6]) b.tie(ic, `${n}a`, n % 2 === 0);
  let ok = 0;
  for (const n of [1, 2, 3, 4, 5, 6]) if (b.level(ic, `${n}y`) === (n % 2 === 0 ? 0 : 1)) ok++;
  check(ok === 6, `74HC04: all six inverters correct (${ok}/6)`);
}

// ================================================ 4. power is not optional ==
section('4. an unpowered part does nothing');
{
  const b = new Bench();
  const ic = b.add('comp.74hc08'); // deliberately not powered
  b.tie(ic, '1a', true);
  b.tie(ic, '1b', true);
  check(b.level(ic, '1y') === 'x', 'a 74HC08 with no Vcc drives nothing at all');

  const b2 = new Bench();
  const ic2 = b2.add('comp.74hc08');
  b2.wire(b2.supply, 'plus', ic2, 'vcc'); // Vcc but no ground
  b2.tie(ic2, '1a', true);
  b2.tie(ic2, '1b', true);
  check(b2.level(ic2, '1y') === 'x', 'and one with Vcc but no ground does nothing either');
}

// =================================================== 5. two chips, separate ==
section('5. two identical packages are independent');
{
  const b = new Bench();
  const a = b.power(b.add('comp.74hc08'));
  const c = b.power(b.add('comp.74hc08'));
  b.tie(a, '1a', true); b.tie(a, '1b', true);
  b.tie(c, '1a', true); b.tie(c, '1b', false);
  check(b.level(a, '1y') === 1, 'the first chip drives high');
  check(b.level(c, '1y') === 0, 'the second drives low from its own inputs');
  check(b.volts(a, '1y') !== b.volts(c, '1y'), 'two instances of the same part do not share state');
}

// =========================================== 6. gates chained through a net ==
section('6. one gate feeding another');
{
  const b = new Bench();
  const and = b.power(b.add('comp.74hc08'));
  const inv = b.power(b.add('comp.74hc04'));
  b.tie(and, '1a', true);
  b.tie(and, '1b', true);
  // AND output feeds the inverter's input through a wire.
  b.wire(and, '1y', inv, '1a');

  check(b.level(and, '1y') === 1, 'the AND gate drives its output high');
  check(b.level(inv, '1y') === 0, 'and the inverter downstream of it drives low — the chain settled');

  // Three deep, to prove the fixed point is not one pass.
  const or = b.power(b.add('comp.74hc32'));
  b.wire(inv, '1y', or, '1a');
  b.tie(or, '1b', false);
  check(b.level(or, '1y') === 0, 'a third stage settles in the same solve');
}

// ================================================= 7. tri-state and the bus ==
section('7. high-Z is a released wire, not a low one');
{
  // Two buffers driving one wire, enabled in turn.
  const b = new Bench();
  const buf = b.power(b.add('comp.74hc125'));
  const sink = b.power(b.add('comp.74hc04'));

  b.tie(buf, '1a', true);   // buffer 1 would drive high
  b.tie(buf, '2a', false);  // buffer 2 would drive low
  b.wire(buf, '1y', sink, '1a');
  b.wire(buf, '2y', sink, '1a'); // both outputs on one bus

  // A drives, B released.
  b.tie(buf, '1oe', false); // active low: enabled
  b.tie(buf, '2oe', true);  // disabled
  check(b.level(sink, '1a') === 1, 'the enabled buffer owns the bus');
  check(b.level(sink, '1y') === 0, 'and the part downstream sees it');
}
{
  // The other way round, on a fresh bench so the enables differ.
  const b = new Bench();
  const buf = b.power(b.add('comp.74hc125'));
  const sink = b.power(b.add('comp.74hc04'));
  b.tie(buf, '1a', true);
  b.tie(buf, '2a', false);
  b.wire(buf, '1y', sink, '1a');
  b.wire(buf, '2y', sink, '1a');
  b.tie(buf, '1oe', true);  // disabled
  b.tie(buf, '2oe', false); // enabled
  check(b.level(sink, '1a') === 0, 'releasing one and enabling the other hands the bus over');
}
{
  // Both released: the wire floats. Not low.
  const b = new Bench();
  const buf = b.power(b.add('comp.74hc125'));
  const sink = b.power(b.add('comp.74hc04'));
  b.tie(buf, '1a', true);
  b.tie(buf, '2a', false);
  b.wire(buf, '1y', sink, '1a');
  b.wire(buf, '2y', sink, '1a');
  b.tie(buf, '1oe', true);
  b.tie(buf, '2oe', true);
  check(b.volts(sink, '1a') === null, 'with every driver released the bus is floating, not pulled low');
  check(b.level(sink, '1y') === 'x', 'so what reads it cannot decide');
}
{
  // Both enabled and disagreeing: contention.
  const b = new Bench();
  const buf = b.power(b.add('comp.74hc125'));
  b.tie(buf, '1a', true);
  b.tie(buf, '2a', false);
  b.wire(buf, '1y', buf, '2y'); // outputs tied together
  b.tie(buf, '1oe', false);
  b.tie(buf, '2oe', false);
  const binding = new CircuitBinding(b.project, null);
  const { netLevels } = binding.update(emptyControls());
  const contended = [...netLevels.values()].some((l) => l.conflict);
  check(contended, 'two enabled drivers disagreeing on one wire is reported as contention');
}

// ================================================= 8. the transceiver's DIR ==
section('8. 74HC245 direction');
{
  const b = new Bench();
  const xcvr = b.power(b.add('comp.74hc245'));
  const sink = b.power(b.add('comp.74hc04'));
  b.tie(xcvr, 'noe', false); // enabled
  b.tie(xcvr, 'dir', true);  // A drives B
  b.tie(xcvr, 'a1', true);
  b.wire(xcvr, 'b1', sink, '1a');
  check(b.level(sink, '1a') === 1, 'with DIR high the A side drives the B side');

  const b2 = new Bench();
  const x2 = b2.power(b2.add('comp.74hc245'));
  const s2 = b2.power(b2.add('comp.74hc04'));
  b2.tie(x2, 'noe', false);
  b2.tie(x2, 'dir', false); // B drives A
  b2.tie(x2, 'b1', true);
  b2.wire(x2, 'a1', s2, '1a');
  check(b2.level(s2, '1a') === 1, 'and with DIR low the B side drives the A side');

  const b3 = new Bench();
  const x3 = b3.power(b3.add('comp.74hc245'));
  const s3 = b3.power(b3.add('comp.74hc04'));
  b3.tie(x3, 'noe', true); // disabled
  b3.tie(x3, 'dir', true);
  b3.tie(x3, 'a1', true);
  b3.wire(x3, 'b1', s3, '1a');
  check(b3.volts(s3, '1a') === null, 'a disabled transceiver releases both sides');
}

// ==================================================== 9. decoders and muxes ==
section('9. decoders and multiplexers');
{
  // 74HC138: one output low at a time, and only when all enables agree.
  for (const select of [0, 3, 7]) {
    const b = new Bench();
    const dec = b.power(b.add('comp.74hc138'));
    b.tie(dec, 'g1', true);
    b.tie(dec, 'ng2a', false);
    b.tie(dec, 'ng2b', false);
    b.tie(dec, 'a', (select & 1) === 1);
    b.tie(dec, 'b', (select & 2) === 2);
    b.tie(dec, 'c', (select & 4) === 4);
    let lows = 0;
    let selectedLow = false;
    for (let n = 0; n < 8; n++) {
      const level = b.level(dec, `y${n}`);
      if (level === 0) lows++;
      if (n === select && level === 0) selectedLow = true;
    }
    check(selectedLow && lows === 1, `74HC138 select ${select}: exactly Y${select} is low (${lows} low)`);
  }
  {
    const b = new Bench();
    const dec = b.power(b.add('comp.74hc138'));
    b.tie(dec, 'g1', false); // disabled
    b.tie(dec, 'ng2a', false);
    b.tie(dec, 'ng2b', false);
    b.tie(dec, 'a', true); b.tie(dec, 'b', true); b.tie(dec, 'c', true);
    let highs = 0;
    for (let n = 0; n < 8; n++) if (b.level(dec, `y${n}`) === 1) highs++;
    check(highs === 8, `a disabled 74HC138 holds every output high (${highs}/8)`);
  }

  // 74HC151: the selected input reaches the output.
  {
    const b = new Bench();
    const mux = b.power(b.add('comp.74hc151'));
    b.tie(mux, 'ng', false);
    for (let n = 0; n < 8; n++) b.tie(mux, `d${n}`, n === 5);
    b.tie(mux, 'a', true);  // 5 = 101
    b.tie(mux, 'b', false);
    b.tie(mux, 'c', true);
    check(b.level(mux, 'y') === 1, 'the 74HC151 passes the selected input');
    check(b.level(mux, 'ny') === 0, 'and its complement');
  }
  {
    const b = new Bench();
    const mux = b.power(b.add('comp.74hc151'));
    b.tie(mux, 'ng', false);
    for (let n = 0; n < 8; n++) b.tie(mux, `d${n}`, n === 5);
    b.tie(mux, 'a', false); b.tie(mux, 'b', true); b.tie(mux, 'c', false); // select 2
    check(b.level(mux, 'y') === 0, 'selecting a different input passes that one instead');
  }

  // 74HC157: one select swings all four channels.
  {
    const b = new Bench();
    const mux = b.power(b.add('comp.74hc157'));
    b.tie(mux, 'ne', false);
    b.tie(mux, 'sel', false);
    for (const n of [1, 2, 3, 4]) {
      b.tie(mux, `${n}a`, true);
      b.tie(mux, `${n}b`, false);
    }
    let aSide = 0;
    for (const n of [1, 2, 3, 4]) if (b.level(mux, `${n}y`) === 1) aSide++;
    check(aSide === 4, `SEL low selects the A inputs on all four channels (${aSide}/4)`);
  }
}

// ===================================================== 10. adder, comparator ==
section('10. arithmetic');
{
  const vectors: [number, number, number][] = [[0, 0, 0], [3, 5, 0], [9, 6, 0], [15, 1, 0], [7, 8, 1], [15, 15, 1]];
  let wrong = 0;
  for (const [av, bv, cin] of vectors) {
    const b = new Bench();
    const add = b.power(b.add('comp.74hc283'));
    for (const n of [1, 2, 3, 4]) {
      b.tie(add, `a${n}`, ((av >> (n - 1)) & 1) === 1);
      b.tie(add, `b${n}`, ((bv >> (n - 1)) & 1) === 1);
    }
    b.tie(add, 'c0', cin === 1);
    let sum = 0;
    for (const n of [1, 2, 3, 4]) if (b.level(add, `s${n}`) === 1) sum |= 1 << (n - 1);
    const carry = b.level(add, 'c4') === 1 ? 1 : 0;
    const expected = av + bv + cin;
    if (sum !== (expected & 0xf) || carry !== ((expected >> 4) & 1)) {
      wrong++;
      console.log(`   ${av}+${bv}+${cin}: got ${sum} carry ${carry}, expected ${expected & 0xf} carry ${(expected >> 4) & 1}`);
    }
  }
  check(wrong === 0, `74HC283 adds correctly across ${vectors.length} vectors including carries`);

  // 74HC85 comparator, including the cascade tie-break.
  const compare = (av: number, bv: number, cascade: 'gt' | 'lt' | 'eq') => {
    const b = new Bench();
    const cmp = b.power(b.add('comp.74hc85'));
    for (let n = 0; n < 4; n++) {
      b.tie(cmp, `a${n}`, ((av >> n) & 1) === 1);
      b.tie(cmp, `b${n}`, ((bv >> n) & 1) === 1);
    }
    b.tie(cmp, 'agtbin', cascade === 'gt');
    b.tie(cmp, 'altbin', cascade === 'lt');
    b.tie(cmp, 'aeqbin', cascade === 'eq');
    return { gt: b.level(cmp, 'agtb'), lt: b.level(cmp, 'altb'), eq: b.level(cmp, 'aeqb') };
  };
  const bigger = compare(9, 4, 'eq');
  check(bigger.gt === 1 && bigger.lt === 0 && bigger.eq === 0, '74HC85: 9 > 4');
  const smaller = compare(2, 11, 'eq');
  check(smaller.lt === 1 && smaller.gt === 0, '74HC85: 2 < 11');
  const equal = compare(6, 6, 'eq');
  check(equal.eq === 1 && equal.gt === 0 && equal.lt === 0, '74HC85: 6 = 6 with the cascade saying equal');
  const tieBroken = compare(6, 6, 'gt');
  check(tieBroken.gt === 1 && tieBroken.eq === 0, 'and an equal word defers to the cascade input');
}

// ==================================== 11. the library is wired to the model ==
section('11. package pinouts match the models');
{
  let mismatches = 0;
  for (const [id, spec] of Object.entries(LOGIC_PARTS)) {
    const def = defOf(id);
    if (!def) {
      check(false, `${id} has a component definition`);
      continue;
    }
    const defPins = new Set(def.pins.map((p) => p.id));
    const modelPins = new Set(spec.pins.map((p) => p.id));
    for (const p of modelPins) if (!defPins.has(p)) mismatches++;
    for (const p of defPins) if (!modelPins.has(p)) mismatches++;
    if (def.simulationAdapterId !== 'sim.logic') mismatches++;
  }
  check(mismatches === 0, `every logic part's pins match its model exactly (${Object.keys(LOGIC_PARTS).length} parts, ${mismatches} mismatches)`);

  // Vcc and GND on every one, or it could not be powered.
  const missingRails = Object.keys(LOGIC_PARTS).filter((id) => {
    const def = defOf(id);
    return !def || !def.pins.some((p) => p.id === 'vcc') || !def.pins.some((p) => p.id === 'gnd');
  });
  check(missingRails.length === 0, `every logic part has power pins${missingRails.length ? `: ${missingRails.join(', ')}` : ''}`);
}

console.log(failures === 0 ? '\nLogic gate checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
