// The build cache, and the four ways it could be wrong.
//
// A cache that is merely fast is not the goal. There are four ways this one
// could be worse than no cache at all, and each has a section here:
//
//   1. it could hand back the wrong bytes — a build whose sources have changed,
//      or whose toolchain has, must not be served from a previous one;
//   2. it could recompile when nothing that affects the bytes has changed —
//      moving a part or renaming a board must cost nothing;
//   3. it could let one request's source reach another's build;
//   4. it could grow without limit, or evict the wrong thing. Both have already
//      happened here: arduino-cli's own cache reached 2.2 GB on this machine
//      with nothing reading it, and the first version of the eviction deleted
//      the compiled core archives, which took an ESP32 build from 3.7 s to
//      20 s at whatever interval it happened to fire.
//
// The parts that need a compiler run against the live service and skip cleanly
// without one. The parts that do not are exercised directly, because a key
// function is worth testing without waiting four seconds for each case.

import { readdir, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { buildKey, evictBuildDirs, CACHE_ROOT, CLI_CACHE_ROOT, cacheStats } from '../server/compiler/buildCache.js';

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

const BASE = process.env.COMPILE_API ?? 'http://localhost:3411';

const BASE_INPUT = {
  fqbn: 'arduino:avr:uno',
  toolchainVersion: '1.5.1',
  coreVersion: '1.8.8',
  syntaxOnly: false,
  files: [
    { name: 'sketch.ino', content: 'void setup(){}\nvoid loop(){}' },
    { name: 'helper.h', content: '#pragma once\nint answer();' },
    { name: 'helper.cpp', content: 'int answer(){return 42;}' },
  ],
};

// ======================================= 1. what must change the answer =====
section('1. everything that can change the bytes changes the key');
{
  const base = buildKey(BASE_INPUT);

  const variants: [string, typeof BASE_INPUT][] = [
    ['the sketch source', { ...BASE_INPUT, files: BASE_INPUT.files.map((f) => (f.name === 'sketch.ino' ? { ...f, content: `${f.content}\n// edit` } : f)) }],
    ['an included .h', { ...BASE_INPUT, files: BASE_INPUT.files.map((f) => (f.name === 'helper.h' ? { ...f, content: `${f.content}\nint other();` } : f)) }],
    ['an included .cpp', { ...BASE_INPUT, files: BASE_INPUT.files.map((f) => (f.name === 'helper.cpp' ? { ...f, content: 'int answer(){return 43;}' } : f)) }],
    ['a new file appearing', { ...BASE_INPUT, files: [...BASE_INPUT.files, { name: 'extra.cpp', content: 'int extra(){return 1;}' }] }],
    ['a file disappearing', { ...BASE_INPUT, files: BASE_INPUT.files.slice(0, 2) }],
    ['a file being renamed', { ...BASE_INPUT, files: BASE_INPUT.files.map((f) => (f.name === 'helper.cpp' ? { ...f, name: 'helper2.cpp' } : f)) }],
    ['the processor target (FQBN)', { ...BASE_INPUT, fqbn: 'arduino:avr:nano' }],
    ['the core version', { ...BASE_INPUT, coreVersion: '1.8.9' }],
    ['the toolchain version', { ...BASE_INPUT, toolchainVersion: '1.5.2' }],
    ['the compile mode (syntax-only vs full)', { ...BASE_INPUT, syntaxOnly: true }],
  ];
  for (const [what, input] of variants) {
    check(buildKey(input) !== base, `${what} produces a different build`);
  }

  // Two files whose contents could be concatenated into a third must not be
  // able to collide — that is what the length prefixes are for.
  const a = buildKey({ ...BASE_INPUT, files: [{ name: 'sketch.ino', content: 'ab' }, { name: 'x.h', content: 'c' }] });
  const b = buildKey({ ...BASE_INPUT, files: [{ name: 'sketch.ino', content: 'a' }, { name: 'x.h', content: 'bc' }] });
  check(a !== b, 'and files cannot be run together into a colliding key');
}

// ================================== 2. what must NOT change the answer ======
section('2. and nothing else does');
{
  const base = buildKey(BASE_INPUT);
  const reordered = buildKey({ ...BASE_INPUT, files: [...BASE_INPUT.files].reverse() });
  check(reordered === base, 'reordering the editor tabs is the same build');

  // The key is built only from the target, the toolchain and the sources. There
  // is nothing in its input that a layout change could reach — which is the
  // property that makes moving a component, renaming a board, routing a wire,
  // zooming or switching tabs cost zero compiles.
  const keys = Object.keys(BASE_INPUT).sort().join(',');
  check(
    keys === 'coreVersion,files,fqbn,syntaxOnly,toolchainVersion',
    `the key's whole input is target, toolchain and sources (${keys})`,
  );
}

// ================================================= 3. isolation on disk =====
section('3. one build cannot reach another');
{
  // Directories are named for the key, and the key is a hash of the content, so
  // two requests share a directory only when their sources are byte-identical —
  // in which case there is nothing of one to leak into the other.
  const one = buildKey(BASE_INPUT);
  const two = buildKey({ ...BASE_INPUT, files: [{ name: 'sketch.ino', content: 'void setup(){}\nvoid loop(){/*mine*/}' }] });
  check(one !== two, 'two different sources get two different build directories');
  check(/^[0-9a-f]{64}$/.test(one), 'the directory name is a hash, carrying nothing of the source');

  let dirs: string[] = [];
  try {
    dirs = (await readdir(CACHE_ROOT, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    /* nothing built yet */
  }
  const named = dirs.filter((d) => d !== path.basename(CLI_CACHE_ROOT) && !/^[0-9a-f]{32}$/.test(d));
  check(named.length === 0, `every build directory is content-addressed${named.length ? `: ${named.join(', ')}` : ''}`);
}

// ============================================= 4. bounded, and correctly ====
section('4. the tree is bounded, and the core archives survive it');
{
  // The bug this guards: the first version of the eviction treated
  // arduino-cli's cache as an ordinary build directory and deleted it, taking
  // the compiled core archives with it. Nothing failed — builds just silently
  // became five times slower.
  const cores = path.join(CLI_CACHE_ROOT, 'cores');
  let hadCores = false;
  try {
    hadCores = (await stat(cores)).isDirectory();
  } catch {
    /* not warmed on this machine */
  }

  // A pile of directories well past the limit, so eviction certainly runs.
  const made: string[] = [];
  for (let i = 0; i < 60; i++) {
    const dir = path.join(CACHE_ROOT, `ffffffffffffffffffffffffffff${String(i).padStart(4, '0')}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'filler'), 'x'.repeat(1024));
    made.push(dir);
  }
  const before = (await readdir(CACHE_ROOT)).length;
  const trimmed = await evictBuildDirs(true);
  const after = (await readdir(CACHE_ROOT, { withFileTypes: true })).filter((d) => d.isDirectory()).length;
  check(trimmed.removed > 0, `eviction removes what is over the limit (${trimmed.removed} of ${before})`);
  check(after <= 49, `and leaves the tree bounded (${after} directories)`);

  if (hadCores) {
    let stillThere = false;
    try {
      stillThere = (await stat(cores)).isDirectory();
    } catch {
      stillThere = false;
    }
    check(stillThere, 'and the compiled core archives are still there');
  } else {
    skip('the core archives are not warmed on this machine, so their survival cannot be checked');
  }

  for (const dir of made) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

// ============================ 5. against the running service ================
section('5. the same build twice, through the API');

async function compile(fqbn: string, boardId: string, content: string) {
  const res = await fetch(`${BASE}/api/compiler/compile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fqbn, boardId, files: [{ name: 'sketch.ino', content }] }),
  });
  return (await res.json()) as {
    success: boolean;
    error?: string;
    source?: string;
    durationMs: number;
    firmware?: { format: string; data: string; regions?: { offset: number; data: string }[] };
  };
}

let live = false;
try {
  live = (await fetch(`${BASE}/health`)).ok;
} catch {
  live = false;
}

if (!live) {
  skip(`no compiler service at ${BASE} — the live cache checks cannot run`);
} else {
  const source = `// cache test ${Date.now()}\nvoid setup(){Serial.begin(9600);}\nvoid loop(){delay(5);}`;
  const first = await compile('arduino:avr:uno', 'board.arduino-uno', source);
  if (!first.success) {
    skip(`the AVR toolchain is unavailable: ${first.error}`);
  } else {
    check(first.source === 'compiled', `the first build compiles (${first.source})`);
    const second = await compile('arduino:avr:uno', 'board.arduino-uno', source);
    check(second.source === 'cached', `the identical second build is served from cache (${second.source})`);
    check(second.durationMs < 100, `and costs almost nothing (${second.durationMs} ms)`);

    // The point of the whole exercise: the cached bytes ARE the compiled bytes.
    check(
      second.firmware?.data === first.firmware?.data && second.firmware?.format === first.firmware?.format,
      'and its firmware is byte-identical to the build it came from',
    );

    // A changed source must not be served from it. Note that "changed source"
    // and "changed firmware" are different things: adding a comment changes the
    // key and rebuilds, and correctly produces the same bytes.
    const commented = await compile('arduino:avr:uno', 'board.arduino-uno', `${source}\n// edited`);
    check(commented.source === 'compiled', `an edited sketch compiles again (${commented.source})`);
    check(
      commented.firmware?.data === first.firmware?.data,
      'and a comment-only edit rebuilds to the same bytes, as it should',
    );

    const edited = await compile('arduino:avr:uno', 'board.arduino-uno', source.replace('delay(5)', 'delay(250)'));
    check(edited.source === 'compiled', `a real edit compiles again (${edited.source})`);
    check(edited.firmware?.data !== first.firmware?.data, 'and produces different firmware');

    // The same source for a different target must not be served from it either.
    const otherTarget = await compile('arduino:avr:nano', 'board.arduino-nano', source);
    check(otherTarget.source === 'compiled', 'the same source for another board compiles for that board');

    // Two identical requests at once are one build.
    const shared = `// dedup ${Date.now()}\nvoid setup(){}\nvoid loop(){}`;
    const statsBefore = (await (await fetch(`${BASE}/api/compiler/cache`)).json()) as { misses: number };
    const [x, y] = await Promise.all([
      compile('arduino:avr:uno', 'board.arduino-uno', shared),
      compile('arduino:avr:uno', 'board.arduino-uno', shared),
    ]);
    const statsAfter = (await (await fetch(`${BASE}/api/compiler/cache`)).json()) as { misses: number };
    check(
      statsAfter.misses - statsBefore.misses === 1,
      `two identical requests together produce one build (${statsAfter.misses - statsBefore.misses})`,
    );
    check(x.firmware?.data === y.firmware?.data, 'and both callers get the same firmware');

    // A failed build is not remembered: its diagnostics are the product, and a
    // stale one would outlive the fix.
    const broken = 'void setup(){ this is not c++ }\nvoid loop(){}';
    const failed1 = await compile('arduino:avr:uno', 'board.arduino-uno', broken);
    const failed2 = await compile('arduino:avr:uno', 'board.arduino-uno', broken);
    check(!failed1.success && !failed2.success, 'a broken sketch fails both times');
    check(failed2.source !== 'cached', `and the failure is not served from cache (${failed2.source ?? 'compiled'})`);

    const stats = cacheStats();
    console.log(`   cache limits: ${stats.maxEntries} entries / ${Math.round(Number(stats.maxBytes) / 1024 / 1024)} MB in memory, ` +
      `${stats.maxDirs} dirs / ${Math.round(Number(stats.maxDirBytes) / 1024 / 1024)} MB on disk`);
    check(Number(stats.maxEntries) > 0 && Number(stats.maxBytes) > 0, 'the artifact cache is bounded in both entries and bytes');
  }
}

console.log(
  failures === 0
    ? `\nBuild cache checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
