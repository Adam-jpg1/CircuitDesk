// The contract every board simulation engine satisfies.
//
// CircuitDesk executes firmware on more than one architecture, and the parts
// above the engine — the simulation controller, the circuit binding, the Pin
// States panel — have no business knowing which one is running. This is the
// seam: everything they need, expressed in units that mean the same thing on
// an AVR and on an RP2040.
//
// Two deliberate choices:
//
//   * Pins are addressed by the runner's own index, not by an "Arduino pin
//     number". An RP2040 has GP0..GP29 and no Arduino numbering at all, so
//     forcing one would mean inventing D0-D13 names that the hardware does not
//     have. `runnerPinIndex()` below performs the board-aware translation.
//
//   * Time is simulated milliseconds, not clock cycles. Cycles are meaningless
//     across architectures and the controller only ever wanted wall-clock
//     equivalence.
//
// This file is pure types plus a small pin-mapping function: it must stay free
// of engine imports so that importing it never pulls an emulator into the
// startup bundle.

import type { BoardDefinition } from '../types';
import { arduinoPinNumber, avrProfileFor } from '../boards/pinMaps';
import type { I2cBus } from './devices/i2cBus';
import type { SpiBus } from './devices/spiBus';

export type PinLevel = 'high' | 'low' | 'input' | 'input-pullup';

export interface PinSnapshot {
  /** Level per runner pin index. */
  states: PinLevel[];
  /** Measured duty over the last sample window (0..1), from real pad edges. */
  duty: number[];
  /** Last measured high-pulse width in microseconds, for servo-style signals. */
  pulseWidthUs: number[];
  /** Pad transitions since the run started. */
  toggles: number[];
}

export interface BoardRunner {
  readonly engine: 'avr8js' | 'rp2040js' | 'esp32c3';

  /** Advances the simulation by a slice of simulated time. Always bounded. */
  runFor(simMs: number): void;
  /** Simulated milliseconds since the run started. */
  readonly timeMs: number;

  digitalPinLevel(pin: number): PinLevel | undefined;
  isOutput(pin: number): boolean;
  /**
   * Drives a pin from the circuit. Engines that model pad pull resistors accept
   * null to mean "nothing is driving this pin any more".
   */
  setDigitalInput(pin: number, value: boolean | null): void;
  addPinListener(listener: (pin: number, high: boolean) => void): () => void;
  onPinChange: ((pin: number, high: boolean) => void) | null;

  adcChannelForPin(pin: number): number | undefined;
  setAnalogVolts(channel: number, volts: number): void;

  onSerialByte: ((byte: number) => void) | null;
  queueSerialInput(text: string): void;

  addMicrosecondEvent(us: number, callback: () => void): () => void;
  snapshot(): PinSnapshot;

  /** Present only on engines whose hardware buses are wired to device models. */
  readonly i2cBus?: I2cBus;
  readonly spiBus?: SpiBus;

  /**
   * The bus pins the firmware has actually muxed, in runner pin indices.
   *
   * Implemented by engines whose buses are not bonded to fixed pins. An AVR's
   * TWI and SPI lines are fixed silicon, so it omits these and the binding
   * falls back to the board's own map; an RP2040 can put either bus on several
   * pin groups, and a sketch chooses with Wire.setSDA() or SPI.setSCK().
   */
  activeI2cPins?(): { sda?: number; scl?: number };
  activeSpiPins?(): { sck?: number; mosi?: number; miso?: number; cs?: number };

  /**
   * Simulated milliseconds until this board's next internal event, if it knows.
   *
   * The shared timeline uses it to decide how far every board may safely
   * advance together. A board that answers lets the world stop exactly at the
   * moment something happens on it — which is what board-to-board UART, I2C and
   * SPI will need, since a bit period is far shorter than a scheduling slice.
   *
   * Optional, and omitting it costs only resolution: the world falls back to
   * its coarse slice, which is what engines that cannot answer already get.
   * Returning undefined means "nothing scheduled", not "nothing will happen".
   */
  nextEventMs?(): number | undefined;

  reset?(): void;
  dispose?(): void;
}

/**
 * Translates a board pin id into the index its runner uses.
 *
 * AVR boards use Arduino pin numbering, which is what avr8js's port map is
 * keyed by. The RP2040 has no Arduino numbering: GP15 is pin 15 because that
 * is the pad's name on the die, and `arduinoPinNumber()` deliberately refuses
 * to resolve GP pins so no AVR code path can ever claim one.
 */
export function runnerPinIndex(board: BoardDefinition, pinId: string): number | undefined {
  if (board.architecture === 'rp2040') return rp2040PinIndex(pinId);
  if (isEsp32C3(board)) return esp32c3PinIndex(pinId);
  return arduinoPinNumber(board, pinId);
}

/**
 * True for the ESP32-C3.
 *
 * The board's architecture is `esp32`, which is correct — the C3 is in that
 * family — but the family spans two entirely different instruction sets. The
 * variant is what says which, so it is what the runner dispatches on; keying
 * off the family alone would hand an Xtensa board to a RISC-V engine.
 */
export function isEsp32C3(board: BoardDefinition): boolean {
  return board.metadata?.variant === 'esp32c3';
}

/**
 * IO<n> is runner index n, which is the pad's own name on the die.
 *
 * The ESP32-C3 has no Arduino pin numbering, so there is nothing to translate
 * and nothing to invent. Power, ground and reset pins have no index, and the
 * legacy aliases old projects used resolve through the board definition before
 * ever reaching here.
 */
export function esp32c3PinIndex(pinId: string): number | undefined {
  const match = /^IO(\d{1,2})$/.exec(pinId);
  if (!match) return undefined;
  const index = Number(match[1]);
  return index >= 0 && index <= 21 ? index : undefined;
}

/** GP<n> is runner index n. Power, ground and debug pins have no index. */
export function rp2040PinIndex(pinId: string): number | undefined {
  const match = /^GP(\d{1,2})$/.exec(pinId);
  if (!match) return undefined;
  const index = Number(match[1]);
  return index >= 0 && index <= 29 ? index : undefined;
}

/** ADC channel reachable at a board pin, in that board's own numbering. */
export function runnerAdcChannel(board: BoardDefinition, pinId: string): number | undefined {
  // The C3's ADC is not modelled, so no pin claims a channel. Reporting one
  // and then returning an invented conversion would look like a working sensor
  // while telling the student nothing true.
  if (isEsp32C3(board)) return undefined;
  if (board.architecture === 'rp2040') {
    const index = rp2040PinIndex(pinId);
    if (index === undefined) return undefined;
    // ADC0..ADC3 are GP26..GP29 on the RP2040.
    const channel = index - 26;
    return channel >= 0 && channel <= 3 ? channel : undefined;
  }
  const profile = avrProfileFor(board);
  const pin = arduinoPinNumber(board, pinId);
  return (pin !== undefined ? profile?.portMap[pin]?.adcChannel : undefined) ?? profile?.adcOnlyChannels?.[pinId];
}

/** Full-scale ADC reference for a board, in volts. */
export function boardAdcReference(board: BoardDefinition): number {
  if (board.architecture === 'rp2040' || isEsp32C3(board)) return 3.3;
  return 5;
}

/** How many runner pin indices a board's engine exposes. */
export function runnerPinCount(board: BoardDefinition): number {
  if (board.architecture === 'rp2040') return 30;
  if (isEsp32C3(board)) return 22;
  return avrProfileFor(board)?.pinCount ?? 0;
}
