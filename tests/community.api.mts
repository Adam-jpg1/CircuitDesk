// The community API, driven over HTTP the way the app drives it.
//
// What matters about a public write API with no accounts is what it refuses,
// so most of this is refusals: oversized, malformed and impersonating posts,
// likes without an id, deletes without the token, and bursts past the limits.
// Then the things a person does — publish, find it, like it, unlike it, delete
// it — and that the file it is kept in survives a restart.

import express from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerCommunityRoutes, builtinPosts, CREATOR_NAME } from '../server/community/routes';
import { CommunityStore } from '../server/community/store';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

process.env.CREATOR_TOKEN = 'test-creator-token-0123456789';
const dir = await mkdtemp(path.join(tmpdir(), 'cd-community-'));
const file = path.join(dir, 'community.json');

async function serve(store: CommunityStore) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));
  await registerCommunityRoutes(app, store);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base };
}

const store = new CommunityStore(file, builtinPosts());
await store.load();
const { server, base } = await serve(store);
const api = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}, ip = '10.0.0.1') => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};

const project = (extra: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'Mine',
  version: '1.0.0',
  boardInstances: [{ id: 'b', definitionId: 'board.arduino-uno', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {} }],
  componentInstances: [{ id: 'l', definitionId: 'comp.led', x: 300, y: 40, rotation: 0, properties: {}, simulationState: {} }],
  connections: [],
  codeFiles: [{ id: 'f', name: 'sketch.ino', content: 'void setup(){}\nvoid loop(){}\n', language: 'cpp' }],
  tests: [],
  ...extra,
});
const preview = { rects: [{ x: 0, y: 0, w: 200, h: 150, k: 'board' }], lines: [{ x1: 0, y1: 0, x2: 10, y2: 10, c: '#e8590c' }] };
const post = (over: Record<string, unknown> = {}) => ({
  title: 'Blinking thing', description: 'It blinks.', authorName: '', tags: ['led'], board: 'Arduino Uno R3', project: project(), preview, ...over,
});

