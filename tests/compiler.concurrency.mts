// Compile concurrency + production-startup suite.
//
// Part 1 exercises the gate directly (deterministic: success, failure and
// timeout release the slot). Part 2 starts the PRODUCTION artefact —
// `node dist-server/index.js`, no tsx — and fires overlapping HTTP requests.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { CompileGate, CompilerBusyError } from '../server/compileGate';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

// ---------- 1. Gate semantics ----------
{
  const gate = new CompileGate(2);
  let release!: () => void;
  const blocked = new Promise<string>((r) => { release = () => r('done'); });

  const first = gate.run(() => blocked);
  await sleep(10);
  check(gate.stats.active === 1, `one build active while running (${JSON.stringify(gate.stats)})`);

  const second = gate.run(() => Promise.resolve('second'));
  const third = gate.run(() => Promise.resolve('third'));
  await sleep(10);
  check(gate.stats.waiting === 2, `two callers queued behind it (${JSON.stringify(gate.stats)})`);

  let refused: unknown;
  try {
    gate.run(() => Promise.resolve('fourth'));
  } catch (err) {
    refused = err;
  }
  check(refused instanceof CompilerBusyError, 'a fourth caller is refused with CompilerBusyError, not queued');
  check(
    refused instanceof CompilerBusyError && refused.retryAfterSeconds > 0,
    `refusal carries a Retry-After hint (${(refused as CompilerBusyError)?.retryAfterSeconds}s)`,
  );

  release();
  check((await first) === 'done' && (await second) === 'second' && (await third) === 'third', 'queued builds all run in order');
  await sleep(10);
  check(gate.stats.active === 0 && gate.stats.waiting === 0, `slot released after success (${JSON.stringify(gate.stats)})`);
}

// slot release after a compiler failure, and after a timeout
{
  const gate = new CompileGate(2);
  await gate.run(() => Promise.reject(new Error('compiler exploded'))).catch(() => undefined);
  check(gate.stats.active === 0, 'slot released after compiler failure');
  const ok = await gate.run(() => Promise.resolve('next build'));
  check(ok === 'next build', 'a later build still runs after a failure');

  await gate
    .run(async () => {
      await sleep(20);
      throw Object.assign(new Error('timed out'), { killed: true });
    })
    .catch(() => undefined);
  check(gate.stats.active === 0 && gate.stats.waiting === 0, 'slot released after a timed-out build');
  check((await gate.run(() => Promise.resolve('recovered'))) === 'recovered', 'gate still usable after a timeout');
}

// ---------- 2. HTTP behaviour against the compiled production server ----------
{
  const PORT = 3497;
  const server = spawn('node', ['dist-server/index.js'], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production', COMPILE_JOBS: '1' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      await sleep(100);
      up = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false);
    }
    check(up, 'production server started from emitted JavaScript (node dist-server/index.js)');

    const sketch = (name: string) => ({
      boardId: 'board.arduino-uno',
      fqbn: 'arduino:avr:uno',
      files: [{ name: 'sketch.ino', content: `void setup(){/*${name}*/} void loop(){}` }],
    });
    const post = (body: unknown) =>
      fetch(`${base}/api/compiler/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    // Fire more requests at once than the queue can hold.
    const responses = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => post(sketch(`s${n}`))));
    const codes = responses.map((r) => r.status);
    const bodies = await Promise.all(responses.map((r) => r.json() as Promise<Record<string, unknown>>));
    const okCount = codes.filter((c) => c === 200).length;
    const busy = codes.filter((c) => c === 503).length;
    console.log(`   statuses: ${codes.join(', ')}`);
    check(okCount >= 1, `at least one concurrent compile is served (${okCount} × 200)`);
    check(okCount + busy === codes.length, 'every response is either a build result or an explicit refusal');
    if (busy > 0) {
      const refusal = bodies[codes.indexOf(503)];
      check(refusal.errorCode === 'BUSY', `refusals use errorCode BUSY (${refusal.errorCode})`);
      check(typeof refusal.error === 'string' && /busy/i.test(String(refusal.error)), `refusal explains itself: ${String(refusal.error).slice(0, 70)}`);
      check(responses[codes.indexOf(503)].headers.get('retry-after') !== null, 'refusal sets a Retry-After header');
    } else {
      console.log('   NOTE: queue absorbed all six requests; no refusal exercised over HTTP');
    }

    // The server must still be healthy and able to build afterwards.
    check(await fetch(`${base}/health`).then((r) => r.ok).catch(() => false), 'server still healthy after the burst');
    const after = (await post(sketch('after')).then((r) => r.json())) as Record<string, unknown>;
    check(after.success === true, 'a fresh compile succeeds after the burst (slot fully released)');
  } finally {
    server.kill('SIGKILL');
  }
}

console.log(failures === 0 ? '\nCompile concurrency checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
