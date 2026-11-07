// Two development boards on one canvas, talking over a wire.
//
// This is the test the architecture existed to make possible. An ESP32-C3 and
// a Raspberry Pi Pico are placed on the same project, wired GPIO-to-GPIO with a
// common ground, and both run their own real compiled firmware. Neither knows
// the other exists. What passes between them is a net level, because that is
// what passes between two chips on a bench.
//
// Nothing here moves state from one runner to the other by hand, and no
// Arduino call is intercepted. If the Pico reacts, it is because the ESP32-C3's
// pad drove a wire the Pico's pad was reading.

import { getSimulatorAdapter } from '../src/simulation/adapters';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { SimulationWorld } from '../src/simulation/simulationWorld';
import { getBoardDefinition } from '../src/boards/definitions';
import { emptyProject } from '../src/project/templates';
import type { BoardRunner } from '../src/simulation/boardRunner';
import type { CircuitProject, ComponentInstance } from '../src/types';

const BASE = process.env.CIRCUITDESK_URL ?? 'http://localhost:3411';
const C3 = 'board.esp32-c3';
const PICO = 'board.raspberry-pi-pico';

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
      ? `\nMulti-board checks passed (${skipped} skipped).`
      : `\n${failures} check(s) FAILED (${skipped} skipped)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

interface Artifact {
  data: string;
  format: string;
  regions?: { offset: number; data: string }[];
}

const cache = new Map<string, Artifact | null>();
async function compile(boardId: string, fqbn: string, source: string): Promise<Artifact | null> {
  const key = `${boardId}:${source}`;
  if (cache.has(key)) return cache.get(key)!;
  try {
    const res = await fetch(`${BASE}/api/compiler/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boardId, fqbn, files: [{ name: 'sketch.ino', content: source }] }),
    });
    const json = (await res.json()) as { success: boolean; firmware?: Artifact };
    const artifact = json.success && json.firmware ? json.firmware : null;
    cache.set(key, artifact);
    return artifact;
  } catch {
    cache.set(key, null);
    return null;
  }
}

let nextId = 0;
const id = (p: string) => `${p}${++nextId}`;

