// The 74xx and CD4xxx library, as data.
//
// Every part here is a pin list and a function. That is deliberate: forty
// hand-written models would be forty different opinions about floating inputs,
// bus contention and clock-versus-reset ordering, and the interesting bugs
// would be in the disagreements rather than in any one part. The single
// evaluator in logicIc.ts owns those decisions; this file owns the datasheets.
//
// Pin names follow the datasheets, so a user reading a real pinout can wire
// from it. Where a datasheet uses an overbar for active-low, the id carries an
// `n` prefix (`noe`, `nclr`) and the printed label keeps the bar.

import {
  andOf,
  nandOf,
  norOf,
  notOf,
  orOf,
  schmitt,
  tristate,
  xorOf,
  xnorOf,
  type Logic,
  type LogicEvalContext,
  type LogicIcSpec,
  type LogicPinSpec,
} from './logicIc';

// ------------------------------------------------------------------ helpers

const inPin = (id: string): LogicPinSpec => ({ id, direction: 'in' });
const outPin = (id: string, canFloat = false): LogicPinSpec => ({ id, direction: 'out', tristate: canFloat });

/** Vcc and GND, which every one of these parts has. */
const RAILS: LogicPinSpec[] = [
  { id: 'vcc', direction: 'power' },
  { id: 'gnd', direction: 'ground' },
];

/**
 * A package of identical N-input gates.
 *
 * The 74HC00/02/08/32/86 are all this shape and differ only in the function
 * and the pin order, so they are one builder rather than five near-copies.
 */
function gatePackage(
  id: string,
  gates: { a: string[]; y: string }[],
  fn: (inputs: Logic[]) => Logic,
): LogicIcSpec {
  return {
    id,
    pins: [
      ...gates.flatMap((g) => [...g.a.map(inPin), outPin(g.y)]),
      ...RAILS,
    ],
    evaluate: (ctx) => {
      const out: Record<string, Logic> = {};
      for (const gate of gates) out[gate.y] = fn(gate.a.map((pin) => ctx.input(pin)));
      return out;
    },
  };
}

/** Reads a group of pins as a binary number, MSB first. Unknown → null. */
function busValue(ctx: LogicEvalContext, pins: string[]): number | null {
  let value = 0;
  for (const pin of pins) {
    const bit = ctx.input(pin);
    if (bit !== 0 && bit !== 1) return null;
    value = (value << 1) | bit;
  }
  return value;
}

/** Spreads a number across output pins, MSB first. */
function spread(value: number, pins: string[]): Record<string, Logic> {
  const out: Record<string, Logic> = {};
  pins.forEach((pin, i) => {
    out[pin] = ((value >> (pins.length - 1 - i)) & 1) as Logic;
  });
  return out;
}

/** Every output unknown, for when a part cannot decide. */
function allUnknown(pins: string[]): Record<string, Logic> {
  return Object.fromEntries(pins.map((p) => [p, 'x' as Logic]));
}

// -------------------------------------------------------------- basic gates

export const HC00: LogicIcSpec = gatePackage(
  'comp.74hc00',
  [
    { a: ['1a', '1b'], y: '1y' }, { a: ['2a', '2b'], y: '2y' },
    { a: ['3a', '3b'], y: '3y' }, { a: ['4a', '4b'], y: '4y' },
  ],
  nandOf,
);

export const HC02: LogicIcSpec = gatePackage(
  'comp.74hc02',
  [
    { a: ['1a', '1b'], y: '1y' }, { a: ['2a', '2b'], y: '2y' },
    { a: ['3a', '3b'], y: '3y' }, { a: ['4a', '4b'], y: '4y' },
  ],
  norOf,
);

export const HC04: LogicIcSpec = gatePackage(
  'comp.74hc04',
  [
    { a: ['1a'], y: '1y' }, { a: ['2a'], y: '2y' }, { a: ['3a'], y: '3y' },
    { a: ['4a'], y: '4y' }, { a: ['5a'], y: '5y' }, { a: ['6a'], y: '6y' },
  ],
  (i) => notOf(i[0]),
);

export const HC08: LogicIcSpec = gatePackage(
  'comp.74hc08',
  [
    { a: ['1a', '1b'], y: '1y' }, { a: ['2a', '2b'], y: '2y' },
    { a: ['3a', '3b'], y: '3y' }, { a: ['4a', '4b'], y: '4y' },
  ],
  andOf,
);

export const HC32: LogicIcSpec = gatePackage(
  'comp.74hc32',
  [
    { a: ['1a', '1b'], y: '1y' }, { a: ['2a', '2b'], y: '2y' },
    { a: ['3a', '3b'], y: '3y' }, { a: ['4a', '4b'], y: '4y' },
  ],
  orOf,
);

export const HC86: LogicIcSpec = gatePackage(
  'comp.74hc86',
  [
    { a: ['1a', '1b'], y: '1y' }, { a: ['2a', '2b'], y: '2y' },
    { a: ['3a', '3b'], y: '3y' }, { a: ['4a', '4b'], y: '4y' },
  ],
  xorOf,
);

