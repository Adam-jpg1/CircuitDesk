import type { BoardDefinition, PinCapability, PinDefinition, SupportLevel } from '../types';
import { ARDUINO_DUE } from './dueDefinition';
import { ARDUINO_UNO_R4_MINIMA } from './r4Definition';
import { MICROBIT_V2 } from './microbitDefinition';
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
/** A Nucleo pad: every one is a GPIO with an EXTI line, plus whatever else it can do. */
const nuc = (id: string, label: string, aliases: string[], caps: PinCapability[], description?: string) =>
  gpio(id, label, ['digital-in', 'digital-out', 'interrupt', ...caps], 3.3, { aliases, description, type: caps.includes('analog-in') ? 'analog' : 'digital' });

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

// Arduino Nano 33 BLE: the Nano footprint around an nRF52840 (u-blox NINA-B306)
// at 64 MHz with 3.3 V logic — and not 5 V tolerant. The pin ids are the ones
// earlier projects saved (TX1/RX0 for D1/D0, GND1/GND2, RST1/RST2). In the
// Arduino mbed core D0 is the TX pad (P1.03) and D1 the RX pad (P1.10), which
// is Serial1; Serial is native USB. Every GPIO can do PWM and interrupts.
const nb = (id: string, label: string, extra: PinCapability[] = [], description?: string) =>
  gpio(id, label, ['digital-in', 'digital-out', 'pwm', 'interrupt', ...extra], 3.3, description ? { description } : {});
const na = (id: string, extra: PinCapability[] = []) =>
  analog(id, id, 3.3, { caps: ['analog-in', 'digital-in', 'digital-out', 'pwm', 'interrupt', ...extra] });

export const NANO_33_BLE = headerBoard({
  id: 'board.nano-33-ble',
  name: 'Arduino Nano 33 BLE',
  family: 'Arduino mbed',
  processor: 'nRF52840 (Cortex-M4F)',
  widthMm: 18,
  heightMm: 45,
  supportLevel: 'simulated',
  logicVoltage: 3.3,
  color: '#0b3d2e',
  usb: 'micro',
  description:
    "Arduino Nano 33 BLE: an nRF52840 Cortex-M4F at 64 MHz with 3.3 V logic. Simulated on CircuitDesk's ARMv7-M core " +
    'and nRF52 model running the Arduino mbed core (mbed OS): Serial over native USB, Serial1 on TX1/RX0, digital I/O, ' +
    'PWM, interrupts, analogRead on A0-A7, Wire on A4/A5 and SPI on D11-D13. Bluetooth and the onboard sensors are not simulated.',
  metadata: { i2cPins: ['A4', 'A5'], spiPins: ['D11', 'D12', 'D13'] },
  left: [
    nb('TX1', 'TX1', ['uart-tx'], 'D0 in the mbed core: Serial1 TX (P1.03)'),
    nb('RX0', 'RX0', ['uart-rx'], 'D1 in the mbed core: Serial1 RX (P1.10)'),
    reset('RST1', 'RST'),
    gnd('GND1'),
    nb('D2', 'D2'),
    nb('D3', 'D3'),
    nb('D4', 'D4'),
    nb('D5', 'D5'),
    nb('D6', 'D6'),
    nb('D7', 'D7'),
    nb('D8', 'D8'),
    nb('D9', 'D9'),
    nb('D10', 'D10', ['spi-ss']),
    nb('D11', 'D11', ['spi-mosi']),
    nb('D12', 'D12', ['spi-miso']),
  ],
  right: [
    vin('VIN'),
    gnd('GND2'),
    reset('RST2', 'RST'),
    p3v3('3V3'),
    na('A7'),
    na('A6'),
    na('A5', ['i2c-scl']),
    na('A4', ['i2c-sda']),
    na('A3'),
    na('A2'),
    na('A1'),
    na('A0'),
    { id: 'AREF', label: 'AREF', type: 'aref' as const, caps: [] },
    nb('D13', 'D13', ['spi-sck'], 'D13: SPI SCK and the built-in LED (P0.13)'),
  ],
});

