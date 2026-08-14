// Persistence of vision, for displays that are only ever lit one part at a time.
//
// A four-digit seven-segment module has twelve pins, not twenty-eight: the
// segment lines are shared and each digit's common is enabled in turn, hundreds
// of times a second. At any instant exactly one digit is lit and the other
// three are dark. Read the pins instantaneously and that is what you get — one
// digit, flickering between four positions, which is not what the hardware
// looks like and not what the firmware is doing wrong.
//
// What an eye sees is the average over roughly the last twenty milliseconds. So
// that is what this models: a per-key light level that follows the electrical
// state through a first-order lag, integrated exactly over each interval the
// state was constant.
//
// Two things this is careful about.
//
// It is a VIEW, not a circuit. Nothing here feeds back into net solving, pin
// levels or device state; a segment that is electrically off is electrically
// off, and only its apparent brightness is smoothed. The electrical model must
// stay exact or every test built on it becomes approximate.
//
// It integrates on edges rather than sampling. A four-digit scan at 1 kHz gives
// each digit 250 us — a quarter of a single simulation slice — so sampling once
// per slice would alias the scan into nonsense. Feeding it the exact times the
// state changed makes the level correct however fast the scan is, and costs
// nothing when nothing is changing.

/**
 * Flicker-fusion time constant, in simulated milliseconds.
 *
 * Eight milliseconds puts the 10%-to-90% response at about eighteen, which is
 * the region where a scanned display stops looking like a scan. Slower would
 * hide a genuinely too-slow refresh; faster would show the flicker the eye does
 * not see.
 */
export const PERSISTENCE_TAU_MS = 8;

/**
 * Below this, a light is reported as off.
 *
 * Without a floor an element decays asymptotically and never quite reaches
 * zero, so a digit that stopped being scanned would stay faintly lit forever.
 * One part in a hundred is far below anything visible.
 */
const DARK_FLOOR = 0.01;

interface Element {
  /** Electrical state, exactly as the circuit last reported it. */
  on: boolean;
  /** Apparent brightness, 0..1. */
  level: number;
  /** Simulated time the state was last integrated to. */
  atMs: number;
}

export class PersistenceTracker {
  private readonly tau: number;
  private elements = new Map<string, Element>();

  constructor(tauMs: number = PERSISTENCE_TAU_MS) {
    this.tau = tauMs;
  }

  /**
   * Records the electrical state of one element at a known time.
   *
   * Call whenever the circuit settles — including on the pin edges a scan
   * produces, which is where the accuracy comes from. Calling it repeatedly
   * with an unchanged state is harmless and cheap.
   */
  set(key: string, on: boolean, nowMs: number): void {
    const el = this.elements.get(key);
    if (!el) {
      // First sight of this element. A light that is already on when we start
      // watching is taken at face value rather than faded up from nothing,
      // which would make the first frame of a static display look wrong.
      this.elements.set(key, { on, level: on ? 1 : 0, atMs: nowMs });
      return;
    }
    this.integrate(el, nowMs);
    el.on = on;
  }

  /** Apparent brightness now, 0..1. Advances the integration without changing state. */
  level(key: string, nowMs: number): number {
    const el = this.elements.get(key);
    if (!el) return 0;
    this.integrate(el, nowMs);
    return el.level;
  }

  /** True when the element is bright enough to read as lit. */
  isLit(key: string, nowMs: number): boolean {
    return this.level(key, nowMs) > DARK_FLOOR;
  }

  /**
   * Advances one element to `nowMs`.
   *
   * Exact for a piecewise-constant input: over an interval where the state did
   * not change, a first-order lag converges toward it as 1 - exp(-dt/tau), so
   * one evaluation per interval is the closed form rather than an approximation
   * of one.
   */
  private integrate(el: Element, nowMs: number): void {
    const dt = nowMs - el.atMs;
    if (dt <= 0) return;
    el.atMs = nowMs;
    const target = el.on ? 1 : 0;
    const decay = Math.exp(-dt / this.tau);
    el.level = target + (el.level - target) * decay;
    if (el.level < DARK_FLOOR && target === 0) el.level = 0;
  }

  /** Every element's brightness, for a renderer that wants the whole panel. */
  snapshot(keys: readonly string[], nowMs: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const key of keys) out[key] = this.level(key, nowMs);
    return out;
  }

  /** Drops an element, e.g. when its part leaves the canvas. */
  forget(prefix: string): void {
    for (const key of [...this.elements.keys()]) {
      if (key === prefix || key.startsWith(`${prefix}#`)) this.elements.delete(key);
    }
  }

  clear(): void {
    this.elements.clear();
  }
}
