// Somebody actually using the Board Studio, in a browser.
//
// The flow test covers the rules; this covers whether a person can reach them.
// A rule that is enforced in a store nobody can drive is not enforced, and the
// specific failures this is here to catch are UI ones:
//
//   * the capability readout must be visible and must CHANGE as choices are
//     made, because "watch wiring-only become simulated" is the whole way a
//     user learns what the chip is for;
//   * a CSV dropped into the pins step must produce pins on screen, and the
//     rows it could not read must be listed, not summarised away;
//   * the processor must be a choice with the chip's limits printed on it,
//     with the imported suggestion offered and applied by nobody;
//   * artwork that is not a drawing must be visibly refused;
//   * "Add to this project" must put a real, resolvable board on the canvas.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

const PORT = 5199;
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
vite.stdout.on('data', (d) => (log += d));
vite.stderr.on('data', (d) => (log += d));

try {
  for (let i = 0; ; i++) {
    if (i > 60) throw new Error(`vite did not start:\n${log}`);
    try {
      if ((await fetch(`http://localhost:${PORT}/tools/review/boardstudio.html`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/tools/review/boardstudio.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="board-studio"]');

  const draft = () =>
    page.evaluate(() => {
      const s = (window as unknown as { studio: { getState(): { draft: unknown } } }).studio;
      return JSON.parse(JSON.stringify(s.getState().draft));
    }) as Promise<{
      identity: { name: string };
      outline: { widthMm: number; heightMm: number; artworkSvg?: string };
      pins: { id: string; label: string; pad: string | null; xMm: number; yMm: number }[];
      processorProfileId: string | null;
      compileProfileId: string;
      runtimeProfileId: string;
    }>;

  // ============================================= 1. the studio is usable ====
  section('1. it opens on a board and shows what that board can do');
  {
    check(await page.isVisible('[data-testid="studio-capability"]'), 'the capability panel is on screen from the start');
    const level = await page.textContent('[data-testid="studio-capability-level"]');
    check(level?.trim() === 'Wiring only', `and a new board reads "Wiring only" (${level?.trim()})`);
    check(await page.isVisible('[data-testid="studio-step-identity"]'), 'the steps are listed');
    check(!(await page.isVisible('[data-testid="studio-step-pipeline"]')), 'and simple mode does not show the pipeline step');
    await page.click('[data-testid="studio-mode-advanced"]');
    check(await page.isVisible('[data-testid="studio-step-pipeline"]'), 'advanced mode does');
    await page.click('[data-testid="studio-mode-simple"]');
  }

  // ================================================= 2. naming and sizing ===
  section('2. the questions are the ones a person can answer');
  {
    await page.click('[data-testid="studio-step-identity"]');
    await page.fill('[data-testid="studio-name"]', 'Greenhouse Controller');
    await page.click('[data-testid="studio-step-outline"]');
    await page.fill('[data-testid="studio-width"]', '42');
    await page.fill('[data-testid="studio-height"]', '58');
    const d = await draft();
    check(d.identity.name === 'Greenhouse Controller', `the name is taken (${d.identity.name})`);
    check(d.outline.widthMm === 42 && d.outline.heightMm === 58, `and the size (${d.outline.widthMm}×${d.outline.heightMm})`);
    check(
      (await page.textContent('.studio-head p'))?.includes('Greenhouse Controller') === true,
      'and the header follows the name, so it is clear which board is being edited',
    );
  }

  // ====================================== 3. the chip is a real decision ====
  section('3. the processor is chosen, never assumed');
  {
    await page.click('[data-testid="studio-step-processor"]');
    const body = (await page.textContent('[data-testid="studio-pane-processor"]')) ?? '';
    check(/does not guess the chip/i.test(body), 'the step says that CircuitDesk does not guess it');
    check(/PIO/.test(body), 'and each chip is offered with what is NOT modelled about it');
    check(
      /breakout|shield|passive/i.test(body),
      'with "no processor" offered as a real kind of board rather than a refusal',
    );

    await page.click('[data-testid="studio-processor-proc.rp2040"]');
    const d = await draft();
    check(d.processorProfileId === 'proc.rp2040', 'choosing the RP2040 sets it');
    check(d.compileProfileId === 'compile.rp2040-arduino', 'and its toolchain follows');
    check(d.runtimeProfileId === 'runtime.rp2040js', 'and its runtime');
    const level = await page.textContent('[data-testid="studio-capability-level"]');
    check(level?.trim() === 'Simulated', `and the capability readout changes to "Simulated" (${level?.trim()})`);
  }

  // ============================================ 4. importing a pin map ======
  section('4. a pin map goes in, and what could not be read is shown');
  {
    await page.click('[data-testid="studio-step-pins"]');
    const csv = [
      'Pin Name,Processor Pin,Type',
      'VENT_SDA,GP4,digital',
      'VENT_SCL,GP5,digital',
      'PUMP,GP15,digital',
      'HEATER,GP16,digital',
      ',GP17,digital',
      'SOIL,GP26,analog',
      'GND,,ground',
    ].join('\n');
    await page.setInputFiles('[data-testid="studio-pane-pins"] input[type=file]', {
      name: 'pins.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv, 'utf8'),
    });
    await page.waitForSelector('[data-testid="studio-csv-summary"]');

    const summary = (await page.textContent('[data-testid="studio-csv-summary"]')) ?? '';
    check(/6 pin\(s\) read/.test(summary), `the readable pins are counted (${summary.trim()})`);
    check(await page.isVisible('[data-testid="studio-csv-errors"]'), 'and the unreadable row is shown, not summarised away');
    const badRows = (await page.textContent('[data-testid="studio-csv-errors"]')) ?? '';
    check(/Row 6/.test(badRows), `pointing at the row it was on (${badRows.replace(/\s+/g, ' ').trim().slice(0, 90)})`);

    const d = await draft();
    check(d.pins.length === 6, `six pins are in the draft (${d.pins.length})`);
    check(d.pins.find((p) => p.id === 'VENT_SDA')?.pad === 'GP4', 'with their pads');
    // The table's cells are inputs, so what a user sees is their values.
    const shown = await page.$$eval('[data-testid="studio-pin-table"] input', (els) =>
      els.map((e) => (e as HTMLInputElement).value));
    check(shown.includes('VENT_SDA'), `and they are on screen to be edited (${shown.slice(0, 4).join(', ')})`);
  }

  // ============================================ 5. a pad can be corrected ===
  section('5. a pad is a dropdown of pads the chip really has');
  {
    const options = await page.$$eval('[data-testid="studio-pad-PUMP"] option', (els) => els.map((e) => (e as HTMLOptionElement).value));
    check(options.includes('GP15'), 'the chip\'s pads are offered');
    check(!options.includes('PB5'), 'and another chip\'s are not');
    check(options.includes(''), 'with "not connected to the chip" available, because some pins are not');
    await page.selectOption('[data-testid="studio-pad-PUMP"]', 'GP14');
    check((await draft()).pins.find((p) => p.id === 'PUMP')?.pad === 'GP14', 'and changing it changes the pin');
    await page.selectOption('[data-testid="studio-pad-PUMP"]', 'GP15');
  }

  // ================================================= 6. placing the pins ====
  section('6. pins are placed by dragging them onto the board');
  {
    await page.click('[data-testid="studio-step-placement"]');
    await page.waitForSelector('[data-testid="pin-placement"]');
    const before = (await draft()).pins.find((p) => p.id === 'PUMP')!;

    const handle = page.locator('[data-testid="pin-placement"] g[data-pin="PUMP"]');
    const box = (await handle.boundingBox())!;
    const board = (await page.locator('[data-testid="pin-placement"]').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(board.x + board.width * 0.75, board.y + board.height * 0.5, { steps: 8 });
    await page.mouse.up();

    const after = (await draft()).pins.find((p) => p.id === 'PUMP')!;
    check(after.xMm !== before.xMm || after.yMm !== before.yMm, `the pin moved (${before.xMm},${before.yMm} → ${after.xMm},${after.yMm})`);
    check(after.xMm <= 42 && after.yMm <= 58, 'and stayed on the board');
    check(Math.abs(after.xMm / 2.54 - Math.round(after.xMm / 2.54)) < 0.001, `landing on the 2.54 mm grid (${after.xMm})`);
  }

  // ============================================= 7. artwork is refused ======
  section('7. artwork that is not a drawing is refused where the user can see it');
  {
    await page.click('[data-testid="studio-mode-advanced"]');
    await page.click('[data-testid="studio-step-artwork"]');
    await page.setInputFiles('[data-testid="studio-pane-artwork"] input[type=file]', {
      name: 'board.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="42mm" height="58mm"><script>fetch("//evil")</script><rect width="42" height="58" fill="#123"/></svg>',
        'utf8',
      ),
    });
    await page.waitForSelector('.studio-warn');
    const refusal = (await page.textContent('[data-testid="studio-pane-artwork"] .studio-warn')) ?? '';
    check(/refused/i.test(refusal), `the file is refused on screen (${refusal.slice(0, 80)})`);
    check(/script/i.test(refusal), 'saying what was in it');
    check((await draft()).outline.artworkSvg === undefined, 'and nothing was stored');

    // A drawing goes in.
    await page.setInputFiles('[data-testid="studio-pane-artwork"] input[type=file]', {
      name: 'board.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 42 58"><rect width="42" height="58" fill="#1c3d2a"/><circle cx="8" cy="8" r="2" fill="#ccc"/></svg>',
        'utf8',
      ),
    });
    await page.waitForFunction(() => {
      const s = (window as unknown as { studio: { getState(): { draft: { outline: { artworkSvg?: string } } | null } } }).studio;
      return Boolean(s.getState().draft?.outline.artworkSvg);
    });
    const art = (await draft()).outline.artworkSvg ?? '';
    check(art.includes('<rect'), 'a real drawing is kept');
    check(!art.includes('script'), 'with nothing executable in what was stored');
  }

  // ========================================== 8. the pipeline, and its FQBN ==
  section('8. advanced mode can change the pipeline and is told when it cannot work');
  {
    await page.click('[data-testid="studio-step-pipeline"]');
    await page.selectOption('[data-testid="studio-compile-profile"]', 'compile.avr-arduino');
    await page.waitForSelector('[data-testid="studio-mismatches"]');
    const text = (await page.textContent('[data-testid="studio-mismatches"]')) ?? '';
    check(/does not build for this processor/i.test(text), `the mismatch is named (${text.replace(/\s+/g, ' ').slice(0, 90)})`);
    const level = await page.textContent('[data-testid="studio-capability-level"]');
    check(level?.trim() === 'Wiring only', `and the board stops claiming it is simulated (${level?.trim()})`);
    await page.selectOption('[data-testid="studio-compile-profile"]', 'compile.rp2040-arduino');
    check(!(await page.isVisible('[data-testid="studio-mismatches"]')), 'putting it back clears the warning');
  }

  // ============================================ 9. onto the canvas ==========
  section('9. the board goes into the project as a real board');
  {
    await page.click('[data-testid="studio-step-review"]');
    const support = await page.textContent('[data-testid="studio-support-level"]');
    check(support?.trim() === 'simulated', `the review says what it is (${support?.trim()})`);

    await page.click('[data-testid="studio-add-to-project"]');
    await page.waitForSelector('[data-testid="studio-save-message"]');
    const placed = await page.evaluate(() => {
      const editor = (window as unknown as {
        editor: { getState(): { project: { boardInstances: { definitionId: string }[]; customDefinitions: { definition: { id: string; name: string; pins: unknown[] }; source?: string }[] } | null } };
      }).editor;
      const project = editor.getState().project!;
      return {
        instances: project.boardInstances.length,
        definitionId: project.boardInstances[0]?.definitionId ?? null,
        embedded: project.customDefinitions.map((c) => ({ id: c.definition.id, name: c.definition.name, pins: c.definition.pins.length, source: c.source })),
      };
    });
    check(placed.instances === 1, `one board instance is on the canvas (${placed.instances})`);
    check(placed.embedded.length === 1, 'and its definition travels in the project');
    check(placed.embedded[0]?.id === placed.definitionId, 'referenced by the id the instance uses');
    check(placed.embedded[0]?.name === 'Greenhouse Controller', `under its own name (${placed.embedded[0]?.name})`);
    check(placed.embedded[0]?.pins === 6, `with all six pins (${placed.embedded[0]?.pins})`);
  }

  // ================================ 10. an older project copy can be updated =
  section('10. the project is offered the newer revision, priced first');
  {
    await page.click('[data-testid="studio-step-review"]');
    check(
      await page.isVisible('[data-testid="studio-project-revision"]'),
      'while nothing has changed, the studio simply says which revision the project is on',
    );

    // Edit the board: drop a pin the project has a definition for.
    await page.click('[data-testid="studio-step-pins"]');
    const removeButtons = page.locator('[data-testid="studio-pin-table"] button');
    await removeButtons.last().click();
    await page.click('[data-testid="studio-step-review"]');
    await page.waitForSelector('[data-testid="studio-upgrade"]');

    const offer = (await page.textContent('[data-testid="studio-upgrade"]')) ?? '';
    check(/revision 1/.test(offer), `the offer names the revision the project is on (${offer.replace(/\s+/g, ' ').slice(0, 100)})`);
    check(/pin\(s\) go|nothing on the canvas is lost/.test(offer), 'and what updating would cost');

    await page.click('[data-testid="studio-upgrade-apply"]');
    await page.waitForFunction(() => {
      const editor = (window as unknown as { editor: { getState(): { project: { customDefinitions: { spec?: { revision: number } }[] } | null } } }).editor;
      return editor.getState().project?.customDefinitions[0]?.spec?.revision === 2;
    });
    const after = await page.evaluate(() => {
      const editor = (window as unknown as {
        editor: { getState(): { project: { customDefinitions: { spec?: { revision: number; pins: unknown[] } }[] } | null } };
      }).editor;
      const entry = editor.getState().project!.customDefinitions[0];
      return { revision: entry.spec?.revision, pins: entry.spec?.pins.length };
    });
    check(after.revision === 2, `the project is moved to revision 2 (${after.revision})`);
    check(after.pins === 5, `with the edited pin map (${after.pins})`);
  }

  // ============================================ 11. and it stays responsive ==
  section('11. the things a user does repeatedly are fast');
  {
    // Opening the Studio on a fresh board: the first thing anybody does.
    const openMs = await page.evaluate(() => {
      const s = (window as unknown as { studio: { getState(): { openNew(n: string): void } } }).studio;
      const start = performance.now();
      for (let i = 0; i < 20; i++) s.getState().openNew('Bench');
      return (performance.now() - start) / 20;
    });
    console.log(`   open the studio: ${openMs.toFixed(2)} ms`);
    check(openMs < 50, `opening is under 50 ms (${openMs.toFixed(2)} ms)`);

    // Sanitising artwork, on a drawing with a few thousand elements.
    const sanitizeMs = await page.evaluate(async () => {
      const mod = await import('/src/custom-boards/svgSanitize.ts');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${
        Array.from({ length: 3000 }, (_, i) => `<rect x="${i % 100}" y="${i % 50}" width="1" height="1" fill="#123"/>`).join('')
      }</svg>`;
      const start = performance.now();
      for (let i = 0; i < 5; i++) mod.sanitizeBoardSvg(svg);
      return (performance.now() - start) / 5;
    });
    console.log(`   sanitise a 3000-element SVG: ${sanitizeMs.toFixed(2)} ms`);
    check(sanitizeMs < 500, `artwork is checked in under half a second (${sanitizeMs.toFixed(2)} ms)`);

    // A hundred pins imported and then rendered in the placement editor, which
    // is the heaviest thing the Studio draws.
    const importMs = await page.evaluate(() => {
      const s = (window as unknown as { studio: { getState(): { openNew(n: string): void; setProcessor(id: string): void; importPinCsv(t: string): unknown } } }).studio;
      const csv = ['label,processor_pin', ...Array.from({ length: 100 }, (_, i) => `SIGNAL_${i},GP${i % 30}`)].join('\n');
      s.getState().openNew('Hundred');
      s.getState().setProcessor('proc.rp2040');
      const start = performance.now();
      s.getState().importPinCsv(csv);
      return performance.now() - start;
    });
    console.log(`   import 100 pins: ${importMs.toFixed(2)} ms`);
    check(importMs < 200, `a hundred pins go in under 200 ms (${importMs.toFixed(2)} ms)`);

    await page.click('[data-testid="studio-step-placement"]');
    await page.waitForSelector('[data-testid="pin-placement"] g[data-pin="SIGNAL_0"]');
    const drawn = await page.$$eval('[data-testid="pin-placement"] g[data-pin]', (els) => els.length);
    check(drawn === 100, `all hundred are drawn in the placement editor (${drawn})`);

    // Dragging one of them: the interaction that must not stutter.
    const dragMs = await page.evaluate(() => {
      const s = (window as unknown as { studio: { getState(): { movePin(id: string, x: number, y: number): void } } }).studio;
      const start = performance.now();
      for (let i = 0; i < 60; i++) s.getState().movePin('SIGNAL_0', 10 + (i % 20), 10 + (i % 30));
      return (performance.now() - start) / 60;
    });
    console.log(`   one drag step with 100 pins on screen: ${dragMs.toFixed(2)} ms`);
    check(dragMs < 16, `each drag step stays inside a frame (${dragMs.toFixed(2)} ms)`);
  }

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`);
  await browser.close();
} finally {
  vite.kill('SIGTERM');
}

console.log(failures === 0 ? '\nBoard Studio UI checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