// Teensy 4.1: an i.MX RT1062 Cortex-M7 with 3.3 V logic (not 5 V tolerant).
// The outer pins, top to bottom with the USB connector up: GND, 0-12, 3.3V,
// 24-32 down the left; VIN, GND, 3.3V, 23-13, GND, 41-33 down the right. Pin
// ids keep the ones earlier projects saved (D0-D23, GND1-3, 3V3_1/2, VIN_5V).
const TEENSY_PWM = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 18, 19, 22, 23, 24, 25, 28, 29, 33, 36, 37]);
const TEENSY_ANALOG: Record<number, number> = {
  14: 0, 15: 1, 16: 2, 17: 3, 18: 4, 19: 5, 20: 6, 21: 7, 22: 8, 23: 9, 24: 10, 25: 11, 26: 12, 27: 13, 38: 14, 39: 15, 40: 16, 41: 17,
};
const TEENSY_EXTRA: Record<number, PinCapability[]> = {
  0: ['uart-rx'], 1: ['uart-tx'], 10: ['spi-ss'], 11: ['spi-mosi'], 12: ['spi-miso'], 13: ['spi-sck'], 18: ['i2c-sda'], 19: ['i2c-scl'],
};
const TEENSY_NOTES: Record<number, string> = {
  0: 'RX1: Serial1 receive', 1: 'TX1: Serial1 transmit', 13: 'SCK, and the orange LED', 18: 'SDA (Wire)', 19: 'SCL (Wire)',
};
function teensyPin(n: number): PinSpec {
  const caps: PinCapability[] = ['digital-in', 'digital-out', 'interrupt', ...(TEENSY_PWM.has(n) ? (['pwm'] as PinCapability[]) : []), ...(TEENSY_EXTRA[n] ?? [])];
  const a = TEENSY_ANALOG[n];
  const description = TEENSY_NOTES[n];
  if (a !== undefined) {
    return analog(`D${n}`, `${n}/A${a}`, 3.3, { caps: ['analog-in', ...caps], aliases: [`A${a}`], ...(description ? { description } : {}) });
  }
  return gpio(`D${n}`, String(n), caps, 3.3, description ? { description } : {});
}
const teensyRange = (from: number, to: number) => {
  const out: PinSpec[] = [];
  const step = from <= to ? 1 : -1;
  for (let n = from; n !== to + step; n += step) out.push(teensyPin(n));
  return out;
};

export const TEENSY_41 = headerBoard({
  id: 'board.teensy41',
  name: 'Teensy 4.1',
  family: 'PJRC',
  processor: 'i.MX RT1062 (Cortex-M7)',
  widthMm: 18,
  heightMm: 61,
  supportLevel: 'simulated',
  logicVoltage: 3.3,
  color: '#0b3d2e',
  usb: 'micro',
  description:
    "Teensy 4.1: an i.MX RT1062 Cortex-M7 with 3.3 V logic. Simulated on CircuitDesk's ARMv7-M core and i.MX RT model " +
    "running the Teensy 4 core, built at the core's 60 MHz speed setting: Serial over native USB, Serial1 on pins 0/1, " +
    'digital I/O and interrupts, analogRead on A0-A17, analogWrite (FlexPWM and QuadTimer pins), Wire on 18/19 and SPI on 11-13.',
  metadata: { i2cPins: ['D18', 'D19'], spiPins: ['D11', 'D12', 'D13'] },
  left: [gnd('GND1'), ...teensyRange(0, 12), p3v3('3V3_1'), ...teensyRange(24, 32)],
  right: [p5v('VIN_5V', 'VIN'), gnd('GND2'), p3v3('3V3_2'), ...teensyRange(23, 13), gnd('GND3'), ...teensyRange(41, 33)],
});

