import type { BoardDefinition, PinDefinition, SupportLevel } from '../types';
import { BOARD_CAPABILITIES } from './capabilities';
import { deriveBoardSupportLevel } from '../project/support';
import { ARDUINO_UNO } from './unoDefinition';
import { ARDUINO_MEGA } from './megaDefinition';
import { ARDUINO_LEONARDO } from './leonardoDefinition';
import { MM, pinRow, pinAt, gpio, analog, gnd, p5v, p3v3, vin, reset, type PinSpec } from './pinHelpers';

interface HeaderBoardSpec {
  id: string;
  name: string;
  family: string;
  processor: string;
  widthMm: number;
  heightMm: number;
  left: (PinSpec | null)[];
  right: (PinSpec | null)[];
  supportLevel: SupportLevel;
  logicVoltage: number;
  color?: string;
  usb?: 'micro' | 'usb-c' | 'mini' | 'none';
  description?: string;
  metadata?: Record<string, unknown>;
  /** Pads off the edge headers, each one pitch inboard of the header pin it sits beside. */
  inner?: { spec: PinSpec; beside: string }[];
}

/** Generic dual-row module (DevKit style): pins run down the left and right edges. */
function headerBoard(spec: HeaderBoardSpec): BoardDefinition {
  const marginTop = (spec.heightMm - (Math.max(spec.left.length, spec.right.length) - 1) * 2.54) / 2;
  const pins: PinDefinition[] = [
    ...pinRow(spec.left, 1.8, marginTop, false),
    ...pinRow(spec.right, spec.widthMm - 1.8, marginTop, false),
  ];
  for (const { spec: pad, beside } of spec.inner ?? []) {
    const anchor = pins.find((p) => p.id === beside);
    if (!anchor) throw new Error(`${spec.id}: inner pad ${pad.id} is beside ${beside}, which is not a pin`);
    const inward = anchor.x > (spec.widthMm * MM) / 2 ? -2.54 : 2.54;
    pins.push(pinAt(pad, anchor.x / MM + inward, anchor.y / MM));
  }
  return {
    id: spec.id,
    name: spec.name,
    family: spec.family,
    processor: spec.processor,
    widthMm: spec.widthMm,
    heightMm: spec.heightMm,
    artwork: { kind: 'builtin', builtinId: 'generic-module' },
    pins,
    supportLevel: spec.supportLevel,
    isBoard: true,
    description: spec.description,
    metadata: {
      logicVoltage: spec.logicVoltage,
      color: spec.color ?? '#0b3d2e',
      usb: spec.usb ?? 'micro',
      ...spec.metadata,
    },
  };
}

const g3 = (id: string, label: string, extra: Partial<PinSpec> = {}) =>
  gpio(id, label, ['digital-in', 'digital-out', 'pwm'], 3.3, extra);
const a3 = (id: string, label: string) => analog(id, label, 3.3);

export const ARDUINO_NANO = headerBoard({
  id: 'board.arduino-nano',
  name: 'Arduino Nano',
  family: 'Arduino AVR',
  processor: 'ATmega328P',
  widthMm: 18,
  heightMm: 43.2,
  supportLevel: 'compile',
  logicVoltage: 5,
  color: '#0b3d5e',
  usb: 'mini',
  description:
    'Arduino Nano — ATmega328P board. Fully simulated with its own pin profile (A6/A7 are ADC-only, as on real hardware) and compiled as arduino:avr:nano.',
  left: [
    gpio('D1', 'TX1', ['digital-in', 'digital-out', 'uart-tx']),
    gpio('D0', 'RX0', ['digital-in', 'digital-out', 'uart-rx']),
    reset('RESET'),
    gnd('GND1'),
    gpio('D2', 'D2', ['digital-in', 'digital-out', 'interrupt']),
    gpio('D3', 'D3', ['digital-in', 'digital-out', 'pwm', 'interrupt']),
    gpio('D4', 'D4'),
    gpio('D5', 'D5', ['digital-in', 'digital-out', 'pwm']),
    gpio('D6', 'D6', ['digital-in', 'digital-out', 'pwm']),
    gpio('D7', 'D7'),
    gpio('D8', 'D8'),
    gpio('D9', 'D9', ['digital-in', 'digital-out', 'pwm']),
    gpio('D10', 'D10', ['digital-in', 'digital-out', 'pwm', 'spi-ss']),
    gpio('D11', 'D11', ['digital-in', 'digital-out', 'pwm', 'spi-mosi']),
    gpio('D12', 'D12', ['digital-in', 'digital-out', 'spi-miso']),
  ],
  right: [
    vin('VIN'),
    gnd('GND2'),
    reset('RESET2', 'RESET'),
    p5v('5V'),
    // ADC6 and ADC7 have no digital buffer on the ATmega328P: analogRead only.
    analog('A7', 'A7', 5, { caps: ['analog-in'] }),
    analog('A6', 'A6', 5, { caps: ['analog-in'] }),
    analog('A5', 'A5'),
    analog('A4', 'A4'),
    analog('A3', 'A3'),
    analog('A2', 'A2'),
    analog('A1', 'A1'),
    analog('A0', 'A0'),
    { id: 'AREF', label: 'AREF', type: 'aref' as const, caps: [] },
    p3v3('3V3'),
    gpio('D13', 'D13', ['digital-in', 'digital-out', 'spi-sck']),
  ],
});

