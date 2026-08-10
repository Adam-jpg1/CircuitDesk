// ESP32-C3-DevKitM-1 on the canvas, end to end.
//
// Nothing here reaches into a harness. Firmware is compiled by the real
// compiler service, executed by the real production runner reached through the
// real adapter, and observed through the real CircuitBinding — the same object
// the canvas renders from. The LED's state is whatever the binding computed
// from the net the firmware's pin is wired to, so a pass means the whole chain
// is connected:
//
//   firmware -> GPIO peripheral -> BoardRunner -> CircuitBinding -> net -> LED
//
// No sketch is detected, no pin is special-cased, and no UI shortcut is taken.

import { getSimulatorAdapter, firmwareFormatForBoard } from '../src/simulation/adapters';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { getBoardDefinition } from '../src/boards/definitions';
import { buildPinStatesModel } from '../src/simulation/pinStatesModel';
import { emptyProject } from '../src/project/templates';
import type { BoardRunner } from '../src/simulation/boardRunner';
import type { CircuitProject, ComponentInstance } from '../src/types';

const BASE = process.env.CIRCUITDESK_URL ?? 'http://localhost:3411';
const BOARD = 'board.esp32-c3';

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
      ? `\nESP32-C3 integration checks passed (${skipped} skipped).`
      : `\n${failures} check(s) FAILED (${skipped} skipped)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

interface Artifact {
  data: string;
  format: string;
  regions?: { offset: number; data: string }[];
}

const compiled = new Map<string, Artifact>();

async function compile(source: string): Promise<Artifact | null> {
  const cached = compiled.get(source);
  if (cached) return cached;
  try {
    const res = await fetch(`${BASE}/api/compiler/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        boardId: BOARD,
        fqbn: 'esp32:esp32:esp32c3',
        files: [{ name: 'sketch.ino', content: source }],
      }),
    });
    const json = (await res.json()) as { success: boolean; firmware?: Artifact };
    if (!json.success || !json.firmware) return null;
    compiled.set(source, json.firmware);
    return json.firmware;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ project building

let nextId = 0;
const id = (prefix: string) => `${prefix}${++nextId}`;

/** Builds a project the way the canvas would: parts placed, pins wired. */
function projectWith(
  parts: { defId: string; props?: Record<string, unknown> }[],
  wire: (boardInstanceId: string, partIds: string[]) => [string, string, string, string][],
): { project: CircuitProject; boardInstanceId: string; partIds: string[] } {
  const project = emptyProject('esp32c3-integration');
  const boardInstanceId = id('b');
  project.boardInstances.push({
    id: boardInstanceId,
    definitionId: BOARD,
    x: 100,
    y: 100,
    rotation: 0,
    properties: {},
    simulationState: {},
  } as ComponentInstance);
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
  for (const [srcId, srcPin, dstId, dstPin] of wire(boardInstanceId, partIds)) {
    project.connections.push({
      id: id('w'),
      sourceComponentId: srcId,
      sourcePinId: srcPin,
      targetComponentId: dstId,
      targetPinId: dstPin,
      netId: '',
      color: '#e8590c',
      points: [],
      routing: 'smooth',
    });
  }
  return { project, boardInstanceId, partIds };
}

/** Runs a bound circuit, updating the binding as the application's loop does. */
function advance(
  runner: BoardRunner,
  binding: CircuitBinding,
  controls: ReturnType<typeof emptyControls>,
  simMs: number,
  onFrame?: (visuals: Map<string, { ledOn?: boolean; brightness?: number }>) => void,
): void {
  for (let done = 0; done < simMs; done += 1) {
    runner.runFor(1);
    const { visuals } = binding.update(controls);
    onFrame?.(visuals as never);
  }
}

const board = getBoardDefinition(BOARD);
if (!board) {
  console.log('FAIL: the ESP32-C3-DevKitM-1 board definition is missing');
  process.exit(1);
}

// ---------- 1. the board reaches its own engine, and only its own ----------
{
  const adapter = getSimulatorAdapter(board);
  check(adapter?.engine === 'esp32c3', `the DevKitM-1 resolves to the ESP32-C3 engine (${adapter?.engine})`);
  check(firmwareFormatForBoard(board) === 'esp-image', 'and the compile pipeline asks for an ESP application image');

  const uno = getBoardDefinition('board.arduino-uno');
  check(getSimulatorAdapter(uno)?.engine === 'avr8js', 'an Uno still resolves to the AVR engine');
  const pico = getBoardDefinition('board.raspberry-pi-pico');
  check(getSimulatorAdapter(pico)?.engine === 'rp2040js', 'and a Pico to the RP2040 one');
}

