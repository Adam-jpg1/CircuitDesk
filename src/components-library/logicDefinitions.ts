// Logic parts as canvas components.
//
// The pin list comes from the simulation spec rather than being retyped here,
// so a package can never be drawn with pins its model does not have. What this
// file adds is the physical part: the package outline, where the pins sit, the
// name people search for, and the description that says what it does.

import type { ComponentDefinition, PinDefinition, SupportLevel } from '../types';
import { MM, pinAt } from '../boards/pinHelpers';
import { LOGIC_PARTS } from '../simulation/devices/logicParts';
import type { LogicIcSpec } from '../simulation/devices/logicIc';

/** 2.54mm, the pin pitch every one of these packages uses. */
const PITCH = 2.54;

/**
 * A DIP package laid out from its real pin order.
 *
 * `order` is the datasheet's pin 1..N walk: down the left side and back up the
 * right, which is how the numbers are printed on the part. Passing it means a
 * user can wire from a datasheet pinout and have it match.
 */
function dip(
  spec: LogicIcSpec,
  name: string,
  order: string[],
  description: string,
  supportLevel: SupportLevel = 'simulated',
): ComponentDefinition {
  const perSide = order.length / 2;
  const widthMm = 7.62 + 2.2;
  const heightMm = perSide * PITCH + 2.0;
  const known = new Set(spec.pins.map((p) => p.id));
  const pins: PinDefinition[] = [];

  order.forEach((id, index) => {
    if (!known.has(id)) throw new Error(`${spec.id}: pinout names "${id}", which the model does not have`);
    const left = index < perSide;
    const row = left ? index : order.length - 1 - index;
    const x = left ? 1.1 : widthMm - 1.1;
    const y = 1.0 + (row + 0.5) * PITCH;
    const pinSpec = spec.pins.find((p) => p.id === id)!;
    pins.push(
      pinAt(
        {
          id,
          label: labelOf(id),
          number: String(index + 1),
          type: pinSpec.direction === 'power' ? 'power-5v' : pinSpec.direction === 'ground' ? 'ground' : 'digital',
          caps:
            pinSpec.direction === 'power'
              ? ['power']
              : pinSpec.direction === 'ground'
                ? ['ground']
                : pinSpec.direction === 'in'
                  ? ['digital-in']
                  : ['digital-out'],
        },
        x,
        y,
      ),
    );
  });

  // Every model pin must appear on the package, or the part would have
  // behaviour reachable through no wire.
  const placed = new Set(order);
  const missing = spec.pins.filter((p) => !placed.has(p.id));
  if (missing.length > 0) throw new Error(`${spec.id}: model pins not on the package: ${missing.map((p) => p.id).join(', ')}`);

  return {
    id: spec.id,
    name,
    category: 'Logic',
    widthMm,
    heightMm,
    artwork: { kind: 'builtin', builtinId: 'dip-ic' },
    pins,
    properties: [],
    validationRules: [],
    simulationAdapterId: 'sim.logic',
    supportLevel,
    description,
    isBoard: false,
  };
}

/** The printed label for a pin id, with overbars restored for active-low. */
function labelOf(id: string): string {
  if (id === 'vcc') return 'VCC';
  if (id === 'gnd') return 'GND';
  // Segment outputs are stored with an `s` prefix to keep them apart from BCD
  // inputs of the same letter; the package still prints the bare letter.
  const segment = /^s([a-g])$/.exec(id);
  if (segment) return segment[1];
  const activeLow = /^(\d?)n(.+)$/.exec(id);
  if (activeLow) return `${activeLow[1]}${activeLow[2].toUpperCase()}̅`;
  return id.toUpperCase();
}

/**
 * A discrete gate drawn as its schematic symbol rather than a package.
 *
 * People sketching logic want a gate, not a chip; people building a circuit
 * want the chip. Both exist, and they share one evaluator.
 */