// The Raspberry Pi's 40-pin J8 header: physical pins 1, 3 ... 39 down one
// row, 2, 4 ... 40 down the other. GPIO pins are named by their BCM numbers,
// which is what RPi.GPIO in BCM mode and gpiozero use. `ids` gives the power
// and ground pins the ids each board's earlier projects saved, in physical
// pin order.
const J8: (string | number)[] = [
  '3V3', '5V', 2, '5V', 3, 'GND', 4, 14, 'GND', 15, 17, 18, 27, 'GND', 22, 23, '3V3', 24, 10, 'GND',
  9, 25, 11, 8, 'GND', 7, 0, 1, 5, 'GND', 6, 12, 13, 'GND', 19, 16, 26, 20, 'GND', 21,
];
const J8_ROLES: Record<number, { caps: PinCapability[]; note: string }> = {
  2: { caps: ['i2c-sda'], note: 'SDA1 (I2C)' }, 3: { caps: ['i2c-scl'], note: 'SCL1 (I2C)' },
  14: { caps: ['uart-tx'], note: 'TXD (UART)' }, 15: { caps: ['uart-rx'], note: 'RXD (UART)' },
  10: { caps: ['spi-mosi'], note: 'MOSI (SPI0)' }, 9: { caps: ['spi-miso'], note: 'MISO (SPI0)' }, 11: { caps: ['spi-sck'], note: 'SCLK (SPI0)' },
  8: { caps: ['spi-ss'], note: 'CE0 (SPI0)' }, 7: { caps: ['spi-ss'], note: 'CE1 (SPI0)' },
  0: { caps: [], note: 'ID_SD: reserved for HAT EEPROMs' }, 1: { caps: [], note: 'ID_SC: reserved for HAT EEPROMs' },
  18: { caps: [], note: 'PCM_CLK / PWM0' }, 12: { caps: [], note: 'PWM0' }, 13: { caps: [], note: 'PWM1' }, 19: { caps: [], note: 'PCM_FS / PWM1' },
};
function j8Header(ids: { power: string[]; ground: string[] }): { left: PinSpec[]; right: PinSpec[] } {
  const p3 = ids.power.filter((x) => x.startsWith('3V3'));
  const p5 = ids.power.filter((x) => x.startsWith('5V'));
  const g = [...ids.ground];
  const spec = (entry: string | number, physical: number): PinSpec => {
    if (entry === '3V3') return { ...p3v3(p3.shift()!, '3V3'), description: `Pin ${physical}: 3.3 V` };
    if (entry === '5V') return { ...p5v(p5.shift()!, '5V'), description: `Pin ${physical}: 5 V` };
    if (entry === 'GND') return { ...gnd(g.shift()!), description: `Pin ${physical}: ground` };
    const n = entry as number;
    const role = J8_ROLES[n];
    return gpio(`GPIO${n}`, `GPIO${n}`, ['digital-in', 'digital-out', 'pwm', 'interrupt', ...(role?.caps ?? [])], 3.3, {
      description: `Pin ${physical}: GPIO${n}${role ? ` — ${role.note}` : ''}`,
      aliases: [`BOARD${physical}`],
    });
  };
  const left: PinSpec[] = [];
  const right: PinSpec[] = [];
  J8.forEach((entry, i) => (i % 2 === 0 ? left : right).push(spec(entry, i + 1)));
  return { left, right };
}

const PI_DESCRIPTION =
  "Simulated by running main.py's GPIO in CircuitDesk's Python interpreter — RPi.GPIO and gpiozero on the header's BCM " +
  'GPIO 0-27, with print() and input() on the Serial Monitor. Not a Linux emulator: the script runs, the Pi does not.';

// Portrait: the header runs along the long edge.
export const RPI_ZERO_GPIO = headerBoard({
  id: 'board.rpi-zero-gpio',
  name: 'Raspberry Pi Zero GPIO Header',
  family: 'Raspberry Pi',
  processor: 'BCM2835 (GPIO header)',
  widthMm: 30,
  heightMm: 65,
  supportLevel: 'simulated',
  logicVoltage: 3.3,
  color: '#0b3d2e',
  usb: 'none',
  description: `The Raspberry Pi Zero's 40-pin GPIO header. ${PI_DESCRIPTION}`,
  metadata: { i2cPins: ['GPIO2', 'GPIO3'], spiPins: ['GPIO10', 'GPIO9', 'GPIO11'] },
  ...j8Header({ power: ['3V3_1', '5V_1', '5V_2', '3V3_2'], ground: ['GND3', 'GND1', 'GND4', 'GND5', 'GND2', 'GND7', 'GND8', 'GND6'] }),
});

