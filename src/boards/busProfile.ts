// Where a board can actually put its I2C, SPI and UART lines.
//
// This exists because CircuitDesk told a Raspberry Pi Pico user that their
// LCD's SDA "should connect to the board's SDA (A4) pin". A4 is an Arduino Uno
// pin. The Pico has no A4, and GP4 — the pin they had used — is the Pico core's
// own default SDA. The advice was wrong in every part: wrong board, wrong pin,
// and wrong verdict.
//
// The cause was not a missing special case. It was that the check had no model
// of a board's bus capability at all, so the only thing it could name was the
// board CircuitDesk was built around. Adding "if Pico then GP4/GP5" would fix
// one board and leave every other one wrong, so the model is what is built here:
//
//     board instance -> processor profile -> which pads carry which signal
//         -> the board's own pad map -> its physical pin names -> verdict
//
// The middle two steps are what let a board nobody has ever added take part.
// The capability tables belong to the CHIP and live in processorProfiles.ts;
// this file knows only how to walk them and how to translate a pad into
// whatever the board in front of it calls that pin. On an Arduino Pico that
// translation is the identity — the pin is called GP4 and the pad is GP4. On a
// board somebody designed last week the pin is called SENSOR_SDA and the pad is
// GP4, and the verdict has to be the same one while the message uses the name
// printed on their silkscreen.
//
// Three verdicts, because there are three genuinely different situations and
// collapsing them is what produced the bad message:
//
//   * default   — the pin the core uses unless the sketch says otherwise.
//                 Nothing to report.
//   * alternate — the silicon can carry the line here, but the firmware has to
//                 say so. Worth telling the user, with the call that does it.
//   * incapable — the peripheral cannot reach this pad at all. A real error.
//
// The capability data is taken from the vendor's own sources, not inferred:
//
//   * RP2040 — the Arduino-Pico core's Wire/SPI/SerialUART setSDA/setSCL/setRX/
//     setTX/setSCK/setCS validity tables, which are the RP2040 datasheet's GPIO
//     function table expressed as code, plus each variant's pins_arduino.h for
//     the defaults (Wire is I2C0 on GP4/GP5).
//   * ESP32-C3 / C6 — the parts have a GPIO matrix, so any exposed GPIO can
//     carry any of these signals; the defaults come from the Arduino-ESP32
//     variant's pins_arduino.h.
//   * AVR — the TWI, SPI and USART lines are bonded to fixed pads and cannot
//     move, which is why those boards carry their pin lists as metadata.
//
// A pin only appears here if the board definition actually brings it out. The
// chip's capability is the upper bound; the header is what the user can wire to.

import type { BoardDefinition, PinCapability } from '../types';
import {
  processorProfile,
  type PeripheralController,
  type ProcessorProfile,
} from './processorProfiles';

export type BusLine =
  | 'i2c-sda'
  | 'i2c-scl'
  | 'spi-sck'
  | 'spi-mosi'
  | 'spi-miso'
  | 'spi-ss'
  | 'uart-tx'
  | 'uart-rx';

export const BUS_LINE_LABEL: Record<BusLine, string> = {
  'i2c-sda': 'SDA',
  'i2c-scl': 'SCL',
  'spi-sck': 'SCK',
  'spi-mosi': 'MOSI',
  'spi-miso': 'MISO',
  'spi-ss': 'CS',
  'uart-tx': 'TX',
  'uart-rx': 'RX',
};

/** The signal key a processor profile's controller uses for each line. */
const LINE_SIGNAL: Record<BusLine, string> = {
  'i2c-sda': 'sda',
  'i2c-scl': 'scl',
  'spi-sck': 'sck',
  'spi-mosi': 'mosi',
  'spi-miso': 'miso',
  'spi-ss': 'ss',
  'uart-tx': 'tx',
  'uart-rx': 'rx',
};

