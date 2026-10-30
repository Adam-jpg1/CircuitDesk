import type { BoardDefinition, PinDefinition } from '../types';
import { pinRow, gpio, analog, gnd, p5v, p3v3, vin, reset, type PinSpec } from './pinHelpers';

// Arduino Due: the Mega's 101.6 x 53.3 mm outline and header positions, with a
// SAM3X8E Cortex-M3 at 84 MHz and 3.3 V logic everywhere — no pin tolerates
// 5 V. Every pin the board brings out is here, because firmware drives them
// through the SAM3X model; the pad behind each label is in the capability
// table's pad map, taken from the core's own variant.cpp.

const TOP_Y = 2.6;
const BOTTOM_Y = 50.7;
const HEADER_X1 = 88.0;
const HEADER_X2 = 90.54;

const io = (id: string, label: string, extra: PinSpec['caps'] = [], options: Partial<PinSpec> = {}) =>
  gpio(id, label, ['digital-in', 'digital-out', 'interrupt', ...extra], 3.3, options);
const pwm = (id: string, label: string) => io(id, label, ['pwm']);

function duePins(): PinDefinition[] {
  const pins: PinDefinition[] = [];

  pins.push(
    ...pinRow(
      [
        io('D0', '0', ['uart-rx'], { aliases: ['RX0'], description: 'Digital 0 / Serial RX (UART)' }),
        io('D1', '1', ['uart-tx'], { aliases: ['TX0'], description: 'Digital 1 / Serial TX (UART)' }),
        pwm('D2', '2'), pwm('D3', '3'), pwm('D4', '4'), pwm('D5', '5'), pwm('D6', '6'), pwm('D7', '7'),
      ],
      17.5,
      TOP_Y,
    ),
  );

  pins.push(
    ...pinRow(
      [
        pwm('D8', '8'), pwm('D9', '9'), pwm('D10', '10'), pwm('D11', '11'), pwm('D12', '12'),
        io('D13', '13', ['pwm'], { aliases: ['LED_BUILTIN'], description: 'Digital 13 / built-in LED (PB27)' }),
        gnd('GND_TOP'),
        { id: 'AREF', label: 'AREF', type: 'aref' as const, caps: [] },
        io('SDA1', 'SDA1', [], { description: 'Wire1 data (TWI0, PA17). Wire1 runs, but parts on the canvas attach to Wire on D20/D21.' }),
        io('SCL1', 'SCL1', [], { description: 'Wire1 clock (TWI0, PA18)' }),
      ],
      36.0,
      TOP_Y,
    ),
  );

  pins.push(
    ...pinRow(
      [
        io('D14', '14', ['uart-tx'], { aliases: ['TX3'] }),
        io('D15', '15', ['uart-rx'], { aliases: ['RX3'] }),
        io('D16', '16', ['uart-tx'], { aliases: ['TX2'] }),
        io('D17', '17', ['uart-rx'], { aliases: ['RX2'] }),
        io('D18', '18', ['uart-tx'], { aliases: ['TX1'] }),
        io('D19', '19', ['uart-rx'], { aliases: ['RX1'] }),
        io('D20', '20', ['i2c-sda'], { aliases: ['SDA'], description: 'Wire data (TWI1, PB12)' }),
        io('D21', '21', ['i2c-scl'], { aliases: ['SCL'], description: 'Wire clock (TWI1, PB13)' }),
      ],
      64.0,
      TOP_Y,
    ),
  );

  pins.push(
    ...pinRow(
      [
        { id: 'IOREF', label: 'IOREF', type: 'power-3v3' as const, caps: [], voltage: 3.3 },
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

  const lower: PinSpec[] = [];
  for (let i = 0; i < 12; i++) lower.push(analog(`A${i}`, `A${i}`, 3.3));
  lower.push(
    { id: 'DAC0', label: 'DAC0', type: 'analog' as const, caps: ['analog-in', 'digital-in', 'digital-out'], voltage: 3.3, description: 'DAC output 0 (PB15)' },
    { id: 'DAC1', label: 'DAC1', type: 'analog' as const, caps: ['analog-in', 'digital-in', 'digital-out'], voltage: 3.3, description: 'DAC output 1 (PB16)' },
    io('CANRX', 'CANRX'),
    io('CANTX', 'CANTX'),
  );
  pins.push(...pinRow(lower, 44.5, BOTTOM_Y));

  const evenSpecs: PinSpec[] = [];
  const oddSpecs: PinSpec[] = [];
  for (let n = 22; n <= 52; n += 2) evenSpecs.push(io(`D${n}`, `${n}`));
  for (let n = 23; n <= 53; n += 2) oddSpecs.push(io(`D${n}`, `${n}`));
  // Legacy ids kept so projects saved against the earlier wiring-only Due still resolve.
  evenSpecs.push(gnd('GNDL'), p3v3('3V3L'));
  oddSpecs.push(gnd('GNDR'), p5v('5VR'), vin('VINR'));
  pins.push(...pinRow(evenSpecs, HEADER_X1, 6.0, false));
  pins.push(...pinRow(oddSpecs, HEADER_X2, 6.0, false));

  // The SPI header beside the chip: SPI is not on D11-D13 on a Due.
  pins.push(
    ...pinRow(
      [
        io('MISO', 'MISO', ['spi-miso'], { description: 'SPI data in (PA25)' }),
        io('SCK', 'SCK', ['spi-sck'], { description: 'SPI clock (PA27)' }),
        io('MOSI', 'MOSI', ['spi-mosi'], { description: 'SPI data out (PA26)' }),
      ],
      70.0,
      25.0,
    ),
  );

  return pins;
}

export const ARDUINO_DUE: BoardDefinition = {
  id: 'board.arduino-due',
  name: 'Arduino Due',
  family: 'Arduino ARM',
  processor: 'AT91SAM3X8E',
  widthMm: 101.6,
  heightMm: 53.3,
  artwork: { kind: 'builtin', builtinId: 'arduino-mega' },
  pins: duePins(),
  supportLevel: 'simulated',
  isBoard: true,
  description:
    'Arduino Due: a SAM3X8E Cortex-M3 at 84 MHz with 3.3 V logic — no pin tolerates 5 V. Simulated on CircuitDesk\'s ' +
    'ARMv7-M core and SAM3X model: 54 digital pins, 12 analog inputs, PWM on D2-D13, Serial (the programming port) and ' +
    'Serial1-Serial3, Wire on D20/D21 and Wire1 on SDA1/SCL1, SPI on the SPI header, attachInterrupt on any pin and ' +
    'Servo.',
  metadata: {
    logicVoltage: 3.3,
    maxPinCurrentMa: 15,
    maxTotalCurrentMa: 130,
    color: '#0b3d5e',
    artworkTitle: 'ARDUINO DUE',
    artworkChip: 'AT91SAM3X8E · Cortex-M3',
    artworkChipMark: 'ATSAM3X8E|ARM',
    uartPins: ['D0', 'D1'],
    i2cPins: ['D20', 'D21'],
    spiPins: ['MISO', 'MOSI', 'SCK'],
    pwmPins: ['D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13'],
  },
};
