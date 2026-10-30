import type { BoardDefinition, PinDefinition } from '../types';
import { pinRow, gpio, analog, gnd, p5v, p3v3, vin, reset } from './pinHelpers';

// Arduino Uno R4 Minima: the Uno R3's 68.6 x 53.4 mm outline and headers, with
// a Renesas RA4M1 Cortex-M4F at 48 MHz running at 5 V. Serial is the native
// USB port; Serial1 is the UART on D0/D1. The RA4M1 pad behind each label is
// in the capability table's pad map, taken from the core's variant.cpp.

const TOP_Y = 2.6;
const BOTTOM_Y = 50.8;

const io = (id: string, label: string, caps: Parameters<typeof gpio>[2] = [], extra: Parameters<typeof gpio>[4] = {}) =>
  gpio(id, label, ['digital-in', 'digital-out', ...(caps ?? [])], 5, { maxCurrentMa: 8, ...extra });

function r4Pins(): PinDefinition[] {
  const pins: PinDefinition[] = [];
  pins.push(
    ...pinRow(
      [
        io('D0', '0', ['uart-rx'], { aliases: ['RX'], description: 'Digital 0 / Serial1 RX (P301)' }),
        io('D1', '1', ['uart-tx'], { aliases: ['TX'], description: 'Digital 1 / Serial1 TX (P302)' }),
        io('D2', '2', ['interrupt'], { description: 'Digital 2 (P105, IRQ0)' }),
        io('D3', '3', ['pwm', 'interrupt'], { aliases: ['~3'], description: 'Digital 3 (P104, IRQ1, GPT1 B)' }),
        io('D4', '4'),
        io('D5', '5', ['pwm'], { aliases: ['~5'] }),
        io('D6', '6', ['pwm'], { aliases: ['~6'] }),
        io('D7', '7'),
      ],
      17.5,
      TOP_Y,
    ),
  );
  pins.push(
    ...pinRow(
      [
        io('D8', '8', ['interrupt']),
        io('D9', '9', ['pwm'], { aliases: ['~9'] }),
        io('D10', '10', ['pwm', 'spi-ss'], { aliases: ['~10', 'SS'] }),
        io('D11', '11', ['pwm', 'spi-mosi'], { aliases: ['~11', 'MOSI'] }),
        io('D12', '12', ['spi-miso', 'interrupt'], { aliases: ['MISO'] }),
        io('D13', '13', ['spi-sck', 'interrupt'], { aliases: ['SCK', 'LED_BUILTIN'], description: 'Digital 13 / SPI SCK / built-in LED (P111)' }),
        gnd('GND_TOP'),
        { id: 'AREF', label: 'AREF', type: 'aref', caps: [] },
        io('SDA', 'SDA', ['i2c-sda'], { description: 'Wire data (IIC1, the same P101 as A4)' }),
        io('SCL', 'SCL', ['i2c-scl'], { description: 'Wire clock (IIC1, the same P100 as A5)' }),
      ],
      41.0,
      TOP_Y,
    ),
  );
  pins.push(
    ...pinRow(
      [
        { id: 'IOREF', label: 'IOREF', type: 'power-5v' as const, caps: [], voltage: 5 },
        reset('RESET'),
        p3v3('3V3'),
        p5v('5V'),
        // GND1 and GND2 are the ids projects saved against the earlier wiring-only R4.
        gnd('GND1'),
        gnd('GND2'),
        vin('VIN'),
      ],
      20.2,
      BOTTOM_Y,
    ),
  );
  pins.push(
    ...pinRow(
      [
        analog('A0', 'A0', 5, { description: 'Analog 0 (P014) — also the DAC output' }),
        analog('A1', 'A1', 5, { caps: ['analog-in', 'digital-in', 'digital-out', 'interrupt'] }),
        analog('A2', 'A2', 5, { caps: ['analog-in', 'digital-in', 'digital-out', 'interrupt'] }),
        analog('A3', 'A3', 5, { caps: ['analog-in', 'digital-in', 'digital-out', 'interrupt'] }),
        analog('A4', 'A4', 5, { caps: ['analog-in', 'digital-in', 'digital-out', 'i2c-sda'] }),
        analog('A5', 'A5', 5, { caps: ['analog-in', 'digital-in', 'digital-out', 'i2c-scl'] }),
      ],
      44.5,
      BOTTOM_Y,
    ),
  );
  return pins;
}

export const ARDUINO_UNO_R4_MINIMA: BoardDefinition = {
  id: 'board.arduino-uno-r4',
  name: 'Arduino Uno R4 Minima',
  family: 'Arduino Renesas',
  processor: 'R7FA4M1AB (Cortex-M4)',
  widthMm: 68.6,
  heightMm: 53.4,
  artwork: { kind: 'builtin', builtinId: 'arduino-uno' },
  pins: r4Pins(),
  supportLevel: 'simulated',
  isBoard: true,
  description:
    "Arduino Uno R4 Minima: a Renesas RA4M1 Cortex-M4F at 48 MHz with 5 V logic, in the Uno's shape. Simulated on " +
    "CircuitDesk's ARMv7-M core and RA4M1 model: Serial over native USB, Serial1 on D0/D1, analogRead (14-bit capable), " +
    'PWM on 3, 5, 6, 9, 10 and 11, Wire on A4/A5, SPI on 11-13, attachInterrupt, Servo, tone and EEPROM.',
  metadata: {
    logicVoltage: 5,
    maxPinCurrentMa: 8,
    maxTotalCurrentMa: 60,
    color: '#0b3d5e',
    artworkTitle: 'ARDUINO UNO R4 MINIMA',
    artworkChip: 'RA4M1 · Cortex-M4',
    artworkChipMark: 'R7FA4M1AB',
    artworkCrystal: false,
    uartPins: ['D0', 'D1'],
    i2cPins: ['A4', 'A5', 'SDA', 'SCL'],
    spiPins: ['D10', 'D11', 'D12', 'D13'],
    pwmPins: ['D3', 'D5', 'D6', 'D9', 'D10', 'D11'],
  },
};