/**
 * 74HC14 — hex Schmitt inverter.
 *
 * The only part here that cares about the input *voltage* rather than its
 * logic level, because hysteresis is the entire reason it exists. It reads the
 * analog level through `inputVolts` and remembers what it last output.
 */
export const HC14: LogicIcSpec = {
  id: 'comp.74hc14',
  pins: [
    ...[1, 2, 3, 4, 5, 6].flatMap((n) => [inPin(`${n}a`), outPin(`${n}y`)]),
    ...RAILS,
  ],
  evaluate: (ctx) => {
    const out: Record<string, Logic> = {};
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const previousOut = ctx.previousOutput(`${n}y`);
      // The trigger's own state is the inverse of what it last drove.
      const previousIn = previousOut === 1 ? 0 : previousOut === 0 ? 1 : 'x';
      out[`${n}y`] = notOf(schmitt(ctx.inputVolts(`${n}a`), ctx.supply, previousIn));
    }
    return out;
  },
};

// --------------------------------------------------------- tri-state buffers

/**
 * 74HC125 — quad tri-state buffer, active-low enable.
 *
 * With the enable high the output is genuinely disconnected, not driven low.
 * That distinction is the whole point of the part and is what makes a shared
 * bus possible, so `tristate` returns 'z' and the solver leaves the net alone.
 */
export const HC125: LogicIcSpec = {
  id: 'comp.74hc125',
  pins: [
    ...[1, 2, 3, 4].flatMap((n) => [inPin(`${n}oe`), inPin(`${n}a`), outPin(`${n}y`, true)]),
    ...RAILS,
  ],
  evaluate: (ctx) => {
    const out: Record<string, Logic> = {};
    for (const n of [1, 2, 3, 4]) out[`${n}y`] = tristate(ctx.input(`${n}a`), ctx.input(`${n}oe`), true);
    return out;
  },
};

/** 74HC126 — the same part with active-high enables. */
export const HC126: LogicIcSpec = {
  id: 'comp.74hc126',
  pins: [
    ...[1, 2, 3, 4].flatMap((n) => [inPin(`${n}oe`), inPin(`${n}a`), outPin(`${n}y`, true)]),
    ...RAILS,
  ],
  evaluate: (ctx) => {
    const out: Record<string, Logic> = {};
    for (const n of [1, 2, 3, 4]) out[`${n}y`] = tristate(ctx.input(`${n}a`), ctx.input(`${n}oe`), false);
    return out;
  },
};

/** 74HC244 — octal buffer in two nibbles, each with its own active-low enable. */
export const HC244: LogicIcSpec = {
  id: 'comp.74hc244',
  pins: [
    inPin('1oe'), inPin('2oe'),
    ...[1, 2, 3, 4].flatMap((n) => [inPin(`1a${n}`), outPin(`1y${n}`, true)]),
    ...[1, 2, 3, 4].flatMap((n) => [inPin(`2a${n}`), outPin(`2y${n}`, true)]),
    ...RAILS,
  ],
  evaluate: (ctx) => {
    const out: Record<string, Logic> = {};
    for (const half of [1, 2]) {
      const oe = ctx.input(`${half}oe`);
      for (const n of [1, 2, 3, 4]) out[`${half}y${n}`] = tristate(ctx.input(`${half}a${n}`), oe, true);
    }
    return out;
  },
};

/**
 * 74HC245 — octal transceiver.
 *
 * Direction decides which side drives; the other side's pins go high-Z. Both
 * sides are declared as outputs because either can be, and which one is doing
 * the driving is a runtime question rather than a wiring one.
 */
export const HC245: LogicIcSpec = {
  id: 'comp.74hc245',
  pins: [
    inPin('dir'), inPin('noe'),
    ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [outPin(`a${n}`, true), outPin(`b${n}`, true)]),
    ...RAILS,
  ],
  evaluate: (ctx) => {
    const enabled = ctx.input('noe') === 0;
    const dir = ctx.input('dir');
    const out: Record<string, Logic> = {};
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      if (!enabled || (dir !== 0 && dir !== 1)) {
        out[`a${n}`] = 'z';
        out[`b${n}`] = 'z';
        continue;
      }
      // DIR high: A drives B. DIR low: B drives A.
      if (dir === 1) {
        out[`b${n}`] = ctx.input(`a${n}`);
        out[`a${n}`] = 'z';
      } else {
        out[`a${n}`] = ctx.input(`b${n}`);
        out[`b${n}`] = 'z';
      }
    }
    return out;
  },
};

// ------------------------------------------------------------------ storage

/**
 * 74HC74 — dual D flip-flop with asynchronous preset and clear.
 *
 * Q changes on the rising clock edge, but preset and clear do not wait for one:
 * they are asynchronous and dominate, which is what makes them useful for reset
 * circuits and what a level-sampling model gets wrong.
 */
