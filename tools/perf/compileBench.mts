// What a build costs, measured against the running service, many times.
//
// One sample of a compile is not a measurement — the first build of a target
// pays for page cache and index loading that the tenth does not, and a box that
// is doing something else for two of the ten will show it. So every figure here
// is a distribution over N runs with unique sources, reported as p50/p90 with
// the spread, and the phase breakdown comes from the server's own timers rather
// than from guessing which part was slow.
//
// Four states, and the differences between them are the whole story:
//
//   cold    first build of this target since the service started
//   warm    target seen before, source never seen: what editing and re-running
//           costs, which is the number that decides whether this feels usable
//   cached  same target, same source: must not run the toolchain at all
//   dedup   two identical requests in flight together: must compile once
//
// Run:  npx tsx tools/perf/compileBench.mts [runs] [targets...]

import { performance } from 'node:perf_hooks';

const BASE = process.env.COMPILE_API ?? 'http://localhost:3411';
const RUNS = Number(process.argv[2] ?? '10');
const ONLY = process.argv.slice(3);

const TARGETS = [
  { id: 'board.arduino-uno', fqbn: 'arduino:avr:uno', label: 'Uno (AVR)' },
  { id: 'board.raspberry-pi-pico', fqbn: 'rp2040:rp2040:rpipico', label: 'Pico (RP2040)' },
  { id: 'board.esp32-c3', fqbn: 'esp32:esp32:esp32c3', label: 'ESP32-C3' },
  { id: 'board.esp32-c6-devkitc-1', fqbn: 'esp32:esp32:esp32c6', label: 'ESP32-C6' },
].filter((t) => ONLY.length === 0 || ONLY.includes(t.id));

/** A sketch whose text differs per tag, so the build key genuinely changes. */
const sketch = (tag: string) =>
  [
    `// bench ${tag}`,
    'void setup() { Serial.begin(9600); pinMode(LED_BUILTIN, OUTPUT); }',
    `void loop() { digitalWrite(LED_BUILTIN, HIGH); delay(${100 + (tag.length % 23)}); digitalWrite(LED_BUILTIN, LOW); delay(100); }`,
  ].join('\n');

interface Sample {
  wallMs: number;
  serverMs: number;
  prepareMs: number;
  compileMs: number;
  artifactMs: number;
  source: string;
  bytes: number;
}

async function compile(fqbn: string, boardId: string, source: string): Promise<Sample> {
  const body = JSON.stringify({ fqbn, boardId, files: [{ name: 'sketch.ino', content: source }] });
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/compiler/compile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const json = (await res.json()) as {
    success: boolean;
    durationMs: number;
    error?: string;
    source?: string;
    timings?: { prepareMs: number; compileMs: number; artifactMs: number };
    firmware?: { data: string };
  };
  const wallMs = performance.now() - t0;
  if (!json.success) throw new Error(`${fqbn}: ${json.error ?? 'build failed'}`);
  return {
    wallMs,
    serverMs: json.durationMs,
    prepareMs: json.timings?.prepareMs ?? 0,
    compileMs: json.timings?.compileMs ?? 0,
    artifactMs: json.timings?.artifactMs ?? 0,
    source: json.source ?? 'compiled',
    bytes: json.firmware?.data.length ?? 0,
  };
}