function gateSymbol(
  spec: LogicIcSpec,
  name: string,
  shape: string,
  description: string,
): ComponentDefinition {
  const inputs = spec.pins.filter((p) => p.direction === 'in' && p.id !== 'oe');
  const widthMm = 16;
  const heightMm = 12;
  const pins: PinDefinition[] = [];
  inputs.forEach((p, i) => {
    const y = inputs.length === 1 ? heightMm / 2 : 3.5 + i * 5;
    pins.push(pinAt({ id: p.id, label: p.id.toUpperCase(), type: 'digital', caps: ['digital-in'] }, 0.4, y));
  });
  if (spec.pins.some((p) => p.id === 'oe')) {
    pins.push(pinAt({ id: 'oe', label: 'OE', type: 'digital', caps: ['digital-in'] }, widthMm / 2, 0.4));
  }
  pins.push(pinAt({ id: 'y', label: 'Y', type: 'digital', caps: ['digital-out'] }, widthMm - 0.4, heightMm / 2));
  pins.push(pinAt({ id: 'vcc', label: 'VCC', type: 'power-5v', caps: ['power'] }, widthMm * 0.35, heightMm - 0.4));
  pins.push(pinAt({ id: 'gnd', label: 'GND', type: 'ground', caps: ['ground'] }, widthMm * 0.65, heightMm - 0.4));

  return {
    id: spec.id,
    name,
    category: 'Logic',
    widthMm,
    heightMm,
    artwork: { kind: 'builtin', builtinId: `gate-${shape}` },
    pins,
    properties: [],
    validationRules: [],
    simulationAdapterId: 'sim.logic',
    supportLevel: 'simulated',
    description,
    isBoard: false,
  };
}

// ------------------------------------------------------------ discrete gates

export const GATE_DEFS: ComponentDefinition[] = [
  gateSymbol(LOGIC_PARTS['comp.gate-and'], 'AND gate', 'and', 'Two-input AND. Output is high only when both inputs are high; an undriven input makes the result unknown rather than low.'),
  gateSymbol(LOGIC_PARTS['comp.gate-or'], 'OR gate', 'or', 'Two-input OR. Output is high when either input is high.'),
  gateSymbol(LOGIC_PARTS['comp.gate-not'], 'NOT gate (inverter)', 'not', 'Inverter. Output is the opposite of the input.'),
  gateSymbol(LOGIC_PARTS['comp.gate-nand'], 'NAND gate', 'nand', 'Two-input NAND — AND followed by an inversion, and the gate every other gate can be built from.'),
  gateSymbol(LOGIC_PARTS['comp.gate-nor'], 'NOR gate', 'nor', 'Two-input NOR — OR followed by an inversion. A pair of these cross-coupled makes an SR latch.'),
  gateSymbol(LOGIC_PARTS['comp.gate-xor'], 'XOR gate', 'xor', 'Two-input exclusive OR. Output is high when exactly one input is high, which makes it the core of an adder.'),
  gateSymbol(LOGIC_PARTS['comp.gate-xnor'], 'XNOR gate', 'xnor', 'Two-input exclusive NOR — high when the inputs agree.'),
  gateSymbol(LOGIC_PARTS['comp.buffer-tristate'], 'Tri-state buffer', 'tristate', 'Buffer with an output enable. With OE low the output is genuinely disconnected from the wire — high impedance, not low — so several can share one bus.'),
  gateSymbol(LOGIC_PARTS['comp.schmitt-trigger'], 'Schmitt inverter', 'schmitt', 'Inverting Schmitt trigger. The switching threshold depends on which way the input is moving, so a slow or noisy edge produces one clean transition instead of several.'),
];

// -------------------------------------------------------------- 74xx and CD4

