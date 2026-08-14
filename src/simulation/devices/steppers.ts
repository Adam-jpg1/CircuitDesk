// Steppers: the position is where the coils put it.
//
// A stepper does not have a speed. It has a rotor that lines up with whichever
// coil pattern is energised, and it moves one step when that pattern changes to
// an adjacent one. Everything a person gets wrong with steppers follows from
// that and is invisible to a model with a `position` property:
//
//   • drive the coils in the wrong order and it turns the wrong way;
//   • skip a phase and it does not move, or judders between two positions;
//   • hold a pattern and it holds position, drawing current, getting warm;
//   • energise nothing and the shaft is free — it does not stay put.
//
// So the model here is a state machine over coil patterns, and the position is
// a count of how far the pattern has walked around the sequence. Firmware pin
// activity is the only input.
//
// The A4988 is different in kind: it has no coils on its input side at all. It
// takes STEP and DIR and does the coil sequencing itself, so it is modelled as
// an edge counter with a microstep divisor — which is what makes wiring MS1-MS3
// actually change how far a given number of steps travels.
//
// NOT modelled: torque, missed steps under load, coil current and the current
// limit a driver's potentiometer sets, holding torque as distinct from moving
// torque, and acceleration ramps. A step commanded is a step taken.

/**
 * The eight coil patterns a rotor can line up with, in order.
 *
 * This is the position ring, and every drive style is a path around it: the
 * half-step sequence visits all eight, full-stepping visits the four two-coil
 * ones, and wave drive visits the four single-coil ones. Working in this single
 * ring rather than in three separate sequences is what lets the model accept
 * whichever style firmware chose without being told — and it is also more
 * faithful, because a full step genuinely moves the rotor two half-step
 * positions rather than one step of a different size.
 */
export const HALF_STEP_SEQUENCE = [
  0b0001, 0b0011, 0b0010, 0b0110, 0b0100, 0b1100, 0b1000, 0b1001,
];

/** Full-step, two coils at a time: the stronger and more common wave. */
export const FULL_STEP_SEQUENCE = [0b0011, 0b0110, 0b1100, 0b1001];

/** Full-step, one coil at a time. */
export const WAVE_SEQUENCE = [0b0001, 0b0010, 0b0100, 0b1000];

export type StepperMode = 'idle' | 'holding' | 'stepping';

/**
 * A coil-driven stepper: 28BYJ-48 through a ULN2003, or a bipolar motor
 * through an H-bridge pair.
 */
export class CoilStepper {
  readonly instanceId: string;
  /** Half-steps for one output revolution, after any gearbox. */
  readonly stepsPerRevolution: number;

  /**
   * Half-step positions moved since reset, signed.
   *
   * Counted in half-steps whatever the drive style, so a full-stepping sketch
   * and a half-stepping one that travel the same distance report the same
   * number — which is what makes `revolutions` mean one thing.
   */
  private steps = 0;
  /** Where in the ring the current pattern sits, or -1 when de-energised. */
  private index = -1;
  private pattern = 0;
  private missed = 0;
  private lastChangeMs = 0;

  constructor(instanceId: string, stepsPerRevolution = 4096) {
    this.instanceId = instanceId;
    this.stepsPerRevolution = stepsPerRevolution;
  }

  /**
   * Applies the four coil levels.
   *
   * Every drive style lands on the same eight-position ring, so nothing has to
   * be told which one firmware chose. An unrecognised pattern is counted rather
   * than guessed at — that is a coil combination the rotor cannot line up with,
   * and it genuinely does not move the shaft.
   */
  setCoils(a: boolean, b: boolean, c: boolean, d: boolean, nowMs: number): void {
    const pattern = (a ? 1 : 0) | (b ? 2 : 0) | (c ? 4 : 0) | (d ? 8 : 0);
    if (pattern === this.pattern) return;
    this.pattern = pattern;
    this.lastChangeMs = nowMs;

    if (pattern === 0) {
      // Nothing energised: the shaft is free and holds nothing.
      this.index = -1;
      return;
    }

    const next = HALF_STEP_SEQUENCE.indexOf(pattern);
    if (next < 0) {
      // Not a pattern the rotor can line up with — both coils of one phase
      // energised against each other, say. It has nowhere to go.
      this.missed++;
      return;
    }
    this.advanceTo(next);
  }

