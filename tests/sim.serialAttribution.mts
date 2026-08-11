// Whose "Sending HIGH" was that?
//
// With one board on the canvas, serial output needed no attribution: there was
// only one thing that could have written it. With two, an unattributed monitor
// is actively misleading — two Picos running the same sketch print the same
// words, and a student debugging why one of them is wrong has no way to tell
// which line came from which board.
//
// So this proves two things that have to be true together:
//
//   * Two instances of the same board type, running the same firmware, are two
//     independent machines. Wired to different input conditions they behave
//     differently, which is only possible if each has its own CPU, its own
//     memory and its own pads.
//
//   * Every byte either of them writes is tagged with the instance that wrote
//     it, using the project's own instance id — not a board type, not an index
//     into a list, and not something derived from the text.
//
// The firmware is real, compiled through the real service for the real target.
// Nothing intercepts Serial: the bytes come out of the modelled UART because
// the firmware wrote them to it.

import { getSimulatorAdapter } from '../src/simulation/adapters';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { SimulationWorld, type SerialOutputEvent } from '../src/simulation/simulationWorld';
import { SerialTranscript, buildSerialLabels } from '../src/simulation/serialLog';
import { getBoardDefinition } from '../src/boards/definitions';
import { emptyProject } from '../src/project/templates';
import type { BoardRunner } from '../src/simulation/boardRunner';
import type { CircuitProject, ComponentInstance } from '../src/types';

const BASE = process.env.CIRCUITDESK_URL ?? 'http://localhost:3411';
const PICO = 'board.raspberry-pi-pico';
const FQBN: Record<string, string> = { [PICO]: 'rp2040:rp2040:rpipico' };

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

interface Artifact {
  data: string;
  format: string;
  regions?: { offset: number; data: string }[];
}

const cache = new Map<string, Artifact>();

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
        console.log(`   (compile request kept dropping: ${(e as Error).message})`);
        return null;
      }
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  return null;
}

// ============================================================ 1. the transcript
//
// The decoding and line-splitting rules, exercised directly. These are cheap to
// get wrong in ways that only show up with two boards printing at once, which is
// exactly the case that has no single-board equivalent to fall back on.
{
  const t = new SerialTranscript();
  const ev = (instanceId: string, byte: number, timestamp = 0): SerialOutputEvent => ({ instanceId, byte, timestamp });
  const write = (id: string, text: string, at = 0) => {
    for (const b of new TextEncoder().encode(text)) t.push(ev(id, b, at));
  };

  // Two boards printing at once. The lines must not braid together.
  write('a', 'Sen', 1);
  write('b', 'Rec', 1);
  write('a', 'ding HIGH\n', 2);
  write('b', 'eiving LOW\n', 2);

  const lines = t.lines();
  check(lines.length === 2, `two interleaved writers produced two lines (${lines.length})`);
  check(
    lines.some((l) => l.instanceId === 'a' && l.text === 'Sending HIGH'),
    'the first board\'s line is whole and attributed to it',
  );
  check(
    lines.some((l) => l.instanceId === 'b' && l.text === 'Receiving LOW'),
    'and the second board\'s likewise',
  );

  // A multi-byte character split across the interleave. A single shared
  // decoder would splice one board's lead byte onto the other's continuation
  // byte and emit U+FFFD; a decoder per instance cannot.
  const t2 = new SerialTranscript();
  const degrees = new TextEncoder().encode('23°C'); // '°' is 0xC2 0xB0
  const other = new TextEncoder().encode('19°F');
  for (let i = 0; i < Math.max(degrees.length, other.length); i++) {
    if (i < degrees.length) t2.push(ev('a', degrees[i]));
    if (i < other.length) t2.push(ev('b', other[i]));
  }
  t2.push(ev('a', 10));
  t2.push(ev('b', 10));
  const decoded = t2.lines();
  check(decoded.find((l) => l.instanceId === 'a')?.text === '23°C', 'a multi-byte character survives being interleaved (a)');
  check(decoded.find((l) => l.instanceId === 'b')?.text === '19°F', 'and on the other instance too (b)');
  check(!decoded.some((l) => l.text.includes('�')), 'with no replacement characters anywhere');

  // Rendering: unprefixed while one board is talking, prefixed once two are.
  const solo = new SerialTranscript();
  for (const b of new TextEncoder().encode('Hello\n')) solo.push(ev('only', b));
  check(solo.render(() => 'Uno') === 'Hello\n', `one board reads exactly as before (${JSON.stringify(solo.render(() => 'Uno'))})`);
  for (const b of new TextEncoder().encode('World\n')) solo.push(ev('second', b));
  const rendered = solo.render((id) => (id === 'only' ? 'Pico #1' : 'Pico #2'));
  check(rendered === '[Pico #1] Hello\n[Pico #2] World\n', `two boards are labelled per line (${JSON.stringify(rendered)})`);

  // A partial line must not gain a newline it was never sent.
  const partial = new SerialTranscript();
  for (const b of new TextEncoder().encode('abc')) partial.push(ev('x', b));
  check(partial.render(() => 'x') === 'abc', 'a line still being written ends where the firmware left it');
  check(partial.lines()[0].complete === false, 'and is marked incomplete');

  // CR is not a line ending of its own; CRLF must not produce a blank line.
  const crlf = new SerialTranscript();
  for (const b of new TextEncoder().encode('one\r\ntwo\r\n')) crlf.push(ev('x', b));
  check(crlf.lines().length === 2 && crlf.lines()[1].text === 'two', 'CRLF ends one line, not two');

  // Removing a board takes its history with it.
  const forgetful = new SerialTranscript();
  for (const b of new TextEncoder().encode('mine\n')) forgetful.push(ev('a', b));
  for (const b of new TextEncoder().encode('yours\n')) forgetful.push(ev('b', b));
  forgetful.forget('b');
  check(forgetful.lines().length === 1 && forgetful.lines()[0].instanceId === 'a', 'a removed board\'s lines go with it');

  // Labels: numbered only where the type repeats, and the user's own name wins.
  const labels = buildSerialLabels([
    { instanceId: 'b1', boardName: 'Raspberry Pi Pico' },
    { instanceId: 'b2', boardName: 'Raspberry Pi Pico' },
    { instanceId: 'b3', boardName: 'Arduino Uno' },
    { instanceId: 'b4', boardName: 'Arduino Uno', label: 'Sensor node' },
  ]);
  check(labels.get('b1') === 'Raspberry Pi Pico #1', `repeated types are numbered (${labels.get('b1')})`);
  check(labels.get('b2') === 'Raspberry Pi Pico #2', `and distinctly (${labels.get('b2')})`);
  check(labels.get('b3') === 'Arduino Uno', `a type left with only one unnamed board is not (${labels.get('b3')})`);
  check(labels.get('b4') === 'Sensor node', `and the user's own name wins (${labels.get('b4')})`);
  check(new Set(labels.values()).size === 4, 'so no two boards share a label');

  // A user label that collides with the automatic one must not produce two
  // identical prefixes.
  const collide = buildSerialLabels([
    { instanceId: 'c1', boardName: 'Arduino Uno', label: 'Arduino Uno' },
    { instanceId: 'c2', boardName: 'Arduino Uno' },
  ]);
  check(new Set(collide.values()).size === 2, `a colliding user label is worked around (${[...collide.values()].join(' | ')})`);
  check(collide.get('c1') === 'Arduino Uno', 'with the user\'s own choice kept intact');
}