export const HC74: LogicIcSpec = {
  id: 'comp.74hc74',
  pins: [
    ...[1, 2].flatMap((n) => [
      inPin(`${n}d`), inPin(`${n}clk`), inPin(`${n}npre`), inPin(`${n}nclr`),
      outPin(`${n}q`), outPin(`${n}nq`),
    ]),
    ...RAILS,
  ],
  initialState: () => ({ q1: 0, q2: 0 }),
  clocks: [1, 2].map((n) => ({
    pin: `${n}clk`,
    edge: 'rising' as const,
    advance: (ctx: LogicEvalContext) => {
      // An asserted async input holds the flop; the edge does nothing.
      if (ctx.input(`${n}npre`) === 0 || ctx.input(`${n}nclr`) === 0) return;
      const d = ctx.input(`${n}d`);
      if (d === 0 || d === 1) ctx.state[`q${n}`] = d;
      else ctx.state[`q${n}`] = -1; // clocked in an unknown
    },
  })),
  evaluate: (ctx) => {
    const out: Record<string, Logic> = {};
    for (const n of [1, 2]) {
      const pre = ctx.input(`${n}npre`);
      const clr = ctx.input(`${n}nclr`);
      let q: Logic;
      if (pre === 0 && clr === 0) q = 1; // both asserted: the datasheet's illegal state
      else if (pre === 0) q = 1;
      else if (clr === 0) q = 0;
      else {
        const stored = ctx.state[`q${n}`];
        q = stored === 1 ? 1 : stored === 0 ? 0 : 'x';
      }
      out[`${n}q`] = q;
      // Both outputs are high in the illegal preset+clear state, as the part does.
      out[`${n}nq`] = pre === 0 && clr === 0 ? 1 : notOf(q);
    }
    return out;
  },
};

/**
 * A cross-coupled NOR SR latch.
 *
 * Combinational rather than clocked: it settles through the solver's own
 * fixed point, and S=R=1 gives the genuinely invalid state with both outputs
 * low rather than an invented preference.
 */
export const SR_LATCH: LogicIcSpec = {
  id: 'comp.latch-sr',
  pins: [inPin('s'), inPin('r'), outPin('q'), outPin('nq'), ...RAILS],
  initialState: () => ({ q: 0 }),
  evaluate: (ctx) => {
    const s = ctx.input('s');
    const r = ctx.input('r');
    if (s === 1 && r === 1) return { q: 0, nq: 0 }; // invalid, and shown as such
    if (s === 1) ctx.state.q = 1;
    else if (r === 1) ctx.state.q = 0;
    else if (s !== 0 || r !== 0) return { q: 'x', nq: 'x' };
    const q = ctx.state.q === 1 ? 1 : 0;
    return { q, nq: notOf(q) };
  },
};

/** A transparent D latch: follows D while enabled, holds when not. */
export const D_LATCH: LogicIcSpec = {
  id: 'comp.latch-d',
  pins: [inPin('d'), inPin('en'), outPin('q'), outPin('nq'), ...RAILS],
  initialState: () => ({ q: 0 }),
  evaluate: (ctx) => {
    const en = ctx.input('en');
    if (en === 1) {
      const d = ctx.input('d');
      ctx.state.q = d === 1 ? 1 : d === 0 ? 0 : -1;
    } else if (en !== 0) {
      return { q: 'x', nq: 'x' };
    }
    const q: Logic = ctx.state.q === 1 ? 1 : ctx.state.q === 0 ? 0 : 'x';
    return { q, nq: notOf(q) };
  },
};

/** A JK flip-flop: the toggle case is what distinguishes it from a D type. */
export const JK_FLIPFLOP: LogicIcSpec = {
  id: 'comp.flipflop-jk',
  pins: [inPin('j'), inPin('k'), inPin('clk'), inPin('nclr'), outPin('q'), outPin('nq'), ...RAILS],
  initialState: () => ({ q: 0 }),
  clocks: [
    {
      pin: 'clk',
      edge: 'rising',
      advance: (ctx) => {
        if (ctx.input('nclr') === 0) return;
        const j = ctx.input('j');
        const k = ctx.input('k');
        if (j !== 0 && j !== 1) return void (ctx.state.q = -1);
        if (k !== 0 && k !== 1) return void (ctx.state.q = -1);
        if (j === 1 && k === 1) ctx.state.q = ctx.state.q === 1 ? 0 : 1;
        else if (j === 1) ctx.state.q = 1;
        else if (k === 1) ctx.state.q = 0;
      },
    },
  ],
  evaluate: (ctx) => {
    if (ctx.input('nclr') === 0) {
      ctx.state.q = 0;
      return { q: 0, nq: 1 };
    }
    const q: Logic = ctx.state.q === 1 ? 1 : ctx.state.q === 0 ? 0 : 'x';
    return { q, nq: notOf(q) };
  },
};

const BYTE = [1, 2, 3, 4, 5, 6, 7, 8];

/**
 * 74HC573 — octal transparent latch with tri-state outputs.
 *
 * The 573 rather than the 373 because it is the same silicon with the pinout
 * arranged so D and Q face each other, which is why it is the one people
 * actually use on a breadboard.
 */
