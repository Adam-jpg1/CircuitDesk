// Row/column key matrices, as the hardware actually works.
//
// The tempting shortcut for a keypad is to hand the firmware a character when
// a key is clicked. That produces a component which cannot be wired wrong,
// cannot be scanned wrong, and teaches nothing — and which stops working the
// moment someone writes their own scanning loop instead of using a library.
//
// A real membrane keypad is a grid of contacts with no electronics in it at
// all. Pressing a key shorts one row line to one column line, and that is the
// entire device. The firmware drives rows, reads columns, and works out which
// key that means. Everything interesting about keypad code — pull-ups, ghosting
// with three keys down, scanning order — comes out of that one fact, so that
// one fact is what gets modelled here.

import type { ContactLayout, ContactSpec } from './contacts';

export interface MatrixSpec {
  rows: number;
  cols: number;
  /** Legends, row-major. Short of `rows*cols` entries the rest are blank. */
  caps: string[];
  /** Pin id for row r (0-based). */
  rowPin: (r: number) => string;
  /** Pin id for column c (0-based). */
  colPin: (c: number) => string;
}

/** The contact key for one position. Stable across relabelling. */
export function matrixKey(row: number, col: number): string {
  return `r${row}c${col}`;
}

/**
 * Every crossing in the grid as a contact.
 *
 * One per intersection, with no diodes: that is what a membrane keypad is, and
 * it is why holding three keys in an L can produce a fourth phantom key. That
 * behaviour is not a bug to be papered over — firmware that cannot cope with
 * it would not cope on the bench either.
 */
export function matrixContacts(spec: MatrixSpec): ContactSpec[] {
  const out: ContactSpec[] = [];
  for (let r = 0; r < spec.rows; r++) {
    for (let c = 0; c < spec.cols; c++) {
      out.push({
        key: matrixKey(r, c),
        a: spec.rowPin(r),
        b: spec.colPin(c),
        label: capAt(spec, r, c),
      });
    }
  }
  return out;
}

/** Where each key sits, for the artwork and the interaction overlay. */
export function matrixLayout(spec: MatrixSpec): { rows: number; cols: number; keys: ContactLayout[] } {
  const keys: ContactLayout[] = [];
  for (let r = 0; r < spec.rows; r++) {
    for (let c = 0; c < spec.cols; c++) {
      keys.push({ key: matrixKey(r, c), row: r, col: c, cap: capAt(spec, r, c) });
    }
  }
  return { rows: spec.rows, cols: spec.cols, keys };
}

function capAt(spec: MatrixSpec, r: number, c: number): string {
  return spec.caps[r * spec.cols + c] ?? '';
}

// ------------------------------------------------------------- known layouts

/** The legend on a standard 3×4 membrane keypad. */
export const KEYPAD_3X4_CAPS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

/** The legend on a standard 4×4 membrane keypad. */
export const KEYPAD_4X4_CAPS = [
  '1', '2', '3', 'A',
  '4', '5', '6', 'B',
  '7', '8', '9', 'C',
  '*', '0', '#', 'D',
];

/**
 * A compact QWERTY-ish matrix keyboard, 5 rows × 10 columns.
 *
 * Fifty keys: enough for a calculator, a menu system, a terminal or a small
 * computer, which is the point of having it at all. It is a plain matrix with
 * explicit row and column pins — no controller, no USB, no protocol — so it
 * works with any board that has ten spare GPIOs and a scanning loop the user
 * wrote themselves.
 */
export const MINI_KEYBOARD_CAPS = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P',
  'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', '↵',
  'Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '⌫',
  '⇧', 'C̲', '←', '→', ' ', ' ', ' ', '-', '=', '/',
];

export const MINI_KEYBOARD_ROWS = 5;
export const MINI_KEYBOARD_COLS = 10;

/**
 * What each key means to a person, for the overlay's tooltip.
 *
 * Note carefully what this is not: it is not what the firmware receives. The
 * firmware receives row and column continuity and decodes it however its
 * author chose. This is a label.
 */
export function keyCapDescription(cap: string): string {
  switch (cap) {
    case '↵': return 'Enter';
    case '⌫': return 'Backspace';
    case '⇧': return 'Shift';
    case 'C̲': return 'Ctrl';
    case '←': return 'Left';
    case '→': return 'Right';
    case ' ': return 'Space';
    default: return cap;
  }
}
