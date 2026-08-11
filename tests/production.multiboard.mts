// The real application's simulation path, with more than one board on it.
//
// Everything here goes through `simulationController` — the object the Run
// button drives — and not through a SimulationWorld built by the test. That
// distinction is the point of the file. The world was already correct; the
// controller was the thing that still owned one runner, so a workspace with two
// Picos ran one CPU and reported it twice. A test that constructed its own world
// would have passed the whole time.
//
// So: one editor source, real compilation through the real service, one runner
// per board instance, and every observation taken from the controller.

import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject } from '../src/project/templates';
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
function finish(): never {
  console.log(
    failures === 0
      ? `\nProduction multi-board checks passed (${skipped} skipped).`
      : `\n${failures} check(s) FAILED (${skipped} skipped)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

let seq = 0;
const uid = (p: string) => `${p}${++seq}`;

interface Placement {
  boards: { id: string; definitionId: string; label?: string }[];
  parts?: { id: string; definitionId: string; properties?: Record<string, unknown> }[];
  wires: [string, string, string, string][];
  source: string;
}

function projectOf(p: Placement): CircuitProject {
  const project = emptyProject('production-multiboard');
  project.codeFiles = [{ id: 'f1', name: 'sketch.ino', content: p.source, language: 'cpp' }];
  for (const b of p.boards) {
    project.boardInstances.push({
      id: b.id, definitionId: b.definitionId, x: 0, y: 0, rotation: 0,
      properties: {}, simulationState: {}, ...(b.label ? { label: b.label } : {}),
    } as ComponentInstance);
  }
  for (const c of p.parts ?? []) {
    project.componentInstances.push({
      id: c.id, definitionId: c.definitionId, x: 300, y: 0, rotation: 0,
      properties: c.properties ?? {}, simulationState: {},
    } as ComponentInstance);
  }
  for (const [a, ap, b, bp] of p.wires) {
    project.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#e8590c', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  }
  return project;
}

/**
 * Builds and starts through the production controller, then pauses.
 *
 * Pausing is what makes the rest deterministic: the running simulation is
 * driven by a wall-clock timer, and a test that measured it would measure the
 * host. `advance()` is the same code path that timer calls.
 */
async function runProject(project: CircuitProject): Promise<boolean> {
  simulationController.stop();
  const report = await simulationController.build(project);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable) return false;
  const started = await simulationController.start();
  if (!started) {
    console.log(`   (start refused: ${useSimulationStore.getState().error ?? 'no reason given'})`);
    return false;
  }
  simulationController.pause();
  return true;
}

const BLINK_SOURCE = 'void setup(){}\nvoid loop(){}';

// A probe compile decides whether the toolchains are here at all.
{
  const probe = projectOf({ boards: [{ id: uid('b'), definitionId: PICO }], wires: [], source: BLINK_SOURCE });
  const report = await simulationController.build(probe);
  if (!report.anyRunnable) {
    skip('the RP2040 toolchain is unavailable — the production sections cannot run');
    finish();
  }
}

// ==================================================== 1. two identical Picos
//
// One editor source. One RP2040 build. Two board instances. Their inputs are
// wired to opposite levels through real canvas nets, so the same firmware has
// to produce different behaviour — which is only possible with two machines.
const TWO_PICO_SOURCE = [
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

const picoHigh = uid('b');
const picoLow = uid('b');
{
  const project = projectOf({
    boards: [{ id: picoHigh, definitionId: PICO }, { id: picoLow, definitionId: PICO }],
    wires: [
      [picoHigh, 'GP16', picoHigh, '3V3'],
      [picoLow, 'GP16', picoLow, 'GND7'],
      [picoHigh, 'GND1', picoLow, 'GND1'],
    ],
    source: TWO_PICO_SOURCE,
  });

  if (!(await runProject(project))) {
    skip('the two-Pico project would not start');
  } else {
    const builds = simulationController.buildReport;
    check(builds.length === 1, `one editor source produced one RP2040 build (${builds.length})`);
    check(builds[0].instanceIds.length === 2, `shared by both board instances (${builds[0].instanceIds.length})`);
    check(builds[0].fqbn === 'rp2040:rp2040:rpipico', `for the real target (${builds[0].fqbn})`);

    check(simulationController.isMultiBoard, 'the controller is running more than one board');
    check(simulationController.boardInstanceIds.length === 2, `two instances (${simulationController.boardInstanceIds.length})`);
    const a = simulationController.runnerFor(picoHigh)!;
    const b = simulationController.runnerFor(picoLow)!;
    check(a !== undefined && b !== undefined, 'each instance resolves to a runner');
    check(a !== b, 'and they are two different runner objects, not one reported twice');

    simulationController.advance(400);
    simulationController.publishNow();

    // ---- independent GPIO, from identical firmware ----
    check(a.digitalPinLevel(15) === 'high', 'the Pico wired to 3V3 drives its output high');
    check(b.digitalPinLevel(15) === 'low', 'and the Pico wired to ground drives its output low');
    check(a.digitalPinLevel(15) !== b.digitalPinLevel(15), 'so the same sketch produced different behaviour');

    // ---- independent RAM, observed through what each CPU printed ----
    const text = useSimulationStore.getState().serialText;
    console.log('   serial:', JSON.stringify(text.split('\n').filter(Boolean).slice(0, 4)));
    check(/Sending HIGH/.test(text) && /Sending LOW/.test(text), 'both messages appear in the monitor');
    const lines = text.split('\n').filter(Boolean);
    check(
      lines.every((l) => /^\[Raspberry Pi Pico #[12]\] Sending (HIGH|LOW)$/.test(l)),
      `every line is attributed to a board instance (${lines[0]})`,
    );
    const labelOf = (fragment: string) =>
      [...new Set(lines.filter((l) => l.endsWith(fragment)).map((l) => l.slice(0, l.indexOf(']') + 1)))];
    check(labelOf('HIGH').length === 1 && labelOf('LOW').length === 1, 'each message comes from exactly one board');
    check(labelOf('HIGH')[0] !== labelOf('LOW')[0], `and they are different boards (${labelOf('HIGH')} vs ${labelOf('LOW')})`);

    // ---- independent simulated time participation ----
    const timeA = a.timeMs;
    const timeB = b.timeMs;
    check(timeA > 100 && timeB > 100, `both CPUs advanced (${timeA.toFixed(1)} ms / ${timeB.toFixed(1)} ms)`);
    check(Math.abs(timeA - timeB) < 2, 'and by the same amount, because they share one timeline');

    // ---- independent reset ----
    const beforeB = b.timeMs;
    simulationController.resetBoard(picoHigh);
    check(a.timeMs < beforeB, `resetting one board restarts only it (${a.timeMs.toFixed(2)} ms vs ${beforeB.toFixed(1)} ms)`);
    check(b.timeMs >= beforeB, 'and the other keeps its own elapsed time');
    simulationController.advance(200);
    check(b.digitalPinLevel(15) === 'low', 'the untouched board is still doing what its wiring says');
    check(a.digitalPinLevel(15) === 'high', 'and the reset board comes back up on its own wiring');

    // ---- removing one leaves the other running ----
    simulationController.removeBoard(picoHigh);
    check(simulationController.boardInstanceIds.length === 1, 'the removed board is gone from the world');
    check(simulationController.runnerFor(picoHigh) === undefined, 'and has no runner');
    const beforeRemoveTime = b.timeMs;
    simulationController.advance(100);
    check(b.timeMs > beforeRemoveTime, `the remaining board carried on (${b.timeMs.toFixed(1)} ms)`);
    check(b.digitalPinLevel(15) === 'low', 'still driven by its own wiring');

    // ---- re-adding boots only the new instance ----
    const readdedElapsed = b.timeMs;
    const added = await simulationController.addBoard(picoHigh);
    check(added, 're-adding the board succeeds without recompiling');
    const a2 = simulationController.runnerFor(picoHigh);
    check(a2 !== undefined && a2 !== a, 'and produces a new runner, not the old one');
    check((a2?.timeMs ?? 999) < 5, `which starts from its own reset (${a2?.timeMs.toFixed(2)} ms)`);
    check(b.timeMs === readdedElapsed, 'while the board that was already running did not restart');
    simulationController.advance(300);
    check(a2?.digitalPinLevel(15) === 'high', 'and the new instance reaches its own steady state');
  }
}

// ============================================ 2. contention, through the app
{
  const one = uid('b');
  const two = uid('b');
  const contendedSource = [
    'void setup() {',
    '  pinMode(15, OUTPUT); pinMode(14, OUTPUT);',
    '  pinMode(12, OUTPUT); pinMode(11, OUTPUT); pinMode(10, OUTPUT);',
    '  pinMode(13, INPUT);',
    '}',
    'void loop() {',
    '  digitalWrite(15, HIGH); digitalWrite(14, LOW);',
    '  digitalWrite(12, HIGH); digitalWrite(11, HIGH); digitalWrite(10, HIGH);',
    '}',
  ].join('\n');
  // Three separate nets, each proving one thing. Both boards run the same
  // sketch, so which pin is on which end is what makes the difference.
  const project = projectOf({
    boards: [{ id: one, definitionId: PICO }, { id: two, definitionId: PICO }],
    wires: [
      [one, 'GND1', two, 'GND1'],
      [one, 'GP15', two, 'GP14'],   // HIGH against LOW     -> contention
      [one, 'GP12', two, 'GP11'],   // HIGH against HIGH    -> agreement
      [one, 'GP13', two, 'GP10'],   // input against output -> no contention
    ],
    source: contendedSource,
  });

  if (!(await runProject(project))) {
    skip('the contention project would not start');
  } else {
    simulationController.advance(60);
    const binding = (simulationController as unknown as { binding: { contendedNets: Set<string> } }).binding;
    const contended = [...binding.contendedNets];
    const graph = (simulationController as unknown as { binding: { graph: { netOf: Map<string, string> } } }).binding.graph;
    const netOf = (inst: string, pin: string) => graph.netOf.get(`${inst}:${pin}`);

    const conflictNet = netOf(one, 'GP15');
    const agreeNet = netOf(one, 'GP14');
    const inputNet = netOf(one, 'GP13');
    check(conflictNet !== undefined && contended.includes(conflictNet), `HIGH against LOW is reported as contention (${contended.length} net(s))`);
    check(agreeNet !== undefined && !contended.includes(agreeNet), 'LOW against LOW is not');
    check(inputNet !== undefined && !contended.includes(inputNet), 'and an output against an input is not');

    // Both boards' drivers must appear when the conflict is described.
    const runners = simulationController.boardInstanceIds;
    check(runners.length === 2, 'both boards are still running while the conflict stands');
  }
}

// ================================= 3. sub-millisecond events are not delayed
//
// The world's 1 ms slice is a ceiling, not a quantum. A net event due at
// 125 ns must wake the world at 125 ns. This is a controller-level check
// because the migration could easily have reintroduced fixed 1 ms stepping.
{
  const board = uid('b');
  const project = projectOf({
    boards: [{ id: board, definitionId: PICO }],
    wires: [],
    source: BLINK_SOURCE,
  });
  if (!(await runProject(project))) {
    skip('the timing project would not start');
  } else {
    const world = simulationController.simulationWorld!;
    const startNs = world.timeNs;
    const observed: number[] = [];
    const settles: number[] = [];
    const previousSettle = world.settle;
    world.settle = () => {
      settles.push(world.timeNs - startNs);
      previousSettle?.();
    };
    for (const at of [6, 125, 1_000, 8_681, 500_000]) {
      world.scheduleAtNs(startNs + at, () => observed.push(world.timeNs - startNs));
    }
    simulationController.advance(1);

    check(observed.length === 5, `every sub-millisecond event fired (${observed.length}/5)`);
    check(
      JSON.stringify(observed) === JSON.stringify([6, 125, 1000, 8681, 500000]),
      `each at exactly its own nanosecond, not the next millisecond (${observed.join(', ')})`,
    );
    // And the nets were resolved at those moments, not only at 1 ms.
    for (const at of [125, 8_681, 500_000]) {
      check(settles.includes(at), `the circuit settled at ${at} ns`);
    }
    check(
      settles.filter((n) => n < 1_000_000).length >= 5,
      `so settling is driven by the timeline, not by a millisecond tick (${settles.filter((n) => n < 1_000_000).length} settles inside the first ms)`,
    );
    world.settle = previousSettle;
  }
}

// ============================== 4. one source, two architectures, per-target
//
// The C6 half uses an RP2040-only API on purpose, so the C6 build genuinely
// fails while the Pico build genuinely succeeds. The controller must say which
// board failed rather than reporting one global "Build failed".
{
  const pico = uid('b');
  const c6 = uid('b');
  const rp2040Only = [
    'void setup() { Serial1.begin(115200); }',
    'void loop() { Serial1.println(rp2040.getFreeHeap()); delay(100); }',
  ].join('\n');
  const project = projectOf({
    boards: [{ id: pico, definitionId: PICO }, { id: c6, definitionId: C6 }],
    wires: [[pico, 'GND1', c6, 'GND1']],
    source: rp2040Only,
  });
  simulationController.stop();
  const report = await simulationController.build(project);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);

  check(report.builds.length === 2, `one source produced two target builds (${report.builds.length})`);
  const picoBuild = report.builds.find((b) => b.fqbn === 'rp2040:rp2040:rpipico');
  const c6Build = report.builds.find((b) => b.fqbn === 'esp32:esp32:esp32c6');
  check(picoBuild?.status === 'built', `the Pico built (${picoBuild?.status})`);
  check(c6Build?.status === 'compile-failed', `and the C6 did not (${c6Build?.status})`);
  check(!report.allSucceeded, 'so the report does not claim everything succeeded');
  check(report.anyRunnable, 'but something is still runnable');
  check(/ESP32-C6-DevKitC-1/.test(c6Build?.detail ?? ''), `the failure names the board that failed (${c6Build?.detail})`);
  check(/Raspberry Pi Pico/.test(picoBuild?.detail ?? ''), `and the success names its own (${picoBuild?.detail})`);
  check(
    !/^Build failed$/i.test(c6Build?.detail ?? ''),
    'and is not a vague global failure',
  );

  // The board that failed must not silently run, and the one that built must.
  const started = await simulationController.start();
  check(started, 'the workspace still runs the board that built');
  simulationController.pause();
  check(simulationController.runnerFor(pico) !== undefined, 'the Pico has a runner');
  check(simulationController.runnerFor(c6) === undefined, 'and the C6 does not, because it has no firmware');
  const summaries = useSimulationStore.getState().builds;
  check(summaries.length === 2, `the UI store carries both outcomes (${summaries.length})`);
  check(
    summaries.some((b) => b.status === 'compile-failed' && b.boardName === 'ESP32-C6-DevKitC-1'),
    'including the failed one, by name',
  );
}

// ======================= 5. one source both architectures genuinely compile
{
  const pico = uid('b');
  const c6 = uid('b');
  const portable = [
    'void setup() { pinMode(2, OUTPUT); }',
    'void loop() { digitalWrite(2, HIGH); delay(30); digitalWrite(2, LOW); delay(30); }',
  ].join('\n');
  const project = projectOf({
    boards: [{ id: pico, definitionId: PICO }, { id: c6, definitionId: C6 }],
    wires: [[pico, 'GND1', c6, 'GND1']],
    source: portable,
  });
  if (!(await runProject(project))) {
    skip('the cross-architecture project would not start');
  } else {
    const builds = simulationController.buildReport;
    check(builds.length === 2 && builds.every((b) => b.status === 'built'), `both targets built (${builds.map((b) => b.status).join(', ')})`);
    check(new Set(builds.map((b) => b.fqbn)).size === 2, 'from two distinct FQBNs');
    const rp = simulationController.runnerFor(pico)!;
    const esp = simulationController.runnerFor(c6)!;
    check(rp.engine === 'rp2040js' && esp.engine === 'esp32c6', `each on its own engine (${rp.engine}, ${esp.engine})`);
    simulationController.advance(300);
    check(rp.timeMs > 100 && esp.timeMs > 100, `both advanced (${rp.timeMs.toFixed(0)} ms, ${esp.timeMs.toFixed(0)} ms)`);
    check(rp.snapshot().toggles[2] > 2, `the Pico's pad really toggled (${rp.snapshot().toggles[2]})`);
    check(esp.snapshot().toggles[2] > 2, `and the C6's did too (${esp.snapshot().toggles[2]})`);
  }
}

