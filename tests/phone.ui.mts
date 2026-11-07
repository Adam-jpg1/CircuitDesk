// CircuitDesk on a phone, used with fingers.
//
// At 390 pixels wide the desktop editor's four panes left the canvas no room
// at all. This drives the phone layout as a phone user would: the front page
// fits, a project opens on its circuit with one pane at a time, a tap in the
// parts list puts a part on the canvas, a fingertip near a pin — not on it —
// starts and finishes a wire, one finger pans, two fingers pinch-zoom, and the
// menu holds what the toolbar has no room for. Touches are real touch events
// (CDP Input.dispatchTouchEvent), not mouse clicks.

import { chromium, devices, type Page, type CDPSession } from 'playwright';
import { spawn } from 'node:child_process';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const PORT = 5214;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
vite.stdout.on('data', (d) => (log += d));
vite.stderr.on('data', (d) => (log += d));

type Pt = { x: number; y: number };

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: Pt[]) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id, radiusX: 4, radiusY: 4, force: 1 })),
  });
}

async function tap(cdp: CDPSession, page: Page, at: Pt) {
  await touch(cdp, 'touchStart', [at]);
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(150);
}

/** The canvas's viewBox: x, y, width, height in world units. */
async function viewBox(page: Page): Promise<number[]> {
  return (await page.locator('.canvas-wrap > svg:not(.minimap)').getAttribute('viewBox'))!.split(' ').map(Number);
}

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
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const cdp = await context.newCDPSession(page);
  const width = devices['iPhone 13'].viewport.width;

  // ---------------------------------------------------------- front page
  await page.goto(`http://localhost:${PORT}/#/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.site-tab');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `the front page fits the phone's width (${overflow}px over)`);
  const tabs = await page.$$eval('.site-tab', (els) => els.map((e) => e.getBoundingClientRect().right));
  check(tabs.length === 3 && tabs.every((r) => r <= width), 'Projects, Templates and Community are all on screen');
  const actions = await page.$$eval('.empty-actions .btn', (els) =>
    els.map((e) => [e.getBoundingClientRect().left, e.getBoundingClientRect().right]),
  );
  check(actions.length === 3 && actions.every(([l, r]) => l >= 0 && r <= width), 'the welcome buttons wrap instead of running off the sides');

  // --------------------------------------------------------- the editor
  await page.getByRole('button', { name: 'Create First Project' }).click();
  await page.waitForSelector('.phone-tabs');
  check((await page.locator('.side-panel').count()) === 0, 'the editor opens without the desktop side panels');
  const canvasBox = await page.locator('.canvas-wrap').boundingBox();
  check(canvasBox !== null && canvasBox.width >= width - 1, `the canvas has the full width (${canvasBox?.width}px of ${width})`);
  check((await page.locator('.phone-tab.active').innerText()) === 'Circuit', 'and the Circuit pane is showing');
  await page.waitForSelector('[data-part-id]');
  const partsBefore = await page.locator('[data-part-id]').count();

  // ---------------------------------------------------- place a part
  await page.locator('.phone-tab', { hasText: 'Parts' }).tap();
  await page.locator('.library-panel input[type="search"], .phone-pane input[type="search"]').first().fill('push button');
  const item = page.locator('.library-item', { hasText: /push ?button/i }).first();
  await item.tap();
  await page.waitForTimeout(300);
  check((await page.locator('.phone-tab.active').innerText()) === 'Circuit', 'tapping a part goes back to the circuit');
  check((await page.locator('[data-part-id]').count()) === partsBefore + 1, 'with the part placed on it');
  await page.locator('.phone-tool', { hasText: 'Fit' }).tap();
  await page.waitForTimeout(200);

  // --------------------------------------------------- wire with fingers
  const button = page.locator('[data-part-id]').last();
  const buttonPin = await button.locator('[data-pin-id]').first().boundingBox();
  const boardPin = await page.locator('[data-part-id]').first().locator('[data-pin-id="D2"]').boundingBox();
  check(buttonPin !== null && boardPin !== null, 'the button and the board both show their pins');
  if (buttonPin && boardPin) {
    const wiresBefore = await page.locator('[data-connection-id]').count();
    await page.locator('.phone-tool', { hasText: 'Wire' }).tap();
    // A fingertip lands beside a pin, not on its few pixels.
    const near = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2 + 7, y: b.y + b.height / 2 + 6 });
    await tap(cdp, page, near(buttonPin));
    check((await page.locator('.phone-wire-hint').count()) === 1, 'a tap beside a pin starts a wire from it');
    await tap(cdp, page, near(boardPin));
    check((await page.locator('[data-connection-id]').count()) === wiresBefore + 1, 'and a tap beside another pin finishes it');
    check((await page.locator('.phone-wire-hint').count()) === 0, 'the wire hint goes once the wire is made');

    // A wire started and abandoned: Cancel, since there is no Escape key.
    await tap(cdp, page, near(buttonPin));
    await page.locator('.phone-wire-hint button', { hasText: 'Cancel' }).tap();
    check((await page.locator('.phone-wire-hint').count()) === 0, 'Cancel drops a wire in progress');
    await page.locator('.phone-tool', { hasText: 'Move' }).tap();
  }

  // ------------------------------------------------- one finger pans
  const box = (await page.locator('.canvas-wrap').boundingBox())!;
  const empty = { x: box.x + 30, y: box.y + 40 };
  const before = await viewBox(page);
  await touch(cdp, 'touchStart', [empty]);
  for (let i = 1; i <= 5; i++) await touch(cdp, 'touchMove', [{ x: empty.x + i * 16, y: empty.y + i * 10 }]);
  await touch(cdp, 'touchEnd', []);
  const panned = await viewBox(page);
  check(panned[0] < before[0] - 10 && panned[2] === before[2], `one finger on empty canvas pans it (x ${before[0].toFixed(0)} → ${panned[0].toFixed(0)}, zoom unchanged)`);

  // -------------------------------------------------- two fingers zoom
  const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await touch(cdp, 'touchStart', [{ x: mid.x - 40, y: mid.y }, { x: mid.x + 40, y: mid.y }]);
  for (let i = 1; i <= 6; i++) {
    await touch(cdp, 'touchMove', [{ x: mid.x - 40 - i * 12, y: mid.y }, { x: mid.x + 40 + i * 12, y: mid.y }]);
  }
  await touch(cdp, 'touchEnd', []);
  const zoomed = await viewBox(page);
  const factor = panned[2] / zoomed[2];
  check(factor > 2.7 && factor < 2.9, `spreading two fingers from 80 to 224 px apart zooms in 2.8x (${factor.toFixed(2)}x)`);
  // The point between the fingers stays put.
  const worldMidBefore = panned[0] + ((mid.x - box.x) / box.width) * panned[2];
  const worldMidAfter = zoomed[0] + ((mid.x - box.x) / box.width) * zoomed[2];
  check(Math.abs(worldMidBefore - worldMidAfter) < 2, 'about the point between the fingers');
  check((await page.locator('[data-part-id]').count()) === partsBefore + 1, 'and neither gesture moved or added a part');

  // ----------------------------------------------------- the menu
  await page.getByRole('button', { name: 'More' }).tap();
  const menu = await page.locator('.phone-menu [role="menuitem"]').allInnerTexts();
  check(['Compile', 'Validate circuit', 'Undo', 'Export…'].every((m) => menu.includes(m)), `the menu holds what the toolbar has no room for (${menu.join(', ')})`);
  await page.locator('.phone-menu-backdrop').tap({ position: { x: 10, y: 400 } });
  check((await page.locator('.phone-menu').count()) === 0, 'and a tap outside closes it');

  // ------------------------------------------------- the other panes
  await page.locator('.phone-tab', { hasText: 'Code' }).tap();
  await page.waitForSelector('.phone-pane .monaco-editor', { timeout: 20000 });
  check(await page.locator('.phone-pane .bottom-tab', { hasText: 'Serial' }).isVisible(), 'Code shows the sketch, with Serial a tab away');
  await page.locator('.phone-tab', { hasText: 'Inspect' }).tap();
  check(await page.locator('.phone-pane-inspect').isVisible(), 'Inspect shows the inspector');
  await page.locator('.phone-tab', { hasText: 'Circuit' }).tap();
  const back = await viewBox(page);
  check(back.join() === zoomed.join(), 'and the circuit is where it was left');

  const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(pageOverflow <= 0, `the editor never scrolls sideways (${pageOverflow}px over)`);
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await browser.close();
} finally {
  vite.kill();
}

console.log(`\n--- ${failures} failing`);
process.exit(failures ? 1 : 0);
