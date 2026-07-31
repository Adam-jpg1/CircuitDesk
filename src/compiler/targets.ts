// Client-side compile-target resolution: the target comes from the primary
// board's canonical definition — never from a default FQBN. Boards without a
// supported toolchain produce a clear refusal instead of compiling as Uno.

import type { BoardDefinition, CircuitProject } from '../types';
import { resolveDefinition } from '../project/partsRegistry';

export type CompileTargetResolution =
  | { ok: true; board: BoardDefinition; boardId: string; fqbn: string }
  | { ok: false; reason: string };

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