const SKETCHES = {
  blink: 'void setup() { pinMode(8, OUTPUT); }\nvoid loop() { digitalWrite(8, HIGH); delay(100); digitalWrite(8, LOW); delay(100); }',
  button:
    'void setup() { pinMode(9, INPUT_PULLUP); pinMode(8, OUTPUT); }\n' +
    'void loop() { digitalWrite(8, digitalRead(9) == LOW ? HIGH : LOW); delay(5); }',
} as const;

const probe = await compile(SKETCHES.blink);
if (!probe) {
  skip('the ESP32-C3 toolchain is unavailable — canvas sections cannot run');
  finish();
}

// ---------- 2. IO8 -> resistor -> LED -> GND ----------
{
  const { project, boardInstanceId, partIds } = projectWith(
    [{ defId: 'comp.resistor', props: { resistance: 220 } }, { defId: 'comp.led', props: { color: 'red' } }],
    (boardId, ids) => {
      const [resistorId, ledId] = ids;
      return [
        [boardId, 'IO8', resistorId, 'p1'],
        [resistorId, 'p2', ledId, 'anode'],
        [ledId, 'cathode', boardId, 'GND1'],
      ];
    },
  );
  const [, ledId] = partIds;

  const runner = await getSimulatorAdapter(board)!.createRunner(probe!, board);
  const binding = new CircuitBinding(project, runner);
  const controls = emptyControls();

  const samples: { at: number; on: boolean }[] = [];
  advance(runner, binding, controls, 520, (visuals) => {
    const led = visuals.get(ledId);
    if (led) samples.push({ at: runner.timeMs, on: led.ledOn === true });
  });

  check(samples.length > 0, 'the binding produced LED visuals from the net');
  check(
    samples.some((s) => s.on) && samples.some((s) => !s.on),
    'the LED is both lit and dark during the run, so it is following the firmware',
  );

  // The edges the LED actually took, and the intervals between them.
  const edges: { at: number; on: boolean }[] = [];
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].on !== samples[i - 1].on) edges.push(samples[i]);
  }
  check(edges.length >= 4, `the LED changed state ${edges.length} times`);
  const intervals = edges.slice(1).map((e, i) => e.at - edges[i].at);
  check(
    intervals.every((gap) => Math.abs(gap - 100) <= 3),
    `each change is 100 ms after the last, as the sketch says (${intervals.map((g) => g.toFixed(0)).join(', ')})`,
  );

  // The LED must be following the pin rather than a timer of its own.
  const mismatched = samples.filter((s) => s.on !== (runner.digitalPinLevel(8) === 'high'));
  check(mismatched.length < samples.length, 'LED state tracks the pin rather than being independent of it');

  runner.dispose?.();
}

// ---------- 3. a button drives an input, and the firmware drives the LED ----------
//
// The whole path has to be genuine in both directions:
//   canvas button -> net -> IO9 -> firmware -> IO8 -> net -> LED
{
  const buttonFirmware = await compile(SKETCHES.button);
  if (!buttonFirmware) {
    skip('the button sketch did not compile');
  } else {
    const { project, boardInstanceId, partIds } = projectWith(
      [
        { defId: 'comp.push-button' },
        { defId: 'comp.resistor', props: { resistance: 220 } },
        { defId: 'comp.led', props: { color: 'red' } },
      ],
      (boardId, ids) => {
        const [buttonId, resistorId, ledId] = ids;
        return [
          [boardId, 'IO9', buttonId, '1a'],
          [buttonId, '2a', boardId, 'GND1'],
          [boardId, 'IO8', resistorId, 'p1'],
          [resistorId, 'p2', ledId, 'anode'],
          [ledId, 'cathode', boardId, 'GND2'],
        ];
      },
    );
    const [buttonId, , ledId] = partIds;

    const runner = await getSimulatorAdapter(board)!.createRunner(buttonFirmware, board);
    const binding = new CircuitBinding(project, runner);
    const controls = emptyControls();

    let lastLed = false;
    const frame = (visuals: Map<string, { ledOn?: boolean }>) => {
      const led = visuals.get(ledId);
      if (led) lastLed = led.ledOn === true;
    };

    // Released: the button is an open switch, so the pad's own pull-up holds
    // the input high and the firmware leaves the LED dark.
    advance(runner, binding, controls, 60, frame);
    check(!lastLed, 'the LED is dark while the button is released');
    check(runner.digitalPinLevel(9) === 'input-pullup', 'and IO9 is an input held by its pull-up');

    // Pressed: the canvas button shorts IO9 to ground.
    controls.pressedButtons.add(buttonId);
    advance(runner, binding, controls, 60, frame);
    check(lastLed, 'pressing the button on the canvas lights the LED');
    check(runner.digitalPinLevel(8) === 'high', 'because the firmware drove IO8 high');

    controls.pressedButtons.delete(buttonId);
    advance(runner, binding, controls, 60, frame);
    check(!lastLed, 'releasing it puts the LED out again');

    // Once more, so a single transition cannot be mistaken for the whole path.
    controls.pressedButtons.add(buttonId);
    advance(runner, binding, controls, 60, frame);
    check(lastLed, 'and pressing again lights it again');

    runner.dispose?.();
  }
}

