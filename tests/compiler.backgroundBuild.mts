// Compiling during the pause before Run, and costing nobody anything for it.
//
// src/app/backgroundBuild.ts compiles once the code has been still for a moment,
// so pressing Run finds the firmware ready. The value is all in the second half
// of this file; the first half is the part that matters more, because a
// background job against a shared, rate-limited service is only acceptable if
// it is provably polite:
//
//   * typing is not a build per keystroke — one build after the pause;
//   * never more often than the minimum spacing, so it uses a bounded fraction
//     of the per-client budget the server enforces;
//   * "not now" from the service (busy, limited, unreachable) means back off;
//   * a sketch that does not compile is asked about once, not on every pause;
//   * it waits for a real compile in progress rather than racing it.
//
// Then, against the real service: after a background build, Run's build makes
// no request at all and is ready at once.

import {
  BackgroundBuilder,
  BACKOFF_MS,
  IDLE_MS,
  MIN_SPACING_MS,
  buildSignature,
} from '../src/app/backgroundBuild';
import { simulationController, type PrebuildOutcome } from '../src/simulation/simulationController';
import { compileProjectCode } from '../src/compiler/compilerClient';
import { emptyProject } from '../src/project/templates';
import { useEditorStore } from '../src/app/editorStore';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { runAction } from '../src/app/actions';
import type { CircuitProject } from '../src/types';

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
function unoProject(code: string): CircuitProject {
  const p = emptyProject(`bg ${++seq}`);
  p.boardInstances = [
    { id: `b${seq}`, definitionId: 'board.arduino-uno', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {} },
  ];
  p.componentInstances = [];
  p.connections = [];
  p.codeFiles = [{ id: 'f', name: 'sketch.ino', content: code, language: 'cpp' }];
  return p;
}
const blink = (ms: number) =>
  `void setup() { pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); delay(${ms}); digitalWrite(13, LOW); delay(${ms}); }\n`;

// ------------------------------------------------------------- fake clock
class FakeClock {
  t = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 1;
  set = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };
  clear = (handle: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== handle);
  };
  /** Advances time, running due timers and letting their promises settle. */
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    this.t = end;
  }
}

function harness(answer: (p: CircuitProject) => PrebuildOutcome) {
  const clock = new FakeClock();
  let project: CircuitProject | null = unoProject(blink(100));
  let compiling = false;
  const asked: string[] = [];
  const builder = new BackgroundBuilder(() => project, {
    now: () => clock.t,
    setTimer: clock.set,
    clearTimer: clock.clear,
    prebuild: async (p) => {
      asked.push(p.codeFiles[0].content);
      return answer(p);
    },
    isCompiling: () => compiling,
  });
  return {
    clock,
    builder,
    asked,
    edit(code: string) {
      project = { ...project!, codeFiles: [{ ...project!.codeFiles[0], content: code }] };
      builder.changed();
    },
    setCompiling(v: boolean) {
      compiling = v;
    },
  };
}
const ok: PrebuildOutcome = { compiled: 1, alreadyReady: 0, failed: 0, refused: false };

// ==================================================== 1. polite scheduling =
section('1. typing is one build, after the pause');
{
  const h = harness(() => ok);
  for (let i = 0; i < 20; i++) {
    h.edit(blink(100 + i)); // a keystroke every 200 ms
    await h.clock.advance(200);
  }
  check(h.asked.length === 0, `nothing is sent while typing (${h.asked.length})`);
  await h.clock.advance(IDLE_MS);
  check(h.asked.length === 1, `one build once the code is still (${h.asked.length})`);
  check(h.asked[0] === blink(119), 'and it is the code as it stands, not an intermediate version');
}

section('2. never more often than the minimum spacing');
{
  const h = harness(() => ok);
  h.builder.changed();
  await h.clock.advance(IDLE_MS);
  check(h.asked.length === 1, 'the first pause builds');
  h.edit(blink(200));
  await h.clock.advance(IDLE_MS + 1000);
  check(h.asked.length === 1, 'a second edit a moment later waits');
  await h.clock.advance(MIN_SPACING_MS);
  check(h.asked.length === 2, 'and builds once the spacing has passed');
  const perFiveMinutes = Math.ceil((5 * 60_000) / MIN_SPACING_MS);
  check(perFiveMinutes <= 20, `so it can use at most ${perFiveMinutes} of the 60 builds per 5 minutes the server allows`);
}

