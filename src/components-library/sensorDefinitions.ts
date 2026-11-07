// Batch 3 sensors as canvas components.
//
// Three families, each generated from its simulation spec so a part cannot be
// drawn with pins its model does not have:
//
//   analog   a transfer function imposing a voltage on a real net
//   gpio     one digital line, driven onto a real net
//   i2c      a register map or command set behind the bus
//
// The user-adjustable quantity comes from the spec too, so the inspector slider
// and the model always agree about range and units.

import type { ComponentDefinition, PinDefinition, PropertyDefinition } from '../types';
import { pinAt } from '../boards/pinHelpers';
import { ANALOG_SENSORS, GPIO_SENSORS } from '../simulation/devices/analogSensors';

const power = (id: string, label: string, x: number, y: number): PinDefinition =>
  pinAt({ id, label, type: 'power-5v', caps: ['power'] }, x, y);
const ground = (id: string, label: string, x: number, y: number): PinDefinition =>
  pinAt({ id, label, type: 'ground', caps: ['ground'] }, x, y);
const analogOut = (id: string, label: string, x: number, y: number): PinDefinition =>
  pinAt({ id, label, type: 'analog', caps: ['analog-in'] }, x, y);
const digital = (id: string, label: string, x: number, y: number): PinDefinition =>
  pinAt({ id, label, type: 'digital', caps: ['digital-out'] }, x, y);

/**
 * A three-pin analog sensor module.
 *
 * Almost every hobby analog sensor is this shape — VCC, GND and one output —
 * so they share a builder and differ only in the transfer function, the name
 * and the artwork.
 */
function analogModule(
  specId: string,
  name: string,
  artworkId: string,
  description: string,
  widthMm = 16,
  heightMm = 22,
): ComponentDefinition {
  const spec = ANALOG_SENSORS[specId];
  const q = spec.quantity;
  const pins: PinDefinition[] = [
    power('vcc', 'VCC', widthMm * 0.25, heightMm - 0.4),
    ground('gnd', 'GND', widthMm * 0.5, heightMm - 0.4),
    analogOut(spec.outputPin, spec.outputPin.toUpperCase(), widthMm * 0.75, heightMm - 0.4),
  ];
  const properties: PropertyDefinition[] = [
    {
      key: q.key,
      label: q.label,
      kind: 'number',
      default: q.default,
      unit: q.unit,
      min: q.min,
      max: q.max,
    },
  ];
  return {
    id: specId,
    name,
    category: 'Sensors',
    widthMm,
    heightMm,
    artwork: { kind: 'builtin', builtinId: artworkId },
    pins,
    properties,
    validationRules: [],
    simulationAdapterId: 'sim.analog-sensor',
    supportLevel: 'simulated',
    description: `${description} ${spec.note}`,
    isBoard: false,
  };
}

/** A three-pin digital sensor module: VCC, GND and one output line. */
function gpioModule(
  specId: string,
  name: string,
  artworkId: string,
  description: string,
  widthMm = 18,
  heightMm = 22,
): ComponentDefinition {
  const spec = GPIO_SENSORS[specId];
  return {
    id: specId,
    name,
    category: 'Sensors',
    widthMm,
    heightMm,
    artwork: { kind: 'builtin', builtinId: artworkId },
    pins: [
      power('vcc', 'VCC', widthMm * 0.25, heightMm - 0.4),
      ground('gnd', 'GND', widthMm * 0.5, heightMm - 0.4),
      digital(spec.outputPin, spec.outputPin.toUpperCase(), widthMm * 0.75, heightMm - 0.4),
    ],
    properties: [
      { key: 'triggered', label: spec.label, kind: 'boolean', default: false },
    ],
    validationRules: [],
    simulationAdapterId: 'sim.gpio-sensor',
    supportLevel: 'simulated',
    description: `${description} ${spec.note}`,
    isBoard: false,
  };
}

// ------------------------------------------------------------------- analog

export const ANALOG_SENSOR_DEFS: ComponentDefinition[] = [
  analogModule('comp.lm35', 'Temperature Sensor (LM35)', 'to92-sensor',
    'Analog temperature sensor in a TO-92 package. Its output is read by a real ADC channel, so a sketch converts it with the same arithmetic it would use on hardware.', 10, 14),
  analogModule('comp.ntc-thermistor', 'NTC Thermistor (10 kΩ)', 'thermistor',
    'Negative-temperature-coefficient thermistor with the divider it is normally used in.', 10, 14),
  analogModule('comp.flex-sensor', 'Flex Sensor', 'flex-sensor',
    'Bend sensor: its resistance rises as it is flexed.', 12, 40),
  analogModule('comp.fsr', 'Force-Sensitive Resistor', 'fsr',
    'Pressure pad whose resistance falls sharply under load.', 18, 22),
  analogModule('comp.soil-moisture', 'Soil Moisture Sensor', 'soil-moisture',
    'Probe module for soil water content.', 14, 46),
  analogModule('comp.mq2', 'Gas Sensor (MQ-2)', 'gas-sensor',
    'Combustible-gas and smoke sensor module.', 20, 26),
  analogModule('comp.rain-sensor', 'Rain Sensor', 'rain-sensor',
    'Water-detection board whose surface resistance falls when wet.', 20, 30),
  analogModule('comp.photodiode', 'Photodiode', 'photodiode',
    'Light-sensitive diode with a transimpedance output.', 8, 12),
];

