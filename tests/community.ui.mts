// The community page, used the way a person uses it, in a browser.
//
// Browse it, find the creator's projects marked as theirs, like one and see the
// like survive a reload, unlike it, read a project's sketch, open a copy and
// land in the editor with the circuit on the canvas, then share a project of
// your own and take it down again. Against the real compiler service on :3411,
// which serves the community API; skipped without it.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const up = await fetch('http://localhost:3411/api/community/projects?limit=1').then((r) => r.ok).catch(() => false);
if (!up) {
  console.log('SKIP: the CircuitDesk service is not running on :3411');
  process.exit(0);
}

const PORT = 5213;
// The client talks to its own origin and Vite proxies /api, rather than this
// port being added to the server's CORS allowlist.
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, VITE_COMPILER_API_URL: `http://localhost:${PORT}` },
});
let log = '';
vite.stdout.on('data', (d) => (log += d));
vite.stderr.on('data', (d) => (log += d));

try {
  for (let i = 0; ; i++) {
    if (i > 60) throw new Error(`vite did not start:\n${log}`);
    try {
      if ((await fetch(`http://localhost:${PORT}/`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // ------------------------------------------------------------ browse
  await page.goto(`http://localhost:${PORT}/#/community`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.cm-card');
  const creatorCards = page.locator('.cm-creator-row .cm-card');
  check((await creatorCards.count()) >= 3, `the creator's projects have their own row (${await creatorCards.count()})`);
  check((await page.locator('.cm-creator-row .creator-badge').count()) === (await creatorCards.count()), 'each one carries the Creator badge');
  const anonymous = await page.locator('.tpl-grid .cm-author', { hasText: 'Anonymous' }).count();
  check(anonymous >= 6, `and the community's own posts are listed, the anonymous ones as Anonymous (${anonymous})`);
  const imgs = await page.$$eval('.cm-card .tpl-preview img', (els) => els.map((e) => (e as HTMLImageElement).src));
  check(imgs.length > 0 && imgs.every((s) => s.startsWith('data:image/svg+xml')), 'every card draws its circuit as an image');

  // ------------------------------------------------------------- like
  const card = page.locator('[data-community-id="cp_parking_beeper"]').first();
  const like = card.locator('.like-btn');
  const before = Number(await like.locator('.like-count').innerText());
  const wasLiked = (await like.getAttribute('aria-pressed')) === 'true';
  if (wasLiked) {
    await like.click();
    await page.waitForTimeout(400);
  }
  const base = Number(await like.locator('.like-count').innerText());
  await like.click();
  await page.waitForFunction(
    (n) => document.querySelector('[data-community-id="cp_parking_beeper"] .like-count')?.textContent === String(n),
    base + 1,
  );
  check((await like.getAttribute('aria-pressed')) === 'true', `liking fills the heart (${before} → ${base + 1})`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-community-id="cp_parking_beeper"]');
  const likeAgain = page.locator('[data-community-id="cp_parking_beeper"] .like-btn').first();
  check(
    (await likeAgain.getAttribute('aria-pressed')) === 'true' && Number(await likeAgain.locator('.like-count').innerText()) === base + 1,
    'and the like is still there after a reload',
  );
  await likeAgain.click();
  await page.waitForFunction(
    (n) => document.querySelector('[data-community-id="cp_parking_beeper"] .like-count')?.textContent === String(n),
    base,
  );
  check((await likeAgain.getAttribute('aria-pressed')) === 'false', 'clicking again takes it back');

  // ------------------------------------------------------ detail + copy
  await page.locator('[data-community-id="cp_night_light"]').first().click();
  await page.waitForSelector('.cm-code');
  await page.waitForFunction(() => /analogRead/.test(document.querySelector('.cm-code')?.textContent ?? ''));
  check(true, 'opening a post shows its sketch');
  await page.getByRole('button', { name: /Open a copy/ }).click();
  await page.waitForURL(/#\/editor\//, { timeout: 15_000 });
  await page.waitForSelector('g[data-definition-id="comp.ldr"]', { timeout: 15_000 });
  check(true, '"Open a copy" lands in the editor with the circuit on the canvas');
  const projectId = /#\/editor\/(.+)$/.exec(page.url())?.[1] ?? '';
  check(projectId.length > 0, 'as a project of your own');

  // --------------------------------------------------- share + remove
  const title = `UI test post ${Date.now()}`;
  await page.goto(`http://localhost:${PORT}/#/community?share=${encodeURIComponent(projectId)}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.cm-form');
  await page.getByLabel(/^Title/).fill(title);
  await page.getByLabel(/What does it do/).fill('Shared by the browser test, then removed.');
  await page.getByLabel(/Display name/).fill('ui_tester');
  await page.getByLabel(/Tags/).fill('test, ldr');
  await page.getByRole('button', { name: /^Share$/ }).click();
  await page.waitForSelector('.cm-code', { timeout: 10_000 });
  check(await page.getByText(title).first().isVisible(), 'sharing publishes the project and opens it');
  check(await page.locator('.modal .cm-author', { hasText: 'ui_tester' }).isVisible(), 'under the name given');
  check(!(await page.locator('.modal .creator-badge').isVisible()), 'without a Creator badge');
  const remove = page.getByRole('button', { name: 'Remove my post' });
  check(await remove.isVisible(), 'and the browser that published it can remove it');
  await remove.click();
  await page.waitForTimeout(800);
  await page.getByPlaceholder(/Search projects/).fill(title);
  await page.waitForTimeout(800);
  check((await page.locator('.cm-card', { hasText: title }).count()) === 0, 'after which it is gone');

  // The creator key. Only meaningful when the server under test has one; the
  // local runner sets CREATOR_TOKEN for this, a deployment sets its own.
  const creatorToken = process.env.CREATOR_TOKEN;
  if (creatorToken) {
    const creatorTitle = `Creator test post ${Date.now()}`;
    await page.goto(`http://localhost:${PORT}/#/community?share=${encodeURIComponent(projectId)}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.cm-form');
    await page.getByLabel(/^Title/).fill(creatorTitle);
    await page.getByText('I am the site creator').click();
    await page.getByLabel(/Creator key/).fill(creatorToken);
    await page.getByRole('button', { name: /^Share$/ }).click();
    await page.waitForSelector('.cm-code', { timeout: 10_000 });
    check(await page.locator('.modal .creator-badge').isVisible(), 'with the creator key, the post carries the Creator badge');
    await page.getByRole('button', { name: 'Remove my post' }).click();
    await page.waitForTimeout(600);
  } else {
    console.log('SKIP: no CREATOR_TOKEN in this environment, so the creator path was not exercised');
    skipped++;
  }

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
  await browser.close();
} finally {
  vite.kill('SIGTERM');
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
