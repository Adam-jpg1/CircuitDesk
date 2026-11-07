// How long a build actually takes, through the path a user's click takes.
//
// Not `arduino-cli` on its own: the real one, through simulationController's
// build(), the compile client, the HTTP hop and the backend, because that is
// what someone waits for. Anything measured below the click is a number about
// our toolchain rather than about our product.
//
// Three states per target, and the difference between them is the whole story:
//
//   cold    nothing warm anywhere — the first build of a target after the
//           backend has never seen it. This is what a new project costs.
//   warm    the backend has built this target before, but this source is new.
//           This is what editing and re-running costs, which is the number
//           that decides whether the tool feels usable.
//   cached  the same target and the exact same source. This must not compile
//           at all. If it does, that is a defect and this file fails.
//
// The invalidation matrix at the end is the other half: a build that happens
// when nothing that affects the bytes has changed is latency somebody paid for
// nothing, and moving a component or renaming a board must cost zero.

import { simulationController } from '../src/simulation/simulationController';
import { emptyProject } from '../src/project/templates';
import { compileProjectCode } from '../src/compiler/compilerClient';
import type { CircuitProject, ComponentInstance } from '../src/types';

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
function section(t: string) {
  console.log(`\n--- ${t}`);
}

let seq = 0;
const uid = (p: string) => `${p}${++seq}`;
const board = (definitionId: string): ComponentInstance => ({
  id: uid('b'), definitionId, x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
});

/** A sketch whose text can be varied so the cache key genuinely changes. */
function sketch(tag: string): string {
  return [
    `// build tag ${tag}`,
    'void setup() { Serial.begin(9600); pinMode(LED_BUILTIN, OUTPUT); }',
    `void loop() { digitalWrite(LED_BUILTIN, HIGH); delay(${100 + (tag.length % 7)}); digitalWrite(LED_BUILTIN, LOW); delay(100); }`,
  ].join('\n');
}

function projectFor(boards: ComponentInstance[], files: { id: string; name: string; content: string }[]): CircuitProject {
  const p = emptyProject('bench');
  p.boardInstances.push(...boards);
  p.codeFiles = files.map((f) => ({ ...f, language: 'cpp' as const }));
  return p;
}

/** Counts real compiler calls by wrapping the client the controller uses. */
let compilerCalls = 0;
const countingCompile: typeof compileProjectCode = async (project, target) => {
  compilerCalls++;
  return compileProjectCode(project, target);
};
(simulationController as unknown as { compileFn: typeof compileProjectCode }).compileFn = countingCompile;

interface Timing {
  label: string;
  totalMs: number;
  backendMs: number;
  transportMs: number;
  calls: number;
  detail: string;
}

async function timeBuild(label: string, p: CircuitProject): Promise<Timing> {
  compilerCalls = 0;
  const started = performance.now();
  const report = await simulationController.build(p);
  const totalMs = performance.now() - started;
  const backendMs = report.builds.reduce((sum, b) => sum + (b.durationMs ?? 0), 0);
  return {
    label,
    totalMs,
    backendMs,
    transportMs: Math.max(0, totalMs - backendMs),
    calls: compilerCalls,
    detail: report.builds.map((b) => b.detail).join(' | '),
  };
}

function row(t: Timing): string {
  return (
    `   ${t.label.padEnd(26)} total ${t.totalMs.toFixed(0).padStart(6)} ms   ` +
    `backend ${t.backendMs.toFixed(0).padStart(6)} ms   ` +
    `transport ${t.transportMs.toFixed(0).padStart(5)} ms   ` +
    `${t.calls} compiler call(s)`
  );
}

// ================================================ reachability ==============
const probe = await timeBuild('probe', projectFor([board('board.arduino-uno')], [{ id: 'f', name: 'sketch.ino', content: sketch('probe') }]));
const backendUp = !/Could not reach the compiler server/.test(probe.detail);
if (!backendUp) {
  skip('the compiler backend is not running — no timings can be taken');
  console.log(`\nCompile benchmark skipped (${skipped}).`);
  process.exit(0);
}

// ================================================ 1. cold, warm, cached =====
section('1. cold, warm and cached, per target');

const TARGETS: { id: string; name: string }[] = [
  { id: 'board.arduino-uno', name: 'Arduino Uno (AVR)' },
  { id: 'board.raspberry-pi-pico', name: 'Raspberry Pi Pico' },
  { id: 'board.esp32-c3', name: 'ESP32-C3' },
  { id: 'board.esp32-c6-devkitc-1', name: 'ESP32-C6' },
];

