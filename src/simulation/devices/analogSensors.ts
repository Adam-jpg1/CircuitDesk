// Analog sensors, as one transfer function each.
//
// Every part in this family does the same thing: it takes a quantity a user
// can change during the simulation — a temperature, a force, a light level —
// and imposes the voltage a real part would produce for it, on a real net,
// which the board's real ADC then reads. The firmware does the conversion back
// with the same arithmetic it would use on the bench.
//
// What this is NOT: a property the firmware reads. If the sensor's output pin
// is not wired to an analog-capable pin, nothing happens at all, because
// nothing would happen on a breadboard either.
//
// The honest limits, stated once for the whole family: these are behavioural
// transfer functions, not device physics. Source impedance, self-heating,
// noise, response time and supply sensitivity are not modelled. Where a part
// is genuinely a variable resistor rather than a voltage source (a thermistor,
// an LDR, an FSR), the divider it would be used in is approximated rather than
// solved, and that is recorded in the part's own description.

/** What a user can set, and the range it makes sense over. */
export interface SensorQuantity {
  /** Control key — the same id the inspector slider writes. */
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  default: number;
  /** Decimal places to show. */
  precision: number;
}

export interface AnalogSensorSpec {
  id: string;
  /** The pin whose voltage this sensor imposes. */
  outputPin: string;
  quantity: SensorQuantity;
  /**
   * Volts for a given quantity at a given supply.
   *
   * Supply is passed because most of these are ratiometric: a divider on 3.3V
   * does not produce the same voltage as the same divider on 5V, and a model
   * that ignored that would read a third high on every ESP32 project.
   */
  volts(value: number, supply: number): number;
  /**
   * Volts at a moment, for a sensor whose output is a waveform rather than a
   * level. Takes precedence over `volts` when present.
   */
  voltsAt?(value: number, supply: number, timeMs: number): number;
  /** One line for the inspector, describing what is and is not modelled. */
  note: string;
}

/** A resistive divider's output: Rlower / (Rupper + Rlower) × supply. */
function divider(rSensor: number, rFixed: number, supply: number, sensorOnTop: boolean): number {
  const total = rSensor + rFixed;
  if (total <= 0) return 0;
  return supply * ((sensorOnTop ? rFixed : rSensor) / total);
}

/**
 * NTC thermistor resistance from the beta equation.
 *
 * The beta model is the one every hobby datasheet quotes and every Arduino
 * library implements, so firmware written against it arrives back at the
 * temperature that was dialled in.
 */
export function ntcResistance(celsius: number, r25 = 10_000, beta = 3950): number {
  const kelvin = celsius + 273.15;
  return r25 * Math.exp(beta * (1 / kelvin - 1 / 298.15));
}

/**
 * One heartbeat as an optical pulse sensor sees it, as a fraction of supply.
 *
 * The shape of a photoplethysmogram: a sharp systolic upstroke, a slower
 * fall, the small dicrotic bump as the aortic valve closes, and a slight
 * undershoot before the next beat — riding on a baseline at half supply,
 * which is where the PulseSensor's amplifier centres its output. `phase` runs
 * 0..1 over one beat.
 */
export function pulseWaveform(phase: number): number {
  const bump = (centre: number, width: number) => Math.exp(-(((phase - centre) / width) ** 2));
  return 0.5 + 0.26 * bump(0.12, 0.045) + 0.07 * bump(0.34, 0.05) - 0.04 * bump(0.6, 0.12);
}

