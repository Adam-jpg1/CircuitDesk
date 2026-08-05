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
  'simulated',
  {
    simulationAdapterId: 'sim.lcd1602',
    validationRules: ['i2c-pins'],
    description:
      'Character LCD on a PCF8574 I2C backpack, decoded end to end: bytes land on the expander pins, the HD44780 latches a nibble on each EN falling edge, and the resulting characters appear at their real DDRAM addresses (line 2 starts at 0x40). Clear, home, entry mode, display/cursor control and DDRAM addressing are implemented; custom CGRAM glyphs are accepted but not rendered. Address 0x27 by default (0x3F for PCF8574A backpacks).',
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
  'simulated',
  {
    simulationAdapterId: 'sim.bmp280',
    validationRules: ['i2c-pins'],
    description:
      'I2C temperature + pressure sensor driven by real firmware traffic: the chip ID, calibration block, ctrl_meas/config and the raw ADC registers are all served by the device model, so the sketch runs the datasheet compensation itself. Address 0x76 by default (0x77 selectable). Only responds when SDA/SCL, VCC and GND are actually wired.',
  },
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
  'simulated',
  {
    simulationAdapterId: 'sim.mpu6050',
    validationRules: ['i2c-pins'],
    description:
      'Accelerometer + gyro driven by real firmware traffic: WHO_AM_I, power management, the range registers and the 14-byte accel/temp/gyro burst are served by the device model at the selected full scale. The part boots asleep, so firmware must clear the SLEEP bit. Address 0x68, or 0x69 when AD0 is tied to a supply. Only responds when SDA/SCL, VCC and GND are actually wired.',
  },
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

export const HC595 = def(
  'comp.hc595', 'Shift Register (74HC595)', 'ICs', 10, 18, 'hc595',
  [
    pin('q1', 'Q1', 1.4, 17.6, { caps: ['digital-out'] }),
    pin('q2', 'Q2', 3.8, 17.6, { caps: ['digital-out'] }),
    pin('q3', 'Q3', 6.2, 17.6, { caps: ['digital-out'] }),
    pin('q4', 'Q4', 8.6, 17.6, { caps: ['digital-out'] }),
    pin('q5', 'Q5', 8.6, 14.0, { caps: ['digital-out'] }),
    pin('q6', 'Q6', 8.6, 10.4, { caps: ['digital-out'] }),
    pin('q7', 'Q7', 8.6, 6.8, { caps: ['digital-out'] }),
    pin('gnd', 'GND', 1.4, 14.0, { type: 'ground', caps: ['ground'] }),
    pin('q0', 'Q0', 1.4, 10.4, { caps: ['digital-out'] }),
    pin('ser', 'SER', 1.4, 6.8, { type: 'digital', caps: ['spi-mosi'] }),
    pin('oe', 'OE', 1.4, 3.2, { type: 'digital', caps: ['digital-in'] }),
    pin('rclk', 'RCLK', 3.8, 3.2, { type: 'digital', caps: ['digital-in'] }),
    pin('srclk', 'SRCLK', 6.2, 3.2, { type: 'digital', caps: ['spi-sck'] }),
    pin('srclr', 'SRCLR', 8.6, 3.2, { type: 'digital', caps: ['digital-in'] }),
    pin('qh2', "QH'", 8.6, 0.4, { caps: ['digital-out'] }),
    pin('vcc', 'VCC', 1.4, 0.4, { type: 'power-5v', caps: ['power'], voltage: 5 }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.hc595',
    description:
      'Serial-in / parallel-out shift register driven by real SPI traffic: firmware shifts bits on SRCLK and they appear on Q0-Q7 only when RCLK rises. OE (active low) puts the outputs in high impedance and SRCLR clears the shift register. Outputs drive real net voltages, so an LED on Q0 lights from bits the sketch actually shifted. It has no chip select, so — like the real part — it shifts whatever appears on the clock.',
  },
);

export const SD_CARD = def(
  'comp.sd-card', 'SD Card Module (SPI)', 'Modules', 24, 28, 'sd-card',
  [
    pin('gnd', 'GND', 2.0, 27.6, { type: 'ground', caps: ['ground'] }),
    pin('vcc', 'VCC', 6.0, 27.6, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('miso', 'MISO', 10.0, 27.6, { type: 'digital', caps: ['spi-miso'] }),
    pin('mosi', 'MOSI', 14.0, 27.6, { type: 'digital', caps: ['spi-mosi'] }),
    pin('sck', 'SCK', 18.0, 27.6, { type: 'digital', caps: ['spi-sck'] }),
    pin('cs', 'CS', 22.0, 27.6, { type: 'digital', caps: ['spi-ss'] }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.sd-card',
    description:
      'A 4 MiB standard-capacity card in SPI mode, preformatted FAT16. The real command layer is simulated \u2014 CMD0/CMD8/CMD58/ACMD41 initialisation (including the "still initialising" polls), CMD17/CMD18 block reads with the 0xFE data token, and CMD24 block writes with the busy period. FAT itself is left to the host library, as on real hardware; unimplemented commands answer with the illegal-command bit rather than pretending.',
  },
);

export const SPI_FLASH = def(
  'comp.spi-flash', 'SPI Flash (W25Q80, 1 MiB)', 'Memory', 12, 10, 'spi-flash',
  [
    pin('cs', 'CS', 1.4, 9.6, { type: 'digital', caps: ['spi-ss'] }),
    pin('miso', 'DO', 1.4, 6.4, { type: 'digital', caps: ['spi-miso'] }),
    pin('wp', 'WP', 1.4, 3.2, { type: 'digital', caps: ['digital-in'] }),
    pin('gnd', 'GND', 1.4, 0.4, { type: 'ground', caps: ['ground'] }),
    pin('vcc', 'VCC', 10.6, 9.6, { type: 'power-3v3', caps: ['power'], voltage: 3.3 }),
    pin('hold', 'HOLD', 10.6, 6.4, { type: 'digital', caps: ['digital-in'] }),
    pin('sck', 'CLK', 10.6, 3.2, { type: 'digital', caps: ['spi-sck'] }),
    pin('mosi', 'DI', 10.6, 0.4, { type: 'digital', caps: ['spi-mosi'] }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.spi-flash',
    description:
      'Winbond-class 8 Mbit SPI NOR flash with the real instruction set: JEDEC ID 0xEF4014, status register, write enable, read / fast read, page program, sector and block erase. Programming is refused without a preceding write enable and can only clear bits until an erase restores them, and the BUSY bit stays set for the datasheet program/erase time. WP and HOLD are wired for realism but their protection behaviour is not modelled.',
  },
);

export const EEPROM_24C = def(
  'comp.eeprom-24c', 'EEPROM (24C256, I2C)', 'Memory', 10, 10, 'eeprom',
  [
    pin('a0', 'A0', 1.4, 9.6, { type: 'digital', caps: ['digital-in'] }),
    pin('a1', 'A1', 3.8, 9.6, { type: 'digital', caps: ['digital-in'] }),
    pin('a2', 'A2', 6.2, 9.6, { type: 'digital', caps: ['digital-in'] }),
    pin('gnd', 'GND', 8.6, 9.6, { type: 'ground', caps: ['ground'] }),
    pin('vcc', 'VCC', 8.6, 0.4, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('wp', 'WP', 6.2, 0.4, { type: 'digital', caps: ['digital-in'] }),
    pin('scl', 'SCL', 3.8, 0.4, { type: 'digital', caps: ['i2c-scl'] }),
    pin('sda', 'SDA', 1.4, 0.4, { type: 'digital', caps: ['i2c-sda'] }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.eeprom-24c',
    validationRules: ['i2c-pins'],
    description:
      '32 KiB serial EEPROM with a two-byte word address. The self-timed write cycle is modelled: after a write the part NACKs its own address for 5 ms, so a sketch that reads back immediately genuinely fails and ACK polling genuinely works. Page writes wrap inside their 64-byte page rather than spilling, as on real silicon. The write-protect pin is wired but its protection behaviour is not modelled.',
  },
);

export const DS3231 = def(
  'comp.ds3231', 'Real-Time Clock (DS3231)', 'Modules', 22, 14, 'rtc',
  [
    pin('gnd', 'GND', 2.0, 13.6, { type: 'ground', caps: ['ground'] }),
    pin('vcc', 'VCC', 6.0, 13.6, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('sda', 'SDA', 10.0, 13.6, { type: 'digital', caps: ['i2c-sda'] }),
    pin('scl', 'SCL', 14.0, 13.6, { type: 'digital', caps: ['i2c-scl'] }),
    pin('sqw', 'SQW', 18.0, 13.6, { caps: ['digital-out'] }),
    pin('rst', '32K', 20.0, 13.6, { caps: ['digital-out'] }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.ds3231',
    validationRules: ['i2c-pins'],
    description:
      'Temperature-compensated RTC at the fixed address 0x68. The BCD time registers really advance with simulated time, so reading the seconds register twice a second apart shows it increment, and writing them sets the clock. 12/24-hour mode, the calendar with leap years, and the temperature registers are implemented. Alarms are stored and read back but never drive INT/SQW, and the 32 kHz output is not generated. Note 0x68 collides with an MPU-6050 left on its default address.',
  },
);

export const MCP4725 = def(
  'comp.mcp4725', 'DAC (MCP4725, 12-bit)', 'ICs', 16, 12, 'dac',
  [
    pin('gnd', 'GND', 2.0, 11.6, { type: 'ground', caps: ['ground'] }),
    pin('vcc', 'VCC', 6.0, 11.6, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('sda', 'SDA', 10.0, 11.6, { type: 'digital', caps: ['i2c-sda'] }),
    pin('scl', 'SCL', 14.0, 11.6, { type: 'digital', caps: ['i2c-scl'] }),
    pin('vout', 'VOUT', 2.0, 0.4, { type: 'analog', caps: ['analog-in'] }),
    pin('a0', 'A0', 14.0, 0.4, { type: 'digital', caps: ['digital-in'] }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.mcp4725',
    validationRules: ['i2c-pins'],
    description:
      '12-bit DAC whose output is a real voltage on the canvas: wire VOUT to an analog input and firmware reads back what it wrote. Fast-mode and register writes are both decoded, the EEPROM form stores a power-on code, and the three power-down modes genuinely stop driving VOUT. Full scale follows the supply rail. EEPROM write time is not modelled — the ready bit always reads ready.',
  },
);

export const HC165 = def(
  'comp.hc165', 'Shift Register (74HC165)', 'ICs', 10, 18, 'hc165',
  [
    pin('pl', 'PL', 1.4, 17.6, { type: 'digital', caps: ['digital-in'] }),
    pin('cp', 'CP', 3.8, 17.6, { type: 'digital', caps: ['spi-sck'] }),
    pin('d4', 'D4', 6.2, 17.6, { type: 'digital', caps: ['digital-in'] }),
    pin('d5', 'D5', 8.6, 17.6, { type: 'digital', caps: ['digital-in'] }),
    pin('d6', 'D6', 8.6, 14.0, { type: 'digital', caps: ['digital-in'] }),
    pin('d7', 'D7', 8.6, 10.4, { type: 'digital', caps: ['digital-in'] }),
    pin('ds', 'DS', 8.6, 6.8, { type: 'digital', caps: ['digital-in'] }),
    pin('vcc', 'VCC', 8.6, 0.4, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('qh', 'QH', 1.4, 3.2, { type: 'digital', caps: ['spi-miso'] }),
    pin('ce', 'CE', 1.4, 6.8, { type: 'digital', caps: ['digital-in'] }),
    pin('d0', 'D0', 1.4, 10.4, { type: 'digital', caps: ['digital-in'] }),
    pin('d1', 'D1', 1.4, 14.0, { type: 'digital', caps: ['digital-in'] }),
    pin('d2', 'D2', 3.8, 14.0, { type: 'digital', caps: ['digital-in'] }),
    pin('d3', 'D3', 6.2, 14.0, { type: 'digital', caps: ['digital-in'] }),
    pin('gnd', 'GND', 1.4, 0.4, { type: 'ground', caps: ['ground'] }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.hc165',
    description:
      'Parallel-in / serial-out shift register, the mirror of the 74HC595: wire QH to MISO and CP to SCK and SPI.transfer(0) clocks eight real input levels back to the sketch, MSB (D7) first. The parallel load pin is asynchronous and active low, so the register follows D0-D7 while PL is held low and freezes when it rises; CE inhibits the clock entirely. Inputs are read from actual net voltages, so buttons wired to D0-D7 are what firmware sees.',
  },
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
  HC595, HC165, SD_CARD, SPI_FLASH, EEPROM_24C, DS3231, MCP4725,
  GENERIC_IC, HEADER_CONNECTOR,
];

export { MM };
