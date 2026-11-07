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

// ---------- 5. real protocol timings are representable ----------
//
// These are the numbers that matter. A 115200-baud bit period is 8681 ns, an
// I2C fast-mode edge is shorter, and an SPI clock at 4 MHz has 125 ns half
// periods. A scheduler that cannot stop on them cannot carry those protocols
// however well the rest of it is built.
{
  const cases: [string, number][] = [
    ['a 115200-baud bit period', 8_681],
    ['one microsecond', 1_000],
    ['a 4 MHz SPI half period', 125],
    ['a single 160 MHz CPU cycle', 6],
  ];
  for (const [label, ns] of cases) {
    const world = new SimulationWorld({ sliceMs: 1 });
    const runner = new RecordingRunner();
    world.add('b1', runner);
    let firedAt: number | null = null;
    world.scheduleAtNs(ns, () => {
      firedAt = world.timeNs;
    });
    world.runFor(1);
    check(firedAt === ns, `${label} (${ns} ns) is landed on exactly (fired at ${firedAt})`);
  }
}

// ---------- 6. closely spaced and simultaneous events ----------
{
  const world = new SimulationWorld({ sliceMs: 1 });
  world.add('b1', new RecordingRunner());

  const order: string[] = [];
  // Three at the same instant, scheduled out of order, plus two adjacent ones.
  world.scheduleAtNs(5_000, () => order.push('c'));
  world.scheduleAtNs(2_000, () => order.push('a1'));
  world.scheduleAtNs(2_000, () => order.push('a2'));
  world.scheduleAtNs(2_001, () => order.push('b'));
  world.scheduleAtNs(2_000, () => order.push('a3'));
  world.runFor(1);

  check(order.join(',') === 'a1,a2,a3,b,c', `events run in time then scheduling order (${order.join(',')})`);

  // One nanosecond apart must still be two distinct moments.
  const world2 = new SimulationWorld({ sliceMs: 1 });
  world2.add('b1', new RecordingRunner());
  const times: number[] = [];
  world2.scheduleAtNs(1_000, () => times.push(world2.timeNs));
  world2.scheduleAtNs(1_001, () => times.push(world2.timeNs));
  world2.runFor(1);
  check(times.join(',') === '1000,1001', `events one nanosecond apart stay distinct (${times.join(',')})`);
}

// ---------- 7. a permanently-due source is bounded without distorting time ----------
//
// The protection is a count, not a minimum slice. Forcing the clock forward by
// a fixed amount would make that amount the finest resolution anything could
// communicate at, which is the mistake this whole section exists to avoid.
{
  const world = new SimulationWorld({ sliceMs: 1 });
  const runner = new RecordingRunner();
  runner.nextEventMs = () => 0;
  world.add('b1', runner);
  const started = Date.now();
  world.runFor(2);

  check(Date.now() - started < 2_000, 'a permanently-due board does not hang the run');
  check(world.timeNs === 2_000_000, `and simulated time is exactly right, not inflated (${world.timeNs} ns)`);
  check(
    runner.slices.every((s) => s > 0),
    'with no zero-length slice, which would not terminate',
  );
  check(runner.slices.length < 500, `bounded by a step count (${runner.slices.length} slices)`);
}

// ---------- 8. a runner that cannot answer costs only resolution ----------
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

// Power-up. The circuit is on the pins before the first instruction: a
// sketch that reads a joystick in its first millisecond must see the stick's
// voltage, not 0 V. So the world resolves the nets once before the first
// slice, and again after a reset — and only then.
{
  const world = new SimulationWorld({ sliceMs: 1 });
  const runner = new RecordingRunner();
  world.add('b1', runner);
  const order: string[] = [];
  const run = runner.runFor.bind(runner);
  runner.runFor = (ms: number) => {
    order.push('run');
    run(ms);
  };
  world.settle = () => order.push('settle');
  world.runFor(2);
  check(order[0] === 'settle', `the circuit is resolved before the first slice runs (${order.slice(0, 3).join(', ')})`);
  check(order.filter((o) => o === 'settle').length === 3, 'and after that once per slice, as before');
  order.length = 0;
  world.runFor(1);
  check(order[0] === 'run', 'later calls do not add an extra settle');
  world.reset();
  order.length = 0;
  world.runFor(1);
  check(order[0] === 'settle', 'a reset is a fresh power-up');
}

console.log(failures === 0 ? '\nTimeline resolution checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
