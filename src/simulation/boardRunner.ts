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
import { processorProfile } from '../boards/processorProfiles';
import { espAdcIndexForGpio } from './espRiscv/sarAdc';
import type { I2cBus } from './devices/i2cBus';
import type { SpiBus } from './devices/spiBus';

export type PinLevel = 'high' | 'low' | 'input' | 'input-pullup';

/** One more hardware UART, on fixed pins. */
export interface UartPort {
  /** The Arduino object it is, e.g. `Serial1`. */
  readonly name: string;
  /** Runner pin indices of its RX and TX pads. */
  readonly rxPin: number;
  readonly txPin: number;
  /** Bytes arriving on the RX pad from something wired to it. */
  receive(text: string): void;
  /** Bytes the firmware sends out of the TX pad. */
  onTransmit: ((byte: number) => void) | null;
  /** The baud the firmware programmed, read from the peripheral. */
  readonly baudRate: number;
}

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
  readonly engine: 'avr8js' | 'rp2040js' | 'esp32c3' | 'esp32c6' | 'samd21' | 'armv7m' | 'python';

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
  /**
   * Console output over the board's own USB, where it has one that is
   * modelled (a Pico's `Serial`). Monitor only: unlike `onSerialByte`, no
   * wire carries it, so nothing on the canvas may hear it.
   */
  onUsbSerialByte?: ((byte: number) => void) | null;
  /** Typed into the Serial Monitor: whatever the board's console is on the other end of. */
  queueSerialInput(text: string): void;
  /**
   * Bytes arriving on the board's UART RX pad from something wired to it — a
   * GPS, a modem, another board. Distinct from the monitor on boards whose
   * console is native USB (Leonardo, Pico, SAMD21): a GPS sentence on RX
   * belongs to Serial1 and must never appear at Serial.read(). Absent where
   * the console and the UART are the same port, and the monitor input is used.
   */
  queueUartInput?(text: string): void;

  /**
   * The baud the firmware configured its UART for, when the engine knows it.
   *
   * Optional because not every runner has a UART peripheral to ask — the ESP
   * parts have none at all, and a device must not be attached to a board that
   * cannot carry a byte. Absent means "this engine cannot tell you", which the
   * UART link treats as the default rather than as a mismatch.
   */
  readonly uartBaudRate?: number;

  /**
   * UARTs beyond the one above, on boards that have more than one modelled —
   * the Mega's Serial1, Serial2 and Serial3. A part wired to a port's pins
   * talks to that port and no other, as on the bench.
   */
  readonly extraUarts?: readonly UartPort[];

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
  // A board that carries a pad map is telling us what its pin reaches on the
  // die, and that is the only thing the emulator has ever known about. Without
  // this step a custom board's STATUS_LED resolves to nothing and the pin the
  // user sees never moves, however correctly the firmware drove pad 15.
  const pad = board.padMap?.[pinId] ?? pinId;
  if (board.architecture === 'rp2040') return rp2040PinIndex(pad);
  if (board.architecture === 'samd') return samdPadIndex(pad);
  if (board.architecture === 'sam') return portPadIndex(pad, 4, 32);
  if (board.architecture === 'stm32') return portPadIndex(pad, 8, 16);
  if (board.architecture === 'renesas') return renesasPadIndex(pad);
  if (board.architecture === 'nrf52') return nrfPadIndex(pad);
  if (board.architecture === 'imxrt') return imxrtPadIndex(pad);
  const espPads = ESP_RISCV_PAD_COUNT[espVariant(board)];
  if (espPads !== undefined) return espPadIndex(pad, espPads);
  return arduinoPinNumber(board, pinId);
}

/** P0.13 is 13 and P1.08 is 40 on the nRF52: port * 32 + pin. */
export function nrfPadIndex(pad: string): number | undefined {
  const match = /^P([01])\.(\d{1,2})$/.exec(pad);
  if (!match || Number(match[2]) > 31) return undefined;
  return Number(match[1]) * 32 + Number(match[2]);
}

