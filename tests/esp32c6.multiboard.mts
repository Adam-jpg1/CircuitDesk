// The ESP32-C6 on a shared canvas with other boards, over real wires.
//
// Every board here runs its own real compiled firmware in its own runner, and
// the only thing that passes between them is a net level — because that is what
// passes between two chips on a bench. Nothing copies state from one runner to
// another, no runner knows another exists, and no Arduino call is intercepted.
// If a board reacts, its pad read a wire another board's pad drove.
//
// The chain proven in each direction is:
//
//   real firmware -> modelled GPIO -> shared electrical net -> modelled GPIO
//   -> real firmware -> observable canvas state
//
// It also proves the thing that is easy to get wrong and invisible when it is:
// two boards of the *same type* are two independent machines. A workspace with
// two Picos in it must run two CPUs, not one CPU reported twice.

import { getSimulatorAdapter } from '../src/simulation/adapters';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { SimulationWorld } from '../src/simulation/simulationWorld';
import { getBoardDefinition } from '../src/boards/definitions';
import { buildPinStatesModel } from '../src/simulation/pinStatesModel';
import { emptyProject } from '../src/project/templates';
import type { BoardRunner } from '../src/simulation/boardRunner';
import type { CircuitProject, ComponentInstance } from '../src/types';

const BASE = process.env.CIRCUITDESK_URL ?? 'http://localhost:3411';
const C6 = 'board.esp32-c6-devkitc-1';
const PICO = 'board.raspberry-pi-pico';

