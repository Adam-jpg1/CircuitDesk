// What a user can set on a part while the simulation runs, declared once.
//
// A sensor in this app is only worth placing if the person using it can change
// what it senses: dial a temperature to 20 °C and watch the sketch print 20,
// cover the light sensor, wave at the PIR. Before this table, that was true of
// five parts and silently false of the rest — the simulator read a control key
// that no UI ever wrote, so the part sat at its default forever.
//
// This is the one place that says, per part, which quantities exist, their
// range and unit, and the key the value lives under. The inspector draws its
// controls from it and the circuit simulation reads through it, so the two can
// not disagree about a key, a default or a range. tests/inputs.interactive.mts
// enforces that every simulated sensor or input appears here (or is one of the
// contact parts the canvas itself clicks), and that a value set here reaches
// the firmware.

import type { ComponentInstance } from '../types';
import { ANALOG_SENSORS, GPIO_SENSORS } from './devices/analogSensors';

/** One adjustable number. */
export interface InputQuantity {
  /**
   * Sub-key for parts with several quantities (`<instance>#<channel>`). Absent
   * for single-quantity parts, whose value lives under the instance id — the
   * key the simulation has always read for them.
   */
  channel?: string;
  label: string;
  unit: string;
  /** Range and step in STORED units. */
  min: number;
  max: number;
  step: number;
  default: number;
  /** Decimal places to show, in display units. */
  precision: number;
  /** Display = stored × scale. A light level stored as 0..1 shows as 0..100 %. */
  scale?: number;
  /** A part property that supplies the value when no control has been set. */
  property?: string;
  /** Which store the value lives in. Potentiometer wipers have their own. */
  store?: 'sensor' | 'pot';
}

export type InputControlSpec =
  | { kind: 'quantities'; quantities: InputQuantity[]; note?: string }
  | {
      kind: 'trigger';
      /** What the asserted state means, e.g. "Motion detected". */
      label: string;
      /** The part holds its output after a trigger; a one-shot button makes sense. */
      latching: boolean;
      note?: string;
    };

/**
 * Parts whose input is a physical contact the user clicks on the canvas —
 * buttons, switches, keypads, the encoder. They have no "value" to type, and
 * listing them here would put a second, worse control next to the real one.
 */
export const CANVAS_CONTACT_ADAPTERS = new Set([
  'sim.push-button',
  'sim.toggle-switch',
  'sim.slide-switch',
  'sim.limit-switch',
  'sim.dip-switch',
  'sim.rotary-encoder',
  'sim.keypad',
  'sim.ir-remote',
]);

const temperature = (min: number, max: number, def: number, property?: string): InputQuantity => ({
  channel: 'temperature',
  label: 'Temperature',
  unit: '°C',
  min,
  max,
  step: 0.1,
  default: def,
  precision: 1,
  ...(property ? { property } : {}),
});

const FIXED: Record<string, InputControlSpec> = {
  'comp.potentiometer': {
    kind: 'quantities',
    quantities: [
      { label: 'Wiper', unit: '%', min: 0, max: 1, step: 0.01, default: 0.5, precision: 0, scale: 100, store: 'pot' },
    ],
  },
  'comp.joystick': {
    kind: 'quantities',
    quantities: [
      { channel: 'x', label: 'X axis', unit: '%', min: 0, max: 1, step: 0.01, default: 0.5, precision: 0, scale: 100, store: 'pot' },
      { channel: 'y', label: 'Y axis', unit: '%', min: 0, max: 1, step: 0.01, default: 0.5, precision: 0, scale: 100, store: 'pot' },
    ],
    note: 'The wipers are across whatever reaches VCC: a stick on 3.3 V reads 3.3 V at full scale.',
  },
  'comp.tmp36': {
    kind: 'quantities',
    quantities: [{ label: 'Temperature', unit: '°C', min: -40, max: 125, step: 0.5, default: 25, precision: 1 }],
    note: '10 mV/°C with a 500 mV offset, on whichever analog pin VOUT reaches.',
  },
  'comp.ldr': {
    kind: 'quantities',
    quantities: [{ label: 'Light level', unit: '%', min: 0, max: 1, step: 0.01, default: 0.5, precision: 0, scale: 100 }],
  },
  'comp.ultrasonic': {
    kind: 'quantities',
    quantities: [{ label: 'Distance', unit: 'cm', min: 2, max: 400, step: 1, default: 100, precision: 0 }],
    note: 'The echo pulse is timed from this distance at the speed of sound, so pulseIn() measures it back.',
  },
  'comp.bmp280': {
    kind: 'quantities',
    quantities: [
      temperature(-40, 85, 25, 'temperature'),
      { channel: 'pressure', label: 'Pressure', unit: 'hPa', min: 300, max: 1100, step: 0.5, default: 1013.25, precision: 1, property: 'pressure' },
    ],
    note: 'Served over I2C as raw ADC counts that the datasheet compensation turns back into these values.',
  },
  'comp.bme280': {
    kind: 'quantities',
    quantities: [
      temperature(-40, 85, 22, 'temperature'),
      { channel: 'pressure', label: 'Pressure', unit: 'hPa', min: 300, max: 1100, step: 0.5, default: 1013, precision: 1, property: 'pressure' },
      { channel: 'humidity', label: 'Humidity', unit: '%RH', min: 0, max: 100, step: 0.5, default: 45, precision: 1, property: 'humidity' },
    ],
  },
  'comp.sht31': {
    kind: 'quantities',
    quantities: [
      temperature(-40, 125, 22, 'temperature'),
      { channel: 'humidity', label: 'Humidity', unit: '%RH', min: 0, max: 100, step: 0.5, default: 45, precision: 1, property: 'humidity' },
    ],
  },
  'comp.mpu6050': {
    kind: 'quantities',
    // Orientation rather than three raw accelerations: "tilt it 30° forward"
    // is what a person means, and the gravity vector that produces is exactly
    // what the standard atan2 pitch/roll arithmetic in a sketch recovers.
    quantities: [
      { channel: 'pitch', label: 'Pitch', unit: '°', min: -90, max: 90, step: 1, default: 0, precision: 0 },
      { channel: 'roll', label: 'Roll', unit: '°', min: -180, max: 180, step: 1, default: 0, precision: 0 },
      { channel: 'gx', label: 'Rotation X', unit: '°/s', min: -250, max: 250, step: 1, default: 0, precision: 0 },
      { channel: 'gy', label: 'Rotation Y', unit: '°/s', min: -250, max: 250, step: 1, default: 0, precision: 0 },
      { channel: 'gz', label: 'Rotation Z', unit: '°/s', min: -250, max: 250, step: 1, default: 0, precision: 0 },
      temperature(-40, 85, 36.53),
    ],
    note: 'Pitch and roll set the direction of gravity on the accelerometer; rotation sets the gyro rates.',
  },
  'comp.ds3231': {
    kind: 'quantities',
    quantities: [temperature(-40, 85, 25)],
    note: 'The DS3231 measures its own die temperature in quarter degrees; this sets it.',
  },
};

