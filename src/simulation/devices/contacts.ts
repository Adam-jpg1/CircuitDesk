// Mechanical contacts, as one idea used by every part that has them.
//
// A pushbutton, a slide switch, a DIP switch bank, a limit switch, a relay's
// pole and every key on a keypad are the same physical thing: two terminals
// that are either bridged or not. Before this they were each hand-written as
// their own case in the circuit builder, which is why a keypad was hard —
// twelve contacts meant twelve special cases and a control key that could only
// name a whole component, never one key on it.
//
// So a part declares its contacts, and everything else follows: the circuit
// builder turns them into switch edges, the UI turns them into things to
// press, and multi-key rollover comes out for free because nothing anywhere
// assumes a component has at most one contact.

import type { ComponentInstance } from '../../types';

/** One pair of terminals that can be bridged. */
export interface ContactSpec {
  /**
   * Stable identity within the instance — `''` for a part with a single
   * contact, otherwise something like `r1c2` or `sw3`.
   *
   * Stable because it is what interaction state is keyed by: renaming it
   * would silently release a key the user is holding.
   */
  key: string;
  /** Pin ids this contact bridges. */
  a: string;
  b: string;
  /**
   * True when the contact rests closed and interaction opens it.
   *
   * A limit switch has both: an NC terminal that conducts until the lever is
   * pressed, and an NO terminal that conducts only while it is.
   */
  normallyClosed?: boolean;
  /** Closed resistance. Zero for a clean switch. */
  ohms?: number;
  /** What to call it in the UI. Defaults to the key. */
  label?: string;
}

/**
 * The control-state key for one contact.
 *
 * A part with one contact keeps using its bare instance id, which is what
 * every existing button and switch already stores — so no saved project and
 * no existing test has to change to gain this.
 */
export function contactStateKey(instanceId: string, contactKey: string): string {
  return contactKey === '' ? instanceId : `${instanceId}#${contactKey}`;
}

/** Whether a contact is bridged right now, given the interaction state. */
export function isContactClosed(
  engaged: ReadonlySet<string>,
  instanceId: string,
  contact: ContactSpec,
): boolean {
  const active = engaged.has(contactStateKey(instanceId, contact.key));
  return contact.normallyClosed ? !active : active;
}

/**
 * How a part's contacts are laid out, when they form a grid.
 *
 * Kept separate from the electrical description because the grid is a fact
 * about the artwork and the overlay, not about the circuit.
 */
export interface ContactLayout {
  key: string;
  row: number;
  col: number;
  /** The legend printed on the key. */
  cap: string;
}

/** A part that has contacts. Implemented by the definition, not the instance. */
export interface ContactModel {
  contacts(instance: ComponentInstance): ContactSpec[];
  /** Present when the contacts are arranged as a grid worth drawing. */
  layout?(instance: ComponentInstance): { rows: number; cols: number; keys: ContactLayout[] };
}

// ------------------------------------------------------------------ builders

/** A single-contact part: one button, one switch. */
export function singleContact(a: string, b: string, options: Partial<ContactSpec> = {}): ContactSpec[] {
  return [{ key: '', a, b, ...options }];
}

/**
 * A changeover (SPDT) pole: common to NO while engaged, common to NC while not.
 *
 * Written as two contacts rather than one three-terminal object because that
 * is what it is — and because it means a break-before-make switch can never
 * accidentally short NO to NC through the common terminal.
 */
export function changeover(common: string, no: string, nc: string, key = ''): ContactSpec[] {
  return [
    { key, a: common, b: no },
    { key, a: common, b: nc, normallyClosed: true },
  ];
}

/** A bank of independent single-pole switches, `sw1`…`swN`. */
export function switchBank(count: number, pinA: (i: number) => string, pinB: (i: number) => string): ContactSpec[] {
  const out: ContactSpec[] = [];
  for (let i = 1; i <= count; i++) {
    out.push({ key: `sw${i}`, a: pinA(i), b: pinB(i), label: `${i}` });
  }
  return out;
}
