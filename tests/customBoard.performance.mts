// How long the custom-board paths take, measured rather than assumed.
//
// The thresholds here are deliberately loose — they are not a benchmark, they
// are a tripwire. What they catch is the class of mistake that does not look
// like a mistake: an O(n²) pin lookup that is fine for eight pins and awful for
// a hundred, a validator called once per render, a library scan that reparses
// every board to draw a list. Each of those ships silently and is discovered by
// a user with a big board.
//
// Every number printed is the real elapsed time on this machine, so a
// regression shows up as a number moving, not only as a failure.

import { validateCustomBoard, isError } from '../src/custom-boards/validate';
import { resolveCustomBoard, capabilitySummary } from '../src/custom-boards/resolve';
import { pinsFromCsv } from '../src/custom-boards/import';
import { parseCsv } from '../src/board-studio/studioStore';
import { libraryBoards, libraryEntryFor } from '../src/board-studio/boardLibrary';
import { embedBoard, embeddedBoards } from '../src/custom-boards/projectBoards';
import { normalizeProject } from '../src/project/projectService';
import { emptyProject } from '../src/project/templates';
import { getBoardBusProfile } from '../src/boards/busProfile';
import { validateProject } from '../src/validation/validator';
import { exportBoardBundle, importBoardBundle } from '../src/custom-boards/bundle';
import { CUSTOM_BOARD_SCHEMA_VERSION, type CustomBoardDefinition, type CustomBoardPin } from '../src/custom-boards/schema';
import type { CircuitProject, ComponentInstance, CustomDefinition } from '../src/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

/** Runs `fn` `times` and reports the mean, which is what a user experiences. */
function time(label: string, times: number, fn: () => void): number {
  fn(); // once to warm, so a first-call import cost is not measured as the cost
  const start = performance.now();
  for (let i = 0; i < times; i++) fn();
  const each = (performance.now() - start) / times;
  console.log(`   ${label}: ${each.toFixed(2)} ms`);
  return each;
}

/** A board with as many pins as a Mega, mapped to real pads. */
function bigBoard(pinCount: number): CustomBoardDefinition {
  const pads = Array.from({ length: 30 }, (_, i) => `GP${i}`);
  const pins: CustomBoardPin[] = Array.from({ length: pinCount }, (_, i) => ({
    id: `PIN_${i}`,
    label: `SIGNAL_${i}`,
    // Pads are reused past 30, which a real board cannot do — so only the first
    // 30 get one and the rest are unmapped, which is also realistic.
    pad: i < pads.length ? pads[i] : null,
    xMm: (i % 2) * 48,
    yMm: 2 + Math.floor(i / 2) * 2.54,
    type: 'digital',
    capabilities: [],
  }));
  return {
    schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
    id: 'custom.big-board',
    revision: 1,
    identity: { name: 'Big Board', creator: 'Bench' },
    outline: { widthMm: 50, heightMm: 4 + (pinCount / 2) * 2.54 },
    pins,
    processorProfileId: 'proc.rp2040',
    compileProfileId: 'compile.rp2040-arduino',
    runtimeProfileId: 'runtime.rp2040js',
  };
}

// ================================================= 1. validation and resolve =
section('1. a 100-pin board is validated and resolved on every keystroke');
{
  const board = bigBoard(100);
  const { problems } = validateCustomBoard(board);
  check(problems.filter(isError).length === 0, `the 100-pin board is valid${problems.filter(isError).map((p) => ` — ${p.message}`).join('')}`);

  // The Studio revalidates after every change, so this is a per-keystroke cost.
  const validateMs = time('validate 100 pins', 200, () => validateCustomBoard(board));
  check(validateMs < 10, `validation stays under 10 ms (${validateMs.toFixed(2)} ms)`);

  const resolveMs = time('resolve 100 pins', 200, () => resolveCustomBoard(board));
  check(resolveMs < 10, `and resolution under 10 ms (${resolveMs.toFixed(2)} ms)`);

  // The capability panel is redrawn with the draft, so it is on the same path.
  const capMs = time('capability summary', 200, () => capabilitySummary(board));
  check(capMs < 10, `as is the capability readout (${capMs.toFixed(2)} ms)`);

  // 256 pins is the schema limit; the limit has to be usable, not merely legal.
  const max = bigBoard(256);
  const maxMs = time('validate 256 pins (the schema limit)', 50, () => validateCustomBoard(max));
  check(maxMs < 30, `the largest legal board still validates quickly (${maxMs.toFixed(2)} ms)`);
}

