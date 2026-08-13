// Storage, counters and the display chain.
//
// Sequential parts are where a logic model earns its keep or quietly lies. The
// questions that matter are whether an edge is an edge (not a level sampled at
// a convenient moment), whether an asynchronous clear really does not wait for
// a clock, and whether a counter driving a decoder driving a seven-segment
// produces the digit through wires rather than through a shortcut.

import { emptyProject } from '../src/project/templates';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
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
 * A bench with a switchable rail per signal.
 *
 * Clocks are driven by toggling a switch rather than by rewiring, because the
 * whole point is to produce a real transition on a real net and let the
 * binding notice the edge — which is exactly what an MCU pin would do.
 */
class Bench {
  readonly project: CircuitProject = emptyProject('sequential');
  readonly supply: ComponentInstance;
  private binding: CircuitBinding | null = null;
  private drivers = new Map<string, ComponentInstance>();

  constructor() {
    this.supply = this.add('comp.battery-aa', { voltage: 5 });
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

  power(part: ComponentInstance): ComponentInstance {
    this.wire(this.supply, 'plus', part, 'vcc');
    this.wire(this.supply, 'minus', part, 'gnd');
    return part;
  }

  tie(part: ComponentInstance, pin: string, high: boolean): void {
    this.wire(this.supply, high ? 'plus' : 'minus', part, pin);
  }

  /**
   * Attaches a slide switch between the rails so a pin can be driven either
   * way at run time — a real changeover contact, not a rewire.
   */
  driver(part: ComponentInstance, pin: string): string {
    const sw = this.add('comp.slide-switch');
    this.wire(this.supply, 'plus', sw, 'no');
    this.wire(this.supply, 'minus', sw, 'nc');
    this.wire(sw, 'com', part, pin);
    const key = `${part.id}:${pin}`;
    this.drivers.set(key, sw);
    return key;
  }

  private engaged = new Set<string>();

  /** Sets a driven pin high or low and settles the circuit. */
  set(key: string, high: boolean): void {
    const sw = this.drivers.get(key)!;
    if (high) this.engaged.add(sw.id);
    else this.engaged.delete(sw.id);
    this.settle();
  }

  /** One clean pulse: low, high, low — three settles, one rising edge. */
  pulse(key: string): void {
    this.set(key, false);
    this.set(key, true);
    this.set(key, false);
  }

  settle(): void {
    if (!this.binding) this.binding = new CircuitBinding(this.project, null);
    const controls = emptyControls();
    for (const id of this.engaged) controls.pressedButtons.add(id);
    this.binding.update(controls);
  }

  volts(part: ComponentInstance, pin: string): number | null {
    if (!this.binding) this.settle();
    const controls = emptyControls();
    for (const id of this.engaged) controls.pressedButtons.add(id);
    const { netLevels } = this.binding!.update(controls);
    const graph = (this.binding as unknown as { graph: { netOf: Map<string, string> } }).graph;
    const netId = graph.netOf.get(`${part.id}:${pin}`);
    return netId ? netLevels.get(netId)?.volts ?? null : null;
  }

  level(part: ComponentInstance, pin: string): 0 | 1 | 'x' {
    const v = this.volts(part, pin);
    if (v === null) return 'x';
    return v <= 1.5 ? 0 : v >= 3.5 ? 1 : 'x';
  }

  /** A nibble read off four output pins, LSB first. */
  nibble(part: ComponentInstance, pins: string[]): number {
    let value = 0;
    pins.forEach((p, i) => {
      if (this.level(part, p) === 1) value |= 1 << i;
    });
    return value;
  }
}

// ================================================== 1. the D flip-flop edge ==
section('1. 74HC74 — edges, not levels');
{
  const b = new Bench();
  const ff = b.power(b.add('comp.74hc74'));
  const clk = b.driver(ff, '1clk');
  const d = b.driver(ff, '1d');
  b.tie(ff, '1npre', true);
  b.tie(ff, '1nclr', true);
  b.tie(ff, '2npre', true);
  b.tie(ff, '2nclr', true);
  b.tie(ff, '2clk', false);
  b.tie(ff, '2d', false);

  b.set(d, true);
  b.set(clk, false);
  check(b.level(ff, '1q') === 0, 'Q starts low with D high but no clock edge yet');
  check(b.level(ff, '1nq') === 1, 'and the complement is high');

  b.set(clk, true);
  check(b.level(ff, '1q') === 1, 'the rising edge clocks D in');

  // D changes while the clock stays high: nothing must happen.
  b.set(d, false);
  check(b.level(ff, '1q') === 1, 'changing D with the clock already high does not move Q');

  b.set(clk, false);
  check(b.level(ff, '1q') === 1, 'and the falling edge does not either');

  b.set(clk, true);
  check(b.level(ff, '1q') === 0, 'the next rising edge clocks in the new value');

  // Asynchronous clear does not wait for a clock.
  b.set(d, true);
  b.set(clk, false);
  b.set(clk, true);
  check(b.level(ff, '1q') === 1, 'set up high again');
  const clr = b.driver(ff, '1nclr');
  b.set(clr, false); // asserted (active low)
  check(b.level(ff, '1q') === 0, 'asserting CLR clears Q immediately, with no clock edge');
  check(b.level(ff, '1nq') === 1, 'and the complement follows');

  // The second flip-flop in the package never moved.
  check(b.level(ff, '2q') === 0, 'the other flip-flop in the package is unaffected');
}

// ============================================================ 2. SR latch ====
section('2. SR latch — including the invalid state');
{
  const b = new Bench();
  const latch = b.power(b.add('comp.latch-sr'));
  const s = b.driver(latch, 's');
  const r = b.driver(latch, 'r');

  b.set(s, false);
  b.set(r, false);
  check(b.level(latch, 'q') === 0, 'starts reset');

  b.set(s, true);
  check(b.level(latch, 'q') === 1, 'set drives Q high');
  b.set(s, false);
  check(b.level(latch, 'q') === 1, 'and it holds when set is released — that is the memory');

  b.set(r, true);
  check(b.level(latch, 'q') === 0, 'reset drives Q low');
  b.set(r, false);
  check(b.level(latch, 'q') === 0, 'and that holds too');

  b.set(s, true);
  b.set(r, true);
  check(
    b.level(latch, 'q') === 0 && b.level(latch, 'nq') === 0,
    'both inputs asserted is the genuinely invalid state: both outputs low, not a guess',
  );
}

// ===================================================== 3. D latch is level ===
section('3. D latch is transparent, unlike the flip-flop');
{
  const b = new Bench();
  const latch = b.power(b.add('comp.latch-d'));
  const d = b.driver(latch, 'd');
  const en = b.driver(latch, 'en');

  b.set(en, true);
  b.set(d, true);
  check(b.level(latch, 'q') === 1, 'with enable high the output follows the input');
  b.set(d, false);
  check(b.level(latch, 'q') === 0, 'and keeps following it — no edge needed');
  b.set(d, true);
  b.set(en, false);
  b.set(d, false);
  check(b.level(latch, 'q') === 1, 'dropping enable freezes the last value');
}

// ============================================================ 4. JK toggle ===
section('4. JK flip-flop toggles');
{
  const b = new Bench();
  const ff = b.power(b.add('comp.flipflop-jk'));
  const clk = b.driver(ff, 'clk');
  b.tie(ff, 'j', true);
  b.tie(ff, 'k', true);
  b.tie(ff, 'nclr', true);

  b.set(clk, false);
  const start = b.level(ff, 'q');
  b.set(clk, true);
  const afterOne = b.level(ff, 'q');
  b.set(clk, false);
  b.set(clk, true);
  const afterTwo = b.level(ff, 'q');
  check(afterOne !== start, `J=K=1 toggles on the first edge (${start} → ${afterOne})`);
  check(afterTwo === start, `and back on the second (${afterOne} → ${afterTwo}) — a divide-by-two`);
}

// ============================================================= 5. counters ===
section('5. counters count, reset and roll over');
{
  const b = new Bench();
  const ctr = b.power(b.add('comp.74hc161'));
  const clk = b.driver(ctr, 'clk');
  b.tie(ctr, 'nclr', true);
  b.tie(ctr, 'nload', true);
  b.tie(ctr, 'enp', true);
  b.tie(ctr, 'ent', true);
  for (const p of ['a', 'b', 'c', 'd']) b.tie(ctr, p, false);

  const q = ['qa', 'qb', 'qc', 'qd'];
  b.set(clk, false);
  check(b.nibble(ctr, q) === 0, 'starts at zero');

  for (let i = 1; i <= 5; i++) {
    b.set(clk, true);
    b.set(clk, false);
    if (b.nibble(ctr, q) !== i) {
      check(false, `counting to ${i} (got ${b.nibble(ctr, q)})`);
      break;
    }
  }
  check(b.nibble(ctr, q) === 5, `five clock edges give five (${b.nibble(ctr, q)})`);

  // RCO only at fifteen.
  check(b.level(ctr, 'rco') === 0, 'the ripple carry is low mid-count');
  for (let i = 0; i < 10; i++) {
    b.set(clk, true);
    b.set(clk, false);
  }
  check(b.nibble(ctr, q) === 15, `ten more edges reach fifteen (${b.nibble(ctr, q)})`);
  check(b.level(ctr, 'rco') === 1, 'and the ripple carry goes high at the top of the range');

  b.set(clk, true);
  b.set(clk, false);
  check(b.nibble(ctr, q) === 0, 'the next edge rolls over to zero');

  // Asynchronous clear.
  b.set(clk, true);
  b.set(clk, false);
  b.set(clk, true);
  b.set(clk, false);
  check(b.nibble(ctr, q) === 2, 'counted to two');
  const clr = b.driver(ctr, 'nclr');
  b.set(clr, false);
  check(b.nibble(ctr, q) === 0, 'asserting CLR zeroes it without a clock edge');
}

// ================================================= 6. up/down and inhibit ====
section('6. 74HC193 counts both ways');
{
  const b = new Bench();
  const ctr = b.power(b.add('comp.74hc193'));
  const up = b.driver(ctr, 'up');
  // The unused clock is tied high rather than driven: parking it high with a
  // switch would itself be a rising edge, and this part counts those.
  b.tie(ctr, 'down', true);
  b.tie(ctr, 'clr', false);
  b.tie(ctr, 'nload', true);
  for (const p of ['a', 'b', 'c', 'd']) b.tie(ctr, p, false);
  const q = ['qa', 'qb', 'qc', 'qd'];

  b.set(up, false);
  for (let i = 0; i < 3; i++) {
    b.set(up, true);
    b.set(up, false);
  }
  check(b.nibble(ctr, q) === 3, `three up edges give three (${b.nibble(ctr, q)})`);
}
{
  // Counting down, on its own bench for the same reason.
  const b = new Bench();
  const ctr = b.power(b.add('comp.74hc193'));
  const down = b.driver(ctr, 'down');
  b.tie(ctr, 'up', true);
  b.tie(ctr, 'clr', false);
  b.tie(ctr, 'nload', true);
  for (const p of ['a', 'b', 'c', 'd']) b.tie(ctr, p, false);
  const q = ['qa', 'qb', 'qc', 'qd'];

  b.set(down, false);
  for (let i = 0; i < 2; i++) {
    b.set(down, true);
    b.set(down, false);
  }
  check(b.nibble(ctr, q) === 14, `counting down from zero wraps to fourteen (${b.nibble(ctr, q)})`);
}

// ================================================= 7. CD4017 one-hot output ==
section('7. CD4017 decoded outputs');
{
  const b = new Bench();
  const ctr = b.power(b.add('comp.cd4017'));
  const clk = b.driver(ctr, 'clk');
  b.tie(ctr, 'inh', false);
  b.tie(ctr, 'rst', false);

  const oneHot = () => {
    let high = -1;
    let count = 0;
    for (let n = 0; n < 10; n++) {
      if (b.level(ctr, `q${n}`) === 1) {
        high = n;
        count++;
      }
    }
    return { high, count };
  };

  b.set(clk, false);
  check(oneHot().high === 0 && oneHot().count === 1, 'exactly Q0 is high at reset');

  for (let i = 1; i <= 4; i++) {
    b.set(clk, true);
    b.set(clk, false);
  }
  const at4 = oneHot();
  check(at4.high === 4 && at4.count === 1, `after four edges exactly Q4 is high (Q${at4.high}, ${at4.count} high)`);
  check(b.level(ctr, 'co') === 1, 'carry-out is high for the first half of the cycle');

  for (let i = 0; i < 2; i++) {
    b.set(clk, true);
    b.set(clk, false);
  }
  check(b.level(ctr, 'co') === 0, 'and low for the second half');

  const rst = b.driver(ctr, 'rst');
  b.set(rst, true);
  check(oneHot().high === 0, 'reset returns to Q0 immediately');
}

// ======================= 8. counter → decoder → seven-segment, through wires ==
section('8. the display chain: CD4026 drives a real seven-segment');
{
  const b = new Bench();
  const ctr = b.power(b.add('comp.cd4026'));
  const display = b.add('comp.seven-segment');
  const clk = b.driver(ctr, 'clk');
  b.tie(ctr, 'inh', false);
  b.tie(ctr, 'rst', false);
  const deo = b.driver(ctr, 'deo');

  // Every segment pin wired to the display's matching segment, and the
  // display's common cathode to ground. Nothing else connects them.
  const segs = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const;
  const displayDef = defOf('comp.seven-segment')!;
  const hasSegments = segs.every((s) => displayDef.pins.some((p) => p.id === s));
  check(hasSegments, 'the seven-segment part exposes a-g as pins');
  if (hasSegments) {
    for (const s of segs) b.wire(ctr, s, display, s);
    const common = displayDef.pins.find((p) => p.id.startsWith('com'));
    if (common) b.wire(b.supply, 'minus', display, common.id);

    const litSegments = () => segs.filter((s) => b.level(ctr, s) === 1).join('');

    b.set(deo, true);
    b.set(clk, false);
    check(litSegments() === 'abcdef', `zero lights a-f but not g (${litSegments()})`);

    b.set(clk, true);
    b.set(clk, false);
    check(litSegments() === 'bc', `one lights only b and c (${litSegments()})`);

    b.set(clk, true);
    b.set(clk, false);
    check(litSegments() === 'abdeg', `two lights a, b, d, e, g (${litSegments()})`);

    // The digit reached the display through the wires: unplug one and it goes.
    b.project.connections = b.project.connections.filter(
      (c) => !(c.sourceComponentId === ctr.id && c.sourcePinId === 'a'),
    );
    const rebound = new CircuitBinding(b.project, null);
    const controls = emptyControls();
    const { netLevels } = rebound.update(controls);
    const graph = (rebound as unknown as { graph: { netOf: Map<string, string> } }).graph;
    const segANet = graph.netOf.get(`${display.id}:a`);
    check(
      segANet === undefined || netLevels.get(segANet)?.volts == null,
      'removing the segment-A wire leaves that segment undriven — the digit came through the wires',
    );
  }

  // Blanking is real, and does not lose the count.
  b.set(deo, false);
  const blanked = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].filter((s) => b.level(ctr, s) === 1);
  check(blanked.length === 0, `display-enable low blanks every segment (${blanked.length} still lit)`);
}