  /**
   * Moves to a new position in the ring, the shortest way round.
   *
   * One position is a half step and two is a full step; the rotor follows
   * both, which is why full-stepping works on real hardware. Three or more
   * means firmware skipped a phase, and the rotor either stays where it is or
   * loses position — so it is counted as a miss rather than credited as fast
   * progress, which is what makes a broken sequence visible instead of just
   * fast.
   */
  private advanceTo(next: number): void {
    if (this.index < 0) {
      this.index = next;
      return;
    }
    const len = HALF_STEP_SEQUENCE.length;
    let delta = next - this.index;
    if (delta > len / 2) delta -= len;
    if (delta <= -len / 2) delta += len;
    if (Math.abs(delta) <= 2 && delta !== 0) {
      this.steps += delta;
    } else if (delta !== 0) {
      this.missed++;
    }
    this.index = next;
  }

  get mode(): StepperMode {
    if (this.pattern === 0) return 'idle';
    return this.index >= 0 ? 'holding' : 'idle';
  }
  get stepCount(): number {
    return this.steps;
  }
  get revolutions(): number {
    return this.steps / this.stepsPerRevolution;
  }
  get angleDegrees(): number {
    const frac = this.revolutions - Math.floor(this.revolutions);
    return frac * 360;
  }
  /** Pattern changes the rotor could not follow. A sign of a broken sequence. */
  get missedTransitions(): number {
    return this.missed;
  }
  /** True while any coil is energised — a stepper holds position when it is. */
  get isHolding(): boolean {
    return this.pattern !== 0;
  }
  get coilPattern(): number {
    return this.pattern;
  }
  get lastChangeAtMs(): number {
    return this.lastChangeMs;
  }

  reset(): void {
    this.steps = 0;
    this.index = -1;
    this.pattern = 0;
    this.missed = 0;
  }
}

/** Microstep resolutions an A4988 offers, by its MS1/MS2/MS3 strapping. */
export const A4988_MICROSTEPS: Record<number, number> = {
  0b000: 1, // full step
  0b001: 2, // half
  0b010: 4, // quarter
  0b011: 8, // eighth
  0b111: 16, // sixteenth
};

/**
 * An A4988-style step/direction driver.
 *
 * The motor's coils are on the driver's far side, so nothing here sequences
 * them: the driver takes an edge on STEP and moves one microstep in the
 * direction DIR is holding. What makes this worth modelling rather than
 * counting pulses is everything around that — ENABLE is active low and a driver
 * left disabled does nothing however many pulses arrive, and the microstep
 * strapping decides how far a given pulse count actually travels.
 */
export class StepDirDriver {
  readonly instanceId: string;
  readonly fullStepsPerRevolution: number;

  /** Microsteps taken, signed. */
  private microsteps = 0;
  private microstepDivisor = 1;
  private direction = 1;
  private enabled = true;
  private stepHigh = false;
  private pulsesWhileDisabled = 0;

  constructor(instanceId: string, fullStepsPerRevolution = 200) {
    this.instanceId = instanceId;
    this.fullStepsPerRevolution = fullStepsPerRevolution;
  }

  /** MS1/MS2/MS3 as wired. Unstrapped pins read low, which is full-step. */
  setMicrostepping(ms1: boolean, ms2: boolean, ms3: boolean): void {
    const code = (ms1 ? 1 : 0) | (ms2 ? 2 : 0) | (ms3 ? 4 : 0);
    this.microstepDivisor = A4988_MICROSTEPS[code] ?? 1;
  }

  /** ENABLE is active low: a floating or high pin leaves the driver off. */
  setEnable(low: boolean): void {
    this.enabled = low;
  }

  setDirection(high: boolean): void {
    this.direction = high ? 1 : -1;
  }

  /** A level on STEP. The motor moves on the rising edge only. */
  setStep(high: boolean): void {
    const rising = !this.stepHigh && high;
    this.stepHigh = high;
    if (!rising) return;
    if (!this.enabled) {
      // Counted rather than ignored: "I sent ten thousand pulses and nothing
      // moved" is the single most common stepper problem, and the reason is
      // almost always this pin.
      this.pulsesWhileDisabled++;
      return;
    }
    this.microsteps += this.direction;
  }

  get microstepCount(): number {
    return this.microsteps;
  }
  get microstepDivisorValue(): number {
    return this.microstepDivisor;
  }
  get isEnabled(): boolean {
    return this.enabled;
  }
  get ignoredPulses(): number {
    return this.pulsesWhileDisabled;
  }
  /** Shaft position in revolutions, accounting for the microstep divisor. */
  get revolutions(): number {
    return this.microsteps / (this.fullStepsPerRevolution * this.microstepDivisor);
  }
  get angleDegrees(): number {
    const frac = this.revolutions - Math.floor(this.revolutions);
    return frac * 360;
  }

  reset(): void {
    this.microsteps = 0;
    this.direction = 1;
    this.enabled = true;
    this.stepHigh = false;
    this.pulsesWhileDisabled = 0;
    this.microstepDivisor = 1;
  }
}
