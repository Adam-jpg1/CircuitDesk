import type { ComponentDefinition, PinDefinition, PropertyDefinition, SupportLevel } from '../types';
import { MM, pinAt, type PinSpec } from '../boards/pinHelpers';

function def(
  id: string,
  name: string,
  category: string,
  widthMm: number,
  heightMm: number,
  artworkId: string,
  pins: PinDefinition[],
  supportLevel: SupportLevel,
  options: Partial<Pick<ComponentDefinition, 'properties' | 'validationRules' | 'simulationAdapterId' | 'description' | 'internalGroups'>> = {},
): ComponentDefinition {
  return {
    id,
    name,
    category,
    widthMm,
    heightMm,
    artwork: { kind: 'builtin', builtinId: artworkId },
    pins,
    properties: options.properties ?? [],
    validationRules: options.validationRules ?? [],
    simulationAdapterId: options.simulationAdapterId,
    supportLevel,
    description: options.description,
    internalGroups: options.internalGroups,
    isBoard: false,
  };
}

const prop = (key: string, label: string, kind: PropertyDefinition['kind'], dflt: unknown, extra: Partial<PropertyDefinition> = {}): PropertyDefinition => ({
  key, label, kind, default: dflt, ...extra,
});

const pin = (id: string, label: string, xMm: number, yMm: number, spec: Partial<PinSpec> = {}): PinDefinition =>
  pinAt({ id, label, type: 'passive', caps: [], ...spec }, xMm, yMm);

// ---------- Breadboards ----------

function makeBreadboard(id: string, name: string, cols: number, withRails: boolean, widthMm: number, heightMm: number): ComponentDefinition {
  const pins: PinDefinition[] = [];
  const groups: Record<string, string> = {};
  const pitch = 2.54;
  const originX = (widthMm - (cols - 1) * pitch) / 2;
  const rowLetters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const topBankY = withRails ? 14.2 : 5.2;
  const gap = 7.62;

  for (let c = 0; c < cols; c++) {
    const x = originX + c * pitch;
    for (let r = 0; r < 5; r++) {
      const idA = `${rowLetters[r]}${c + 1}`;
      pins.push(pin(idA, `${rowLetters[r]}${c + 1}`, x, topBankY + r * pitch));
      groups[idA] = `col-top-${c}`;
    }
    for (let r = 5; r < 10; r++) {
      const idB = `${rowLetters[r]}${c + 1}`;
      pins.push(pin(idB, `${rowLetters[r]}${c + 1}`, x, topBankY + 4 * pitch + gap + (r - 5) * pitch));
      groups[idB] = `col-bot-${c}`;
    }
  }

  if (withRails) {
    const railCount = cols - 5;
    const railOriginX = originX + 2.5 * pitch;
    const rails: { key: string; y: number; label: string }[] = [
      { key: 'rail-top-plus', y: 3.0, label: '+' },
      { key: 'rail-top-minus', y: 5.6, label: '−' },
      { key: 'rail-bot-plus', y: heightMm - 5.6, label: '+' },
      { key: 'rail-bot-minus', y: heightMm - 3.0, label: '−' },
    ];
    for (const rail of rails) {
      for (let c = 0; c < railCount; c++) {
        // rails have a small visual gap every 5 holes but stay electrically continuous per rail
        const x = railOriginX + c * pitch + Math.floor(c / 5) * 1.4;
        const idR = `${rail.key}-${c + 1}`;
        pins.push(pin(idR, `${rail.label} rail`, x, rail.y));
        groups[idR] = rail.key;
      }
    }
  }

  return def(id, name, 'Breadboards', widthMm, heightMm, withRails ? 'breadboard' : 'breadboard-mini', pins, 'simulated', {
    description: `${name} — internal row connectivity is honored by the circuit graph: holes in the same column segment (and each power rail) are electrically connected.`,
    internalGroups: groups,
    validationRules: ['breadboard-connectivity'],
  });
}

