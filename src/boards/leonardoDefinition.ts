import type { BoardDefinition, PinDefinition } from '../types';
import { pinRow, gpio, analog, gnd, p5v, p3v3, vin, reset, type PinSpec } from './pinHelpers';

// Arduino Leonardo: 68.6 x 53.3 mm, Uno-shaped headers with an ATmega32U4.
//
// Two things differ from the Uno and are reflected here rather than inherited:
//  - I2C lives on D2 (SDA) and D3 (SCL), not on A4/A5.
//  - SPI is only on the ICSP header (D14 MISO, D15 SCK, D16 MOSI).
//
// A6-A11 are alternate ADC functions of D4/D6/D8/D9/D10/D12, not separate
// header pins, so they appear as aliases on those pins — exactly as silkscreen
// does on the real board.

const TOP_Y = 2.6;
const BOTTOM_Y = 50.7;
const ICSP_X = 62.5;
const ICSP_Y = 24.0;

const pwm = (id: string, label: string, extra: Partial<PinSpec> = {}) =>
  gpio(id, label, ['digital-in', 'digital-out', 'pwm'], 5, extra);

function leonardoPins(): PinDefinition[] {
  const pins: PinDefinition[] = [];

  // Top-left digital block: D0..D7 (D0/RX nearest the USB corner).
  pins.push(
    ...pinRow(
      [
        gpio('D0', '0', ['digital-in', 'digital-out', 'uart-rx'], 5, {
          aliases: ['RX1'],
          description: 'Digital 0 / Serial1 RX (PD2)',
        }),
        gpio('D1', '1', ['digital-in', 'digital-out', 'uart-tx'], 5, {
          aliases: ['TX1'],
          description: 'Digital 1 / Serial1 TX (PD3)',
        }),
        gpio('D2', '2', ['digital-in', 'digital-out', 'i2c-sda', 'interrupt'], 5, {
          aliases: ['SDA'],
          description: 'Digital 2 / I2C SDA (PD1)',
        }),
        pwm('D3', '3', {
          caps: ['digital-in', 'digital-out', 'pwm', 'i2c-scl', 'interrupt'],
          aliases: ['SCL', '~3'],
          description: 'Digital 3 / I2C SCL / PWM OC0B (PD0)',
        }),
        gpio('D4', '4', ['digital-in', 'digital-out', 'analog-in'], 5, {
          aliases: ['A6'],
          description: 'Digital 4 / analog A6 (PD4, ADC8)',
        }),
        pwm('D5', '5', { aliases: ['~5'], description: 'Digital 5 / PWM OC3A (PC6)' }),
        pwm('D6', '6', {
          caps: ['digital-in', 'digital-out', 'pwm', 'analog-in'],
          aliases: ['A7', '~6'],
          description: 'Digital 6 / analog A7 / PWM OC4D (PD7, ADC10)',
        }),
        gpio('D7', '7', ['digital-in', 'digital-out', 'interrupt'], 5, { description: 'Digital 7 / INT6 (PE6)' }),
      ],
      17.5,
      TOP_Y,
    ),
  );

  // Top-right block: D8..D13, GND, AREF.
  pins.push(
    ...pinRow(
      [
        gpio('D8', '8', ['digital-in', 'digital-out', 'analog-in'], 5, {
          aliases: ['A8'],
          description: 'Digital 8 / analog A8 (PB4, ADC11)',
        }),
        pwm('D9', '9', {
          caps: ['digital-in', 'digital-out', 'pwm', 'analog-in'],
          aliases: ['A9', '~9'],
          description: 'Digital 9 / analog A9 / PWM OC1A (PB5, ADC12)',
        }),
        pwm('D10', '10', {
          caps: ['digital-in', 'digital-out', 'pwm', 'analog-in'],
          aliases: ['A10', '~10'],
          description: 'Digital 10 / analog A10 / PWM OC1B (PB6, ADC13)',
        }),
        pwm('D11', '11', { aliases: ['~11'], description: 'Digital 11 / PWM OC0A (PB7)' }),
        gpio('D12', '12', ['digital-in', 'digital-out', 'analog-in'], 5, {
          aliases: ['A11'],
          description: 'Digital 12 / analog A11 (PD6, ADC9)',
        }),
        pwm('D13', '13', {
          aliases: ['LED_BUILTIN', '~13'],
          description: 'Digital 13 / built-in LED / PWM OC4A (PC7)',
        }),
        gnd('GND_TOP'),
        { id: 'AREF', label: 'AREF', type: 'aref' as const, caps: [] },
      ],
      41.0,
      TOP_Y,
    ),
  );

  // Bottom-left power block. GND1/GND2/5V/3V3/VIN/RESET ids are unchanged from
  // the previous Leonardo entry so saved projects keep resolving.
  pins.push(
    ...pinRow(
      [
        { id: 'IOREF', label: 'IOREF', type: 'power-5v' as const, caps: [], voltage: 5 },
        reset('RESET'),
        p3v3('3V3'),
        p5v('5V'),
        gnd('GND1'),
        gnd('GND2'),
        vin('VIN'),
      ],
      20.2,
      BOTTOM_Y,
    ),
  );

  // Bottom-right analog block: A0..A5 (PF7, PF6, PF5, PF4, PF1, PF0).
  pins.push(
    ...pinRow(
      [
        analog('A0', 'A0'), analog('A1', 'A1'), analog('A2', 'A2'),
        analog('A3', 'A3'), analog('A4', 'A4'), analog('A5', 'A5'),
      ],
      44.5,
      BOTTOM_Y,
    ),
  );

  // ICSP 2x3 header — the only place SPI is exposed on this board.
  pins.push(
    ...pinRow(
      [
        gpio('D14', 'MISO', ['digital-in', 'digital-out', 'spi-miso'], 5, {
          aliases: ['MISO'],
          description: 'ICSP MISO / digital 14 (PB3)',
        }),
        p5v('ICSP_5V', '5V'),
        gpio('D15', 'SCK', ['digital-in', 'digital-out', 'spi-sck'], 5, {
          aliases: ['SCK'],
          description: 'ICSP SCK / digital 15 (PB1)',
        }),
      ],
      ICSP_X,
      ICSP_Y,
    ),
  );
  pins.push(
    ...pinRow(
      [
        gpio('D16', 'MOSI', ['digital-in', 'digital-out', 'spi-mosi'], 5, {
          aliases: ['MOSI'],
          description: 'ICSP MOSI / digital 16 (PB2)',
        }),
        reset('ICSP_RESET', 'RST'),
        gnd('ICSP_GND'),
      ],
      ICSP_X,
      ICSP_Y + 2.54,
    ),
  );

  return pins;
}

