// Pin-visibility check in a real browser against the built app on :3411.
//
// Imports a project holding an Uno, a Nano, a Mega, a Pico, a BMP280 and an
// MPU-6050, then reads the rendered SVG back out. Two things are proven here:
//
//   1. every pin paints a visible marker with NO cursor over it, and
//   2. the interactive hit circles and the wire endpoints still sit on exactly
//      the coordinates they sat on before (dumped as COORD lines, diffed
//      against the same run with the marker change reverted).

import { chromium } from 'playwright';

const SCRATCH = '/tmp/claude-0/-home-user-whay/33313529-9d56-5506-bb90-3d0291077577/scratchpad';
const COORDS_ONLY = process.argv.includes('--coords-only');

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!COORDS_ONLY) console.log(ok ? 'PASS:' : 'FAIL:', msg);
  if (!ok) failures++;
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://localhost:3411/#/import', { waitUntil: 'load' });
await page.waitForTimeout(1500);
const chooser = page.waitForEvent('filechooser');
await page.locator('.dropzone').click();
(await chooser).setFiles(`${SCRATCH}/pinvis.cdproj.json`);
await page.waitForTimeout(2000);
for (let step = 0; step < 5; step++) {
  const importBtn = page.getByRole('button', { name: 'Import', exact: true });
  if (await importBtn.isVisible().catch(() => false)) {
    await importBtn.click();
    break;
  }
  const cont = page.getByRole('button', { name: /^Continue/ }).first();
  if (!(await cont.isVisible().catch(() => false))) break;
  await cont.click();
  await page.waitForTimeout(700);
}
await page.waitForTimeout(3000);
if (!page.url().includes('#/editor/')) {
  await page.goto('http://localhost:3411/#/', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  await page.locator('.project-card').first().click();
  await page.waitForTimeout(2500);
}
check(page.url().includes('#/editor/'), 'multi-board project opened in the editor');

/** Every circle on the canvas, with the geometry and paint the browser resolved. */
async function readCircles() {
  return page.$$eval('.canvas-wrap svg circle', (nodes) =>
    nodes.map((n) => {
      const el = n as SVGCircleElement;
      return {
        cx: Number(el.getAttribute('cx')),
        cy: Number(el.getAttribute('cy')),
        r: Number(el.getAttribute('r')),
        fill: el.getAttribute('fill') ?? '',
        stroke: el.getAttribute('stroke') ?? '',
        pe: getComputedStyle(el).pointerEvents,
        cursor: getComputedStyle(el).cursor,
      };
    }),
  );
}

// Default view zoom is 1 — normal working zoom, markers render in full.
await page.mouse.move(1200, 880);
await page.waitForTimeout(500);
const circles = await readCircles();

// --- the coordinate dump compared across the two builds ---
const hit = circles.filter((c) => c.cursor === 'crosshair');
console.log('COORD-PINS ' + hit.map((c) => `${c.cx.toFixed(4)},${c.cy.toFixed(4)},${c.r}`).sort().join(' '));
const wirePaths = await page.$$eval('.canvas-wrap svg path[d]', (nodes) =>
  nodes.map((n) => (n as SVGPathElement).getAttribute('d') ?? '').filter((d) => d.startsWith('M')).sort(),
);
console.log('COORD-WIRES ' + wirePaths.join(' | '));

if (!COORDS_ONLY) {
  check(hit.length > 150, `interactive pin hit circles are present (${hit.length})`);
  check(wirePaths.length >= 4, `the fixture's wires are rendered (${wirePaths.length})`);

  // 1. visible without hovering: markers are painted, not near-transparent.
  const painted = circles.filter((c) => c.pe === 'none' && c.fill !== '' && !/0\.001/.test(c.fill));
  check(
    painted.length >= hit.length,
    `every pin paints a marker with no cursor over it (${painted.length} markers / ${hit.length} pins)`,
  );

  // 2. high-contrast outline ring.
  const ringed = circles.filter((c) => c.pe === 'none' && /^#(e6ebf1|ffffff|8fd0ff|3d9df2|f85149|3fb950)$/i.test(c.stroke));
  check(ringed.length >= hit.length, `markers carry a high-contrast outline ring (${ringed.length})`);

  // 3/6. type fills are distinguishable and use the existing tokens.
  const fills = new Set(circles.filter((c) => c.pe === 'none').map((c) => c.fill.toLowerCase()));
  for (const [label, colour] of [
    ['power 5V/VIN', '#f85149'],
    ['power 3V3', '#d29922'],
    ['ground', '#6b7885'],
    ['analog', '#3fb950'],
    ['digital', '#3d9df2'],
  ] as const) {
    check(fills.has(colour), `${label} pins use their own fill ${colour}`);
  }

  // 4. halo behind each marker.
  const halos = circles.filter((c) => c.pe === 'none' && c.fill === 'rgba(0,0,0,0.5)');
  check(halos.length >= hit.length, `every marker sits on a dark halo (${halos.length})`);

  // 6. connected pins read differently from free pins, without hovering.
  // The fixture's 4 wires land on 7 distinct pins — Uno A4 carries two of them.
  const connectedDots = circles.filter((c) => c.pe === 'none' && c.fill === '#0d1117');
  check(connectedDots.length === 7, `connected pins are marked (${connectedDots.length} pins for 4 wires)`);
  const whiteRings = circles.filter((c) => c.stroke === '#ffffff').length;
  check(whiteRings === 7, `connected pins take the connected ring colour (${whiteRings})`);

  // 8. the hit circle is untouched: same radii, still transparent and hittable.
  const radii = [...new Set(hit.map((c) => c.r))].sort((a, b) => a - b);
  check(radii.every((r) => r === 3.1 || r === 3.6), `hit circles keep their original radii (${radii.join(', ')})`);
  check(hit.every((c) => c.fill === 'rgba(255,255,255,0.001)'), 'hit circles stay transparent and hittable');
  // every marker stays inside the hit circle it sits under
  const spill = circles.filter((c) => c.pe === 'none' && c.r > 3.6);
  check(spill.length === 0, `no marker is drawn larger than its hit circle (${spill.length} oversized)`);

  // 5. hover is extra emphasis on top of the always-on marker. Aim at a real
  // hit circle (the markers themselves have pointer events off).
  const before = circles.filter((c) => c.stroke === '#8fd0ff').length;
  let after = 0;
  for (let i = 0; i < 8 && after === 0; i++) {
    const at = await page.evaluate((n) => {
      const els = [...document.querySelectorAll('.canvas-wrap svg circle')] as SVGCircleElement[];
      const hits = els.filter((e) => getComputedStyle(e).cursor === 'crosshair');
      const el = hits[n * 7];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, i);
    if (!at) break;
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(350);
    after = (await readCircles()).filter((c) => c.stroke === '#8fd0ff').length;
  }
  check(before === 0 && after > 0, `hover adds emphasis on top of the visible marker (${before} → ${after})`);
  await page.screenshot({ path: `${SCRATCH}/pins-after.png` });

  // 7. very low zoom drops the detail instead of adding clutter.
  await page.mouse.move(800, 500);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 240);
  await page.waitForTimeout(700);
  const out = await readCircles();
  check(
    out.filter((c) => c.fill === 'rgba(0,0,0,0.5)').length === 0,
    'zoomed far out the halo/ring detail is dropped',
  );
  check(
    out.some((c) => c.pe === 'none' && /^#[0-9a-f]{6}$/i.test(c.fill)),
    'zoomed far out each pin is still a plain colour dot',
  );
  await page.screenshot({ path: `${SCRATCH}/pins-zoomed-out.png` });

  const real = errors.filter((e) => !/favicon|DevTools|Download the React/.test(e));
  check(real.length === 0, `no console errors (${real.slice(0, 2).join(' | ').slice(0, 160) || 'none'})`);
  console.log(failures === 0 ? '\nAll pin visibility checks passed.' : `\n${failures} check(s) FAILED`);
}

await browser.close();
process.exit(COORDS_ONLY || failures === 0 ? 0 : 1);
