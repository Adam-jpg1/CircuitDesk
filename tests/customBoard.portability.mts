// A project with a board nobody has, opened by somebody who has nothing.
//
// The promise is simple and easy to break: send somebody a project and it opens.
// Not "opens if they import your board first", not "opens with a hole where the
// board was" — opens, with the board, its pins, its artwork, its pipeline and
// every wire attached to it.
//
// The other half is the one that is easy to forget: a project file is untrusted
// input in exactly the way a board file is. It arrives by email, by link, by
// clone. It carries a description of a board AND the capability derived from
// that description, and only one of those is a fact. This checks that the
// derived half is thrown away and recomputed on the way in, so a project that
// has been edited to claim more than it has comes back saying what it is.

import { normalizeProject } from '../src/project/projectService';
import { emptyProject } from '../src/project/templates';
import { embedBoard, embeddedBoards, previewUpgrade, upgradeEmbeddedBoard, removeEmbeddedBoard } from '../src/custom-boards/projectBoards';
import { resolveDefinition } from '../src/project/partsRegistry';
import { resolveWorkspaceTargets } from '../src/compiler/targets';
import { exportBoardBundle, importBoardBundle } from '../src/custom-boards/bundle';
import { runnerPinIndex } from '../src/simulation/boardRunner';
import { getBoardBusProfile } from '../src/boards/busProfile';
import { CUSTOM_BOARD_SCHEMA_VERSION, type CustomBoardDefinition } from '../src/custom-boards/schema';
import type { CircuitProject, ComponentInstance } from '../src/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

const ART = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 44"><rect width="30" height="44" fill="#1c3d2a"/></svg>';

const BOARD: CustomBoardDefinition = {
  schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
  id: 'custom.travelling-board',
  revision: 3,
  identity: { name: 'Travelling Board', creator: 'Somebody Else', hardwareVersion: 'Rev C' },
  outline: { widthMm: 30, heightMm: 44, color: '#1c3d2a', artworkSvg: ART },
  pins: [
    { id: 'V3', label: '3V3', pad: null, xMm: 2, yMm: 4, type: 'power-3v3', capabilities: [], voltage: 3.3 },
    { id: 'GND', label: 'GND', pad: null, xMm: 2, yMm: 8, type: 'ground', capabilities: [] },
    { id: 'LAMP', label: 'LAMP', pad: 'GP15', xMm: 2, yMm: 12, type: 'digital', capabilities: [] },
    { id: 'PROBE_SDA', label: 'PROBE_SDA', pad: 'GP4', xMm: 28, yMm: 12, type: 'digital', capabilities: [] },
    { id: 'PROBE_SCL', label: 'PROBE_SCL', pad: 'GP5', xMm: 28, yMm: 16, type: 'digital', capabilities: [] },
  ],
  processorProfileId: 'proc.rp2040',
  compileProfileId: 'compile.rp2040-arduino',
  runtimeProfileId: 'runtime.rp2040js',
};

let seq = 0;
const uid = (p: string) => `${p}${++seq}`;

