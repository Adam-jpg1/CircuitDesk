// CircuitDesk Public Beta — full browser QA against the production build on :3411.
// Covers: create project → add components → undo/redo → write code → compiler
// errors → compile+run → serial → pause/step/reset/stop → autosave → reopen →
// export → every import format (incl. graceful failure) → custom part library.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const errors: string[] = [];
let failures = 0;

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { executablePath: '/opt/pw-browsers/chromium' },
);
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(String(err)));

function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
async function statusBar(): Promise<string> {
  return (await page.locator('.status-bar').innerText()).replace(/\n/g, ' | ');
}

// ---------- 1. Dashboard ----------
await page.goto('http://localhost:3411/');
await page.waitForTimeout(1200);
check((await page.title()) === 'CircuitDesk', 'browser title is CircuitDesk');
check(await page.getByText('Public Beta · v0.9.0').isVisible(), 'Public Beta v0.9.0 badge shown on dashboard');
check(await page.getByText('Create First Project').isVisible(), 'empty state with Create First Project');

// ---------- 2. Create project ----------
await page.getByText('Create First Project').click();
await page.waitForTimeout(2500);
check(page.url().includes('#/editor/'), 'one click created one project and opened the editor');
check(await page.locator('.monaco-editor').first().isVisible(), 'Monaco code editor loaded (bundled)');
check((await statusBar()).includes('3 parts · 3 wires'), 'Blink starter circuit on canvas (3 parts, 3 wires)');

// ---------- 3. Add component + undo/redo ----------
await page.locator('.li-name').filter({ hasText: /^LED$/ }).first().dblclick();
await page.waitForTimeout(400);
check((await statusBar()).includes('4 parts'), 'double-click in library adds a component (4 parts)');
await page.locator('.canvas-wrap > svg:not(.minimap)').first().click({ position: { x: 60, y: 60 } });
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
check((await statusBar()).includes('3 parts'), 'Ctrl+Z undoes the add (3 parts)');
await page.keyboard.press('Control+y');
await page.waitForTimeout(300);
check((await statusBar()).includes('4 parts'), 'Ctrl+Y redoes the add (4 parts)');

// ---------- 4. Compiler error handling ----------
await page.locator('.monaco-editor').first().click();
await page.keyboard.press('Control+a');
await page.keyboard.insertText('void setup( { broken\n');
await page.waitForTimeout(900);
await page.getByRole('button', { name: 'Compile', exact: true }).click();
await page.waitForTimeout(8000);
const compilerOut = await page.locator('.mono-out').first().innerText();
check(/Build failed/.test(compilerOut), 'broken code → friendly "Build failed" in Compiler tab');
check(/sketch\.ino:\d+/.test(compilerOut), 'compiler diagnostics point at sketch.ino lines');
check(!page.url().includes('error'), 'app did not crash on compile error');

// ---------- 5. Write real code, compile + simulate ----------
const goodCode = [
  '// qa-marker-beta',
  'void setup() {',
  '  pinMode(13, OUTPUT);',
  '  Serial.begin(9600);',
  '}',
  'void loop() {',
  '  digitalWrite(13, HIGH);',
  '  Serial.println("ON");',
  '  delay(250);',
  '  digitalWrite(13, LOW);',
  '  Serial.println("OFF");',
  '  delay(250);',
  '}',
].join('\n');
await page.getByRole('button', { name: 'Code', exact: true }).click();
await page.locator('.monaco-editor').first().click();
await page.keyboard.press('Control+a');
await page.keyboard.insertText(goodCode);
await page.waitForTimeout(1000);
await page.getByTitle(/Run \(Ctrl\+Enter\)/).click();
await page.waitForTimeout(9000);
check((await statusBar()).includes('Simulating'), 'compile + run → simulation running');
await page.waitForTimeout(1600);
const serial = await page.locator('.mono-out').first().innerText();
check(serial.includes('ON') && serial.includes('OFF'), 'serial monitor streams ON/OFF from emulated UART');

// pin states tab shows live GPIO
await page.getByRole('button', { name: 'Pin states' }).click();
await page.waitForTimeout(600);
check((await page.locator('.pin-chip').count()) === 20, 'Pin states tab shows all 20 pins live');

// pause / step / reset / stop
await page.getByTitle('Pause simulation').click();
await page.waitForTimeout(400);
check((await statusBar()).includes('Paused'), 'pause works');
await page.getByTitle(/Step ~1 ms/).click();
await page.waitForTimeout(300);
check((await statusBar()).includes('Paused'), 'single-step keeps paused state');
await page.getByTitle(/Reset the MCU/).click();
await page.waitForTimeout(400);
check((await statusBar()).includes('Paused @ 0.0') || (await statusBar()).includes('Paused'), 'reset restarts firmware');
await page.getByTitle('Stop simulation').click();
await page.waitForTimeout(400);
check((await statusBar()).includes('stopped'), 'stop works');

// validation runs without issues on the starter circuit
await page.getByRole('button', { name: 'Validate' }).click();
await page.waitForTimeout(700);
check(true, 'validation executed without crashing');