export const HC573: LogicIcSpec = {
  id: 'comp.74hc573',
  pins: [
    inPin('le'), inPin('noe'),
    ...BYTE.flatMap((n) => [inPin(`d${n}`), outPin(`q${n}`, true)]),
    ...RAILS,
  ],
  initialState: () => Object.fromEntries(BYTE.map((n) => [`q${n}`, 0])),
  evaluate: (ctx) => {
    if (ctx.input('le') === 1) {
      for (const n of BYTE) {
        const d = ctx.input(`d${n}`);
        ctx.state[`q${n}`] = d === 1 ? 1 : d === 0 ? 0 : -1;
      }
    }
    const oe = ctx.input('noe');
    const out: Record<string, Logic> = {};
    for (const n of BYTE) {
      const stored: Logic = ctx.state[`q${n}`] === 1 ? 1 : ctx.state[`q${n}`] === 0 ? 0 : 'x';
      out[`q${n}`] = tristate(stored, oe, true);
    }
    return out;
  },
};

/** 74HC574 — octal D register, edge triggered rather than transparent. */
export const HC574: LogicIcSpec = {
  id: 'comp.74hc574',
  pins: [
    inPin('clk'), inPin('noe'),
    ...BYTE.flatMap((n) => [inPin(`d${n}`), outPin(`q${n}`, true)]),
    ...RAILS,
  ],
  initialState: () => Object.fromEntries(BYTE.map((n) => [`q${n}`, 0])),
  clocks: [
    {
      pin: 'clk',
      edge: 'rising',
      advance: (ctx) => {
        for (const n of BYTE) {
          const d = ctx.input(`d${n}`);
          ctx.state[`q${n}`] = d === 1 ? 1 : d === 0 ? 0 : -1;
        }
      },
    },
  ],
  evaluate: (ctx) => {
    const oe = ctx.input('noe');
    const out: Record<string, Logic> = {};
    for (const n of BYTE) {
      const stored: Logic = ctx.state[`q${n}`] === 1 ? 1 : ctx.state[`q${n}`] === 0 ? 0 : 'x';
      out[`q${n}`] = tristate(stored, oe, true);
    }
    return out;
  },
};

// ----------------------------------------------------------------- counters

const NIBBLE = ['qa', 'qb', 'qc', 'qd'];

/**
 * 74HC161 — synchronous 4-bit binary counter with asynchronous clear.
 *
 * Counts on the rising edge when both enables are high, loads in parallel when
 * LOAD is low, and clears immediately when CLR goes low without waiting for a
 * clock. RCO is high only at 15 with the count enabled — a detail that matters
 * because it is how these are cascaded.
 */
export const HC161: LogicIcSpec = {
  id: 'comp.74hc161',
  pins: [
    inPin('clk'), inPin('nclr'), inPin('nload'), inPin('enp'), inPin('ent'),
    inPin('a'), inPin('b'), inPin('c'), inPin('d'),
    ...NIBBLE.map((q) => outPin(q)), outPin('rco'),
    ...RAILS,
  ],
  initialState: () => ({ count: 0 }),
  clocks: [
    {
      pin: 'clk',
      edge: 'rising',
      advance: (ctx) => {
        if (ctx.input('nclr') === 0) return;
        if (ctx.input('nload') === 0) {
          const loaded = busValue(ctx, ['d', 'c', 'b', 'a']);
          ctx.state.count = loaded ?? 0;
          return;
        }
        if (ctx.input('enp') === 1 && ctx.input('ent') === 1) {
          ctx.state.count = (ctx.state.count + 1) & 0xf;
        }
      },
    },
  ],
  evaluate: (ctx) => {
    if (ctx.input('nclr') === 0) ctx.state.count = 0;
    const count = ctx.state.count & 0xf;
    return {
      qa: ((count >> 0) & 1) as Logic,
      qb: ((count >> 1) & 1) as Logic,
      qc: ((count >> 2) & 1) as Logic,
      qd: ((count >> 3) & 1) as Logic,
      rco: (count === 15 && ctx.input('ent') === 1 ? 1 : 0) as Logic,
    };
  },
};

/**
 * 74HC193 — 4-bit up/down counter with two clocks.
 *
 * Up and down are separate clock inputs rather than a direction pin, which is
 * unusual enough that firmware written for it does not work on anything else.
 * Borrow and carry are active low and only pulse at the ends of the range.
 */