export const ESP32_DEVKIT = headerBoard({
  id: 'board.esp32-devkit',
  name: 'ESP32 DevKit V1',
  family: 'Espressif',
  processor: 'ESP32-WROOM-32',
  widthMm: 28.5,
  heightMm: 52,
  supportLevel: 'validation',
  logicVoltage: 3.3,
  color: '#12262e',
  description:
    '3.3 V logic Wi-Fi/BT board. Wiring and electrical validation are supported; firmware simulation for the Xtensa core is not implemented, so it is honestly labeled validation-level.',
  left: [
    { id: 'EN', label: 'EN', type: 'reset' as const, caps: [] },
    a3('VP', 'VP'), a3('VN', 'VN'), a3('D34', 'D34'), a3('D35', 'D35'),
    g3('D32', 'D32'), g3('D33', 'D33'), g3('D25', 'D25'), g3('D26', 'D26'), g3('D27', 'D27'),
    g3('D14', 'D14'), g3('D12', 'D12'), gnd('GND1'), g3('D13', 'D13'),
    p5v('VIN_5V', '5V'),
  ],
  right: [
    p3v3('3V3'), gnd('GND2'),
    g3('D15', 'D15'), g3('D2', 'D2'), g3('D4', 'D4'),
    g3('RX2', 'RX2', { caps: ['digital-in', 'digital-out', 'uart-rx'] }),
    g3('TX2', 'TX2', { caps: ['digital-in', 'digital-out', 'uart-tx'] }),
    g3('D5', 'D5'), g3('D18', 'D18', { caps: ['digital-in', 'digital-out', 'spi-sck'] }),
    g3('D19', 'D19', { caps: ['digital-in', 'digital-out', 'spi-miso'] }),
    g3('D21', 'D21', { caps: ['digital-in', 'digital-out', 'i2c-sda'] }),
    g3('RX0', 'RX0', { caps: ['digital-in', 'digital-out', 'uart-rx'] }),
    g3('TX0', 'TX0', { caps: ['digital-in', 'digital-out', 'uart-tx'] }),
    g3('D22', 'D22', { caps: ['digital-in', 'digital-out', 'i2c-scl'] }),
    g3('D23', 'D23', { caps: ['digital-in', 'digital-out', 'spi-mosi'] }),
  ],
});

export const PICO = headerBoard({
  id: 'board.raspberry-pi-pico',
  name: 'Raspberry Pi Pico',
  family: 'Raspberry Pi',
  processor: 'RP2040',
  widthMm: 21,
  heightMm: 51,
  supportLevel: 'validation',
  logicVoltage: 3.3,
  color: '#1a4232',
  description:
    'RP2040 board with 3.3 V logic and GP0-GP28 pins (GP26-28 are the ADC channels). Compiles for the real RP2040 target — never through the AVR toolchain — and runs that firmware instruction by instruction, including GPIO, ADC, UART0, I2C and SPI.',
  left: [
    g3('GP0', 'GP0', { caps: ['digital-in', 'digital-out', 'uart-tx', 'i2c-sda', 'pwm'] }),
    g3('GP1', 'GP1', { caps: ['digital-in', 'digital-out', 'uart-rx', 'i2c-scl', 'pwm'] }),
    gnd('GND1'),
    g3('GP2', 'GP2'), g3('GP3', 'GP3'), g3('GP4', 'GP4'), g3('GP5', 'GP5'),
    gnd('GND2'),
    g3('GP6', 'GP6'), g3('GP7', 'GP7'), g3('GP8', 'GP8'), g3('GP9', 'GP9'),
    gnd('GND3'),
    g3('GP10', 'GP10'), g3('GP11', 'GP11'), g3('GP12', 'GP12'), g3('GP13', 'GP13'),
    gnd('GND4'),
    g3('GP14', 'GP14'), g3('GP15', 'GP15'),
  ],
  right: [
    { ...p5v('VBUS', 'VBUS'), voltage: 5 },
    vin('VSYS', 'VSYS'),
    gnd('GND5'),
    { id: 'EN3V3', label: '3V3_EN', type: 'digital' as const, caps: ['digital-in' as const], voltage: 3.3 },
    p3v3('3V3'),
    { id: 'ADC_VREF', label: 'ADC_VREF', type: 'aref' as const, caps: [] },
    a3('GP28', 'GP28'),
    gnd('AGND', 'AGND'),
    a3('GP27', 'GP27'), a3('GP26', 'GP26'),
    { id: 'RUN', label: 'RUN', type: 'reset' as const, caps: ['digital-in' as const] },
    g3('GP22', 'GP22'),
    gnd('GND6'),
    g3('GP21', 'GP21', { caps: ['digital-in', 'digital-out', 'i2c-scl'] }),
    g3('GP20', 'GP20', { caps: ['digital-in', 'digital-out', 'i2c-sda'] }),
    g3('GP19', 'GP19', { caps: ['digital-in', 'digital-out', 'spi-mosi'] }),
    g3('GP18', 'GP18', { caps: ['digital-in', 'digital-out', 'spi-sck'] }),
    gnd('GND7'),
    g3('GP17', 'GP17'), g3('GP16', 'GP16', { caps: ['digital-in', 'digital-out', 'spi-miso'] }),
  ],
});

/**
 * Boards that are a different product carrying a chip CircuitDesk already runs.
 *
 * These cost almost nothing to support and are the point of keeping board,
 * processor, toolchain and runtime as four separate things: the RP2040 on a
 * XIAO is the RP2040 on a Pico, so the emulator, the toolchain and every
 * device model already work. What differs is the product — its name, its
 * outline, its pin count, and the names printed beside the pads.
 *
 * The XIAO is the interesting one. Its silkscreen says D0-D10, but those pads
 * are GP26, GP27, GP28, GP29, GP6, GP7, GP0, GP1, GP2, GP4 and GP3. Firmware
 * is written against the pad; the user wires to the label; `padMap` is what
 * keeps the two attached, exactly as it does for a board somebody brought in
 * themselves.
 */
