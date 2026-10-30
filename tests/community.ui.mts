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

  // A like the server could not save is not shown as saved.
  await page.route('**/api/community/projects/*/like', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'The community is unavailable right now. Please try again in a moment.', errorCode: 'UNAVAILABLE' }),
    }),
  );
  await likeAgain.click();
  await page.waitForSelector('.toast.error', { timeout: 5000 }).catch(() => null);
  await page.waitForTimeout(300);
  const failedText = await page.locator('.toast.error').last().innerText().catch(() => '');
  check(/unavailable/i.test(failedText), `a failed like says so (${JSON.stringify(failedText)})`);
  check(
    (await likeAgain.getAttribute('aria-pressed')) === 'false' && Number(await likeAgain.locator('.like-count').innerText()) === base,
    'and the heart and count go back to what the server has',
  );
  await page.unroute('**/api/community/projects/*/like');

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

  // The report this guards: opening the 4-bit computer and pressing Run at
  // once — while its background build is running, on a service that may
  // still be warming up — was refused with "the compiler is busy". Run must
  // wait its turn and then run the program.
  await page.goto(`http://localhost:${PORT}/#/community`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' }); // a fresh page, without the search typed above
  await page.locator('[data-community-id="cp_logic_computer"]').first().click();
  await page.getByRole('button', { name: /Open a copy/ }).click();
  await page.waitForURL(/#\/editor\//, { timeout: 15_000 });
  await page.waitForSelector('g[data-definition-id="comp.74hc574"]', { timeout: 15_000 });
  await page.getByTitle(/Run \(Ctrl\+Enter\)/).click();
  await page.getByText('Serial', { exact: true }).first().click().catch(() => undefined);
  let serialText = '';
  for (let i = 0; i < 120 && !/PC=7 {2}JC {2}6 {2}taken\s/.test(serialText); i++) {
    await page.waitForTimeout(500);
    serialText = await page.locator('.mono-out').first().innerText().catch(() => '');
  }
  const compilerText = await page.locator('.mono-out').first().innerText().catch(() => '');
  check(!/compiler is busy/i.test(compilerText + serialText), 'pressing Run straight after opening the 4-bit computer is never refused as busy');
  check(
    /PC=3 {2}ADD {2}3 {2}->  ACC=9/.test(serialText) && /PC=6 {2}ADD {2}15 {2}->  ACC=8 {2}carry=1/.test(serialText) && /PC=7 {2}JC {2}6 {2}taken/.test(serialText),
    `and the chips run the program, jumps included (${(serialText.match(/PC=7[^\n]*/) ?? ['no jump yet'])[0]})`,
  );
  // And it keeps running, which the canvas shows: the display changes.
  const segmentsNow = () => page.locator('g[data-definition-id="comp.seven-segment"]').first().innerHTML();
  const before7 = await segmentsNow();
  await page.waitForTimeout(1500);
  check((await segmentsNow()) !== before7, 'the seven-segment display on the canvas keeps changing as it runs');

  // The snake, played. The reports this guards: the matrix stayed dark (the
  // MAX7219 lost every address byte), and the joystick could only be moved by
  // inspector sliders. Run it, see pixels, drag the stick up on the canvas and
  // see the snake turn.
  await page.goto(`http://localhost:${PORT}/#/community`, { waitUntil: 'networkidle' });
  await page.locator('[data-community-id="cp_matrix_snake"]').first().click();
  await page.getByRole('button', { name: /Open a copy/ }).click();
  await page.waitForURL(/#\/editor\//, { timeout: 15_000 });
  await page.waitForSelector('g[data-definition-id="comp.max7219"]', { timeout: 15_000 });
  await page.getByTitle(/Run \(Ctrl\+Enter\)/).click();
  const lit = () => page.locator('g[data-definition-id="comp.max7219"] circle[fill="#ff4d3d"]').count();
  let litCount = 0;
  for (let i = 0; i < 120 && litCount === 0; i++) {
    await page.waitForTimeout(500);
    litCount = await lit();
  }
  check(litCount >= 3, `the snake and its food light the matrix on the canvas (${litCount} pixels)`);
  const picture = () => page.locator('g[data-definition-id="comp.max7219"]').first().innerHTML();
  await page.waitForTimeout(400);
  const frameA = await picture();
  await page.waitForTimeout(800);
  check((await picture()) === frameA, 'a new game waits for the player rather than crawling into a wall');
  await page.getByText('Serial', { exact: true }).first().click().catch(() => undefined);
  const stick = await page.locator('g[data-definition-id="comp.joystick"]').first().boundingBox();
  if (stick) {
    const cx = stick.x + stick.width / 2;
    const cy = stick.y + stick.height * 0.35;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 60, { steps: 6 });
    let snakeSerial = '';
    for (let i = 0; i < 20 && !/turn U/.test(snakeSerial); i++) {
      await page.waitForTimeout(250);
      snakeSerial = await page.locator('.mono-out').first().innerText().catch(() => '');
    }
    await page.waitForTimeout(600);
    const frameB = await picture();
    await page.mouse.up();
    check(/GO\n/.test(snakeSerial) && /turn U/.test(snakeSerial), 'dragging the joystick up on the canvas starts the game and turns the snake');
    check(frameB !== frameA, 'and the snake moves on the matrix');
    check(!/turn [LR]/.test(snakeSerial), 'with no phantom turns from a stick nobody touched');
  } else {
    check(false, 'the joystick is on the canvas');
  }

  // Tetris, played with the mouse: the panel draws, the piece falls on its
  // own, and the four buttons on the canvas play the opening that clears a
  // line (I left, I right once, O right four times, each hard-dropped).
  await page.goto(`http://localhost:${PORT}/#/community`, { waitUntil: 'networkidle' });
  await page.locator('[data-community-id="cp_tft_tetris"]').first().click();
  await page.getByRole('button', { name: /Open a copy/ }).click();
  await page.waitForURL(/#\/editor\//, { timeout: 15_000 });
  await page.waitForSelector('g[data-definition-id="comp.st7735"]', { timeout: 15_000 });
  await page.getByTitle(/Run \(Ctrl\+Enter\)/).click();
  await page.getByText('Serial', { exact: true }).first().click().catch(() => undefined);
  const serialNow = () => page.locator('.mono-out').first().innerText().catch(() => '');
  let tetrisSerial = '';
  for (let i = 0; i < 120 && !/piece I/.test(tetrisSerial); i++) {
    await page.waitForTimeout(500);
    tetrisSerial = await serialNow();
  }
  const panel = () => page.locator('g[data-definition-id="comp.st7735"] image').first().getAttribute('href').catch(() => null);
  const panelA = await panel();
  check(!!panelA && panelA.startsWith('data:image/png'), 'the TFT shows a picture once the game starts');
  await page.waitForTimeout(1200);
  check((await panel()) !== panelA, 'and it changes as the piece falls on its own');
  const button = (name: string) => page.locator('g[data-definition-id="comp.push-button"]', { hasText: name }).first().boundingBox();
  const [leftBtn, rightBtn, dropBtn] = await Promise.all([button('LEFT'), button('RIGHT'), button('DROP')]);
  check(!!leftBtn && !!rightBtn && !!dropBtn && !!(await button('ROTATE')), 'the four buttons are labelled on the canvas');
  if (leftBtn && rightBtn && dropBtn) {
    const tapAt = async (b: { x: number; y: number; width: number; height: number }) => {
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(90);
      await page.mouse.up();
      await page.waitForTimeout(140);
    };
    const waitFor = async (re: RegExp) => {
      for (let i = 0; i < 30 && !re.test(tetrisSerial); i++) {
        await page.waitForTimeout(200);
        tetrisSerial = await serialNow();
      }
    };
    for (let i = 0; i < 3; i++) await tapAt(leftBtn);
    await tapAt(dropBtn);
    await waitFor(/piece I[\s\S]*piece I/);
    await tapAt(rightBtn);
    await tapAt(dropBtn);
    await waitFor(/piece O/);
    for (let i = 0; i < 4; i++) await tapAt(rightBtn);
    await tapAt(dropBtn);
    await waitFor(/lines 1/);
    check(/lines 1 {2}score \d+/.test(tetrisSerial), `clicking the buttons on the canvas plays the opening and clears a line (${(tetrisSerial.match(/lines[^\n]*/) ?? ['no line'])[0]})`);
  }

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
