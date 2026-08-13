// Which parts have contacts, and where.
//
// One table rather than a case per part in the circuit builder. Adding a
// switch, a keypad or a limit switch is now a row here plus artwork — the
// solver, the interaction overlay and the visual state all pick it up without
// being told about the specific part.

import type { ComponentInstance } from '../../types';
import { changeover, singleContact, switchBank, type ContactLayout, type ContactSpec } from './contacts';
import {
  KEYPAD_3X4_CAPS,
  KEYPAD_4X4_CAPS,
  MINI_KEYBOARD_CAPS,
  MINI_KEYBOARD_COLS,
  MINI_KEYBOARD_ROWS,
  matrixContacts,
  matrixLayout,
  type MatrixSpec,
} from './matrixInput';

export interface ContactPart {
  contacts(instance: ComponentInstance): ContactSpec[];
  layout?(instance: ComponentInstance): { rows: number; cols: number; keys: ContactLayout[] };
}

const rowPin = (r: number) => `row${r + 1}`;
const colPin = (c: number) => `col${c + 1}`;

/** The grid a keypad instance currently is, honouring configurable sizes. */
function keypadSpec(instance: ComponentInstance, rows: number, cols: number, caps: string[]): MatrixSpec {
  return { rows, cols, caps, rowPin, colPin };
}

/** A configurable keypad reads its own size from its properties. */
function configurableSpec(instance: ComponentInstance): MatrixSpec {
  const rows = clampInt(instance.properties.rows, 1, 8, 4);
  const cols = clampInt(instance.properties.cols, 1, 8, 4);
  const caps: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) caps.push(defaultCap(r, c, cols));
  }
  return { rows, cols, caps, rowPin, colPin };
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** A sensible legend for a grid nobody has labelled: 1-9, then 0 and symbols. */
function defaultCap(r: number, c: number, cols: number): string {
  const index = r * cols + c;
  return index < 9 ? String(index + 1) : String.fromCharCode('A'.charCodeAt(0) + index - 9);
}

export const CONTACT_PARTS: Record<string, ContactPart> = {
  // Existing parts, moved here from hand-written cases so they share one model.
  'comp.push-button': { contacts: () => singleContact('1a', '2a') },
  'comp.push-button-6mm': { contacts: () => singleContact('1a', '2a') },
  'comp.toggle-switch': { contacts: () => changeover('com', 'no', 'nc') },
  'comp.slide-switch': { contacts: () => changeover('com', 'no', 'nc') },

  // A limit switch is a lever-operated changeover: NC conducts until the lever
  // is pressed, which is why it is wired as an end-stop rather than a button.
  'comp.limit-switch': { contacts: () => changeover('com', 'no', 'nc') },

  // DIP banks: N independent poles, each its own contact.
  'comp.dip-switch-4': { contacts: () => switchBank(4, (i) => `a${i}`, (i) => `b${i}`) },
  'comp.dip-switch-6': { contacts: () => switchBank(6, (i) => `a${i}`, (i) => `b${i}`) },
  'comp.dip-switch-8': { contacts: () => switchBank(8, (i) => `a${i}`, (i) => `b${i}`) },

  // A KY-040's two quadrature contacts plus its push switch. The detent
  // sequencing lives in the encoder model; these are the contacts it drives.
  'comp.rotary-encoder': {
    contacts: () => [
      { key: 'a', a: 'clk', b: 'gnd', label: 'A' },
      { key: 'b', a: 'dt', b: 'gnd', label: 'B' },
      { key: 'sw', a: 'sw', b: 'gnd', label: 'Switch' },
    ],
  },

  // The joystick's axes are a pair of potentiometers; only its push-in click
  // is a contact.
  'comp.joystick': { contacts: () => [{ key: 'sw', a: 'sw', b: 'gnd', label: 'Click' }] },

  // Keypads and keyboards: a grid of crossings and nothing else.
  'comp.keypad-3x4': {
    contacts: (i) => matrixContacts(keypadSpec(i, 4, 3, KEYPAD_3X4_CAPS)),
    layout: (i) => matrixLayout(keypadSpec(i, 4, 3, KEYPAD_3X4_CAPS)),
  },
  'comp.keypad-4x4': {
    contacts: (i) => matrixContacts(keypadSpec(i, 4, 4, KEYPAD_4X4_CAPS)),
    layout: (i) => matrixLayout(keypadSpec(i, 4, 4, KEYPAD_4X4_CAPS)),
  },
  'comp.keypad-matrix': {
    contacts: (i) => matrixContacts(configurableSpec(i)),
    layout: (i) => matrixLayout(configurableSpec(i)),
  },
  'comp.mini-keyboard': {
    contacts: (i) => matrixContacts(keypadSpec(i, MINI_KEYBOARD_ROWS, MINI_KEYBOARD_COLS, MINI_KEYBOARD_CAPS)),
    layout: (i) => matrixLayout(keypadSpec(i, MINI_KEYBOARD_ROWS, MINI_KEYBOARD_COLS, MINI_KEYBOARD_CAPS)),
  },
};

/** The contacts a component instance has, or none if it is not that kind of part. */
export function contactsOf(definitionId: string, instance: ComponentInstance): ContactSpec[] {
  return CONTACT_PARTS[definitionId]?.contacts(instance) ?? [];
}

/** The key grid a component instance has, when it has one worth drawing. */
export function contactLayoutOf(
  definitionId: string,
  instance: ComponentInstance,
): { rows: number; cols: number; keys: ContactLayout[] } | null {
  return CONTACT_PARTS[definitionId]?.layout?.(instance) ?? null;
}