// --------------------------------------------------------------------- gpio

export const GPIO_SENSOR_DEFS: ComponentDefinition[] = [
  gpioModule('comp.pir', 'PIR Motion Sensor (HC-SR501)', 'pir',
    'Passive infrared motion detector.', 24, 28),
  gpioModule('comp.tilt-switch', 'Tilt Switch', 'tilt-switch',
    'Ball tilt switch on a breakout.', 12, 18),
  gpioModule('comp.vibration-sensor', 'Vibration Sensor (SW-420)', 'vibration',
    'Shock and vibration detector module.', 18, 22),
  gpioModule('comp.hall-sensor', 'Hall Effect Sensor', 'hall',
    'Digital magnetic-field switch.', 12, 18),
];

// ---------------------------------------------------------------------- i2c

/** A four-pin I2C breakout: VCC, GND, SDA, SCL. */
function i2cModule(
  id: string,
  name: string,
  artworkId: string,
  description: string,
  properties: PropertyDefinition[],
  widthMm: number,
  heightMm: number,
): ComponentDefinition {
  return {
    id,
    name,
    category: 'Sensors',
    widthMm,
    heightMm,
    artwork: { kind: 'builtin', builtinId: artworkId },
    pins: [
      power('vcc', 'VCC', widthMm * 0.2, heightMm - 0.4),
      ground('gnd', 'GND', widthMm * 0.4, heightMm - 0.4),
      pinAt({ id: 'scl', label: 'SCL', type: 'digital', caps: ['i2c-scl'] }, widthMm * 0.6, heightMm - 0.4),
      pinAt({ id: 'sda', label: 'SDA', type: 'digital', caps: ['i2c-sda'] }, widthMm * 0.8, heightMm - 0.4),
    ],
    properties: [
      ...properties,
      { key: 'i2cAddress', label: 'I²C address', kind: 'text', default: '' },
    ],
    validationRules: [],
    simulationAdapterId: id === 'comp.bme280' ? 'sim.bme280' : 'sim.sht31',
    supportLevel: 'simulated',
    description,
    isBoard: false,
  };
}

export const I2C_SENSOR_DEFS: ComponentDefinition[] = [
  i2cModule(
    'comp.bme280', 'Environmental Sensor (BME280)', 'bme280',
    'Bosch BME280: temperature, pressure and humidity over I²C. It publishes the raw ADC counts and a real calibration set, so a standard BME280 library runs the datasheet compensation and arrives back at the values set here. Its chip id is 0x60, distinct from a BMP280: a driver that checks will tell them apart. Conversion timing, oversampling and IIR filtering are stored and read back but do not change the result.',
    [
      { key: 'temperature', label: 'Temperature', kind: 'number', default: 22, unit: '°C', min: -40, max: 85 },
      { key: 'pressure', label: 'Pressure', kind: 'number', default: 1013, unit: 'hPa', min: 300, max: 1100 },
      { key: 'humidity', label: 'Humidity', kind: 'number', default: 45, unit: '%RH', min: 0, max: 100 },
    ],
    22, 18,
  ),
  i2cModule(
    'comp.sht31', 'Temperature/Humidity Sensor (SHT31)', 'sht31',
    'Sensirion SHT31 over I²C. Command-driven rather than register-mapped, and every data pair carries a real CRC-8 that the driver checks: a wrong checksum makes a reading fail here exactly as it would on hardware. The heater bit is stored and reported but does not warm the sensor.',
    [
      { key: 'temperature', label: 'Temperature', kind: 'number', default: 22, unit: '°C', min: -40, max: 125 },
      { key: 'humidity', label: 'Humidity', kind: 'number', default: 45, unit: '%RH', min: 0, max: 100 },
    ],
    20, 16,
  ),
];

export const ALL_SENSOR_DEFS: ComponentDefinition[] = [
  ...ANALOG_SENSOR_DEFS,
  ...GPIO_SENSOR_DEFS,
  ...I2C_SENSOR_DEFS,
];

// -------------------------------------------------------------- Batch 4: displays

/** The LCD2004: the same HD44780 controller as the 1602, on bigger glass. */
export const LCD2004: ComponentDefinition = {
  id: 'comp.lcd2004',
  name: 'LCD 2004 (20×4, I²C)',
  category: 'Displays',
  widthMm: 98,
  heightMm: 60,
  artwork: { kind: 'builtin', builtinId: 'lcd2004' },
  pins: [
    ground('gnd', 'GND', 8, 59.6),
    power('vcc', 'VCC', 13, 59.6),
    pinAt({ id: 'sda', label: 'SDA', type: 'digital', caps: ['i2c-sda'] }, 18, 59.6),
    pinAt({ id: 'scl', label: 'SCL', type: 'digital', caps: ['i2c-scl'] }, 23, 59.6),
  ],
  properties: [{ key: 'i2cAddress', label: 'I²C address', kind: 'text', default: '' }],
  validationRules: [],
  simulationAdapterId: 'sim.lcd2004',
  supportLevel: 'simulated',
  description:
    'Twenty-column, four-row character LCD on a PCF8574 I²C backpack. The same HD44780 controller as the 1602, so the same libraries drive it: including the quirk that row three continues row one in DDRAM, which is why text written past column 20 reappears on line three.',
  isBoard: false,
};