try {
  // ============================================================ browsing ====
  section('1. browsing');
  const builtIns = builtinPosts();
  let r = await api('GET', '/api/community/projects');
  check(r.status === 200 && r.json.total === builtIns.length, `the built-in projects are listed (${r.json.total})`);
  const likesOf = (items: { likes: number }[]) => items.map((i) => i.likes);
  const sortedDesc = (xs: number[]) => xs.every((x, i) => i === 0 || xs[i - 1] >= x);
  check(sortedDesc(likesOf(r.json.items)), 'most liked first by default');
  check(r.json.items.every((i: Record<string, unknown>) => !('project' in i) && !('likers' in i) && !('deleteTokenHash' in i)), 'a list carries no project bodies, likers or secrets');
  check(r.json.creatorName === CREATOR_NAME, `the creator's name is reported (${r.json.creatorName})`);

  // ========================================================== refusals =======
  section('2. what it refuses');
  const refusals: [string, Record<string, unknown>][] = [
    ['a title that is too short', post({ title: 'x' })],
    ['a title that is too long', post({ title: 'x'.repeat(200) })],
    ['a project with no board', post({ project: project({ boardInstances: [] }) })],
    ['a code file name the compiler would refuse', post({ project: project({ codeFiles: [{ name: '../etc/passwd', content: '' }] }) })],
    ['a project over the size limit', post({ project: project({ codeFiles: [{ name: 'a.ino', content: 'x'.repeat(400 * 1024) }] }) })],
    ['too many tags', post({ tags: ['a', 'b', 'c', 'd', 'e', 'f'] })],
    ['a tag with markup', post({ tags: ['<b>x</b>'] })],
    ['a display name claiming the creator', post({ authorName: CREATOR_NAME })],
    ['a display name claiming to be official', post({ authorName: 'CircuitDesk Official' })],
    ['a display name with markup', post({ authorName: '<img src=x>' })],
    ['a preview with something other than numbers', post({ preview: { rects: [{ x: '<script>', y: 0, w: 1, h: 1 }] } })],
  ];
  for (const [what, body] of refusals) {
    r = await api('POST', '/api/community/projects', body, {}, '10.9.0.' + Math.floor(Math.random() * 250));
    check(r.status === 400 && typeof r.json.error === 'string', `refuses ${what} (${r.status}: ${r.json.error})`);
  }

  // ==================================================== publishing ==========
  section('3. publishing');
  r = await api('POST', '/api/community/projects', post({ title: '  Blink  <b>bold</b>\n with‮ tricks ', authorName: 'maker_kat' }), {}, '10.1.0.1');
  check(r.status === 201, `a valid project is published (${r.status})`);
  const mine = r.json.item;
  const deleteToken = r.json.deleteToken as string;
  check(/^[0-9a-f]{48}$/.test(deleteToken), 'and the publisher is handed a delete token, once');
  check(mine.title === 'Blink <b>bold</b> with tricks', `control characters are stripped and markup kept as plain text (${JSON.stringify(mine.title)})`);
  check(mine.authorName === 'maker_kat' && mine.creator === false, 'under the name given, without the creator badge');
  check(mine.partCount === 2 && mine.boardId === 'board.arduino-uno', 'with its part count and board worked out on the server');
  const anon = await api('POST', '/api/community/projects', post({ title: 'Nameless' }), {}, '10.1.0.2');
  check(anon.json.item.authorName === 'Anonymous', 'no name means Anonymous');
  const full = await api('GET', `/api/community/projects/${mine.id}`);
  check(full.status === 200 && full.json.project.codeFiles[0].name === 'sketch.ino', 'the full project comes back for "open a copy"');
  const withThumb = await api('POST', '/api/community/projects', post({ title: 'Thumb', project: project({ thumbnailSvg: '<svg onload=alert(1)>' }) }), {}, '10.1.0.3');
  const fetched = await api('GET', `/api/community/projects/${withThumb.json.item.id}`);
  check(fetched.json.project.thumbnailSvg === undefined, 'a project never keeps thumbnail markup it was sent');

  // ======================================================= the creator =======
  section('4. the creator badge comes from the token, not the name');
  r = await api('POST', '/api/community/projects', post({ title: 'From the creator', authorName: 'whoever' }), { 'x-creator-token': process.env.CREATOR_TOKEN! }, '10.2.0.1');
  check(r.status === 201 && r.json.item.creator === true && r.json.item.authorName === CREATOR_NAME, `with the token: badge and the creator's name (${r.json.item.authorName})`);
  r = await api('POST', '/api/community/projects', post({ title: 'Pretender' }), { 'x-creator-token': 'wrong-token-wrong-token' }, '10.2.0.2');
  check(r.status === 201 && r.json.item.creator === false, 'with a wrong token: published, but no badge');
  const creatorList = await api('GET', '/api/community/projects?creator=1&limit=60');
  check(creatorList.json.items.every((i: { creator: boolean }) => i.creator), 'the creator filter lists only badge-holders');

  // ============================================================ likes ========
  section('5. likes');
  const me = randomUUID();
  const other = randomUUID();
  r = await api('PUT', `/api/community/projects/${mine.id}/like`, { clientId: me });
  check(r.status === 200 && r.json.item.likes === 1 && r.json.item.liked, 'liking counts once');
  r = await api('PUT', `/api/community/projects/${mine.id}/like`, { clientId: me });
  check(r.json.item.likes === 1, 'and liking again does not count twice');
  r = await api('PUT', `/api/community/projects/${mine.id}/like`, { clientId: other });
  check(r.json.item.likes === 2, 'a second visitor makes two');
  const seen = await api('GET', `/api/community/projects?q=maker_kat&clientId=${me}`);
  check(seen.json.items[0]?.liked === true, 'the list says which ones this visitor liked');
  r = await api('DELETE', `/api/community/projects/${mine.id}/like`, { clientId: me });
  check(r.json.item.likes === 1 && !r.json.item.liked, 'unliking takes it back');
  r = await api('PUT', `/api/community/projects/${mine.id}/like`, { clientId: 'not-a-uuid' });
  check(r.status === 400, 'a like needs a well-formed anonymous id');
  const first = builtIns[0];
  r = await api('PUT', `/api/community/projects/${first.id}/like`, { clientId: me });
  check(r.json.item.likes === first.baseLikes + 1, `likes add to a built-in project's base count (${first.baseLikes} + 1)`);

  // ======================================================== searching =======
  section('6. searching and sorting');
  r = await api('GET', '/api/community/projects?sort=new&limit=3');
  const dates = r.json.items.map((i: { createdAt: string }) => i.createdAt);
  check(dates.every((d: string, i: number) => i === 0 || dates[i - 1] >= d), 'newest first when asked');
  r = await api('GET', '/api/community/projects?q=blink');
  check(r.json.items.some((i: { id: string }) => i.id === mine.id), 'search finds a project by its title');

  // =========================================================== deleting ======
  section('7. only the publisher can delete');
  r = await api('DELETE', `/api/community/projects/${mine.id}`, undefined, { 'x-delete-token': 'f'.repeat(48) });
  check(r.status === 403, 'a wrong token is refused');
  r = await api('DELETE', `/api/community/projects/${mine.id}`);
  check(r.status === 403, 'no token is refused');
  r = await api('DELETE', `/api/community/projects/${mine.id}`, undefined, { 'x-delete-token': deleteToken });
  check(r.status === 200, 'the right token removes it');
  r = await api('GET', `/api/community/projects/${mine.id}`);
  check(r.status === 404, 'and it is gone');

  // ====================================================== rate limits ========
  section('8. publishing is rate limited');
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) {
    statuses.push((await api('POST', '/api/community/projects', post({ title: `Burst ${i}` }), {}, '10.3.0.1')).status);
  }
  check(statuses.slice(0, 5).every((s) => s === 201) && statuses.slice(5).every((s) => s === 429), `five an hour from one address, then 429 (${statuses.join(' ')})`);

  // ===================================================== persistence ========
  section('9. it survives a restart');
  await store.flush();
  const onDisk = JSON.parse(await readFile(file, 'utf8')) as { posts: { id: string; likers: string[] }[] };
  check(onDisk.posts.some((p) => p.id === anon.json.item.id), 'published projects are written to the data file');
  check(!JSON.stringify(onDisk).includes(other), 'and the file holds hashes, not the anonymous ids themselves');
  const reopened = new CommunityStore(file, builtinPosts());
  await reopened.load();
  check(reopened.get(anon.json.item.id) !== undefined, 'a fresh process reads them back');
  const firstAgain = reopened.summary(reopened.get(first.id)!, me);
  check(firstAgain.likes === first.baseLikes + 1 && firstAgain.liked, 'and a like on a built-in project is kept across the restart');
  const smaller = new CommunityStore(file, builtinPosts().slice(1));
  await smaller.load();
  check(smaller.get(first.id) === undefined, 'a built-in project the code no longer ships is dropped, not kept from the file');
  check(smaller.get(anon.json.item.id) !== undefined, 'while what visitors published stays');
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}

section(`${failures} failing`);
process.exit(failures ? 1 : 0);
