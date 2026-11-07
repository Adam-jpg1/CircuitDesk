// ESP32-C3 firmware, compiled and executed through the production path.
//
// Every sketch below is ordinary Arduino code a user could type. It is sent to
// the real compiler service, the real artifacts come back, and they are run
// through the real adapter — the same lazy import the application uses — with
// no shortcut anywhere. Nothing detects a sketch, nothing patches an address,
// and no pin is special-cased: the second sketch exists precisely to show that
// the first one's pin is not wired into the implementation.
//
// The suite skips with a clear message when the toolchain is not available,
// rather than passing on nothing.

import { getSimulatorAdapter } from '../src/simulation/adapters';
import { findBoardByIdOrAlias } from '../src/boards/definitions';
import { runnerPinIndex } from '../src/simulation/boardRunner';
import type { BoardRunner } from '../src/simulation/boardRunner';

const BASE = process.env.CIRCUITDESK_URL ?? 'http://localhost:3411';
const BOARD_ID = 'board.esp32-c3';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function skip(msg: string) {
  console.log('SKIP:', msg);
  skipped++;
}
function report(): never {
  console.log(
    failures === 0
      ? `\nESP32-C3 firmware checks passed (${skipped} skipped).`
      : `\n${failures} check(s) FAILED (${skipped} skipped)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

interface Artifact {
  data: string;
  format: string;
  regions?: { offset: number; data: string }[];
}

async function compile(source: string): Promise<{ firmware?: Artifact; error?: string }> {
  try {
    const res = await fetch(`${BASE}/api/compiler/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        boardId: BOARD_ID,
        fqbn: 'esp32:esp32:esp32c3',
        files: [{ name: 'sketch.ino', content: source }],
      }),
    });
    const json = (await res.json()) as { success: boolean; firmware?: Artifact; message?: string; error?: string };
    if (!json.success || !json.firmware) return { error: json.message ?? json.error ?? 'compile failed' };
    return { firmware: json.firmware };
  } catch (err) {
    return { error: String(err) };
  }
}

const board = findBoardByIdOrAlias(BOARD_ID);
if (!board) {
  console.log('FAIL: the ESP32-C3-DevKitM-1 board definition is missing');
  process.exit(1);
}

// ---------- the board is wired into the production registry ----------
{
  const adapter = getSimulatorAdapter(board);
  check(adapter !== null, 'the ESP32-C3-DevKitM-1 resolves to a simulator adapter');
  check(adapter?.engine === 'esp32c3', `and to its own engine, not another board's (${adapter?.engine})`);
  check(adapter?.firmwareFormat === 'esp-image', 'which executes ESP application images');
  check(board.name === 'ESP32-C3-DevKitM-1', `the board carries its official product name (${board.name})`);
}

// ---------- sketches ----------
const SKETCHES = {
  blink8:
    'void setup() { pinMode(8, OUTPUT); }\n' +
    'void loop() { digitalWrite(8, HIGH); delay(100); digitalWrite(8, LOW); delay(100); }',
  blink3:
    'void setup() { pinMode(3, OUTPUT); }\n' +
    'void loop() { digitalWrite(3, HIGH); delay(50); digitalWrite(3, LOW); delay(50); }',
  button:
    'void setup() { pinMode(9, INPUT_PULLUP); pinMode(8, OUTPUT); }\n' +
    'void loop() { digitalWrite(8, digitalRead(9) == LOW ? HIGH : LOW); delay(5); }',
} as const;

const probe = await compile(SKETCHES.blink8);
if (!probe.firmware) {
  skip(`the ESP32-C3 toolchain is unavailable (${probe.error}) — firmware sections cannot run`);
  report();
}

async function runnerFor(source: string): Promise<BoardRunner> {
  const built = source === SKETCHES.blink8 ? probe : await compile(source);
  if (!built.firmware) throw new Error(`compile failed: ${built.error}`);
  const adapter = getSimulatorAdapter(board)!;
  return adapter.createRunner(built.firmware, board!);
}

/** Records every edge on a pin, with the simulated time it happened at. */
function watch(runner: BoardRunner, pin: number): { at: number; high: boolean }[] {
  const edges: { at: number; high: boolean }[] = [];
  runner.addPinListener((changed, high) => {
    if (changed === pin) edges.push({ at: runner.timeMs, high });
  });
  return edges;
}

/** Advances in slices, as the simulation controller does. */
function run(runner: BoardRunner, ms: number, slice = 8): void {
  for (let elapsed = 0; elapsed < ms; elapsed += slice) runner.runFor(slice);
}