export const XIAO_RP2040 = headerBoard({
  id: 'board.seeed-xiao-rp2040',
  name: 'Seeed XIAO RP2040',
  family: 'Seeed Studio',
  processor: 'RP2040',
  widthMm: 17.5,
  heightMm: 21,
  supportLevel: 'validation',
  logicVoltage: 3.3,
  color: '#1d1f22',
  description:
    'A thumbnail-sized RP2040 board. The silkscreen numbers its pins D0-D10; the pads behind them are GP26, GP27, '
    + 'GP28, GP29, GP6, GP7, GP0, GP1, GP2, GP4 and GP3, which is what firmware addresses. Runs real RP2040 '
    + 'firmware on the same emulator a Pico does.',
  left: [
    a3('D0', 'D0'), a3('D1', 'D1'), a3('D2', 'D2'), a3('D3', 'D3'),
    g3('D4', 'D4', { caps: ['digital-in', 'digital-out', 'i2c-sda'] }),
    g3('D5', 'D5', { caps: ['digital-in', 'digital-out', 'i2c-scl'] }),
    g3('D6', 'D6', { caps: ['digital-in', 'digital-out', 'uart-tx'] }),
  ],
  right: [
    { ...p5v('V5', '5V'), voltage: 5 },
    gnd('GND1'),
    p3v3('3V3'),
    g3('D10', 'D10', { caps: ['digital-in', 'digital-out', 'spi-mosi'] }),
    g3('D9', 'D9', { caps: ['digital-in', 'digital-out', 'spi-miso'] }),
    g3('D8', 'D8', { caps: ['digital-in', 'digital-out', 'spi-sck'] }),
    g3('D7', 'D7', { caps: ['digital-in', 'digital-out', 'uart-rx'] }),
  ],
});

export const ESP32_C3_SUPERMINI = headerBoard({
  id: 'board.esp32-c3-supermini',
  name: 'ESP32-C3 SuperMini',
  family: 'Espressif',
  processor: 'ESP32-C3',
  widthMm: 18,
  heightMm: 22.5,
  supportLevel: 'validation',
  logicVoltage: 3.3,
  color: '#1b2a36',
  description:
    'A widely cloned ESP32-C3 board the size of a postage stamp. The RISC-V core executes the compiled '
    + 'application image for real, with GPIO and Serial; Wi-Fi, Bluetooth, the ADC, PWM, I2C and SPI are not simulated.',
  left: [
    g3('IO5', 'IO5'), g3('IO6', 'IO6'), g3('IO7', 'IO7'),
    g3('IO8', 'IO8', { caps: ['digital-in', 'digital-out', 'i2c-sda'] }),
    g3('IO9', 'IO9', { caps: ['digital-in', 'digital-out', 'i2c-scl'] }),
    g3('IO10', 'IO10'),
    g3('IO20', 'IO20', { caps: ['digital-in', 'digital-out', 'uart-rx'] }),
    g3('IO21', 'IO21', { caps: ['digital-in', 'digital-out', 'uart-tx'] }),
  ],
  right: [
    gnd('GND1'),
    p3v3('3V3'),
    { ...p5v('V5', '5V'), voltage: 5 },
    a3('IO4', 'IO4'), a3('IO3', 'IO3'), a3('IO2', 'IO2'),
    g3('IO1', 'IO1'), g3('IO0', 'IO0'),
  ],
});

export const PRO_MINI = headerBoard({
  id: 'board.arduino-pro-mini',
  name: 'Arduino Pro Mini (5V, 16 MHz)',
  family: 'Arduino',
  processor: 'ATmega328P',
  widthMm: 18,
  heightMm: 33,
  supportLevel: 'validation',
  logicVoltage: 5,
  color: '#1c3f5a',
  description:
    'The same ATmega328P an Uno carries, with no USB and no regulator worth speaking of, and two more analog '
    + 'inputs (A6, A7) the Uno does not bring out. Built as itself (arduino:avr:pro) and run on the same AVR '
    + 'emulator.',
  left: [
    gpio('D1', 'TXO', ['digital-in', 'digital-out', 'uart-tx']),
    gpio('D0', 'RXI', ['digital-in', 'digital-out', 'uart-rx']),
    { id: 'RST1', label: 'RST', type: 'reset' as const, caps: ['digital-in' as const] },
    gnd('GND1'),
    gpio('D2', 'D2', ['digital-in', 'digital-out', 'interrupt']),
    gpio('D3', 'D3', ['digital-in', 'digital-out', 'pwm', 'interrupt']),
    gpio('D4', 'D4'),
    gpio('D5', 'D5', ['digital-in', 'digital-out', 'pwm']),
    gpio('D6', 'D6', ['digital-in', 'digital-out', 'pwm']),
    gpio('D7', 'D7'),
    gpio('D8', 'D8'),
    gpio('D9', 'D9', ['digital-in', 'digital-out', 'pwm']),
  ],
  right: [
    { ...p5v('VCC', 'VCC'), voltage: 5 },
    gnd('GND2'),
    { ...p5v('RAW', 'RAW'), voltage: 5 },
    analog('A3', 'A3'), analog('A2', 'A2'), analog('A1', 'A1'), analog('A0', 'A0'),
    gpio('D13', 'D13', ['digital-in', 'digital-out', 'spi-sck']),
    gpio('D12', 'D12', ['digital-in', 'digital-out', 'spi-miso']),
    gpio('D11', 'D11', ['digital-in', 'digital-out', 'pwm', 'spi-mosi']),
    gpio('D10', 'D10', ['digital-in', 'digital-out', 'pwm', 'spi-ss']),
    // A4/A5 carry the TWI lines on this chip, as they do on an Uno.
    analog('A5', 'A5', 5, { caps: ['analog-in', 'digital-in', 'digital-out', 'i2c-scl'] }),
    analog('A4', 'A4', 5, { caps: ['analog-in', 'digital-in', 'digital-out', 'i2c-sda'] }),
  ],
  // A6 and A7 are the two inner pads beside A5 and A4, off the edge headers.
  // Analog only, as on every ATmega328P.
  inner: [
    { spec: analog('A6', 'A6', 5, { caps: ['analog-in'] }), beside: 'A5' },
    { spec: analog('A7', 'A7', 5, { caps: ['analog-in'] }), beside: 'A4' },
  ],
});