/** The service's cache counters, or null on a build that has no cache. */
async function stats(): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(`${BASE}/api/compiler/cache`);
    return res.ok ? ((await res.json()) as Record<string, number>) : null;
  } catch {
    return null;
  }
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
};
const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${n.toFixed(0)}ms`);

function report(label: string, samples: Sample[]) {
  const wall = samples.map((s) => s.wallMs);
  const compileMs = samples.map((s) => s.compileMs);
  const server = samples.map((s) => s.serverMs);
  console.log(
    `  ${label.padEnd(10)} n=${String(samples.length).padStart(2)}  ` +
    `p50 ${fmt(pct(wall, 0.5)).padStart(7)}  p90 ${fmt(pct(wall, 0.9)).padStart(7)}  ` +
    `min ${fmt(Math.min(...wall)).padStart(7)}  max ${fmt(Math.max(...wall)).padStart(7)}  ` +
    `| toolchain p50 ${fmt(pct(compileMs, 0.5)).padStart(7)}  ` +
    `transport p50 ${fmt(pct(wall, 0.5) - pct(server, 0.5)).padStart(6)}  ` +
    `| ${[...new Set(samples.map((s) => s.source))].join('/')}`,
  );
}

console.log(`compile benchmark — ${BASE}, ${RUNS} runs per state\n`);

const table: Record<string, Record<string, number>> = {};

for (const target of TARGETS) {
  console.log(`${target.label}  (${target.fqbn})`);

  // cold: the first build of this target in this process's life.
  const cold = await compile(target.fqbn, target.id, sketch(`cold-${target.id}-${Date.now()}`));
  console.log(
    `  ${'cold'.padEnd(10)} n= 1  ${fmt(cold.wallMs).padStart(7)}` +
    `  | toolchain ${fmt(cold.compileMs)}  prepare ${fmt(cold.prepareMs)}  artifacts ${fmt(cold.artifactMs)}`,
  );

  const warm: Sample[] = [];
  for (let i = 0; i < RUNS; i++) {
    warm.push(await compile(target.fqbn, target.id, sketch(`warm-${target.id}-${Date.now()}-${i}`)));
  }
  report('warm', warm);

  // cached: the same source again. Nothing may run.
  const repeated = sketch(`cached-${target.id}-${Date.now()}`);
  await compile(target.fqbn, target.id, repeated);
  const cachedRuns: Sample[] = [];
  for (let i = 0; i < RUNS; i++) cachedRuns.push(await compile(target.fqbn, target.id, repeated));
  report('cached', cachedRuns);

  // dedup: two identical requests at once must produce one build.
  const shared = sketch(`dedup-${target.id}-${Date.now()}`);
  const before = await stats();
  const pair = await Promise.all([
    compile(target.fqbn, target.id, shared),
    compile(target.fqbn, target.id, shared),
  ]);
  const after = await stats();
  console.log(
    `  ${'dedup'.padEnd(10)} two identical requests together: ` +
    `${pair.map((p) => `${fmt(p.wallMs)} (${p.source})`).join(', ')}` +
    (before && after ? `  cache misses added: ${Number(after.misses) - Number(before.misses)}` : ''),
  );

  table[target.label] = {
    cold: cold.wallMs,
    warmP50: pct(warm.map((s) => s.wallMs), 0.5),
    warmP90: pct(warm.map((s) => s.wallMs), 0.9),
    cachedP50: pct(cachedRuns.map((s) => s.wallMs), 0.5),
    toolchainP50: pct(warm.map((s) => s.compileMs), 0.5),
  };
  console.log();
}

console.log('summary (wall clock through the HTTP API)');
console.log(`  ${'target'.padEnd(18)} ${'cold'.padStart(8)} ${'warm p50'.padStart(9)} ${'warm p90'.padStart(9)} ${'cached p50'.padStart(11)}`);
for (const [label, row] of Object.entries(table)) {
  console.log(
    `  ${label.padEnd(18)} ${fmt(row.cold).padStart(8)} ${fmt(row.warmP50).padStart(9)} ` +
    `${fmt(row.warmP90).padStart(9)} ${fmt(row.cachedP50).padStart(11)}`,
  );
}
const final = await stats();
console.log(
  final
    ? `\ncache: ${final.entries} entries / ${(Number(final.bytes) / 1024 / 1024).toFixed(1)} MB, ` +
      `${final.hits} hits, ${final.misses} misses ` +
      `(${((Number(final.hits) / Math.max(1, Number(final.hits) + Number(final.misses))) * 100).toFixed(0)}% hit rate)`
    : '\ncache: this build of the service has no artifact cache',
);
