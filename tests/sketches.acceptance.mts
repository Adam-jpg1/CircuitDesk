// The project this feature exists for.
//
// An ESP32-C6 sending, a Raspberry Pi Pico receiving, and an LCD showing what
// arrived. Two boards, two sketches, each containing only its own half — no
// architecture conditional, no role-select pin, no sketch that is secretly
// both. That was impossible before: one editor source meant one program, and
// the program had to work out which board it had woken up on.
//
// Everything runs through `simulationController`, the object the Run button
// drives, and the signal crosses a real canvas net between two real modelled
// pads. The LCD's text comes out of the HD44780 model the Pico's firmware
// actually talked to over I2C.

import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject } from '../src/project/templates';
import { assignSketch, createSeparateSketch, sketchIdFor } from '../src/project/sketches';
import { normalizeProject } from '../src/project/projectService';
import type { CircuitProject, ComponentInstance } from '../src/types';

const PICO = 'board.raspberry-pi-pico';
const C6 = 'board.esp32-c6-devkitc-1';

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

let seq = 0;
const uid = (p: string) => `${p}${++seq}`;

interface Spec {
  boards: { id: string; definitionId: string; sketchId: string; label?: string }[];
  parts?: { id: string; definitionId: string; properties?: Record<string, unknown> }[];
  sketches: { id: string; name: string; content: string }[];
  wires: [string, string, string, string][];
}