export const HC193: LogicIcSpec = {
  id: 'comp.74hc193',
  pins: [
    inPin('up'), inPin('down'), inPin('clr'), inPin('nload'),
    inPin('a'), inPin('b'), inPin('c'), inPin('d'),
    ...NIBBLE.map((q) => outPin(q)), outPin('nco'), outPin('nbo'),
    ...RAILS,
  ],
  initialState: () => ({ count: 0 }),
  clocks: [
    {
      pin: 'up',
      edge: 'rising',
      advance: (ctx) => {
        if (ctx.input('clr') === 1 || ctx.input('nload') === 0) return;
        ctx.state.count = (ctx.state.count + 1) & 0xf;
      },
    },
    {
      pin: 'down',
      edge: 'rising',
      advance: (ctx) => {
        if (ctx.input('clr') === 1 || ctx.input('nload') === 0) return;
        ctx.state.count = (ctx.state.count - 1) & 0xf;
      },
    },
  ],
  evaluate: (ctx) => {
    if (ctx.input('clr') === 1) ctx.state.count = 0;
    else if (ctx.input('nload') === 0) {
      const loaded = busValue(ctx, ['d', 'c', 'b', 'a']);
      if (loaded !== null) ctx.state.count = loaded;
    }
    const count = ctx.state.count & 0xf;
    return {
      qa: ((count >> 0) & 1) as Logic,
      qb: ((count >> 1) & 1) as Logic,
      qc: ((count >> 2) & 1) as Logic,
      qd: ((count >> 3) & 1) as Logic,
      // Carry falls while the count is at 15 and the up clock is low.
      nco: (count === 15 && ctx.input('up') === 0 ? 0 : 1) as Logic,
      nbo: (count === 0 && ctx.input('down') === 0 ? 0 : 1) as Logic,
    };
  },
};

const DECADE_OUTPUTS = ['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9'];

/**
 * CD4017 — decade counter with ten decoded outputs.
 *
 * Exactly one output is high at a time, which is why it turns up in every
 * chaser and sequencer project ever built. Carry-out is high for counts 0-4,
 * so cascading it divides by ten.
 */
export const CD4017: LogicIcSpec = {
  id: 'comp.cd4017',
  pins: [
    inPin('clk'), inPin('inh'), inPin('rst'),
    ...DECADE_OUTPUTS.map((q) => outPin(q)), outPin('co'),
    ...RAILS,
  ],
  initialState: () => ({ count: 0 }),
  clocks: [
    {
      pin: 'clk',
      edge: 'rising',
      advance: (ctx) => {
        if (ctx.input('rst') === 1) return;
        // INH high inhibits counting, which is how the part is gated.
        if (ctx.input('inh') === 1) return;
        ctx.state.count = (ctx.state.count + 1) % 10;
      },
    },
  ],
  evaluate: (ctx) => {
    if (ctx.input('rst') === 1) ctx.state.count = 0;
    const count = ctx.state.count % 10;
    const out: Record<string, Logic> = {};
    DECADE_OUTPUTS.forEach((q, i) => {
      out[q] = (i === count ? 1 : 0) as Logic;
    });
    out.co = (count < 5 ? 1 : 0) as Logic;
    return out;
  },
};

const SEGMENTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

/** Seven-segment patterns for 0-9, in `a`…`g` order. */
const DIGIT_SEGMENTS: number[][] = [
  [1, 1, 1, 1, 1, 1, 0], // 0
  [0, 1, 1, 0, 0, 0, 0], // 1
  [1, 1, 0, 1, 1, 0, 1], // 2
  [1, 1, 1, 1, 0, 0, 1], // 3
  [0, 1, 1, 0, 0, 1, 1], // 4
  [1, 0, 1, 1, 0, 1, 1], // 5
  [1, 0, 1, 1, 1, 1, 1], // 6
  [1, 1, 1, 0, 0, 0, 0], // 7
  [1, 1, 1, 1, 1, 1, 1], // 8
  [1, 1, 1, 1, 0, 1, 1], // 9
];

/**
 * CD4026 — decade counter with a seven-segment driver on the outputs.
 *
 * The counter and the decoder are one part, which is what makes it a one-chip
 * digit. The segment outputs are real pins: they drive a seven-segment
 * component through wires, not through a shortcut that draws a number.
 */
export const CD4026: LogicIcSpec = {
  id: 'comp.cd4026',
  pins: [
    inPin('clk'), inPin('inh'), inPin('rst'), inPin('deo'),
    ...SEGMENTS.map((s) => outPin(s)), outPin('co'), outPin('ung'),
    ...RAILS,
  ],
  initialState: () => ({ count: 0 }),
  clocks: [
    {
      pin: 'clk',
      edge: 'rising',
      advance: (ctx) => {
        if (ctx.input('rst') === 1 || ctx.input('inh') === 1) return;
        ctx.state.count = (ctx.state.count + 1) % 10;
      },
    },
  ],
  evaluate: (ctx) => {
    if (ctx.input('rst') === 1) ctx.state.count = 0;
    const count = ctx.state.count % 10;
    const pattern = DIGIT_SEGMENTS[count];
    // Display-enable-out low blanks the segments without losing the count.
    const blanked = ctx.input('deo') === 0;
    const out: Record<string, Logic> = {};
    SEGMENTS.forEach((s, i) => {
      out[s] = (blanked ? 0 : pattern[i]) as Logic;
    });
    out.co = (count >= 5 ? 1 : 0) as Logic;
    out.ung = (count === 1 || count === 0 ? 1 : 0) as Logic;
    return out;
  },
};

const RIPPLE_OUTPUTS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10', 'q11', 'q12'];

