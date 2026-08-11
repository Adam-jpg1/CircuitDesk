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
//     board instance -> board definition -> bus capability profile
//         -> default and alternate pin mappings -> current wiring -> verdict
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
// Everything below is taken from the vendor's own sources, not inferred:
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

import type { BoardDefinition } from '../types';

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

/** Which bus a line belongs to, for messages and for pairing checks. */
export function busOfLine(line: BusLine): 'i2c' | 'spi' | 'uart' {
  return line.startsWith('i2c') ? 'i2c' : line.startsWith('spi') ? 'spi' : 'uart';
}

/**
 * One hardware peripheral instance, as a sketch would name it.
 *
 * `name` is the object the user types — `Wire`, `Wire1`, `SPI`, `Serial1` —
 * because a message that says "use Wire1" is actionable and one that says
 * "use I2C controller 1" is not.
 */
export interface BusChannel {
  name: string;
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
}

export type BusPinVerdict =
  | { kind: 'default'; channel: string }
  /** Legal, but the sketch has to ask for it. `configuration` is the call. */
  | { kind: 'alternate'; channel: string; configuration?: string }
  | { kind: 'incapable' };

// ------------------------------------------------------------- RP2040 tables
//
// From the Arduino-Pico core's own validity tables (libraries/Wire/src/Wire.cpp,
// libraries/SPI/src/SPI.cpp, cores/rp2040/SerialUART.cpp), RP2040 branch. These
// are pad numbers; only the ones a given board brings out survive into a
// profile.

const RP2040_I2C: { name: string; sda: number[]; scl: number[] }[] = [
  { name: 'Wire', sda: [0, 4, 8, 12, 16, 20, 24, 28], scl: [1, 5, 9, 13, 17, 21, 25, 29] },
  { name: 'Wire1', sda: [2, 6, 10, 14, 18, 22, 26], scl: [3, 7, 11, 15, 19, 23, 27] },
];

const RP2040_SPI: { name: string; miso: number[]; cs: number[]; sck: number[]; mosi: number[] }[] = [
  { name: 'SPI', miso: [0, 4, 16, 20], cs: [1, 5, 17, 21], sck: [2, 6, 18, 22], mosi: [3, 7, 19, 23] },
  { name: 'SPI1', miso: [8, 12, 24, 28], cs: [9, 13, 25, 29], sck: [10, 14, 26], mosi: [11, 15, 27] },
];

const RP2040_UART: { name: string; tx: number[]; rx: number[] }[] = [
  { name: 'Serial1', tx: [0, 12, 16, 28], rx: [1, 13, 17, 29] },
  { name: 'Serial2', tx: [4, 8, 20, 24], rx: [5, 9, 21, 25] },
];

/** Defaults from the rpipico / rpipicow variant's pins_arduino.h. */
const RP2040_DEFAULTS: Record<string, Partial<Record<BusLine, number>>> = {
  Wire: { 'i2c-sda': 4, 'i2c-scl': 5 },
  Wire1: { 'i2c-sda': 26, 'i2c-scl': 27 },
  SPI: { 'spi-miso': 16, 'spi-ss': 17, 'spi-sck': 18, 'spi-mosi': 19 },
  SPI1: { 'spi-miso': 12, 'spi-ss': 13, 'spi-sck': 14, 'spi-mosi': 15 },
  Serial1: { 'uart-tx': 0, 'uart-rx': 1 },
  Serial2: { 'uart-tx': 8, 'uart-rx': 9 },
};