const FQBN: Record<string, string> = {
  [C6]: 'esp32:esp32:esp32c6',
  [PICO]: 'rp2040:rp2040:rpipico',
};

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
function finish(): never {
  console.log(
    failures === 0
      ? `\nESP32-C6 multi-board checks passed (${skipped} skipped).`
      : `\n${failures} check(s) FAILED (${skipped} skipped)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

interface Artifact {
  data: string;
  format: string;
  regions?: { offset: number; data: string }[];
}

const cache = new Map<string, Artifact>();

/**
 * Compiles through the real service, retrying a dropped connection.
 *
 * Only a success is cached: a transient miss must not poison the rest of the
 * run, and a cached null once turned a whole section into a skip that looked
 * like a missing toolchain. The retry exists because a cold cross-compile can
 * outlast the connection, which is a property of the test environment rather
 * than of anything being tested.
 */
async function compile(boardId: string, source: string): Promise<Artifact | null> {
  const key = `${boardId}:${source}`;
  const cached = cache.get(key);
  if (cached) return cached;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/api/compiler/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boardId, fqbn: FQBN[boardId], files: [{ name: 'sketch.ino', content: source }] }),
      });
      const json = (await res.json()) as { success: boolean; firmware?: Artifact; error?: string };
      if (json.success && json.firmware) {
        cache.set(key, json.firmware);
        return json.firmware;
      }
      console.log(`   (compile for ${boardId} failed: ${json.error ?? 'no reason given'})`);
      return null;
    } catch (e) {
      if (attempt === 3) {
        console.log(`   (compile request for ${boardId} kept dropping: ${(e as Error).message})`);
        return null;
      }
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  return null;
}

let nextId = 0;
const id = (p: string) => `${p}${++nextId}`;

interface BoardSpec {
  boardId: string;
  source: string;
}
type Wire = [string, string, string, string];

/**
 * Builds a project the way the canvas would, then a world from it.
 *
 * Board instances are named by the caller and kept distinct, because instance
 * identity is the whole point: two entries with the same `boardId` are two
 * different boards, not one board mentioned twice.
 */
async function buildWorld(
  boards: Record<string, BoardSpec>,
  parts: { defId: string; props?: Record<string, unknown> }[],
  wire: (partIds: string[]) => Wire[],
): Promise<{ world: SimulationWorld; binding: CircuitBinding; partIds: string[] } | null> {
  const project = emptyProject('c6-multi-board');
  for (const [instanceId, spec] of Object.entries(boards)) {
    project.boardInstances.push({
      id: instanceId,
      definitionId: spec.boardId,
      x: 100,
      y: 100,
      rotation: 0,
      properties: {},
      simulationState: {},
    } as ComponentInstance);
  }
  const partIds: string[] = [];
  for (const part of parts) {
    const instId = id('c');
    partIds.push(instId);
    project.componentInstances.push({
      id: instId,
      definitionId: part.defId,
      x: 300,
      y: 100,
      rotation: 0,
      properties: part.props ?? {},
      simulationState: {},
    } as ComponentInstance);
  }
  for (const [a, ap, b, bp] of wire(partIds)) {
    project.connections.push({
      id: id('w'),
      sourceComponentId: a,
      sourcePinId: ap,
      targetComponentId: b,
      targetPinId: bp,
      netId: '',
      color: '#e8590c',
      points: [],
      routing: 'smooth',
    } as CircuitProject['connections'][number]);
  }

  const world = new SimulationWorld({ sliceMs: 1 });
  for (const [instanceId, spec] of Object.entries(boards)) {
    const built = await compile(spec.boardId, spec.source);
    if (!built) { console.log(`   (no artifact for ${spec.boardId})`); return null; }
    const board = getBoardDefinition(spec.boardId)!;
    const adapter = getSimulatorAdapter(board);
    if (!adapter) { console.log(`   (no adapter for ${spec.boardId})`); return null; }
    try {
      const runner: BoardRunner = await adapter.createRunner(built, board);
      world.add(instanceId, runner);
    } catch (e) {
      console.log(`   (createRunner failed for ${spec.boardId}: ${(e as Error).message})`);
      return null;
    }
  }
  const binding = new CircuitBinding(project, world.boards[0].runner, world.runnerMap());
  world.settle = () => binding.update(emptyControls());
  return { world, binding, partIds };
}

// ---------- the C6 is a simulated board at all ----------
{
  const board = getBoardDefinition(C6);
  check(board !== undefined, 'the ESP32-C6-DevKitC-1 exists');
  check(getSimulatorAdapter(board)?.engine === 'esp32c6', 'and resolves to the esp32c6 engine');
  check(board?.manufacturer === 'Espressif', 'under its real manufacturer');
}

const probe = await compile(C6, 'void setup(){}\nvoid loop(){}');
if (!probe) {
  skip('the ESP32-C6 toolchain is unavailable — multi-board sections cannot run');
  finish();
}

// ---------- A. C6 drives, Pico reacts, LED lights ----------
//
//   C6 IO2 -> wire -> Pico GP16 -> Pico firmware -> Pico GP15 -> resistor -> LED
{
  const c6 = id('b');
  const pico = id('b');
  const built = await buildWorld(
    {
      [c6]: {
        boardId: C6,
        source:
          'void setup() { pinMode(2, OUTPUT); }\n' +
          'void loop() { digitalWrite(2, HIGH); delay(40); digitalWrite(2, LOW); delay(40); }',
      },
      [pico]: {
        boardId: PICO,
        source: 'void setup() { pinMode(16, INPUT); pinMode(15, OUTPUT); }\n' + 'void loop() { digitalWrite(15, digitalRead(16)); }',
      },
    },
    [{ defId: 'comp.resistor', props: { resistance: 220 } }, { defId: 'comp.led', props: { color: 'red' } }],
    ([resistorId, ledId]) => [
      [c6, 'IO2', pico, 'GP16'],
      [c6, 'GND1', pico, 'GND3'],
      [pico, 'GP15', resistorId, 'p1'],
      [resistorId, 'p2', ledId, 'anode'],
      [ledId, 'cathode', pico, 'GND7'],
    ],
  );

  if (!built) {
    skip('one of the two sketches did not compile');
  } else {
    const { world, binding, partIds } = built;
    const ledId = partIds[1];
    check(world.isMultiBoard, `the world is running ${world.boards.length} boards`);

    const c6Runner = world.runnerFor(c6)!;
    const picoRunner = world.runnerFor(pico)!;
    check(c6Runner.engine === 'esp32c6' && picoRunner.engine === 'rp2040js', 'each instance has its own engine');
    check(c6Runner !== picoRunner, 'and they are two different runner objects');

    const samples: { ms: number; c6: string | undefined; picoOut: string | undefined; led: boolean }[] = [];
    for (let i = 0; i < 700; i++) {
      world.runFor(1);
      const visuals = binding.update(emptyControls()).visuals as Map<string, { ledOn?: boolean }>;
      samples.push({
        ms: world.timeMs,
        c6: c6Runner.digitalPinLevel(2),
        picoOut: picoRunner.digitalPinLevel(15),
        led: visuals.get(ledId)?.ledOn === true,
      });
    }

    const drivenHigh = samples.filter((s) => s.c6 === 'high');
    const drivenLow = samples.filter((s) => s.c6 === 'low');
    check(drivenHigh.length > 20, `the C6 drives IO2 high (${drivenHigh.length} samples)`);
    check(drivenLow.length > 20, `and low (${drivenLow.length} samples)`);

    // The Pico's output must follow the C6's, one settle behind at most.
    const followed = samples.filter((s) => s.c6 !== undefined && s.picoOut === s.c6).length;
    check(followed > samples.length * 0.9, `the Pico's GP15 follows the C6's IO2 (${followed}/${samples.length} samples agree)`);

    const lit = samples.filter((s) => s.led).length;
    check(lit > 20, `and the LED on the Pico's pin lights (${lit} samples)`);
    check(lit < samples.length - 20, 'and goes out again, so it is following rather than stuck on');

    // The LED is on exactly when the C6 is driving high, which is the whole
    // chain end to end.
    const agree = samples.filter((s) => s.c6 !== undefined && s.led === (s.c6 === 'high')).length;
    check(agree > samples.length * 0.9, `the LED agrees with what the C6 is doing (${agree}/${samples.length})`);

    world.dispose();
  }
}

