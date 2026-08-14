// A close look at a handful of parts, still at 1:1.
//
// Fewer parts in frame, not bigger pixels — the sheet is rendered at the same
// zoom as everything else, so what is judged here is exactly what the editor
// draws. The point is only that a 56x80 part is easier to study when it is not
// one of a hundred on a 1700px sheet.
//
// Run:  npx tsx tools/review/detail.mts <name> <comma,separated,part,ids> [width]

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const [name, parts, width = '760'] = process.argv.slice(2);
if (!name || !parts) {
  console.error('usage: detail.mts <name> <part,ids> [width]');
  process.exit(2);
}

const OUT = 'tests/.artifacts/review';
const PORT = 5199;
await mkdir(OUT, { recursive: true });

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
vite.stdout.on('data', (d) => (log += d));
vite.stderr.on('data', (d) => (log += d));

try {
  for (let i = 0; ; i++) {
    if (i > 60) throw new Error(`vite did not start:\n${log}`);
    try {
      if ((await fetch(`http://localhost:${PORT}/tools/review/index.html`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: Number(width), height: 900 }, deviceScaleFactor: 1 });
  const url = `http://localhost:${PORT}/tools/review/index.html?parts=${encodeURIComponent(parts)}&title=${encodeURIComponent(name)}&width=${width}`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const box = await page.locator('svg').first().boundingBox();
  if (box) await page.setViewportSize({ width: Math.ceil(box.width), height: Math.ceil(box.height) });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/detail-${name}.png`, fullPage: true });
  console.log(`captured detail-${name}.png`);
  await browser.close();
} finally {
  vite.kill('SIGTERM');
}
