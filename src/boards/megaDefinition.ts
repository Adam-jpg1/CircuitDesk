import type { BoardDefinition, PinDefinition } from '../types';
import { pinRow, gpio, analog, gnd, p5v, p3v3, vin, reset, type PinSpec } from './pinHelpers';

// Arduino Mega 2560: 101.6 x 53.3 mm. The first ~68 mm mirror the Uno's
// headers (shield compatibility); the remaining length adds the D14-D21
// communication header, A6-A15, and the 2x18 double header carrying D22-D53.
//
// Every digital and analog pin the board exposes is present here, because the
// Mega is a simulated board: the canvas pin ids are what firmware drives
// through the ATmega2560 profile in boards/pinMaps.ts.

const TOP_Y = 2.6;
const BOTTOM_Y = 50.7;
const HEADER_X1 = 88.0;
const HEADER_X2 = 90.54;

const pwm = (id: string, label: string) => gpio(id, label, ['digital-in', 'digital-out', 'pwm']);

function megaPins(): PinDefinition[] {
  const pins: PinDefinition[] = [];

  // --- Top edge, Uno-compatible block 1: D0-D7 ---
  pins.push(
    ...pinRow(
      [
        gpio('D0', '0', ['digital-in', 'digital-out', 'uart-rx'], 5, { aliases: ['RX0'], description: 'Digital 0 / Serial RX' }),
        gpio('D1', '1', ['digital-in', 'digital-out', 'uart-tx'], 5, { aliases: ['TX0'], description: 'Digital 1 / Serial TX' }),
        pwm('D2', '2'), pwm('D3', '3'), pwm('D4', '4'), pwm('D5', '5'), pwm('D6', '6'), pwm('D7', '7'),
      ],
      17.5,
      TOP_Y,
    ),
  );

  // --- Top edge, Uno-compatible block 2: D8-D13, GND, AREF ---
  pins.push(
    ...pinRow(
      [
        pwm('D8', '8'), pwm('D9', '9'),
        gpio('D10', '10', ['digital-in', 'digital-out', 'pwm', 'spi-ss'], 5, { aliases: ['SS'] }),
        gpio('D11', '11', ['digital-in', 'digital-out', 'pwm'], 5),
        gpio('D12', '12', ['digital-in', 'digital-out', 'pwm'], 5),
        gpio('D13', '13', ['digital-in', 'digital-out', 'pwm'], 5, {
          aliases: ['LED_BUILTIN'],
          description: 'Digital 13 / built-in LED (PB7 on the ATmega2560)',
        }),
        gnd('GND_TOP'),
        { id: 'AREF', label: 'AREF', type: 'aref' as const, caps: [] },
      ],
      41.0,
      TOP_Y,
    ),
  );

  // --- Top edge, communication block: D14-D21 (Serial1-3, I2C) ---
  pins.push(
    ...pinRow(
      [
        gpio('D14', '14', ['digital-in', 'digital-out', 'uart-tx'], 5, { aliases: ['TX3'] }),
        gpio('D15', '15', ['digital-in', 'digital-out', 'uart-rx'], 5, { aliases: ['RX3'] }),
        gpio('D16', '16', ['digital-in', 'digital-out', 'uart-tx'], 5, { aliases: ['TX2'] }),
        gpio('D17', '17', ['digital-in', 'digital-out', 'uart-rx'], 5, { aliases: ['RX2'] }),
        gpio('D18', '18', ['digital-in', 'digital-out', 'uart-tx', 'interrupt'], 5, { aliases: ['TX1'] }),
        gpio('D19', '19', ['digital-in', 'digital-out', 'uart-rx', 'interrupt'], 5, { aliases: ['RX1'] }),
        gpio('D20', '20', ['digital-in', 'digital-out', 'i2c-sda', 'interrupt'], 5, { aliases: ['SDA'] }),
        gpio('D21', '21', ['digital-in', 'digital-out', 'i2c-scl', 'interrupt'], 5, { aliases: ['SCL'] }),
      ],
      64.0,
      TOP_Y,
    ),
  );

  // --- Bottom edge, power block ---
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

  // --- Bottom edge, analog block A0-A15 ---
  const analogSpecs: PinSpec[] = [];
  for (let i = 0; i < 16; i++) analogSpecs.push(analog(`A${i}`, `A${i}`));
  pins.push(...pinRow(analogSpecs, 44.5, BOTTOM_Y));

  // --- Double header (2x18) carrying D22-D53 plus power ---
  // Column 1 (even pins) and column 2 (odd pins), matching the physical board.
  const evenSpecs: PinSpec[] = [];
  const oddSpecs: PinSpec[] = [];
  // D44-D46 are the Timer5 PWM outputs on the double header.
  const dh = (n: number) => (n >= 44 && n <= 46 ? pwm(`D${n}`, `${n}`) : gpio(`D${n}`, `${n}`));
  for (let n = 22; n <= 52; n += 2) evenSpecs.push(dh(n));
  for (let n = 23; n <= 53; n += 2) oddSpecs.push(dh(n));
  // Legacy ids kept so projects saved before the full pinout still resolve.
  evenSpecs.push(gnd('GNDL'), p5v('5VL'));
  oddSpecs.push(gnd('GNDR'), vin('VINR'));
  pins.push(...pinRow(evenSpecs, HEADER_X1, 6.0, false));
  pins.push(...pinRow(oddSpecs, HEADER_X2, 6.0, false));

  return pins;
}

export const ARDUINO_MEGA: BoardDefinition = {
  id: 'board.arduino-mega2560',
  name: 'Arduino Mega 2560',
  family: 'Arduino AVR',
  processor: 'ATmega2560',
  widthMm: 101.6,
  heightMm: 53.3,
  artwork: { kind: 'builtin', builtinId: 'arduino-mega' },
  pins: megaPins(),
  // architecture / compiler / simulation / badge come from the canonical
  // capability table (boards/capabilities.ts).
  supportLevel: 'simulated',
  isBoard: true,
  description:
    'Mega 2560-compatible board with an ATmega2560 at 16 MHz. Fully simulated on its own profile: 54 digital pins (D0-D53), 16 analog inputs (A0-A15), six timers with PWM on 2-13 and 44-46, and Serial plus Serial1-Serial3 (USART0-3).',
  metadata: {
    logicVoltage: 5,
    maxPinCurrentMa: 20,
    maxTotalCurrentMa: 200,
    color: '#0b3d5e',
    uartPins: ['D0', 'D1'],
    i2cPins: ['D20', 'D21'],
    spiPins: ['D50', 'D51', 'D52', 'D53'],
    pwmPins: ['D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13', 'D44', 'D45', 'D46'],
  },
};