/** Defaults from each Arduino-ESP32 variant's pins_arduino.h. */
const ESP_RISCV_DEFAULTS: Record<string, Partial<Record<BusLine, number>>> = {
  esp32c3: {
    'i2c-sda': 8, 'i2c-scl': 9,
    'spi-miso': 5, 'spi-mosi': 6, 'spi-sck': 4, 'spi-ss': 7,
    'uart-tx': 21, 'uart-rx': 20,
  },
  esp32c6: {
    'i2c-sda': 23, 'i2c-scl': 22,
    'spi-miso': 20, 'spi-mosi': 19, 'spi-sck': 21, 'spi-ss': 18,
    'uart-tx': 16, 'uart-rx': 17,
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

// ---------------------------------------------------------------- assembling

/** The pin ids a board actually exposes, including the aliases it accepts. */
function exposedPinIds(board: BoardDefinition): Set<string> {
  const ids = new Set<string>();
  for (const pin of board.pins) {
    ids.add(pin.id);
    for (const alias of pin.aliases ?? []) ids.add(alias);
  }
  return ids;
}

/** Keeps only pads the board brings out, named the way the board names them. */
function padsToPinIds(pads: number[], prefix: string, exposed: Set<string>): string[] {
  return pads.map((n) => `${prefix}${n}`).filter((id) => exposed.has(id));
}

function padDefault(
  pad: number | undefined,
  prefix: string,
  exposed: Set<string>,
): string | undefined {
  if (pad === undefined) return undefined;
  const id = `${prefix}${pad}`;
  return exposed.has(id) ? id : undefined;
}

function rp2040Profile(board: BoardDefinition): BoardBusProfile {
  const exposed = exposedPinIds(board);
  const channels: BusChannel[] = [];
  for (const bus of RP2040_I2C) {
    const d = RP2040_DEFAULTS[bus.name] ?? {};
    channels.push({
      name: bus.name,
      pins: {
        'i2c-sda': padsToPinIds(bus.sda, 'GP', exposed),
        'i2c-scl': padsToPinIds(bus.scl, 'GP', exposed),
      },
      defaults: {
        'i2c-sda': padDefault(d['i2c-sda'], 'GP', exposed),
        'i2c-scl': padDefault(d['i2c-scl'], 'GP', exposed),
      },
    });
  }
  for (const bus of RP2040_SPI) {
    const d = RP2040_DEFAULTS[bus.name] ?? {};
    channels.push({
      name: bus.name,
      pins: {
        'spi-miso': padsToPinIds(bus.miso, 'GP', exposed),
        'spi-mosi': padsToPinIds(bus.mosi, 'GP', exposed),
        'spi-sck': padsToPinIds(bus.sck, 'GP', exposed),
        'spi-ss': padsToPinIds(bus.cs, 'GP', exposed),
      },
      defaults: {
        'spi-miso': padDefault(d['spi-miso'], 'GP', exposed),
        'spi-mosi': padDefault(d['spi-mosi'], 'GP', exposed),
        'spi-sck': padDefault(d['spi-sck'], 'GP', exposed),
        'spi-ss': padDefault(d['spi-ss'], 'GP', exposed),
      },
    });
  }
  for (const bus of RP2040_UART) {
    const d = RP2040_DEFAULTS[bus.name] ?? {};
    channels.push({
      name: bus.name,
      pins: {
        'uart-tx': padsToPinIds(bus.tx, 'GP', exposed),
        'uart-rx': padsToPinIds(bus.rx, 'GP', exposed),
      },
      defaults: {
        'uart-tx': padDefault(d['uart-tx'], 'GP', exposed),
        'uart-rx': padDefault(d['uart-rx'], 'GP', exposed),
      },
    });
  }
  return { boardId: board.id, boardName: board.name, routing: 'muxable', channels };
}

/**
 * The ESP32 RISC-V parts route peripherals through a GPIO matrix.
 *
 * Any GPIO the board brings out can carry any of these signals, so the honest
 * profile is "all of them" with the variant's defaults marked. Saying a pin is
 * incapable when the matrix can reach it would be the same class of mistake
 * this file exists to remove.
 */
function espMatrixProfile(board: BoardDefinition, variant: string): BoardBusProfile {
  const exposed = exposedPinIds(board);
  const gpios = board.pins.filter((p) => /^IO\d+$/.test(p.id)).map((p) => p.id);
  const d = ESP_RISCV_DEFAULTS[variant] ?? {};
  const all = (line: BusLine): Partial<Record<BusLine, string[]>> => ({ [line]: gpios });
  const channel = (name: string, lines: BusLine[]): BusChannel => ({
    name,
    pins: Object.assign({}, ...lines.map(all)),
    defaults: Object.fromEntries(
      lines.map((line) => [line, padDefault(d[line], 'IO', exposed)]).filter(([, v]) => v !== undefined),
    ) as Partial<Record<BusLine, string>>,
  });
  return {
    boardId: board.id,
    boardName: board.name,
    routing: 'matrix',
    channels: [
      channel('Wire', ['i2c-sda', 'i2c-scl']),
      channel('SPI', ['spi-sck', 'spi-mosi', 'spi-miso', 'spi-ss']),
      channel('Serial1', ['uart-tx', 'uart-rx']),
    ],
  };
}

/**
 * AVR boards, whose lines are bonded silicon.
 *
 * The pin lists live in each board's metadata because they are facts about that
 * chip's packaging: A4/A5 on an Uno, D20/D21 on a Mega, D2/D3 on a Leonardo.
 * There are no alternates, so `pins` and `defaults` say the same thing — which
 * is exactly the truth about the hardware.
 */
function fixedProfile(board: BoardDefinition): BoardBusProfile | undefined {
  const meta = board.metadata as Record<string, unknown>;
  const i2c = (meta.i2cPins as string[] | undefined) ?? [];
  const spi = (meta.spiPins as string[] | undefined) ?? [];
  const uart = (meta.uartPins as string[] | undefined) ?? [];
  if (i2c.length === 0 && spi.length === 0 && uart.length === 0) return undefined;

  const exposed = exposedPinIds(board);
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
      pins: { 'i2c-sda': sda, 'i2c-scl': scl },
      defaults: { 'i2c-sda': sda[0], 'i2c-scl': scl[0] },
    });
  }

  if (spi.length > 0) {
    // The metadata lists the SPI group unordered and the order differs per
    // board, so the roles come from each pin's own declared capability rather
    // than from a position in the list.
    const byCap = (cap: string) =>
      keep(spi.filter((id) => board.pins.find((p) => p.id === id)?.capabilities.includes(cap)));
    const sck = byCap('spi-sck');
    const mosi = byCap('spi-mosi');
    const miso = byCap('spi-miso');
    const cs = byCap('spi-ss');
    if (sck.length + mosi.length + miso.length > 0) {
      channels.push({
        name: 'SPI',
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
      pins: { 'uart-tx': tx, 'uart-rx': rx },
      defaults: { 'uart-tx': tx[0], 'uart-rx': rx[0] },
    });
  }

  return { boardId: board.id, boardName: board.name, routing: 'fixed', channels };
}

/**
 * The bus capability profile for a board, or undefined when none is known.
 *
 * Undefined matters: it means CircuitDesk does not know this board's bus
 * layout, and the caller must then say nothing rather than fall back to
 * another board's pins. That fallback is the bug this file replaces.
 */
export function getBoardBusProfile(board: BoardDefinition | undefined): BoardBusProfile | undefined {
  if (!board?.isBoard) return undefined;
  if (board.architecture === 'rp2040') return rp2040Profile(board);
  const variant = (board.metadata?.variant as string | undefined) ?? '';
  if (variant in ESP_RISCV_DEFAULTS) return espMatrixProfile(board, variant);
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
    configuration:
      profile.routing === 'fixed' ? undefined : configurationCall(channel.name, line, padArgument(pinId)),
  };
}

/** The number a `setSDA()`-style call wants, from a board pin id like GP4. */
function padArgument(pinId: string): string {
  const match = /^(?:GP|IO|D|A)(\d+)$/.exec(pinId);
  return match ? match[1] : pinId;
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
