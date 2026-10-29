// A circuit with no board, in the real app: it is live without pressing Run,
// and the last wire can be dropped on a part near a pin — it snaps.
//
// The project is a 9 V battery, a 330 Ω resistor and an LED with the LED's
// return wire missing. The LED must be dark until that wire is drawn, then
// light the moment it is, with no board and no Run.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { emptyProject } from '../src/project/templates';
import type { CircuitProject } from '../src/types';

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(ok ? 'PASS:' : 'FAIL:', msg);
  if (!ok) failures++;
};

const project: CircuitProject = emptyProject('Battery LED');
const part = (id: string, definitionId: string, x: number, y: number, properties: Record<string, unknown> = {}) => {
  project.componentInstances.push({ id, definitionId, x, y, rotation: 0, properties, simulationState: {} });
};
part('bat', 'comp.battery-9v', 100, 120);
part('res', 'comp.resistor', 260, 80, { resistance: 330 });
part('led', 'comp.led', 360, 140, { color: 'red' });
const wire = (id: string, a: string, ap: string, b: string, bp: string) =>
  project.connections.push({
    id, sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
    netId: '', color: '#e5534b', points: [], routing: 'smooth',
  } as CircuitProject['connections'][number]);
wire('w1', 'bat', 'plus', 'res', 'p1');
wire('w2', 'res', 'p2', 'led', 'anode');
const fixture = `${process.env.SCRATCH ?? '/tmp'}/boardless-${Date.now()}.cdproj.json`;
writeFileSync(fixture, JSON.stringify({ app: 'CircuitDesk', kind: 'circuitdesk-project', ...project }));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://localhost:3411/#/import', { waitUntil: 'load' });
await page.waitForTimeout(1200);
const chooser = page.waitForEvent('filechooser');
await page.locator('.dropzone').click();
(await chooser).setFiles(fixture);
await page.waitForTimeout(1500);
for (let step = 0; step < 5; step++) {
  const importBtn = page.getByRole('button', { name: 'Import', exact: true });
  if (await importBtn.isVisible().catch(() => false)) {
    await importBtn.click();
    break;
  }
  const cont = page.getByRole('button', { name: /^Continue/ }).first();
  if (!(await cont.isVisible().catch(() => false))) break;
  await cont.click();
  await page.waitForTimeout(600);
}
await page.waitForTimeout(2500);
if (!page.url().includes('#/editor/')) {
  await page.goto('http://localhost:3411/#/', { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.locator('.project-card').first().click();
  await page.waitForTimeout(2000);
}
check(page.url().includes('#/editor/'), 'the battery circuit opened in the editor');

const lit = () => page.locator('[data-part-id] [data-lit]').first().getAttribute('data-lit');
check((await lit()) === 'false', 'with the return wire missing, the LED is dark');

// Wire tool, from the battery's minus terminal.
await page.keyboard.press('w');
const pinBox = async (partId: string, pinId: string) =>
  (await page.locator(`.canvas-wrap [data-part-id="${partId}"] [data-pin-id="${pinId}"]`).boundingBox())!;
const minus = await pinBox('bat', 'minus');
await page.mouse.click(minus.x + minus.width / 2, minus.y + minus.height / 2);
await page.waitForTimeout(200);

// Out in the open the free end dangles.
await page.mouse.move(700, 600);
await page.waitForTimeout(150);
check(await page.locator('[data-wire-end="dangling"]').isVisible(), 'away from any pin, the free end shows as dangling');

// Over the LED's leg, a few pixels from its cathode pin: snaps.
const cathode = await pinBox('led', 'cathode');
const near = { x: cathode.x + cathode.width / 2, y: cathode.y + cathode.height / 2 - 10 };
await page.mouse.move(near.x, near.y);
await page.waitForTimeout(150);
check(await page.locator('[data-wire-end="snapped"]').isVisible(), 'near the cathode, the end snaps to it and shows green');
await page.mouse.click(near.x, near.y);
await page.waitForTimeout(400);
check((await page.locator('.canvas-wrap [data-connection-id]').count()) === 3, 'a click on the LED near its pin makes the connection');
await page.waitForTimeout(400);
check((await lit()) === 'true', 'and the LED lights — no board, no Run');

// Run with no board.
await page.getByTitle(/^Run \(Ctrl\+Enter\)/).click();
await page.waitForTimeout(800);
const statusText = await page.locator('.status-bar').innerText();
check(/Simulating|Running/i.test(statusText), `Run on a board-less canvas runs it (${statusText.replace(/\n/g, ' | ').slice(0, 160)})`);
check((await lit()) === 'true', 'and the LED stays lit');
await page.getByTitle('Stop simulation').click();
await page.waitForTimeout(400);
check((await lit()) === 'true', 'stopped, the circuit is still live');

check(errors.length === 0, `no page errors (${errors.slice(0, 2).join(' | ')})`);
await browser.close();
console.log(`\n--- ${failures} failing`);
process.exit(failures ? 1 : 0);
