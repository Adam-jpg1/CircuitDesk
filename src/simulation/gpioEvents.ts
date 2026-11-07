// What a digital pin is doing, described without reference to any one chip.
//
// Several things downstream need to know this: the canvas binding that drives
// an LED, the Pin States panel, and later a logic analyser, signal tracing and
// automatically graded exercises. If each of those reached into a particular
// runtime's registers they would all have to be rewritten for every new part.
//
// So runtimes report pin state in these terms instead. Nothing here is
// UI-specific — there are no callbacks named after panels and no colours — and
// nothing is AVR-, RP2040- or ESP-specific either.

/** Which way a pin is driving, from the chip's point of view. */
export type PinDirection =
  /** The chip is driving the pin. */
  | 'output'
  /** The chip is reading the pin. */
  | 'input'
  /** Neither: the pad is disconnected from the chip's digital logic. */
  | 'disabled';

/** An internal pull resistor, when the chip has one enabled. */
export type PinPull = 'up' | 'down' | 'none';

/**
 * The electrical level on a pin.
 *
 * `undefined` means genuinely indeterminate: an input with no pull and nothing
 * connected. Reporting a level there would be inventing one, and a floating
 * input is a real and common wiring mistake worth being able to show.
 */
export type PinLevel = 0 | 1 | undefined;

export interface PinState {
  /** The chip's own number for the pin, as its datasheet names it. */
  pin: number;
  direction: PinDirection;
  level: PinLevel;
  pull: PinPull;
  /**
   * True when the chip is driving low but not high — an open-drain output.
   * A pull-up or an external source decides the high level.
   */
  openDrain: boolean;
  /** Simulated nanoseconds since power-on at which this became true. */
  timestamp: number;
}

/** A pin changing state. Carries what it was, so an edge is unambiguous. */
export interface PinChange {
  previous: PinState;
  current: PinState;
}

/** Something that reports digital pin state. */
export interface DigitalPinSource {
  /** Every pin the part exposes, in its own numbering. */
  pinNumbers(): number[];
  /** Current state of one pin. */
  pinState(pin: number): PinState;
  /**
   * Drives a pin from outside the chip, as a wire on the canvas would.
   *
   * `undefined` releases it, leaving the pin to its pull or to float.
   */
  drivePin(pin: number, level: 0 | 1 | undefined): void;
  /** Called whenever any pin's state changes. */
  onPinChange(listener: (change: PinChange) => void): () => void;
}

/** True when two states differ in anything worth reporting. */
export function pinStateChanged(a: PinState, b: PinState): boolean {
  return a.direction !== b.direction || a.level !== b.level || a.pull !== b.pull || a.openDrain !== b.openDrain;
}
