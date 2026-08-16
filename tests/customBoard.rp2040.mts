// A board CircuitDesk has never heard of, compiled and executed.
//
// This is the acceptance test for the whole milestone's premise: a user should
// not have to wait for CircuitDesk to add their board. The board here is not a
// Raspberry Pi Pico — different name, different outline, different pin count,
// different pin NAMES — and it is not a Pico in the code either: nothing about
// it borrows a Pico's identity at any point between the canvas and the CPU.
//
// What it does share is the chip. It names the RP2040 processor profile, the
// Arduino-Pico compile profile and the RP2040 runtime, so it gets real
// arduino-cli compilation to a real UF2 and real execution on rp2040js. The
// firmware is written against GP15 and GP16, because that is what firmware is
// written against; the canvas shows STATUS_LED and BUTTON, because that is what
// the maker printed on the board. Both identities are real and this proves
// they stay attached to each other.
//
// Skips cleanly without the RP2040 toolchain rather than pretending.

import { simulationController } from '../src/simulation/simulationController';
import { emptyProject } from '../src/project/templates';
import { normalizeProject } from '../src/project/projectService';
import { embedBoard, newCustomBoard } from '../src/custom-boards/projectBoards';
import { validateCustomBoard, isError } from '../src/custom-boards/validate';
import { resolveCustomBoard } from '../src/custom-boards/resolve';
import { resolveDefinition } from '../src/project/partsRegistry';
import { resolveWorkspaceTargets } from '../src/compiler/targets';
import { CUSTOM_BOARD_SCHEMA_VERSION, type CustomBoardDefinition } from '../src/custom-boards/schema';
import type { CircuitProject, ComponentInstance } from '../src/types';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function skip(msg: string) {
  console.log('SKIP:', msg);
  skipped++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

let seq = 0;
const uid = (p: string) => `${p}${++seq}`;

/** A board somebody designed. Deliberately unlike a Pico in every visible way. */
export const LAB_BOARD: CustomBoardDefinition = {
  schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
  id: 'custom.rp2040-lab-board',
  revision: 1,
  identity: {
    name: 'RP2040 Lab Board',
    creator: 'Lab Systems',
    description: 'A test-rig controller built around an RP2040.',
  },
  outline: { widthMm: 34, heightMm: 46, color: '#123f5e' },
  pins: [
    { id: 'VSYS', label: 'VSYS', pad: null, xMm: 3, yMm: 5, type: 'power-5v', capabilities: [], voltage: 5 },
    { id: 'GND', label: 'GND', pad: null, xMm: 3, yMm: 11, type: 'ground', capabilities: [] },
    { id: 'V3', label: '3V3', pad: null, xMm: 3, yMm: 17, type: 'power-3v3', capabilities: [], voltage: 3.3 },
    { id: 'STATUS_LED', label: 'STATUS', pad: 'GP15', xMm: 3, yMm: 23, type: 'digital', capabilities: [] },
    { id: 'BUTTON', label: 'BTN', pad: 'GP16', xMm: 3, yMm: 29, type: 'digital', capabilities: [] },
    { id: 'SENSOR_SDA', label: 'SENSOR_SDA', pad: 'GP4', xMm: 31, yMm: 23, type: 'digital', capabilities: [] },
    { id: 'SENSOR_SCL', label: 'SENSOR_SCL', pad: 'GP5', xMm: 31, yMm: 29, type: 'digital', capabilities: [] },
    { id: 'AUX', label: 'AUX', pad: 'GP17', xMm: 31, yMm: 35, type: 'digital', capabilities: [] },
  ],
  processorProfileId: 'proc.rp2040',
  compileProfileId: 'compile.rp2040-arduino',
  runtimeProfileId: 'runtime.rp2040js',
  peripherals: [{ kind: 'i2c', controller: 'i2c0', pins: { sda: 'SENSOR_SDA', scl: 'SENSOR_SCL' } }],
};

/** Firmware is written against the PADS, which is what firmware is written against. */
const BLINK = [
  '// Written against the processor, as firmware is.',
  'void setup() {',
  '  Serial1.begin(9600);',
  '  pinMode(15, OUTPUT);',
  '  pinMode(16, INPUT_PULLUP);',
  '}',
  'void loop() {',
  '  digitalWrite(15, HIGH);',
  '  delay(40);',
  '  digitalWrite(15, LOW);',
  '  delay(40);',
  '}',
].join('\n');

function projectWithBoard(source: string): { project: CircuitProject; instance: ComponentInstance } {
  const project = emptyProject('custom rp2040');
  embedBoard(project, LAB_BOARD);
  const instance: ComponentInstance = {
    id: uid('b'), definitionId: LAB_BOARD.id, x: 40, y: 40, rotation: 0, properties: {}, simulationState: {},
  };
  project.boardInstances.push(instance);
  project.codeFiles = [{ id: 'f1', name: 'sketch.ino', content: source, language: 'cpp' }];
  return { project, instance };
}

// ======================================= 1. the board is not a Pico ==========
section('1. it is its own board');
{
  const { problems, board } = validateCustomBoard(LAB_BOARD);
  check(problems.filter(isError).length === 0, `the definition is accepted${problems.filter(isError).map((p) => ` — ${p.message}`).join('')}`);
  const { board: resolved } = resolveCustomBoard(board!);

  check(resolved.name === 'RP2040 Lab Board', 'its name is its own');
  check(resolved.manufacturer === 'Lab Systems', 'as is its maker');
  check(resolved.id !== 'board.raspberry-pi-pico', 'and its id is not a Pico\'s');
  check(resolved.pins.length === 8, `it has its own eight pins (${resolved.pins.length})`);
  check(resolved.widthMm === 34 && resolved.heightMm === 46, 'and its own outline');
  check(
    resolved.pins.every((p) => !/^GP\d+$/.test(p.label)),
    'no pin is LABELLED with a pad name — the labels are the maker\'s',
  );
  check(
    !JSON.stringify({ ...resolved, compiler: null }).includes('Pico'),
    'and nothing but the build target mentions a Pico',
  );
  // The one place a Pico legitimately appears: the Arduino-Pico core's generic
  // RP2040 target, which is what this chip is built with.
  check(resolved.compiler?.fqbn === 'rp2040:rp2040:rpipico', `it builds for ${resolved.compiler?.fqbn}`);
  check(resolved.processor === 'RP2040', 'while its processor is the chip');
}

// ================================ 2. it resolves like any other board ========
section('2. the rest of the app sees an ordinary board');
{
  const { project, instance } = projectWithBoard(BLINK);
  const def = resolveDefinition(instance.definitionId, project);
  check(def !== undefined, 'the board resolves out of the project');
  check(def?.isBoard === true, 'as a board');
  check(def?.id === LAB_BOARD.id, 'by its own id');

  const { targets, unbuildable } = resolveWorkspaceTargets(project);
  check(unbuildable.length === 0, `it is buildable${unbuildable.map((u) => ` — ${u.reason}`).join('')}`);
  check(targets.length === 1, `and produces one build (${targets.length})`);
  check(targets[0]?.boardId === LAB_BOARD.id, 'the build belongs to the custom board');
  check(
    targets[0]?.serverBoardId === 'board.raspberry-pi-pico',
    `and is requested from the service as the RP2040 target (${targets[0]?.serverBoardId})`,
  );
  check(targets[0]?.fqbn === 'rp2040:rp2040:rpipico', 'with the RP2040 FQBN');
}

// ==================================== 3. it compiles and it runs =============
section('3. compiled with the RP2040 pipeline, executed on the RP2040 runtime');
{
  const { project, instance } = projectWithBoard(BLINK);
  simulationController.stop();
  const report = await simulationController.build(project);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);

  if (!report.anyRunnable) {
    skip('the RP2040 toolchain is unavailable — the custom board cannot be built here');
  } else {
    const build = report.builds[0];
    check(build.status === 'built', `the custom board built (${build.status})`);
    check(build.boardName === 'RP2040 Lab Board', `and the report names the custom board (${build.boardName})`);
    check(build.result?.firmware?.format === 'uf2', `producing a UF2 (${build.result?.firmware?.format})`);
    check(
      build.result?.boardId === LAB_BOARD.id,
      `stamped with the custom board, not the compile target (${build.result?.boardId})`,
    );

    const started = await simulationController.start();
    check(started, 'and it starts');
    if (started) {
      simulationController.pause();
      const runner = simulationController.runnerFor(instance.id);
      check(runner !== undefined, 'a runner exists for the instance');

      // The firmware drives GP15. The board calls that pin STATUS_LED. Both
      // are true at once, which is the point.
      simulationController.advance(300);
      const binding = (simulationController as unknown as {
        binding: { visualsFor?: unknown } | null;
      }).binding;
      check(binding !== null, 'the circuit binding is live');

      // GP15 is the pad. The board calls it STATUS_LED. Both are true at once,
      // and this is where that has to hold: the firmware drove pad 15, and the
      // pin the canvas labels STATUS is the pin that moved.
      check(runner?.isOutput(15) === true, 'the firmware made GP15 an output');
      let sawHigh = false;
      let sawLow = false;
      for (let i = 0; i < 60 && !(sawHigh && sawLow); i++) {
        simulationController.advance(10);
        const level = runner?.digitalPinLevel(15);
        if (level === 'high') sawHigh = true;
        if (level === 'low') sawLow = true;
      }
      check(sawHigh && sawLow, `GP15 toggles (high=${sawHigh} low=${sawLow})`);

      // And the pin the user sees is the one that moved.
      const def = resolveDefinition(instance.definitionId, project)!;
      const statusPin = def.pins.find((p) => p.id === 'STATUS_LED');
      check(statusPin?.label === 'STATUS', 'the canvas pin is called STATUS');
      check(statusPin?.aliases?.includes('GP15') === true, 'and it is the pin bonded to GP15');
    }
  }
  simulationController.stop();
}

