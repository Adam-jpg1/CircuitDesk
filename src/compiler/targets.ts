// Client-side compile-target resolution: the target comes from the board's own
// canonical definition — never from a default FQBN. Boards without a supported
// toolchain produce a clear refusal instead of compiling as Uno.
//
// A workspace has one sketch and may have several boards. That makes the
// compile target a *set*: the sketch is built once per distinct FQBN, and each
// board instance runs the artifact built for its own target. Two Picos share an
// artifact because they share an FQBN; a Pico and a C6 do not, because they
// share nothing but the source text.
//
// Grouping is by FQBN rather than by board id so that two different boards that
// genuinely compile to the same target are built once — and, more importantly,
// so that nothing can conclude two boards are "the same board" and share
// runtime state. An artifact is a file; a running CPU is not.

import type { BoardDefinition, CircuitProject } from '../types';
import { resolveDefinition } from '../project/partsRegistry';
import { sketchFor, sketchIdFor } from '../project/sketches';
import { compileProfile } from '../boards/pipelineProfiles';
import { isCustomBoardId } from '../custom-boards/schema';

export type CompileTargetResolution =
  | { ok: true; board: BoardDefinition; boardId: string; fqbn: string }
  | { ok: false; reason: string };

/**
 * The single primary target, for callers that legitimately have one.
 *
 * Kept for the paths that mean "the board this project is about" — the export
 * dialogue, the compiler panel's heading. Anything that runs firmware must use
 * `resolveWorkspaceTargets` instead, because a workspace can hold more than one
 * board and picking the first would silently drop the rest.
 */
export function resolveCompileTarget(project: CircuitProject): CompileTargetResolution {
  const inst = project.boardInstances[0];
  if (!inst) {
    return { ok: false, reason: 'Place a board on the canvas before compiling — there is no default compile target.' };
  }
  const def = resolveDefinition(inst.definitionId, project);
  if (!def || !def.isBoard) {
    return { ok: false, reason: `The board definition "${inst.definitionId}" could not be resolved, so nothing was compiled.` };
  }
  const compiler = def.compiler;
  if (!compiler || compiler.provider === 'none' || !compiler.supported || !compiler.fqbn) {
    return {
      ok: false,
      reason:
        `${def.name} has no compiler toolchain in CircuitDesk yet (current support: ${def.supportLevel}). ` +
        'It is never compiled as a different board.' +
        (def.metadata.limitation ? ` ${def.metadata.limitation}` : ''),
    };
  }
  return { ok: true, board: def, boardId: def.id, fqbn: compiler.fqbn };
}

/** One compilation the workspace needs, and the board instances waiting on it. */
export interface WorkspaceTarget {
  fqbn: string;
  boardId: string;
  /**
   * The id the COMPILER SERVICE knows this target by.
   *
   * The service keeps a strict allowlist and refuses anything not on it, which
   * is exactly the protection that must not be weakened — so a board it has
   * never heard of compiles by naming the TARGET its pipeline uses, not itself.
   * A custom RP2040 board sends the RP2040 target and gets RP2040 firmware; it
   * does not become a Raspberry Pi Pico by doing so, and the artifact is still
   * stamped with the board that will run it.
   *
   * The same value as `boardId` for native boards, which are on the allowlist
   * under their own names.
   */
  serverBoardId: string;
  board: BoardDefinition;
  /** The sketch document this build compiles. */
  sketchId: string;
  /** Its display name, for a build report a person can read. */
  sketchName: string;
  /**
   * Board instances that will run this artifact — each in its own runner.
   *
   * More than one entry means several boards share a build, never a CPU.
   */
  instanceIds: string[];
}

/**
 * What the compiler service should be asked to build this board as.
 *
 * A board on the service's own allowlist is asked for by name. A custom board
 * is asked for by the target its compile profile declares — the service refuses
 * ids it does not know, and that refusal is a protection worth keeping, so the
 * request names something real rather than the allowlist being widened.
 */
function serverTargetFor(def: BoardDefinition): string {
  if (!isCustomBoardId(def.id)) return def.id;
  const profile = def.compileProfileId ? compileProfile(def.compileProfileId) : undefined;
  return profile?.serverTargetId ?? def.id;
}

/** A board instance the workspace cannot build for, and why. */
export interface UnbuildableBoard {
  instanceId: string;
  boardName: string;
  reason: string;
}

export interface WorkspaceTargets {
  targets: WorkspaceTarget[];
  /**
   * Boards that are on the canvas but cannot be built.
   *
   * Reported rather than dropped: a board silently skipped looks to the user
   * exactly like a board that ran and did nothing.
   */
  unbuildable: UnbuildableBoard[];
}

/**
 * Every compilation this workspace needs.
 *
 * Grouped by target *and* sketch, which is the real build unit: two Picos
 * running one sketch is one compilation loaded into two machines, two Picos
 * running different sketches is two, and one sketch on a Pico and a C6 is two
 * because the target differs. Board instance is deliberately not part of the
 * key — an artifact is a file, and the same file can be loaded twice.
 *
 * Order follows the canvas, so the first board placed is the first target
 * built and messages read in the order the user thinks about their boards.
 */
export function resolveWorkspaceTargets(project: CircuitProject): WorkspaceTargets {
  const byBuild = new Map<string, WorkspaceTarget>();
  const unbuildable: UnbuildableBoard[] = [];

  for (const inst of project.boardInstances) {
    const def = resolveDefinition(inst.definitionId, project);
    if (!def || !def.isBoard) {
      unbuildable.push({
        instanceId: inst.id,
        boardName: inst.label || inst.definitionId,
        reason: `The board definition "${inst.definitionId}" could not be resolved.`,
      });
      continue;
    }
    const compiler = def.compiler;
    if (!compiler || compiler.provider === 'none' || !compiler.supported || !compiler.fqbn) {
      unbuildable.push({
        instanceId: inst.id,
        boardName: inst.label || def.name,
        reason:
          `${def.name} has no compiler toolchain in CircuitDesk yet (current support: ${def.supportLevel}). ` +
          'It is never compiled as a different board.',
      });
      continue;
    }
    const sketchId = sketchIdFor(project, inst.id);
    const sketch = sketchFor(project, inst.id);
    if (!sketchId || !sketch) {
      unbuildable.push({
        instanceId: inst.id,
        boardName: inst.label || def.name,
        reason: `${inst.label || def.name} has no sketch assigned, so there is nothing to build for it.`,
      });
      continue;
    }
    const key = `${compiler.fqbn}\u0000${sketchId}`;
    const existing = byBuild.get(key);
    if (existing) existing.instanceIds.push(inst.id);
    else {
      byBuild.set(key, {
        fqbn: compiler.fqbn,
        boardId: def.id,
        serverBoardId: serverTargetFor(def),
        board: def,
        sketchId,
        sketchName: sketch.name,
        instanceIds: [inst.id],
      });
    }
  }

  return { targets: [...byBuild.values()], unbuildable };
}
