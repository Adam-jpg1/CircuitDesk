// Board-aware pin numbering and AVR port mapping. Replaces the previous
// hard-coded Uno assumptions: every consumer (simulator binding, validator,
// inspector, canvas, Pin States panel) resolves pins through the board's own
// definition instead of assuming the Uno layout.
//
// This module is PURE DATA on purpose — it is imported by non-lazy UI code,
// so it must never import avr8js. The matching emulator peripheral
// configuration lives in simulation/avr/mcuConfig.ts, which is only reachable
// from the lazily-loaded simulator chunk.

import type { BoardDefinition } from '../types';

export type AvrPortName = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'J' | 'K' | 'L';

export interface AvrPortRef {
  port: AvrPortName;
  index: number;
  /** ADC channel when the pin is analog-capable. */
  adcChannel?: number;
}

export interface AvrBoardProfile {
  /** Canonical MCU id; selects the peripheral register/vector set. */
  mcu: 'atmega328p' | 'atmega2560' | 'atmega32u4';
  /** Highest valid data-space address (RAMEND). avr8js allocates 0x100 + sramBytes. */
  ramEnd: number;
  /** Flash size in bytes — firmware larger than this is rejected. */
  flashBytes: number;
  /** Arduino pin number of A0 for this board (Uno/Nano 14, Mega 54). */
  analogPinBase: number;
  digitalPinCount: number;
  /** Highest Arduino pin number + 1 (sizes pin snapshots). */
  pinCount: number;
  /** Ports this MCU exposes; only these are instantiated. */
  ports: AvrPortName[];
  portMap: Record<number, AvrPortRef>;
  /** ADC-only channels with no digital port behind them (Nano A6/A7). */
  adcOnlyChannels?: Record<string, number>;
  /** Peripherals present on the chip that CircuitDesk does NOT emulate. */
  unsupported: string[];
}

/** ATmega328P (Uno / Nano): D0-D7 → PD, D8-D13 → PB, A0-A5 → PC. */
function atmega328pMap(): Record<number, AvrPortRef> {
  const map: Record<number, AvrPortRef> = {};
  for (let i = 0; i <= 7; i++) map[i] = { port: 'D', index: i };
  for (let i = 8; i <= 13; i++) map[i] = { port: 'B', index: i - 8 };
  for (let i = 14; i <= 19; i++) map[i] = { port: 'C', index: i - 14, adcChannel: i - 14 };
  return map;
}

/**
 * ATmega2560 (Arduino Mega 2560) digital pin → port/bit mapping, matching the
 * `mega` variant's pins_arduino.h. Deliberately written out in full: the Mega
 * pinout is irregular (it hops across ports E/G/H/J/L) and must never be
 * derived from the Uno layout.
 */
function atmega2560Map(): Record<number, AvrPortRef> {
  const spec: [number, AvrPortName, number][] = [
    [0, 'E', 0], [1, 'E', 1], [2, 'E', 4], [3, 'E', 5], [4, 'G', 5], [5, 'E', 3],
    [6, 'H', 3], [7, 'H', 4], [8, 'H', 5], [9, 'H', 6],
    [10, 'B', 4], [11, 'B', 5], [12, 'B', 6], [13, 'B', 7],
    [14, 'J', 1], [15, 'J', 0], [16, 'H', 1], [17, 'H', 0],
    [18, 'D', 3], [19, 'D', 2], [20, 'D', 1], [21, 'D', 0],
    [22, 'A', 0], [23, 'A', 1], [24, 'A', 2], [25, 'A', 3],
    [26, 'A', 4], [27, 'A', 5], [28, 'A', 6], [29, 'A', 7],
    [30, 'C', 7], [31, 'C', 6], [32, 'C', 5], [33, 'C', 4],
    [34, 'C', 3], [35, 'C', 2], [36, 'C', 1], [37, 'C', 0],
    [38, 'D', 7], [39, 'G', 2], [40, 'G', 1], [41, 'G', 0],
    [42, 'L', 7], [43, 'L', 6], [44, 'L', 5], [45, 'L', 4],
    [46, 'L', 3], [47, 'L', 2], [48, 'L', 1], [49, 'L', 0],
    [50, 'B', 3], [51, 'B', 2], [52, 'B', 1], [53, 'B', 0],
  ];
  const map: Record<number, AvrPortRef> = {};
  for (const [pin, port, index] of spec) map[pin] = { port, index };
  // A0-A7 → PF0-PF7 (ADC0-7); A8-A15 → PK0-PK7 (ADC8-15, selected via MUX5).
  for (let i = 0; i < 8; i++) map[54 + i] = { port: 'F', index: i, adcChannel: i };
  for (let i = 0; i < 8; i++) map[62 + i] = { port: 'K', index: i, adcChannel: 8 + i };
  return map;
}

