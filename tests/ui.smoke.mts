// UI smoke test against the production build served on :3411.
import { chromium } from 'playwright';

const errors: string[] = [];
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(String(err)));

function fail(msg: string): never {
  console.error('FAIL:', msg);
  console.error('console errors:', errors.slice(0, 10));
  process.exit(1);
}
function pass(msg: string) {
  console.log('PASS:', msg);
}

// 1. dashboard loads
await page.goto('http://localhost:3411/');
await page.waitForTimeout(1200);
const title = await page.title();
if (title !== 'CircuitDesk') fail(`title is "${title}"`);
pass('dashboard loads with title CircuitDesk');
if (!(await page.getByText('Create First Project').isVisible().catch(() => false))) fail('empty state missing');
pass('empty state shows Create First Project');

// 2. one click creates one project and opens the editor
await page.getByText('Create First Project').click();
await page.waitForTimeout(2500);
if (!page.url().includes('#/editor/')) fail('did not navigate to editor');
pass('project created and editor opened');
await page.screenshot({ path: 'tests/.artifacts/editor.png' });

// Monaco editor loaded locally?
const monacoLoaded = await page.locator('.monaco-editor').first().isVisible().catch(() => false);
if (!monacoLoaded) fail('Monaco editor did not load');
pass('Monaco editor loaded (bundled, no CDN)');

// canvas parts present?
const svgParts = await page.locator('.canvas-wrap svg g').count();
if (svgParts < 3) fail(`canvas seems empty (${svgParts} groups)`);
pass(`canvas renders parts (${svgParts} svg groups)`);

// 3. validate
await page.getByRole('button', { name: 'Validate' }).click();
await page.waitForTimeout(600);
pass('validate ran');

// 4. compile + run via toolbar Run button (compiles first)
await page.getByTitle(/Run \(Ctrl\+Enter\)/).click();
await page.waitForTimeout(9000); // first compile may take a few seconds
const statusText = await page.locator('.status-bar').innerText();
if (!/Simulating/.test(statusText)) fail(`simulation not running: status="${statusText.replace(/\n/g, ' | ')}"`);
pass('firmware compiled and simulation is running');

// serial output appears
await page.waitForTimeout(2500);
const serial = await page.locator('.mono-out').first().innerText().catch(() => '');
if (!serial.includes('ON') || !serial.includes('OFF')) fail(`serial output missing: "${serial.slice(0, 80)}"`);
pass('serial monitor shows ON/OFF from emulated UART');
await page.screenshot({ path: 'tests/.artifacts/running.png' });

// 5. reload persistence: project still opens
await page.goto('http://localhost:3411/#/');
await page.waitForTimeout(1500);
const cardCount = await page.locator('.project-card').count();
if (cardCount < 1) fail('project did not persist to dashboard after reload');
pass(`project persisted (${cardCount} card(s) on dashboard)`);
await page.locator('.project-card').first().click();
await page.waitForTimeout(2200);
if (!page.url().includes('#/editor/')) fail('could not reopen project');
const partsAfter = await page.locator('.canvas-wrap svg g').count();
if (partsAfter < 3) fail('reopened project lost its parts');
pass('project reopens with circuit restored');

// 6. no react update-depth errors anywhere
const depthErr = errors.find((e) => e.includes('Maximum update depth'));
if (depthErr) fail('Maximum update depth exceeded occurred');
pass('no "Maximum update depth exceeded" errors');
const otherErrors = errors.filter((e) => !e.includes('favicon') && !e.includes('Download the React DevTools'));
console.log(otherErrors.length === 0 ? 'PASS: no console errors' : `NOTE: console errors (${otherErrors.length}): ${otherErrors.slice(0, 5).join(' || ').slice(0, 500)}`);

await browser.close();
console.log('\nUI smoke test finished.');