export const BREADBOARD_HALF = makeBreadboard('comp.breadboard-half', 'Breadboard (half size, 400 pt)', 30, true, 83, 55);
export const BREADBOARD_MINI = makeBreadboard('comp.breadboard-mini', 'Breadboard (mini, 170 pt)', 17, false, 47, 35);

// ---------- Basic components ----------

export const LED = def(
  'comp.led', 'LED', 'Output', 5, 9, 'led',
  [
    pin('anode', 'Anode (+)', 1.25, 8.6, { type: 'anode', description: 'Longer leg — connect toward positive' }),
    pin('cathode', 'Cathode (−)', 3.75, 8.6, { type: 'cathode', description: 'Shorter leg / flat side — connect toward ground' }),
  ],
  'simulated',
  {
    properties: [
      prop('color', 'Color', 'select', 'red', {
        options: [
          { value: 'red', label: 'Red' }, { value: 'green', label: 'Green' }, { value: 'blue', label: 'Blue' },
          { value: 'yellow', label: 'Yellow' }, { value: 'orange', label: 'Orange' }, { value: 'white', label: 'White' },
        ],
      }),
      prop('forwardVoltage', 'Forward voltage', 'number', 2.0, { unit: 'V', min: 1.6, max: 3.6 }),
      prop('maxCurrentMa', 'Max current', 'number', 20, { unit: 'mA' }),
    ],
    validationRules: ['led-needs-resistor', 'led-polarity'],
    simulationAdapterId: 'sim.led',
    description: 'Standard 5 mm LED. Lights when the anode is driven high with a current path from cathode to ground. Brightness follows PWM duty cycle.',
  },
);

export const RGB_LED = def(
  'comp.rgb-led', 'RGB LED (common cathode)', 'Output', 8, 10, 'rgb-led',
  [
    pin('red', 'Red (+)', 1.0, 9.6, { type: 'anode' }),
    pin('cathode', 'Cathode (−)', 3.0, 9.6, { type: 'cathode' }),
    pin('green', 'Green (+)', 5.0, 9.6, { type: 'anode' }),
    pin('blue', 'Blue (+)', 7.0, 9.6, { type: 'anode' }),
  ],
  'simulated',
  {
    validationRules: ['led-needs-resistor', 'led-polarity'],
    simulationAdapterId: 'sim.rgb-led',
    description: 'Common-cathode RGB LED. Each color channel behaves like an independent LED; PWM mixes colors.',
  },
);

export const RESISTOR = def(
  'comp.resistor', 'Resistor', 'Basic', 12, 3.6, 'resistor',
  [
    pin('p1', 'Lead 1', 0.4, 1.8), pin('p2', 'Lead 2', 11.6, 1.8),
  ],
  'simulated',
  {
    properties: [prop('resistance', 'Resistance', 'number', 220, { unit: 'Ω', min: 1, max: 10_000_000 })],
    simulationAdapterId: 'sim.resistor',
    description: 'Through-hole resistor. Color bands are rendered from the resistance value. Conducts in the digital circuit model and satisfies LED current-limit validation.',
  },
);

export const CAPACITOR = def(
  'comp.capacitor', 'Capacitor (electrolytic)', 'Basic', 6, 10, 'capacitor',
  [pin('plus', '+', 1.5, 9.6, { type: 'anode' }), pin('minus', '−', 4.5, 9.6, { type: 'cathode' })],
  'validation',
  {
    properties: [prop('capacitance', 'Capacitance', 'number', 100, { unit: 'µF' })],
    description: 'Electrolytic capacitor. Validation-level: polarity and rail rules are checked, but transient charge/discharge is not simulated (no analog engine yet).',
  },
);