export const LOGIC_IC_DEFS: ComponentDefinition[] = [
  dip(
    LOGIC_PARTS['comp.74hc00'], '74HC00 (quad NAND)',
    ['1a', '1b', '1y', '2a', '2b', '2y', 'gnd', '3y', '3a', '3b', '4y', '4a', '4b', 'vcc'],
    'Four independent two-input NAND gates in one 14-pin package, with the standard 74HC00 pinout.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc02'], '74HC02 (quad NOR)',
    ['1y', '1a', '1b', '2y', '2a', '2b', 'gnd', '3a', '3b', '3y', '4a', '4b', '4y', 'vcc'],
    'Four two-input NOR gates. Note the outputs come first on this part — the 02 pinout is not the 00 pinout.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc04'], '74HC04 (hex inverter)',
    ['1a', '1y', '2a', '2y', '3a', '3y', 'gnd', '4y', '4a', '5y', '5a', '6y', '6a', 'vcc'],
    'Six inverters in one package.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc08'], '74HC08 (quad AND)',
    ['1a', '1b', '1y', '2a', '2b', '2y', 'gnd', '3y', '3a', '3b', '4y', '4a', '4b', 'vcc'],
    'Four two-input AND gates.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc14'], '74HC14 (hex Schmitt inverter)',
    ['1a', '1y', '2a', '2y', '3a', '3y', 'gnd', '4y', '4a', '5y', '5a', '6y', '6a', 'vcc'],
    'Six inverters with Schmitt-trigger inputs. Real hysteresis: the threshold moves depending on the direction of travel, which is what cleans up a slow RC edge or a bouncing switch.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc32'], '74HC32 (quad OR)',
    ['1a', '1b', '1y', '2a', '2b', '2y', 'gnd', '3y', '3a', '3b', '4y', '4a', '4b', 'vcc'],
    'Four two-input OR gates.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc86'], '74HC86 (quad XOR)',
    ['1a', '1b', '1y', '2a', '2b', '2y', 'gnd', '3y', '3a', '3b', '4y', '4a', '4b', 'vcc'],
    'Four two-input exclusive-OR gates.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc125'], '74HC125 (quad tri-state buffer)',
    ['1oe', '1a', '1y', '2oe', '2a', '2y', 'gnd', '3y', '3a', '3oe', '4y', '4a', '4oe', 'vcc'],
    'Four buffers with individual active-low output enables. A disabled output is high impedance, so several parts can drive one wire in turn.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc126'], '74HC126 (quad tri-state buffer)',
    ['1oe', '1a', '1y', '2oe', '2a', '2y', 'gnd', '3y', '3a', '3oe', '4y', '4a', '4oe', 'vcc'],
    'The 74HC125 with active-high enables.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc244'], '74HC244 (octal buffer)',
    [
      '1oe', '1a1', '2y4', '1a2', '2y3', '1a3', '2y2', '1a4', '2y1', 'gnd',
      '2a1', '1y4', '2a2', '1y3', '2a3', '1y2', '2a4', '1y1', '2oe', 'vcc',
    ],
    'Eight buffers in two independently enabled nibbles, for driving an address or data bus.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc245'], '74HC245 (octal transceiver)',
    [
      'dir', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'gnd',
      'b8', 'b7', 'b6', 'b5', 'b4', 'b3', 'b2', 'b1', 'noe', 'vcc',
    ],
    'Eight bidirectional buffers. DIR chooses which side drives; the other side releases the wire entirely.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc74'], '74HC74 (dual D flip-flop)',
    ['1nclr', '1d', '1clk', '1npre', '1q', '1nq', 'gnd', '2nq', '2q', '2npre', '2clk', '2d', '2nclr', 'vcc'],
    'Two D-type flip-flops with asynchronous preset and clear. Q follows D on the rising clock edge; preset and clear do not wait for a clock.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc573'], '74HC573 (octal latch)',
    [
      'noe', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'gnd',
      'le', 'q8', 'q7', 'q6', 'q5', 'q4', 'q3', 'q2', 'q1', 'vcc',
    ],
    'Eight transparent latches with tri-state outputs. Outputs follow the inputs while LE is high and hold when it falls.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc574'], '74HC574 (octal register)',
    [
      'noe', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'gnd',
      'clk', 'q8', 'q7', 'q6', 'q5', 'q4', 'q3', 'q2', 'q1', 'vcc',
    ],
    'Eight D flip-flops sharing a clock, with tri-state outputs. Edge triggered rather than transparent, which is the difference from the 573.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc161'], '74HC161 (4-bit counter)',
    ['nclr', 'clk', 'a', 'b', 'c', 'd', 'enp', 'gnd', 'nload', 'ent', 'qd', 'qc', 'qb', 'qa', 'rco', 'vcc'],
    'Synchronous 4-bit binary counter with parallel load and asynchronous clear. RCO goes high at fifteen so several can be cascaded.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc193'], '74HC193 (up/down counter)',
    ['b', 'qb', 'qa', 'down', 'up', 'qc', 'qd', 'gnd', 'd', 'c', 'nload', 'nco', 'nbo', 'clr', 'a', 'vcc'],
    'Four-bit counter with separate up and down clock inputs, parallel load and an asynchronous clear. Carry and borrow are active low.',
  ),
  dip(
    LOGIC_PARTS['comp.cd4017'], 'CD4017 (decade counter)',
    ['q5', 'q1', 'q0', 'q2', 'q6', 'q7', 'q3', 'gnd', 'q8', 'q4', 'q9', 'co', 'inh', 'clk', 'rst', 'vcc'],
    'Decade counter with ten decoded outputs — exactly one is high at a time, which is why it turns up in every chaser and sequencer.',
  ),
  dip(
    LOGIC_PARTS['comp.cd4026'], 'CD4026 (counter + 7-seg driver)',
    ['clk', 'inh', 'deo', 'a', 'b', 'c', 'd', 'gnd', 'e', 'f', 'g', 'ung', 'rst', 'co', 'vcc', 'vcc'].slice(0, 16),
    'Decade counter with a seven-segment decoder built in. Its segment pins are real outputs: wire them to a seven-segment display and the digit comes from the counter, not from a shortcut.',
  ),
  dip(
    LOGIC_PARTS['comp.cd4040'], 'CD4040 (12-stage ripple counter)',
    ['q12', 'q6', 'q5', 'q7', 'q4', 'q3', 'q2', 'gnd', 'q1', 'clk', 'rst', 'q9', 'q8', 'q10', 'q11', 'vcc'],
    'Twelve-stage binary ripple counter, clocked on the falling edge. Useful as a clock divider — each output is half the frequency of the one before it.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc138'], '74HC138 (3-to-8 decoder)',
    ['a', 'b', 'c', 'ng2a', 'ng2b', 'g1', 'y7', 'gnd', 'y6', 'y5', 'y4', 'y3', 'y2', 'y1', 'y0', 'vcc'],
    'Three address lines select one of eight active-low outputs. All three enables must agree, which is how several share one address bus.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc139'], '74HC139 (dual 2-to-4 decoder)',
    ['1ng', '1a', '1b', '1y0', '1y1', '1y2', '1y3', 'gnd', '2y3', '2y2', '2y1', '2y0', '2b', '2a', '2ng', 'vcc'],
    'Two independent two-to-four decoders, each with its own active-low enable.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc151'], '74HC151 (8-to-1 mux)',
    ['d3', 'd2', 'd1', 'd0', 'y', 'ny', 'ng', 'gnd', 'a', 'b', 'c', 'd7', 'd6', 'd5', 'd4', 'vcc'],
    'Eight inputs, three select lines, one output plus its complement.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc153'], '74HC153 (dual 4-to-1 mux)',
    ['1ng', 'b', '1c3', '1c2', '1c1', '1c0', '1y', 'gnd', '2y', '2c0', '2c1', '2c2', '2c3', 'a', '2ng', 'vcc'],
    'Two four-to-one multiplexers sharing one pair of select lines.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc157'], '74HC157 (quad 2-to-1 mux)',
    ['sel', '1a', '1b', '1y', '2a', '2b', '2y', 'gnd', '3y', '3b', '3a', '4y', '4b', '4a', 'ne', 'vcc'],
    'Four two-to-one multiplexers switched together — one select line chooses between two nibbles.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc283'], '74HC283 (4-bit adder)',
    ['s2', 'b2', 'a2', 's1', 'a1', 'b1', 'c0', 'gnd', 'c4', 's4', 'b4', 'a4', 's3', 'a3', 'b3', 'vcc'],
    'Four-bit binary full adder with carry in and carry out. Cascade C4 into the next chip’s C0 for wider sums.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc85'], '74HC85 (magnitude comparator)',
    [
      'b3', 'altbin', 'aeqbin', 'agtbin', 'agtb', 'aeqb', 'altb', 'gnd',
      'b0', 'a0', 'b1', 'a1', 'a2', 'b2', 'a3', 'vcc',
    ],
    'Compares two four-bit numbers and reports greater, equal or less. The cascade inputs decide ties, which is what makes wider comparators possible.',
  ),
  dip(
    LOGIC_PARTS['comp.cd4511'], 'CD4511 (BCD to 7-segment)',
    // Pins 1-16 as printed: BCD in on the left, segments out on the right.
    ['b', 'c', 'nlt', 'nbi', 'le', 'd', 'a', 'gnd', 'se', 'sd', 'sc', 'sb', 'sa', 'sg', 'sf', 'vcc'],
    'BCD input to seven-segment outputs, with a store latch, lamp test and blanking. Inputs above nine blank the display rather than showing hex — the behaviour that distinguishes a 4511 from a 7447.',
  ),
  dip(
    LOGIC_PARTS['comp.74hc164'], '74HC164 (8-bit shift register)',
    ['a', 'b', 'q1', 'q2', 'q3', 'q4', 'gnd', 'clk', 'nclr', 'q5', 'q6', 'q7', 'q8', 'vcc'],
    'Serial-in, parallel-out shift register with no output latch — the outputs ripple as bits shift through, which is the difference from a 74HC595.',
  ),
];

