// Peak memory of a build, per target, sampled while it runs.
//
// COMPILE_JOBS=1 is in place because a 512 MB instance died at the default
// parallelism, and the only honest way to revisit that is to measure again
// after changing anything about how builds run. This walks /proc for every
// process descended from the compiler server and reports the highest total RSS
// it sees, which is the number that has to stay under the instance's limit —
// not the compiler's RSS alone, because it is the container that gets killed.
//
// Run:  npx tsx tools/perf/compileMemory.mts [pid-of-server]

import { readdir, readFile } from 'node:fs/promises';

const BASE = process.env.COMPILE_API ?? 'http://localhost:3411';

const TARGETS = [
  { id: 'board.arduino-uno', fqbn: 'arduino:avr:uno', label: 'Uno (AVR)' },
  { id: 'board.raspberry-pi-pico', fqbn: 'rp2040:rp2040:rpipico', label: 'Pico (RP2040)' },
  { id: 'board.esp32-c3', fqbn: 'esp32:esp32:esp32c3', label: 'ESP32-C3' },
  { id: 'board.esp32-c6-devkitc-1', fqbn: 'esp32:esp32:esp32c6', label: 'ESP32-C6' },
];

/** Every process on the box, with its RSS in bytes and its parent. */
async function processes(): Promise<Map<number, { ppid: number; rss: number; comm: string }>> {
  const out = new Map<number, { ppid: number; rss: number; comm: string }>();
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
      // comm can contain spaces and parentheses, so split on the LAST ')'.
      const close = stat.lastIndexOf(')');
      const comm = stat.slice(stat.indexOf('(') + 1, close);
      const fields = stat.slice(close + 2).split(' ');
      const ppid = Number(fields[1]);
      const rssPages = Number(fields[21]);
      out.set(Number(entry), { ppid, rss: rssPages * 4096, comm });
    } catch {
      /* exited between readdir and read */
    }
  }
  return out;
}

/** Total RSS of a process and everything below it. */
function treeRss(all: Map<number, { ppid: number; rss: number; comm: string }>, root: number): { bytes: number; count: number } {
  const children = new Map<number, number[]>();
  for (const [pid, p] of all) children.set(p.ppid, [...(children.get(p.ppid) ?? []), pid]);
  let bytes = 0;
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    const p = all.get(pid);
    if (!p) continue;
    bytes += p.rss;
    count++;
    stack.push(...(children.get(pid) ?? []));
  }
  return { bytes, count };
}

/** The compiler server's pid, from the argument or by looking for it. */
async function serverPid(): Promise<number> {
  const given = Number(process.argv[2]);
  if (Number.isFinite(given) && given > 0) return given;
  const all = await processes();
  for (const [pid] of all) {
    try {
      const cmd = await readFile(`/proc/${pid}/cmdline`, 'utf8');
      // The dev server runs the TypeScript entry; the production one runs the
      // compiled output. Memory has to be measurable on both, and the number
      // that matters is the production one.
      if (cmd.includes('server/index.ts') || cmd.includes('dist-server/index.js')) return pid;
    } catch {
      /* gone */
    }
  }
  throw new Error('could not find the compiler server; pass its pid as an argument');
}

const root = await serverPid();
console.log(`sampling pid ${root} and its children, every 50 ms\n`);
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MiB`;

console.log(`  ${'target'.padEnd(18)} ${'peak RSS'.padStart(9)} ${'idle RSS'.padStart(9)} ${'peak procs'.padStart(10)}  build`);
for (const target of TARGETS) {
  const idle = treeRss(await processes(), root);
  let peak = idle.bytes;
  let peakProcs = idle.count;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const now = treeRss(await processes(), root);
      if (now.bytes > peak) peak = now.bytes;
      if (now.count > peakProcs) peakProcs = now.count;
      await new Promise((r) => setTimeout(r, 50));
    }
  })();

  const started = Date.now();
  const res = await fetch(`${BASE}/api/compiler/compile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fqbn: target.fqbn,
      boardId: target.id,
      files: [
        {
          name: 'sketch.ino',
          content: `// mem ${target.id} ${Date.now()}\nvoid setup(){Serial.begin(9600);}\nvoid loop(){delay(10);}`,
        },
      ],
    }),
  });
  const json = (await res.json()) as { success: boolean; error?: string };
  sampling = false;
  await sampler;
  console.log(
    `  ${target.label.padEnd(18)} ${mb(peak).padStart(9)} ${mb(idle.bytes).padStart(9)} ${String(peakProcs).padStart(10)}  ` +
    `${json.success ? 'ok' : `FAILED: ${json.error}`} in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}