section('3. "not now" from the service means back off');
{
  const h = harness(() => ({ compiled: 0, alreadyReady: 0, failed: 1, refused: true }));
  h.builder.changed();
  await h.clock.advance(IDLE_MS);
  check(h.asked.length === 1, 'it asks once');
  h.edit(blink(300));
  await h.clock.advance(MIN_SPACING_MS + IDLE_MS);
  check(h.asked.length === 1, 'and after a refusal, does not ask again at the usual spacing');
  await h.clock.advance(BACKOFF_MS);
  check(h.asked.length === 2, 'but does once the back-off has passed');
}

section('4. a sketch that does not compile is asked about once');
{
  const h = harness((p) =>
    p.codeFiles[0].content.includes('oops') ? { compiled: 0, alreadyReady: 0, failed: 1, refused: false } : ok,
  );
  h.edit('void setup() { oops }');
  await h.clock.advance(IDLE_MS);
  check(h.asked.length === 1, 'the broken sketch is tried once');
  h.builder.changed();
  await h.clock.advance(MIN_SPACING_MS * 3);
  check(h.asked.length === 1, 'and not again while it is unchanged');
  h.edit(blink(400));
  await h.clock.advance(MIN_SPACING_MS + IDLE_MS);
  check(h.asked.length === 2, 'but the fixed sketch is');
}

section('5. a real compile in progress is not raced');
{
  const h = harness(() => ok);
  h.setCompiling(true);
  h.builder.changed();
  await h.clock.advance(IDLE_MS * 4);
  check(h.asked.length === 0, 'nothing is sent while Run is compiling');
  h.setCompiling(false);
  await h.clock.advance(IDLE_MS);
  check(h.asked.length === 1, 'and it goes once that finishes');
}

section('6. the signature is the source and the target, nothing else');
{
  const a = unoProject(blink(100));
  const b = { ...a, componentInstances: [{ id: 'led', definitionId: 'comp.led', x: 9, y: 9, rotation: 0, properties: {}, simulationState: {} }] };
  check(buildSignature(a) === buildSignature(b), 'placing a part does not trigger a build');
  const c = { ...a, codeFiles: [{ ...a.codeFiles[0], content: blink(101) }] };
  check(buildSignature(a) !== buildSignature(c), 'changing the code does');
  const none = { ...a, boardInstances: [] };
  check(buildSignature(none) === '', 'and a canvas with no board has nothing to build');
}

// ====================================== 7. against the real compiler service =
section('7. after a background build, Run makes no request and is ready at once');
{
  let requests = 0;
  (simulationController as unknown as { compileFn: typeof compileProjectCode }).compileFn = async (p, t) => {
    requests++;
    return compileProjectCode(p, t);
  };
  simulationController.closeProject();
  const project = unoProject(`// bg ${Date.now()}\n${blink(123)}`);
  const started = Date.now();
  const outcome = await simulationController.prebuild(project);
  const backgroundMs = Date.now() - started;
  if (outcome.refused) {
    skip('the compiler service is not reachable here');
  } else {
    check(outcome.compiled === 1, `the background build compiled the sketch (${JSON.stringify(outcome)}) in ${backgroundMs} ms`);
    check(simulationController.isPrebuilt(project), 'and the firmware is ready');
    const before = requests;
    const runStarted = Date.now();
    const report = await simulationController.build(project);
    const runMs = Date.now() - runStarted;
    check(requests === before, `pressing Run sent no compile request (${requests - before})`);
    check(report.builds[0]?.status === 'built' && /up to date/.test(report.builds[0].detail), `and reported the build up to date (${report.builds[0]?.detail})`);
    check(runMs < 100, `in ${runMs} ms rather than ${backgroundMs} ms`);
    check(await simulationController.start(), 'and the prebuilt firmware runs');
    const again = await simulationController.prebuild(project);
    check(again.alreadyReady === 1 && again.compiled === 0, 'a second background pass over unchanged code does nothing');
  }
  simulationController.closeProject();
}

