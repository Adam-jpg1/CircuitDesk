// The shared timeline's resolution.
//
// The world advances boards in slices, and it would be easy for that slice to
// become the finest resolution anything can communicate at. That would be a
// problem the moment board-to-board UART, I2C or SPI arrive: a bit at 115200
// baud is 8.7 microseconds, and an I2C edge is shorter still. A millisecond
// ceiling would quietly make all of them impossible.
//
// So the slice is a ceiling, not a step. These cases prove the world stops on
// the events inside it.

import { SimulationWorld } from '../src/simulation/simulationWorld';
import type { BoardRunner, PinLevel, PinSnapshot } from '../src/simulation/boardRunner';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

/** A runner that only records how it was advanced. */
class RecordingRunner implements BoardRunner {
  readonly engine = 'avr8js' as const;
  timeMs = 0;
  readonly slices: number[] = [];
  onPinChange: ((pin: number, high: boolean) => void) | null = null;
  onSerialByte: ((byte: number) => void) | null = null;
  /** Simulated ms until this board's next event, or undefined for none. */
  next: number | undefined = undefined;

  runFor(simMs: number): void {
    this.slices.push(simMs);
    this.timeMs += simMs;
    if (this.next !== undefined) this.next = Math.max(0, this.next - simMs);
  }
  nextEventMs(): number | undefined {
    return this.next;
  }
  digitalPinLevel(): PinLevel | undefined {
    return 'low';
  }
  isOutput(): boolean {
    return false;
  }
  setDigitalInput(): void {}
  addPinListener(): () => void {
    return () => {};
  }
  adcChannelForPin(): number | undefined {
    return undefined;
  }
  setAnalogVolts(): void {}
  queueSerialInput(): void {}
  addMicrosecondEvent(): () => void {
    return () => {};
  }
  snapshot(): PinSnapshot {
    return { states: [], duty: [], pulseWidthUs: [], toggles: [] };
  }
}

// ---------- 1. with nothing scheduled, the ceiling applies ----------
{
  const world = new SimulationWorld({ sliceMs: 1 });
  const runner = new RecordingRunner();
  world.add('b1', runner);
  world.runFor(4);

  check(runner.slices.length === 4, `four milliseconds took four slices (${runner.slices.length})`);
  check(
    runner.slices.every((s) => Math.abs(s - 1) < 1e-9),
    'each of them a full millisecond, so the coarse behaviour is unchanged',
  );
  check(Math.abs(world.timeMs - 4) < 1e-9, `and the world advanced exactly four ms (${world.timeMs})`);
}

// ---------- 2. a scheduled event inside a slice is stopped on ----------
//
// This is the case that matters. A quarter of a millisecond is well inside the
// slice, and the world must land on it rather than run past to the boundary.
{
  const world = new SimulationWorld({ sliceMs: 1 });
  const runner = new RecordingRunner();
  world.add('b1', runner);

  let firedAt: number | null = null;
  world.scheduleAt(0.25, () => {
    firedAt = world.timeMs;
  });
  world.runFor(1);

  check(firedAt !== null, 'a sub-millisecond scheduled event fires');
  check(
    firedAt !== null && Math.abs(firedAt - 0.25) < 1e-9,
    `at the time it was scheduled for, not at the slice boundary (${firedAt})`,
  );
  check(runner.slices[0] < 1, `so the first slice was shortened to reach it (${runner.slices[0]})`);
  check(Math.abs(world.timeMs - 1) < 1e-9, 'and the requested millisecond still elapsed in total');
}

// ---------- 3. a board's own event shortens the slice ----------
{
  const world = new SimulationWorld({ sliceMs: 1 });
  const runner = new RecordingRunner();
  runner.next = 0.1;
  world.add('b1', runner);
  world.runFor(1);

  check(
    Math.abs(runner.slices[0] - 0.1) < 1e-9,
    `a board reporting an event in 0.1 ms is advanced only that far (${runner.slices[0]})`,
  );
  check(Math.abs(world.timeMs - 1) < 1e-9, 'and the world still completes the millisecond');
}

// ---------- 4. the earliest of several boards wins ----------
{
  const world = new SimulationWorld({ sliceMs: 1 });
  const fast = new RecordingRunner();
  const slow = new RecordingRunner();
  fast.next = 0.05;
  slow.next = 0.4;
  world.add('fast', fast);
  world.add('slow', slow);
  world.runFor(0.5);

  check(
    Math.abs(fast.slices[0] - 0.05) < 1e-9 && Math.abs(slow.slices[0] - 0.05) < 1e-9,
    `both boards advance to the earliest event, not each to its own (${fast.slices[0]}, ${slow.slices[0]})`,
  );
  check(
    fast.timeMs === slow.timeMs,
    `so no board runs ahead of another (${fast.timeMs} vs ${slow.timeMs})`,
  );
}

// ---------- 5. resolution is bounded, so the browser cannot starve ----------
//
// A board claiming an event every nanosecond must not make the world take
// millions of slices to cross a millisecond.
{
  const world = new SimulationWorld({ sliceMs: 1 });
  const runner = new RecordingRunner();
  runner.next = 0;
  // Keep it permanently due, which is the pathological case.
  runner.nextEventMs = () => 0;
  world.add('b1', runner);
  world.runFor(1);

  check(runner.slices.length <= 200, `a permanently-due board is still bounded (${runner.slices.length} slices)`);
  check(Math.abs(world.timeMs - 1) < 1e-9, 'and the millisecond still completes exactly');
  check(
    runner.slices.every((s) => s > 0),
    'with no zero-length slice, which would not terminate',
  );

  // The floor is still far below any bit period these protocols use.
  const shortest = Math.min(...runner.slices);
  check(shortest <= 0.01 + 1e-9, `the finest slice is ${shortest} ms, under a 115200-baud bit period of 0.0087 ms`);
}

// ---------- 6. a runner that cannot answer costs only resolution ----------
{
  const world = new SimulationWorld({ sliceMs: 1 });
  const runner = new RecordingRunner();
  // Engines that predate this simply do not implement the method.
  (runner as { nextEventMs?: unknown }).nextEventMs = undefined;
  world.add('b1', runner);
  world.runFor(2);

  check(runner.slices.length === 2, 'a runner with no event method still runs on the coarse ceiling');
  check(
    runner.slices.every((s) => Math.abs(s - 1) < 1e-9),
    'in whole slices, exactly as before',
  );
}

console.log(failures === 0 ? '\nTimeline resolution checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