/** GPIO2_03 on the i.MX RT is GPIO2 bit 3: (port - 1) * 32 + bit, GPIO1-5. */
export function imxrtPadIndex(pad: string): number | undefined {
  const match = /^GPIO([1-5])_(\d{2})$/.exec(pad);
  if (!match || Number(match[2]) > 31) return undefined;
  return (Number(match[1]) - 1) * 32 + Number(match[2]);
}

/** P<port><pin> on the RA4M1, P111 being port 1 pin 11: port * 16 + pin. */
export function renesasPadIndex(pad: string): number | undefined {
  const match = /^P(\d)(\d\d)$/.exec(pad);
  if (!match || Number(match[2]) > 15) return undefined;
  return Number(match[1]) * 16 + Number(match[2]);
}

/**
 * P<port><bit> pads as port * width + bit: PB27 on a SAM3X is 59. The ARM chips
 * here all name their pads this way, with ports of 32 (SAM3X) or 16 (STM32).
 */
export function portPadIndex(pad: string, ports: number, width: number): number | undefined {
  const match = /^P([A-Z])(\d{1,2})$/.exec(pad);
  if (!match) return undefined;
  const port = match[1].charCodeAt(0) - 65;
  const bit = Number(match[2]);
  if (port >= ports || bit >= width) return undefined;
  return port * width + bit;
}

/**
 * PA17 is 17 and PB08 is 40: group * 32 + bit, which is how the SAMD21 runner
 * numbers its pads. A board's labels reach these through its pad map.
 */
export function samdPadIndex(pad: string): number | undefined {
  const match = /^P([AB])(\d{2})$/.exec(pad);
  if (!match) return undefined;
  const bit = Number(match[2]);
  if (bit > 31) return undefined;
  return (match[1] === 'B' ? 32 : 0) + bit;
}

/**
 * The board's chip variant, as a string.
 *
 * `metadata` is `Record<string, unknown>`, so the variant has to be narrowed
 * before it can key anything — an unknown is not an index.
 */
function espVariant(board: BoardDefinition): string {
  const variant = board.metadata?.variant;
  if (typeof variant === 'string' && variant.length > 0) return variant;
  // A custom board names a processor rather than a variant, and for these
  // parts the processor IS the variant — an ESP32-C6 board is an esp32c6 one
  // whatever its maker called it. Derived rather than required, so nobody has
  // to type a magic string into a board file to get the right engine.
  const processor = board.processorProfileId ? processorProfile(board.processorProfileId) : undefined;
  const architecture = processor?.architecture;
  return architecture === 'esp32c3' || architecture === 'esp32c6' ? architecture : '';
}

/**
 * How many pads each Espressif RISC-V part has, by variant.
 *
 * `SOC_GPIO_PIN_COUNT`: 22 on the C3, 31 on the C6. A board brings out only
 * some of them, and the board definition is what decides which — this is only
 * the upper bound on what a pad name could legitimately mean.
 */
const ESP_RISCV_PAD_COUNT: Record<string, number | undefined> = {
  esp32c3: 22,
  esp32c6: 31,
};

/**
 * True for the ESP32-C3.
 *
 * The board's architecture is `esp32`, which is correct — the C3 is in that
 * family — but the family spans two entirely different instruction sets. The
 * variant is what says which, so it is what the runner dispatches on; keying
 * off the family alone would hand an Xtensa board to a RISC-V engine.
 */
export function isEsp32C3(board: BoardDefinition): boolean {
  return espVariant(board) === 'esp32c3';
}

/** True for the ESP32-C6, on the same reasoning as the C3. */
export function isEsp32C6(board: BoardDefinition): boolean {
  return espVariant(board) === 'esp32c6';
}

/** True for either Espressif RISC-V part this runtime executes. */
export function isEspRiscv(board: BoardDefinition): boolean {
  return ESP_RISCV_PAD_COUNT[espVariant(board)] !== undefined;
}