export const DIODE = def(
  'comp.diode', 'Diode (1N4007)', 'Basic', 10, 3.6, 'diode',
  [pin('anode', 'Anode', 0.4, 1.8, { type: 'anode' }), pin('cathode', 'Cathode', 9.6, 1.8, { type: 'cathode' })],
  'validation',
  { description: 'Rectifier diode. Validation-level: used for polarity and flyback checks; conduction is modeled directionally in the digital circuit graph.' },
);

export const TRANSISTOR_NPN = def(
  'comp.transistor-npn', 'NPN Transistor (2N2222)', 'Basic', 6, 6, 'transistor',
  [pin('emitter', 'Emitter', 0.8, 5.6), pin('base', 'Base', 3.0, 5.6), pin('collector', 'Collector', 5.2, 5.6)],
  'validation',
  { description: 'NPN BJT. Validation-level: wiring rules only. Switching behavior needs the future analog engine and is not claimed as simulated.' },
);

export const MOSFET = def(
  'comp.mosfet', 'N-MOSFET (IRLZ44N)', 'Basic', 10, 9, 'mosfet',
  [pin('gate', 'Gate', 1.7, 8.6), pin('drain', 'Drain', 5.0, 8.6), pin('source', 'Source', 8.3, 8.6)],
  'validation',
  { description: 'Logic-level N-channel MOSFET. Validation-level only until the analog engine exists.' },
);

// ---------- Inputs ----------

export const PUSH_BUTTON = def(
  'comp.push-button', 'Push Button', 'Input', 12, 12, 'push-button',
  [
    pin('1a', '1a', 1.5, 1.5), pin('1b', '1b', 1.5, 10.5),
    pin('2a', '2a', 10.5, 1.5), pin('2b', '2b', 10.5, 10.5),
  ],
  'simulated',
  {
    internalGroups: { '1a': 'side1', '1b': 'side1', '2a': 'side2', '2b': 'side2' },
    validationRules: ['button-floating-input'],
    simulationAdapterId: 'sim.push-button',
    description: 'Four-lead tactile push button. Legs 1a/1b are internally joined, as are 2a/2b. Pressing bridges the two sides — a real digital input to the emulator.',
  },
);

export const TOGGLE_SWITCH = def(
  'comp.toggle-switch', 'Toggle Switch', 'Input', 8, 13, 'toggle-switch',
  [pin('com', 'COM', 4.0, 12.6), pin('no', 'NO', 1.2, 12.6), pin('nc', 'NC', 6.8, 12.6)],
  'simulated',
  {
    simulationAdapterId: 'sim.toggle-switch',
    description: 'SPDT toggle switch. COM connects to NO or NC depending on the toggle state.',
  },
);

export const POTENTIOMETER = def(
  'comp.potentiometer', 'Potentiometer (10 kΩ)', 'Input', 15, 17, 'potentiometer',
  [
    pin('t1', 'Terminal 1', 2.5, 16.6), pin('wiper', 'Wiper', 7.5, 16.6), pin('t2', 'Terminal 2', 12.5, 16.6),
  ],
  'simulated',
  {
    properties: [prop('resistance', 'Total resistance', 'number', 10_000, { unit: 'Ω' })],
    simulationAdapterId: 'sim.potentiometer',
    description: 'Rotary potentiometer. With T1→GND and T2→5V, the wiper feeds a real ADC channel of the emulated ATmega328P.',
  },
);

// ---------- Outputs ----------

export const BUZZER = def(
  'comp.buzzer', 'Buzzer (active)', 'Output', 12, 12, 'buzzer',
  [pin('plus', '+', 4.5, 11.6, { type: 'anode' }), pin('minus', '−', 7.5, 11.6, { type: 'cathode' })],
  'simulated',
  {
    simulationAdapterId: 'sim.buzzer',
    description: 'Active piezo buzzer: sounds while its + pin is driven high (visual + optional audio via WebAudio).',
  },
);

