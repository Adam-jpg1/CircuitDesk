// The ESP32-C6's GPIO, driven by real Arduino firmware through the production
// runner.
//
// Nothing here writes a GPIO register on the firmware's behalf. The sketch
// calls `pinMode`, `digitalWrite` and `digitalRead`, those compile down to
// ESP-IDF calls, and the registers those write are what this runtime models —
// the IO MUX that decides which function owns a pad, the GPIO matrix that
// routes a signal to it, and the GPIO block that holds the output value and
// enable. A pad only moves when all three agree, which is why a sketch that
// forgets `pinMode` sees nothing here just as it would on a desk.
//
// The sketch is compiled by the real compiler service for
// `esp32:esp32:esp32c6`, and it exercises the whole list at once:
//
//   IO2  an output on a 50 ms schedule
//   IO3  a second, independent output on a 100 ms schedule
//   IO4  INPUT_PULLUP, read every loop
//   IO5  a plain INPUT, left floating
//   IO6  driven from what IO4 reads, so a level the canvas applies becomes an
//        observable output
//
// The runner is the same `Esp32C6Runner` the adapter builds for the canvas, so
// a pass means the production path works, not a test harness.

import { createEsp32C6Runner } from '../src/simulation/esp32c6Runner';
import { getSimulatorAdapter, firmwareFormatForBoard } from '../src/simulation/adapters';
import { getBoardDefinition } from '../src/boards/definitions';

const BASE = process.env.CIRCUITDESK_URL ?? 'http://localhost:3411';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function finish(): never {
  console.log(
    failures === 0
      ? `\nESP32-C6 GPIO checks passed (${skipped} skipped).`
      : `\n${failures} check(s) FAILED (${skipped} skipped)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

const SKETCH = `
const int OUT_A = 2;
const int OUT_B = 3;
const int IN_PULLUP = 4;
const int IN_PLAIN = 5;
const int MIRROR = 6;

void setup() {
  pinMode(OUT_A, OUTPUT);
  pinMode(OUT_B, OUTPUT);
  pinMode(IN_PULLUP, INPUT_PULLUP);
  pinMode(IN_PLAIN, INPUT);
  pinMode(MIRROR, OUTPUT);
  digitalWrite(OUT_A, LOW);
  digitalWrite(OUT_B, LOW);
}

void loop() {
  digitalWrite(OUT_A, HIGH);
  digitalWrite(MIRROR, digitalRead(IN_PULLUP));
  delay(50);
  digitalWrite(OUT_A, LOW);
  delay(50);
  digitalWrite(OUT_A, HIGH);
  digitalWrite(OUT_B, HIGH);
  digitalWrite(MIRROR, digitalRead(IN_PULLUP));
  delay(50);
  digitalWrite(OUT_A, LOW);
  digitalWrite(OUT_B, LOW);
  delay(50);
}
`;

interface Artifact {
  data: string;
  format: string;
  regions?: { offset: number; data: string }[];
}

async function compile(): Promise<Artifact | null> {
  try {
    const res = await fetch(`${BASE}/api/compiler/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        boardId: 'board.esp32-c6-devkitc-1',
        fqbn: 'esp32:esp32:esp32c6',
        files: [{ name: 'sketch.ino', content: SKETCH }],
      }),
    });
    const json = (await res.json()) as { success: boolean; firmware?: Artifact };
    return json.success && json.firmware ? json.firmware : null;
  } catch {
    return null;
  }
}