/** The controls a part offers, or undefined if it has nothing to set. */
export function inputControlsFor(definitionId: string): InputControlSpec | undefined {
  const fixed = FIXED[definitionId];
  if (fixed) return fixed;
  const analog = ANALOG_SENSORS[definitionId];
  if (analog) {
    const q = analog.quantity;
    const step = Math.pow(10, -q.precision) * (q.max - q.min > 1000 ? 10 : 1);
    return {
      kind: 'quantities',
      quantities: [
        {
          label: q.label,
          unit: q.unit,
          min: q.min,
          max: q.max,
          step,
          default: q.default,
          precision: q.precision,
          // The simulation has always fallen back to this property; the
          // control shows the same value it would use.
          property: q.key,
        },
      ],
      note: analog.note,
    };
  }
  const gpio = GPIO_SENSORS[definitionId];
  if (gpio) return { kind: 'trigger', label: gpio.label, latching: gpio.holdMs > 0, note: gpio.note };
  return undefined;
}

/** The store key a quantity's value lives under for one instance. */
export function controlKey(instanceId: string, q: Pick<InputQuantity, 'channel'>): string {
  return q.channel ? `${instanceId}#${q.channel}` : instanceId;
}

/**
 * The value a quantity has right now: the control if one was set, otherwise
 * the part's property, otherwise undefined.
 *
 * Undefined rather than the default on purpose — a device model with its own
 * state (a test that sets a BMP280's temperature directly, say) must not be
 * overwritten every frame by a default nobody chose.
 */
export function explicitQuantity(
  read: (key: string) => number | undefined,
  inst: Pick<ComponentInstance, 'id' | 'properties'>,
  q: InputQuantity,
): number | undefined {
  const set = read(controlKey(inst.id, q));
  if (set !== undefined && Number.isFinite(set)) return set;
  if (q.property !== undefined) {
    const raw = inst.properties[q.property];
    if (raw !== undefined && raw !== null && raw !== '') {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

/** The value a quantity has right now, falling back to its default. */
export function quantityValue(
  read: (key: string) => number | undefined,
  inst: Pick<ComponentInstance, 'id' | 'properties'>,
  q: InputQuantity,
): number {
  return explicitQuantity(read, inst, q) ?? q.default;
}

/** A part's quantity by channel, for the simulation's device cases. */
export function quantityOf(definitionId: string, channel?: string): InputQuantity {
  const spec = inputControlsFor(definitionId);
  const q = spec?.kind === 'quantities' ? spec.quantities.find((x) => x.channel === channel) : undefined;
  if (!q) throw new Error(`No input quantity "${channel ?? '(value)'}" is declared for ${definitionId}`);
  return q;
}

/** Clamps a typed value to the quantity's range, in stored units. */
export function clampQuantity(q: InputQuantity, stored: number): number {
  if (!Number.isFinite(stored)) return q.default;
  return Math.min(q.max, Math.max(q.min, stored));
}

/**
 * Gravity in g along the sensor's axes for a pitch and roll in degrees.
 *
 * The inverse of the arithmetic every MPU6050 tutorial uses —
 * roll = atan2(ay, az), pitch = atan2(-ax, sqrt(ay² + az²)) — so a sketch
 * that does that arrives back at the angles that were dialled in.
 */
export function gravityFor(pitchDeg: number, rollDeg: number): { x: number; y: number; z: number } {
  const p = (pitchDeg * Math.PI) / 180;
  const r = (rollDeg * Math.PI) / 180;
  const clean = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);
  return {
    x: clean(-Math.sin(p)),
    y: clean(Math.cos(p) * Math.sin(r)),
    z: clean(Math.cos(p) * Math.cos(r)),
  };
}
