// The compile queue holds builds, not requests.
//
// The gate allows one toolchain run at a time and a short queue behind it, and
// refuses the rest — a protection for a small instance that must stay. What it
// must not do is count requests that need no toolchain at all. It used to: a
// cached result and a duplicate of a build already running each waited for a
// place in the queue, so opening a project (whose background build was running)
// and pressing Run (asking for the same firmware) on a service still warming up
// filled it, and Run was refused with "the compiler is busy" for firmware that
// was already being built.
//
// Driven through compileProject with the server's real CompileGate, against
// the real toolchain. Skips cleanly without arduino-cli.

import { compileProject } from '../server/compiler/compilerService';
import { detectArduinoCli } from '../server/compiler/arduinoCli';
import { CompileGate, CompilerBusyError } from '../server/compileGate';
import { resetCache } from '../server/compiler/buildCache';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const cli = await detectArduinoCli();
if (!cli.available || !cli.avrCoreInstalled) {
  console.log('SKIP: arduino-cli with the AVR core is not available here');
  process.exit(0);
}

const gate = new CompileGate(2);
const slot = <T,>(work: () => Promise<T>) => gate.run(work);
const sketch = (tag: string) => ({
  fqbn: 'arduino:avr:uno',
  boardId: 'board.arduino-uno',
  files: [{ name: 'sketch.ino', content: `// queue ${tag}\nvoid setup() { pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); delay(${tag.length}); }\n` }],
});
const settle = <T,>(p: Promise<T>) =>
  p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

resetCache();
const stamp = Date.now();

// A result for B is cached before anything else happens.
const cached = await compileProject(sketch(`cached-${stamp}`), false, slot);
check(cached.success, 'a first build of B succeeds');

// A long build is running; two different builds wait behind it — the queue is full.
const running = settle(compileProject(sketch(`running-${stamp}`), false, slot));
const waitingC = settle(compileProject(sketch(`c-${stamp}-x`), false, slot));
const waitingD = settle(compileProject(sketch(`d-${stamp}-xx`), false, slot));
await new Promise((r) => setTimeout(r, 50));
check(gate.stats.active === 1 && gate.stats.waiting === 2, `the queue is full: ${gate.stats.active} running, ${gate.stats.waiting} waiting`);

// A genuinely new build finds the queue full and is refused: the protection is unchanged.
const extra = await settle(compileProject(sketch(`e-${stamp}-xxx`), false, slot));
check(!extra.ok && extra.error instanceof CompilerBusyError, 'a fourth different build is still refused while the queue is full');

// Asking again for firmware that is cached needs no toolchain: no place in the queue.
const again = await settle(compileProject(sketch(`cached-${stamp}`), false, slot));
check(again.ok && again.value.success && again.value.source === 'cached', `a cached build is answered while the queue is full (${again.ok ? again.value.source : 'refused'})`);

// Asking for the firmware being built right now joins that build.
const duplicates = await Promise.all([1, 2, 3].map(() => settle(compileProject(sketch(`running-${stamp}`), false, slot))));
check(
  duplicates.every((d) => d.ok && d.value.success),
  `three requests for the build already running all get its result (${duplicates.map((d) => (d.ok ? d.value.source : 'refused')).join(', ')})`,
);
check(duplicates.every((d) => d.ok && d.value.source === 'joined'), 'by joining it rather than queueing');

const results = await Promise.all([running, waitingC, waitingD]);
check(results.every((r) => r.ok && r.value.success), 'and the queued builds all finish');

// The warm-up waits for an idle compiler.
let idleResolved = false;
const busy = settle(compileProject(sketch(`idle-${stamp}-yyyy`), false, slot));
while (gate.stats.active === 0) await new Promise((r) => setTimeout(r, 5));
const idle = gate.whenIdle().then(() => (idleResolved = true));
await new Promise((r) => setTimeout(r, 30));
check(!idleResolved, 'background work waits while a build is running');
await busy;
await idle;
check(idleResolved && gate.stats.active === 0, 'and starts once the compiler is free');

console.log(`\n--- ${failures} failing`);
process.exit(failures ? 1 : 0);
