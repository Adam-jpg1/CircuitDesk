import type { BoardDefinition, PinDefinition } from '../types';
import { pinAt, gpio, analog, gnd, p3v3, type PinSpec } from './pinHelpers';

// BBC micro:bit V2: 51.6 x 42 mm, an nRF52833 at 64 MHz with 3.3 V logic.
// The edge connector runs along the bottom: five large rings (0, 1, 2, 3V,
// GND) between the narrow strips, in the board's own order. Arduino pin
// numbers are the edge numbers (P0 is pin 0, P20 pin 20), and the nRF pad
// behind each is in the capability table's pad map, from the sandeepmistry
// core's variant. The 5 x 5 LED matrix and buttons A and B are on the board
// and are simulated too; Serial goes over USB through the interface chip.

const W = 51.6;
const EDGE_Y = 40.2;

type Edge = PinSpec & { wide?: boolean };

const ring = (spec: PinSpec): Edge => ({ ...spec, wide: true });
const strip = (id: string, desc: string, caps: PinSpec['caps'] = ['digital-in', 'digital-out', 'pwm', 'interrupt']): Edge =>
  gpio(id, id.replace('P', ''), caps, 3.3, { description: desc, maxCurrentMa: 5 });

/** The edge connector, left to right as printed on the back of the board. */
const EDGE: Edge[] = [
  strip('P3', 'P3 — analog input, LED column 3', ['analog-in', 'digital-in', 'digital-out', 'pwm', 'interrupt']),
  ring({ ...analog('P0', '0', 3.3), caps: ['analog-in', 'digital-in', 'digital-out', 'pwm', 'interrupt'], description: 'Ring 0 — analog input' }),
  strip('P4', 'P4 — analog input, LED column 1', ['analog-in', 'digital-in', 'digital-out', 'pwm', 'interrupt']),
  strip('P5', 'P5 — button A'),
  strip('P6', 'P6 — LED column 4'),
  strip('P7', 'P7 — LED column 2'),
  ring({ ...analog('P1', '1', 3.3), caps: ['analog-in', 'digital-in', 'digital-out', 'pwm', 'interrupt'], description: 'Ring 1 — analog input' }),
  strip('P8', 'P8'),
  strip('P9', 'P9'),
  strip('P10', 'P10 — analog input, LED column 5', ['analog-in', 'digital-in', 'digital-out', 'pwm', 'interrupt']),
  strip('P11', 'P11 — button B'),
  strip('P12', 'P12'),
  ring({ ...analog('P2', '2', 3.3), caps: ['analog-in', 'digital-in', 'digital-out', 'pwm', 'interrupt'], description: 'Ring 2 — analog input' }),
  strip('P13', 'P13 — SPI SCK', ['digital-in', 'digital-out', 'pwm', 'interrupt', 'spi-sck']),
  strip('P14', 'P14 — SPI MISO', ['digital-in', 'digital-out', 'pwm', 'interrupt', 'spi-miso']),
  strip('P15', 'P15 — SPI MOSI', ['digital-in', 'digital-out', 'pwm', 'interrupt', 'spi-mosi']),
  strip('P16', 'P16'),
  ring({ ...p3v3('3V'), description: '3 V supply' }),
  strip('P19', 'P19 — I2C SCL (Wire)', ['digital-in', 'digital-out', 'interrupt', 'i2c-scl']),
  strip('P20', 'P20 — I2C SDA (Wire)', ['digital-in', 'digital-out', 'interrupt', 'i2c-sda']),
  ring(gnd('GND')),
];

function microbitPins(): PinDefinition[] {
  // Rings are three strips wide; lay the connector out in strip units.
  const units = EDGE.reduce((n, p) => n + (p.wide ? 3 : 1), 0);
  const pitch = (W - 4) / units;
  let x = 2;
  return EDGE.map((spec) => {
    const span = (spec.wide ? 3 : 1) * pitch;
    const pin = pinAt(spec, x + span / 2, EDGE_Y);
    x += span;
    return pin;
  });
}

export const MICROBIT_V2: BoardDefinition = {
  id: 'board.microbit',
  name: 'BBC micro:bit',
  family: 'micro:bit',
  processor: 'nRF52833 (Cortex-M4F)',
  widthMm: W,
  heightMm: 42,
  artwork: { kind: 'builtin', builtinId: 'microbit' },
  pins: microbitPins(),
  supportLevel: 'simulated',
  isBoard: true,
  description:
    "BBC micro:bit V2: an nRF52833 Cortex-M4F at 64 MHz with 3.3 V logic. Simulated on CircuitDesk's ARMv7-M core and " +
    'nRF52 model with the Arduino nRF5 core: the edge connector pins, the 5 x 5 LED matrix, buttons A and B, Serial ' +
    '(through the USB interface chip), analogRead on 0, 1, 2, 3, 4 and 10, PWM, Wire on 19/20 and SPI on 13-15.',
  metadata: {
    logicVoltage: 3.3,
    maxPinCurrentMa: 5,
    maxTotalCurrentMa: 90,
    color: '#151a1f',
    i2cPins: ['P19', 'P20'],
    spiPins: ['P13', 'P14', 'P15'],
    // On the board itself: active-low buttons with pull-ups, and the matrix,
    // which lights an LED while its row pad is high and its column pad low.
    onboardButtons: [
      { key: 'A', pad: 'P0.14', xMm: 7.2, yMm: 20, rMm: 3 },
      { key: 'B', pad: 'P0.23', xMm: W - 7.2, yMm: 20, rMm: 3 },
    ],
    ledMatrix: {
      rows: ['P0.21', 'P0.22', 'P0.15', 'P0.24', 'P0.19'],
      cols: ['P0.28', 'P0.11', 'P0.31', 'P1.05', 'P0.30'],
      xMm: W / 2,
      yMm: 19,
      pitchMm: 4.2,
    },
  },
};