// ============================== 4. the project is portable ==================
section('4. the definition travels with the project');
{
  const { project } = projectWithBoard(BLINK);
  // Round-tripped through JSON, which is what saving and opening actually is.
  const onDisk = JSON.stringify(project);
  check(onDisk.includes('custom.rp2040-lab-board'), 'the saved project carries the board id');
  check(onDisk.includes('STATUS_LED'), 'and its pin names');
  check(onDisk.includes('GP15'), 'and the pad they map to');
  check(!/[A-Za-z]:\\\\|\/home\/|\/Users\//.test(onDisk), 'and no path from anybody\'s machine');

  const reopened = normalizeProject(JSON.parse(onDisk));
  const def = resolveDefinition(LAB_BOARD.id, reopened);
  check(def !== undefined, 'a fresh open resolves the board with nothing else installed');
  check(def?.name === 'RP2040 Lab Board', 'with its name');
  check(def?.pins.length === 8, 'and all its pins');
  check(
    def?.pins.find((p) => p.id === 'STATUS_LED')?.aliases?.includes('GP15') === true,
    'and the pad mapping intact',
  );
  const { targets } = resolveWorkspaceTargets(reopened);
  check(targets.length === 1 && targets[0].fqbn === 'rp2040:rp2040:rpipico', 'and it still builds for the RP2040');
}

// ============================ 5. renaming breaks nothing ====================
section('5. the name is a label, not an identity');
{
  const { project, instance } = projectWithBoard(BLINK);
  const before = resolveWorkspaceTargets(project);

  const renamed: CustomBoardDefinition = {
    ...LAB_BOARD,
    revision: 2,
    identity: { ...LAB_BOARD.identity, name: 'Robot Controller Rev B' },
  };
  embedBoard(project, renamed);

  const def = resolveDefinition(instance.definitionId, project);
  check(def?.name === 'Robot Controller Rev B', 'the board is renamed');
  check(instance.definitionId === LAB_BOARD.id, 'the instance still references the same id');
  const after = resolveWorkspaceTargets(project);
  check(after.length === before.length, 'the same builds are needed');
  check(after.targets[0].fqbn === before.targets[0].fqbn, 'for the same target');
  check(
    after.targets[0].serverBoardId === before.targets[0].serverBoardId,
    'through the same pipeline',
  );
  check(
    def?.pins.find((p) => p.id === 'STATUS_LED')?.label === 'STATUS',
    'and every pin id is unchanged, so no wire moves',
  );
}

// ================================= 6. a new blank board is wiring-only ======
section('6. a board starts honest');
{
  const fresh = newCustomBoard('Untitled Board');
  check(fresh.processorProfileId === null, 'a new board has no processor');
  check(fresh.compileProfileId === 'compile.none', 'and no toolchain');
  check(fresh.runtimeProfileId === 'runtime.none', 'and no runtime');
  check(fresh.id.startsWith('custom.'), `with a generated id (${fresh.id})`);
  check(!fresh.id.includes('Untitled'), 'that is not derived from the name');
}

console.log(
  failures === 0
    ? `\nCustom RP2040 board checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