/**
 * ATmega32U4 (Arduino Leonardo) digital pin → port/bit mapping, matching the
 * `leonardo` variant's pins_arduino.h. Like the Mega this is written out in
 * full: the 32U4 pinout hops across ports B/C/D/E/F and shares nothing with
 * the 328P layout.
 *
 * A6-A11 are deliberately absent. On real hardware they are alternate ADC
 * functions of D4/D6/D8/D9/D10/D12 (channels 8-13) reached through MUX5, which
 * this engine cannot select on the 32U4 — see the unsupported list below.
 */
function atmega32u4Map(): Record<number, AvrPortRef> {
  const spec: [number, AvrPortName, number][] = [
    [0, 'D', 2], [1, 'D', 3], [2, 'D', 1], [3, 'D', 0], [4, 'D', 4],
    [5, 'C', 6], [6, 'D', 7], [7, 'E', 6],
    [8, 'B', 4], [9, 'B', 5], [10, 'B', 6], [11, 'B', 7],
    [12, 'D', 6], [13, 'C', 7],
    // ICSP / SPI pins (D17 = SS drives the RX LED and is not broken out).
    [14, 'B', 3], [15, 'B', 1], [16, 'B', 2], [17, 'B', 0],
  ];
  const map: Record<number, AvrPortRef> = {};
  for (const [pin, port, index] of spec) map[pin] = { port, index };
  // A0-A5 → PF7, PF6, PF5, PF4, PF1, PF0 = ADC7, 6, 5, 4, 1, 0.
  const analog: [number, number, number][] = [
    [18, 7, 7], [19, 6, 6], [20, 5, 5], [21, 4, 4], [22, 1, 1], [23, 0, 0],
  ];
  for (const [pin, index, adcChannel] of analog) map[pin] = { port: 'F', index, adcChannel };
  return map;
}

const ATMEGA328P_UNO: AvrBoardProfile = {
  mcu: 'atmega328p',
  ramEnd: 0x08ff, // 2 KB SRAM at 0x0100
  flashBytes: 32 * 1024,
  analogPinBase: 14,
  digitalPinCount: 14,
  pinCount: 20,
  ports: ['B', 'C', 'D'],
  portMap: atmega328pMap(),
  unsupported: ['EEPROM starts erased each time the simulation starts or is Reset (it keeps its contents for the whole run)'],
};

const ATMEGA328P_NANO: AvrBoardProfile = {
  ...ATMEGA328P_UNO,
  // A6/A7 exist on the Nano as ADC-only inputs (no digital port behind them).
  adcOnlyChannels: { A6: 6, A7: 7 },
};

const ATMEGA2560_MEGA: AvrBoardProfile = {
  mcu: 'atmega2560',
  // 8 KB SRAM starting at 0x0200 (the 2560 has extended I/O up to 0x01FF).
  ramEnd: 0x21ff,
  flashBytes: 256 * 1024,
  analogPinBase: 54,
  digitalPinCount: 54,
  pinCount: 70, // D0-D53 + A0-A15
  ports: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L'],
  portMap: atmega2560Map(),
  unsupported: [
    'EEPROM starts erased each time the simulation starts or is Reset (it keeps its contents for the whole run)',
  ],
};