function simpleWiringBoard(
  id: string,
  name: string,
  family: string,
  processor: string,
  widthMm: number,
  heightMm: number,
  logicVoltage: number,
  left: (PinSpec | null)[],
  right: (PinSpec | null)[],
  supportLevel: SupportLevel = 'wiring',
  extra: Partial<HeaderBoardSpec> = {},
): BoardDefinition {
  return headerBoard({
    id, name, family, processor, widthMm, heightMm, left, right, supportLevel, logicVoltage,
    description:
      extra.description ??
      `${name} — visual and wiring support with pin metadata. Firmware simulation is not implemented for this board; the support badge reflects that honestly.`,
    ...extra,
  });
}

const seqPins = (prefix: string, from: number, to: number, v: number): PinSpec[] => {
  const out: PinSpec[] = [];
  for (let i = from; i <= to; i++) out.push(g3(`${prefix}${i}`, `${prefix}${i}`));
  return out.map((p) => ({ ...p, voltage: v }));
};

const RAW_BOARD_DEFINITIONS: BoardDefinition[] = [
  ARDUINO_UNO,
  ARDUINO_NANO,
  ARDUINO_MEGA,
  ARDUINO_LEONARDO,
  PRO_MINI,
  XIAO_RP2040,
  ESP32_C3_SUPERMINI,
  simpleWiringBoard(
    'board.arduino-due', 'Arduino Due', 'Arduino ARM', 'AT91SAM3X8E', 101.5, 53.3, 3.3,
    [...seqPins('D', 22, 39, 3.3).slice(0, 16), gnd('GNDL'), p3v3('3V3L')],
    [...seqPins('D', 40, 53, 3.3), gnd('GNDR'), p5v('5VR'), vin('VINR'), reset('RESET')],
    'wiring', { color: '#0b3d5e', description: 'Due — 3.3 V logic ARM board. Wiring + validation (3.3 V rules apply). No simulation.' },
  ),
  simpleWiringBoard(
    'board.arduino-uno-r4', 'Arduino Uno R4 Minima', 'Arduino Renesas', 'RA4M1 (Cortex-M4)', 68.6, 53.4, 5,
    [gpio('D0', 'RX0', ['digital-in', 'digital-out', 'uart-rx']), gpio('D1', 'TX1', ['digital-in', 'digital-out', 'uart-tx']), gpio('D2', 'D2'), gpio('D3', 'D3'), gpio('D4', 'D4'), gpio('D5', 'D5'), gpio('D6', 'D6'), gpio('D7', 'D7'), gpio('D8', 'D8'), gpio('D9', 'D9'), gpio('D10', 'D10'), gpio('D11', 'D11'), gpio('D12', 'D12'), gpio('D13', 'D13')],
    [p5v('5V'), p3v3('3V3'), gnd('GND1'), gnd('GND2'), vin('VIN'), analog('A0', 'A0'), analog('A1', 'A1'), analog('A2', 'A2'), analog('A3', 'A3'), analog('A4', 'A4'), analog('A5', 'A5'), reset('RESET')],
    'wiring', { color: '#0b3d5e' },
  ),
  simpleWiringBoard(
    'board.nano-33-ble', 'Arduino Nano 33 BLE', 'Arduino mbed', 'nRF52840', 18, 45, 3.3,
    [g3('TX1', 'TX1', { caps: ['digital-in', 'digital-out', 'uart-tx'] }), g3('RX0', 'RX0', { caps: ['digital-in', 'digital-out', 'uart-rx'] }), reset('RST1', 'RST'), gnd('GND1'), g3('D2', 'D2'), g3('D3', 'D3'), g3('D4', 'D4'), g3('D5', 'D5'), g3('D6', 'D6'), g3('D7', 'D7'), g3('D8', 'D8'), g3('D9', 'D9'), g3('D10', 'D10'), g3('D11', 'D11'), g3('D12', 'D12')],
    [vin('VIN'), gnd('GND2'), reset('RST2', 'RST'), p3v3('3V3'), a3('A7', 'A7'), a3('A6', 'A6'), a3('A5', 'A5'), a3('A4', 'A4'), a3('A3', 'A3'), a3('A2', 'A2'), a3('A1', 'A1'), a3('A0', 'A0'), { id: 'AREF', label: 'AREF', type: 'aref' as const, caps: [] }, g3('D13', 'D13')],
    'wiring', { color: '#0b3d2e', usb: 'micro' },
  ),
  ESP32_DEVKIT,
  simpleWiringBoard(
    'board.esp32-s3', 'ESP32-S3-DevKitC-1', 'Espressif', 'ESP32-S3', 25.5, 63, 3.3,
    [p3v3('3V3'), ...seqPins('GPIO', 4, 18, 3.3), gnd('GND1')],
    [{ ...g3('GPIO1', 'GPIO1') }, { ...g3('GPIO2', 'GPIO2') }, ...seqPins('GPIO', 38, 48, 3.3), g3('TX0', 'TX0'), g3('RX0', 'RX0'), p5v('VIN_5V', '5V'), gnd('GND2')],
    'validation', { color: '#12262e', usb: 'usb-c' },
  ),
  // ESP32-C3-DevKitM-1, Espressif's own development board for the
  // ESP32-C3-MINI-1 module. The pin order below is the J1 and J3 headers as
  // Espressif documents them, top to bottom, including the repeated GND and
  // supply pins — a board's real header has those, and leaving them out is
  // what made the previous definition impossible to wire against correctly.
  //
  // ADC channels follow the module's own mapping: ADC1 on IO0-IO4 and ADC2_CH0
  // on IO5. IO18 and IO19 carry USB D-/D+ on this board, and IO8 drives the
  // on-board RGB LED, so both are annotated rather than presented as plain
  // GPIO.
  // ESP32-C6-DevKitC-1, from Espressif's own user guide for the board rather
  // than from the Arduino core's generic C6 variant — the core carries the
  // chip's pin capabilities but not this board's header arrangement.
  //
  // The two headers are sixteen positions each, ending in a no-connect. ADC1
  // reaches GPIO0-GPIO6, all of which sit on J1. GPIO12 and GPIO13 carry the
  // native USB D-/D+ lines, GPIO8 drives the on-board RGB LED, and GPIO4, 5, 8,
  // 9 and 15 are strapping pins the chip samples at reset — each annotated
  // rather than presented as ordinary GPIO.
  //
  // The module carries 8 MB of flash. The Arduino core's generic esp32c6 target
  // defaults to a 4 MB layout, which is a toolchain default rather than a
  // property of this board.
  simpleWiringBoard(
    'board.esp32-c6-devkitc-1', 'ESP32-C6-DevKitC-1', 'Espressif', 'ESP32-C6 (RISC-V RV32IMC)', 25.4, 58.4, 3.3,
    [
      p3v3('3V3_1'), reset('RST', 'RST'),
      { ...a3('IO4', 'IO4'), description: 'GPIO4 — ADC1 channel; MTMS strapping pin' },
      { ...a3('IO5', 'IO5'), description: 'GPIO5 — ADC1 channel; MTDI strapping pin' },
      { ...a3('IO6', 'IO6'), description: 'GPIO6 — ADC1 channel; MTCK' },
      g3('IO7', 'IO7', { description: 'GPIO7 — MTDO' }),
      a3('IO0', 'IO0'), a3('IO1', 'IO1'),
      g3('IO8', 'IO8', { description: 'GPIO8 — drives the on-board RGB LED; strapping pin' }),
      g3('IO10', 'IO10'), g3('IO11', 'IO11'),
      a3('IO2', 'IO2'), a3('IO3', 'IO3'),
      p5v('5V_1', '5V'), gnd('GND1'),
    ],
    [
      gnd('GND2'),
      g3('IO16', 'TX', { caps: ['digital-in', 'digital-out', 'pwm', 'uart-tx'] }),
      g3('IO17', 'RX', { caps: ['digital-in', 'digital-out', 'pwm', 'uart-rx'] }),
      g3('IO15', 'IO15', { description: 'GPIO15 — strapping pin' }),
      g3('IO23', 'IO23'), g3('IO22', 'IO22'), g3('IO21', 'IO21'), g3('IO20', 'IO20'),
      g3('IO19', 'IO19'), g3('IO18', 'IO18'),
      g3('IO9', 'IO9', { description: 'GPIO9 — Boot button; strapping pin' }),
      gnd('GND3'),
      g3('IO13', 'IO13', { description: 'GPIO13 — native USB D+' }),
      g3('IO12', 'IO12', { description: 'GPIO12 — native USB D-' }),
      gnd('GND4'),
    ],
    'wiring',
    {
      color: '#1f3b52',
      description:
        'ESP32-C6-DevKitC-1 — Espressif development board carrying an ESP32-C6-WROOM-1 module with 8 MB flash. ' +
        'Two USB Type-C ports (one to the native USB peripheral, one through the USB-to-UART bridge), Boot and Reset buttons, ' +
        'and an addressable RGB LED on GPIO8. Wiring and pin metadata only at present; firmware execution is not implemented for this board.',
    },
  ),
  simpleWiringBoard(
    'board.esp32-c3', 'ESP32-C3-DevKitM-1', 'Espressif', 'ESP32-C3 (RISC-V RV32IMC)', 22.9, 51.1, 3.3,
    [
      gnd('GND1'), { ...p3v3('3V3_1'), aliases: ['3V3'] }, p3v3('3V3_2'),
      { ...a3('IO2', 'IO2'), aliases: ['GPIO2'] }, { ...a3('IO3', 'IO3'), aliases: ['GPIO3'] },
      gnd('GND2'), reset('RST', 'RST'), gnd('GND3'),
      { ...a3('IO0', 'IO0'), aliases: ['GPIO0'] }, { ...a3('IO1', 'IO1'), aliases: ['GPIO1'] },
      { ...g3('IO10', 'IO10'), aliases: ['GPIO10'] },
      gnd('GND4'), { ...p5v('5V_1', '5V'), aliases: ['VIN_5V'] }, p5v('5V_2', '5V'), gnd('GND5'),
    ],
    [
      gnd('GND6'),
      g3('IO21', 'TX', { caps: ['digital-in', 'digital-out', 'pwm', 'uart-tx'], aliases: ['TX0'] }),
      g3('IO20', 'RX', { caps: ['digital-in', 'digital-out', 'pwm', 'uart-rx'], aliases: ['RX0'] }),
      gnd('GND7'),
      { ...g3('IO9', 'IO9'), aliases: ['GPIO9'] },
      g3('IO8', 'IO8', { aliases: ['GPIO8'], description: 'GPIO8 — also drives the on-board RGB LED' }),
      gnd('GND8'),
      { ...g3('IO7', 'IO7'), aliases: ['GPIO7'] }, { ...g3('IO6', 'IO6'), aliases: ['GPIO6'] },
      { ...a3('IO5', 'IO5'), aliases: ['GPIO5'] }, { ...a3('IO4', 'IO4'), aliases: ['GPIO4'] },
      gnd('GND9'),
      g3('IO18', 'IO18', { aliases: ['GPIO18'], description: 'GPIO18 — also USB D-' }),
      g3('IO19', 'IO19', { aliases: ['GPIO19'], description: 'GPIO19 — also USB D+' }),
      gnd('GND10'),
    ],
    'validation',
    {
      color: '#12262e',
      usb: 'micro',
      description:
        'ESP32-C3-DevKitM-1 (ESP32-C3-MINI-1 module, 4 MB flash). RISC-V RV32IMC at 160 MHz with 3.3 V logic. Two 15-pin headers as Espressif documents them.',
    },
  ),
  simpleWiringBoard(
    'board.esp8266-nodemcu', 'ESP8266 NodeMCU', 'Espressif', 'ESP8266', 25.6, 48.5, 3.3,
    [{ id: 'A0', label: 'A0', type: 'analog' as const, caps: ['analog-in' as const], voltage: 3.3 }, gnd('GND1'), g3('D0', 'D0'), g3('D1', 'D1', { caps: ['digital-in', 'digital-out', 'i2c-scl'] }), g3('D2', 'D2', { caps: ['digital-in', 'digital-out', 'i2c-sda'] }), g3('D3', 'D3'), g3('D4', 'D4'), p3v3('3V3_1')],
    [g3('D5', 'D5', { caps: ['digital-in', 'digital-out', 'spi-sck'] }), g3('D6', 'D6', { caps: ['digital-in', 'digital-out', 'spi-miso'] }), g3('D7', 'D7', { caps: ['digital-in', 'digital-out', 'spi-mosi'] }), g3('D8', 'D8'), g3('RX', 'RX', { caps: ['digital-in', 'uart-rx'] }), g3('TX', 'TX', { caps: ['digital-out', 'uart-tx'] }), gnd('GND2'), p5v('VIN_5V', 'VIN')],
    'wiring', { color: '#1a1a24' },
  ),
  simpleWiringBoard(
    'board.esp32-cam', 'ESP32-CAM', 'Espressif', 'ESP32 + OV2640', 27, 40.5, 3.3,
    [p5v('5V'), gnd('GND1'), g3('IO12', 'IO12'), g3('IO13', 'IO13'), g3('IO15', 'IO15'), g3('IO14', 'IO14'), g3('IO2', 'IO2'), g3('IO4', 'IO4')],
    [p3v3('3V3'), g3('IO16', 'IO16'), g3('IO0', 'IO0'), gnd('GND2'), { id: 'VOR', label: 'VOR', type: 'nc' as const, caps: [] }, g3('U0R', 'U0R', { caps: ['digital-in', 'uart-rx'] }), g3('U0T', 'U0T', { caps: ['digital-out', 'uart-tx'] }), gnd('GND3')],
    'visual-only', { usb: 'none', color: '#12262e', description: 'ESP32-CAM — visual reference with pin metadata. Camera behavior is not modeled.' },
  ),
  PICO,
  { ...PICO, id: 'board.raspberry-pi-pico-w', name: 'Raspberry Pi Pico W', description: 'Pico W (wireless). The RP2040 side runs real firmware exactly as the Pico does; the CYW43 Wi-Fi radio is not simulated.', metadata: { ...PICO.metadata } },
  simpleWiringBoard(
    // Portrait: the 40-pin header runs along the Zero's 65 mm edge. Drawn
    // landscape, thirteen pins a side did not fit in 30 mm and four of them
    // sat off the board.
    'board.rpi-zero-gpio', 'Raspberry Pi Zero GPIO Header', 'Raspberry Pi', 'BCM2835 (header only)', 30, 65, 3.3,
    [p3v3('3V3_1'), g3('GPIO2', 'GPIO2', { caps: ['digital-in', 'digital-out', 'i2c-sda'] }), g3('GPIO3', 'GPIO3', { caps: ['digital-in', 'digital-out', 'i2c-scl'] }), g3('GPIO4', 'GPIO4'), gnd('GND1'), g3('GPIO17', 'GPIO17'), g3('GPIO27', 'GPIO27'), g3('GPIO22', 'GPIO22'), p3v3('3V3_2'), g3('GPIO10', 'GPIO10', { caps: ['digital-in', 'digital-out', 'spi-mosi'] }), g3('GPIO9', 'GPIO9', { caps: ['digital-in', 'digital-out', 'spi-miso'] }), g3('GPIO11', 'GPIO11', { caps: ['digital-in', 'digital-out', 'spi-sck'] }), gnd('GND2')],
    [p5v('5V_1'), p5v('5V_2'), gnd('GND3'), g3('GPIO14', 'GPIO14 TXD', { caps: ['digital-out', 'uart-tx'] }), g3('GPIO15', 'GPIO15 RXD', { caps: ['digital-in', 'uart-rx'] }), g3('GPIO18', 'GPIO18'), gnd('GND4'), g3('GPIO23', 'GPIO23'), g3('GPIO24', 'GPIO24'), gnd('GND5'), g3('GPIO25', 'GPIO25'), g3('GPIO8', 'GPIO8'), g3('GPIO7', 'GPIO7')],
    'wiring', { usb: 'none', color: '#0b3d2e', description: 'Raspberry Pi GPIO header (subset of the 40-pin J8). Wiring/validation only — Linux boards are not simulated.' },
  ),
  simpleWiringBoard(
    'board.rpi4-gpio', 'Raspberry Pi 4/5 GPIO Header', 'Raspberry Pi', 'BCM2711/BCM2712 (header only)', 85, 20, 3.3,
    [p3v3('3V3_1'), g3('GPIO2', 'GPIO2', { caps: ['digital-in', 'digital-out', 'i2c-sda'] }), g3('GPIO3', 'GPIO3', { caps: ['digital-in', 'digital-out', 'i2c-scl'] }), g3('GPIO4', 'GPIO4'), gnd('GND1'), g3('GPIO17', 'GPIO17'), g3('GPIO27', 'GPIO27'), g3('GPIO22', 'GPIO22')],
    [p5v('5V_1'), p5v('5V_2'), gnd('GND2'), g3('GPIO14', 'GPIO14 TXD', { caps: ['digital-out', 'uart-tx'] }), g3('GPIO15', 'GPIO15 RXD', { caps: ['digital-in', 'uart-rx'] }), g3('GPIO18', 'GPIO18'), gnd('GND3'), g3('GPIO23', 'GPIO23')],
    'wiring', { usb: 'none', color: '#0b3d2e' },
  ),
  simpleWiringBoard(
    'board.teensy41', 'Teensy 4.1', 'PJRC', 'IMXRT1062 (Cortex-M7)', 18, 61, 3.3,
    [gnd('GND1'), ...seqPins('D', 0, 12, 3.3), p3v3('3V3_1')],
    [p5v('VIN_5V', 'VIN'), gnd('GND2'), p3v3('3V3_2'), ...seqPins('D', 13, 23, 3.3), gnd('GND3')],
    'wiring', { color: '#0b3d2e' },
  ),
  simpleWiringBoard(
    'board.microbit', 'BBC micro:bit', 'BBC', 'nRF52833', 52, 43, 3.3,
    [a3('P0', 'P0'), a3('P1', 'P1'), a3('P2', 'P2')],
    [p3v3('3V'), gnd('GND')],
    'visual-only', { usb: 'micro', color: '#1a1a24', description: 'micro:bit edge connector (large pads P0-P2, 3V, GND). Visual reference with pin metadata.' },
  ),
  simpleWiringBoard(
    'board.stm32-nucleo', 'STM32 Nucleo-64', 'STMicroelectronics', 'STM32F401RE', 70, 82.5, 3.3,
    [g3('PA0', 'PA0'), g3('PA1', 'PA1'), g3('PA4', 'PA4'), g3('PB0', 'PB0'), g3('PC1', 'PC1'), g3('PC0', 'PC0'), g3('PA5', 'PA5 (LED)'), g3('PA6', 'PA6'), g3('PA7', 'PA7'), g3('PB6', 'PB6'), g3('PC7', 'PC7'), g3('PA9', 'PA9'), g3('PA8', 'PA8'), g3('PB10', 'PB10'), g3('PB4', 'PB4'), g3('PB5', 'PB5'), g3('PB3', 'PB3'), g3('PA10', 'PA10'), g3('PA2', 'PA2 TX'), g3('PA3', 'PA3 RX')],
    [p3v3('3V3'), p5v('5V'), gnd('GND1'), gnd('GND2'), vin('VIN'), reset('NRST'), { id: 'AVDD', label: 'AVDD', type: 'power-3v3' as const, caps: ['power' as const], voltage: 3.3 }],
    'wiring', { usb: 'mini', color: '#dbe4ea' },
  ),
  simpleWiringBoard(
    'board.adafruit-feather', 'Adafruit Feather M0', 'Adafruit', 'SAMD21 (Cortex-M0+)', 22.9, 51, 3.3,
    [reset('RST'), p3v3('3V3'), { id: 'AREF', label: 'AREF', type: 'aref' as const, caps: [] }, gnd('GND1'), a3('A0', 'A0'), a3('A1', 'A1'), a3('A2', 'A2'), a3('A3', 'A3'), a3('A4', 'A4'), a3('A5', 'A5'), g3('SCK', 'SCK', { caps: ['digital-in', 'digital-out', 'spi-sck'] }), g3('MOSI', 'MOSI', { caps: ['digital-in', 'digital-out', 'spi-mosi'] }), g3('MISO', 'MISO', { caps: ['digital-in', 'digital-out', 'spi-miso'] }), g3('RX', 'RX', { caps: ['digital-in', 'uart-rx'] }), g3('TX', 'TX', { caps: ['digital-out', 'uart-tx'] })],
    [{ id: 'VBAT', label: 'BAT', type: 'power-vin' as const, caps: ['power' as const], voltage: 3.7 }, { id: 'EN', label: 'EN', type: 'digital' as const, caps: ['digital-in' as const], voltage: 3.3 }, { ...p5v('VUSB', 'USB') }, g3('D13', 'D13'), g3('D12', 'D12'), g3('D11', 'D11'), g3('D10', 'D10'), g3('D9', 'D9'), g3('D6', 'D6'), g3('D5', 'D5'), g3('SCL', 'SCL', { caps: ['digital-in', 'digital-out', 'i2c-scl'] }), g3('SDA', 'SDA', { caps: ['digital-in', 'digital-out', 'i2c-sda'] })],
    'wiring', { color: '#12262e', description: 'Adafruit Feather M0: an ATSAMD21G18 at 48 MHz with native USB, in the Feather layout. Runs real SAMD21 firmware.' },
  ),
  simpleWiringBoard(
    'board.adafruit-qtpy', 'Adafruit QT Py SAMD21', 'Adafruit', 'SAMD21 (Cortex-M0+)', 17.8, 22.9, 3.3,
    // As printed: A0-A3, SDA, SCL and TX down one side; 5V, GND, 3V, MO, MI,
    // SCK and RX down the other.
    [a3('A0', 'A0'), a3('A1', 'A1'), a3('A2', 'A2'), a3('A3', 'A3'), g3('SDA', 'SDA', { caps: ['digital-in', 'digital-out', 'i2c-sda'] }), g3('SCL', 'SCL', { caps: ['digital-in', 'digital-out', 'i2c-scl'] }), g3('TX', 'TX', { caps: ['digital-out', 'uart-tx'] })],
    [p5v('VUSB', '5V'), gnd('GND'), p3v3('3V3'), g3('MOSI', 'MO', { caps: ['digital-in', 'digital-out', 'spi-mosi'] }), g3('MISO', 'MI', { caps: ['digital-in', 'digital-out', 'spi-miso'] }), g3('SCK', 'SCK', { caps: ['digital-in', 'digital-out', 'spi-sck'] }), g3('RX', 'RX', { caps: ['digital-in', 'uart-rx'] })],
    'wiring', { usb: 'usb-c', color: '#1a1a24', description: 'Adafruit QT Py M0: an ATSAMD21E18 the size of a stamp, with native USB. Runs real SAMD21 firmware.' },
  ),
  simpleWiringBoard(
    'board.seeed-xiao', 'Seeed Studio XIAO SAMD21', 'Seeed Studio', 'SAMD21 (Cortex-M0+)', 17.5, 21, 3.3,
    [a3('A0', 'A0/D0'), a3('A1', 'A1/D1'), a3('A2', 'A2/D2'), a3('A3', 'A3/D3'), g3('SDA', 'SDA', { caps: ['digital-in', 'digital-out', 'i2c-sda'] }), g3('SCL', 'SCL', { caps: ['digital-in', 'digital-out', 'i2c-scl'] }), g3('TX', 'TX', { caps: ['digital-out', 'uart-tx'] })],
    [p5v('VUSB', '5V'), gnd('GND'), p3v3('3V3'), a3('A10', 'A10/MOSI'), a3('A9', 'A9/MISO'), a3('A8', 'A8/SCK'), g3('RX', 'RX', { caps: ['digital-in', 'uart-rx'] })],
    'wiring', { usb: 'usb-c', color: '#1a1a24' },
  ),
];