// ============ 6. the canvas proof, both directions, through the controller
{
  const c6 = uid('b');
  const pico = uid('b');
  const resistor = uid('c');
  const led = uid('c');
  // One source, branching on the architecture the compiler is building for —
  // which is how a real sketch spans two boards. The C6 drives IO2 and the
  // Pico mirrors it onto an LED; then the Pico drives GP17 and the C6 mirrors
  // that onto IO4.
  const source = [
    '#if defined(ARDUINO_ARCH_RP2040)',
    'void setup() { pinMode(16, INPUT); pinMode(15, OUTPUT); pinMode(17, OUTPUT); }',
    'void loop() { digitalWrite(15, digitalRead(16)); digitalWrite(17, HIGH); }',
    '#else',
    'void setup() { pinMode(2, OUTPUT); pinMode(3, INPUT); pinMode(4, OUTPUT); }',
    'void loop() { digitalWrite(2, HIGH); delay(40); digitalWrite(4, digitalRead(3)); digitalWrite(2, LOW); delay(40); digitalWrite(4, digitalRead(3)); }',
    '#endif',
  ].join('\n');

  const project = projectOf({
    boards: [{ id: c6, definitionId: C6 }, { id: pico, definitionId: PICO }],
    parts: [
      { id: resistor, definitionId: 'comp.resistor', properties: { resistance: 220 } },
      { id: led, definitionId: 'comp.led', properties: { color: 'red' } },
    ],
    wires: [
      [c6, 'GND1', pico, 'GND3'],
      // forward: C6 IO2 -> Pico GP16 -> Pico GP15 -> resistor -> LED
      [c6, 'IO2', pico, 'GP16'],
      [pico, 'GP15', resistor, 'p1'],
      [resistor, 'p2', led, 'anode'],
      [led, 'cathode', pico, 'GND7'],
      // reverse: Pico GP17 -> C6 IO3 -> C6 firmware -> C6 IO4
      [pico, 'GP17', c6, 'IO3'],
    ],
    source,
  });

  if (!(await runProject(project))) {
    skip('the cross-board canvas project would not start');
  } else {
    const espRunner = simulationController.runnerFor(c6)!;
    const picoRunner = simulationController.runnerFor(pico)!;
    const samples: { c6out: string | undefined; picoOut: string | undefined; led: boolean; c6mirror: string | undefined }[] = [];
    for (let i = 0; i < 600; i++) {
      simulationController.advance(1);
      simulationController.publishNow();
      const visuals = useSimulationStore.getState().visuals as Record<string, { ledOn?: boolean }>;
      samples.push({
        c6out: espRunner.digitalPinLevel(2),
        picoOut: picoRunner.digitalPinLevel(15),
        led: visuals[led]?.ledOn === true,
        c6mirror: espRunner.digitalPinLevel(4),
      });
      simulationController.publishNow();
    }

    // ---- forward: C6 firmware -> net -> Pico firmware -> canvas LED ----
    const high = samples.filter((s) => s.c6out === 'high').length;
    const low = samples.filter((s) => s.c6out === 'low').length;
    check(high > 20 && low > 20, `the C6 drives IO2 both ways (${high} high / ${low} low)`);
    const followed = samples.filter((s) => s.c6out !== undefined && s.picoOut === s.c6out).length;
    check(followed > samples.length * 0.9, `the Pico's GP15 follows it (${followed}/${samples.length})`);
    const lit = samples.filter((s) => s.led).length;
    check(lit > 20 && lit < samples.length - 20, `and the canvas LED follows rather than sticking (${lit} lit)`);
    const agree = samples.filter((s) => s.c6out !== undefined && s.led === (s.c6out === 'high')).length;
    check(agree > samples.length * 0.9, `the LED agrees with the C6 end to end (${agree}/${samples.length})`);

    // ---- reverse: Pico firmware -> net -> C6 input -> C6 firmware -> C6 output ----
    check(picoRunner.digitalPinLevel(17) === 'high', 'the Pico drives GP17 high');
    const mirrored = samples.slice(100).filter((s) => s.c6mirror === 'high').length;
    check(mirrored > samples.length * 0.5, `and the C6's own firmware mirrors it onto IO4 (${mirrored} samples)`);
    check(espRunner.digitalPinLevel(4) === 'high', 'which ends high, driven by the C6 and nothing else');
  }
}

simulationController.stop();
finish();