/** MAX7219 8×8 matrix module. */
export const MAX7219_MATRIX: ComponentDefinition = {
  id: 'comp.max7219',
  name: 'LED Matrix 8×8 (MAX7219)',
  category: 'Displays',
  widthMm: 32,
  heightMm: 32,
  artwork: { kind: 'builtin', builtinId: 'max7219' },
  pins: [
    ground('gnd', 'GND', 5, 31.6),
    power('vcc', 'VCC', 10, 31.6),
    pinAt({ id: 'din', label: 'DIN', type: 'digital', caps: ['spi-mosi'] }, 15, 31.6),
    pinAt({ id: 'cs', label: 'CS', type: 'digital', caps: ['digital-in'] }, 20, 31.6),
    pinAt({ id: 'clk', label: 'CLK', type: 'digital', caps: ['spi-sck'] }, 25, 31.6),
    pinAt({ id: 'dout', label: 'DOUT', type: 'digital', caps: ['digital-out'] }, 30, 31.6),
  ],
  properties: [],
  validationRules: [],
  simulationAdapterId: 'sim.max7219',
  supportLevel: 'simulated',
  description:
    'Eight-by-eight LED matrix driven by a MAX7219 over SPI. Its digit registers are the rows, so what lights up is exactly what firmware clocked in. Shutdown blanks the panel without losing the pattern and display-test lights everything. Intensity and scan limit are stored and reported but do not change brightness or multiplex duty.',
  isBoard: false,
};

export const DISPLAY_DEFS: ComponentDefinition[] = [LCD2004, MAX7219_MATRIX];

// ------------------------------------------------------- Batch 6: expanders

/** An I2C port expander: bus pins, power, and N general-purpose IO pins. */
function expander(
  id: string,
  name: string,
  pinCount: number,
  description: string,
): ComponentDefinition {
  const perSide = Math.ceil(pinCount / 2);
  const widthMm = 7.62 + 2.2;
  const heightMm = Math.max(perSide, 6) * 2.54 + 8;
  const pins: PinDefinition[] = [];
  for (let i = 0; i < pinCount; i++) {
    const left = i < perSide;
    const row = left ? i : i - perSide;
    pins.push(
      pinAt(
        { id: `p${i}`, label: `P${i}`, type: 'digital', caps: ['digital-in', 'digital-out'] },
        left ? 1.1 : widthMm - 1.1,
        3 + row * 2.54,
      ),
    );
  }
  // Bus, power and the interrupt line along the bottom edge.
  const footY = heightMm - 0.6;
  pins.push(power('vcc', 'VCC', widthMm * 0.15, footY));
  pins.push(ground('gnd', 'GND', widthMm * 0.35, footY));
  pins.push(pinAt({ id: 'sda', label: 'SDA', type: 'digital', caps: ['i2c-sda'] }, widthMm * 0.55, footY));
  pins.push(pinAt({ id: 'scl', label: 'SCL', type: 'digital', caps: ['i2c-scl'] }, widthMm * 0.75, footY));
  pins.push(pinAt({ id: 'int', label: 'INT', type: 'digital', caps: ['digital-out'] }, widthMm * 0.95, footY));

  return {
    id,
    name,
    category: 'ICs',
    widthMm,
    heightMm,
    artwork: { kind: 'builtin', builtinId: 'dip-ic' },
    pins,
    properties: [{ key: 'i2cAddress', label: 'I²C address', kind: 'text', default: '' }],
    validationRules: [],
    simulationAdapterId: 'sim.expander',
    supportLevel: 'simulated',
    description,
    isBoard: false,
  };
}

export const EXPANDER_DEFS: ComponentDefinition[] = [
  expander('comp.pcf8574', 'PCF8574 (8-bit I²C expander)', 8,
    'Eight extra GPIOs over I²C. There is no direction register: writing a 1 releases the pin to a weak pull-up rather than driving it high, which is why you write 1 to a pin before reading it as an input, and why a button can then pull that pin low. Writing a 0 pulls firmly low, and such a pin reads low whatever is outside it.'),
  expander('comp.pcf8575', 'PCF8575 (16-bit I²C expander)', 16,
    'Sixteen extra GPIOs over I²C. The PCF8574 with a second byte: the same quasi-bidirectional pins and the same write-1-to-read rule, written and read low byte first.'),
  expander('comp.mcp23017', 'MCP23017 (16-bit I²C expander)', 16,
    'Sixteen GPIOs with real direction control, configurable pull-ups, polarity inversion and interrupt-on-change. Unlike a PCF8574 an output here drives both ways and an input is high impedance. Writing GPIOA/B writes the output latch, and reading INTCAP clears the interrupt. BANK=1 addressing and interrupt-on-compare are not modelled.'),
];