const results: Record<string, { cold: Timing; warm: Timing; cached: Timing }> = {};

for (const target of TARGETS) {
  simulationController.stop();
  // Cold: this target has not been built in this process, and the source is
  // unique, so nothing anywhere can answer it from a cache.
  const cold = await timeBuild(
    `${target.name} cold`,
    projectFor([board(target.id)], [{ id: 'f', name: 'sketch.ino', content: sketch(`cold-${target.id}-${Date.now()}`) }]),
  );
  if (/build failed|cannot execute/.test(cold.detail) && /Could not reach|not installed|unavailable/.test(cold.detail)) {
    skip(`${target.name}: the toolchain is unavailable — ${cold.detail}`);
    continue;
  }

  // Warm: same target, different source. The backend has the core archive and
  // the toolchain in page cache; only this sketch is new.
  const warm = await timeBuild(
    `${target.name} warm`,
    projectFor([board(target.id)], [{ id: 'f', name: 'sketch.ino', content: sketch(`warm-${target.id}-${Date.now()}`) }]),
  );

  // Cached: the identical project again. Nothing should compile.
  const cachedProject = projectFor(
    [board(target.id)],
    [{ id: 'f', name: 'sketch.ino', content: sketch(`cached-${target.id}`) }],
  );
  await timeBuild(`${target.name} priming`, cachedProject);
  const cached = await timeBuild(`${target.name} cached`, cachedProject);

  results[target.id] = { cold, warm, cached };
  console.log(row(cold));
  console.log(row(warm));
  console.log(row(cached));
  console.log(`      ${cached.detail}`);
}

// ============================= 2. the same project twice must not rebuild ===
section('2. an unchanged project must not compile again');
{
  for (const [id, r] of Object.entries(results)) {
    const name = TARGETS.find((t) => t.id === id)?.name ?? id;
    check(r.cached.calls === 0, `${name}: the second identical build makes no compiler call (${r.cached.calls})`);
    check(/up to date/.test(r.cached.detail), `${name}: and reports the artifact as up to date`);
    check(r.cached.totalMs < 50, `${name}: taking ${r.cached.totalMs.toFixed(1)} ms rather than a compile`);
  }
}