// ---------- B. Pico drives, C6 reacts, second C6 pin follows ----------
//
//   Pico GP14 -> wire -> C6 IO3 -> C6 firmware -> C6 IO4 -> resistor -> LED
{
  const c6 = id('b');
  const pico = id('b');
  const built = await buildWorld(
    {
      [pico]: {
        boardId: PICO,
        source:
          'void setup() { pinMode(14, OUTPUT); }\n' +
          'void loop() { digitalWrite(14, HIGH); delay(40); digitalWrite(14, LOW); delay(40); }',
      },
      [c6]: {
        boardId: C6,
        source: 'void setup() { pinMode(3, INPUT); pinMode(4, OUTPUT); }\n' + 'void loop() { digitalWrite(4, digitalRead(3)); }',
      },
    },
    [{ defId: 'comp.resistor', props: { resistance: 220 } }, { defId: 'comp.led', props: { color: 'green' } }],
    ([resistorId, ledId]) => [
      [pico, 'GP14', c6, 'IO3'],
      [pico, 'GND3', c6, 'GND1'],
      [c6, 'IO4', resistorId, 'p1'],
      [resistorId, 'p2', ledId, 'anode'],
      [ledId, 'cathode', c6, 'GND2'],
    ],
  );

  if (!built) {
    skip('the reverse-direction sketches did not compile');
  } else {
    const { world, binding, partIds } = built;
    const ledId = partIds[1];
    const c6Runner = world.runnerFor(c6)!;
    const picoRunner = world.runnerFor(pico)!;

    const samples: { pico: string | undefined; c6Out: string | undefined; led: boolean }[] = [];
    for (let i = 0; i < 700; i++) {
      world.runFor(1);
      const visuals = binding.update(emptyControls()).visuals as Map<string, { ledOn?: boolean }>;
      samples.push({
        pico: picoRunner.digitalPinLevel(14),
        c6Out: c6Runner.digitalPinLevel(4),
        led: visuals.get(ledId)?.ledOn === true,
      });
    }

    check(samples.some((s) => s.pico === 'high') && samples.some((s) => s.pico === 'low'), 'the Pico drives GP14 both ways');
    const followed = samples.filter((s) => s.pico !== undefined && s.c6Out === s.pico).length;
    check(followed > samples.length * 0.9, `the C6's IO4 follows the Pico's GP14 (${followed}/${samples.length})`);
    const lit = samples.filter((s) => s.led).length;
    check(lit > 20 && lit < samples.length - 20, `and the LED on the C6's pin follows too (${lit} on, ${samples.length - lit} off)`);

    world.dispose();
  }
}

