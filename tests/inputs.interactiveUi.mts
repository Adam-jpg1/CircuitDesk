// Typing a temperature into the inspector, in a browser, and reading it back.
//
// tests/inputs.interactive.mts proves the store call reaches firmware. This
// proves a person can make that call: open the I2C showcase from the
// dashboard, click the BMP280 on the canvas, type 20 into its Temperature box,
// press Run, and the serial monitor shows the sketch printing 20.0 C. Then the
// same with the slider, so both ways of setting a value are covered.
//
// Needs the compiler service on :3411; without it the run step is skipped.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { SHOWCASE_TEMPLATES } from '../src/project/templates';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const PORT = 5207;
// The client talks to its own origin and Vite's /api proxy forwards to the
// compiler, rather than this test's port being added to the server's CORS
// allowlist — that list is a protection and stays as it ships.
// Vite itself rather than through npx: killing an npx wrapper leaves the real
// server running on the port, and the next run then talks to a stale one.
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
  const compilerUp = await fetch('http://localhost:3411/api/compiler/health').then((r) => r.ok).catch(() => false);

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  if (process.env.TRACE) {
    page.on('requestfailed', (r) => console.log('   request failed:', r.url(), r.failure()?.errorText));
    page.on('response', (r) => r.url().includes('/api/') && console.log('   api:', r.status(), r.url()));
    page.on('console', (m) => m.type() === 'error' && console.log('   console:', m.text().slice(0, 200)));
  }
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });

  const showcase = SHOWCASE_TEMPLATES().find((t) => t.id === 'show.i2c-sensor-bus')!;
  await page.locator('.template-card', { hasText: showcase.name }).first().click();
  const bmp = page.locator('g[data-definition-id="comp.bmp280"]').first();
  await bmp.waitFor({ timeout: 20_000 });
  check(true, 'the showcase opens with a BMP280 on the canvas');

  // Select it the way a person does: click it.
  const box = await bmp.boundingBox();
  check(box !== null, 'the BMP280 is on screen');
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.35);
  const temp = page.getByLabel('Temperature (°C)', { exact: true });
  await temp.waitFor({ timeout: 5_000 }).catch(() => undefined);
  check(await temp.isVisible().catch(() => false), 'selecting it shows a Temperature box in the inspector');
  check(
    await page.getByLabel('Pressure (hPa)', { exact: true }).isVisible().catch(() => false),
    'and a Pressure box',
  );
  check((await temp.inputValue().catch(() => '')) === '25.0', `starting at the sensor's 25.0 °C (${await temp.inputValue().catch(() => '?')})`);

  // Typed before Run: the value applies when the simulation starts.
  await temp.fill('20');
  await temp.press('Enter');
  check((await temp.inputValue()) === '20.0', `typing 20 sets 20.0 °C (${await temp.inputValue()})`);

  // Out of range is clamped, not passed through.
  await temp.fill('500');
  await temp.press('Enter');
  check((await temp.inputValue()) === '85.0', `typing 500 clamps to the part's 85.0 °C limit (${await temp.inputValue()})`);
  await temp.fill('20');
  await temp.press('Enter');

  if (!compilerUp) {
    console.log('SKIP: the compiler service is not running, so the firmware was not run');
    skipped++;
  } else {
    await page.getByTitle(/Run \(Ctrl\+Enter\)/).click();
    // The serial monitor is a tab of the bottom panel; open it as a person would.
    await page.getByRole('button', { name: 'Serial', exact: true }).first().click().catch(() => undefined);
    await page.getByText('Serial', { exact: true }).first().click().catch(() => undefined);
    const serial = page.locator('.mono-out').first();
    let text = '';
    for (let i = 0; i < 90 && !/temperature 20\.0 C/.test(text); i++) {
      await page.waitForTimeout(500);
      text = await serial.innerText().catch(() => '');
    }
    check(/temperature 20\.0 C/.test(text), `the running sketch prints "temperature 20.0 C" (${(text.match(/temperature [\d.]+ C/g) ?? []).slice(-1)[0] ?? 'nothing yet'})`);

    // Now the slider, mid-run.
    const slider = page.getByLabel('Temperature slider', { exact: true });
    await slider.fill('30');
    let after = '';
    for (let i = 0; i < 40 && !/temperature 30\.0 C/.test(after); i++) {
      await page.waitForTimeout(500);
      after = await serial.innerText().catch(() => '');
    }
    check(/temperature 30\.0 C/.test(after), 'dragging the slider to 30 while it runs is printed as 30.0 C');
    check((await temp.inputValue()) === '30.0', 'and the number box follows the slider');
  }

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
  await browser.close();
} finally {
  vite.kill('SIGTERM');
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures === 0 ? 0 : 1);