const I2C_LINES: BusLine[] = ['i2c-sda', 'i2c-scl'];
const SPI_LINES: BusLine[] = ['spi-sck', 'spi-mosi', 'spi-miso', 'spi-ss'];
const UART_LINES: BusLine[] = ['uart-tx', 'uart-rx'];

/** Which bus a line belongs to, for messages and for pairing checks. */
export function busOfLine(line: BusLine): 'i2c' | 'spi' | 'uart' {
  return line.startsWith('i2c') ? 'i2c' : line.startsWith('spi') ? 'spi' : 'uart';
}

/**
 * One hardware peripheral instance, as a sketch would name it.
 *
 * `name` is the object the user types — `Wire`, `Wire1`, `SPI`, `Serial1` —
 * because a message that says "use Wire1" is actionable and one that says
 * "use I2C controller 1" is not. `controllerId` keeps the chip's own name for
 * anything that needs to talk about the silicon.
 */
export interface BusChannel {
  name: string;
  controllerId: string;
  /** Board pin ids this channel can carry each line on. */
  pins: Partial<Record<BusLine, string[]>>;
  /** The pin the core uses for each line unless the sketch changes it. */
  defaults: Partial<Record<BusLine, string>>;
}

export interface BoardBusProfile {
  boardId: string;
  boardName: string;
  /**
   * How the lines get to the pads.
   *
   *   fixed   — bonded silicon, as on an AVR. There is nowhere else to put it.
   *   muxable — a fixed set of alternates chosen in firmware, as on an RP2040.
   *   matrix  — a full GPIO matrix, as on an ESP32: any exposed GPIO will do.
   */
  routing: 'fixed' | 'muxable' | 'matrix';
  channels: BusChannel[];
  /**
   * Board pin id -> processor pad, for the pins where the two differ.
   *
   * Empty for a board that names its pins after its pads, which every native
   * board does. Populated for a custom board, and it is what lets a message say
   * `MOTOR_PWM (GP15)` — the name the user gave the pin, and the pad that name
   * stands for, so the sentence is both recognisable and checkable.
   */
  padOfPin: Record<string, string>;
}

export type BusPinVerdict =
  | { kind: 'default'; channel: string }
  /** Legal, but the sketch has to ask for it. `configuration` is the call. */
  | { kind: 'alternate'; channel: string; configuration?: string }
  | { kind: 'incapable' };

/**
 * Defaults from the rpipico / rpipicow variant's pins_arduino.h.
 *
 * A variant fact rather than a chip fact — the RP2040 has no opinion about
 * which of its eight possible SDA pads Wire should start on, and the core's
 * variant header does. Keyed by the name a sketch uses, because that is what
 * the variant header is choosing for.
 */
const RP2040_VARIANT_DEFAULTS: Record<string, Partial<Record<BusLine, string>>> = {
  Wire: { 'i2c-sda': 'GP4', 'i2c-scl': 'GP5' },
  Wire1: { 'i2c-sda': 'GP26', 'i2c-scl': 'GP27' },
  SPI: { 'spi-miso': 'GP16', 'spi-ss': 'GP17', 'spi-sck': 'GP18', 'spi-mosi': 'GP19' },
  SPI1: { 'spi-miso': 'GP12', 'spi-ss': 'GP13', 'spi-sck': 'GP14', 'spi-mosi': 'GP15' },
  Serial1: { 'uart-tx': 'GP0', 'uart-rx': 'GP1' },
  Serial2: { 'uart-tx': 'GP8', 'uart-rx': 'GP9' },
};

/** Defaults from each Arduino-ESP32 variant's pins_arduino.h. */
const ESP_RISCV_DEFAULTS: Record<string, Partial<Record<BusLine, string>>> = {
  esp32c3: {
    'i2c-sda': 'IO8', 'i2c-scl': 'IO9',
    'spi-miso': 'IO5', 'spi-mosi': 'IO6', 'spi-sck': 'IO4', 'spi-ss': 'IO7',
    'uart-tx': 'IO21', 'uart-rx': 'IO20',
  },
  esp32c6: {
    'i2c-sda': 'IO23', 'i2c-scl': 'IO22',
    'spi-miso': 'IO20', 'spi-mosi': 'IO19', 'spi-sck': 'IO21', 'spi-ss': 'IO18',
    'uart-tx': 'IO16', 'uart-rx': 'IO17',
  },
};

