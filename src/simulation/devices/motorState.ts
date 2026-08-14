// What a motor is doing, derived from the voltage across its terminals.
//
// The shortcut every simulator is tempted by is a `speed` property on the part,
// or an RPM the firmware sets. Both make a motor that spins when the code says
// so rather than when the circuit says so, which means a missing ground, a
// backwards H-bridge, or a driver whose enable pin was never brought high all
// look identical to a working one.
//
// So there is no speed input here. A motor has two terminals; the model reads
// what is on them and works out the rest:
//
//   • the difference in volts is the drive, and its sign is the direction;
//   • the magnitude, normalised against the part's rated voltage, is how hard;
//   • below a stall threshold it does not turn at all, because a real motor
//     needs some minimum to overcome its own friction;
//   • a terminal that is floating is not a terminal at 0 V, so a motor with one
//     wire off does nothing rather than half of something.
//
// Shaft angle is integrated from that, which is what an encoder needs. This is a
// behavioural model and says so: there is no inertia, no back-EMF, no torque
// and no load. Those need the analog solver, and claiming them without it would
// be the same lie in a different place.

/** What the model reports about a motor at one instant. */
export interface MotorState {
  /** 'stopped' | 'forward' | 'reverse' — the sign of the drive, named. */
  direction: 'stopped' | 'forward' | 'reverse';
  /** 0..1, how hard it is being driven relative to its rating. */
  magnitude: number;
  /** Signed volts across the terminals: positive drives forward. */
  volts: number;
  /** True when both terminals are actually connected to something. */
  connected: boolean;
}

/**
 * Below this fraction of the rated voltage, the shaft does not move.
 *
 * Real small DC motors need roughly a fifth of their rating before friction
 * gives way. It matters because it is why a PWM duty of 10% does nothing on a
 * bench, and a model without it would happily creep.
 */
export const STALL_FRACTION = 0.18;

export class MotorModel {
  readonly instanceId: string;
  /** Nameplate voltage — the magnitude is relative to this. */
  ratedVolts: number;
  /** Revolutions per minute at the rated voltage, for angle integration. */
  ratedRpm: number;

  private state: MotorState = { direction: 'stopped', magnitude: 0, volts: 0, connected: false };
  /** Shaft position in revolutions, signed and unbounded. */
  private revolutions = 0;
  private lastMs: number | null = null;

  constructor(instanceId: string, ratedVolts = 6, ratedRpm = 200) {
    this.instanceId = instanceId;
    this.ratedVolts = ratedVolts;
    this.ratedRpm = ratedRpm;
  }

  /**
   * Applies the terminal voltages at a known time.
   *
   * `null` for a terminal means it reaches nothing — floating, not zero. That
   * distinction is the whole reason a motor with one lead disconnected does
   * nothing here.
   */
  update(plusVolts: number | null, minusVolts: number | null, nowMs: number): void {
    // Integrate the shaft with the OLD state before adopting the new one: the
    // motor was turning at the previous rate for the interval that just ended.
    if (this.lastMs !== null && nowMs > this.lastMs) {
      const dtMin = (nowMs - this.lastMs) / 60_000;
      const rpm = this.signedFraction() * this.ratedRpm;
      this.revolutions += rpm * dtMin;
    }
    this.lastMs = nowMs;

    if (plusVolts === null || minusVolts === null) {
      this.state = { direction: 'stopped', magnitude: 0, volts: 0, connected: false };
      return;
    }
    const volts = plusVolts - minusVolts;
    const fraction = Math.min(Math.abs(volts) / this.ratedVolts, 1);
    if (fraction < STALL_FRACTION) {
      this.state = { direction: 'stopped', magnitude: 0, volts, connected: true };
      return;
    }
    this.state = {
      direction: volts > 0 ? 'forward' : 'reverse',
      magnitude: fraction,
      volts,
      connected: true,
    };
  }

  /** Signed drive fraction: negative for reverse, zero when stalled. */
  private signedFraction(): number {
    if (this.state.direction === 'stopped') return 0;
    return this.state.direction === 'forward' ? this.state.magnitude : -this.state.magnitude;
  }

  get current(): MotorState {
    return this.state;
  }
  get direction(): MotorState['direction'] {
    return this.state.direction;
  }
  get magnitude(): number {
    return this.state.magnitude;
  }
  get isTurning(): boolean {
    return this.state.direction !== 'stopped';
  }
  /** Shaft position in revolutions, signed. Integrated, not injected. */
  get position(): number {
    return this.revolutions;
  }
  /** Shaft angle within one turn, 0..360, for the canvas. */
  get angleDegrees(): number {
    const frac = this.revolutions - Math.floor(this.revolutions);
    return frac * 360;
  }

  reset(): void {
    this.state = { direction: 'stopped', magnitude: 0, volts: 0, connected: false };
    this.revolutions = 0;
    this.lastMs = null;
  }
}

/**
 * A quadrature encoder riding on a motor shaft.
 *
 * The two channels are 90 degrees apart, which is what lets firmware tell
 * direction from the order the edges arrive in. Both channels are derived from
 * the same shaft position the motor model integrates, so a motor that is not
 * turning produces no pulses and a motor running backwards produces them in the
 * other order — neither of which a "pulse count" property could do.
 */
export class QuadratureEncoder {
  /** Pulses per revolution, per channel. */
  readonly ppr: number;

  constructor(ppr = 20) {
    this.ppr = ppr;
  }

  /** Channel A level for a shaft position in revolutions. */
  channelA(revolutions: number): boolean {
    return this.square(revolutions, 0);
  }

  /** Channel B, a quarter cycle behind A. */
  channelB(revolutions: number): boolean {
    return this.square(revolutions, 0.25);
  }

  private square(revolutions: number, phase: number): boolean {
    const cycles = revolutions * this.ppr + phase;
    const frac = cycles - Math.floor(cycles);
    return frac < 0.5;
  }

  /** Total edges on one channel over a span, for tests and the inspector. */
  edgeCount(fromRevolutions: number, toRevolutions: number): number {
    return Math.abs(Math.floor(toRevolutions * this.ppr * 2) - Math.floor(fromRevolutions * this.ppr * 2));
  }
}
