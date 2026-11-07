// The simulated-time event scheduler.
//
// This is the piece that lets a parked processor skip a hundred milliseconds
// of waiting without retiring sixteen million instructions. Getting it wrong
// is not a performance bug — it is a correctness bug, because skipping past an
// event means firmware never sees it, and skipping while the processor is
// still running means instructions are lost. So these cases are about where a
// skip is allowed to land, not about how fast it is.

import { earliestEvent, planIdleSkip, type TimedEventSource } from '../src/simulation/eventScheduler';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

/** A source that fires once at a fixed time. */
const at = (nanos: number | undefined): TimedEventSource => ({ nextEventNanos: () => nanos });

// ---------- 1. finding the earliest event ----------
{
  check(earliestEvent([], 0) === undefined, 'no sources means nothing to wait for');
  check(earliestEvent([at(undefined)], 0) === undefined, 'a source with no scheduled event contributes nothing');
  check(earliestEvent([at(500)], 0) === 500, 'a single source gives its own time');
  check(earliestEvent([at(900), at(300), at(600)], 0) === 300, 'the earliest of several wins');
  check(
    earliestEvent([at(900), at(undefined), at(600)], 0) === 600,
    'a source with nothing scheduled does not mask one that has',
  );

  // A source that is already overdue must not drag the clock backwards.
  check(earliestEvent([at(100)], 1000) === 1000, 'an overdue event collapses to now rather than to the past');
  check(earliestEvent([at(100), at(2000)], 1000) === 1000, 'and still wins against a later one');
}

// ---------- 2. planning a skip ----------
{
  const plan = planIdleSkip([at(5000)], 1000, undefined);
  check(plan.kind === 'advanced' && plan.to === 5000, 'a future event is skipped to exactly');

  check(planIdleSkip([at(1000)], 1000, undefined).kind === 'due', 'an event due now needs no skip');
  check(planIdleSkip([at(200)], 1000, undefined).kind === 'due', 'and neither does one already past');

  // Nothing scheduled and no limit is a machine that can never wake again.
  check(planIdleSkip([], 1000, undefined).kind === 'stalled', 'nothing to wait for at all is reported as a stall');
  check(planIdleSkip([at(undefined)], 0, undefined).kind === 'stalled', 'and so is a source with no event');
}

// ---------- 3. the caller's limit ----------
//
// A runner asked for one slice of simulated time must not have the clock
// disappear a second into the future: an input arriving from the canvas in the
// meantime would be seen far too late, or not at all.
{
  const limited = planIdleSkip([at(1_000_000)], 0, 16_000);
  check(limited.kind === 'limited' && limited.to === 16_000, 'a skip stops at the caller\'s limit');

  const within = planIdleSkip([at(5_000)], 0, 16_000);
  check(within.kind === 'advanced' && within.to === 5_000, 'an event inside the limit is still reached exactly');

  const exact = planIdleSkip([at(16_000)], 0, 16_000);
  check(exact.kind === 'advanced' && exact.to === 16_000, 'an event exactly at the limit is reached, not clipped');

  // With nothing scheduled, a limit still lets time pass up to it, so a run
  // that was asked for a slice of time delivers that slice.
  const idle = planIdleSkip([], 0, 16_000);
  check(idle.kind === 'limited' && idle.to === 16_000, 'an idle machine with a limit runs out its slice');

  // A limit already reached leaves the clock alone.
  check(planIdleSkip([], 16_000, 16_000).kind === 'stalled', 'a limit already reached does not move time');
  check(planIdleSkip([], 20_000, 16_000).kind === 'stalled', 'and neither does one already passed');
}

// ---------- 4. sources are asked afresh every time ----------
//
// A timer's next alarm moves as it fires, so the scheduler must never cache an
// answer it was given earlier.
{
  let calls = 0;
  const moving: TimedEventSource = {
    nextEventNanos: () => {
      calls++;
      return calls * 1000;
    },
  };
  const first = planIdleSkip([moving], 0, undefined);
  const second = planIdleSkip([moving], 0, undefined);
  check(first.kind === 'advanced' && first.to === 1000, 'the first plan uses the first answer');
  check(second.kind === 'advanced' && second.to === 2000, 'and the second plan asks again rather than reusing it');
}

console.log(failures === 0 ? '\nEvent scheduler checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
