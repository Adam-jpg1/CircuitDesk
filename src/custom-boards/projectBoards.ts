// Custom boards inside a project, so a project stays portable.
//
// The rule this file exists to keep: a project that uses a custom board must
// open on somebody else's machine. That rules out referencing the author's
// personal library, and it certainly rules out a path on their disk — either
// one arrives at the next person as a hole where a board used to be.
//
// So the DEFINITION travels in the project, in `customDefinitions`, which is
// the mechanism the app already uses to resolve parts by id. A board instance
// references the definition by id; the definition carries its own pins, its own
// artwork and its own choice of processor, toolchain and runtime; and opening
// the project on a fresh machine needs nothing that is not in the file.
//
// The snapshot is also what makes editing safe. A definition in the user's
// library can be changed; the copy inside a project cannot change underneath
// it, so editing "Robot Controller" in the library never silently reroutes the
// wires of a project already built against revision 3. Upgrading is a thing the
// user chooses, and `upgradeEmbeddedBoard` is where that choice is applied.

import type { CircuitProject, CustomDefinition } from '../types';
import { validateCustomBoard, isError, type BoardProblem } from './validate';
import { resolveCustomBoard } from './resolve';
import { CUSTOM_BOARD_SCHEMA_VERSION, type CustomBoardDefinition } from './schema';

/** Marks the CustomDefinition entries that carry a custom board. */
export const CUSTOM_BOARD_SOURCE = 'custom-board';

/**
 * The custom board definitions a project carries, by board id.
 *
 * Reads the definition out of the entry rather than the resolved board, because
 * the definition is the thing that round-trips: a resolved BoardDefinition has
 * had capability derived onto it, and re-deriving from a derived board would
 * let an edited profile change what a saved project claims.
 */
export function embeddedBoards(project: CircuitProject): Map<string, CustomBoardDefinition> {
  const out = new Map<string, CustomBoardDefinition>();
  for (const entry of project.customDefinitions) {
    if (entry.source !== CUSTOM_BOARD_SOURCE) continue;
    const spec = (entry as CustomDefinition & { spec?: unknown }).spec;
    const { board } = validateCustomBoard(spec);
    if (board) out.set(board.id, board);
  }
  return out;
}

/**
 * Puts a custom board into a project, or replaces the copy already there.
 *
 * Stores BOTH the source definition and the resolved BoardDefinition: the
 * definition because it is what can be edited, exported and re-resolved, and
 * the resolved board because `resolveDefinition` — which the canvas, the
 * validator and the compiler all go through — expects a PartDefinition and
 * should not have to know custom boards exist.
 */
export function embedBoard(
  project: CircuitProject,
  definition: CustomBoardDefinition,
): { problems: BoardProblem[]; project: CircuitProject } {
  const { problems, board } = validateCustomBoard(definition);
  if (!board) return { problems, project };

  const { board: resolved } = resolveCustomBoard(board);
  const entry: CustomDefinition & { spec: CustomBoardDefinition } = {
    kind: 'board',
    definition: resolved,
    spec: board,
    source: CUSTOM_BOARD_SOURCE,
    createdAt: new Date().toISOString(),
  };
  const others = project.customDefinitions.filter((c) => c.definition.id !== board.id);
  project.customDefinitions = [...others, entry];
  return { problems, project };
}

/** Removes a custom board, refusing while instances of it are still placed. */
export function removeEmbeddedBoard(
  project: CircuitProject,
  boardId: string,
): { removed: boolean; reason?: string } {
  const inUse = project.boardInstances.filter((i) => i.definitionId === boardId);
  if (inUse.length > 0) {
    return {
      removed: false,
      reason:
        `${inUse.length} board instance(s) on the canvas still use this definition. ` +
        'Delete them first — removing the definition would leave them unresolvable.',
    };
  }
  const before = project.customDefinitions.length;
  project.customDefinitions = project.customDefinitions.filter((c) => c.definition.id !== boardId);
  return { removed: project.customDefinitions.length < before };
}

export interface UpgradeReport {
  /** Pin ids the newer revision no longer has, and the wires that used them. */
  droppedPins: { pinId: string; connectionIds: string[] }[];
  /** Pins whose processor pad changed, which changes what firmware drives. */
  remappedPads: { pinId: string; from: string | null; to: string | null }[];
  fromRevision: number;
  toRevision: number;
}

/**
 * What upgrading a project to a newer revision of a board would cost.
 *
 * Reported before anything changes, because the honest answer is sometimes
 * "three of your wires have nowhere to go". A user who edits a board's pin map
 * after building a project with it should be told that, not have it applied.
 */