/** How a sketch moves a line, per channel kind. */
function configurationCall(channel: string, line: BusLine, pinPad: string): string | undefined {
  switch (line) {
    case 'i2c-sda':
      return `${channel}.setSDA(${pinPad})`;
    case 'i2c-scl':
      return `${channel}.setSCL(${pinPad})`;
    case 'spi-sck':
      return `${channel}.setSCK(${pinPad})`;
    case 'spi-mosi':
      return `${channel}.setTX(${pinPad})`;
    case 'spi-miso':
      return `${channel}.setRX(${pinPad})`;
    case 'spi-ss':
      return `${channel}.setCS(${pinPad})`;
    case 'uart-tx':
      return `${channel}.setTX(${pinPad})`;
    case 'uart-rx':
      return `${channel}.setRX(${pinPad})`;
  }
}

// ---------------------------------------------------- pads to physical pins
//
// The one translation everything else is built on. A capability table is
// written in pads because pads are what the silicon has; a canvas, a wire and
// an error message are all in board pin ids because that is what the user
// sees. Every board answers the same two questions, and neither answer is
// guessed from the shape of a name.

interface PadResolver {
  /** Board pin ids that reach this pad, in the order the board lists them. */
  pinsFor(pad: string): string[];
  /** The pad a board pin reaches, when the board says so. */
  padOfPin: Record<string, string>;
  /** True when the board carries an explicit pin->pad map of its own. */
  mapped: boolean;
}

function padResolver(board: BoardDefinition): PadResolver {
  const declared = board.padMap ?? {};
  const byPad = new Map<string, string[]>();
  const order = new Map(board.pins.map((p, i) => [p.id, i]));
  for (const [pinId, pad] of Object.entries(declared)) {
    if (!order.has(pinId)) continue; // a stale mapping names a pin that is gone
    byPad.set(pad, [...(byPad.get(pad) ?? []), pinId]);
  }
  for (const list of byPad.values()) {
    list.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }

  return {
    mapped: byPad.size > 0,
    padOfPin: { ...declared },
    pinsFor(pad: string): string[] {
      const mapped = byPad.get(pad);
      if (mapped) return mapped;
      // A board that names its pins after the pads needs no map, and neither
      // does a pin that answers to the pad as an alias. This is the native
      // case: the Pico's GP4 pin IS pad GP4, and looking it up any other way
      // would be inventing a mapping that the board never stated.
      const out: string[] = [];
      for (const pin of board.pins) {
        if (pin.id === pad || (pin.aliases ?? []).includes(pad)) out.push(pin.id);
      }
      return out;
    },
  };
}

/**
 * How a pin should be named in a message: the maker's name, and the pad it is.
 *
 * `MOTOR_PWM (GP15)` on a custom board, `GP15` on a Pico — because on the Pico
 * repeating the name would be noise, and on the custom board leaving the pad
 * out would make the advice uncheckable against the datasheet.
 */
export function describeBusPin(profile: BoardBusProfile, pinId: string): string {
  const pad = profile.padOfPin[pinId];
  return pad && pad !== pinId ? `${pinId} (${pad})` : pinId;
}

// ------------------------------------------------------------- assembling