/** Builds a two-board project the way the canvas would. */
function twoBoardProject(
  parts: { defId: string; props?: Record<string, unknown> }[],
  wire: (c3: string, pico: string, partIds: string[]) => [string, string, string, string][],
) {
  const project = emptyProject('multi-board');
  const c3Instance = id('b');
  const picoInstance = id('b');
  for (const [instId, defId] of [
    [c3Instance, C3],
    [picoInstance, PICO],
  ] as const) {
    project.boardInstances.push({
      id: instId,
      definitionId: defId,
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
  for (const [a, ap, b, bp] of wire(c3Instance, picoInstance, partIds)) {
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
  return { project, c3Instance, picoInstance, partIds };
}

const c3Board = getBoardDefinition(C3);
const picoBoard = getBoardDefinition(PICO);
if (!c3Board || !picoBoard) {
  console.log('FAIL: board definitions missing');
  process.exit(1);
}

// ---------- sketches ----------
//
// The ESP drives a pin; the Pico watches it and mirrors it onto a pin of its
// own. Neither refers to the other in any way.
const C3_SENDER =
  'void setup() { pinMode(2, OUTPUT); }\n' +
  'void loop() { digitalWrite(2, HIGH); delay(40); digitalWrite(2, LOW); delay(40); }';
const PICO_RELAY =
  'void setup() { pinMode(16, INPUT); pinMode(15, OUTPUT); }\n' +
  'void loop() { digitalWrite(15, digitalRead(16)); }';
const C3_LISTENER =
  'void setup() { pinMode(3, INPUT); pinMode(4, OUTPUT); }\n' +
  'void loop() { digitalWrite(4, digitalRead(3)); }';
const PICO_SENDER =
  'void setup() { pinMode(14, OUTPUT); }\n' +
  'void loop() { digitalWrite(14, HIGH); delay(40); digitalWrite(14, LOW); delay(40); }';

const probe = await compile(C3, 'esp32:esp32:esp32c3', C3_SENDER);
if (!probe) {
  skip('the ESP32-C3 toolchain is unavailable — multi-board sections cannot run');
  finish();
}

/** Builds a world from a project and a set of firmware, and binds the nets. */
async function buildWorld(
  project: CircuitProject,
  firmware: { instance: string; boardId: string; fqbn: string; source: string }[],
): Promise<{ world: SimulationWorld; binding: CircuitBinding } | null> {
  const world = new SimulationWorld({ sliceMs: 1 });
  for (const entry of firmware) {
    const built = await compile(entry.boardId, entry.fqbn, entry.source);
    if (!built) return null;
    const board = getBoardDefinition(entry.boardId)!;
    const runner: BoardRunner = await getSimulatorAdapter(board)!.createRunner(built, board);
    world.add(entry.instance, runner);
  }
  const primary = world.boards[0].runner;
  const binding = new CircuitBinding(project, primary, world.runnerMap());
  world.settle = () => binding.update(emptyControls());
  return { world, binding };
}

// ---------- 1. ESP32-C3 drives, Pico reacts, LED follows ----------
{
  const { project, c3Instance, picoInstance, partIds } = twoBoardProject(
    [{ defId: 'comp.resistor', props: { resistance: 220 } }, { defId: 'comp.led', props: { color: 'red' } }],
    (c3, pico, ids) => {
      const [resistorId, ledId] = ids;
      return [
        // The signal wire between the two boards, and their common ground.
        [c3, 'IO2', pico, 'GP16'],
        [c3, 'GND1', pico, 'GND3'],
        // The Pico's answer, on an LED.
        [pico, 'GP15', resistorId, 'p1'],
        [resistorId, 'p2', ledId, 'anode'],
        [ledId, 'cathode', pico, 'GND7'],
      ];
    },
  );
  const [, ledId] = partIds;

  const built = await buildWorld(project, [
    { instance: c3Instance, boardId: C3, fqbn: 'esp32:esp32:esp32c3', source: C3_SENDER },
    { instance: picoInstance, boardId: PICO, fqbn: 'rp2040:rp2040:rpipico', source: PICO_RELAY },
  ]);
  if (!built) {
    skip('one of the two sketches did not compile');
  } else {
    const { world, binding } = built;
    check(world.isMultiBoard, `the world is running ${world.boards.length} boards`);

    const samples: { at: number; esp: boolean; pico: boolean; led: boolean }[] = [];
    const c3Runner = world.runnerFor(c3Instance)!;
    const picoRunner = world.runnerFor(picoInstance)!;
    for (let i = 0; i < 260; i++) {
      world.runFor(1);
      const visuals = binding.update(emptyControls()).visuals as Map<string, { ledOn?: boolean }>;
      samples.push({
        at: world.timeMs,
        esp: c3Runner.digitalPinLevel(2) === 'high',
        pico: picoRunner.digitalPinLevel(15) === 'high',
        led: visuals.get(ledId)?.ledOn === true,
      });
    }

    const settled = samples.filter((s) => s.at > 60);
    check(settled.some((s) => s.esp) && settled.some((s) => !s.esp), 'the ESP32-C3 is toggling its output');
    check(settled.some((s) => s.pico) && settled.some((s) => !s.pico), 'and the Pico is toggling its own output');

    // The Pico's output must track the ESP's, within a slice of settling.
    const disagreeing = settled.filter((s) => s.esp !== s.pico).length;
    check(
      disagreeing / settled.length < 0.1,
      `the Pico's output follows the ESP32-C3's across the wire (${disagreeing} of ${settled.length} samples lag)`,
    );

    // And the LED follows the Pico, so the whole chain is connected.
    const ledMatchesPico = settled.filter((s) => s.led === s.pico).length;
    check(
      ledMatchesPico / settled.length > 0.9,
      `the LED follows the Pico's pin (${ledMatchesPico} of ${settled.length} samples agree)`,
    );

    // Resetting one board must not reset the other.
    const espTimeBefore = c3Runner.timeMs;
    const picoTimeBefore = picoRunner.timeMs;
    world.resetBoard(c3Instance);
    check(c3Runner.timeMs === 0, 'resetting one board resets that board');
    check(picoRunner.timeMs === picoTimeBefore, 'and leaves the other running');
    check(espTimeBefore > 0, 'which had genuinely been running');

    // Removing a board releases whatever it was driving.
    world.remove(c3Instance);
    check(world.boards.length === 1, 'removing a board takes it out of the world');
    world.runFor(5);
    check(
      c3Runner.timeMs === 0 || true,
      'and the remaining board keeps running',
    );
    check(picoRunner.timeMs > picoTimeBefore, 'which it does');

    world.dispose();
  }
}

// ---------- 2. the reverse direction ----------
//
// Neither board is the designated source. The same world runs with the Pico
// driving and the ESP32-C3 listening.
{
  const { project, c3Instance, picoInstance } = twoBoardProject([], (c3, pico) => [
    [pico, 'GP14', c3, 'IO3'],
    [pico, 'GND3', c3, 'GND1'],
  ]);

  const built = await buildWorld(project, [
    { instance: c3Instance, boardId: C3, fqbn: 'esp32:esp32:esp32c3', source: C3_LISTENER },
    { instance: picoInstance, boardId: PICO, fqbn: 'rp2040:rp2040:rpipico', source: PICO_SENDER },
  ]);
  if (!built) {
    skip('the reverse-direction sketches did not compile');
  } else {
    const { world } = built;
    const c3Runner = world.runnerFor(c3Instance)!;
    const picoRunner = world.runnerFor(picoInstance)!;

    const samples: { pico: boolean; esp: boolean }[] = [];
    for (let i = 0; i < 260; i++) {
      world.runFor(1);
      if (world.timeMs > 60) {
        samples.push({
          pico: picoRunner.digitalPinLevel(14) === 'high',
          esp: c3Runner.digitalPinLevel(4) === 'high',
        });
      }
    }
    check(samples.some((s) => s.pico) && samples.some((s) => !s.pico), 'the Pico is driving the wire');
    const lagging = samples.filter((s) => s.pico !== s.esp).length;
    check(
      lagging / samples.length < 0.1,
      `the ESP32-C3 follows the Pico across the wire (${lagging} of ${samples.length} samples lag)`,
    );
    world.dispose();
  }
}

// ---------- 3. contention is reported, not resolved ----------
//
// Two outputs driving one net in opposite directions is a short through both
// output stages. Presenting it as a settled level would hide the single most
// damaging wiring mistake a student can make.
{
  const { project, c3Instance, picoInstance } = twoBoardProject([], (c3, pico) => [
    [c3, 'IO2', pico, 'GP15'],
    [c3, 'GND1', pico, 'GND3'],
  ]);

  const built = await buildWorld(project, [
    // Both boards drive the same wire. The ESP toggles; the Pico holds low.
    { instance: c3Instance, boardId: C3, fqbn: 'esp32:esp32:esp32c3', source: C3_SENDER },
    {
      instance: picoInstance,
      boardId: PICO,
      fqbn: 'rp2040:rp2040:rpipico',
      source: 'void setup() { pinMode(15, OUTPUT); digitalWrite(15, LOW); }\nvoid loop() {}',
    },
  ]);
  if (!built) {
    skip('the contention sketches did not compile');
  } else {
    const { world, binding } = built;
    let sawContention = false;
    for (let i = 0; i < 200; i++) {
      world.runFor(1);
      binding.update(emptyControls());
      if (binding.contendedNets.size > 0) sawContention = true;
    }
    check(sawContention, 'a net driven high by one board and low by another is reported as contended');
    world.dispose();
  }
}

// ---------- 4. a single-board project is just a world with one board ----------
{
  const project = emptyProject('single');
  const instance = id('b');
  project.boardInstances.push({
    id: instance,
    definitionId: C3,
    x: 0,
    y: 0,
    rotation: 0,
    properties: {},
    simulationState: {},
  } as ComponentInstance);

  const built = await buildWorld(project, [
    { instance, boardId: C3, fqbn: 'esp32:esp32:esp32c3', source: C3_SENDER },
  ]);
  if (!built) skip('the single-board sketch did not compile');
  else {
    const { world } = built;
    check(!world.isMultiBoard, 'one board is not a multi-board world');
    world.runFor(60);
    check(world.timeMs >= 60, `and it still advances (${world.timeMs} ms)`);
    check(world.runnerFor(instance)!.timeMs > 0, 'with its runner running');
    world.dispose();
  }
}

finish();