export const ANALOG_SENSORS: Record<string, AnalogSensorSpec> = {
  'comp.pulse-sensor': {
    id: 'comp.pulse-sensor',
    outputPin: 'sig',
    quantity: { key: 'bpm', label: 'Heart rate', unit: 'BPM', min: 30, max: 200, default: 72, precision: 0 },
    volts: (_bpm, supply) => supply * 0.5,
    voltsAt: (bpm, supply, timeMs) => {
      const periodMs = 60_000 / Math.max(1, bpm);
      return supply * pulseWaveform((timeMs % periodMs) / periodMs);
    },
    note:
      'A heartbeat waveform at the rate set here: baseline at half supply, a systolic peak about a quarter of supply above it, and the dicrotic notch. ' +
      'The PulseSensor library finds the beats in it and reports the BPM back. No finger, motion or ambient-light artefacts.',
  },
  'comp.lm35': {
    id: 'comp.lm35',
    outputPin: 'vout',
    quantity: { key: 'temperature', label: 'Temperature', unit: '°C', min: -10, max: 110, default: 25, precision: 1 },
    // 10 mV per °C with no offset — which is why an LM35 cannot read below
    // zero on a single supply, and the model does not pretend otherwise.
    volts: (c) => Math.max(0, c * 0.01),
    note: 'Linear 10 mV/°C output. Below 0 °C the output clamps at zero, as it does on a single supply.',
  },
  'comp.ntc-thermistor': {
    id: 'comp.ntc-thermistor',
    outputPin: 'vout',
    quantity: { key: 'temperature', label: 'Temperature', unit: '°C', min: -20, max: 125, default: 25, precision: 1 },
    // 10k NTC on top of a 10k fixed resistor: the classic divider, so a
    // library's beta conversion returns the temperature that was set.
    volts: (c, supply) => divider(ntcResistance(c), 10_000, supply, true),
    note: 'Beta-model 10 kΩ NTC in a divider with a 10 kΩ fixed resistor to ground. Ratiometric with the supply.',
  },
  'comp.flex-sensor': {
    id: 'comp.flex-sensor',
    outputPin: 'vout',
    quantity: { key: 'bend', label: 'Bend', unit: '%', min: 0, max: 100, default: 0, precision: 0 },
    // Straight is about 25k, fully bent about 100k, in a divider with 47k.
    volts: (bend, supply) => divider(25_000 + (bend / 100) * 75_000, 47_000, supply, true),
    note: 'Resistance rises with bend (25 kΩ straight to 100 kΩ bent) in a divider with a 47 kΩ resistor.',
  },
  'comp.fsr': {
    id: 'comp.fsr',
    outputPin: 'vout',
    quantity: { key: 'force', label: 'Force', unit: 'N', min: 0, max: 100, default: 0, precision: 1 },
    // Force-sensitive resistors fall roughly as an inverse power law, and are
    // effectively open with nothing on them.
    volts: (force, supply) => {
      const resistance = force <= 0 ? 10_000_000 : Math.max(200, 30_000 / Math.pow(force, 0.7));
      return divider(resistance, 10_000, supply, true);
    },
    note: 'Inverse power-law resistance in a divider with 10 kΩ. Unloaded it is effectively open, so the output sits near zero.',
  },
  'comp.soil-moisture': {
    id: 'comp.soil-moisture',
    outputPin: 'vout',
    quantity: { key: 'moisture', label: 'Moisture', unit: '%', min: 0, max: 100, default: 30, precision: 0 },
    // These modules output *high* when dry, which catches people out, so the
    // model keeps that inversion rather than quietly making it intuitive.
    volts: (moisture, supply) => supply * (1 - moisture / 100),
    note: 'Capacitive-style module: output falls as moisture rises, so dry reads near the supply. Ratiometric.',
  },
  'comp.mq2': {
    id: 'comp.mq2',
    outputPin: 'aout',
    quantity: { key: 'gas', label: 'Gas concentration', unit: 'ppm', min: 200, max: 10_000, default: 400, precision: 0 },
    // Log-scale response, which is what the datasheet curve is and why these
    // are calibrated rather than read directly.
    volts: (ppm, supply) => {
      const ratio = Math.log10(Math.max(200, ppm) / 200) / Math.log10(50);
      return Math.min(supply, supply * (0.1 + ratio * 0.85));
    },
    note: 'Logarithmic response over 200-10000 ppm. Behavioural only: no heater warm-up, no gas selectivity, no calibration curve per gas.',
  },
  'comp.rain-sensor': {
    id: 'comp.rain-sensor',
    outputPin: 'aout',
    quantity: { key: 'rain', label: 'Wetness', unit: '%', min: 0, max: 100, default: 0, precision: 0 },
    volts: (wet, supply) => supply * (1 - wet / 100),
    note: 'Board resistance falls as the surface wets, so the analog output falls. Behavioural only.',
  },
  'comp.photodiode': {
    id: 'comp.photodiode',
    outputPin: 'vout',
    quantity: { key: 'light', label: 'Illuminance', unit: 'lx', min: 0, max: 10_000, default: 200, precision: 0 },
    // A photodiode into a transimpedance stage: current is linear in light,
    // and the stage saturates. Deliberately behavioural — the diode's own
    // physics needs the analog solver.
    volts: (lux, supply) => Math.min(supply, (lux / 10_000) * supply),
    note: 'Behavioural: photocurrent taken as linear in illuminance through a fixed transimpedance. Junction physics needs the analog solver.',
  },
};

// -------------------------------------------------------------- GPIO sensors
//
// Parts whose whole output is one digital line. They are cheap to model and
// genuinely useful, and the thing that makes them honest is that the line is
// driven onto a real net rather than handed to the firmware.

export interface GpioSensorSpec {
  id: string;
  /** The pin this sensor drives. */
  outputPin: string;
  /** True when the output is asserted low rather than high. */
  activeLow?: boolean;
  /** The user-facing state, which is a toggle rather than a slider. */
  label: string;
  /** How long the output stays asserted after triggering, in ms. 0 = follows. */
  holdMs: number;
  note: string;
}

export const GPIO_SENSORS: Record<string, GpioSensorSpec> = {
  'comp.pir': {
    id: 'comp.pir',
    outputPin: 'out',
    label: 'Motion detected',
    // A real PIR holds its output high for a retrigger period after motion.
    // It does not flicker, and it does not fire on its own — so this one does
    // not either. Nothing here is random.
    holdMs: 2000,
    note: 'Output goes high on motion and holds for the retrigger time. Never self-triggers: motion is something you cause.',
  },
  'comp.tilt-switch': {
    id: 'comp.tilt-switch',
    outputPin: 'out',
    label: 'Tilted',
    holdMs: 0,
    note: 'A ball switch: the output follows the tilt state directly.',
  },
  'comp.vibration-sensor': {
    id: 'comp.vibration-sensor',
    outputPin: 'out',
    label: 'Vibration',
    holdMs: 120,
    note: 'SW-420 style module: a short pulse per shock event, with the comparator threshold left out of the model.',
  },
  'comp.hall-sensor': {
    id: 'comp.hall-sensor',
    outputPin: 'out',
    activeLow: true,
    label: 'Magnet present',
    holdMs: 0,
    note: 'Digital Hall switch with an open-drain style active-low output: it pulls low while a magnet is near.',
  },
};