function channelFrom(
  controller: PeripheralController,
  lines: readonly BusLine[],
  resolver: PadResolver,
  variantDefaults?: Record<string, Partial<Record<BusLine, string>>>,
): BusChannel | undefined {
  const name = controller.arduinoName ?? controller.id;
  const pins: Partial<Record<BusLine, string[]>> = {};
  const defaults: Partial<Record<BusLine, string>> = {};
  let reachable = false;

  for (const line of lines) {
    const signal = LINE_SIGNAL[line];
    const pads = controller.signals[signal] ?? [];
    const ids = [...new Set(pads.flatMap((pad) => resolver.pinsFor(pad)))];
    pins[line] = ids;
    if (ids.length > 0) reachable = true;

    // The core's variant default first, the chip's own selection second. A
    // board that does not bring the default pad out simply has no default for
    // that line, which is the truth and not something to paper over.
    const defaultPad = variantDefaults?.[name]?.[line] ?? controller.defaults?.[signal];
    const resolved = defaultPad ? resolver.pinsFor(defaultPad) : [];
    if (resolved.length > 0 && ids.includes(resolved[0])) defaults[line] = resolved[0];
  }

  return reachable ? { name, controllerId: controller.id, pins, defaults } : undefined;
}

/**
 * The profile for any chip whose controllers state which pads they can reach.
 *
 * One function for the RP2040 and for every AVR, because the difference between
 * them is entirely in the data: an AVR controller lists one pad per signal and
 * so has no alternates to offer, while an RP2040 controller lists eight. The
 * `routing` a caller sees still differs, because "you cannot move this" and
 * "you can move this, in firmware" are different things to be told.
 */
function controllerProfile(
  board: BoardDefinition,
  processor: ProcessorProfile,
  resolver: PadResolver,
  routing: 'fixed' | 'muxable',
  variantDefaults?: Record<string, Partial<Record<BusLine, string>>>,
): BoardBusProfile | undefined {
  const channels: BusChannel[] = [];
  const add = (group: PeripheralController[], lines: readonly BusLine[]) => {
    for (const controller of group) {
      const channel = channelFrom(controller, lines, resolver, variantDefaults);
      if (channel) channels.push(channel);
    }
  };
  add(processor.i2c, I2C_LINES);
  add(processor.spi, SPI_LINES);
  add(processor.uarts, UART_LINES);
  if (channels.length === 0) return undefined;
  return {
    boardId: board.id,
    boardName: board.name,
    routing,
    channels,
    padOfPin: resolver.padOfPin,
  };
}

/**
 * The ESP32 RISC-V parts route peripherals through a GPIO matrix.
 *
 * Any GPIO the board brings out can carry any of these signals, so the honest
 * profile is "all of them" with the variant's defaults marked. Saying a pin is
 * incapable when the matrix can reach it would be the same class of mistake
 * this file exists to remove.
 *
 * The channels are named rather than derived from the processor profile's
 * controller lists, which are empty for these parts: the emulator models none
 * of these peripherals, so the chip profile claims none. Wiring is a question
 * about the silicon, not about the emulator, and the matrix is real whether or
 * not CircuitDesk executes anything through it.
 */
function matrixProfile(
  board: BoardDefinition,
  processor: ProcessorProfile,
  resolver: PadResolver,
  defaults: Partial<Record<BusLine, string>>,
): BoardBusProfile {
  const gpios = [...new Set(processor.pads.flatMap((pad) => resolver.pinsFor(pad)))];
  const channel = (name: string, controllerId: string, lines: readonly BusLine[]): BusChannel => ({
    name,
    controllerId,
    pins: Object.fromEntries(lines.map((line) => [line, gpios])) as Partial<Record<BusLine, string[]>>,
    defaults: Object.fromEntries(
      lines
        .map((line) => [line, resolver.pinsFor(defaults[line] ?? '')[0]])
        .filter(([, v]) => v !== undefined),
    ) as Partial<Record<BusLine, string>>,
  });
  return {
    boardId: board.id,
    boardName: board.name,
    routing: 'matrix',
    channels: [
      channel('Wire', 'i2c0', I2C_LINES),
      channel('SPI', 'spi2', SPI_LINES),
      channel('Serial1', 'uart1', UART_LINES),
    ],
    padOfPin: resolver.padOfPin,
  };
}

