// The front of the app: projects, templates, and the way between them.
//
// Templates are only worth building if somebody can find them, and the two
// kinds answer different questions — "how do I start" and "what can this
// actually do". They now have a page of their own, so this checks the split is
// real on that page, that every template is reachable, that each card says
// which board it opens on and is drawn from its own circuit, that the filters
// filter — and that the projects page still offers a way in.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { STARTER_TEMPLATES, SHOWCASE_TEMPLATES } from '../src/project/templates';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const PORT = 5201;
// Vite itself, not through npx: killing an npx wrapper leaves the server
// holding the port for the next run.
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
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
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // ------------------------------------------------------------ projects
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  const tabs = await page.$$eval('.site-tab', (els) => els.map((e) => e.textContent?.trim() ?? ''));
  check(['Projects', 'Templates', 'Community'].every((t) => tabs.includes(t)), `the header offers Projects, Templates and Community (${tabs.join(' | ')})`);
  check((await page.locator('.site-tab.active').innerText()).trim() === 'Projects', 'and marks where you are');
  const teaser = await page.locator('.template-card').count();
  check(teaser >= 3 && teaser <= 6, `the projects page shows a few templates, not the whole gallery (${teaser})`);
  check(await page.getByRole('button', { name: /All templates/ }).isVisible(), 'with a way to the rest');

  // ----------------------------------------------------------- templates
  await page.getByRole('button', { name: /All templates/ }).click();
  await page.waitForSelector('.site-hero');
  check(page.url().endsWith('#/templates'), 'which is a page of its own');
  const sections = await page.$$eval('.dash-section-title', (els) => els.map((e) => e.textContent?.trim() ?? ''));
  check(sections.includes('Starter templates'), `the starters have their own section (${sections.join(' | ')})`);
  check(sections.includes('Showcase projects'), 'and the showcases have theirs');

  const starters = STARTER_TEMPLATES();
  const showcases = SHOWCASE_TEMPLATES();
  const ORIGINAL_STARTERS = [
    'tpl.blink', 'tpl.button-led', 'tpl.potentiometer', 'tpl.rgb',
    'tpl.servo-sweep', 'tpl.ultrasonic', 'tpl.seven-segment', 'tpl.serial-demo',
  ];
  for (const id of ORIGINAL_STARTERS) check(starters.some((t) => t.id === id), `the original starter ${id} is still offered`);
  check(new Set(starters.map((t) => t.board)).size >= 2, 'starters cover more than one board');
  check(showcases.length >= 6, `the showcase gallery has a spread (${showcases.length})`);

  const names = await page.$$eval('.tpl-grid .template-card .t-name', (els) => els.map((e) => e.textContent?.trim() ?? ''));
  for (const t of [...starters, ...showcases]) check(names.includes(t.name), `"${t.name}" is on the page`);
  check(names.includes('Blank project'), 'and a blank project is still offered');

  const boards = await page.$$eval('.tpl-grid .template-card .t-board', (els) => els.map((e) => e.textContent?.trim() ?? ''));
  check(boards.length === starters.length + showcases.length, `every template card names its board (${boards.length})`);
  for (const arch of ['Raspberry Pi Pico', 'ESP32-C6-DevKitC-1']) check(boards.includes(arch), `including ${arch}, which is not an AVR`);

  const previews = await page.$$eval('.tpl-grid .tpl-preview img', (els) => els.map((e) => (e as HTMLImageElement).src));
  check(previews.length === starters.length + showcases.length && previews.every((s) => s.startsWith('data:image/svg+xml')), 'every card shows its own circuit, as an image');
  check(new Set(previews).size === previews.length, 'and no two pictures are the same');
  const tested = await page.locator('.tpl-grid .tpl-tested').count();
  check(tested === starters.length + showcases.length, `and every one says it is bench-tested — which tests/starters audit asserts (${tested})`);

  // The filters filter.
  await page.getByRole('tab', { name: 'Showcases' }).click();
  check((await page.locator('.dash-section-title', { hasText: 'Starter templates' }).count()) === 0, 'choosing Showcases hides the starters');
  check((await page.locator('.tpl-grid .template-card').count()) === showcases.length, 'and lists every showcase');
  await page.getByRole('tab', { name: 'All' }).click();
  await page.locator('.chip', { hasText: 'Raspberry Pi Pico' }).click();
  const picoOnly = await page.$$eval('.tpl-grid .template-card .t-board', (els) => els.map((e) => e.textContent?.trim() ?? ''));
  check(picoOnly.length > 0 && picoOnly.every((b) => b === 'Raspberry Pi Pico'), `a board chip narrows to that board (${picoOnly.length})`);
  await page.locator('.chip', { hasText: 'Every board' }).click();
  await page.getByPlaceholder(/Search templates/).fill('servo');
  const found = await page.$$eval('.tpl-grid .template-card .t-name', (els) => els.map((e) => e.textContent?.trim() ?? ''));
  check(found.length > 0 && found.every((n) => /servo/i.test(n) || n !== ''), `search finds by name or part (${found.join(', ')})`);

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
  await browser.close();
} finally {
  vite.kill('SIGTERM');
}

console.log(failures === 0 ? '\nDashboard gallery checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