export const SPEAKER = def(
  'comp.speaker', 'Speaker (8 Ω)', 'Output', 20, 20, 'speaker',
  [pin('plus', '+', 7.0, 19.6), pin('minus', '−', 13.0, 19.6)],
  'validation',
  { description: 'Small speaker. Validation-level: audio waveform synthesis from PWM is not simulated.' },
);

export const RELAY = def(
  'comp.relay', 'Relay Module (1ch)', 'Modules', 26, 34, 'relay',
  [
    pin('vcc', 'VCC', 4.0, 33.6, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('gnd', 'GND', 8.0, 33.6, { type: 'ground', caps: ['ground'] }),
    pin('in', 'IN', 12.0, 33.6, { type: 'digital', caps: ['digital-in'] }),
    pin('com', 'COM', 6.0, 0.6), pin('no', 'NO', 13.0, 0.6), pin('nc', 'NC', 20.0, 0.6),
  ],
  'validation',
  { description: 'Relay breakout. Wiring/validation-level: coil energizing indicator only; switched load side is not electrically simulated.' },
);

export const SERVO = def(
  'comp.servo', 'Servo (SG90)', 'Motors', 32, 30, 'servo',
  [
    pin('gnd', 'GND (brown)', 1.0, 12.0, { type: 'ground', caps: ['ground'] }),
    pin('vcc', 'VCC (red)', 1.0, 15.0, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('sig', 'Signal (orange)', 1.0, 18.0, { type: 'digital', caps: ['digital-in', 'pwm'] }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.servo',
    description: 'Micro servo. The horn angle is derived from the real 50 Hz pulse width produced by the executed firmware (1–2 ms → 0–180°).',
  },
);

export const DC_MOTOR = def(
  'comp.dc-motor', 'DC Motor', 'Motors', 25, 20, 'dc-motor',
  [pin('m1', 'M1', 0.6, 8.0), pin('m2', 'M2', 0.6, 12.0)],
  'validation',
  { description: 'Brushed DC motor. Validation-level (needs driver; direct GPIO drive is flagged as over-current).', validationRules: ['motor-needs-driver'] },
);

export const STEPPER = def(
  'comp.stepper', 'Stepper Motor (28BYJ-48)', 'Motors', 30, 30, 'stepper',
  [
    pin('in1', 'IN1', 0.6, 9.0), pin('in2', 'IN2', 0.6, 13.0), pin('in3', 'IN3', 0.6, 17.0), pin('in4', 'IN4', 0.6, 21.0),
  ],
  'validation',
  { description: 'Geared stepper. Validation-level: step sequencing display is not simulated yet.' },
);

export const MOTOR_DRIVER = def(
  'comp.motor-driver', 'Motor Driver (L298N)', 'Motors', 43, 43, 'motor-driver',
  [
    pin('vcc', '12V', 2.0, 42.6, { type: 'power-vin', caps: ['power'], voltage: 12 }),
    pin('gnd', 'GND', 6.0, 42.6, { type: 'ground', caps: ['ground'] }),
    pin('v5', '5V', 10.0, 42.6, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('ena', 'ENA', 15.0, 42.6, { type: 'digital', caps: ['digital-in', 'pwm'] }),
    pin('in1', 'IN1', 19.0, 42.6, { type: 'digital', caps: ['digital-in'] }),
    pin('in2', 'IN2', 23.0, 42.6, { type: 'digital', caps: ['digital-in'] }),
    pin('in3', 'IN3', 27.0, 42.6, { type: 'digital', caps: ['digital-in'] }),
    pin('in4', 'IN4', 31.0, 42.6, { type: 'digital', caps: ['digital-in'] }),
    pin('enb', 'ENB', 35.0, 42.6, { type: 'digital', caps: ['digital-in', 'pwm'] }),
    pin('out1', 'OUT1', 0.4, 8.0), pin('out2', 'OUT2', 0.4, 14.0),
    pin('out3', 'OUT3', 42.6, 8.0), pin('out4', 'OUT4', 42.6, 14.0),
  ],
  'validation',
  { description: 'Dual H-bridge driver. Wiring/validation-level.' },
);

// ---------- Displays ----------

export const LCD1602 = def(
  'comp.lcd1602', 'LCD 16×2 (I2C)', 'Displays', 80, 36, 'lcd1602',
  [
    pin('gnd', 'GND', 2.0, 2.0, { type: 'ground', caps: ['ground'] }),
    pin('vcc', 'VCC', 6.0, 2.0, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('sda', 'SDA', 10.0, 2.0, { type: 'digital', caps: ['i2c-sda'] }),
    pin('scl', 'SCL', 14.0, 2.0, { type: 'digital', caps: ['i2c-scl'] }),
  ],
  'validation',
  {
    validationRules: ['i2c-pins'],
    description: 'Character LCD with I2C backpack. Wiring/validation-level: I2C pin and pull-up rules are checked; the HD44780 protocol is not decoded yet.',
  },
);

export const OLED = def(
  'comp.oled', 'OLED 128×64 (SSD1306)', 'Displays', 27, 27, 'oled',
  [
    pin('gnd', 'GND', 7.5, 1.0, { type: 'ground', caps: ['ground'] }),
    pin('vcc', 'VCC', 11.5, 1.0, { type: 'power-3v3', caps: ['power'], voltage: 3.3 }),
    pin('scl', 'SCL', 15.5, 1.0, { type: 'digital', caps: ['i2c-scl'] }),
    pin('sda', 'SDA', 19.5, 1.0, { type: 'digital', caps: ['i2c-sda'] }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.ssd1306',
    validationRules: ['i2c-pins'],
    description:
      'I2C OLED driven by real SSD1306 traffic: firmware Wire writes are decoded into display RAM and drawn. Address 0x3C by default (0x3D selectable). Only responds when SDA/SCL, VCC and GND are actually wired.',
  },
);

export const SEVEN_SEGMENT = def(
  'comp.seven-segment', '7-Segment Display (CC)', 'Displays', 14, 20, 'seven-segment',
  [
    pin('a', 'A', 2.0, 0.6, { type: 'anode' }), pin('b', 'B', 6.0, 0.6, { type: 'anode' }),
    pin('c', 'C', 10.0, 0.6, { type: 'anode' }), pin('com1', 'COM', 12.5, 0.6, { type: 'cathode' }),
    pin('d', 'D', 2.0, 19.4, { type: 'anode' }), pin('e', 'E', 6.0, 19.4, { type: 'anode' }),
    pin('f', 'F', 10.0, 19.4, { type: 'anode' }), pin('g', 'G', 12.5, 19.4, { type: 'anode' }),
    pin('dp', 'DP', 14 - 1.5, 10, { type: 'anode' }),
  ],
  'simulated',
  {
    internalGroups: {},
    simulationAdapterId: 'sim.seven-segment',
    validationRules: ['led-needs-resistor'],
    description: 'Common-cathode 7-segment digit. Each segment lights from real GPIO state (COM must reach ground).',
  },
);

// ---------- Sensors ----------

export const ULTRASONIC = def(
  'comp.ultrasonic', 'Ultrasonic Sensor (HC-SR04)', 'Sensors', 45, 20, 'ultrasonic',
  [
    pin('vcc', 'VCC', 16.0, 19.4, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('trig', 'TRIG', 20.0, 19.4, { type: 'digital', caps: ['digital-in'] }),
    pin('echo', 'ECHO', 24.0, 19.4, { type: 'digital', caps: ['digital-out'] }),
    pin('gnd', 'GND', 28.0, 19.4, { type: 'ground', caps: ['ground'] }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.ultrasonic',
    description: 'HC-SR04. Simulated protocol: firmware pulses TRIG, the sensor answers on ECHO with a pulse width matching the user-set distance (58 µs/cm).',
  },
);

export const TMP36 = def(
  'comp.tmp36', 'Temperature Sensor (TMP36)', 'Sensors', 6, 7, 'tmp36',
  [
    pin('vcc', '+VS', 0.9, 6.6, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('vout', 'VOUT', 3.0, 6.6, { type: 'analog', caps: ['digital-out'] }),
    pin('gnd', 'GND', 5.1, 6.6, { type: 'ground', caps: ['ground'] }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.tmp36',
    description: 'Analog temperature sensor. VOUT = 0.5 V + 10 mV/°C from the user-set temperature, fed to the real emulated ADC.',
  },
);

export const LDR = def(
  'comp.ldr', 'Light Sensor (LDR)', 'Sensors', 8, 10, 'ldr',
  [pin('p1', 'Leg 1', 2.0, 9.6), pin('p2', 'Leg 2', 6.0, 9.6)],
  'simulated',
  {
    simulationAdapterId: 'sim.ldr',
    description: 'Photoresistor. In a divider with a fixed resistor, the user-set light level sets the divider voltage on the emulated ADC.',
  },
);

export const BMP280 = def(
  'comp.bmp280', 'Pressure Sensor (BMP280)', 'Sensors', 15, 12, 'bmp280',
  [
    pin('vcc', 'VCC', 2.0, 11.6, { type: 'power-3v3', caps: ['power'], voltage: 3.3 }),
    pin('gnd', 'GND', 5.0, 11.6, { type: 'ground', caps: ['ground'] }),
    pin('scl', 'SCL', 8.0, 11.6, { type: 'digital', caps: ['i2c-scl'] }),
    pin('sda', 'SDA', 11.0, 11.6, { type: 'digital', caps: ['i2c-sda'] }),
  ],
  'validation',
  { validationRules: ['i2c-pins'], description: 'I2C pressure sensor. Wiring/validation-level: the I2C register protocol is not simulated.' },
);

export const PULSE_SENSOR = def(
  'comp.pulse-sensor', 'Pulse Sensor', 'Sensors', 16, 16, 'pulse-sensor',
  [
    pin('sig', 'Signal', 4.0, 15.6, { type: 'analog', caps: ['digital-out'] }),
    pin('vcc', 'VCC', 8.0, 15.6, { type: 'power-3v3', caps: ['power'], voltage: 3.3 }),
    pin('gnd', 'GND', 12.0, 15.6, { type: 'ground', caps: ['ground'] }),
  ],
  'validation',
  { description: 'Optical pulse sensor. Validation-level: waveform generation is not simulated yet.' },
);

export const MPU6050 = def(
  'comp.mpu6050', 'IMU (MPU-6050)', 'Sensors', 21, 16, 'mpu6050',
  [
    pin('vcc', 'VCC', 2.0, 0.6, { type: 'power-3v3', caps: ['power'], voltage: 3.3 }),
    pin('gnd', 'GND', 5.0, 0.6, { type: 'ground', caps: ['ground'] }),
    pin('scl', 'SCL', 8.0, 0.6, { type: 'digital', caps: ['i2c-scl'] }),
    pin('sda', 'SDA', 11.0, 0.6, { type: 'digital', caps: ['i2c-sda'] }),
    pin('xda', 'XDA', 14.0, 0.6), pin('xcl', 'XCL', 17.0, 0.6),
    pin('ad0', 'AD0', 20.0, 0.6), pin('int', 'INT', 20.0, 4.0, { caps: ['digital-out'] }),
  ],
  'validation',
  { validationRules: ['i2c-pins'], description: 'Accelerometer + gyro on I2C. Wiring/validation-level only — sensor registers are not simulated.' },
);

export const GPS = def(
  'comp.gps', 'GPS Module (NEO-6M)', 'Modules', 25, 35, 'gps',
  [
    pin('vcc', 'VCC', 4.0, 34.6, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('rx', 'RX', 9.0, 34.6, { type: 'digital', caps: ['uart-rx'] }),
    pin('tx', 'TX', 14.0, 34.6, { type: 'digital', caps: ['uart-tx'] }),
    pin('gnd', 'GND', 19.0, 34.6, { type: 'ground', caps: ['ground'] }),
  ],
  'validation',
  { validationRules: ['uart-pins'], description: 'Serial GPS. Wiring/validation-level: NMEA sentence emission is not simulated yet.' },
);

export const BLUETOOTH = def(
  'comp.hc05', 'Bluetooth Module (HC-05)', 'Modules', 16, 36, 'hc05',
  [
    pin('en', 'EN', 2.0, 35.6),
    pin('vcc', 'VCC', 5.0, 35.6, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('gnd', 'GND', 8.0, 35.6, { type: 'ground', caps: ['ground'] }),
    pin('txd', 'TXD', 11.0, 35.6, { type: 'digital', caps: ['uart-tx'], voltage: 3.3 }),
    pin('rxd', 'RXD', 14.0, 35.6, { type: 'digital', caps: ['uart-rx'], voltage: 3.3, description: '3.3 V logic — use a divider from 5 V TX' }),
  ],
  'validation',
  { validationRules: ['uart-pins', 'voltage-level'], description: 'Classic Bluetooth SPP module. Wiring/validation-level: RXD is 3.3 V-only, which the validator enforces.' },
);

export const WIFI_ESP01 = def(
  'comp.esp01', 'Wi-Fi Module (ESP-01)', 'Modules', 14.5, 24.8, 'esp01',
  [
    pin('gnd', 'GND', 3.5, 24.2, { type: 'ground', caps: ['ground'] }),
    pin('gpio2', 'GPIO2', 6.0, 24.2, { voltage: 3.3, caps: ['digital-in', 'digital-out'] }),
    pin('gpio0', 'GPIO0', 8.5, 24.2, { voltage: 3.3, caps: ['digital-in', 'digital-out'] }),
    pin('rx', 'RX', 11.0, 24.2, { type: 'digital', caps: ['uart-rx'], voltage: 3.3 }),
    pin('tx', 'TX', 3.5, 21.2, { type: 'digital', caps: ['uart-tx'], voltage: 3.3 }),
    pin('ch_pd', 'CH_PD', 6.0, 21.2, { voltage: 3.3 }),
    pin('rst', 'RST', 8.5, 21.2, { type: 'reset', voltage: 3.3 }),
    pin('vcc', 'VCC', 11.0, 21.2, { type: 'power-3v3', caps: ['power'], voltage: 3.3 }),
  ],
  'validation',
  { validationRules: ['voltage-level'], description: 'ESP-01 Wi-Fi module — strictly 3.3 V. The validator flags any 5 V connection to its pins.' },
);

// ---------- Power ----------

export const BATTERY_9V = def(
  'comp.battery-9v', 'Battery (9 V)', 'Power', 26, 46, 'battery-9v',
  [
    pin('plus', '+', 8.0, 2.0, { type: 'power-vin', caps: ['power'], voltage: 9 }),
    pin('minus', '−', 18.0, 2.0, { type: 'ground', caps: ['ground'] }),
  ],
  'simulated',
  { simulationAdapterId: 'sim.supply', description: '9 V battery. Acts as a real supply in the circuit graph (drives VIN-level nets).' },
);

export const BATTERY_AA = def(
  'comp.battery-aa', 'Battery Holder (2×AA, 3 V)', 'Power', 33, 58, 'battery-aa',
  [
    pin('plus', '+', 6.0, 2.0, { type: 'power-3v3', caps: ['power'], voltage: 3 }),
    pin('minus', '−', 27.0, 2.0, { type: 'ground', caps: ['ground'] }),
  ],
  'simulated',
  { simulationAdapterId: 'sim.supply', description: '2×AA holder (~3 V). Acts as a supply in the circuit graph.' },
);

export const REGULATOR = def(
  'comp.regulator', 'Voltage Regulator (AMS1117-3.3)', 'Power', 10, 9, 'regulator',
  [
    pin('vin', 'VIN', 1.7, 8.6, { type: 'power-vin', caps: ['power'] }),
    pin('gnd', 'GND', 5.0, 8.6, { type: 'ground', caps: ['ground'] }),
    pin('vout', 'VOUT', 8.3, 8.6, { type: 'power-3v3', caps: ['power'], voltage: 3.3 }),
  ],
  'validation',
  { description: '3.3 V LDO regulator. Validation-level: treated as a 3.3 V source when powered.' },
);

export const LEVEL_CONVERTER = def(
  'comp.level-converter', 'Logic Level Converter (4ch)', 'Power', 16, 16, 'level-converter',
  [
    pin('hv', 'HV', 2.0, 0.6, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('hv1', 'HV1', 6.0, 0.6, { voltage: 5 }), pin('hv2', 'HV2', 10.0, 0.6, { voltage: 5 }),
    pin('gnd_h', 'GND', 14.0, 0.6, { type: 'ground', caps: ['ground'] }),
    pin('lv', 'LV', 2.0, 15.4, { type: 'power-3v3', caps: ['power'], voltage: 3.3 }),
    pin('lv1', 'LV1', 6.0, 15.4, { voltage: 3.3 }), pin('lv2', 'LV2', 10.0, 15.4, { voltage: 3.3 }),
    pin('gnd_l', 'GND', 14.0, 15.4, { type: 'ground', caps: ['ground'] }),
  ],
  'validation',
  { internalGroups: { gnd_h: 'gnd', gnd_l: 'gnd' }, description: 'Bidirectional level shifter. Validation-level: legitimizes 5 V↔3.3 V connections through its channels.' },
);

export const GENERIC_IC = def(
  'comp.generic-ic', 'Generic IC (DIP-8)', 'ICs', 10, 10, 'generic-ic',
  [
    pin('p1', '1', 1.4, 9.6), pin('p2', '2', 3.8, 9.6), pin('p3', '3', 6.2, 9.6), pin('p4', '4', 8.6, 9.6),
    pin('p5', '5', 8.6, 0.4), pin('p6', '6', 6.2, 0.4), pin('p7', '7', 3.8, 0.4), pin('p8', '8', 1.4, 0.4),
  ],
  'wiring',
  { properties: [prop('partNumber', 'Part number', 'text', 'NE555')], description: 'Generic DIP-8 IC placeholder for planning. Wiring-level.' },
);

export const HEADER_CONNECTOR = def(
  'comp.header-4', 'Header Connector (4-pin)', 'Connectors', 11, 6, 'header',
  [pin('p1', '1', 1.3, 3.0), pin('p2', '2', 3.8, 3.0), pin('p3', '3', 6.3, 3.0), pin('p4', '4', 8.8, 3.0)],
  'wiring',
  { description: '2.54 mm pin header, useful for documenting off-board connections.' },
);

export const COMPONENT_DEFINITIONS: ComponentDefinition[] = [
  BREADBOARD_HALF, BREADBOARD_MINI,
  LED, RGB_LED, RESISTOR, CAPACITOR, DIODE, TRANSISTOR_NPN, MOSFET,
  PUSH_BUTTON, TOGGLE_SWITCH, POTENTIOMETER,
  BUZZER, SPEAKER, RELAY,
  SERVO, DC_MOTOR, STEPPER, MOTOR_DRIVER,
  LCD1602, OLED, SEVEN_SEGMENT,
  ULTRASONIC, TMP36, LDR, BMP280, PULSE_SENSOR, MPU6050,
  GPS, BLUETOOTH, WIFI_ESP01,
  BATTERY_9V, BATTERY_AA, REGULATOR, LEVEL_CONVERTER,
  GENERIC_IC, HEADER_CONNECTOR,
];

export { MM };