function projectWithLcd(): CircuitProject {
  const project = emptyProject('travelling project');
  embedBoard(project, BOARD);
  project.boardInstances.push({
    id: 'b1', definitionId: BOARD.id, x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  } as ComponentInstance);
  project.componentInstances.push({
    id: 'lcd', definitionId: 'comp.lcd1602', x: 300, y: 0, rotation: 0, properties: {}, simulationState: {},
  } as ComponentInstance);
  for (const [a, ap, b, bp] of [
    ['lcd', 'sda', 'b1', 'PROBE_SDA'],
    ['lcd', 'scl', 'b1', 'PROBE_SCL'],
    ['lcd', 'gnd', 'b1', 'GND'],
    ['lcd', 'vcc', 'b1', 'V3'],
  ] as [string, string, string, string][]) {
    project.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#888', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  }
  return project;
}

/** Saving and opening is exactly this: JSON out, JSON in, normalize. */
const roundTrip = (p: CircuitProject) => normalizeProject(JSON.parse(JSON.stringify(p)));

// ================================= 1. it opens somewhere else ================
section('1. a project with a board nobody has, opened by somebody who has nothing');
{
  const saved = JSON.stringify(projectWithLcd());
  check(saved.includes('custom.travelling-board'), 'the file carries the board id');
  check(saved.includes('PROBE_SDA'), 'its pin names');
  check(saved.includes('GP4'), 'the pads behind them');
  check(saved.includes('Rev C'), 'and the hardware version printed on it');
  check(!/[A-Za-z]:\\\\|\/home\/|\/Users\/|file:\/\//.test(saved), 'and no path from anybody\'s machine');

  const opened = normalizeProject(JSON.parse(saved));
  const def = resolveDefinition(BOARD.id, opened);
  check(def !== undefined, 'it resolves with nothing installed');
  check(def?.name === 'Travelling Board', 'under its own name');
  check(def?.pins.length === 5, `with all its pins (${def?.pins.length})`);
  check(def?.artwork.kind === 'svg', 'and its artwork');
  check(opened.connections.length === 4, `every wire survived (${opened.connections.length})`);
  check(runnerPinIndex(def!, 'LAMP') === 15, 'the pad mapping is intact');
  const profile = getBoardBusProfile(def);
  check(
    profile?.channels.find((c) => c.name === 'Wire')?.defaults['i2c-sda'] === 'PROBE_SDA',
    'and bus validation still knows which of its pins is SDA',
  );
  const { targets, unbuildable } = resolveWorkspaceTargets(opened);
  check(unbuildable.length === 0 && targets.length === 1, 'it still builds');
}

// ================== 2. the file's capability claims are not believed =========
section('2. a project cannot talk a board into being more than it is');
{
  const tampered = JSON.parse(JSON.stringify(projectWithLcd()));
  const entry = tampered.customDefinitions[0];
  // Exactly what an attacker — or a curious user with a text editor — would do:
  // leave the description alone and edit the derived half.
  entry.definition.supportLevel = 'simulated';
  entry.definition.simulation = { engine: 'rp2040js', supported: true, supportedApis: ['everything'], supportedPeripherals: ['all'] };
  entry.definition.compiler = { provider: 'arduino-cli', fqbn: 'attacker:core:whatever', supported: true };
  entry.spec.processorProfileId = null;
  entry.spec.compileProfileId = 'compile.none';
  entry.spec.runtimeProfileId = 'runtime.none';

  const opened = normalizeProject(tampered);
  const def = resolveDefinition(BOARD.id, opened)!;
  check(def.supportLevel === 'wiring', `the board comes back wiring-only (${def.supportLevel})`);
  check(def.simulation?.supported === false, 'its claim to be simulated did not survive the open');
  check(def.compiler?.supported === false, 'nor its claim to compile');
  check(def.compiler?.fqbn === undefined, `nor the build target it invented (${def.compiler?.fqbn})`);
  check(
    def.simulation?.supportedApis.length === 0,
    'and it claims no APIs, because the runtime named in its description provides none',
  );
  check(opened.connections.length === 4, 'while every wire is still attached, because nothing was deleted');

  const { targets, unbuildable } = resolveWorkspaceTargets(opened);
  check(targets.length === 0 && unbuildable.length === 1, 'and nothing is built for it');
}

// ============ 3. a description that no longer validates is disarmed, not lost =
section('3. a board that can no longer be read keeps its wires and loses its claims');
{
  const broken = JSON.parse(JSON.stringify(projectWithLcd()));
  // A pad that does not exist on the chip: the kind of thing a hand-edit or a
  // future schema change produces.
  broken.customDefinitions[0].spec.pins[2].pad = 'NOT_A_PAD';

  const opened = normalizeProject(broken);
  const def = resolveDefinition(BOARD.id, opened);
  check(def !== undefined, 'the board is still there');
  check(def?.pins.length === 5, `with its pins (${def?.pins.length})`);
  check(opened.connections.length === 4, `and its wires (${opened.connections.length})`);
  check(def?.supportLevel === 'wiring', `but wiring-only (${def?.supportLevel})`);
  check(def?.compiler?.supported === false, 'nothing is compiled for it');
  check(
    (def?.compiler?.note ?? '').length > 0,
    `and the reason travels with it (${(def?.compiler?.note ?? '').slice(0, 80)})`,
  );
}

// ============================ 4. the copy in a project is a snapshot ========
section('4. editing a board does not reach into projects already built with it');
{
  const project = projectWithLcd();
  const embedded = embeddedBoards(project).get(BOARD.id)!;
  check(embedded.revision === 3, `the project holds revision ${embedded.revision}`);

  // The user edits the board in their library: renames a pin the project uses.
  const edited: CustomBoardDefinition = {
    ...BOARD,
    revision: 4,
    pins: BOARD.pins.filter((p) => p.id !== 'PROBE_SCL'),
  };

  const preview = previewUpgrade(project, edited);
  check(preview?.fromRevision === 3 && preview?.toRevision === 4, 'the upgrade is previewed before anything happens');
  check(preview?.droppedPins.length === 1, `naming the pin that would go (${preview?.droppedPins[0]?.pinId})`);
  check(
    preview?.droppedPins[0]?.connectionIds.length === 1,
    'and the wire that would go with it — which is the cost the user needs before deciding',
  );
  check(embeddedBoards(project).get(BOARD.id)?.revision === 3, 'and nothing has changed yet');

  const { report } = upgradeEmbeddedBoard(project, edited);
  check(embeddedBoards(project).get(BOARD.id)?.revision === 4, 'applying it moves the project to revision 4');
  check(report?.droppedPins.length === 1, 'with the same count the preview gave');
  check(project.connections.length === 3, `and the doomed wire actually removed (${project.connections.length})`);

  const reopened = roundTrip(project);
  check(reopened.connections.length === 3, 'which survives a save and open');
}

// ======================= 5. a board cannot be removed out from under a wire ==
section('5. a definition in use cannot be removed');
{
  const project = projectWithLcd();
  const refusal = removeEmbeddedBoard(project, BOARD.id);
  check(!refusal.removed, 'removing a board with instances on the canvas is refused');
  check(/instance/i.test(refusal.reason ?? ''), `and says why (${refusal.reason?.slice(0, 70)})`);

  project.boardInstances = [];
  const second = removeEmbeddedBoard(project, BOARD.id);
  check(second.removed, 'with the instances gone it can be removed');
  check(project.customDefinitions.length === 0, 'and the project no longer carries it');
}

// ============================= 6. board out, board in, unchanged ============
section('6. exporting and reimporting a board changes nothing about it');
{
  const { json, problems } = exportBoardBundle(BOARD);
  check(problems.length === 0, `the export is clean${problems.map((p) => ` — ${p.message}`).join('')}`);
  const { board: back, problems: importProblems } = importBoardBundle(json);
  check(back !== undefined, `and it reads back${importProblems.map((p) => ` — ${p.message}`).join('')}`);
  // Field order is not meaning, so the comparison is key-sorted.
  const stable = (v: unknown): string =>
    JSON.stringify(v, (_k, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
        : value);
  check(stable(back) === stable(BOARD), 'the same definition in every field, artwork included');

  // And it lands in a fresh project as the same board.
  const fresh = emptyProject('fresh');
  embedBoard(fresh, back!);
  const def = resolveDefinition(BOARD.id, fresh);
  check(def?.name === BOARD.identity.name, 'which embeds into a new project as itself');
  check(runnerPinIndex(def!, 'LAMP') === 15, 'with its pad mapping');
}

// ========================= 7. two projects, one board, no interference ======
section('7. the same board in two projects is two independent copies');
{
  const a = projectWithLcd();
  const b = projectWithLcd();
  upgradeEmbeddedBoard(a, { ...BOARD, revision: 5, identity: { ...BOARD.identity, name: 'Renamed In A' } });
  check(embeddedBoards(a).get(BOARD.id)?.identity.name === 'Renamed In A', 'one project is edited');
  check(
    embeddedBoards(b).get(BOARD.id)?.identity.name === 'Travelling Board',
    'and the other is untouched, because each carries its own copy',
  );
  check(embeddedBoards(b).get(BOARD.id)?.revision === 3, 'still on the revision it was built with');
}

console.log(failures === 0 ? '\nCustom-board portability checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
