// The full-size key panel, and the four things it must not get wrong.
//
// The panel exists because fifty keys on a 118 mm part is about nine pixels a
// key at the zoom the canvas opens at — accurate, and close to unusable. What
// makes it safe to add is that it is a *view*: it presses the same contacts the
// canvas presses, and it presses nothing else.
//
// So this checks the four claims that matter:
//   1. a key here closes exactly one matrix crossing, by the contact key the
//      simulation uses — not a character, not a keycode;
//   2. several keys can be down at once, because a matrix has no interlock;
//   3. closing the panel lets go of everything it was holding, so no contact is
//      left closed with nothing on screen able to open it;
//   4. nothing in it can reach the firmware except through the matrix.
//
// It drives the real component against the real stores in a browser, because
// the claims are about what ends up in the simulation store and a mock of that
// store would be asserting on itself.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { MINI_KEYBOARD_CAPS, MINI_KEYBOARD_COLS, MINI_KEYBOARD_ROWS, matrixKey } from '../src/simulation/devices/matrixInput';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

const PORT = 5198;
// Vite itself, not through npx: killing npx would leave the server holding the port.
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
vite.stdout.on('data', (d) => (log += d));
vite.stderr.on('data', (d) => (log += d));

/** Contacts the panel is holding closed, by contact key. */
type Held = string[];

try {
  for (let i = 0; ; i++) {
    if (i > 60) throw new Error(`vite did not start:\n${log}`);
    try {
      if ((await fetch(`http://localhost:${PORT}/tools/review/keypanel.html`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/tools/review/keypanel.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="keymatrix-overlay"]');

  const held = (): Promise<Held> =>
    page.evaluate(() => {
      const sim = (window as unknown as { sim: { getState(): { pressedButtons: string[] } } }).sim;
      return sim.getState().pressedButtons.map((k) => k.replace(/^kb1#?/, ''));
    });
  const keyAt = (row: number, col: number) => page.locator(`svg g:has(title)`).nth(row * MINI_KEYBOARD_COLS + col);

  // ============================================ 1. one key, one crossing ====
  section('1. a key closes the crossing it is drawn on');
  {
    const total = await page.locator('svg g:has(title)').count();
    check(
      total === MINI_KEYBOARD_ROWS * MINI_KEYBOARD_COLS,
      `the panel draws every key of the matrix (${total} of ${MINI_KEYBOARD_ROWS * MINI_KEYBOARD_COLS})`,
    );

    const cap = await keyAt(2, 3).locator('text').textContent();
    check(cap === MINI_KEYBOARD_CAPS[2 * MINI_KEYBOARD_COLS + 3], `keys are in matrix order ("${cap}")`);

    check((await held()).length === 0, 'nothing is closed to start with');
    await keyAt(2, 3).hover();
    await page.mouse.down();
    const down = await held();
    check(down.length === 1 && down[0] === matrixKey(2, 3), `holding it closes exactly ${matrixKey(2, 3)} (${down.join(',') || 'none'})`);

    // The pressed key is visible, not merely recorded.
    const stroke = await keyAt(2, 3).locator('rect').first().getAttribute('stroke');
    check(stroke === '#7fb2e8', `and the key is drawn down (${stroke})`);

    await page.mouse.up();
    check((await held()).length === 0, 'releasing opens it again');
  }

  // ================================== 2. a matrix has no interlock ==========
  section('2. several keys at once');
  {
    await page.locator('.keymatrix-toggle input').first().check(); // "Hold keys"
    for (const [r, c] of [[0, 0], [1, 4], [4, 9]] as const) {
      await keyAt(r, c).click();
    }
    const down = (await held()).sort();
    const want = [matrixKey(0, 0), matrixKey(1, 4), matrixKey(4, 9)].sort();
    check(
      down.length === 3 && want.every((k, i) => down[i] === k),
      `three keys are down together (${down.join(', ')})`,
    );

    // Pressing one again lets go of that one and no other, which is what makes
    // a held key usable as a modifier.
    await keyAt(1, 4).click();
    const after = (await held()).sort();
    check(after.length === 2 && !after.includes(matrixKey(1, 4)), `releasing one leaves the others (${after.join(', ')})`);
  }

  // ============================ 3. closing must not strand a contact ========
  section('3. closing the panel opens everything it was holding');
  {
    check((await held()).length === 2, 'two keys are still down');
    await page.locator('.keymatrix-head button').click();
    await page.waitForSelector('[data-testid="closed"]');
    const after = await held();
    check(after.length === 0, `and the panel is gone with nothing left closed (${after.join(', ') || 'none'})`);
  }

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await browser.close();
} finally {
  vite.kill('SIGTERM');
}

// ================================== 4. it is not a keyboard driver ==========
section('4. the panel cannot reach firmware except through the matrix');
{
  const source = await readFile('src/editor/KeyMatrixOverlay.tsx', 'utf8');
  // The only way anything here touches the simulation.
  const writes = [...source.matchAll(/useSimulationStore\.getState\(\)\.(\w+)/g)].map((m) => m[1]);
  const unexpected = [...new Set(writes)].filter((fn) => fn !== 'pressButton');
  check(
    unexpected.length === 0,
    `the only simulation call it makes is pressButton${unexpected.length ? ` (also: ${unexpected.join(', ')})` : ''}`,
  );

  for (const forbidden of ['sendSerial', 'writeSerial', 'onSerialByte', 'HID', 'usb']) {
    check(!new RegExp(forbidden, 'i').test(source.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')), `no ${forbidden} anywhere in it`);
  }
  check(
    /contactStateKey/.test(source),
    'and it addresses contacts by the same key the canvas and the binding use',
  );
}

console.log(failures === 0 ? '\nKey panel checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