export function previewUpgrade(
  project: CircuitProject,
  next: CustomBoardDefinition,
): UpgradeReport | null {
  const current = embeddedBoards(project).get(next.id);
  if (!current) return null;

  const nextPins = new Map(next.pins.map((p) => [p.id, p]));
  const droppedPins: UpgradeReport['droppedPins'] = [];
  const remappedPads: UpgradeReport['remappedPads'] = [];

  const instanceIds = new Set(
    project.boardInstances.filter((i) => i.definitionId === next.id).map((i) => i.id),
  );

  for (const pin of current.pins) {
    const after = nextPins.get(pin.id);
    if (!after) {
      const connectionIds = project.connections
        .filter(
          (c) =>
            (instanceIds.has(c.sourceComponentId) && c.sourcePinId === pin.id) ||
            (instanceIds.has(c.targetComponentId) && c.targetPinId === pin.id),
        )
        .map((c) => c.id);
      droppedPins.push({ pinId: pin.id, connectionIds });
      continue;
    }
    if (after.pad !== pin.pad) remappedPads.push({ pinId: pin.id, from: pin.pad, to: after.pad });
  }

  return {
    droppedPins,
    remappedPads,
    fromRevision: current.revision,
    toRevision: next.revision,
  };
}

/**
 * Applies a newer revision to a project, after the user has seen the cost.
 *
 * Wires to pins the new revision does not have are removed rather than left
 * pointing at nothing — `normalizeProject` would drop them on the next load
 * anyway, and doing it here means the count in the report is the count that
 * actually happens.
 */
export function upgradeEmbeddedBoard(
  project: CircuitProject,
  next: CustomBoardDefinition,
): { report: UpgradeReport | null; problems: BoardProblem[] } {
  const report = previewUpgrade(project, next);
  const { problems } = embedBoard(project, next);
  if (problems.some(isError)) return { report: null, problems };
  if (report) {
    const doomed = new Set(report.droppedPins.flatMap((d) => d.connectionIds));
    project.connections = project.connections.filter((c) => !doomed.has(c.id));
  }
  return { report, problems };
}

/** A fresh, empty definition for the Board Studio to start from. */
export function newCustomBoard(name: string): CustomBoardDefinition {
  // The id is generated once and never derived from the name, which is what
  // makes renaming free.
  const random = Math.random().toString(36).slice(2, 10);
  return {
    schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
    id: `custom.${Date.now().toString(36)}${random}`,
    revision: 1,
    identity: { name },
    outline: { widthMm: 25, heightMm: 50 },
    pins: [],
    processorProfileId: null,
    compileProfileId: 'compile.none',
    runtimeProfileId: 'runtime.none',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Rebuilds every embedded board's definition from the spec it was made from.
 *
 * A project file is untrusted input in exactly the way a board file is — it
 * arrives by email, by link, by clone — and a custom board entry carries two
 * things: the `spec`, which is a description, and the `definition`, which is
 * capability DERIVED from that description. Trusting the second is how a
 * hand-edited project claims to be simulated with no processor on it: the
 * canvas, the compiler client and the runner all read the definition, and none
 * of them re-derives it.
 *
 * So it is re-derived here, on the way in, every time. The spec is validated
 * and resolved exactly as it would be on import, and the result replaces
 * whatever the file said. Nothing is lost by this — the spec is the thing a
 * user edits and exports — and a project that has been tampered with quietly
 * comes back saying what it really is.
 *
 * A spec that no longer validates is not deleted, because deleting it would
 * take every wire attached to that board with it. It keeps its geometry and its
 * pins and loses every capability claim, which is the honest reading of "we
 * cannot tell what this board is any more".
 */
export function revalidateEmbeddedBoards(project: CircuitProject): {
  rederived: string[];
  disarmed: { boardId: string; reason: string }[];
} {
  const rederived: string[] = [];
  const disarmed: { boardId: string; reason: string }[] = [];

  project.customDefinitions = project.customDefinitions.map((entry) => {
    if (entry.source !== CUSTOM_BOARD_SOURCE) return entry;
    const spec = (entry as CustomDefinition & { spec?: unknown }).spec;
    const { board, problems } = validateCustomBoard(spec);
    if (board) {
      const { board: resolved } = resolveCustomBoard(board);
      rederived.push(resolved.id);
      return { ...entry, definition: resolved, spec: board };
    }
    const reason = problems.find(isError)?.message ?? 'the board description could not be read';
    disarmed.push({ boardId: entry.definition?.id ?? 'unknown', reason });
    return {
      ...entry,
      definition: {
        ...entry.definition,
        supportLevel: 'wiring',
        compiler: { provider: 'none', supported: false, note: reason },
        simulation: { engine: 'none', supported: false, supportedApis: [], supportedPeripherals: [] },
      },
    };
  });

  return { rederived, disarmed };
}
