// The dashboard a new user actually lands on.
//
// Templates are only worth building if somebody can find them, and the two
// kinds answer different questions — "how do I start" and "what can this
// actually do". A single undifferentiated row answers neither, so this checks
// the split is real on screen, that every template is reachable, and that each
// card says which board it opens on: a showcase on a Pico is not something you
// can open on an Uno, and finding that out after clicking is too late.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { STARTER_TEMPLATES, SHOWCASE_TEMPLATES } from '../src/project/templates';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const PORT = 5201;
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.template-card');

  const sections = (await page.$$eval('.dash-section-title', (els) => els.map((e) => e.textContent?.trim() ?? '')));
  check(sections.includes('Starter templates'), `the starters have their own section (${sections.join(' | ')})`);
  check(sections.includes('Showcase projects'), 'and the showcases have theirs');

  const names = await page.$$eval('.template-card .t-name', (els) => els.map((e) => e.textContent?.trim() ?? ''));
  const starters = STARTER_TEMPLATES();
  const showcases = SHOWCASE_TEMPLATES();
  // The eight originals must still be there — a rebuild that quietly dropped
  // one is a regression — and the set may grow beyond them, which is the point
  // of having starters for boards that are not an Uno.
  const ORIGINAL_STARTERS = [
    'tpl.blink', 'tpl.button-led', 'tpl.potentiometer', 'tpl.rgb',
    'tpl.servo-sweep', 'tpl.ultrasonic', 'tpl.seven-segment', 'tpl.serial-demo',
  ];
  for (const id of ORIGINAL_STARTERS) {
    check(starters.some((t) => t.id === id), `the original starter ${id} is still offered`);
  }
  check(starters.length >= ORIGINAL_STARTERS.length, `and the set has not shrunk (${starters.length})`);
  check(
    new Set(starters.map((t) => t.board)).size >= 2,
    'starters cover more than one board, so a Pico owner has somewhere to begin',
  );
  check(showcases.length >= 6, `the showcase gallery has a spread (${showcases.length})`);

  for (const t of [...starters, ...showcases]) {
    check(names.includes(t.name), `"${t.name}" is on the dashboard`);
  }
  check(names.includes('Blank project'), 'and a blank project is still offered');

  // The board each one opens on, which is the thing a reader needs before
  // clicking rather than after.
  const boards = await page.$$eval('.template-card .t-board', (els) => els.map((e) => e.textContent?.trim() ?? ''));
  const distinct = [...new Set(boards)];
  check(boards.length === starters.length + showcases.length, `every template card names its board (${boards.length})`);
  check(distinct.length >= 3, `spanning several boards (${distinct.join(', ')})`);
  for (const arch of ['Raspberry Pi Pico', 'ESP32-C6-DevKitC-1']) {
    check(distinct.includes(arch), `including ${arch}, which is not an AVR`);
  }

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
  await browser.close();
} finally {
  vite.kill('SIGTERM');
}

console.log(failures === 0 ? '\nDashboard gallery checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
