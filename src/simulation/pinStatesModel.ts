// Pin States panel model, generated from the selected board's own definition.
// Boards without genuine simulation support never display fake live states.

import type { BoardDefinition } from '../types';
import { avrProfileFor } from '../boards/pinMaps';
import { runnerPinIndex, runnerAdcChannel, isEsp32C3 } from './boardRunner';

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
  // Two passes so canonical names win over aliases (SDA/SCL → A4/A5 on AVR).
  // An RP2040 has no D#/A# names at all, and neither does an ESP32-C3, so
  // their pins pass through in definition order and are sorted by index below.
  const ordered = [
    ...board.pins.filter((p) => /^[DA]\d+$/.test(p.id)),
    ...board.pins.filter((p) => !/^[DA]\d+$/.test(p.id)),
  ];
  for (const pin of ordered) {
    // The pin index is resolved through the board's own architecture, so an
    // RP2040 row is GP15 → runner index 15 and never an AVR Arduino number.
    const n = runnerPinIndex(board, pin.id);
    const isLive =
      n !== undefined && (board.architecture === 'rp2040' || isEsp32C3(board) || profile?.portMap[n] !== undefined);
    if (isLive && !seen.has(n!)) {
      seen.add(n!);
      rows.push({ pin: n, label: pin.id });
    } else if (!isLive && runnerAdcChannel(board, pin.id) !== undefined) {
      // A pin with no digital state but a real ADC channel — the Nano's
      // A6/A7, which are analog-only inputs with no port bit behind them.
      rows.push({ label: pin.id, adcOnly: true });
    }
  }
  rows.sort((a, b) => (a.pin ?? 999) - (b.pin ?? 999));
  return { kind: 'pins', boardName: board.name, rows };
}

/** Live snapshot shape consumed by the panel (structural — no emulator import). */
export interface LivePinSnapshot {
  states: ('low' | 'high' | 'input' | 'input-pullup')[];
  duty: number[];
  pulseWidthUs: number[];
  toggles: number[];
}

export interface PinStateCell {
  label: string;
  /** 'unavailable' when this row has no entry in the active snapshot. */
  level: 'high' | 'low' | 'input' | 'input-pullup' | 'adc-only' | 'unavailable';
  text: string;
  /** Measured PWM duty, only when the pin is genuinely pulse-width modulated. */
  dutyPercent?: number;
  title: string;
}

/**
 * Maps one Pin States row onto the active snapshot.
 *
 * The row list comes from the board on the canvas while the snapshot comes
 * from the runner that is actually executing, so the two can disagree — a
 * 70-pin Mega model against a 20-entry Uno snapshot, for example. Rows with no
 * entry report "—" instead of borrowing another board's pin state (and instead
 * of throwing on an undefined value).
 */
export function pinStateCell(row: PinStateRow, snapshot: LivePinSnapshot | null | undefined): PinStateCell {
  if (row.pin === undefined) {
    return { label: row.label, level: 'adc-only', text: 'ADC', title: 'ADC-only input — no digital pin state' };
  }
  const state = snapshot?.states[row.pin];
  if (state === undefined) {
    return {
      label: row.label,
      level: 'unavailable',
      text: '—',
      title:
        'No live state for this pin in the running simulation. The firmware currently executing was built for a ' +
        'different board — recompile for the board on the canvas.',
    };
  }
  const duty = snapshot?.duty[row.pin] ?? 0;
  const toggles = snapshot?.toggles[row.pin] ?? 0;
  const isPwm = (state === 'high' || state === 'low') && duty > 0.02 && duty < 0.98;
  return {
    label: row.label,
    level: state,
    text: state === 'input-pullup' ? 'IN·PU' : state.toUpperCase().slice(0, 5),
    dutyPercent: isPwm ? duty * 100 : undefined,
    title: `${toggles} transitions since start`,
  };
}
