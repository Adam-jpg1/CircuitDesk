// Pin States panel model, generated from the selected board's own definition.
// Boards without genuine simulation support never display fake live states.

import type { BoardDefinition } from '../types';
import { arduinoPinNumber, avrProfileFor } from '../boards/pinMaps';

export interface PinStateRow {
  /** Emulator pin index (index into the live PinSnapshot arrays), if live-capable. */
  pin?: number;
  label: string;
  adcOnly?: boolean;
}

export type PinStatesModel =
  | { kind: 'no-board' }
  | { kind: 'not-simulated'; boardName: string }
  | { kind: 'pins'; boardName: string; rows: PinStateRow[] };

export function buildPinStatesModel(board: BoardDefinition | null | undefined): PinStatesModel {
  if (!board) return { kind: 'no-board' };
  if (!board.simulation?.supported) {
    return { kind: 'not-simulated', boardName: board.name };
  }
  const profile = avrProfileFor(board);
  const seen = new Set<number>();
  const rows: PinStateRow[] = [];
  // Two passes so canonical D#/A# names win over aliases (SDA/SCL → A4/A5).
  const ordered = [
    ...board.pins.filter((p) => /^[DA]\d+$/.test(p.id)),
    ...board.pins.filter((p) => !/^[DA]\d+$/.test(p.id)),
  ];
  for (const pin of ordered) {
    const n = arduinoPinNumber(board, pin.id);
    if (n !== undefined && profile?.portMap[n] && !seen.has(n)) {
      seen.add(n);
      rows.push({ pin: n, label: pin.id });
    } else if (profile?.adcOnlyChannels?.[pin.id] !== undefined) {
      rows.push({ label: pin.id, adcOnly: true });
    }
  }
  rows.sort((a, b) => (a.pin ?? 999) - (b.pin ?? 999));
  return { kind: 'pins', boardName: board.name, rows };
}
