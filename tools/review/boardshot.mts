// A picture of a board CircuitDesk generated for itself.
//
// A custom board with no artwork is drawn from its own facts — outline,
// silkscreen edge, mounting holes, a chip package, the pin labels the maker
// gave and the board's name. That drawing is the first thing a person sees
// after importing their board, and nothing in the test suite looks at it, so
// this renders one at the canvas's own scale for a human to check.
//
// Usage: npx tsx tools/review/boardshot.mts [out.png]

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { CustomBoardArtwork } from '../../src/boards/artwork/CustomBoardArtwork';
import { resolveCustomBoard } from '../../src/custom-boards/resolve';
import { CUSTOM_BOARD_SCHEMA_VERSION, type CustomBoardDefinition, type CustomBoardPin } from '../../src/custom-boards/schema';
import { UNITS_PER_MM } from '../../src/types';

const pin = (
  id: string, label: string, pad: string | null, xMm: number, yMm: number,
  type: CustomBoardPin['type'] = 'digital',
): CustomBoardPin => ({ id, label, pad, xMm, yMm, type, capabilities: [] });

const BOARD: CustomBoardDefinition = {
  schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
  id: 'custom.orchard-node',
  revision: 2,
  identity: { name: 'Orchard Node', creator: 'Fieldwork Instruments' },
  outline: { widthMm: 34, heightMm: 52, color: '#2f4a2f' },
  pins: [
    pin('BATT', 'BATT', null, 3, 5, 'power-5v'),
    pin('GND', 'GND', null, 3, 10, 'ground'),
    pin('VALVE', 'VALVE', 'GP15', 3, 15),
    pin('FLOW', 'FLOW', 'GP16', 3, 20),
    pin('AUX', 'AUX', 'GP17', 3, 25),
    pin('PROBE_SDA', 'PROBE_SDA', 'GP4', 31, 15),
    pin('PROBE_SCL', 'PROBE_SCL', 'GP5', 31, 20),
    pin('MOISTURE', 'MOISTURE', 'GP26', 31, 25, 'analog'),
  ],
  processorProfileId: 'proc.rp2040',
  compileProfileId: 'compile.rp2040-arduino',
  runtimeProfileId: 'runtime.rp2040js',
};

/** A wider board, where the package does fit between the two headers. */
const WIDE: CustomBoardDefinition = {
  ...BOARD,
  id: 'custom.gantry',
  identity: { name: 'Gantry Controller', creator: 'Fieldwork Instruments' },
  outline: { widthMm: 68, heightMm: 52, color: '#3b2f4f' },
  pins: [
    pin('V5', '5V', null, 3, 6, 'power-5v'),
    pin('GND', 'GND', null, 3, 12, 'ground'),
    pin('STEP_X', 'STEP_X', 'GP2', 3, 18),
    pin('STEP_Y', 'STEP_Y', 'GP3', 3, 24),
    pin('DIR_X', 'DIR_X', 'GP4', 65, 6),
    pin('DIR_Y', 'DIR_Y', 'GP5', 65, 12),
    pin('PROBE', 'PROBE', 'GP26', 65, 18, 'analog'),
    pin('LIMIT', 'LIMIT', 'GP6', 65, 24),
  ],
};

/** And one with no chip on it at all. */
const PASSIVE: CustomBoardDefinition = {
  ...BOARD,
  id: 'custom.breakout',
  identity: { name: 'Thermocouple Breakout' },
  outline: { widthMm: 22, heightMm: 18, color: '#5a4a2a' },
  pins: [
    pin('V3', '3V3', null, 3, 4, 'power-3v3'),
    pin('GND', 'GND', null, 3, 9, 'ground'),
    pin('SO', 'SO', null, 3, 14),
    pin('CS', 'CS', null, 19, 4),
    pin('SCK', 'SCK', null, 19, 9),
  ],
  processorProfileId: null,
  compileProfileId: 'compile.none',
  runtimeProfileId: 'runtime.none',
};

const WHICH = (process.argv[3] ?? 'tall') as 'tall' | 'wide' | 'passive';
const SOURCE = WHICH === 'wide' ? WIDE : WHICH === 'passive' ? PASSIVE : BOARD;

const out = process.argv[2] ?? 'tests/.artifacts/custom-board.png';
const { board } = resolveCustomBoard(SOURCE);
const W = board.widthMm * UNITS_PER_MM;
const H = board.heightMm * UNITS_PER_MM;
const inner = renderToStaticMarkup(createElement(CustomBoardArtwork, { def: board }));
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W + 8}" height="${H + 10}" viewBox="-4 -4 ${W + 8} ${H + 10}">` +
  `<rect x="-4" y="-4" width="${W + 8}" height="${H + 10}" fill="#12161b"/>${inner}</svg>`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
// deviceScaleFactor 1: the size a user actually sees it at, not a flattering one.
const page = await browser.newPage({
  viewport: { width: Math.ceil(W + 8), height: Math.ceil(H + 10) },
  deviceScaleFactor: 1,
});
await page.setContent(`<body style="margin:0;background:#12161b">${svg}</body>`);
await page.screenshot({ path: out });
await browser.close();
await writeFile(out.replace(/\.png$/, '.svg'), svg);
console.log(`${board.name}: ${board.widthMm}×${board.heightMm} mm → ${Math.round(W)}×${Math.round(H)} px at 1:1 — ${out}`);