// ================================ 8. Run never starts yesterday's firmware ===
section('8. editing the sketch and pressing Run runs the edited sketch');
{
  // The regression this guards: Run used to start whatever was built last if
  // the last compile had succeeded, so an edit followed by Run silently ran
  // the previous firmware.
  const say = (word: string) =>
    `void setup() { Serial.begin(115200); }\nvoid loop() { Serial.println("${word}"); delay(20); }\n`;
  const runAndRead = async (): Promise<string> => {
    runAction();
    for (let i = 0; i < 150 && useSimulationStore.getState().status !== 'running'; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (useSimulationStore.getState().status !== 'running') return '';
    simulationController.pause();
    simulationController.advance(150);
    simulationController.publishNow();
    return useSimulationStore.getState().serialText;
  };
  const tag = Date.now();
  const p = unoProject(say(`FIRST${tag}`));
  useEditorStore.setState({ project: p });
  const first = await runAndRead();
  if (first === '') {
    skip('the compiler service is not reachable, so Run could not be exercised');
  } else {
    check(first.includes(`FIRST${tag}`), 'the first Run runs the sketch');
    simulationController.stop();
    useEditorStore.getState().updateCodeFile('f', say(`SECOND${tag}`));
    const second = await runAndRead();
    check(second.includes(`SECOND${tag}`), `after an edit, Run runs the edited sketch (${JSON.stringify(second.slice(0, 24))})`);
    check(!second.includes(`FIRST${tag}`), 'and not the one built before the edit');
  }
  simulationController.closeProject();
}

// ========================= 9. Run joins a background build already running ===
section('9. pressing Run while the background build is running asks once');
{
  let calls = 0;
  (simulationController as unknown as { compileFn: typeof compileProjectCode }).compileFn = async (p, t) => {
    calls++;
    return compileProjectCode(p, t);
  };
  simulationController.closeProject();
  const project = unoProject(`// join ${Date.now()}\n${blink(321)}`);
  const background = simulationController.prebuild(project); // not awaited: still running
  const report = await simulationController.build(project);
  const outcome = await background;
  if (outcome.refused) {
    skip('the compiler service is not reachable here');
  } else {
    check(calls === 1, `one request served both the background build and Run (${calls})`);
    check(report.builds[0]?.status === 'built', `and Run got the firmware (${report.builds[0]?.status})`);
  }
  simulationController.closeProject();
}

// ================================= 10. a busy compiler is a wait, not a failure =
section('10. "the compiler is busy" makes Run wait its turn');
{
  let calls = 0;
  const stages: string[] = [];
  (simulationController as unknown as { compileFn: typeof compileProjectCode }).compileFn = async (p, t) => {
    calls++;
    if (calls === 1) {
      return {
        success: false, toolchain: 'none', toolchainVersion: '', stdout: '', stderr: '', diagnostics: [], durationMs: 0,
        error: 'Compile refused: The compiler is busy: one build is running and 2 more are already queued.',
        errorCode: 'BUSY', retryAfterSeconds: 1,
      };
    }
    return compileProjectCode(p, t);
  };
  simulationController.onStage = (st) => st && stages.push(st.step);
  simulationController.closeProject();
  const project = unoProject(`// busy ${Date.now()}\n${blink(222)}`);
  const report = await simulationController.build(project);
  simulationController.onStage = undefined;
  if (calls > 1 && report.builds[0]?.status !== 'built' && /reach/.test(report.builds[0]?.detail ?? '')) {
    skip('the compiler service is not reachable here');
  } else {
    check(calls === 2, `a refused build is asked for again (${calls} requests)`);
    check(stages.includes('queued'), `the button says it is queued while it waits (${stages.join(' → ')})`);
    check(report.builds[0]?.status === 'built', `and Run gets its firmware instead of an error (${report.builds[0]?.detail})`);
  }
  simulationController.closeProject();
}

section(`${failures} failing, ${skipped} skipped`);
process.exit(failures > 0 ? 1 : 0);