/**
 * CD4040 — 12-stage ripple counter.
 *
 * Counts on the falling edge, which is what makes a chain of them divide
 * cleanly, and has no load: it counts or it is reset.
 */
export const CD4040: LogicIcSpec = {
  id: 'comp.cd4040',
  pins: [inPin('clk'), inPin('rst'), ...RIPPLE_OUTPUTS.map((q) => outPin(q)), ...RAILS],
  initialState: () => ({ count: 0 }),
  clocks: [
    {
      pin: 'clk',
      edge: 'falling',
      advance: (ctx) => {
        if (ctx.input('rst') === 1) return;
        ctx.state.count = (ctx.state.count + 1) & 0xfff;
      },
    },
  ],
  evaluate: (ctx) => {
    if (ctx.input('rst') === 1) ctx.state.count = 0;
    const count = ctx.state.count & 0xfff;
    const out: Record<string, Logic> = {};
    RIPPLE_OUTPUTS.forEach((q, i) => {
      out[q] = ((count >> i) & 1) as Logic;
    });
    return out;
  },
};

// ------------------------------------------------------ decoders and muxes

/**
 * 74HC138 — 3-to-8 line decoder with active-low outputs.
 *
 * All three enables must agree before anything is selected, which is the
 * feature: it is what lets several of them share an address bus.
 */
export const HC138: LogicIcSpec = {
  id: 'comp.74hc138',
  pins: [
    inPin('a'), inPin('b'), inPin('c'), inPin('g1'), inPin('ng2a'), inPin('ng2b'),
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => outPin(`y${n}`)),
    ...RAILS,
  ],
  evaluate: (ctx) => {
    const outputs = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => `y${n}`);
    const enabled = ctx.input('g1') === 1 && ctx.input('ng2a') === 0 && ctx.input('ng2b') === 0;
    const disabled =
      ctx.input('g1') === 0 || ctx.input('ng2a') === 1 || ctx.input('ng2b') === 1;
    if (disabled) return Object.fromEntries(outputs.map((y) => [y, 1 as Logic]));
    if (!enabled) return allUnknown(outputs);
    const select = busValue(ctx, ['c', 'b', 'a']);
    if (select === null) return allUnknown(outputs);
    return Object.fromEntries(outputs.map((y, i) => [y, (i === select ? 0 : 1) as Logic]));
  },
};

/** 74HC139 — dual 2-to-4 decoder, each half with its own active-low enable. */
export const HC139: LogicIcSpec = {
  id: 'comp.74hc139',
  pins: [
    ...[1, 2].flatMap((h) => [
      inPin(`${h}ng`), inPin(`${h}a`), inPin(`${h}b`),
      ...[0, 1, 2, 3].map((n) => outPin(`${h}y${n}`)),
    ]),
    ...RAILS,
  ],
  evaluate: (ctx) => {
    const out: Record<string, Logic> = {};
    for (const h of [1, 2]) {
      const outputs = [0, 1, 2, 3].map((n) => `${h}y${n}`);
      if (ctx.input(`${h}ng`) !== 0) {
        for (const y of outputs) out[y] = ctx.input(`${h}ng`) === 1 ? 1 : 'x';
        continue;
      }
      const select = busValue(ctx, [`${h}b`, `${h}a`]);
      outputs.forEach((y, i) => {
        out[y] = select === null ? 'x' : ((i === select ? 0 : 1) as Logic);
      });
    }
    return out;
  },
};

/** 74HC151 — 8-to-1 multiplexer with complementary outputs. */
export const HC151: LogicIcSpec = {
  id: 'comp.74hc151',
  pins: [
    inPin('a'), inPin('b'), inPin('c'), inPin('ng'),
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => inPin(`d${n}`)),
    outPin('y'), outPin('ny'),
    ...RAILS,
  ],
  evaluate: (ctx) => {
    if (ctx.input('ng') !== 0) {
      return ctx.input('ng') === 1 ? { y: 0, ny: 1 } : { y: 'x', ny: 'x' };
    }
    const select = busValue(ctx, ['c', 'b', 'a']);
    if (select === null) return { y: 'x', ny: 'x' };
    const value = ctx.input(`d${select}`);
    return { y: value, ny: notOf(value) };
  },
};

/** 74HC153 — dual 4-to-1 multiplexer sharing one pair of select lines. */
export const HC153: LogicIcSpec = {
  id: 'comp.74hc153',
  pins: [
    inPin('a'), inPin('b'),
    ...[1, 2].flatMap((h) => [
      inPin(`${h}ng`),
      ...[0, 1, 2, 3].map((n) => inPin(`${h}c${n}`)),
      outPin(`${h}y`),
    ]),
    ...RAILS,
  ],
  evaluate: (ctx) => {
    const select = busValue(ctx, ['b', 'a']);
    const out: Record<string, Logic> = {};
    for (const h of [1, 2]) {
      if (ctx.input(`${h}ng`) !== 0) {
        out[`${h}y`] = ctx.input(`${h}ng`) === 1 ? 0 : 'x';
        continue;
      }
      out[`${h}y`] = select === null ? 'x' : ctx.input(`${h}c${select}`);
    }
    return out;
  },
};