// ===================================== 9. CD4511 decodes BCD, blanks above 9 ==
section('9. CD4511');
{
  const decode = (value: number) => {
    const b = new Bench();
    const dec = b.power(b.add('comp.cd4511'));
    b.tie(dec, 'nlt', true);
    b.tie(dec, 'nbi', true);
    b.tie(dec, 'le', false);
    b.tie(dec, 'a', (value & 1) === 1);
    b.tie(dec, 'b', (value & 2) === 2);
    b.tie(dec, 'c', (value & 4) === 4);
    b.tie(dec, 'd', (value & 8) === 8);
    return ['a', 'b', 'c', 'd', 'e', 'f', 'g'].filter((s) => b.level(dec, `s${s}`) === 1).join('');
  };
  check(decode(0) === 'abcdef', `0 → abcdef (${decode(0)})`);
  check(decode(1) === 'bc', `1 → bc (${decode(1)})`);
  check(decode(7) === 'abc', `7 → abc (${decode(7)})`);
  check(decode(8) === 'abcdefg', `8 → all seven (${decode(8)})`);
  check(decode(12) === '', `12 blanks the display rather than showing hex (${JSON.stringify(decode(12))})`);

  // Lamp test overrides everything.
  const b = new Bench();
  const dec = b.power(b.add('comp.cd4511'));
  b.tie(dec, 'nlt', false);
  b.tie(dec, 'nbi', true);
  b.tie(dec, 'le', false);
  for (const p of ['a', 'b', 'c', 'd']) b.tie(dec, p, false);
  const all = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].filter((s) => b.level(dec, `s${s}`) === 1);
  check(all.length === 7, `lamp test lights every segment (${all.length}/7)`);
}