// ---------- C. two boards of the same type are two machines ----------
//
// The failure this guards against is the one that looks like everything works:
// a workspace with two identical boards where only one is really running, and
// the other's state is the first one's reported twice.
//
// Both Picos run the *same compiled firmware*. What differs is only how they
// are wired: the second one's input is tied to its own ground, the first one's
// is left to its internal pull-up. If they were one machine they could not
// disagree.
{
  const a = id('b');
  const b = id('b');
  const RELAY =
    'void setup() { pinMode(16, INPUT_PULLUP); pinMode(15, OUTPUT); }\n' + 'void loop() { digitalWrite(15, digitalRead(16)); }';
  const built = await buildWorld(
    { [a]: { boardId: PICO, source: RELAY }, [b]: { boardId: PICO, source: RELAY } },
    [],
    () => [
      // Only the second board's input is pulled to ground.
      [b, 'GP16', b, 'GND3'],
    ],
  );

  if (!built) {
    skip('the two-Pico project did not compile');
  } else {
    const { world } = built;
    const runnerA = world.runnerFor(a)!;
    const runnerB = world.runnerFor(b)!;

    check(runnerA !== runnerB, 'two instances of the same board type are two different runners');
    check(world.boards.length === 2, 'and the world holds both');
    check(world.runnerFor(a) === runnerA && world.runnerFor(b) === runnerB, 'each resolves by its own instance id');

    for (let i = 0; i < 500; i++) world.runFor(1);

    check(
      runnerA.digitalPinLevel(15) === 'high',
      `the unwired Pico mirrors its pulled-up input high (${runnerA.digitalPinLevel(15)})`,
    );
    check(
      runnerB.digitalPinLevel(15) === 'low',
      `while the Pico whose input is wired to ground mirrors low (${runnerB.digitalPinLevel(15)})`,
    );
    check(
      runnerA.digitalPinLevel(15) !== runnerB.digitalPinLevel(15),
      'so two boards running the same firmware disagree, which one machine could not do',
    );

    // Their clocks advance together but their state does not.
    check(Math.abs(runnerA.timeMs - runnerB.timeMs) < 2, 'both boards share the world clock');
    check(runnerA.snapshot().states[15] !== runnerB.snapshot().states[15], 'and their snapshots differ pin for pin');

    // Lifecycle: resetting one must not disturb the other.
    const beforeA = runnerA.timeMs;
    world.resetBoard(b);
    check(
      // Not exactly zero: rebuilding an RP2040 runs its boot stub, which costs
      // a few tens of microseconds of the new machine's own time. What matters
      // is that it is back at the very start of a boot rather than half a
      // second into a run.
      runnerB.timeMs < 1 && beforeA > 100,
      `resetting the second board returns it to power-on (${runnerB.timeMs.toFixed(3)} ms, the first is at ${beforeA.toFixed(1)})`,
    );
    check(runnerA.timeMs === beforeA, "and leaves the first board's clock exactly where it was");
    for (let i = 0; i < 300; i++) world.runFor(1);
    check(runnerB.digitalPinLevel(15) === 'low', 'and it comes back up still wired the way it was');
    check(runnerA.digitalPinLevel(15) === 'high', 'with the first board unchanged throughout');

    world.dispose();
  }
}

// ---------- D. two C6 instances are two machines ----------
{
  const a = id('b');
  const b = id('b');
  const RELAY =
    'void setup() { pinMode(4, INPUT_PULLUP); pinMode(5, OUTPUT); }\n' + 'void loop() { digitalWrite(5, digitalRead(4)); }';
  const built = await buildWorld(
    { [a]: { boardId: C6, source: RELAY }, [b]: { boardId: C6, source: RELAY } },
    [],
    () => [[b, 'IO4', b, 'GND1']],
  );

  if (!built) {
    skip('the two-C6 project did not compile');
  } else {
    const { world } = built;
    const runnerA = world.runnerFor(a)!;
    const runnerB = world.runnerFor(b)!;
    check(runnerA !== runnerB, 'two ESP32-C6 instances are two different runners');

    for (let i = 0; i < 500; i++) world.runFor(1);
    check(runnerA.digitalPinLevel(5) === 'high', `the unwired C6 mirrors its pulled-up input high (${runnerA.digitalPinLevel(5)})`);
    check(runnerB.digitalPinLevel(5) === 'low', `and the grounded one mirrors low (${runnerB.digitalPinLevel(5)})`);

    // Removing one leaves the other running.
    const beforeRemove = runnerA.timeMs;
    world.remove(b);
    check(world.boards.length === 1, 'removing a board takes it out of the world');
    for (let i = 0; i < 50; i++) world.runFor(1);
    check(runnerA.timeMs > beforeRemove, 'and the remaining board carries on');
    check(runnerA.digitalPinLevel(5) === 'high', 'with its own state intact');

    world.dispose();
  }
}