/** 74HC157 — quad 2-to-1 multiplexer, one select line for all four. */
export const HC157: LogicIcSpec = {
  id: 'comp.74hc157',
  pins: [
    inPin('sel'), inPin('ne'),
    ...[1, 2, 3, 4].flatMap((n) => [inPin(`${n}a`), inPin(`${n}b`), outPin(`${n}y`)]),
    ...RAILS,
  ],
  evaluate: (ctx) => {
    const out: Record<string, Logic> = {};
    const enable = ctx.input('ne');
    const sel = ctx.input('sel');
    for (const n of [1, 2, 3, 4]) {
      if (enable !== 0) {
        out[`${n}y`] = enable === 1 ? 0 : 'x';
        continue;
      }
      out[`${n}y`] = sel === 0 ? ctx.input(`${n}a`) : sel === 1 ? ctx.input(`${n}b`) : 'x';
    }
    return out;
  },
};

// ------------------------------------------------- arithmetic and comparison

/**
 * 74HC283 — 4-bit binary full adder with carry in and out.
 *
 * The sum is genuinely computed from the input pins, so it can be cascaded
 * into an 8-bit adder by wiring C4 of one to C0 of the next.
 */
export const HC283: LogicIcSpec = {
  id: 'comp.74hc283',
  pins: [
    ...[1, 2, 3, 4].flatMap((n) => [inPin(`a${n}`), inPin(`b${n}`)]),
    inPin('c0'),
    ...[1, 2, 3, 4].map((n) => outPin(`s${n}`)), outPin('c4'),
    ...RAILS,
  ],
  evaluate: (ctx) => {
    const a = busValue(ctx, ['a4', 'a3', 'a2', 'a1']);
    const b = busValue(ctx, ['b4', 'b3', 'b2', 'b1']);
    const cin = ctx.input('c0');
    const outputs = ['s1', 's2', 's3', 's4', 'c4'];
    if (a === null || b === null || (cin !== 0 && cin !== 1)) return allUnknown(outputs);
    const total = a + b + cin;
    return { ...spread(total & 0xf, ['s4', 's3', 's2', 's1']), c4: ((total >> 4) & 1) as Logic };
  },
};

/**
 * 74HC85 — 4-bit magnitude comparator.
 *
 * The cascade inputs decide the answer when the two words are equal, which is
 * what makes wider comparators possible and is the part of the datasheet
 * people get wrong.
 */
export const HC85: LogicIcSpec = {
  id: 'comp.74hc85',
  pins: [
    ...[0, 1, 2, 3].flatMap((n) => [inPin(`a${n}`), inPin(`b${n}`)]),
    inPin('agtbin'), inPin('altbin'), inPin('aeqbin'),
    outPin('agtb'), outPin('altb'), outPin('aeqb'),
    ...RAILS,
  ],
  evaluate: (ctx) => {
    const a = busValue(ctx, ['a3', 'a2', 'a1', 'a0']);
    const b = busValue(ctx, ['b3', 'b2', 'b1', 'b0']);
    if (a === null || b === null) return allUnknown(['agtb', 'altb', 'aeqb']);
    if (a > b) return { agtb: 1, altb: 0, aeqb: 0 };
    if (a < b) return { agtb: 0, altb: 1, aeqb: 0 };
    // Equal: defer to the cascade inputs from the less significant stage.
    const gt = ctx.input('agtbin');
    const lt = ctx.input('altbin');
    const eq = ctx.input('aeqbin');
    return {
      agtb: gt === 1 && lt === 0 ? 1 : gt === 'x' ? 'x' : 0,
      altb: lt === 1 && gt === 0 ? 1 : lt === 'x' ? 'x' : 0,
      aeqb: eq === 1 && gt !== 1 && lt !== 1 ? 1 : eq === 'x' ? 'x' : 0,
    };
  },
};

// --------------------------------------------------------- display decoding

/**
 * CD4511 — BCD to seven-segment latch/decoder/driver.
 *
 * Blanking, lamp test and the store latch are all real, and inputs above nine
 * blank the display rather than showing hex — which is the behaviour that
 * distinguishes a 4511 from a 7447 and surprises people.
 */
