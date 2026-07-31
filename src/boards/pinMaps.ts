// Board-aware pin numbering and AVR port mapping. Replaces the previous
// hard-coded Uno assumptions: every consumer (simulator binding, validator,
// inspector, canvas, Pin States panel) resolves pins through the board's own
// definition instead of assuming the Uno layout.

import type { BoardDefinition } from '../types';

export interface AvrPortRef {
  port: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'J' | 'K' | 'L';
  index: number;
  /** ADC channel when the pin is analog-capable. */
  adcChannel?: number;
}

/** ATmega328P (Uno / Nano): D0-D7 → PD, D8-D13 → PB, A0-A5 → PC. */
function atmega328pMap(): Record<number, AvrPortRef> {
  const map: Record<number, AvrPortRef> = {};
  for (let i = 0; i <= 7; i++) map[i] = { port: 'D', index: i };
  for (let i = 8; i <= 13; i++) map[i] = { port: 'B', index: i - 8 };
  for (let i = 14; i <= 19; i++) map[i] = { port: 'C', index: i - 14, adcChannel: i - 14 };
  return map;
}

export interface AvrBoardProfile {
  mcu: string;
  /** Arduino pin number of A0 for this board (Uno/Nano 14, Leonardo 18, Mega 54). */
  analogPinBase: number;
  digitalPinCount: number;
  portMap: Record<number, AvrPortRef>;
  /** ADC-only channels with no digital function (Nano A6/A7). */
  adcOnlyChannels?: Record<string, number>;
}

const ATMEGA328P_UNO: AvrBoardProfile = {
  mcu: 'atmega328p',
  analogPinBase: 14,
  digitalPinCount: 14,
  portMap: atmega328pMap(),
};

const ATMEGA328P_NANO: AvrBoardProfile = {
  ...ATMEGA328P_UNO,
  // A6/A7 exist on the Nano as ADC-only inputs (no digital port behind them).
  adcOnlyChannels: { A6: 6, A7: 7 },
};

/** AVR simulation profiles, keyed by canonical board id. Only boards listed
 * here may run on the AVR8js engine — there is no fallback profile. */
export const AVR_BOARD_PROFILES: Record<string, AvrBoardProfile> = {
  'board.arduino-uno': ATMEGA328P_UNO,
  'board.arduino-nano': ATMEGA328P_NANO,
};

export function avrProfileFor(board: BoardDefinition | undefined | null): AvrBoardProfile | undefined {
  if (!board) return undefined;
  return AVR_BOARD_PROFILES[board.id];
}

/**
 * Board-aware "Arduino pin number" for a board pin id (e.g. "D13" → 13,
 * "A0" → analog base + 0). Only meaningful for AVR-architecture boards with
 * Arduino-style numbering; returns undefined for everything else (GP pins,
 * power pins, non-AVR boards) rather than guessing.
 */
export function arduinoPinNumber(board: BoardDefinition | undefined | null, pinId: string): number | undefined {
  if (!board || (board.architecture ?? 'other') !== 'avr') return undefined;
  const analogBase = Number(board.metadata.analogPinBase ?? 14);
  if (/^D\d+$/.test(pinId)) return Number(pinId.slice(1));
  if (/^A\d+$/.test(pinId)) return analogBase + Number(pinId.slice(1));
  if (pinId === 'SDA' && board.pins.some((p) => p.id === 'A4')) return analogBase + 4;
  if (pinId === 'SCL' && board.pins.some((p) => p.id === 'A5')) return analogBase + 5;
  return undefined;
}

/** Display label for an Arduino pin number on a given board. */
export function arduinoPinLabel(board: BoardDefinition, pin: number): string {
  const analogBase = Number(board.metadata.analogPinBase ?? 14);
  return pin >= analogBase ? `A${pin - analogBase}` : `D${pin}`;
}
