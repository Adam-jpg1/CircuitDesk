// What people publish survives a redeploy, a restart and the service
// sleeping — tested with real server processes, the way Render runs them.
//
// A Render deploy or restart starts a new container: the process is new and
// so is its filesystem. So every "new" server here gets a fresh, empty data
// directory, and the only thing it shares with the old one is the database.
// If anything were still kept on local disk, it would be gone.
//
//   1. publish, like (twice from one browser, once from another), redeploy
//      with SIGTERM: everything is there, counts exact, likes recognised;
//   2. a hard stop (SIGKILL — a crash, or the free tier putting the service
//      to sleep) loses nothing either, because nothing waits to be written;
//   3. status and /health say the storage is persistent;
//   4. the creator can back up and restore into a different database;
//   5. an old JSON file from before the database is imported once;
//   6. in production without DATABASE_URL the server says, loudly, that
//      nothing will survive.
//
// Runs on the Postgres in TEST_DATABASE_URL, which it EMPTIES first — point it
// only at a throwaway database. Without one, it runs on PGlite in a shared
// directory, which proves process restarts but not a fresh container.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
const ALICE = '0b7c2a4e-1d3f-4a5b-8c6d-7e8f9a0b1c2d';
const BOB = '9f1e2d3c-4b5a-4968-8776-655443322110';
let nextPort = 3600 + Math.floor(Math.random() * 300);

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const sharedPglite = mkdtempSync(path.join(tmpdir(), 'cd-community-pglite-'));
if (DATABASE_URL) {
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP TABLE IF EXISTS likes, projects, settings CASCADE;');
  await client.end();
  console.log('   on Postgres (TEST_DATABASE_URL); every new server gets an empty disk');
} else {
  console.log('   on PGlite in a shared directory (set TEST_DATABASE_URL to test against Postgres)');
}

interface Server {
  child: ChildProcess;
  base: string;
  exited: Promise<number | null>;
  log: () => string;
}

