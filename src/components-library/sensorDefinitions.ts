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
    'Bosch BME280: temperature, pressure and humidity over I²C. It publishes the raw ADC counts and a real calibration set, so a standard BME280 library runs the datasheet compensation and arrives back at the values set here. Its chip id is 0x60, distinct from a BMP280 — a driver that checks will tell them apart. Conversion timing, oversampling and IIR filtering are stored and read back but do not change the result.',
    [
      { key: 'temperature', label: 'Temperature', kind: 'number', default: 22, unit: '°C', min: -40, max: 85 },
      { key: 'pressure', label: 'Pressure', kind: 'number', default: 1013, unit: 'hPa', min: 300, max: 1100 },
      { key: 'humidity', label: 'Humidity', kind: 'number', default: 45, unit: '%RH', min: 0, max: 100 },
    ],
    22, 18,
  ),
  i2cModule(
    'comp.sht31', 'Temperature/Humidity Sensor (SHT31)', 'sht31',
    'Sensirion SHT31 over I²C. Command-driven rather than register-mapped, and every data pair carries a real CRC-8 that the driver checks — a wrong checksum makes a reading fail here exactly as it would on hardware. The heater bit is stored and reported but does not warm the sensor.',
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
