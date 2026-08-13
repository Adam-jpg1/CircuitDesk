// Combinational and sequential logic, as one evaluator.
//
// There are around forty 74xx and CD4xxx parts worth having, and writing forty
// hand-rolled models would produce forty subtly different opinions about what
// happens when an input floats, when two outputs fight, or when a clock edge
// lands in the same instant as a reset. So the parts are data — a pin list and
// a function — and there is exactly one opinion about the hard cases, here.
//
// Three rules, which is what makes the family deterministic:
//
//   1. An input that is not driven is UNKNOWN, not LOW. A 74HC gate with a
//      floating input really does misbehave, and reporting `x` is how a user
//      finds the missing pull-down instead of chasing their firmware.
//   2. An output is a level or high-Z, never "a bit". Tri-state parts are the
//      whole reason the 244/245/373 exist, so Z is a first-class value rather
//      than something bolted on afterwards.
//   3. Sequential parts change on an edge that the world clock delivered, in
//      the order the world delivered it. Nothing samples "the current frame".

/** A wire's logical value. `x` means not driven, or driven to a contradiction. */
export type Logic = 0 | 1 | 'x' | 'z';

/** True only for a definite 1. Everything undecided reads as not-high. */
export function isHigh(v: Logic): boolean {
  return v === 1;
}

/** Resolves a voltage to a logic level against the family's thresholds. */
export function levelOf(volts: number | null, supply: number): Logic {
  if (volts === null || !Number.isFinite(volts)) return 'x';
  // 74HC thresholds: below 30% of Vcc is a definite low, above 70% a definite
  // high. In between is genuinely indeterminate and is reported as such.
  if (volts <= supply * 0.3) return 0;
  if (volts >= supply * 0.7) return 1;
  return 'x';
}

// ------------------------------------------------------------- gate algebra
//
// Written to propagate uncertainty rather than swallow it: `1 OR x` is 1
// because the answer does not depend on the unknown input, but `0 OR x` is x.

export function notOf(a: Logic): Logic {
  if (a === 0) return 1;
  if (a === 1) return 0;
  return 'x';
}

export function andOf(inputs: Logic[]): Logic {
  if (inputs.some((v) => v === 0)) return 0;
  return inputs.every((v) => v === 1) ? 1 : 'x';
}

export function orOf(inputs: Logic[]): Logic {
  if (inputs.some((v) => v === 1)) return 1;
  return inputs.every((v) => v === 0) ? 0 : 'x';
}

export function xorOf(inputs: Logic[]): Logic {
  if (inputs.some((v) => v !== 0 && v !== 1)) return 'x';
  return (inputs.filter((v) => v === 1).length % 2 === 1 ? 1 : 0) as Logic;
}

export const nandOf = (i: Logic[]): Logic => notOf(andOf(i));
export const norOf = (i: Logic[]): Logic => notOf(orOf(i));
export const xnorOf = (i: Logic[]): Logic => notOf(xorOf(i));

/**
 * A tri-state output: the value when enabled, high-Z when not.
 *
 * `enable` being unknown gives Z rather than a guess, because driving a bus
 * you are not sure you own is the failure this models.
 */
export function tristate(value: Logic, enable: Logic, activeLow = false): Logic {
  const on = activeLow ? enable === 0 : enable === 1;
  if (!on) return 'z';
  return value;
}

/**
 * A Schmitt trigger, which needs the previous output to have hysteresis at all.
 *
 * The whole purpose of a 74HC14 is that its threshold depends on which way the
 * input is moving, so a model that just compares against one threshold is not
 * a Schmitt trigger — it is an inverter with extra steps.
 */
export function schmitt(volts: number | null, supply: number, previous: Logic): Logic {
  if (volts === null || !Number.isFinite(volts)) return 'x';
  const vt = { rising: supply * 0.6, falling: supply * 0.4 };
  if (previous === 1) return volts < vt.falling ? 0 : 1;
  if (previous === 0) return volts > vt.rising ? 1 : 0;
  if (volts > vt.rising) return 1;
  if (volts < vt.falling) return 0;
  return 'x';
}

// --------------------------------------------------------- part description

export interface LogicPinSpec {
  id: string;
  direction: 'in' | 'out' | 'power' | 'ground';
  /** For outputs that can go high-Z. */
  tristate?: boolean;
}

/**
 * Everything a logic part needs to be simulated.
 *
 * `evaluate` is pure and gets the whole input picture plus the part's own
 * retained state, so a counter and a NAND gate are described the same way and
 * only differ in whether they read `state`.
 */
export interface LogicIcSpec {
  id: string;
  pins: LogicPinSpec[];
  /** Called whenever inputs settle. Returns the value of every output pin. */
  evaluate(ctx: LogicEvalContext): Record<string, Logic>;
  /**
   * Pins whose rising (or falling) edge advances internal state.
   *
   * Declared rather than detected so the world can subscribe to real pin
   * edges: a clock pulse microseconds wide must not depend on being lucky
   * enough to land inside a polled frame.
   */
  clocks?: { pin: string; edge: 'rising' | 'falling'; advance(ctx: LogicEvalContext): void }[];
  /** Fresh internal state for a new instance. */
  initialState?(): Record<string, number>;
}

export interface LogicEvalContext {
  /** Current level of an input pin. */
  input(pinId: string): Logic;
  /** Retained state, e.g. a counter's value or a flip-flop's Q. */
  state: Record<string, number>;
  /** Supply voltage, for threshold-dependent parts. */
  supply: number;
  /** The output this part drove last time, for hysteresis. */
  previousOutput(pinId: string): Logic;
}

/**
 * A running instance of a logic part.
 *
 * Holds the state and the last outputs; the circuit binding owns when it is
 * evaluated and what its outputs do to the nets.
 */
export class LogicIcDevice {
  readonly state: Record<string, number>;
  private outputs: Record<string, Logic> = {};

  constructor(
    readonly instanceId: string,
    readonly spec: LogicIcSpec,
    readonly supply: number,
  ) {
    this.state = spec.initialState?.() ?? {};
    for (const pin of spec.pins) if (pin.direction === 'out') this.outputs[pin.id] = 'x';
  }

  /** Recomputes outputs from the current inputs. */
  evaluate(input: (pinId: string) => Logic): Record<string, Logic> {
    const ctx: LogicEvalContext = {
      input,
      state: this.state,
      supply: this.supply,
      previousOutput: (pinId) => this.outputs[pinId] ?? 'x',
    };
    this.outputs = this.spec.evaluate(ctx);
    return this.outputs;
  }

  /** Advances state on a declared clock edge, before the next evaluation. */
  clockEdge(pinId: string, edge: 'rising' | 'falling', input: (pinId: string) => Logic): boolean {
    const clock = this.spec.clocks?.find((c) => c.pin === pinId && c.edge === edge);
    if (!clock) return false;
    clock.advance({
      input,
      state: this.state,
      supply: this.supply,
      previousOutput: (id) => this.outputs[id] ?? 'x',
    });
    return true;
  }

  outputOf(pinId: string): Logic {
    return this.outputs[pinId] ?? 'x';
  }
}