// ===================================================== 2. importing a pin map
section('2. importing a hundred pins');
{
  const csv = ['label,processor_pin,type', ...Array.from({ length: 100 }, (_, i) => `SIGNAL_${i},GP${i % 30},digital`)].join('\n');
  const parseMs = time('parse a 100-row CSV', 100, () => parseCsv(csv));
  check(parseMs < 10, `parsing is under 10 ms (${parseMs.toFixed(2)} ms)`);

  const { headers, rows } = parseCsv(csv);
  const readMs = time('read 100 pins from it', 100, () => pinsFromCsv(headers, rows, 'proc.rp2040'));
  check(readMs < 25, `and reading them into pins under 25 ms (${readMs.toFixed(2)} ms)`);

  const result = pinsFromCsv(headers, rows, 'proc.rp2040');
  check(result.pins.length === 100, `all hundred arrive (${result.pins.length})`);
}

// ====================================================== 3. bus profile & rules
section('3. board-aware validation on a board with a hundred pins');
{
  const { board } = resolveCustomBoard(bigBoard(100));
  const profileMs = time('build the bus profile', 200, () => getBoardBusProfile(board));
  check(profileMs < 10, `the bus profile is built in under 10 ms (${profileMs.toFixed(2)} ms)`);

  // The whole validator runs on every edit to the circuit.
  const project = emptyProject('perf');
  embedBoard(project, bigBoard(100));
  project.boardInstances.push({
    id: 'b1', definitionId: 'custom.big-board', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  } as ComponentInstance);
  project.componentInstances.push({
    id: 'lcd', definitionId: 'comp.lcd1602', x: 300, y: 0, rotation: 0, properties: {}, simulationState: {},
  } as ComponentInstance);
  project.connections.push({
    id: 'w1', sourceComponentId: 'lcd', sourcePinId: 'sda', targetComponentId: 'b1', targetPinId: 'PIN_4',
    netId: '', color: '#888', points: [], routing: 'smooth',
  } as CircuitProject['connections'][number]);

  const validateMs = time('validate the whole circuit', 50, () => validateProject(project));
  check(validateMs < 120, `a full circuit validation stays under 120 ms (${validateMs.toFixed(2)} ms)`);
}

// ============================================== 4. ten instances of one board
section('4. ten instances of one custom board in one project');
{
  const project = emptyProject('ten');
  embedBoard(project, bigBoard(40));
  for (let i = 0; i < 10; i++) {
    project.boardInstances.push({
      id: `b${i}`, definitionId: 'custom.big-board', x: i * 100, y: 0, rotation: 0, properties: {}, simulationState: {},
    } as ComponentInstance);
  }
  check(project.customDefinitions.length === 1, 'ten instances share ONE definition, which is the point of an instance');

  const saved = JSON.stringify(project);
  console.log(`   project on disk: ${Math.round(saved.length / 1024)} KB`);
  check(saved.length < 200_000, `and the file stays small (${Math.round(saved.length / 1024)} KB)`);

  const openMs = time('open a 10-instance project', 20, () => normalizeProject(JSON.parse(saved)));
  check(openMs < 150, `opening it stays under 150 ms (${openMs.toFixed(2)} ms)`);
  check(embeddedBoards(normalizeProject(JSON.parse(saved))).size === 1, 'and it still carries exactly one board definition');
}

// ================================================ 5. a library of many boards
section('5. a library with two hundred boards in it');
{
  const entries: CustomDefinition[] = [];
  for (let i = 0; i < 200; i++) {
    const { entry } = libraryEntryFor({ ...bigBoard(20), id: `custom.board-${i}`, identity: { name: `Board ${i}` } });
    if (entry) entries.push(entry);
  }
  check(entries.length === 200, `two hundred boards are stored (${entries.length})`);

  const listMs = time('list the library', 20, () => libraryBoards(entries));
  check(listMs < 400, `listing it stays under 400 ms (${listMs.toFixed(2)} ms)`);
  check(libraryBoards(entries).length === 200, 'and every board comes back');
}

// ================================================== 6. board files in and out
section('6. exporting and opening a board file');
{
  const board = bigBoard(100);
  const exportMs = time('export a 100-pin board', 100, () => exportBoardBundle(board));
  check(exportMs < 15, `exporting is under 15 ms (${exportMs.toFixed(2)} ms)`);

  const { json } = exportBoardBundle(board);
  console.log(`   board file: ${Math.round(json.length / 1024)} KB`);
  const importMs = time('open it again', 100, () => importBoardBundle(json));
  check(importMs < 25, `and opening it under 25 ms (${importMs.toFixed(2)} ms)`);
}

console.log(failures === 0 ? '\nCustom-board performance checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