// -------------------------------------------------------- discrete storage

export const DISCRETE_LOGIC_DEFS: ComponentDefinition[] = [
  {
    id: 'comp.latch-sr',
    name: 'SR latch',
    category: 'Logic',
    widthMm: 18,
    heightMm: 14,
    artwork: { kind: 'builtin', builtinId: 'logic-block' },
    pins: [
      pinAt({ id: 's', label: 'S', caps: ['digital-in'] }, 0.4, 4),
      pinAt({ id: 'r', label: 'R', caps: ['digital-in'] }, 0.4, 10),
      pinAt({ id: 'q', label: 'Q', caps: ['digital-out'] }, 17.6, 4),
      pinAt({ id: 'nq', label: 'Q̅', caps: ['digital-out'] }, 17.6, 10),
      pinAt({ id: 'vcc', label: 'VCC', type: 'power-5v', caps: ['power'] }, 6, 13.6),
      pinAt({ id: 'gnd', label: 'GND', type: 'ground', caps: ['ground'] }, 12, 13.6),
    ],
    properties: [],
    validationRules: [],
    simulationAdapterId: 'sim.logic',
    supportLevel: 'simulated',
    description:
      'Set-reset latch built from cross-coupled NOR gates. Setting both inputs at once is the genuinely invalid state and both outputs go low, rather than the model picking a winner.',
    isBoard: false,
  },
  {
    id: 'comp.latch-d',
    name: 'D latch (transparent)',
    category: 'Logic',
    widthMm: 18,
    heightMm: 14,
    artwork: { kind: 'builtin', builtinId: 'logic-block' },
    pins: [
      pinAt({ id: 'd', label: 'D', caps: ['digital-in'] }, 0.4, 4),
      pinAt({ id: 'en', label: 'EN', caps: ['digital-in'] }, 0.4, 10),
      pinAt({ id: 'q', label: 'Q', caps: ['digital-out'] }, 17.6, 4),
      pinAt({ id: 'nq', label: 'Q̅', caps: ['digital-out'] }, 17.6, 10),
      pinAt({ id: 'vcc', label: 'VCC', type: 'power-5v', caps: ['power'] }, 6, 13.6),
      pinAt({ id: 'gnd', label: 'GND', type: 'ground', caps: ['ground'] }, 12, 13.6),
    ],
    properties: [],
    validationRules: [],
    simulationAdapterId: 'sim.logic',
    supportLevel: 'simulated',
    description: 'Transparent D latch: Q follows D while EN is high and holds the last value when EN falls.',
    isBoard: false,
  },
  {
    id: 'comp.flipflop-jk',
    name: 'JK flip-flop',
    category: 'Logic',
    widthMm: 18,
    heightMm: 18,
    artwork: { kind: 'builtin', builtinId: 'logic-block' },
    pins: [
      pinAt({ id: 'j', label: 'J', caps: ['digital-in'] }, 0.4, 4),
      pinAt({ id: 'clk', label: 'CLK', caps: ['digital-in'] }, 0.4, 9),
      pinAt({ id: 'k', label: 'K', caps: ['digital-in'] }, 0.4, 14),
      pinAt({ id: 'nclr', label: 'CLR̅', caps: ['digital-in'] }, 9, 0.4),
      pinAt({ id: 'q', label: 'Q', caps: ['digital-out'] }, 17.6, 5),
      pinAt({ id: 'nq', label: 'Q̅', caps: ['digital-out'] }, 17.6, 13),
      pinAt({ id: 'vcc', label: 'VCC', type: 'power-5v', caps: ['power'] }, 6, 17.6),
      pinAt({ id: 'gnd', label: 'GND', type: 'ground', caps: ['ground'] }, 12, 17.6),
    ],
    properties: [],
    validationRules: [],
    simulationAdapterId: 'sim.logic',
    supportLevel: 'simulated',
    description:
      'JK flip-flop clocked on the rising edge. J and K both high toggles the output, which is the case that separates it from a D type and makes it a divide-by-two.',
    isBoard: false,
  },
];

export const ALL_LOGIC_DEFS: ComponentDefinition[] = [
  ...GATE_DEFS,
  ...DISCRETE_LOGIC_DEFS,
  ...LOGIC_IC_DEFS,
];

export { MM };