export const CD4511: LogicIcSpec = {
  id: 'comp.cd4511',
  // The datasheet names the BCD inputs A-D and the segment outputs a-g, which
  // is unambiguous on paper and a collision in code. The outputs carry an `s`
  // prefix here; their printed labels are still the plain segment letters.
  pins: [
    inPin('a'), inPin('b'), inPin('c'), inPin('d'),
    inPin('nlt'), inPin('nbi'), inPin('le'),
    ...SEGMENTS.map((s) => outPin(`s${s}`)),
    ...RAILS,
  ],
  initialState: () => ({ latched: 0 }),
  evaluate: (ctx) => {
    const seg = (values: (0 | 1 | 'x')[]) =>
      Object.fromEntries(SEGMENTS.map((s, i) => [`s${s}`, values[i] as Logic]));
    // Lamp test wins over everything, then blanking, as the datasheet orders it.
    if (ctx.input('nlt') === 0) return seg(SEGMENTS.map(() => 1 as const));
    if (ctx.input('nbi') === 0) return seg(SEGMENTS.map(() => 0 as const));
    if (ctx.input('le') === 0) {
      const value = busValue(ctx, ['d', 'c', 'b', 'a']);
      if (value === null) return allUnknown(SEGMENTS.map((s) => `s${s}`));
      ctx.state.latched = value;
    }
    const digit = ctx.state.latched;
    // Ten to fifteen are blank on a 4511, not hex letters.
    if (digit > 9) return seg(SEGMENTS.map(() => 0 as const));
    return seg(DIGIT_SEGMENTS[digit] as (0 | 1)[]);
  },
};

// ---------------------------------------------------------- shift registers

/**
 * 74HC164 — serial-in, parallel-out shift register.
 *
 * Unlike the 595 there is no output latch: the outputs change as bits shift
 * through, which is why it needs fewer pins and produces visible rippling.
 */
export const HC164: LogicIcSpec = {
  id: 'comp.74hc164',
  pins: [
    inPin('a'), inPin('b'), inPin('clk'), inPin('nclr'),
    ...BYTE.map((n) => outPin(`q${n}`)),
    ...RAILS,
  ],
  initialState: () => ({ shift: 0 }),
  clocks: [
    {
      pin: 'clk',
      edge: 'rising',
      advance: (ctx) => {
        if (ctx.input('nclr') === 0) return;
        // The two serial inputs are ANDed, which is how one of them is used
        // as an enable in real designs.
        const bit = andOf([ctx.input('a'), ctx.input('b')]);
        ctx.state.shift = ((ctx.state.shift << 1) | (bit === 1 ? 1 : 0)) & 0xff;
      },
    },
  ],
  evaluate: (ctx) => {
    if (ctx.input('nclr') === 0) ctx.state.shift = 0;
    const out: Record<string, Logic> = {};
    BYTE.forEach((n, i) => {
      out[`q${n}`] = ((ctx.state.shift >> i) & 1) as Logic;
    });
    return out;
  },
};

// ------------------------------------------------------ discrete gate parts
//
// Single gates on the canvas, for people drawing logic rather than wiring a
// specific package. Same evaluator, one gate per part.

function discreteGate(id: string, inputs: number, fn: (i: Logic[]) => Logic): LogicIcSpec {
  const pins = inputs === 1 ? ['a'] : ['a', 'b'];
  return {
    id,
    pins: [...pins.map(inPin), outPin('y'), ...RAILS],
    evaluate: (ctx) => ({ y: fn(pins.map((p) => ctx.input(p))) }),
  };
}

export const GATE_AND = discreteGate('comp.gate-and', 2, andOf);
export const GATE_OR = discreteGate('comp.gate-or', 2, orOf);
export const GATE_NOT = discreteGate('comp.gate-not', 1, (i) => notOf(i[0]));
export const GATE_NAND = discreteGate('comp.gate-nand', 2, nandOf);
export const GATE_NOR = discreteGate('comp.gate-nor', 2, norOf);
export const GATE_XOR = discreteGate('comp.gate-xor', 2, xorOf);
export const GATE_XNOR = discreteGate('comp.gate-xnor', 2, xnorOf);

export const GATE_TRISTATE: LogicIcSpec = {
  id: 'comp.buffer-tristate',
  pins: [inPin('a'), inPin('oe'), outPin('y', true), ...RAILS],
  evaluate: (ctx) => ({ y: tristate(ctx.input('a'), ctx.input('oe'), false) }),
};

export const GATE_SCHMITT: LogicIcSpec = {
  id: 'comp.schmitt-trigger',
  pins: [inPin('a'), outPin('y'), ...RAILS],
  evaluate: (ctx) => {
    const previousOut = ctx.previousOutput('y');
    const previousIn = previousOut === 1 ? 0 : previousOut === 0 ? 1 : 'x';
    return { y: notOf(schmitt(ctx.inputVolts('a'), ctx.supply, previousIn)) };
  },
};

// ------------------------------------------------------------------ registry

/** Every logic part, by component definition id. */
export const LOGIC_PARTS: Record<string, LogicIcSpec> = Object.fromEntries(
  [
    GATE_AND, GATE_OR, GATE_NOT, GATE_NAND, GATE_NOR, GATE_XOR, GATE_XNOR,
    GATE_TRISTATE, GATE_SCHMITT,
    HC00, HC02, HC04, HC08, HC14, HC32, HC86,
    HC125, HC126, HC244, HC245,
    HC74, SR_LATCH, D_LATCH, JK_FLIPFLOP, HC573, HC574,
    HC161, HC193, CD4017, CD4026, CD4040,
    HC138, HC139, HC151, HC153, HC157,
    HC283, HC85,
    CD4511, HC164,
  ].map((spec) => [spec.id, spec]),
);

export { DIGIT_SEGMENTS, SEGMENTS };
