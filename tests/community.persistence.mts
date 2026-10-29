// What people publish survives a redeploy, and can be carried to a new host.
//
// A deploy replaces the server process: the old one gets SIGTERM, a new one
// starts. Everything published and every like has to be there afterwards.
// Two things decide that, and both are tested here with real server
// processes, not an in-process store:
//   * the file is on a disk the deploy keeps (render.yaml mounts one;
//     /health and /api/community/status say whether storage is persistent);
//   * writes are debounced, so a SIGTERM that lands inside the debounce must
//     still write — the server flushes before it exits.
// And for moving hosts or keeping an offline copy: the creator can download
// a backup and restore it into an empty server, likes and all, with the same
// checks a publish goes through and without ever deleting anything.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

const CREATOR_TOKEN = 'persistence-test-creator-token-01';
const CLIENT = '0b7c2a4e-1d3f-4a5b-8c6d-7e8f9a0b1c2d';
let nextPort = 3600 + Math.floor(Math.random() * 300);

interface Server {
  child: ChildProcess;
  base: string;
  exited: Promise<number | null>;
}

async function startServer(dataDir: string, extraEnv: Record<string, string> = {}): Promise<Server> {
  const port = nextPort++;
  // Node itself, as production runs it (`node dist-server/index.js`), so the
  // SIGTERM reaches the server rather than a wrapper.
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      COMMUNITY_DATA_DIR: dataDir,
      CREATOR_TOKEN,
      COMPILE_WARMUP: 'off',
      COMMUNITY_PUBLISH_MAX: '1000',
      COMMUNITY_LIKE_MAX: '1000',
      COMMUNITY_READ_MAX: '1000',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', (d) => (log += d));
  child.stderr?.on('data', (d) => (log += d));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const base = `http://127.0.0.1:${port}`;
  // Up to a minute: a cold tsx start on a busy machine has taken longer than 30 s.
  for (let i = 0; i < 600; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return { child, base, exited };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start:\n${log}`);
}

async function api(base: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

const project = (name: string) => ({
  id: 'p1',
  name,
  version: '1.0.0',
  boardInstances: [{ id: 'b', definitionId: 'board.arduino-uno', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {} }],
  componentInstances: [{ id: 'l', definitionId: 'comp.led', x: 300, y: 40, rotation: 0, properties: {}, simulationState: {} }],
  connections: [],
  codeFiles: [{ id: 'f', name: 'sketch.ino', content: 'void setup(){}\nvoid loop(){}\n', language: 'cpp' }],
  tests: [],
});
const preview = { rects: [{ x: 0, y: 0, w: 200, h: 150, k: 'board' }], lines: [] };
const post = (title: string) => ({ title, description: 'Kept.', authorName: 'Ada', tags: ['led'], board: 'Arduino Uno R3', project: project(title), preview });

const published = async (base: string) =>
  ((await api(base, 'GET', `/api/community/projects?sort=new&limit=100&clientId=${CLIENT}`)).json.items as {
    id: string;
    title: string;
    likes: number;
    liked: boolean;
  }[]).filter((p) => p.title.startsWith('Kept '));

const dataDir = mkdtempSync(path.join(tmpdir(), 'cd-community-'));
const servers: Server[] = [];
try {
  // ============================================ 1. a redeploy keeps everything
  section('1. publish, like, and redeploy while a write is still pending');
  const first = await startServer(dataDir);
  servers.push(first);
  const a = await api(first.base, 'POST', '/api/community/projects', post('Kept one'));
  const b = await api(first.base, 'POST', '/api/community/projects', post('Kept two'));
  check(a.status === 201 && b.status === 201, 'two projects are published');
  const like = await api(first.base, 'PUT', `/api/community/projects/${a.json.item.id}/like`, { clientId: CLIENT });
  check(like.status === 200 && like.json.item.likes >= 1, 'and one is liked');
  // At once: inside the 300 ms write debounce, as a deploy's SIGTERM can be.
  first.child.kill('SIGTERM');
  const code = await first.exited;
  check(code === 0, `the old process saves and exits cleanly on SIGTERM (exit ${code})`);
  const file = path.join(dataDir, 'community.json');
  check(existsSync(file), 'the data file is on disk');
  const onDisk = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { posts: { title: string }[] }) : { posts: [] };
  check(onDisk.posts.filter((p) => p.title.startsWith('Kept ')).length === 2, 'holding both projects, written before the exit');

  const second = await startServer(dataDir);
  servers.push(second);
  const after = await published(second.base);
  check(after.length === 2, `the new process has both projects (${after.map((p) => p.title).join(', ')})`);
  const liked = after.find((p) => p.id === a.json.item.id);
  check(liked?.likes === like.json.item.likes && liked.liked, `with the like, still recognised as this browser's (${liked?.likes}, ${liked?.liked})`);

  // ===================================================== 2. storage is reported
  section('2. whether storage is persistent is visible');
  const status = (await api(second.base, 'GET', '/api/community/status')).json;
  check(status.mode === 'file' && status.publishedPosts === 2, `status counts the published projects (${status.publishedPosts})`);
  check(typeof status.persistent === 'boolean', `and says whether the directory is on a persistent disk (${status.persistent})`);
  const health = (await api(second.base, 'GET', '/health')).json;
  check(health.communityStorage?.publishedPosts === 2, '/health reports it too, for checking a deploy from outside');

  // ===================================================== 3. backup and restore
  section('3. the creator can back up and restore onto a new host');
  const refused = await api(second.base, 'GET', '/api/community/backup');
  check(refused.status === 403, 'a backup without the creator token is refused');
  const backup = await api(second.base, 'GET', '/api/community/backup', undefined, { 'x-creator-token': CREATOR_TOKEN });
  check(backup.status === 200 && backup.json.version === 1, 'the creator downloads a backup');

  const freshDir = mkdtempSync(path.join(tmpdir(), 'cd-community-new-'));
  const fresh = await startServer(freshDir, { COMMUNITY_DISK_PERSISTENT: '1' });
  servers.push(fresh);
  check((await published(fresh.base)).length === 0, 'a new host starts with nothing published');
  check((await api(fresh.base, 'GET', '/api/community/status')).json.persistent === true, 'COMMUNITY_DISK_PERSISTENT=1 declares a host whose disk persists');
  const noToken = await api(fresh.base, 'POST', '/api/community/restore', backup.json);
  check(noToken.status === 403, 'a restore without the creator token is refused');
  const restored = await api(fresh.base, 'POST', '/api/community/restore', backup.json, { 'x-creator-token': CREATOR_TOKEN });
  check(restored.status === 200 && restored.json.added === 2, `the restore adds both projects (${restored.json.added})`);
  const moved = await published(fresh.base);
  const movedLike = moved.find((p) => p.id === a.json.item.id);
  check(moved.length === 2 && movedLike?.liked === true && movedLike.likes === liked?.likes, 'with the same ids, likes and liked flags');
  const again = await api(fresh.base, 'POST', '/api/community/restore', backup.json, { 'x-creator-token': CREATOR_TOKEN });
  check(again.json.added === 0 && (await published(fresh.base)).length === 2, 'restoring twice adds nothing twice');

  // A backup is a file from outside: it goes through the publish checks.
  const tampered = structuredClone(backup.json) as { posts: Record<string, any>[] };
  tampered.posts.push({ ...tampered.posts.find((p) => !p.builtIn), id: 'cp_tampered000001', title: 'Kept evil', preview: { rects: [{ x: '<script>', y: 0, w: 1, h: 1 }] } });
  tampered.posts.push({ ...tampered.posts.find((p) => !p.builtIn), id: 'cp_tampered000002', title: 'Kept creator?', authorName: 'Admin', creator: false });
  const checked = await api(fresh.base, 'POST', '/api/community/restore', tampered, { 'x-creator-token': CREATOR_TOKEN });
  check(checked.json.skipped >= 1, `a post that would fail publishing is skipped (${checked.json.skipped} skipped)`);
  const titles = (await published(fresh.base)).map((p) => p.title);
  check(!titles.includes('Kept evil'), 'the bad preview did not get in');
  const notGarbage = await api(fresh.base, 'POST', '/api/community/restore', { hello: 1 }, { 'x-creator-token': CREATOR_TOKEN });
  check(notGarbage.status === 400, 'something that is not a backup is refused');
} finally {
  for (const s of servers) {
    if (s.child.exitCode === null) s.child.kill('SIGTERM');
  }
  await Promise.all(servers.map((s) => s.exited));
}

console.log(`\n--- ${failures} failing`);
process.exit(failures ? 1 : 0);
