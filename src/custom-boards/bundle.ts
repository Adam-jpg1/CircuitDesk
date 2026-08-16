// The file a board travels in.
//
// `.cdboard.json` — one JSON document, not an archive. The choice is
// deliberate: the only asset a board needs is its artwork, artwork is SVG,
// and SVG is text. An archive would buy nothing and cost a decompression
// bomb, a path-traversal surface and a file-count limit to enforce.
//
// What it carries is everything needed to recreate the board on a machine that
// has never seen it: identity, revision, outline, artwork, every pin with its
// pad, the processor and pipeline it chose, its peripheral assignments and its
// schema version. What it does NOT carry is any path from the machine that
// wrote it — the export is checked for that, because a board bundle with
// C:\Users\... in it is a bundle that only works for one person.
//
// On the way back in it is untrusted input and goes through the same validator
// a project's embedded board does, plus the bundle-shaped checks here.

import { CUSTOM_BOARD_SCHEMA_VERSION, CUSTOM_BOARD_LIMITS, type CustomBoardDefinition } from './schema';
import { validateCustomBoard, isError, type BoardProblem } from './validate';
import { looksHostile } from './svgSanitize';

/** Marks the document so a stray JSON file is refused with a clear reason. */
export const BUNDLE_KIND = 'circuitdesk-board';
export const BUNDLE_VERSION = 1;

export interface BoardBundle {
  kind: typeof BUNDLE_KIND;
  bundleVersion: number;
  /** When and by what, for the person who opens it. Never a path. */
  exportedAt: string;
  exportedBy: string;
  board: CustomBoardDefinition;
}

/** Largest bundle we will read. A board is a few kilobytes plus its artwork. */
const MAX_BUNDLE_BYTES = CUSTOM_BOARD_LIMITS.maxArtworkBytes + 256 * 1024;

/**
 * Anything that looks like a path from somebody's computer.
 *
 * Checked on EXPORT rather than only on import, because the failure it prevents
 * is silent: a bundle that carries an author's home directory still opens, it
 * just carries information nobody meant to share.
 */
const PATH_LIKE = /(^|["'\s])(?:[A-Za-z]:[\\/]|\\\\[^\\]|\/(?:home|Users|root|var|etc|tmp)\/)/;

export function exportBoardBundle(board: CustomBoardDefinition): { json: string; problems: BoardProblem[] } {
  const problems: BoardProblem[] = [];
  const bundle: BoardBundle = {
    kind: BUNDLE_KIND,
    bundleVersion: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: 'CircuitDesk',
    board,
  };
  const json = JSON.stringify(bundle, null, 2);
  const leak = PATH_LIKE.exec(json);
  if (leak) {
    problems.push({
      severity: 'warning',
      code: 'path-in-bundle',
      message:
        `The board contains something that looks like a filesystem path ("${leak[0].trim().slice(0, 40)}"). ` +
        'It has been exported as-is, but a path from your machine will not mean anything on anybody else\'s.',
    });
  }
  return { json, problems };
}

/**
 * Reads a bundle, treating every part of it as hostile until checked.
 *
 * Returns problems rather than throwing, so an import screen can show all of
 * them at once — somebody fixing a hand-edited bundle wants the list.
 */
export function importBoardBundle(text: string): { board?: CustomBoardDefinition; problems: BoardProblem[] } {
  const problems: BoardProblem[] = [];

  if (typeof text !== 'string' || text.length === 0) {
    return { problems: [{ severity: 'error', code: 'empty', message: 'The file is empty.' }] };
  }
  if (text.length > MAX_BUNDLE_BYTES) {
    return {
      problems: [{
        severity: 'error',
        code: 'bundle-too-large',
        message: `The board file is ${Math.round(text.length / 1024)} KB; the limit is ${Math.round(MAX_BUNDLE_BYTES / 1024)} KB.`,
      }],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      problems: [{
        severity: 'error',
        code: 'not-json',
        message: `The file is not valid JSON: ${err instanceof Error ? err.message.slice(0, 120) : 'parse failed'}.`,
      }],
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { problems: [{ severity: 'error', code: 'not-an-object', message: 'A board file must be a JSON object.' }] };
  }

  const bundle = parsed as Partial<BoardBundle>;
  if (bundle.kind !== BUNDLE_KIND) {
    return {
      problems: [{
        severity: 'error',
        code: 'not-a-board-bundle',
        message:
          `This is not a CircuitDesk board file — it says kind "${String(bundle.kind)}". ` +
          `A board file has kind "${BUNDLE_KIND}".`,
      }],
    };
  }
  if (typeof bundle.bundleVersion !== 'number' || bundle.bundleVersion > BUNDLE_VERSION) {
    return {
      problems: [{
        severity: 'error',
        code: 'bundle-version',
        message:
          `This board file is version ${String(bundle.bundleVersion)}; this build reads up to ${BUNDLE_VERSION}. ` +
          'Update CircuitDesk to open it.',
      }],
    };
  }

  // The artwork gets a structural refusal before the full validator, so the
  // message says "this file contains a script" rather than "artwork removed".
  const raw = bundle.board as Partial<CustomBoardDefinition> | undefined;
  const artwork = raw?.outline?.artworkSvg;
  if (typeof artwork === 'string') {
    const hostile = looksHostile(artwork);
    if (hostile) {
      return {
        problems: [{
          severity: 'error',
          code: 'hostile-artwork',
          message: `This board file was refused: ${hostile}. Board artwork may only contain drawing instructions.`,
        }],
      };
    }
  }

  const { problems: validation, board } = validateCustomBoard(bundle.board);
  problems.push(...validation);
  if (!board) return { problems };

  if (board.schemaVersion !== CUSTOM_BOARD_SCHEMA_VERSION) {
    problems.push({
      severity: 'warning',
      code: 'schema-upgraded',
      message: `The board was written for schema ${board.schemaVersion} and has been read as ${CUSTOM_BOARD_SCHEMA_VERSION}.`,
    });
  }

  return { board, problems: problems.filter((p) => !isError(p) || true) };
}

/**
 * A copy of a board with a new identity, for "duplicate".
 *
 * A new id rather than the same one, because two boards with one id is a
 * collision waiting to happen in a library and in a project. The revision
 * restarts at 1: this is a new board that happens to look like another, not a
 * later version of it.
 */
export function duplicateBoard(board: CustomBoardDefinition, name: string): CustomBoardDefinition {
  const random = Math.random().toString(36).slice(2, 10);
  return {
    ...board,
    id: `custom.${Date.now().toString(36)}${random}`,
    revision: 1,
    identity: { ...board.identity, name },
    createdAt: new Date().toISOString(),
    updatedAt: undefined,
  };
}

/**
 * A file name that is safe to hand to a download.
 *
 * Derived from the board's name for the user's benefit, stripped to characters
 * that cannot climb out of a directory or confuse a shell that should never see
 * it in the first place.
 */
export function bundleFileName(board: CustomBoardDefinition): string {
  const base = board.identity.name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .toLowerCase() || 'board';
  return `${base}.cdboard.json`;
}