const ATMEGA32U4_LEONARDO: AvrBoardProfile = {
  mcu: 'atmega32u4',
  // 2.5 KB SRAM at 0x0100 (extended I/O ends at 0x00FF).
  ramEnd: 0x0aff,
  flashBytes: 32 * 1024,
  analogPinBase: 18,
  digitalPinCount: 18,
  pinCount: 24, // D0-D17 + A0-A5
  ports: ['B', 'C', 'D', 'E', 'F'],
  portMap: atmega32u4Map(),
  unsupported: [
    'USB HID: Keyboard, Mouse and other native-USB libraries enumerate, but nothing reads their reports',
    'ADC channels 8-13 (the A6-A11 alternate functions of D4/D6/D8/D9/D10/D12) — MUX5 sits at a different ADCSRB bit on this MCU than the engine assumes',
    'EEPROM starts erased each time the simulation starts or is Reset (it keeps its contents for the whole run)',
    'Caterina bootloader, USB auto-reset and serial-port enumeration',
  ],
};

/** AVR simulation profiles, keyed by canonical board id. Only boards listed
 * here may run on the AVR8js engine — there is no fallback profile. */
export const AVR_BOARD_PROFILES: Record<string, AvrBoardProfile> = {
  'board.arduino-uno': ATMEGA328P_UNO,
  'board.arduino-nano': ATMEGA328P_NANO,
  'board.arduino-mega2560': ATMEGA2560_MEGA,
  'board.arduino-leonardo': ATMEGA32U4_LEONARDO,
};

/**
 * The machine profile for a PROCESSOR, which is what the emulator runs on.
 *
 * Keyed by chip rather than by board, because a memory map, a vector table and
 * a port layout belong to the silicon. A board somebody designed around an
 * ATmega328P and an Arduino Uno need the same machine; what differs between
 * them is the header labelling, which lives on the board.
 *
 * The variant each chip resolves to is the one its compile profile builds for,
 * so the Arduino pin numbering the firmware was compiled with is the numbering
 * the runner uses.
 */
const AVR_PROFILES_BY_PROCESSOR: Record<string, AvrBoardProfile> = {
  'proc.atmega328p': ATMEGA328P_UNO,
  'proc.atmega2560': ATMEGA2560_MEGA,
  'proc.atmega32u4': ATMEGA32U4_LEONARDO,
};

export function avrProfileForProcessor(processorProfileId: string | undefined): AvrBoardProfile | undefined {
  return processorProfileId ? AVR_PROFILES_BY_PROCESSOR[processorProfileId] : undefined;
}

export function avrProfileFor(board: BoardDefinition | undefined | null): AvrBoardProfile | undefined {
  if (!board) return undefined;
  // A board's own variant profile where it has one — the Nano's A6/A7 are real
  // and the Uno's profile does not have them — and the processor's otherwise,
  // which is the path a custom board takes.
  return AVR_BOARD_PROFILES[board.id] ?? avrProfileForProcessor(board.processorProfileId);
}

/**
 * Board-aware "Arduino pin number" for a board pin id (e.g. "D13" → 13,
 * "A0" → analog base + 0). Only meaningful for AVR-architecture boards with
 * Arduino-style numbering; returns undefined for everything else (GP pins,
 * power pins, non-AVR boards) rather than guessing.
 */
export function avrPinNumberForPad(profile: AvrBoardProfile, pad: string): number | undefined {
  const match = /^P([A-L])(\d)$/.exec(pad);
  if (!match) return undefined;
  const port = match[1] as AvrPortName;
  const index = Number(match[2]);
  for (const [number, ref] of Object.entries(profile.portMap)) {
    if (ref.port === port && ref.index === index) return Number(number);
  }
  return undefined;
}

export function arduinoPinNumber(board: BoardDefinition | undefined | null, pinId: string): number | undefined {
  if (!board || (board.architecture ?? 'other') !== 'avr') return undefined;
  // A board that states which pad a pin reaches has said everything there is
  // to say, and it is said first: a maker who labels a pin D13 and wires it to
  // PB3 means PB3, and reading the label instead would drive the wrong port.
  // The number comes from the variant the firmware was compiled for, because
  // that numbering is the one the sketch's digitalWrite() went through.
  const pad = board.padMap?.[pinId];
  if (pad !== undefined) {
    const profile = avrProfileFor(board);
    return profile ? avrPinNumberForPad(profile, pad) : undefined;
  }
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