export const RPI4_GPIO = headerBoard({
  id: 'board.rpi4-gpio',
  name: 'Raspberry Pi 4/5 GPIO Header',
  family: 'Raspberry Pi',
  processor: 'BCM2711/BCM2712 (GPIO header)',
  widthMm: 30,
  heightMm: 65,
  supportLevel: 'simulated',
  logicVoltage: 3.3,
  color: '#0b3d2e',
  usb: 'none',
  description: `The Raspberry Pi 4 and 5's 40-pin GPIO header. ${PI_DESCRIPTION}`,
  metadata: { i2cPins: ['GPIO2', 'GPIO3'], spiPins: ['GPIO10', 'GPIO9', 'GPIO11'] },
  ...j8Header({ power: ['3V3_1', '5V_1', '5V_2', '3V3_2'], ground: ['GND2', 'GND1', 'GND3', 'GND6', 'GND4', 'GND7', 'GND8', 'GND5'] }),
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
    + 'application image for real, with GPIO, Serial and analogRead() on IO0-IO5; Wi-Fi, Bluetooth, PWM, I2C and SPI are not simulated.',
  left: [
    a3('IO5', 'IO5'), g3('IO6', 'IO6'), g3('IO7', 'IO7'),
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
    a3('IO1', 'IO1'), a3('IO0', 'IO0'),
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
  ARDUINO_DUE,
  ARDUINO_UNO_R4_MINIMA,
  NANO_33_BLE,
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
  RPI_ZERO_GPIO,
  RPI4_GPIO,
  TEENSY_41,
  MICROBIT_V2,
  simpleWiringBoard(
    // The pins keep their pad names as ids, which is what earlier projects
    // saved; the Arduino-header names are aliases. D0/D1 are left out of the
    // aliases on purpose: on a stock Nucleo, PA2/PA3 go to the ST-LINK and
    // reach the header only when SB62/SB63 are closed.
    'board.stm32-nucleo', 'STM32 Nucleo-64', 'STMicroelectronics', 'STM32F401RE', 70, 82.5, 3.3,
    [
      nuc('PA0', 'A0 PA0', ['A0'], ['analog-in', 'pwm']), nuc('PA1', 'A1 PA1', ['A1'], ['analog-in', 'pwm']),
      nuc('PA4', 'A2 PA4', ['A2'], ['analog-in']), nuc('PB0', 'A3 PB0', ['A3'], ['analog-in', 'pwm']),
      nuc('PC1', 'A4 PC1', ['A4'], ['analog-in']), nuc('PC0', 'A5 PC0', ['A5'], ['analog-in']),
      nuc('PA5', 'D13 PA5', ['D13', 'LED_BUILTIN'], ['pwm', 'spi-sck'], 'D13 / SPI SCK / the green user LED LD2'),
      nuc('PA6', 'D12 PA6', ['D12'], ['pwm', 'spi-miso', 'analog-in']), nuc('PA7', 'D11 PA7', ['D11'], ['pwm', 'spi-mosi', 'analog-in']),
      nuc('PB6', 'D10 PB6', ['D10'], ['pwm']), nuc('PC7', 'D9 PC7', ['D9'], ['pwm']), nuc('PA9', 'D8 PA9', ['D8'], ['pwm']),
      nuc('PA8', 'D7 PA8', ['D7'], ['pwm']), nuc('PB10', 'D6 PB10', ['D6'], ['pwm']), nuc('PB4', 'D5 PB4', ['D5'], ['pwm']),
      nuc('PB5', 'D4 PB5', ['D4'], ['pwm']), nuc('PB3', 'D3 PB3', ['D3'], ['pwm']), nuc('PA10', 'D2 PA10', ['D2'], ['pwm']),
      nuc('PA2', 'PA2 TX', ['TX'], ['uart-tx', 'pwm', 'analog-in'], 'USART2 TX: Serial, carried to the ST-LINK virtual COM port'),
      nuc('PA3', 'PA3 RX', ['RX'], ['uart-rx', 'pwm', 'analog-in'], 'USART2 RX: Serial, from the ST-LINK virtual COM port'),
      nuc('PB9', 'D14 SDA', ['D14', 'SDA'], ['i2c-sda', 'pwm'], 'Wire data (I2C1, PB9)'),
      nuc('PB8', 'D15 SCL', ['D15', 'SCL'], ['i2c-scl', 'pwm'], 'Wire clock (I2C1, PB8)'),
    ],
    [p3v3('3V3'), p5v('5V'), gnd('GND1'), gnd('GND2'), vin('VIN'), reset('NRST'), { id: 'AVDD', label: 'AVDD', type: 'power-3v3' as const, caps: ['power' as const], voltage: 3.3 }],
    'simulated',
    {
      usb: 'mini',
      color: '#dbe4ea',
      description:
        "STM32 Nucleo-64 with the STM32F401RE: a Cortex-M4F at 84 MHz with 3.3 V logic. Runs real STM32duino firmware on CircuitDesk's ARMv7-M core and STM32F401 model.",
    },
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
