import type { BoardDefinition, PinDefinition } from '../types';
import { pinRow, gpio, analog, gnd, p5v, p3v3, vin, reset } from './pinHelpers';

// Arduino Uno R3: 68.6 x 53.4 mm. USB on the left, digital header on top,
// power + analog header on the bottom. Pin order matches the physical board.

const TOP_Y = 2.6;
const BOTTOM_Y = 50.8;

function unoPins(): PinDefinition[] {
  const pins: PinDefinition[] = [];

  // Top-left digital block, left → right: D0..D7 (D0/RX nearest the USB corner).
  pins.push(
    ...pinRow(
      [
        gpio('D0', '0', ['digital-in', 'digital-out', 'uart-rx'], 5, { aliases: ['RX'], description: 'Digital 0 / UART RX' }),
        gpio('D1', '1', ['digital-in', 'digital-out', 'uart-tx'], 5, { aliases: ['TX'], description: 'Digital 1 / UART TX' }),
        gpio('D2', '2', ['digital-in', 'digital-out', 'interrupt']),
        gpio('D3', '3', ['digital-in', 'digital-out', 'pwm', 'interrupt'], 5, { aliases: ['~3'] }),
        gpio('D4', '4'),
        gpio('D5', '5', ['digital-in', 'digital-out', 'pwm'], 5, { aliases: ['~5'] }),
        gpio('D6', '6', ['digital-in', 'digital-out', 'pwm'], 5, { aliases: ['~6'] }),
        gpio('D7', '7'),
      ],
      17.5,
      TOP_Y,
    ),
  );

  // Top-right block, left → right: D8..D13, GND, AREF, SDA, SCL.
  pins.push(
    ...pinRow(
      [
        gpio('D8', '8'),
        gpio('D9', '9', ['digital-in', 'digital-out', 'pwm'], 5, { aliases: ['~9'] }),
        gpio('D10', '10', ['digital-in', 'digital-out', 'pwm', 'spi-ss'], 5, { aliases: ['~10', 'SS'] }),
        gpio('D11', '11', ['digital-in', 'digital-out', 'pwm', 'spi-mosi'], 5, { aliases: ['~11', 'MOSI'] }),
        gpio('D12', '12', ['digital-in', 'digital-out', 'spi-miso'], 5, { aliases: ['MISO'] }),
        gpio('D13', '13', ['digital-in', 'digital-out', 'spi-sck'], 5, {
          aliases: ['SCK', 'LED_BUILTIN'],
          description: 'Digital 13 / SPI SCK / built-in LED',
        }),
        gnd('GND_TOP'),
        { id: 'AREF', label: 'AREF', type: 'aref', caps: [] },
        gpio('SDA', 'SDA', ['digital-in', 'digital-out', 'i2c-sda'], 5, { aliases: ['A4'] }),
        gpio('SCL', 'SCL', ['digital-in', 'digital-out', 'i2c-scl'], 5, { aliases: ['A5'] }),
      ],
      41.0,
      TOP_Y,
    ),
  );

  // Bottom-left power block, left → right: IOREF, RESET, 3V3, 5V, GND, GND, VIN.
  pins.push(
    ...pinRow(
      [
        { id: 'IOREF', label: 'IOREF', type: 'power-5v' as const, caps: [], voltage: 5 },
        reset('RESET'),
        p3v3('3V3'),
        p5v('5V'),
        gnd('GND_PWR1'),
        gnd('GND_PWR2'),
        vin('VIN'),
      ],
      20.2,
      BOTTOM_Y,
    ),
  );

  // Bottom-right analog block, left → right: A0..A5.
  pins.push(
    ...pinRow(
      [
        analog('A0', 'A0'),
        analog('A1', 'A1'),
        analog('A2', 'A2'),
        analog('A3', 'A3'),
        analog('A4', 'A4', 5, { aliases: ['SDA'], caps: ['analog-in', 'digital-in', 'digital-out', 'i2c-sda'] }),
        analog('A5', 'A5', 5, { aliases: ['SCL'], caps: ['analog-in', 'digital-in', 'digital-out', 'i2c-scl'] }),
      ],
      44.5,
      BOTTOM_Y,
    ),
  );

  return pins;
}

export const ARDUINO_UNO: BoardDefinition = {
  id: 'board.arduino-uno',
  name: 'Arduino Uno R3',
  family: 'Arduino AVR',
  processor: 'ATmega328P',
  widthMm: 68.6,
  heightMm: 53.4,
  artwork: { kind: 'builtin', builtinId: 'arduino-uno' },
  pins: unoPins(),
  compilerTarget: { fqbn: 'arduino:avr:uno', mcu: 'atmega328p', fCpuHz: 16_000_000 },
  simulationAdapterId: 'avr8js-atmega328p',
  supportLevel: 'simulated',
  isBoard: true,
  description:
    'Uno-compatible development board with an ATmega328P at 16 MHz. Fully simulated: real compiled firmware runs on an AVR emulator with GPIO, UART, timers, PWM and ADC.',
  metadata: {
    logicVoltage: 5,
    maxPinCurrentMa: 20,
    maxTotalCurrentMa: 200,
    uartPins: ['D0', 'D1'],
    i2cPins: ['A4', 'A5', 'SDA', 'SCL'],
    spiPins: ['D10', 'D11', 'D12', 'D13'],
    pwmPins: ['D3', 'D5', 'D6', 'D9', 'D10', 'D11'],
  },
};
