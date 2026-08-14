// Captures the review sheets to PNG at exactly 1:1.
//
// deviceScaleFactor is pinned to 1 so a pixel in the file is a pixel on the
// screen. That is the entire point: an enlarged screenshot proves nothing
// about whether a 1.4 mm character is readable.
//
// Run:  npx tsx tools/review/capture.mts        (starts vite itself)

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const SHEETS = ['inputs', 'sensors', 'displays', 'motors', 'communication', 'logic', 'power', 'showcase'];
const OUT = 'tests/.artifacts/review';
const PORT = 5199;

await mkdir(OUT, { recursive: true });

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let viteOut = '';
vite.stdout.on('data', (d) => (viteOut += d));
vite.stderr.on('data', (d) => (viteOut += d));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/tools/review/index.html`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`vite did not start:\n${viteOut}`);
}

try {
  await waitForServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  for (const sheet of SHEETS) {
    await page.goto(`http://localhost:${PORT}/tools/review/index.html?sheet=${sheet}`, { waitUntil: 'networkidle' });
    // The raster panels paint in an effect after their first frame.
    await page.waitForTimeout(900);
    const box = await page.locator('svg').first().boundingBox();
    if (!box) throw new Error(`sheet ${sheet} rendered nothing`);
    await page.setViewportSize({ width: Math.ceil(box.width), height: Math.min(Math.ceil(box.height), 20000) });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/${sheet}.png`, fullPage: true });
    console.log(`captured ${sheet}  ${Math.round(box.width)}x${Math.round(box.height)}`);
  }

  await browser.close();
  if (errors.length) {
    console.error(`\n${errors.length} page error(s):`);
    for (const e of errors.slice(0, 20)) console.error('  ', e);
    process.exitCode = 1;
  } else {
    console.log('\nno page errors');
  }
} finally {
  vite.kill('SIGTERM');
}