export const ARDUINO_LEONARDO: BoardDefinition = {
  id: 'board.arduino-leonardo',
  name: 'Arduino Leonardo',
  family: 'Arduino AVR',
  processor: 'ATmega32U4',
  widthMm: 68.6,
  heightMm: 53.3,
  artwork: { kind: 'builtin', builtinId: 'arduino-leonardo' },
  pins: leonardoPins(),
  // architecture / compiler / simulation / badge come from the canonical
  // capability table (boards/capabilities.ts).
  supportLevel: 'simulated',
  isBoard: true,
  description:
    'Leonardo-compatible board with an ATmega32U4 at 16 MHz. Simulated on its own profile: 18 digital pins (D0-D17), A0-A5 analog inputs, Timer0/1/3 PWM, Serial over its native USB port and Serial1 on D0/D1. USB Keyboard and Mouse are not emulated.',
  metadata: {
    logicVoltage: 5,
    maxPinCurrentMa: 40,
    maxTotalCurrentMa: 200,
    color: '#0b3d5e',
    uartPins: ['D0', 'D1'],
    i2cPins: ['D2', 'D3'],
    spiPins: ['D14', 'D15', 'D16'],
    // Physical PWM outputs. D6 and D13 are Timer4 outputs on real hardware and
    // are not emulated — the simulation capability list says so.
    pwmPins: ['D3', 'D5', 'D6', 'D9', 'D10', 'D11', 'D13'],
  },
};
