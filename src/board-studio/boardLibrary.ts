// My Boards: the shelf a user's own boards live on between projects.
//
// A board that only exists inside the project it was made in is not a board a
// person owns. So a definition can be saved to a library, and from there
// dropped into any project — while the copy inside each project stays a
// snapshot, because a library edit must never silently reroute wires in
// something already built.
//
// That is what revisions are for. The id never changes: it is the identity a
// project's board instances reference, and changing it would orphan every one
// of them. What changes is the revision, and it changes only when the
// definition genuinely differs — saving a board you opened and did not edit is
// not a new revision of it, and pretending otherwise would make the number
// meaningless within a week.
//
// The storage is the custom-parts store the app already has. A custom board is
// a `CustomDefinition` of kind 'board' whose `spec` is the definition and whose
// `definition` is the resolved BoardDefinition, so everything that already
// resolves parts by id resolves these without knowing they are special.

import type { CustomDefinition } from '../types';
import { validateCustomBoard, isError, type BoardProblem } from '../custom-boards/validate';
import { resolveCustomBoard } from '../custom-boards/resolve';
import { CUSTOM_BOARD_SOURCE, disarmedDefinition } from '../custom-boards/projectBoards';
import type { CustomBoardDefinition } from '../custom-boards/schema';

/** The custom boards among a set of library entries, newest edit first. */
export function libraryBoards(parts: CustomDefinition[]): CustomBoardDefinition[] {
  const out: CustomBoardDefinition[] = [];
  for (const entry of parts) {
    if (entry.kind !== 'board' || entry.source !== CUSTOM_BOARD_SOURCE) continue;
    const { board } = validateCustomBoard((entry as CustomDefinition & { spec?: unknown }).spec);
    if (board) out.push(board);
  }
  return out.sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''));
}

/**
 * Everything about a definition except which revision it is and when it was
 * touched — the part that decides whether this is a new revision at all.
 */
function materialForm(board: CustomBoardDefinition): string {
  const { revision: _revision, updatedAt: _updatedAt, createdAt: _createdAt, ...rest } = board;
  return JSON.stringify(rest);
}

/** True when two definitions differ in anything a user would call a change. */
export function boardChanged(previous: CustomBoardDefinition, next: CustomBoardDefinition): boolean {
  return materialForm(previous) !== materialForm(next);
}

/**
 * The definition to store, with its revision resolved against what is there.
 *
 * A first save keeps revision 1. A save that changed nothing keeps the revision
 * it had. A save that changed something takes the next number — always the next
 * one, never the edited object's own claim, so a hand-edited bundle cannot
 * declare itself revision 99 and win every future comparison.
 */
export function withNextRevision(
  next: CustomBoardDefinition,
  previous?: CustomBoardDefinition,
): CustomBoardDefinition {
  const now = new Date().toISOString();
  if (!previous) {
    return { ...next, revision: 1, createdAt: next.createdAt ?? now, updatedAt: now };
  }
  if (!boardChanged(previous, next)) return { ...previous };
  return {
    ...next,
    revision: previous.revision + 1,
    createdAt: previous.createdAt ?? next.createdAt ?? now,
    updatedAt: now,
  };
}

/**
 * A library entry for a board, ready to store.
 *
 * Returns problems instead of throwing, and returns no entry when the board is
 * not valid: a library of boards that cannot be opened is worse than an empty
 * one.
 */
export function libraryEntryFor(
  board: CustomBoardDefinition,
): { entry?: CustomDefinition; problems: BoardProblem[] } {
  const { problems, board: validated } = validateCustomBoard(board);
  if (!validated || problems.some(isError)) return { problems };
  const { board: resolved } = resolveCustomBoard(validated);
  const entry: CustomDefinition & { spec: CustomBoardDefinition } = {
    kind: 'board',
    definition: resolved,
    spec: validated,
    source: CUSTOM_BOARD_SOURCE,
    createdAt: validated.createdAt ?? new Date().toISOString(),
  };
  return { entry, problems };
}

/** The board in a library with this id, if any. */
export function findLibraryBoard(
  parts: CustomDefinition[],
  boardId: string,
): CustomBoardDefinition | undefined {
  return libraryBoards(parts).find((b) => b.id === boardId);
}

/**
 * How a library board compares to the copy embedded in a project.
 *
 * The answer a user needs before deciding whether to upgrade: same board,
 * newer in the library, or newer in the project (which happens when they
 * edited it there).
 */
export function compareRevisions(
  library: CustomBoardDefinition | undefined,
  embedded: CustomBoardDefinition | undefined,
): 'no-library-copy' | 'no-project-copy' | 'same' | 'library-newer' | 'project-newer' {
  if (!library) return 'no-library-copy';
  if (!embedded) return 'no-project-copy';
  if (library.revision === embedded.revision) return 'same';
  return library.revision > embedded.revision ? 'library-newer' : 'project-newer';
}

/**
 * A stored library entry, with its board re-derived from its description.
 *
 * The same rule projects live under: the `spec` is a description and the
 * `definition` is a conclusion drawn from it, and only the first is a fact.
 * IndexedDB is not a trust boundary — an entry can be edited in a browser's
 * dev tools as easily as a project file can be edited in a text editor — so
 * the conclusion is drawn again on every load rather than read back.
 *
 * An entry whose description no longer validates keeps its geometry and loses
 * every capability claim, rather than vanishing from the library: a board a
 * user made and can still see is recoverable, and one that silently
 * disappeared is not.
 */
export function rederivedLibraryEntry(entry: CustomDefinition): CustomDefinition {
  if (entry.kind !== 'board' || entry.source !== CUSTOM_BOARD_SOURCE) return entry;
  const { board } = validateCustomBoard((entry as CustomDefinition & { spec?: unknown }).spec);
  if (!board) {
    return {
      ...entry,
      definition: disarmedDefinition(entry.definition, 'This board\'s description could not be read.'),
    };
  }
  const { board: resolved } = resolveCustomBoard(board);
  return { ...entry, definition: resolved, spec: board } as CustomDefinition;
}
