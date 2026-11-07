// A simulated-time event scheduler, independent of any particular chip.
//
// Every interpreter CircuitDesk runs has the same problem: firmware spends
// most of its life waiting. A FreeRTOS idle task sits in a wait-for-interrupt
// instruction until the next tick; an AVR sketch spins in a delay loop; a
// sensor driver polls a ready bit that hardware will set in a millisecond.
// Retiring one instruction per CPU cycle through that wait is exact and
// completely wasteful — a hundred milliseconds of idling on a 160 MHz part is
// sixteen million steps that do nothing.
//
// The fix is to notice that while the processor is genuinely parked, nothing
// can change except by the passage of time, and the things time can change all
// know when they will next do so. A timer knows when its comparator fires; a
// pending input knows when it arrives. So the machine asks them, jumps the
// clock straight to the earliest of those moments, and resumes.
//
// This module holds only that idea. It knows nothing about interrupts,
// registers or instruction sets, so an ESP32-C6, an ESP32-H2 or any other
// event-driven runtime can use it without change.

/** Something whose state changes at a known future moment on its own. */
export interface TimedEventSource {
  /**
   * Simulated nanoseconds at which this source next changes state, or
   * undefined when only something else acting on it can change it.
   *
   * A value in the past means "already due"; the scheduler treats that as now
   * rather than skipping backwards.
   */
  nextEventNanos(): number | undefined;
}

/** Why a fast-forward stopped where it did, for diagnostics and tests. */
export type IdleSkipOutcome =
  /** Time was advanced to the next event. */
  | { kind: 'advanced'; to: number }
  /** An event was already due, so no time needed to pass. */
  | { kind: 'due' }
  /** A caller-imposed limit was reached before any event. */
  | { kind: 'limited'; to: number }
  /** Nothing can ever wake the machine again. */
  | { kind: 'stalled' };

/**
 * Finds the earliest moment any source will act.
 *
 * Sources that report a time already passed collapse to `now`, so a caller
 * that has fallen behind catches up rather than jumping backwards.
 */
export function earliestEvent(sources: Iterable<TimedEventSource>, now: number): number | undefined {
  let soonest: number | undefined;
  for (const source of sources) {
    const at = source.nextEventNanos();
    if (at === undefined) continue;
    const bounded = Math.max(at, now);
    if (soonest === undefined || bounded < soonest) soonest = bounded;
  }
  return soonest;
}

/**
 * Works out how far a parked machine may skip.
 *
 * `limit` is the latest time the caller will allow — a runner asked for one
 * frame's worth of simulated time must not disappear a second into the future,
 * because an input arriving from the canvas in the meantime would be seen far
 * too late. Passing undefined means no limit.
 */
export function planIdleSkip(
  sources: Iterable<TimedEventSource>,
  now: number,
  limit: number | undefined,
): IdleSkipOutcome {
  const next = earliestEvent(sources, now);
  if (next === undefined) {
    // Nothing will ever change on its own. Whether that is a firmware bug or
    // simply a machine waiting for a person to press a button is not something
    // this module can know, so it says what it observed and lets the caller
    // decide.
    return limit !== undefined && limit > now ? { kind: 'limited', to: limit } : { kind: 'stalled' };
  }
  if (next <= now) return { kind: 'due' };
  if (limit !== undefined && limit < next) return { kind: 'limited', to: limit };
  return { kind: 'advanced', to: next };
}
