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
  board: BoardDefinition;
  /**
   * Board instances that will run this artifact — each in its own runner.
   *
   * More than one entry means several boards share a build, never a CPU.
   */
  instanceIds: string[];
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
 * Every compilation this workspace needs, grouped by target.
 *
 * Order follows the canvas, so the first board placed is the first target
 * built and messages read in the order the user thinks about their boards.
 */
export function resolveWorkspaceTargets(project: CircuitProject): WorkspaceTargets {
  const byFqbn = new Map<string, WorkspaceTarget>();
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
    const existing = byFqbn.get(compiler.fqbn);
    if (existing) existing.instanceIds.push(inst.id);
    else byFqbn.set(compiler.fqbn, { fqbn: compiler.fqbn, boardId: def.id, board: def, instanceIds: [inst.id] });
  }

  return { targets: [...byFqbn.values()], unbuildable };
}