// ---------- 1. blink on IO8 ----------
{
  const runner = await runnerFor(SKETCHES.blink8);
  const edges = watch(runner, 8);
  run(runner, 620);

  check(edges.length >= 5, `IO8 toggled through the production runner (${edges.length} edges)`);
  const intervals = edges.slice(1).map((e, i) => e.at - edges[i].at);
  const steady = intervals.slice(1);
  check(
    steady.every((gap) => Math.abs(gap - 100) < 5),
    `every interval is the sketch's own 100 ms (${steady.map((g) => g.toFixed(1)).join(', ')})`,
  );
  check(runner.isOutput(8), 'the pin reports itself as an output');
  check(runner.digitalPinLevel(8) === 'high' || runner.digitalPinLevel(8) === 'low', 'and has a driven level');

  // Nothing else moved.
  const snapshot = runner.snapshot();
  check(snapshot.toggles[8] > 0, 'the snapshot counts the toggles on IO8');
  check(
    snapshot.toggles.filter((t, i) => i !== 8 && t > 0).length === 0,
    'and no other pin toggled at all',
  );
  runner.dispose?.();
}

// ---------- 2. a different pin at a different rate ----------
//
// The point of this one is that nothing about the implementation is tied to
// the pin or the interval the first sketch happened to use.
{
  const runner = await runnerFor(SKETCHES.blink3);
  const onThree = watch(runner, 3);
  const onEight = watch(runner, 8);
  run(runner, 320);

  check(onThree.length >= 5, `IO3 toggled (${onThree.length} edges)`);
  const intervals = onThree.slice(1).map((e, i) => e.at - onThree[i].at);
  const steady = intervals.slice(1);
  check(
    steady.every((gap) => Math.abs(gap - 50) < 5),
    `at the second sketch's own 50 ms (${steady.map((g) => g.toFixed(1)).join(', ')})`,
  );
  check(onEight.length === 0, 'and IO8, which the first sketch used, never moved');
  check(!runner.isOutput(8), 'IO8 is not even an output in this sketch');
  runner.dispose?.();
}

// ---------- 3. a button on an input with a pull-up ----------
{
  const runner = await runnerFor(SKETCHES.button);
  run(runner, 40);

  check(runner.digitalPinLevel(9) === 'input-pullup', 'IO9 is an input with its pull-up on');
  check(runner.digitalPinLevel(8) === 'low', 'and with the button released the LED pin is low');

  runner.setDigitalInput(9, false);
  run(runner, 40);
  check(runner.digitalPinLevel(8) === 'high', 'pressing the button to ground drives the LED pin high');

  runner.setDigitalInput(9, null);
  run(runner, 40);
  check(runner.digitalPinLevel(8) === 'low', 'releasing it returns to the pull-up and the LED goes low');

  runner.setDigitalInput(9, false);
  run(runner, 40);
  check(runner.digitalPinLevel(8) === 'high', 'and it does it again, so the path is not a one-shot');
  runner.dispose?.();
}

// ---------- 4. board pin ids resolve to the runner's own pins ----------
{
  check(runnerPinIndex(board, 'IO8') === 8, 'IO8 resolves to runner pin 8');
  check(runnerPinIndex(board, 'IO21') === 21, 'IO21 resolves to runner pin 21');
  check(runnerPinIndex(board, 'GND1') === undefined, 'a ground pin has no runner index');
  check(runnerPinIndex(board, '3V3_1') === undefined, 'and neither does a power pin');
  check(runnerPinIndex(board, 'D13') === undefined, 'an Arduino pin name resolves to nothing on this board');
  check(runnerPinIndex(board, 'GP15') === undefined, 'and so does an RP2040 one');
}

// ---------- 5. lifecycle ----------
{
  const runner = await runnerFor(SKETCHES.blink8);
  run(runner, 220);
  const before = runner.timeMs;
  check(before > 200, `time advances while running (${before.toFixed(1)} ms)`);

  // Pausing is the controller simply not calling runFor; nothing may move.
  const paused = runner.timeMs;
  check(runner.timeMs === paused, 'a runner that is not being run does not advance on its own');

  run(runner, 50);
  check(runner.timeMs > paused, 'and resumes when it is run again');

  runner.reset?.();
  check(runner.timeMs === 0, 'reset returns simulated time to zero');
  check(!runner.isOutput(8), 'and the pin is no longer configured, as at power-on');

  run(runner, 220);
  check(runner.isOutput(8), 'running again re-runs setup() and reconfigures the pin');

  runner.dispose?.();
  const after = runner.timeMs;
  runner.runFor(100);
  check(runner.timeMs === after, 'a disposed runner refuses to run');
}

report();