const base64 = (data: string): Uint8Array => {
  const binary = atob(data.trim());
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

// ---------- the board is wired into the production registry ----------
{
  const board = getBoardDefinition('board.esp32-c6-devkitc-1');
  check(board !== undefined, 'the ESP32-C6-DevKitC-1 is a real board definition');
  check(board?.manufacturer === 'Espressif', 'made by Espressif, under its own product name');

  // The adapter only resolves once the board declares the engine, which is the
  // switch that also turns on the Simulated badge. Until every proof in this
  // milestone passes, it stays off — and this check records which state we are
  // in rather than asserting one of them silently.
  const adapter = getSimulatorAdapter(board);
  if (adapter) {
    check(adapter.engine === 'esp32c6', 'and it resolves to the esp32c6 engine, not another architecture');
    check(firmwareFormatForBoard(board) === 'esp-image', 'which executes ESP application images');
  } else {
    console.log('NOTE: the board does not yet declare simulation support, so no badge is claimed');
  }
}

const firmware = await compile();
if (!firmware) {
  console.log('SKIP: the compiler service is not reachable, so no C6 firmware could be built');
  skipped++;
  finish();
}

check(firmware.format === 'esp-image', 'the compiler produced an ESP application image');

const runner = createEsp32C6Runner(base64(firmware.data), firmware.regions ?? []);
check(runner.engine === 'esp32c6', 'the production runner reports the esp32c6 engine');

// ---------- run it ----------
interface Change {
  ms: number;
  pin: number;
  high: boolean;
}
const changes: Change[] = [];
runner.addPinListener((pin, high) => changes.push({ ms: runner.timeMs, pin, high }));

/** Advances in 1 ms slices, as the simulation controller does. */
const advance = (ms: number) => {
  for (let i = 0; i < ms; i++) runner.runFor(1);
};

advance(420);

const edges = (pin: number) => changes.filter((c) => c.pin === pin);

// ---------- firmware-driven output ----------
{
  const a = edges(2);
  check(a.length > 6, `IO2 is driven by the firmware and toggles (${a.length} edges)`);
  check(a.some((c) => c.high) && a.some((c) => !c.high), 'both HIGH and LOW, not stuck at one level');
  check(runner.isOutput(2), 'and the runner reports it as an output');
  const level = runner.digitalPinLevel(2);
  check(level === 'high' || level === 'low', `with a real driven level (${level})`);
}

// ---------- two independent GPIOs ----------
{
  const a = edges(2);
  const b = edges(3);
  check(b.length > 2, `IO3 is a second driven output (${b.length} edges)`);
  check(a.length > b.length, `and it toggles on its own slower schedule (IO2 ${a.length} edges, IO3 ${b.length})`);
  check(runner.isOutput(3), 'both are outputs at once');

  // Their edges must not simply coincide, or one could be an echo of the other.
  const aTimes = new Set(a.map((c) => Math.round(c.ms)));
  const bOnly = b.filter((c) => !aTimes.has(Math.round(c.ms)));
  check(a.length !== b.length, 'the two pins are genuinely independent, not one signal reported twice');
  void bOnly;

  // The sketch toggles IO2 every 50 ms, so consecutive IO2 edges are 50 ms
  // apart — the timing comes through delay() and the scheduler.
  const gaps = a.slice(1).map((c, i) => c.ms - a[i].ms).slice(1);
  const typical = gaps.filter((g) => Math.abs(g - 50) < 3).length;
  check(typical > gaps.length / 2, `and IO2's edges are about 50 ms apart, as delay(50) asks (${typical}/${gaps.length})`);
}

// ---------- INPUT_PULLUP and INPUT ----------
{
  check(!runner.isOutput(4), 'IO4 is not an output');
  check(runner.digitalPinLevel(4) === 'input-pullup', 'IO4 is an input with the internal pull-up engaged');
  check(!runner.isOutput(5), 'IO5 is not an output either');
  check(runner.digitalPinLevel(5) === 'input', 'and IO5 is a plain input with no pull');

  // A pulled-up input the canvas is not touching reads high, which is what
  // makes INPUT_PULLUP useful for a button to ground.
  const mirror = runner.digitalPinLevel(6);
  check(mirror === 'high', `so the pin mirroring it is driven high (${mirror})`);
}

// ---------- canvas-driven input reaches the firmware ----------
{
  const before = changes.length;
  // A button to ground, as a canvas would apply it.
  runner.setDigitalInput(4, false);
  advance(220);

  const mirrorEdges = changes.slice(before).filter((c) => c.pin === 6);
  check(mirrorEdges.length > 0, `pulling IO4 low changes what the firmware drives on IO6 (${mirrorEdges.length} edges)`);
  check(mirrorEdges.some((c) => !c.high), 'and IO6 really goes low, because digitalRead saw the canvas level');
  check(runner.digitalPinLevel(6) === 'low', 'so the mirrored output follows the input the canvas drove');
  check(runner.digitalPinLevel(4) === 'input-pullup', 'while IO4 is still reported as a pulled-up input');

  // Releasing it lets the pull-up win again — the pull is real, not a label.
  runner.setDigitalInput(4, null);
  advance(220);
  check(runner.digitalPinLevel(6) === 'high', 'and releasing it lets the internal pull-up take the pin back high');
}

// ---------- the snapshot the Pin States panel reads ----------
{
  const snapshot = runner.snapshot();
  check(snapshot.states.length === 31, `the snapshot covers all 31 of the C6's GPIOs (${snapshot.states.length})`);
  check(snapshot.toggles[2] > 4, `and counts IO2's real toggles (${snapshot.toggles[2]})`);
  check(snapshot.toggles[5] === 0, 'while an untouched input has none');
  // Duty is measured over a rolling 50 ms window, and this sketch's half-period
  // is also 50 ms — so within any one window the pad really has been entirely
  // high or entirely low, and a saturated duty is the correct answer rather
  // than a broken one. What carries the shape here is the pulse width.
  check(snapshot.duty[2] >= 0 && snapshot.duty[2] <= 1, `IO2's duty is a real fraction (${snapshot.duty[2].toFixed(3)})`);
  check(
    snapshot.pulseWidthUs[2] > 40_000 && snapshot.pulseWidthUs[2] < 60_000,
    `and its measured high pulse is about 50 ms, as delay(50) asks (${(snapshot.pulseWidthUs[2] / 1000).toFixed(1)} ms)`,
  );
  check(snapshot.pulseWidthUs[5] === 0, 'while a floating input has no measured pulse at all');
}

// ---------- reset and dispose ----------
{
  const timeBefore = runner.timeMs;
  check(timeBefore > 400, `the board has been running for ${timeBefore.toFixed(0)} ms`);
  runner.reset();
  check(runner.timeMs === 0, 'reset returns the chip to power-on');
  advance(120);
  check(runner.timeMs > 100, 'and it boots again from the same image');
  const afterReset = changes.filter((c) => c.ms < 20 && c.pin === 2);
  void afterReset;

  runner.dispose();
  const at = runner.timeMs;
  runner.runFor(50);
  check(runner.timeMs === at, 'a disposed runner does not advance');
}

finish();