/**
 * Merges the canonical capability table (architecture, aliases, compiler,
 * simulation, pin capability upgrades) over the raw visual definitions and
 * derives the support badge from capabilities. Deprecated per-board fields
 * are stripped so no subsystem can read stale Uno-era assumptions.
 */
function applyCapabilities(raw: BoardDefinition): BoardDefinition {
  const caps = BOARD_CAPABILITIES[raw.id];
  if (!caps) {
    return { ...raw, architecture: raw.architecture ?? 'other' };
  }
  const pins = caps.extraPinCaps
    ? raw.pins.map((p) => {
        const extra = caps.extraPinCaps!.filter((e) => e.pattern.test(p.id)).flatMap((e) => e.add);
        if (extra.length === 0) return p;
        return { ...p, capabilities: [...new Set([...p.capabilities, ...extra])] };
      })
    : raw.pins;
  const def: BoardDefinition = {
    ...raw,
    pins,
    architecture: caps.architecture,
    aliases: caps.aliases,
    ...(caps.processorProfileId ? { processorProfileId: caps.processorProfileId } : {}),
    ...(caps.compileProfileId ? { compileProfileId: caps.compileProfileId } : {}),
    ...(caps.runtimeProfileId ? { runtimeProfileId: caps.runtimeProfileId } : {}),
    ...(caps.serverTargetId ? { serverTargetId: caps.serverTargetId } : {}),
    ...(caps.padMap ? { padMap: caps.padMap } : {}),
    ...(caps.manufacturer ? { manufacturer: caps.manufacturer } : {}),
    compiler: caps.compiler ?? { provider: 'none', supported: false },
    simulation:
      caps.simulation ?? { engine: 'none', supported: false, supportedApis: [], supportedPeripherals: [] },
    supportLevel: deriveBoardSupportLevel(
      { compiler: caps.compiler, simulation: caps.simulation },
      raw.supportLevel,
    ),
    metadata: {
      ...raw.metadata,
      ...(caps.analogPinBase !== undefined ? { analogPinBase: caps.analogPinBase } : {}),
      ...(caps.variant ? { variant: caps.variant } : {}),
      ...(caps.limitation ? { limitation: caps.limitation } : {}),
      ...(caps.identityNote ? { identityNote: caps.identityNote } : {}),
    },
  };
  delete def.compilerTarget;
  delete def.simulationAdapterId;
  return def;
}

export const BOARD_DEFINITIONS: BoardDefinition[] = RAW_BOARD_DEFINITIONS.map(applyCapabilities);

export function getBoardDefinition(id: string): BoardDefinition | undefined {
  return BOARD_DEFINITIONS.find((b) => b.id === id);
}

/** Resolve a board by canonical id or any registered alias (case-insensitive). */
export function findBoardByIdOrAlias(idOrAlias: string): BoardDefinition | undefined {
  const needle = idOrAlias.trim().toLowerCase();
  return BOARD_DEFINITIONS.find(
    (b) => b.id.toLowerCase() === needle || (b.aliases ?? []).some((a) => a.toLowerCase() === needle),
  );
}