// ============================================ 2. two identical Picos, one sketch
//
// The sketch is one sketch — the workspace's code tab. Both boards run it, and
// they disagree about what to print because they disagree about what their
// GP16 is connected to. That is only possible with two real machines.
const SOURCE = [
  'void setup() {',
  '  Serial1.begin(115200);',
  '  pinMode(16, INPUT);',
  '  pinMode(15, OUTPUT);',
  '}',
  'void loop() {',
  '  int v = digitalRead(16);',
  '  digitalWrite(15, v);',
  '  Serial1.println(v ? "Sending HIGH" : "Sending LOW");',
  '  delay(20);',
  '}',
].join('\n');

const artifact = await compile(PICO, SOURCE);
if (!artifact) {
  skip('the RP2040 toolchain is unavailable — the multi-board sections cannot run');
  console.log(failures === 0 ? `\nSerial attribution checks passed (${skipped} skipped).` : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

{
  const project = emptyProject('serial-attribution');
  const high = 'board-high';
  const low = 'board-low';
  for (const instanceId of [high, low]) {
    project.boardInstances.push({
      id: instanceId,
      definitionId: PICO,
      x: 100,
      y: 100,
      rotation: 0,
      properties: {},
      simulationState: {},
    } as ComponentInstance);
  }
  // One board's input is tied to its own 3V3 rail, the other's to its own
  // ground. Real wires on the canvas, not a call into the runner.
  let wireId = 0;
  for (const [a, ap, b, bp] of [
    [high, 'GP16', high, '3V3'],
    [low, 'GP16', low, 'GND7'],
    [high, 'GND1', low, 'GND1'],
  ] as [string, string, string, string][]) {
    project.connections.push({
      id: `w${++wireId}`,
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

  const transcript = new SerialTranscript();
  const events: SerialOutputEvent[] = [];
  const world = new SimulationWorld({
    sliceMs: 1,
    onSerial: (event) => {
      events.push(event);
      transcript.push(event);
    },
  });

  const board = getBoardDefinition(PICO)!;
  const adapter = getSimulatorAdapter(board)!;
  // The same compiled artifact for both, because they are the same board type
  // running the same sketch — and two separate runners, because they are two
  // separate boards.
  const runners = new Map<string, BoardRunner>();
  for (const instanceId of [high, low]) {
    const runner = await adapter.createRunner(artifact, board);
    runners.set(instanceId, runner);
    world.add(instanceId, runner);
  }

  check(world.boards.length === 2, `the world holds two board instances (${world.boards.length})`);
  check(runners.get(high) !== runners.get(low), 'which are two different runner objects');
  check(world.runnerFor(high) !== world.runnerFor(low), 'and resolve separately by instance id');

  const binding = new CircuitBinding(project, world.boards[0].runner, world.runnerMap());
  world.settle = () => binding.update(emptyControls());

  for (let i = 0; i < 400; i++) world.runFor(1);

  // ---- the boards disagreed, which needs two machines ----
  check(world.runnerFor(high)!.digitalPinLevel(15) === 'high', 'the board wired to 3V3 drives its output high');
  check(world.runnerFor(low)!.digitalPinLevel(15) === 'low', 'and the board wired to ground drives its output low');

  // ---- every byte is attributed ----
  check(events.length > 0, `serial bytes were produced (${events.length})`);
  check(
    events.every((e) => e.instanceId === high || e.instanceId === low),
    'every byte names a board instance that is actually in the world',
  );
  check(
    events.every((e) => e.byte >= 0 && e.byte <= 255 && Number.isInteger(e.byte)),
    'and is a byte',
  );
  check(
    events.every((e) => e.timestamp >= 0 && e.timestamp <= world.timeMs),
    'stamped with a simulated time inside the run',
  );
  const fromHigh = events.filter((e) => e.instanceId === high).length;
  const fromLow = events.filter((e) => e.instanceId === low).length;
  check(fromHigh > 0 && fromLow > 0, `both boards spoke (${fromHigh} bytes / ${fromLow} bytes)`);

  // ---- and the attribution is right, not merely present ----
  const highLines = transcript.linesFor(high).filter((l) => l.complete);
  const lowLines = transcript.linesFor(low).filter((l) => l.complete);
  check(highLines.length > 0 && lowLines.length > 0, `each board produced whole lines (${highLines.length} / ${lowLines.length})`);
  check(
    highLines.every((l) => l.text === 'Sending HIGH'),
    `the 3V3-wired board only ever said "Sending HIGH" (${[...new Set(highLines.map((l) => l.text))].join(' | ')})`,
  );
  check(
    lowLines.every((l) => l.text === 'Sending LOW'),
    `the grounded board only ever said "Sending LOW" (${[...new Set(lowLines.map((l) => l.text))].join(' | ')})`,
  );

  // ---- what a person would read ----
  const labels = buildSerialLabels(
    world.boards.map((m) => ({ instanceId: m.instanceId, boardName: board.name })),
  );
  const text = transcript.render((id) => labels.get(id) ?? id);
  const first = text.split('\n').filter(Boolean).slice(0, 4);
  console.log('   transcript:', JSON.stringify(first));
  check(
    first.every((line) => /^\[Raspberry Pi Pico #[12]\] Sending (HIGH|LOW)$/.test(line)),
    'the rendered transcript prefixes every line with the board that wrote it',
  );
  check(
    text.includes('#1] Sending') && text.includes('#2] Sending'),
    'and both boards appear in it under distinct labels',
  );

  // ---- resetting one board does not disturb the other's attribution ----
  const beforeReset = transcript.linesFor(low).length;
  world.resetBoard(high);
  for (let i = 0; i < 200; i++) world.runFor(1);
  check(transcript.linesFor(low).length > beforeReset, 'the untouched board kept printing across the other\'s reset');
  check(
    transcript.linesFor(low).filter((l) => l.complete).every((l) => l.text === 'Sending LOW'),
    'and still says only what its own wiring makes true',
  );

  // ---- removing a board stops its output and leaves the other's alone ----
  const removedAt = events.length;
  world.remove(high);
  for (let i = 0; i < 100; i++) world.runFor(1);
  const after = events.slice(removedAt);
  check(after.length > 0, `the remaining board carried on (${after.length} bytes)`);
  check(after.every((e) => e.instanceId === low), 'and every byte after the removal is the remaining board\'s');

  world.dispose();
}

// ================================================ 3. serial input names a board
//
// The other direction: "send this to the serial port" has to say which port
// once there is more than one.
{
  const sent: string[] = [];
  const world = new SimulationWorld({ sliceMs: 1 });
  const fake = (name: string): BoardRunner =>
    ({
      engine: 'avr8js',
      timeMs: 0,
      runFor() {},
      digitalPinLevel: () => undefined,
      isOutput: () => false,
      setDigitalInput() {},
      addPinListener: () => () => {},
      onPinChange: null,
      adcChannelForPin: () => undefined,
      setAnalogVolts() {},
      onSerialByte: null,
      queueSerialInput: (text: string) => sent.push(`${name}:${text}`),
      addMicrosecondEvent: () => () => {},
      snapshot: () => ({ states: [], duty: [], pulseWidthUs: [], toggles: [] }),
    }) as unknown as BoardRunner;

  world.add('one', fake('one'));
  world.add('two', fake('two'));
  check(world.sendSerial('two', 'hello') === true, 'serial input can be addressed to one instance');
  check(sent.length === 1 && sent[0] === 'two:hello', `and reaches only that board (${sent.join(', ')})`);
  check(world.sendSerial('missing', 'hello') === false, 'and an unknown instance is reported rather than swallowed');
  world.dispose();
}

console.log(
  failures === 0
    ? `\nSerial attribution checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