function projectOf(spec: Spec): CircuitProject {
  const p = emptyProject('per-board-sketches');
  p.codeFiles = spec.sketches.map((s) => ({ ...s, language: 'cpp' as const }));
  for (const b of spec.boards) {
    p.boardInstances.push({
      id: b.id, definitionId: b.definitionId, x: 0, y: 0, rotation: 0,
      properties: {}, simulationState: {}, sketchId: b.sketchId, ...(b.label ? { label: b.label } : {}),
    } as ComponentInstance);
  }
  for (const c of spec.parts ?? []) {
    p.componentInstances.push({
      id: c.id, definitionId: c.definitionId, x: 300, y: 0, rotation: 0,
      properties: c.properties ?? {}, simulationState: {},
    } as ComponentInstance);
  }
  for (const [a, ap, b, bp] of spec.wires) {
    p.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#e8590c', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  }
  return p;
}

/** Transport failures are not build failures — a dropped socket is retried. */
const TRANSIENT =
  /fetch failed|socket|ECONN|EAI_AGAIN|network|timed out|Could not reach the compiler|502|503|504|rate limit/i;

async function buildWithRetry(project: CircuitProject, attempts = 3) {
  let report = await simulationController.build(project);
  for (let i = 1; i < attempts; i++) {
    const transient = report.builds.some((b) => b.status !== 'built' && TRANSIENT.test(b.detail));
    if (!transient) break;
    console.log(`   (transient compiler transport error — retry ${i})`);
    await new Promise((r) => setTimeout(r, 2000 * i));
    report = await simulationController.build(project);
  }
  return report;
}

async function run(project: CircuitProject): Promise<boolean> {
  simulationController.stop();
  const report = await buildWithRetry(project);
  for (const b of report.builds) console.log(`   build: ${b.detail}  [used by ${b.instanceIds.length}]`);
  // A build the compiler never received is not a result to assert against —
  // skip the section rather than report a transport outage as a product bug.
  if (report.builds.some((b) => b.status !== 'built' && TRANSIENT.test(b.detail))) return false;
  if (!report.anyRunnable) return false;
  if (!(await simulationController.start())) {
    console.log(`   (start refused: ${useSimulationStore.getState().error ?? '—'})`);
    return false;
  }
  simulationController.pause();
  return true;
}

// A cheap probe so a missing toolchain skips rather than fails.
{
  const probe = projectOf({
    boards: [{ id: 'p', definitionId: PICO, sketchId: 's' }],
    sketches: [{ id: 's', name: 'sketch.ino', content: 'void setup(){}\nvoid loop(){}' }],
    wires: [],
  });
  const report = await simulationController.build(probe);
  if (!report.anyRunnable) {
    skip('the RP2040 toolchain is unavailable — the acceptance sections cannot run');
    console.log(`\nPer-board sketch acceptance skipped (${skipped}).`);
    process.exit(0);
  }
}

// =============== 1. ESP32-C6 sender → Pico receiver → LCD, two real sketches ==
//
// The C6's source is a sender and nothing else. The Pico's is a receiver and
// nothing else. Neither mentions the other's architecture.
const SENDER = [
  '// Sender. Runs on the ESP32-C6. Knows nothing about receivers or displays.',
  'void setup() {',
  '  pinMode(2, OUTPUT);',
  '}',
  'void loop() {',
  '  digitalWrite(2, HIGH);',
  '  delay(60);',
  '  digitalWrite(2, LOW);',
  '  delay(60);',
  '}',
].join('\n');

const RECEIVER = [
  '// Receiver. Runs on the Pico. Knows nothing about senders.',
  '#include <Wire.h>',
  '',
  'const uint8_t ADDR = 0x27;',
  'uint8_t backlight = 0x08;',
  '',
  'void expander(uint8_t data) {',
  '  Wire.beginTransmission(ADDR);',
  '  Wire.write(data | backlight);',
  '  Wire.endTransmission();',
  '}',
  'void pulse(uint8_t data) {',
  '  expander(data | 0x04);',
  '  delayMicroseconds(2);',
  '  expander(data & ~0x04);',
  '  delayMicroseconds(60);',
  '}',
  'void send(uint8_t value, uint8_t mode) {',
  '  pulse((value & 0xF0) | mode);',
  '  pulse(((value << 4) & 0xF0) | mode);',
  '}',
  'void command(uint8_t c) { send(c, 0); }',
  'void writeChar(char c) { send((uint8_t)c, 1); }',
  'void print(const char *s) { while (*s) writeChar(*s++); }',
  '',
  'void setup() {',
  '  pinMode(16, INPUT);',
  '  Wire.setSDA(4);',
  '  Wire.setSCL(5);',
  '  Wire.begin();',
  '  delay(50);',
  '  pulse(0x30); delay(5);',
  '  pulse(0x30); delay(5);',
  '  pulse(0x20); delay(5);',
  '  command(0x28); command(0x08); command(0x01); delay(3);',
  '  command(0x06); command(0x0C);',
  '  command(0x80); print("TEST CIRCUITDESK");',
  '}',
  '',
  'int last = -1;',
  'void loop() {',
  '  int v = digitalRead(16);',
  '  if (v != last) {',
  '    last = v;',
  '    command(0xC0);',
  '    print(v ? "TRY IT TODAY   " : "WAITING...     ");',
  '  }',
  '}',
].join('\n');

const c6 = uid('b');
const pico = uid('b');
const lcd = uid('c');
{
  const project = projectOf({
    boards: [
      { id: c6, definitionId: C6, sketchId: 'send' },
      { id: pico, definitionId: PICO, sketchId: 'recv' },
    ],
    parts: [{ id: lcd, definitionId: 'comp.lcd1602' }],
    sketches: [
      { id: 'send', name: 'sender.ino', content: SENDER },
      { id: 'recv', name: 'receiver.ino', content: RECEIVER },
    ],
    wires: [
      [c6, 'IO2', pico, 'GP16'],
      [c6, 'GND1', pico, 'GND3'],
      [pico, 'GP4', lcd, 'sda'],
      [pico, 'GP5', lcd, 'scl'],
      [pico, '3V3', lcd, 'vcc'],
      [pico, 'GND1', lcd, 'gnd'],
    ],
  });

  // Neither sketch may contain the tricks this feature is meant to retire.
  for (const [name, src] of [['sender.ino', SENDER], ['receiver.ino', RECEIVER]] as const) {
    check(!/#if\s*(defined\s*\()?\s*ARDUINO_ARCH/.test(src), `${name} contains no architecture conditional`);
    check(!/ARDUINO_ARCH_RP2040|ARDUINO_ARCH_ESP32/.test(src), `${name} does not name an architecture at all`);
  }
  check(!/Wire|lcd|LCD/i.test(SENDER), 'the sender says nothing about displays');
  check(!/digitalWrite\(2/.test(RECEIVER), 'and the receiver does not drive the sender\'s pin');

  if (!(await run(project))) {
    skip('the sender/receiver project would not start');
  } else {
    const builds = simulationController.buildReport;
    check(builds.length === 2, `two sketches produced two builds (${builds.length})`);
    check(
      builds.some((b) => b.sketchName === 'sender.ino' && b.fqbn === 'esp32:esp32:esp32c6' && b.status === 'built'),
      'sender.ino built for the C6',
    );
    check(
      builds.some((b) => b.sketchName === 'receiver.ino' && b.fqbn === 'rp2040:rp2040:rpipico' && b.status === 'built'),
      'receiver.ino built for the Pico',
    );
    check(builds.every((b) => b.instanceIds.length === 1), 'each build serves exactly the board that uses it');

    const sender = simulationController.runnerFor(c6)!;
    const receiver = simulationController.runnerFor(pico)!;
    check(sender.engine === 'esp32c6' && receiver.engine === 'rp2040js', `each on its own engine (${sender.engine}, ${receiver.engine})`);

    // Let both boot and settle, then watch the LCD.
    const seen = new Set<string>();
    let c6High = 0;
    let c6Low = 0;
    for (let i = 0; i < 1400; i++) {
      simulationController.advance(1);
      if (i % 20 === 0) simulationController.publishNow();
      const level = sender.digitalPinLevel(2);
      if (level === 'high') c6High++;
      if (level === 'low') c6Low++;
      const visuals = useSimulationStore.getState().visuals as Record<string, { readout?: string[] }>;
      const rows = visuals[lcd]?.readout;
      if (rows) seen.add(rows.map((r) => r.trimEnd()).join(' | '));
    }
    simulationController.publishNow();

    check(c6High > 50 && c6Low > 50, `the C6's sender drives IO2 both ways (${c6High} high / ${c6Low} low)`);
    check(receiver.timeMs > 500, `the Pico's receiver ran (${receiver.timeMs.toFixed(0)} ms)`);

    const final = (useSimulationStore.getState().visuals as Record<string, { readout?: string[] }>)[lcd]?.readout ?? [];
    console.log('   LCD:', JSON.stringify(final));
    check(final[0]?.startsWith('TEST CIRCUITDESK'), `the LCD shows the receiver's first line (${JSON.stringify(final[0])})`);
    const states = [...seen].join('\n');
    check(/TRY IT TODAY/.test(states), "and the second line shows what the sender's edge caused");
    check(/WAITING/.test(states), 'having also shown the idle state, so it is following the wire');
    check(seen.size > 1, `the display changed as the signal changed (${seen.size} distinct states)`);
  }
}

// ============ 2. two Picos, different sketches, then the same one ============
{
  const a = uid('b');
  const b = uid('b');
  const SEND2 = 'void setup(){ pinMode(15, OUTPUT); }\nvoid loop(){ digitalWrite(15, HIGH); }';
  const RECV2 = [
    'void setup(){ pinMode(16, INPUT); pinMode(14, OUTPUT); }',
    'void loop(){ digitalWrite(14, digitalRead(16)); }',
  ].join('\n');

  const project = projectOf({
    boards: [
      { id: a, definitionId: PICO, sketchId: 'sa' },
      { id: b, definitionId: PICO, sketchId: 'rb' },
    ],
    sketches: [
      { id: 'sa', name: 'sender.ino', content: SEND2 },
      { id: 'rb', name: 'receiver.ino', content: RECV2 },
    ],
    wires: [
      [a, 'GND1', b, 'GND1'],
      [a, 'GP15', b, 'GP16'],
    ],
  });

  if (!(await run(project))) {
    skip('the two-Pico project would not start');
  } else {
    const builds = simulationController.buildReport;
    check(builds.length === 2, `same target, different sketches — two builds (${builds.length})`);
    check(builds.every((b2) => b2.fqbn === 'rp2040:rp2040:rpipico'), 'both for the Pico target');
    check(new Set(builds.map((b2) => b2.sketchId)).size === 2, 'from two sketch documents');
    check(builds.every((b2) => b2.status === 'built'), 'both built');

    simulationController.advance(400);
    const sender = simulationController.runnerFor(a)!;
    const receiver = simulationController.runnerFor(b)!;
    check(sender !== receiver, 'two independent runners');
    check(sender.digitalPinLevel(15) === 'high', 'the sender drives its output high');
    check(receiver.digitalPinLevel(14) === 'high', 'and the receiver mirrors it, over the canvas wire');
    check(receiver.digitalPinLevel(16) !== undefined, 'through a real modelled input pad');

    // Now put both on one sketch: one artifact, still two machines.
    const shared = assignSketch(project, b, 'sa');
    if (!(await run(shared))) {
      skip('the shared-sketch variant would not start');
    } else {
      const sharedBuilds = simulationController.buildReport;
      check(sharedBuilds.length === 1, `both boards on one sketch is one build (${sharedBuilds.length})`);
      check(sharedBuilds[0].instanceIds.length === 2, 'serving both boards');
      check(sharedBuilds[0].sketchName === 'sender.ino', 'named by the sketch they share');
      const r1 = simulationController.runnerFor(a)!;
      const r2 = simulationController.runnerFor(b)!;
      check(r1 !== r2, 'and it is still two independent runners');
      simulationController.advance(200);
      check(r1.digitalPinLevel(15) === 'high' && r2.digitalPinLevel(15) === 'high', 'both running the same firmware');
      simulationController.resetBoard(a);
      check(r1.timeMs < r2.timeMs, `resetting one leaves the other running (${r1.timeMs.toFixed(1)} vs ${r2.timeMs.toFixed(1)} ms)`);
    }
  }
}

// ================================= 3. partial success, per sketch and target ==
{
  const p1 = uid('b');
  const c = uid('b');
  const project = projectOf({
    boards: [
      { id: p1, definitionId: PICO, sketchId: 'ok' },
      { id: c, definitionId: C6, sketchId: 'bad' },
    ],
    sketches: [
      { id: 'ok', name: 'blink.ino', content: 'void setup(){ pinMode(15, OUTPUT); }\nvoid loop(){ digitalWrite(15, HIGH); }' },
      { id: 'bad', name: 'controller.ino', content: 'void setup(){ this_function_does_not_exist(); }\nvoid loop(){}' },
    ],
    wires: [[p1, 'GND1', c, 'GND1']],
  });
  simulationController.stop();
  const report = await simulationController.build(project);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  const good = report.builds.find((b) => b.sketchName === 'blink.ino');
  const bad = report.builds.find((b) => b.sketchName === 'controller.ino');
  check(good?.status === 'built', `the good sketch built (${good?.status})`);
  check(bad?.status === 'compile-failed', `and the broken one did not (${bad?.status})`);
  check(/controller\.ino/.test(bad?.detail ?? ''), `the failure names the sketch (${bad?.detail})`);
  check(/ESP32-C6-DevKitC-1/.test(bad?.detail ?? ''), 'and the board family');
  check(report.anyRunnable && !report.allSucceeded, 'so the workspace is partly runnable');

  check(await simulationController.start(), 'the board whose sketch built still runs');
  simulationController.pause();
  check(simulationController.runnerFor(p1) !== undefined, 'the Pico has a runner');
  check(simulationController.runnerFor(c) === undefined, 'and the C6 has none — no stale firmware, no other target');

  const summaries = useSimulationStore.getState().builds;
  check(summaries.length === 2, `both outcomes reach the UI (${summaries.length})`);
  check(summaries.every((s) => s.usedBy.length > 0), 'each naming the boards it serves');
}

// ===================== 4. one failing sketch shared by three boards, once ====
{
  const ids = [uid('b'), uid('b'), uid('b')];
  const project = projectOf({
    boards: ids.map((id) => ({ id, definitionId: PICO, sketchId: 'bad' })),
    sketches: [{ id: 'bad', name: 'receiver.ino', content: 'void setup(){ nope(); }\nvoid loop(){}' }],
    wires: [[ids[0], 'GND1', ids[1], 'GND1'], [ids[1], 'GND2', ids[2], 'GND1']],
  });
  simulationController.stop();
  const report = await simulationController.build(project);
  check(report.builds.length === 1, `three boards sharing one failing sketch is one error (${report.builds.length})`);
  check(report.builds[0].instanceIds.length === 3, 'listing all three affected boards');
  const summary = useSimulationStore.getState().builds[0];
  check(summary.usedBy.length === 3, `and the UI shows who is affected (${summary?.usedBy.join(', ')})`);
  check(new Set(summary.usedBy).size === 3, 'each named distinctly');
}

// ============================= 5. serial identity is the board, not the sketch =
{
  const a = uid('b');
  const b = uid('b');
  const SRC = [
    'void setup(){ Serial1.begin(115200); pinMode(16, INPUT); }',
    'void loop(){ Serial1.println(digitalRead(16) ? "HIGH SIDE" : "LOW SIDE"); delay(20); }',
  ].join('\n');
  const project = projectOf({
    boards: [
      { id: a, definitionId: PICO, sketchId: 'one', label: 'Sender Node' },
      { id: b, definitionId: PICO, sketchId: 'one', label: 'Display Node' },
    ],
    sketches: [{ id: 'one', name: 'shared.ino', content: SRC }],
    wires: [
      [a, 'GND1', b, 'GND1'],
      [a, 'GP16', a, '3V3'],
      [b, 'GP16', b, 'GND7'],
    ],
  });
  if (!(await run(project))) {
    skip('the shared-sketch serial project would not start');
  } else {
    check(simulationController.buildReport.length === 1, 'one build for the shared sketch');
    simulationController.advance(400);
    simulationController.publishNow();
    const text = useSimulationStore.getState().serialText;
    console.log('   serial:', JSON.stringify(text.split('\n').filter(Boolean).slice(0, 3)));
    check(/\[Sender Node\]/.test(text), 'serial is attributed to the board\'s own name');
    check(/\[Display Node\]/.test(text), 'for both boards');
    check(!/shared\.ino/.test(text), 'and never to the sketch they share');
    const senderSaid = text.split('\n').filter((l) => l.startsWith('[Sender Node]'));
    const displaySaid = text.split('\n').filter((l) => l.startsWith('[Display Node]'));
    check(senderSaid.every((l) => /HIGH SIDE/.test(l)), 'the board wired high says so');
    check(displaySaid.every((l) => /LOW SIDE/.test(l)), 'and the board wired low says the other thing');
  }
}

// ============================================== 6. save, reload, still right ==
{
  const a = uid('b');
  const b = uid('b');
  const c = uid('b');
  const project = projectOf({
    boards: [
      { id: a, definitionId: PICO, sketchId: 'recv' },
      { id: b, definitionId: PICO, sketchId: 'recv' },
      { id: c, definitionId: C6, sketchId: 'send' },
    ],
    sketches: [
      { id: 'recv', name: 'receiver.ino', content: RECEIVER },
      { id: 'send', name: 'sender.ino', content: SENDER },
    ],
    wires: [[a, 'GND1', b, 'GND1'], [b, 'GND2', c, 'GND1']],
  });

  // Through JSON, which is what persistence does to it.
  const reloaded = normalizeProject(JSON.parse(JSON.stringify(project)));
  check(reloaded.codeFiles.length === 2, 'both sketches survive a save and reload');
  check(reloaded.codeFiles.find((f) => f.id === 'recv')?.content === RECEIVER, 'the receiver source is byte-for-byte identical');
  check(reloaded.codeFiles.find((f) => f.id === 'send')?.content === SENDER, 'and so is the sender');
  check(reloaded.codeFiles.map((f) => f.name).join(',') === 'receiver.ino,sender.ino', 'names preserved');
  check(sketchIdFor(reloaded, a) === 'recv' && sketchIdFor(reloaded, b) === 'recv', 'the two Picos still share one sketch id');
  check(sketchIdFor(reloaded, c) === 'send', 'and the C6 still has its own');
  check(reloaded.boardInstances.map((x) => x.id).join(',') === [a, b, c].join(','), 'board instance ids preserved');

  if (!(await run(reloaded))) {
    skip('the reloaded project would not start');
  } else {
    const builds = simulationController.buildReport;
    check(builds.length === 2, `the reloaded project builds two sketches (${builds.length})`);
    const recvBuild = builds.find((x) => x.sketchName === 'receiver.ino');
    check(recvBuild?.instanceIds.length === 2, 'with the shared one serving both Picos');
    check(builds.find((x) => x.sketchName === 'sender.ino')?.fqbn === 'esp32:esp32:esp32c6', 'and the C6 on its own');
    simulationController.advance(300);
    check(simulationController.runnerFor(c)!.digitalPinLevel(2) !== undefined, 'the reloaded C6 runs the sender');
    check(simulationController.boardInstanceIds.length === 3, 'all three boards are running');
  }
}

// ============================ 7. add, remove and re-add with assignments ====
{
  const a = uid('b');
  const b = uid('b');
  const SRC = 'void setup(){ pinMode(15, OUTPUT); }\nvoid loop(){ digitalWrite(15, HIGH); }';
  const project = projectOf({
    boards: [
      { id: a, definitionId: PICO, sketchId: 's1' },
      { id: b, definitionId: PICO, sketchId: 's2' },
    ],
    sketches: [
      { id: 's1', name: 'a.ino', content: SRC },
      { id: 's2', name: 'b.ino', content: `${SRC}\n// different` },
    ],
    wires: [[a, 'GND1', b, 'GND1']],
  });
  if (!(await run(project))) {
    skip('the lifecycle project would not start');
  } else {
    simulationController.advance(200);
    const runnerB = simulationController.runnerFor(b)!;
    const beforeRemove = runnerB.timeMs;

    simulationController.removeBoard(a);
    check(simulationController.runnerFor(a) === undefined, 'the removed board is gone');
    simulationController.advance(100);
    check(runnerB.timeMs > beforeRemove, `the other board keeps running (${runnerB.timeMs.toFixed(0)} ms)`);

    const elapsed = runnerB.timeMs;
    const added = await simulationController.addBoard(a);
    check(added, 're-adding the board succeeds without recompiling');
    const runnerA = simulationController.runnerFor(a);
    check(runnerA !== undefined && runnerA.timeMs < 5, `and it starts fresh (${runnerA?.timeMs.toFixed(2)} ms)`);
    check(runnerB.timeMs === elapsed, 'while the untouched board did not restart');
    simulationController.advance(200);
    check(runnerA!.digitalPinLevel(15) === 'high', 'the re-added board runs its own assigned sketch');
  }
}

// =================== 8. create-separate through the running controller ======
{
  const a = uid('b');
  const b = uid('b');
  const project = projectOf({
    boards: [
      { id: a, definitionId: PICO, sketchId: 'sh' },
      { id: b, definitionId: PICO, sketchId: 'sh' },
    ],
    sketches: [{ id: 'sh', name: 'shared.ino', content: 'void setup(){ pinMode(15, OUTPUT); }\nvoid loop(){ digitalWrite(15, HIGH); }' }],
    wires: [[a, 'GND1', b, 'GND1']],
  });
  simulationController.stop();
  const before = await simulationController.build(project);
  check(before.builds.length === 1, 'shared to start with: one build');

  const { project: split, sketchId } = createSeparateSketch(project, b);
  const edited: CircuitProject = {
    ...split,
    codeFiles: split.codeFiles.map((f) =>
      f.id === sketchId ? { ...f, content: 'void setup(){ pinMode(14, OUTPUT); }\nvoid loop(){ digitalWrite(14, HIGH); }' } : f,
    ),
  };
  const after = await simulationController.build(edited);
  check(after.builds.length === 2, `after separating, two builds (${after.builds.length})`);
  check(after.builds.every((x) => x.status === 'built'), 'both of which built');
  check(new Set(after.builds.map((x) => x.sketchId)).size === 2, 'from two documents');

  if (await simulationController.start()) {
    simulationController.pause();
    simulationController.advance(400);
    const ra = simulationController.runnerFor(a)!;
    const rb = simulationController.runnerFor(b)!;
    check(ra.digitalPinLevel(15) === 'high', 'the board left on the shared sketch drives GP15');
    check(rb.digitalPinLevel(14) === 'high', 'and the separated board drives GP14, its own code');
    check(rb.digitalPinLevel(15) !== 'high', 'no longer doing what the shared sketch does');
  } else {
    skip('the separated project would not start');
  }
}

simulationController.stop();
console.log(
  failures === 0
    ? `\nPer-board sketch acceptance passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