/** A new container: its own empty disk; the database is the only thing it shares. */
async function deploy(env: Record<string, string> = {}): Promise<Server> {
  const port = nextPort++;
  const freshDisk = mkdtempSync(path.join(tmpdir(), 'cd-container-'));
  // Node itself, as production runs it (`node dist-server/index.js`), so the
  // SIGTERM reaches the server rather than a wrapper.
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      DATABASE_URL,
      COMMUNITY_DATA_DIR: DATABASE_URL ? freshDisk : sharedPglite,
      CREATOR_TOKEN,
      COMPILE_WARMUP: 'off',
      COMMUNITY_PUBLISH_MAX: '1000',
      COMMUNITY_LIKE_MAX: '1000',
      COMMUNITY_READ_MAX: '1000',
      ...env,
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
      if (res.ok) return { child, base, exited, log: () => log };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start:\n${log}`);
}

async function stop(s: Server, signal: NodeJS.Signals): Promise<number | null> {
  s.child.kill(signal);
  return s.exited;
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
const post = (title: string) => ({ title, description: 'Kept.', authorName: 'Ada', tags: ['led'], board: 'Arduino Uno R3', project: project(title), preview, clientId: ALICE });
const like = (base: string, id: string, who: string) => api(base, 'PUT', `/api/community/projects/${id}/like`, { clientId: who });

const published = async (base: string, who = ALICE) =>
  ((await api(base, 'GET', `/api/community/projects?sort=new&limit=100&clientId=${who}`)).json.items as {
    id: string;
    title: string;
    likes: number;
    liked: boolean;
  }[]).filter((p) => p.title.startsWith('Kept '));

const servers: Server[] = [];
const up = async (env?: Record<string, string>) => {
  const s = await deploy(env);
  servers.push(s);
  return s;
};

try {
  // ============================================ 1. a redeploy keeps everything
  section('1. publish, like, and redeploy');
  const first = await up();
  const a = await api(first.base, 'POST', '/api/community/projects', post('Kept one'));
  const b = await api(first.base, 'POST', '/api/community/projects', post('Kept two'));
  check(a.status === 201 && b.status === 201, 'two projects are published');
  const id = a.json.item.id as string;
  let r = await like(first.base, id, ALICE);
  check(r.status === 200 && r.json.item.likes === 1 && r.json.item.liked, 'liked once (1)');
  r = await like(first.base, id, ALICE);
  check(r.json.item.likes === 1, `the same browser liking again does not count (${r.json.item.likes})`);
  r = await like(first.base, id, BOB);
  check(r.json.item.likes === 2, `a second browser makes two (${r.json.item.likes})`);
  // At once, as a deploy's SIGTERM can land right after a request.
  check((await stop(first, 'SIGTERM')) === 0, 'the old process exits cleanly on SIGTERM');

  const second = await up();
  const after = await published(second.base);
  check(after.length === 2, `the redeployed server, on a fresh disk, has both projects (${after.map((p) => p.title).join(', ')})`);
  const kept = after.find((p) => p.id === id);
  check(kept?.likes === 2 && kept.liked, `with both likes, still recognised as this browser's (${kept?.likes}, ${kept?.liked})`);
  check((await published(second.base, BOB)).find((p) => p.id === id)?.liked === true, "and as the other browser's");
  r = await like(second.base, id, ALICE);
  check(r.json.item.likes === 2, 'liking again after the redeploy still does not double-count');

  // ============================================ 2. a hard stop loses nothing
  section('2. a crash or the service sleeping (SIGKILL) loses nothing');
  r = await api(second.base, 'DELETE', `/api/community/projects/${id}/like`, { clientId: BOB });
  check(r.json.item.likes === 1, 'an unlike just before the stop');
  await stop(second, 'SIGKILL');
  const third = await up();
  const woke = (await published(third.base)).find((p) => p.id === id);
  check(woke?.likes === 1, `after waking, the count is exactly what it was (${woke?.likes})`);

  // ===================================================== 3. storage is reported
  section('3. whether storage is persistent is visible');
  const status = (await api(third.base, 'GET', '/api/community/status')).json;
  check(status.publishedPosts === 2, `status counts the published projects (${status.publishedPosts})`);
  if (DATABASE_URL) {
    check(status.mode === 'postgres' && status.persistent === true, `status says Postgres, persistent (${status.mode}, ${status.persistent})`);
    check(!JSON.stringify(status).includes('@'), 'and does not show the connection string');
  }
  const health = (await api(third.base, 'GET', '/health')).json;
  check(health.communityStorage?.publishedPosts === 2, '/health reports it too, for checking a deploy from outside');

  // ===================================================== 4. backup and restore
  section('4. the creator can back up and restore into another database');
  const refused = await api(third.base, 'GET', '/api/community/backup');
  check(refused.status === 403, 'a backup without the creator token is refused');
  const backup = await api(third.base, 'GET', '/api/community/backup', undefined, { 'x-creator-token': CREATOR_TOKEN });
  check(backup.status === 200 && backup.json.version === 1, 'the creator downloads a backup');

  const elsewhere = { DATABASE_URL: '', COMMUNITY_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'cd-community-new-')), COMMUNITY_DISK_PERSISTENT: '1' };
  const fresh = await up(elsewhere);
  check((await published(fresh.base)).length === 0, 'a new database starts with nothing published');
  const noToken = await api(fresh.base, 'POST', '/api/community/restore', backup.json);
  check(noToken.status === 403, 'a restore without the creator token is refused');
  const restored = await api(fresh.base, 'POST', '/api/community/restore', backup.json, { 'x-creator-token': CREATOR_TOKEN });
  check(restored.status === 200 && restored.json.added === 2, `the restore adds both projects (${restored.json.added})`);
  const moved = (await published(fresh.base)).find((p) => p.id === id);
  check(moved?.liked === true && moved.likes === 1, `with the same ids, likes and liked flags (${moved?.likes}, ${moved?.liked})`);
  const again = await api(fresh.base, 'POST', '/api/community/restore', backup.json, { 'x-creator-token': CREATOR_TOKEN });
  check(again.json.added === 0 && (await published(fresh.base)).length === 2, 'restoring twice adds nothing twice');
  // A backup is a file from outside: it goes through the publish checks.
  const tampered = structuredClone(backup.json) as { posts: Record<string, any>[] };
  tampered.posts.push({ ...tampered.posts.find((p) => !p.builtIn), id: 'cp_tampered000001', title: 'Kept evil', preview: { rects: [{ x: '<script>', y: 0, w: 1, h: 1 }] } });
  const checked = await api(fresh.base, 'POST', '/api/community/restore', tampered, { 'x-creator-token': CREATOR_TOKEN });
  check(checked.json.skipped >= 1, `a post that would fail publishing is skipped (${checked.json.skipped} skipped)`);
  check(!(await published(fresh.base)).some((p) => p.title === 'Kept evil'), 'the bad preview did not get in');
  const notGarbage = await api(fresh.base, 'POST', '/api/community/restore', { hello: 1 }, { 'x-creator-token': CREATOR_TOKEN });
  check(notGarbage.status === 400, 'something that is not a backup is refused');

  // ================================================= 5. the old JSON file
  section('5. a community.json from before the database is imported, once');
  const legacyDir = mkdtempSync(path.join(tmpdir(), 'cd-community-legacy-'));
  writeFileSync(path.join(legacyDir, 'community.json'), JSON.stringify(backup.json));
  const legacy = { DATABASE_URL: '', COMMUNITY_DATA_DIR: legacyDir };
  let old = await up(legacy);
  check((await published(old.base)).length === 2, 'its projects are in the database at first start');
  await stop(old, 'SIGTERM');
  old = await up(legacy);
  check((await published(old.base)).length === 2, 'and a restart does not import them a second time');

  // ======================================= 6. production without a database
  section('6. production without DATABASE_URL warns');
  const bare = await up({ DATABASE_URL: '', COMMUNITY_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'cd-community-bare-')) });
  const bareStatus = (await api(bare.base, 'GET', '/api/community/status')).json;
  check(bareStatus.persistent === false, `status says it is not persistent (${bareStatus.mode})`);
  check(/DATABASE_URL is not set/.test(bare.log()), 'and the startup log says everything will be lost at the next deploy');
} finally {
  for (const s of servers) {
    if (s.child.exitCode === null && s.child.signalCode === null) s.child.kill('SIGTERM');
  }
  await Promise.all(servers.map((s) => s.exited));
}

console.log(`\n--- ${failures} failing`);
process.exit(failures ? 1 : 0);