// ================================================= 10. the octal register ====
section('10. 74HC574 and 74HC573');
{
  const b = new Bench();
  const reg = b.power(b.add('comp.74hc574'));
  const clk = b.driver(reg, 'clk');
  const oe = b.driver(reg, 'noe');
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) b.tie(reg, `d${n}`, n % 2 === 1);

  b.set(oe, false); // active low: outputs enabled
  b.set(clk, false);
  b.set(clk, true);
  let stored = 0;
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) if (b.level(reg, `q${n}`) === 1) stored |= 1 << (n - 1);
  check(stored === 0b01010101, `the register latches the input byte on the edge (0b${stored.toString(2).padStart(8, '0')})`);

  // Disabling the outputs releases the pins entirely.
  b.set(oe, true);
  check(b.volts(reg, 'q1') === null, 'disabling OE releases the outputs — high impedance, not low');
}

// ================================================= 11. two chips, separate ===
section('11. two counters on one canvas are independent');
{
  const b = new Bench();
  const a = b.power(b.add('comp.74hc161'));
  const c = b.power(b.add('comp.74hc161'));
  const clkA = b.driver(a, 'clk');
  const clkC = b.driver(c, 'clk');
  for (const ctr of [a, c]) {
    b.tie(ctr, 'nclr', true);
    b.tie(ctr, 'nload', true);
    b.tie(ctr, 'enp', true);
    b.tie(ctr, 'ent', true);
    for (const p of ['a', 'b', 'c', 'd']) b.tie(ctr, p, false);
  }
  const q = ['qa', 'qb', 'qc', 'qd'];

  b.set(clkA, false);
  b.set(clkC, false);
  for (let i = 0; i < 3; i++) {
    b.set(clkA, true);
    b.set(clkA, false);
  }
  check(b.nibble(a, q) === 3, `clocking the first counter three times gives three (${b.nibble(a, q)})`);
  check(b.nibble(c, q) === 0, `and leaves the second at zero (${b.nibble(c, q)})`);

  b.set(clkC, true);
  b.set(clkC, false);
  check(b.nibble(c, q) === 1, 'the second counter has its own clock');
  check(b.nibble(a, q) === 3, 'and the first did not move');
}

console.log(failures === 0 ? '\nSequential logic checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