// ---------- D2. a canvas button reaches the C6's digitalRead ----------
//
// A push button between the pin and ground, which is how a student wires one.
// Pressing it is a control the canvas applies, not a call into the runner.
{
  const c6 = id('b');
  const built = await buildWorld(
    {
      [c6]: {
        boardId: C6,
        source:
          'void setup() { pinMode(4, INPUT_PULLUP); pinMode(5, OUTPUT); }\n' +
          'void loop() { digitalWrite(5, digitalRead(4) ? LOW : HIGH); }',
      },
    },
    [{ defId: 'comp.push-button' }, { defId: 'comp.resistor', props: { resistance: 220 } }, { defId: 'comp.led', props: { color: 'blue' } }],
    ([buttonId, resistorId, ledId]) => [
      [c6, 'IO4', buttonId, '1a'],
      [buttonId, '2a', c6, 'GND1'],
      [c6, 'IO5', resistorId, 'p1'],
      [resistorId, 'p2', ledId, 'anode'],
      [ledId, 'cathode', c6, 'GND2'],
    ],
  );

  if (!built) {
    skip('the button project did not compile');
  } else {
    const { world, binding, partIds } = built;
    const [buttonId, , ledId] = partIds;

    const controls = emptyControls();
    world.settle = () => binding.update(controls);

    for (let i = 0; i < 400; i++) world.runFor(1);
    let visuals = binding.update(controls).visuals as Map<string, { ledOn?: boolean }>;
    check(world.runnerFor(c6)!.digitalPinLevel(4) === 'input-pullup', 'the C6 pin is a pulled-up input');
    check(visuals.get(ledId)?.ledOn !== true, 'with the button released the LED is off');

    // Press it: the pin is pulled to ground through the button.
    controls.pressedButtons.add(buttonId);
    for (let i = 0; i < 300; i++) world.runFor(1);
    visuals = binding.update(controls).visuals as Map<string, { ledOn?: boolean }>;
    check(visuals.get(ledId)?.ledOn === true, 'pressing the button on the canvas lights the LED the firmware drives');

    controls.pressedButtons.delete(buttonId);
    for (let i = 0; i < 300; i++) world.runFor(1);
    visuals = binding.update(controls).visuals as Map<string, { ledOn?: boolean }>;
    check(visuals.get(ledId)?.ledOn !== true, 'and releasing it lets the internal pull-up take the pin back');

    world.dispose();
  }
}

// ---------- E. Pin States for the C6 ----------
{
  const c6 = id('b');
  const built = await buildWorld(
    {
      [c6]: {
        boardId: C6,
        source:
          'void setup() { pinMode(2, OUTPUT); pinMode(4, INPUT_PULLUP); }\n' +
          'void loop() { digitalWrite(2, HIGH); delay(20); digitalWrite(2, LOW); delay(20); }',
      },
    },
    [],
    () => [],
  );

  if (!built) {
    skip('the Pin States sketch did not compile');
  } else {
    const { world } = built;
    const runner = world.runnerFor(c6)!;
    for (let i = 0; i < 300; i++) world.runFor(1);

    const board = getBoardDefinition(C6)!;
    const model = buildPinStatesModel(board);
    check(model.kind === 'pins', `the C6 shows live pin states rather than "${model.kind}"`);
    if (model.kind !== 'pins') {
      world.dispose();
      finish();
    }
    const rows = model.rows;
    const names = rows.map((r) => r.label);

    check(model.boardName === board.name, `named as the real board (${model.boardName})`);
    check(rows.length > 15, `with ${rows.length} pin rows`);
    check(
      names.every((n) => /^IO\d{1,2}$/.test(n)),
      `and every one is an IO name (${names.slice(0, 6).join(', ')}…)`,
    );
    check(!names.some((n) => /^D\d/.test(n) || /^A\d/.test(n) || /^GP\d/.test(n)), 'with no D0, A0 or GP0 anywhere');

    // Only pads the DevKitC-1 actually brings out.
    const exposed = new Set(board.pins.filter((p) => /^IO\d{1,2}$/.test(p.id)).map((p) => p.id));
    check(names.every((n) => exposed.has(n)), 'and no pad the board does not bring out');
    check(!names.includes('IO14'), 'IO14 is not on the header, so it is not offered');
    check(!names.includes('IO24'), 'nor IO24, which the module does not route');
    check(
      rows.every((r) => r.pin === undefined || r.label === `IO${r.pin}`),
      'and every row maps to the pad its own name says, with nothing translated',
    );

    // The values come from this runner instance, not from a default.
    const snapshot = runner.snapshot();
    const io2 = rows.find((r) => r.label === 'IO2');
    const io4 = rows.find((r) => r.label === 'IO4');
    check(io2?.pin === 2 && io4?.pin === 4, 'IO2 and IO4 resolve to runner indexes 2 and 4');
    check(snapshot.states[io2!.pin!] === 'high' || snapshot.states[io2!.pin!] === 'low', 'IO2 reads a driven level');
    check(snapshot.states[io4!.pin!] === 'input-pullup', 'and IO4 reads as a pulled-up input, as the sketch set it');
    check(snapshot.toggles[io2!.pin!] > 4, `with IO2's real toggle count (${snapshot.toggles[io2!.pin!]})`);
    const untouched = rows.find((r) => r.label === 'IO11');
    check(snapshot.toggles[untouched!.pin!] === 0, 'and an untouched pad showing none');

    world.dispose();
  }
}

finish();