/**
 * Native AVR boards, whose lines are bonded silicon.
 *
 * These boards name their pins the way the Arduino core numbers them — A4, D20,
 * SDA — and carry no pad map, so the pin lists live in each board's metadata:
 * they are facts about that chip's packaging as that variant exposes it. There
 * are no alternates, so `pins` and `defaults` say the same thing, which is
 * exactly the truth about the hardware.
 *
 * A custom AVR board takes the other route — its pad map is explicit, so its
 * profile comes from the processor's controllers like every other custom board.
 */
function fixedProfile(board: BoardDefinition): BoardBusProfile | undefined {
  const meta = board.metadata as Record<string, unknown>;
  const i2c = (meta.i2cPins as string[] | undefined) ?? [];
  const spi = (meta.spiPins as string[] | undefined) ?? [];
  const uart = (meta.uartPins as string[] | undefined) ?? [];
  if (i2c.length === 0 && spi.length === 0 && uart.length === 0) return undefined;

  const exposed = new Set<string>();
  for (const pin of board.pins) {
    exposed.add(pin.id);
    for (const alias of pin.aliases ?? []) exposed.add(alias);
  }
  const keep = (ids: string[]) => ids.filter((id) => exposed.has(id));
  const channels: BusChannel[] = [];

  // The Uno lists SDA/SCL twice — as A4/A5 and as the dedicated SDA/SCL header
  // pins, which are the same pads bonded out at two places on the board. Both
  // are correct answers, so both are listed and the first is the default.
  const sda = keep(i2c.filter((id) => /^(A4|SDA|D20|D2)$/.test(id)));
  const scl = keep(i2c.filter((id) => /^(A5|SCL|D21|D3)$/.test(id)));
  if (sda.length > 0 || scl.length > 0) {
    channels.push({
      name: 'Wire',
      controllerId: 'twi0',
      pins: { 'i2c-sda': sda, 'i2c-scl': scl },
      defaults: { 'i2c-sda': sda[0], 'i2c-scl': scl[0] },
    });
  }

  if (spi.length > 0) {
    // The metadata lists the SPI group unordered and the order differs per
    // board, so the roles come from each pin's own declared capability rather
    // than from a position in the list.
    const byCap = (cap: PinCapability) =>
      keep(spi.filter((id) => board.pins.find((p) => p.id === id)?.capabilities.includes(cap)));
    const sck = byCap('spi-sck');
    const mosi = byCap('spi-mosi');
    const miso = byCap('spi-miso');
    const cs = byCap('spi-ss');
    if (sck.length + mosi.length + miso.length > 0) {
      channels.push({
        name: 'SPI',
        controllerId: 'spi0',
        pins: { 'spi-sck': sck, 'spi-mosi': mosi, 'spi-miso': miso, 'spi-ss': cs },
        defaults: { 'spi-sck': sck[0], 'spi-mosi': mosi[0], 'spi-miso': miso[0], 'spi-ss': cs[0] },
      });
    }
  }

  if (uart.length >= 2) {
    const tx = keep(uart.filter((id) => board.pins.find((p) => p.id === id)?.capabilities.includes('uart-tx')));
    const rx = keep(uart.filter((id) => board.pins.find((p) => p.id === id)?.capabilities.includes('uart-rx')));
    channels.push({
      name: 'Serial',
      controllerId: 'usart0',
      pins: { 'uart-tx': tx, 'uart-rx': rx },
      defaults: { 'uart-tx': tx[0], 'uart-rx': rx[0] },
    });
  }

  return { boardId: board.id, boardName: board.name, routing: 'fixed', channels, padOfPin: {} };
}

/**
 * The bus capability profile for a board, or undefined when none is known.
 *
 * Undefined matters: it means CircuitDesk does not know this board's bus
 * layout, and the caller must then say nothing rather than fall back to
 * another board's pins. That fallback is the bug this file replaces.
 *
 * Note what this function does NOT look at: the board's id. A custom board and
 * a native board reach the same code by the same route — the processor they
 * name and the pad map they carry — which is what makes "your board works like
 * ours" true rather than aspirational.
 */