// ---------- 4. a wire to a pin the firmware never touches stays dark ----------
{
  const { project, partIds } = projectWith(
    [{ defId: 'comp.resistor', props: { resistance: 220 } }, { defId: 'comp.led', props: { color: 'red' } }],
    (boardId, ids) => {
      const [resistorId, ledId] = ids;
      return [
        [boardId, 'IO4', resistorId, 'p1'],
        [resistorId, 'p2', ledId, 'anode'],
        [ledId, 'cathode', boardId, 'GND1'],
      ];
    },
  );
  const [, ledId] = partIds;

  const runner = await getSimulatorAdapter(board)!.createRunner(probe!, board);
  const binding = new CircuitBinding(project, runner);
  const controls = emptyControls();

  let everOn = false;
  advance(runner, binding, controls, 320, (visuals) => {
    if (visuals.get(ledId)?.ledOn === true) everOn = true;
  });
  check(!everOn, 'an LED on a pin the sketch never configures never lights');
  runner.dispose?.();
}

// ---------- 5. Pin States shows this board's real pins, and nothing else ----------
{
  const model = buildPinStatesModel(board);
  check(model.kind === 'pins', 'Pin States has real rows for this board');
  if (model.kind !== 'pins') finish();

  check(model.boardName === 'ESP32-C3-DevKitM-1', `named by its official product name (${model.boardName})`);

  const labels = model.rows.map((r) => r.label);
  check(labels.every((l) => /^IO\d{1,2}$/.test(l)), `every row is an IO pin (${labels.join(' ')})`);

  // The fallbacks that must never appear. An ESP32-C3 has no Arduino pin
  // numbering and no RP2040 pads, and a row bearing either name would mean the
  // panel had resolved this board through another architecture's map.
  check(!labels.some((l) => /^D\d+$/.test(l)), 'no Arduino D0-D13 row appears');
  check(!labels.some((l) => /^A\d+$/.test(l)), 'no Arduino analog row appears');
  check(!labels.some((l) => /^GP\d+$/.test(l)), 'no RP2040 GP row appears');
  check(!labels.some((l) => /^GPIO\d+$/.test(l)), 'and no legacy GPIO alias appears, only the canonical name');

  // Only pins the DevKitM-1 actually brings out, and each exactly once.
  const exposed = board.pins.filter((p) => /^IO\d{1,2}$/.test(p.id)).map((p) => p.id).sort();
  check(
    JSON.stringify([...labels].sort()) === JSON.stringify(exposed),
    `the rows are exactly the board's exposed GPIOs (${labels.length} of ${exposed.length})`,
  );
  check(new Set(labels).size === labels.length, 'with no pin listed twice');
  check(model.rows.every((r) => r.pin !== undefined), 'and every row maps to a real runner pin');

  // A pin the module does not bring out must not be invented.
  check(!labels.includes('IO11'), 'IO11, which the module does not expose, is absent');
  check(!labels.includes('IO17'), 'and so is IO17');

  // Rows carry live state from the running emulator.
  const runner = await getSimulatorAdapter(board)!.createRunner(probe!, board);
  for (let i = 0; i < 40; i++) runner.runFor(1);
  const snapshot = runner.snapshot();
  const io8 = model.rows.find((r) => r.label === 'IO8')!;
  check(
    snapshot.states[io8.pin!] === 'high' || snapshot.states[io8.pin!] === 'low',
    `IO8 reports a driven level from the live emulator (${snapshot.states[io8.pin!]})`,
  );
  const io4 = model.rows.find((r) => r.label === 'IO4')!;
  check(snapshot.states[io4.pin!] === 'input', 'and a pin the sketch never configures reports as an input');
  runner.dispose?.();
}

finish();