/**
 * IO<n> is runner index n, which is the pad's own name on the die.
 *
 * Neither Espressif RISC-V part has Arduino pin numbering, so there is nothing
 * to translate and nothing to invent — no D0, no A0, no GP0. Power, ground and
 * reset pins have no index, and the legacy aliases old projects used resolve
 * through the board definition before ever reaching here.
 */
export function espPadIndex(pinId: string, padCount: number): number | undefined {
  const match = /^IO(\d{1,2})$/.exec(pinId);
  if (!match) return undefined;
  const index = Number(match[1]);
  return index >= 0 && index < padCount ? index : undefined;
}

/** The ESP32-C3's 22 pads. */
export function esp32c3PinIndex(pinId: string): number | undefined {
  return espPadIndex(pinId, 22);
}

/** The ESP32-C6's 31 pads. */
export function esp32c6PinIndex(pinId: string): number | undefined {
  return espPadIndex(pinId, 31);
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
  // The SAR ADC's one-shot path is modelled on both Espressif RISC-V parts
  // (espRiscv/sarAdc.ts); a GPIO without an ADC channel claims none.
  if (isEspRiscv(board)) {
    const gpio = runnerPinIndex(board, pinId);
    return gpio === undefined ? undefined : espAdcIndexForGpio(espVariant(board), gpio);
  }
  if (board.architecture === 'samd') {
    // AIN<n> behind the pad the label reaches, from the chip's mux table.
    const pad = board.padMap?.[pinId] ?? pinId;
    return processorProfile('proc.samd21')?.adcChannels?.[pad];
  }
  if (board.architecture === 'sam') {
    const pad = board.padMap?.[pinId] ?? pinId;
    return processorProfile('proc.sam3x8e')?.adcChannels?.[pad];
  }
  if (board.architecture === 'stm32') {
    const pad = board.padMap?.[pinId] ?? pinId;
    return processorProfile('proc.stm32f401re')?.adcChannels?.[pad];
  }
  if (board.architecture === 'renesas') {
    const pad = board.padMap?.[pinId] ?? pinId;
    return processorProfile('proc.ra4m1')?.adcChannels?.[pad];
  }
  if (board.architecture === 'nrf52') {
    const pad = board.padMap?.[pinId] ?? pinId;
    return processorProfile(board.processorProfileId ?? 'proc.nrf52833')?.adcChannels?.[pad];
  }
  if (board.architecture === 'imxrt') {
    const pad = board.padMap?.[pinId] ?? pinId;
    return processorProfile('proc.imxrt1062')?.adcChannels?.[pad];
  }
  if (board.architecture === 'rp2040') {
    const index = rp2040PinIndex(board.padMap?.[pinId] ?? pinId);
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
  if (board.architecture === 'rp2040' || board.architecture === 'samd' || board.architecture === 'sam' || board.architecture === 'stm32' || board.architecture === 'nrf52' || board.architecture === 'imxrt' || isEspRiscv(board)) return 3.3;
  return 5;
}

/** How many runner pin indices a board's engine exposes. */
export function runnerPinCount(board: BoardDefinition): number {
  if (board.architecture === 'rp2040') return 30;
  // PA00-PA31 and PB00-PB31, as the SAMD21 runner numbers them.
  if (board.architecture === 'samd') return 64;
  // PA0-PD31 on the SAM3X.
  if (board.architecture === 'sam') return 128;
  // PA0-PH15 on the STM32F4, sixteen to a port.
  if (board.architecture === 'stm32') return 128;
  // P000-P915 on the RA4M1, sixteen to a port.
  if (board.architecture === 'renesas') return 160;
  // P0.00-P1.15 on the nRF52.
  if (board.architecture === 'nrf52') return 48;
  // GPIO1-GPIO5, thirty-two pads each, on the i.MX RT.
  if (board.architecture === 'imxrt') return 160;
  const espPads = ESP_RISCV_PAD_COUNT[espVariant(board)];
  if (espPads !== undefined) return espPads;
  return avrProfileFor(board)?.pinCount ?? 0;
}