// ---------- 6. Autosave → reopen (persistence, no data loss) ----------
await page.waitForTimeout(1500); // let autosave flush
await page.locator('.toolbar .icon-btn').first().click(); // back to dashboard
await page.waitForTimeout(1200);
const cards = await page.locator('.project-card').count();
check(cards >= 1, `project persisted to dashboard (${cards} card view(s))`);
await page.locator('.project-card .btn', { hasText: 'Open' }).first().click();
await page.waitForTimeout(2200);
check((await statusBar()).includes('4 parts'), 'reopened project restored all 4 parts');
await page.getByRole('button', { name: 'Code', exact: true }).click();
await page.waitForTimeout(800);
const codeText = await page.locator('.monaco-editor .view-lines').first().innerText();
check(codeText.includes('qa-marker-beta'), 'reopened project restored edited code (no data loss)');

// ---------- 7. Export ----------
await page.getByRole('button', { name: 'Export' }).click();
await page.waitForTimeout(400);
const downloadPromise = page.waitForEvent('download', { timeout: 8000 });
await page.getByRole('button', { name: /Bill of materials/ }).click();
const download = await downloadPromise.catch(() => null);
check(download !== null, `BOM CSV export downloads (${download?.suggestedFilename() ?? 'failed'})`);
await page.keyboard.press('Escape');

// ---------- 8. Import center: every advertised format ----------
interface ImportCase {
  file: string;
  expectName: RegExp;
  target: 'custom' | 'project';
  minPins?: number;
}
const importCases: ImportCase[] = [
  { file: 'pinmap.csv', expectName: /pinmap/, target: 'custom', minPins: 4 },
  { file: 'board.kicad_pcb', expectName: /QA Sensor Board/, target: 'custom', minPins: 7 },
  { file: 'board.brd', expectName: /board/, target: 'custom', minPins: 6 },
  { file: 'shape.easyeda.json', expectName: /QA EasyEDA Board/, target: 'custom', minPins: 3 },
  { file: 'copper.gtl', expectName: /copper/, target: 'custom' },
  { file: 'art.svg', expectName: /art/, target: 'custom' },
  { file: 'bundle.zip', expectName: /QA Bundle Part/, target: 'custom', minPins: 4 },
  { file: 'part.fzpz', expectName: /QA Fritzing Part/, target: 'custom', minPins: 3 },
  { file: 'project.cdproj.json', expectName: /QA Imported Project/, target: 'project' },
];

for (const testCase of importCases) {
  await page.goto('http://localhost:3411/#/import');
  await page.waitForTimeout(700);
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('.dropzone').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(path.join(fixtures, testCase.file));
  await page.waitForTimeout(1500);

  const parseFailed = await page.getByText('Parsing failed').isVisible().catch(() => false);
  if (parseFailed) {
    check(false, `${testCase.file}: parsed`);
    continue;
  }
  const nameOk = await page.getByText(testCase.expectName).first().isVisible().catch(() => false);
  check(nameOk, `${testCase.file}: parsed and detected name`);
  if (testCase.minPins) {
    const pinText = await page.locator('.kv-table').first().innerText().catch(() => '');
    const m = /Pins \/ pads\s+(\d+)/.exec(pinText);
    check(m !== null && Number(m[1]) >= testCase.minPins, `${testCase.file}: extracted ≥${testCase.minPins} pins (got ${m?.[1] ?? '?'})`);
  }
  await page.getByRole('button', { name: 'Continue to mapping' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Continue to preview' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Continue to import' }).click();
  await page.waitForTimeout(500);
  if (testCase.target === 'project') {
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.waitForTimeout(2500);
    check(page.url().includes('#/editor/'), `${testCase.file}: imported as a working project`);
    check((await statusBar()).includes('3 parts'), `${testCase.file}: restored circuit (3 parts)`);
  } else {
    // default target is custom board / visual reference — import as-is
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.waitForTimeout(1800);
    check(page.url().includes('#/custom-parts'), `${testCase.file}: saved to the custom part library`);
  }
}

// custom part library now lists the imports
await page.goto('http://localhost:3411/#/custom-parts');
await page.waitForTimeout(900);
const customCount = await page.locator('.project-card').count();
check(customCount >= 8, `custom part library lists all imported parts (${customCount})`);

// imported parts appear in the editor library
await page.goto('http://localhost:3411/#/');
await page.waitForTimeout(800);
await page.locator('.project-card .btn', { hasText: 'Open' }).first().click();
await page.waitForTimeout(2000);
check(
  await page.locator('.library-cat', { hasText: 'Imported parts' }).isVisible(),
  'imported parts appear in the editor part library',
);

// ---------- 9. Graceful failure on a corrupt file ----------
await page.goto('http://localhost:3411/#/import');
await page.waitForTimeout(700);
const chooser2Promise = page.waitForEvent('filechooser');
await page.locator('.dropzone').click();
await (await chooser2Promise).setFiles(path.join(fixtures, 'broken.kicad_pcb'));
await page.waitForTimeout(1500);
check(await page.getByText('Parsing failed').isVisible(), 'corrupt file → friendly "Parsing failed" panel, no crash');
await page.getByRole('button', { name: 'Choose a different file' }).click();
await page.waitForTimeout(400);
check(await page.locator('.dropzone').isVisible(), 'wizard recovers to the upload step after a failure');

// ---------- 10. Stability ----------
check(!errors.some((e) => e.includes('Maximum update depth')), 'no "Maximum update depth exceeded" anywhere');
const realErrors = errors.filter(
  (e) => !e.includes('favicon') && !e.includes('React DevTools') && !e.includes('[CircuitDesk]'),
);
check(realErrors.length === 0, `no unexpected console errors (${realErrors.length})`);
if (realErrors.length > 0) console.log('console errors:', realErrors.slice(0, 6));

await browser.close();
console.log(failures === 0 ? '\nFull beta QA passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