export function getBoardBusProfile(board: BoardDefinition | undefined): BoardBusProfile | undefined {
  if (!board?.isBoard) return undefined;
  const processor = board.processorProfileId ? processorProfile(board.processorProfileId) : undefined;
  if (processor) {
    const resolver = padResolver(board);
    switch (processor.architecture) {
      case 'rp2040':
        return controllerProfile(board, processor, resolver, 'muxable', RP2040_VARIANT_DEFAULTS);
      case 'esp32c3':
      case 'esp32c6':
        return matrixProfile(board, processor, resolver, ESP_RISCV_DEFAULTS[processor.architecture] ?? {});
      case 'avr':
        // A pad map is the board telling us its own wiring; metadata pin lists
        // are the native variant's. Prefer the board's own statement.
        if (resolver.mapped) {
          return controllerProfile(board, processor, resolver, 'fixed') ?? fixedProfile(board);
        }
        return fixedProfile(board);
    }
  }
  return fixedProfile(board);
}

// ------------------------------------------------------------- classification

/** Channels on this board that can carry `line` on `pinId`. */
export function channelsCarrying(profile: BoardBusProfile, line: BusLine, pinId: string): BusChannel[] {
  return profile.channels.filter((c) => (c.pins[line] ?? []).includes(pinId));
}

/**
 * What this board makes of `line` being wired to `pinId`.
 *
 * A pin that is the default on any channel is a default — being able to reach
 * it another way as well does not make it something the user has to configure.
 */
export function classifyBusPin(profile: BoardBusProfile, line: BusLine, pinId: string): BusPinVerdict {
  const carrying = channelsCarrying(profile, line, pinId);
  if (carrying.length === 0) return { kind: 'incapable' };
  const asDefault = carrying.find((c) => c.defaults[line] === pinId);
  if (asDefault) return { kind: 'default', channel: asDefault.name };
  // On bonded silicon there are no alternates to choose between. An Uno's A4
  // and its dedicated SDA header pin are the same pad brought out twice, so
  // telling the user to configure one of them would be nonsense.
  if (profile.routing === 'fixed') return { kind: 'default', channel: carrying[0].name };
  const channel = carrying[0];
  return {
    kind: 'alternate',
    channel: channel.name,
    configuration: configurationCall(channel.name, line, padArgument(profile, pinId)),
  };
}

/**
 * The number a `setSDA()`-style call wants.
 *
 * It is the GPIO number, so it comes from the PAD — a custom board's
 * `SENSOR_SDA` yields 4 because the pad behind it is GP4, and a Pico's GP4
 * yields 4 because the pin is the pad. Guessing a number out of the pin's own
 * name would produce nonsense for exactly the boards this milestone is for.
 */
function padArgument(profile: BoardBusProfile, pinId: string): string {
  const pad = profile.padOfPin[pinId] ?? pinId;
  const match = /^(?:GP|IO|D|A)(\d+)$/.exec(pad);
  return match ? match[1] : pad;
}

/**
 * Channels that can carry every one of these line/pin pairs at once.
 *
 * SDA on one I2C controller and SCL on another is not a working bus, however
 * capable each pad is on its own — a check that looked at the two pins
 * separately would pass a circuit that cannot work.
 */
export function channelsCarryingAll(
  profile: BoardBusProfile,
  wiring: readonly { line: BusLine; pinId: string }[],
): BusChannel[] {
  return profile.channels.filter((c) => wiring.every((w) => (c.pins[w.line] ?? []).includes(w.pinId)));
}

/** Human-readable pin choices for a line, for a message that suggests a fix. */
export function suggestedPinsFor(profile: BoardBusProfile, line: BusLine, limit = 4): string[] {
  const out: string[] = [];
  for (const channel of profile.channels) {
    const preferred = channel.defaults[line];
    if (preferred && !out.includes(preferred)) out.push(preferred);
  }
  for (const channel of profile.channels) {
    for (const pin of channel.pins[line] ?? []) {
      if (!out.includes(pin)) out.push(pin);
      if (out.length >= limit) return out;
    }
  }
  return out.slice(0, limit);
}