// ============================================= 3. the invalidation matrix ===
section('3. what does and does not cause a build');
{
  const picoSketch = { id: 'f1', name: 'sketch.ino', content: sketch('matrix-a') };

  // A. three Picos, one sketch: one build, three runners.
  const a = projectFor(
    [board('board.raspberry-pi-pico'), board('board.raspberry-pi-pico'), board('board.raspberry-pi-pico')],
    [picoSketch],
  );
  const ta = await timeBuild('3 Picos, one sketch', a);
  check(ta.calls <= 1, `three Picos sharing a sketch cost ${ta.calls} build(s), not three`);
  const runners = a.boardInstances.length;
  check(runners === 3, `while still being ${runners} independent boards`);

  // B. three Picos, three different sketches: three builds. The sketches have
  // to be ASSIGNED — three .ino files in a project with no assignments means
  // three boards all running the default one, which is one build and is
  // correct. Getting this wrong the first time is what the assignment model is
  // for, so it is worth writing down.
  const b = projectFor(
    [board('board.raspberry-pi-pico'), board('board.raspberry-pi-pico'), board('board.raspberry-pi-pico')],
    [
      { id: 'f1', name: 'a.ino', content: sketch('matrix-b1') },
      { id: 'f2', name: 'b.ino', content: sketch('matrix-b2') },
      { id: 'f3', name: 'c.ino', content: sketch('matrix-b3') },
    ],
  );
  b.boardInstances.forEach((bi, i) => { bi.sketchId = `f${i + 1}`; });
  const tb = await timeBuild('3 Picos, three sketches', b);
  check(tb.calls === 3, `three boards on three assigned sketches cost ${tb.calls} build(s)`);
  const tbAgain = await timeBuild('3 Picos, three sketches again', b);
  check(tbAgain.calls === 0, 'and none the second time');

  // Unassigned, the same three files are one build: every board falls back to
  // the default sketch, so there is genuinely only one thing to compile.
  const bShared = projectFor(
    [board('board.raspberry-pi-pico'), board('board.raspberry-pi-pico'), board('board.raspberry-pi-pico')],
    [
      { id: 'g1', name: 'a.ino', content: sketch('matrix-b-shared') },
      { id: 'g2', name: 'b.ino', content: sketch('matrix-b-unused') },
    ],
  );
  const tShared = await timeBuild('3 Picos, unassigned', bShared);
  check(tShared.calls === 1, `unassigned boards share the default sketch: ${tShared.calls} build`);

  // C. a Pico and a C6 from the same source: two builds, because the bytes
  // differ even though the text does not.
  const c = projectFor(
    [board('board.raspberry-pi-pico'), board('board.esp32-c6-devkitc-1')],
    [{ id: 'f1', name: 'sketch.ino', content: sketch('matrix-c') }],
  );
  const tc = await timeBuild('Pico + C6, same source', c);
  check(tc.calls === 2, `one source on two architectures is ${tc.calls} build(s)`);
  const again = await timeBuild('Pico + C6 again', c);
  check(again.calls === 0, 'and running it again is none');

  // E. things that change the canvas but not the bytes.
  const base = projectFor([board('board.arduino-uno')], [{ id: 'f1', name: 'sketch.ino', content: sketch('matrix-e') }]);
  await timeBuild('baseline', base);

  const noOps: { what: string; mutate: (p: CircuitProject) => void }[] = [
    { what: 'renaming a board', mutate: (p) => { p.boardInstances[0].label = 'Controller'; } },
    { what: 'moving a board', mutate: (p) => { p.boardInstances[0].x += 120; p.boardInstances[0].y += 40; } },
    { what: 'adding and moving a component', mutate: (p) => {
      p.componentInstances.push({ id: uid('c'), definitionId: 'comp.led', x: 30, y: 40, rotation: 0, properties: {}, simulationState: {} });
      p.componentInstances[0].x += 25;
    } },
    { what: 'rerouting a wire', mutate: (p) => {
      const c = p.connections[0];
      if (c) c.points = [{ x: 1, y: 1 }, { x: 2, y: 2 }];
      else p.connections.push({ id: uid('w'), sourceComponentId: p.boardInstances[0].id, sourcePinId: 'D2',
        targetComponentId: p.componentInstances[0]?.id ?? p.boardInstances[0].id, targetPinId: 'anode',
        netId: '', color: '#000', points: [{ x: 3, y: 3 }], routing: 'smooth' } as CircuitProject['connections'][number]);
    } },
    { what: 'rotating a component', mutate: (p) => { if (p.componentInstances[0]) p.componentInstances[0].rotation = 90; } },
  ];
  for (const noOp of noOps) {
    noOp.mutate(base);
    const t = await timeBuild(noOp.what, base);
    check(t.calls === 0, `${noOp.what} costs ${t.calls} compiler call(s)`);
  }

  // D. edit one sketch of two: only that one rebuilds.
  const d = projectFor(
    [board('board.raspberry-pi-pico'), board('board.raspberry-pi-pico')],
    [
      { id: 'f1', name: 'sender.ino', content: sketch('matrix-d-sender') },
      { id: 'f2', name: 'receiver.ino', content: sketch('matrix-d-receiver') },
    ],
  );
  d.boardInstances[0].sketchId = 'f1';
  d.boardInstances[1].sketchId = 'f2';
  await timeBuild('two sketches, first build', d);
  d.codeFiles[0] = { ...d.codeFiles[0], content: sketch('matrix-d-sender-edited') };
  const td = await timeBuild('sender edited', d);
  check(td.calls === 1, `editing one of two sketches rebuilds ${td.calls}, not both`);
}

// ============================================== 4. the layers, and the plan =
section('4. where the time goes');
{
  const rows = Object.entries(results).map(([id, r]) => {
    const name = TARGETS.find((t) => t.id === id)?.name ?? id;
    return { name, cold: r.cold.totalMs, warm: r.warm.totalMs, cached: r.cached.totalMs, transport: r.warm.transportMs };
  });
  console.log('   target                       cold      warm    cached   transport(warm)');
  for (const r of rows) {
    console.log(
      `   ${r.name.padEnd(24)} ${r.cold.toFixed(0).padStart(7)} ${r.warm.toFixed(0).padStart(9)} ` +
      `${r.cached.toFixed(0).padStart(8)} ${r.transport.toFixed(0).padStart(12)}`,
    );
  }
  const slowest = rows.slice().sort((a, b) => b.warm - a.warm)[0];
  if (slowest) console.log(`\n   Slowest warm build: ${slowest.name} at ${slowest.warm.toFixed(0)} ms — the bottleneck to attack first.`);
  // A warm build is what a user pays on every edit, so it is the number that
  // decides whether the tool feels usable. No threshold is asserted here: this
  // run measures, and the optimisation milestone that follows will set one
  // against these figures rather than against a guess.
}

simulationController.stop();
console.log(
  failures === 0
    ? `\nCompile benchmark passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
