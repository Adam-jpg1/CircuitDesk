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
  'simulated',
  {
    simulationAdapterId: 'sim.relay',
    description:
      'A single changeover on a coil. At rest COM is joined to NC; energise the coil and it moves to NO. The ' +
      'contacts are the same model a switch uses, moved by the coil rather than by a finger, so a relay ' +
      'switching a real load behaves like a switch switching one — and a module whose ground was forgotten, ' +
      'or one fed 3.3 V by a coil that wants 5, does not click. Behavioural: coil inductance, the flyback a ' +
      'driving transistor needs, contact bounce and contact ratings are not modelled.',
  },
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
  'simulated',
  {
    simulationAdapterId: 'sim.motor',
    validationRules: ['motor-needs-driver'],
    description:
      'Brushed DC motor, rated 6 V. Direction is the sign of the voltage across its terminals and speed is the ' +
      'magnitude relative to that rating — nothing sets a speed, so a backwards H-bridge runs it backwards, an ' +
      'unwired terminal stops it, and a duty below about a fifth does not overcome its friction. Direct GPIO ' +
      'drive is still flagged as over-current. Behavioural: no inertia, no back-EMF, no torque and no load.',
  },
);

export const STEPPER = def(
  'comp.stepper', 'Stepper Motor (28BYJ-48)', 'Motors', 30, 30, 'stepper',
  [
    pin('in1', 'IN1', 0.6, 9.0), pin('in2', 'IN2', 0.6, 13.0), pin('in3', 'IN3', 0.6, 17.0), pin('in4', 'IN4', 0.6, 21.0),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.stepper',
    description:
      'A bipolar stepper driven by its four coil lines. Position is where the coils put it: the model matches ' +
      'the pattern firmware drives against the half-step, full-step and wave sequences and moves one step per ' +
      'adjacent transition. Reverse the sequence and it turns the other way; skip a phase and it does not ' +
      'move, and the skip is counted rather than credited. De-energise every coil and it holds nothing. ' +
      'Behavioural: no torque, no missed steps under load, no coil current.',
  },
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
  'simulated',
  {
    simulationAdapterId: 'sim.motor-driver',
    description:
      'A dual H-bridge. Each half drives its two outputs from its two inputs, but only while that half\'s ' +
      'enable is high — with the enable low the outputs are not driven at all and the motor coasts, which is ' +
      'why a sketch that forgets ENA gets a motor that never turns however it drives IN1 and IN2. The outputs ' +
      'swing to the motor supply, so no motor supply means no output whatever the logic side does. ' +
      'Behavioural: no bridge drop, no shoot-through, no current limit and no thermal shutdown.',
  },
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

/**
 * The bare character LCD: sixteen pins, no backpack.
 *
 * `LiquidCrystal lcd(rs, en, d4, d5, d6, d7)` is the first display most people
 * ever wire, and it is a genuinely different part from the I2C module — six
 * GPIOs instead of two bus wires, and a panel that stays blank until firmware
 * pulses E. Both are worth having for exactly that reason.
 */
function parallelLcd(
  id: string,
  name: string,
  columns: number,
  rows: number,
  widthMm: number,
  heightMm: number,
): ComponentDefinition {
  // The real 16-pin 2.54 mm header, in datasheet order.
  const header: [string, string, Partial<PinSpec>][] = [
    ['vss', 'VSS', { type: 'ground', caps: ['ground'] }],
    ['vdd', 'VDD', { type: 'power-5v', caps: ['power'], voltage: 5 }],
    ['v0', 'V0', { type: 'passive' }],
    ['rs', 'RS', { type: 'digital', caps: ['digital-in'] }],
    ['rw', 'RW', { type: 'digital', caps: ['digital-in'] }],
    ['e', 'E', { type: 'digital', caps: ['digital-in'] }],
    ['d0', 'D0', { type: 'digital', caps: ['digital-in'] }],
    ['d1', 'D1', { type: 'digital', caps: ['digital-in'] }],
    ['d2', 'D2', { type: 'digital', caps: ['digital-in'] }],
    ['d3', 'D3', { type: 'digital', caps: ['digital-in'] }],
    ['d4', 'D4', { type: 'digital', caps: ['digital-in'] }],
    ['d5', 'D5', { type: 'digital', caps: ['digital-in'] }],
    ['d6', 'D6', { type: 'digital', caps: ['digital-in'] }],
    ['d7', 'D7', { type: 'digital', caps: ['digital-in'] }],
    ['a', 'A', { type: 'power-5v', caps: ['power'], voltage: 5 }],
    ['k', 'K', { type: 'ground', caps: ['ground'] }],
  ];
  const pitch = 2.54;
  const originX = (widthMm - (header.length - 1) * pitch) / 2;
  return def(
    id, name, 'Displays', widthMm, heightMm, 'lcd-parallel',
    header.map(([pinId, label, spec], i) => pin(pinId, label, originX + i * pitch, 2.0, spec)),
    'simulated',
    {
      simulationAdapterId: 'sim.lcd-parallel',
      description:
        `Character LCD wired straight to GPIOs — the LiquidCrystal(rs, en, d4, d5, d6, d7) build. ` +
        `The HD44780 latches on the falling edge of E and reads whatever RS and the data lines hold at that ` +
        `instant, so the four-bit initialisation dance is real: skip it and the panel stays blank, exactly as ` +
        `on a breadboard. Wire all eight data lines and it runs eight-bit, one byte per pulse. ${columns}x${rows} ` +
        `characters at their real DDRAM addresses. R/W is wired but the busy-flag read path is not modelled ` +
        `(every common library delays instead of polling), and V0 contrast and the backlight pins are power ` +
        `rather than signal. Custom CGRAM glyphs are accepted but not rendered.`,
    },
  );
}

export const LCD1602_PARALLEL = parallelLcd('comp.lcd1602-parallel', 'LCD 16×2 (parallel)', 16, 2, 80, 36);
export const LCD2004_PARALLEL = parallelLcd('comp.lcd2004-parallel', 'LCD 20×4 (parallel)', 20, 4, 98, 60);

/**
 * A WS2812 part: data in, data out, power, and a pixel count.
 *
 * Ring, strip, matrix and a single pixel are the same silicon repeated — the
 * only thing that differs is how many there are and how they are laid out, so
 * they are one builder rather than four hand-written parts.
 */
function neopixel(
  id: string,
  name: string,
  pixels: number,
  widthMm: number,
  heightMm: number,
  artworkId: string,
  layout: string,
): ComponentDefinition {
  return def(
    id, name, 'LEDs', widthMm, heightMm, artworkId,
    [
      pin('gnd', 'GND', widthMm * 0.2, heightMm - 0.6, { type: 'ground', caps: ['ground'] }),
      pin('vcc', '5V', widthMm * 0.4, heightMm - 0.6, { type: 'power-5v', caps: ['power'], voltage: 5 }),
      pin('din', 'DIN', widthMm * 0.6, heightMm - 0.6, { type: 'digital', caps: ['digital-in'] }),
      pin('dout', 'DOUT', widthMm * 0.8, heightMm - 0.6, { type: 'digital', caps: ['digital-out'] }),
    ],
    'simulated',
    {
      properties: [prop('pixelCount', 'Pixels', 'number', pixels, { min: 1, max: 256 })],
      simulationAdapterId: 'sim.neopixel',
      description:
        `${layout} of WS2812B addressable LEDs. The colours are decoded from the waveform on DIN — each bit is a ` +
        `~1.25 us period whose high time is short for a zero and long for a one, twenty-four bits per pixel in ` +
        `green-red-blue order, latched by a gap of 50 us or more. Nothing watches for a library call, so a ` +
        `hand-written bit-bang loop lights it and a sketch driving the wrong pin lights nothing. Sending fewer ` +
        `bits than the strip has pixels leaves the rest holding their last colour, as the hardware does. ` +
        `Brightness is a colour rather than a current draw, the WS2811's 400 kHz mode is not modelled, and DOUT ` +
        `drives nothing — chain by raising this part's pixel count rather than by wiring two parts together.`,
    },
  );
}

export const NEOPIXEL = neopixel('comp.neopixel', 'NeoPixel (WS2812B)', 1, 10, 10, 'neopixel', 'A single');
export const NEOPIXEL_RING = neopixel('comp.neopixel-ring', 'NeoPixel Ring (16)', 16, 46, 46, 'neopixel-ring', 'A ring');
export const NEOPIXEL_STRIP = neopixel('comp.neopixel-strip', 'NeoPixel Strip (8)', 8, 84, 12, 'neopixel-strip', 'A strip');
export const NEOPIXEL_MATRIX = neopixel('comp.neopixel-matrix', 'NeoPixel Matrix (8×8)', 64, 42, 46, 'neopixel-matrix', 'An 8x8 matrix');

/**
 * An SPI display module: the bus, a chip select, and the two control lines
 * every one of these breakouts brings out.
 *
 * D/C is not optional decoration — it is what tells the controller whether the
 * byte on MOSI is a command or a pixel, so a module without it wired shows
 * nothing. RESET usually is optional (many boards tie it high), and the model
 * treats an unwired RESET as never asserted rather than as held low.
 */
function spiDisplay(
  id: string,
  name: string,
  widthMm: number,
  heightMm: number,
  artworkId: string,
  adapterId: string,
  description: string,
  extraPins: [string, string][] = [],
): ComponentDefinition {
  const header: [string, string, Partial<PinSpec>][] = [
    ['gnd', 'GND', { type: 'ground', caps: ['ground'] }],
    ['vcc', 'VCC', { type: 'power-3v3', caps: ['power'], voltage: 3.3 }],
    ['sck', 'SCK', { type: 'digital', caps: ['spi-sck'] }],
    ['mosi', 'MOSI', { type: 'digital', caps: ['spi-mosi'] }],
    ['cs', 'CS', { type: 'digital', caps: ['digital-in'] }],
    ['dc', 'DC', { type: 'digital', caps: ['digital-in'] }],
    ['rst', 'RST', { type: 'digital', caps: ['digital-in'] }],
    // Extra lines are outputs FROM the module — an e-paper's BUSY is the only
    // one so far, and it is driven by the panel rather than by the board.
    ...extraPins.map(
      ([pid, label]) => [pid, label, { type: 'digital', caps: ['digital-out'] }] as [string, string, Partial<PinSpec>],
    ),
  ];
  const pitch = 2.54;
  const originX = (widthMm - (header.length - 1) * pitch) / 2;
  return def(
    id, name, 'Displays', widthMm, heightMm, artworkId,
    header.map(([pid, label, spec], i) => pin(pid, label, originX + i * pitch, heightMm - 1.2, spec)),
    'simulated',
    { simulationAdapterId: adapterId, description },
  );
}

export const EPAPER29 = spiDisplay(
  'comp.epaper29', 'E-Paper 2.9" 128×296', 48, 76, 'epaper', 'sim.epaper',
  'A 2.9-inch monochrome e-paper on an SSD1680-family controller. The behaviour that makes it an e-paper is ' +
    'modelled and is the thing people trip over: the panel does not follow its RAM. Writing display RAM changes ' +
    'nothing visible; the image only changes when a refresh is commanded, and then it stays — through further ' +
    'RAM writes, through deep sleep, and through a reset. BUSY is a real output driven for the duration of an ' +
    'update, so a driver that waits on it blocks for a plausible time and one that does not misbehaves as it ' +
    'would on a bench. Refusing to refresh while in deep sleep is modelled too. NOT modelled and not claimed: ' +
    'ghosting, LUT waveforms, partial-refresh artefacts, refresh current, temperature compensation, and the ' +
    'red channel of three-colour panels — a refresh here is clean at the end of its BUSY period.',
  [['busy', 'BUSY']],
);

export const NOKIA5110 = spiDisplay(
  'comp.nokia5110', 'Nokia 5110 LCD (PCD8544)', 45, 45, 'nokia5110', 'sim.pcd8544',
  'The 84x48 Nokia 5110 panel. Not I2C and not quite SPI: a clock, a data line, no output at all, and a D/C ' +
    'line deciding whether the byte is a command or display RAM. The catch every driver hits is modelled — the ' +
    'function-set byte carries an H bit, and half the command set only exists while it is 1, so sending the ' +
    'contrast command without setting H first is read as something else entirely and the screen comes up blank ' +
    'or black. Contrast, bias and temperature coefficient are stored and reported rather than shown as darkness.',
);

export const ILI9341 = spiDisplay(
  'comp.ili9341', 'TFT 2.8" 240×320 (ILI9341)', 50, 68, 'tft', 'sim.tft',
  'A 240x320 colour TFT. Firmware sets a column range and a row range, issues a memory write, and streams ' +
    'RGB565 pixels; the framebuffer is filled by walking that rectangle, so a driver that gets the window wrong ' +
    'draws a skewed picture here too. MADCTL orientation and BGR order are applied. The pixel format is ' +
    'checked against what the silicon accepts rather than assumed. Gamma, VCOM and power-control registers are ' +
    'accepted and their arguments consumed with no visual effect; tearing output, partial and idle modes, ' +
    'scrolling and reads back from display RAM are not modelled.',
);

export const ST7735 = spiDisplay(
  'comp.st7735', 'TFT 1.8" 128×160 (ST7735)', 40, 56, 'tft', 'sim.tft',
  'A 128x160 colour TFT. The visible panel is a corner of the controller\'s larger memory, so the two-pixel ' +
    'column offset and one-pixel row offset are applied — a driver that omits them draws everything shifted ' +
    'with a coloured edge, exactly as on a bench. Accepts 12-, 16- and 18-bit pixel formats. Same modelled ' +
    'subset and same exclusions as the other controllers in this family.',
);

export const ST7789 = spiDisplay(
  'comp.st7789', 'TFT 240×320 (ST7789)', 44, 60, 'tft', 'sim.tft',
  'A 240x320 colour TFT with the ST7789 register set — porch, gate and VDV/VRH controls that the ILI9341 does ' +
    'not have, and which an ILI9341 will not accept. Column and row addressing, memory write, MADCTL and pixel ' +
    'format behave as the family does. Gamma and power registers are consumed without visual effect.',
);

export const GC9A01 = spiDisplay(
  'comp.gc9a01', 'Round TFT 1.28" 240×240 (GC9A01)', 46, 46, 'tft-round', 'sim.tft',
  'The round 240x240 module. Its register set is its own: the inter-register enable pair that unlocks it, and ' +
    'a block of vendor registers whose opcodes collide numerically with other controllers and mean something ' +
    'else. A sequence written for an ST7789 is recorded as unknown commands rather than half-accepted, which ' +
    'is why the wrong driver produces a blank screen here as it does on hardware.',
);

export const SSD1331 = spiDisplay(
  'comp.ssd1331', 'Colour OLED 0.95" 96×64 (SSD1331)', 34, 40, 'tft', 'sim.tft',
  'A 96x64 colour OLED, and the odd one out: its command set predates MIPI DCS, so the address window is ' +
    '0x15/0x75 rather than CASET/RASET and there is no memory-write command at all — pixel data simply ' +
    'follows. It also draws in hardware, so the line, rectangle and clear-window commands are executed rather ' +
    'than ignored, which is the difference between a filled rectangle appearing and nothing appearing. Only ' +
    'the 65k-colour mode is decoded; a remap selecting 256 colours is recorded as refused. Dim and scroll are ' +
    'accepted with no visual effect.',
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

/**
 * The 1.12" square OLED. Same footprint and the same two bus wires as the
 * SSD1306 module, a different controller behind them — which is the whole
 * reason it is worth having: swapping the part in a project is the cheapest way
 * to find out that the driver you chose was the wrong one.
 */
export const SH1107_OLED = def(
  'comp.sh1107', 'OLED 128×128 (SH1107)', 'Displays', 30, 30, 'sh1107',
  [
    pin('gnd', 'GND', 9.0, 1.0, { type: 'ground', caps: ['ground'] }),
    pin('vcc', 'VCC', 13.0, 1.0, { type: 'power-3v3', caps: ['power'], voltage: 3.3 }),
    pin('scl', 'SCL', 17.0, 1.0, { type: 'digital', caps: ['i2c-scl'] }),
    pin('sda', 'SDA', 21.0, 1.0, { type: 'digital', caps: ['i2c-sda'] }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.sh1107',
    validationRules: ['i2c-pins'],
    description:
      'Square 128×128 I²C OLED. Its command set is close enough to the SSD1306 to be confused with it and different in the places that matter: sixteen pages instead of eight, a four-bit page opcode, a seven-bit column address, and a single-opcode addressing mode where the SSD1306 takes an argument byte — so an SSD1306 driver pointed at one produces a blank panel here exactly as it does on a bench. Segment remap, COM scan direction and the start line are applied, so a driver that flips the panel flips it here too. Contrast and multiplex ratio are stored and reported rather than shown.',
  },
);

/**
 * A multiplexed seven-segment module.
 *
 * Segment lines are shared across every digit and each digit's common is
 * enabled in turn — which is why these have twelve pins rather than twenty-eight
 * and why firmware has to scan them. Nothing here sets a number: the digits
 * come from which segment lines are asserted while which common is enabled,
 * averaged over the last few milliseconds the way an eye averages them.
 */
function multiDigitSevenSegment(
  id: string,
  name: string,
  digits: number,
  widthMm: number,
): ComponentDefinition {
  const segs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'];
  const pins: PinDefinition[] = [];
  const pitch = 2.54;
  const total = segs.length + digits;
  const originX = (widthMm - (total - 1) * pitch) / 2;
  segs.forEach((seg, i) => {
    pins.push(pin(seg, seg.toUpperCase(), originX + i * pitch, 21.4, { type: 'anode', caps: ['digital-in'] }));
  });
  for (let d = 0; d < digits; d++) {
    pins.push(
      pin(`d${d + 1}`, `D${d + 1}`, originX + (segs.length + d) * pitch, 21.4, {
        type: 'cathode',
        caps: ['digital-in'],
      }),
    );
  }
  return def(
    id, name, 'Displays', widthMm, 22, 'seven-segment-multi', pins, 'simulated',
    {
      simulationAdapterId: 'sim.multiplexed',
      validationRules: ['led-needs-resistor'],
      description:
        `${digits}-digit common-cathode display. The segment lines are shared and each digit's common is ` +
        `enabled separately, so firmware must scan it — drive one common low, set the segments, move on. ` +
        `There is no value property: what is shown is derived from which segment lines are asserted while ` +
        `which common is low. Because only one digit is electrically lit at a time, the canvas shows the ` +
        `brightness an eye would average over the last few milliseconds; a digit that is never scanned stays ` +
        `dark, and a scan that stops fades out. Segment current and per-digit brightness matching are not modelled.`,
    },
  );
}

export const SEVEN_SEGMENT_2 = multiDigitSevenSegment('comp.seven-segment-2', '7-Segment Display (2 digit)', 2, 30);
export const SEVEN_SEGMENT_4 = multiDigitSevenSegment('comp.seven-segment-4', '7-Segment Display (4 digit)', 4, 40);

/** Common-anode single digit — the same glass, the opposite polarity. */
export const SEVEN_SEGMENT_CA = def(
  'comp.seven-segment-ca', '7-Segment Display (CA)', 'Displays', 14, 20, 'seven-segment',
  [
    pin('a', 'A', 2.0, 0.6, { type: 'cathode' }), pin('b', 'B', 6.0, 0.6, { type: 'cathode' }),
    pin('c', 'C', 10.0, 0.6, { type: 'cathode' }), pin('com1', 'COM', 12.5, 0.6, { type: 'anode' }),
    pin('d', 'D', 2.0, 19.4, { type: 'cathode' }), pin('e', 'E', 6.0, 19.4, { type: 'cathode' }),
    pin('f', 'F', 10.0, 19.4, { type: 'cathode' }), pin('g', 'G', 12.5, 19.4, { type: 'cathode' }),
    pin('dp', 'DP', 14 - 1.5, 10, { type: 'cathode' }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.multiplexed',
    validationRules: ['led-needs-resistor'],
    description:
      'Common-anode 7-segment digit: the common goes to the supply and a segment lights when its pin is pulled ' +
      'LOW. That is the opposite of the common-cathode part, and wiring one as the other is the most common ' +
      'reason a digit stays dark — which it does here too.',
  },
);

/**
 * A bare 8x8 matrix: sixteen pins, no driver chip.
 *
 * The MAX7219 module does the scanning for you. This one does not, which is the
 * point — it is how a matrix is taught, and the firmware has to hold the whole
 * frame and paint it row by row fast enough to look continuous.
 */
export const LED_MATRIX_8X8 = def(
  'comp.led-matrix', 'LED Matrix 8×8 (bare)', 'Displays', 32, 32, 'led-matrix',
  [
    ...Array.from({ length: 8 }, (_, i) =>
      pin(`r${i + 1}`, `R${i + 1}`, 2.5 + i * 3.8, 31.4, { type: 'cathode', caps: ['digital-in'] }),
    ),
    ...Array.from({ length: 8 }, (_, i) =>
      pin(`c${i + 1}`, `C${i + 1}`, 2.5 + i * 3.8, 0.6, { type: 'anode', caps: ['digital-in'] }),
    ),
  ],
  'simulated',
  {
    validationRules: ['led-needs-resistor'],
    simulationAdapterId: 'sim.multiplexed',
    description:
      'An 8x8 matrix with no driver behind it: eight row cathodes and eight column anodes, and an LED at every ' +
      'crossing. A pixel lights when its column is driven high and its row is pulled low, so a whole frame needs ' +
      'firmware to scan the rows fast enough that the eye joins them up — which is exactly what the canvas ' +
      'shows, averaged over the last few milliseconds. Stop scanning and it fades. Per-LED current and the ' +
      'brightness drop from lighting many LEDs in one row are not modelled.',
  },
);

/** The TM1637 four-digit module: two wires, a driver chip, no address. */
export const TM1637 = def(
  'comp.tm1637', 'TM1637 4-Digit Display', 'Displays', 42, 24, 'tm1637',
  [
    pin('gnd', 'GND', 8, 23.4, { type: 'ground', caps: ['ground'] }),
    pin('vcc', 'VCC', 14, 23.4, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('dio', 'DIO', 20, 23.4, { type: 'digital', caps: ['digital-in', 'digital-out'] }),
    pin('clk', 'CLK', 26, 23.4, { type: 'digital', caps: ['digital-in'] }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.tm1637',
    description:
      'Four digits behind a TM1637, on two wires that look like I2C and are not. There is no address — the ' +
      'chip is the only thing on those pins — and bits go out least significant first, which is the opposite ' +
      'of I2C and would scramble every glyph if decoded the other way. The model watches the two pins ' +
      'directly, so an ordinary Arduino TM1637 sketch drives it with nothing simulator-specific. The chip ' +
      'holds a whole frame, so unlike a bare multiplexed display there is no scan to average. Its keypad ' +
      'scanning half is not modelled (no common breakout wires it), nor is display-test mode, and brightness ' +
      'is stored and reported rather than shown as luminance.',
  },
);

// ---------- Motors, drivers and actuators ----------

/** A two-terminal motor. Direction and speed come from the terminals, always. */
function dcMotorPart(
  id: string,
  name: string,
  widthMm: number,
  heightMm: number,
  description: string,
  extra: [string, string, Partial<PinSpec>][] = [],
): ComponentDefinition {
  return def(
    id, name, 'Motors', widthMm, heightMm, 'dc-motor',
    [
      pin('m1', 'M+', widthMm * 0.35, heightMm - 0.6, { type: 'passive' }),
      pin('m2', 'M−', widthMm * 0.65, heightMm - 0.6, { type: 'passive' }),
      ...extra.map(([pid, label, spec], i) =>
        pin(pid, label, widthMm * (0.2 + i * 0.2), 0.6, spec),
      ),
    ],
    'simulated',
    { simulationAdapterId: 'sim.motor', description },
  );
}

export const GEARMOTOR = dcMotorPart(
  'comp.gearmotor', 'Gearmotor (TT, 1:48)', 20, 14,
  'A geared DC motor. Direction is the sign of the voltage across its terminals and speed is the magnitude ' +
    'relative to its 6 V rating, so a backwards H-bridge runs it backwards and a missing ground stops it. Below ' +
    'about a fifth of its rating it does not turn at all, which is why a low PWM duty does nothing. Behavioural: ' +
    'there is no inertia, no back-EMF, no torque and no load — those need the analog solver.',
);

export const VIBRATION_MOTOR = dcMotorPart(
  'comp.vibration-motor', 'Vibration motor', 10, 10,
  'A coin vibration motor, rated 3 V. Same model as any other brushed motor — direction and magnitude from the ' +
    'terminals — which matters here because it is usually driven straight from a transistor and a 5 V drive is ' +
    'well past its rating. Behavioural: no inertia, no back-EMF, no torque.',
);

export const DC_MOTOR_ENCODER = dcMotorPart(
  'comp.dc-motor-encoder', 'DC motor with quadrature encoder', 24, 16,
  'A gearmotor with a quadrature encoder on the shaft. Both channels are derived from the shaft position the ' +
    'motor model integrates, so a motor that is not turning produces no pulses and one running backwards ' +
    'produces them in the other order — which is what lets firmware tell direction, and what a pulse-count ' +
    'property could never do. Eleven pulses per revolution per channel. Behavioural: no inertia or load.',
  [
    ['enca', 'A', { type: 'digital', caps: ['digital-out'] }],
    ['encb', 'B', { type: 'digital', caps: ['digital-out'] }],
    ['evcc', 'V+', { type: 'power-5v', caps: ['power'], voltage: 5 }],
    ['egnd', 'GND', { type: 'ground', caps: ['ground'] }],
  ],
);

export const SOLENOID = def(
  'comp.solenoid', 'Solenoid (12V)', 'Motors', 16, 24, 'solenoid',
  [pin('p1', '+', 5, 23.4, { type: 'passive' }), pin('p2', '−', 11, 23.4, { type: 'passive' })],
  'simulated',
  {
    simulationAdapterId: 'sim.motor',
    description:
      'A pull-type solenoid, rated 12 V. It is energised when there is enough voltage across it and released ' +
      'otherwise, which is the whole of its behaviour. Behavioural: stroke, force, coil inductance and the ' +
      'flyback a switching transistor needs are not modelled — the diode is still worth wiring, and validation ' +
      'still asks for it.',
  },
);

/** A stepper whose four coils firmware drives directly. */
function coilStepper(id: string, name: string, steps: number, description: string): ComponentDefinition {
  return def(
    id, name, 'Motors', 26, 26, 'stepper',
    ['in1', 'in2', 'in3', 'in4'].map((pid, i) =>
      pin(pid, pid.toUpperCase(), 4 + i * 6, 25.4, { type: 'passive', caps: ['digital-in'] }),
    ),
    'simulated',
    { simulationAdapterId: 'sim.stepper', description },
  );
}

export const STEPPER_28BYJ = coilStepper(
  'comp.stepper-28byj', '28BYJ-48 Stepper (5V)', 4096,
  'The geared unipolar stepper every kit ships. Position is where the coils put it: the model matches the ' +
    'pattern firmware drives against the half-step, full-step and wave sequences and moves one step per ' +
    'adjacent transition. Drive the sequence backwards and it turns backwards; skip a phase and it does not ' +
    'move, and the skip is counted rather than credited as progress; energise nothing and it holds nothing. ' +
    '4096 steps per output revolution through its gearbox. Behavioural: no torque, no missed steps under load, ' +
    'no coil current.',
);

export const A4988 = def(
  'comp.a4988', 'A4988 Stepper Driver', 'Motors', 20, 20, 'dip-ic',
  [
    pin('en', 'EN', 1.2, 3, { type: 'digital', caps: ['digital-in'] }),
    pin('ms1', 'MS1', 1.2, 5.5, { type: 'digital', caps: ['digital-in'] }),
    pin('ms2', 'MS2', 1.2, 8, { type: 'digital', caps: ['digital-in'] }),
    pin('ms3', 'MS3', 1.2, 10.5, { type: 'digital', caps: ['digital-in'] }),
    pin('rst', 'RST', 1.2, 13, { type: 'digital', caps: ['digital-in'] }),
    pin('slp', 'SLP', 1.2, 15.5, { type: 'digital', caps: ['digital-in'] }),
    pin('step', 'STEP', 1.2, 18, { type: 'digital', caps: ['digital-in'] }),
    pin('dir', 'DIR', 18.8, 18, { type: 'digital', caps: ['digital-in'] }),
    pin('gnd', 'GND', 18.8, 15.5, { type: 'ground', caps: ['ground'] }),
    pin('vdd', 'VDD', 18.8, 13, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('1b', '1B', 18.8, 10.5, { type: 'passive' }),
    pin('1a', '1A', 18.8, 8, { type: 'passive' }),
    pin('2a', '2A', 18.8, 5.5, { type: 'passive' }),
    pin('2b', '2B', 18.8, 3, { type: 'passive' }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.stepper',
    description:
      'A step/direction stepper driver. It sequences the coils itself, so the model is what happens on its ' +
      'logic side: one microstep per rising edge on STEP, in the direction DIR is holding. ENABLE is active ' +
      'low and an unwired one reads as enabled, because the board pulls it down — but drive it high and the ' +
      'pulses are counted and ignored, which is the answer to "I sent ten thousand steps and nothing moved". ' +
      'MS1-MS3 select the microstep divisor, so the same pulse count travels a different distance. ' +
      'Behavioural: the current limit its potentiometer sets, torque, missed steps and thermal shutdown are ' +
      'not modelled.',
  },
);

export const ULN2003 = def(
  'comp.uln2003', 'ULN2003 Darlington Array', 'Motors', 20, 20, 'dip-ic',
  [
    ...Array.from({ length: 7 }, (_, i) =>
      pin(`in${i + 1}`, `IN${i + 1}`, 1.2, 2.5 + i * 2.4, { type: 'digital', caps: ['digital-in'] }),
    ),
    pin('gnd', 'GND', 1.2, 19.3, { type: 'ground', caps: ['ground'] }),
    ...Array.from({ length: 7 }, (_, i) =>
      pin(`out${i + 1}`, `OUT${i + 1}`, 18.8, 2.5 + i * 2.4, { type: 'passive', caps: ['digital-out'] }),
    ),
    pin('com', 'COM', 18.8, 19.3, { type: 'passive' }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.uln2003',
    description:
      'Seven Darlington sinks. A high on an input pulls the matching output to ground; a low leaves it ' +
      'floating. It cannot source — which is not a limitation to work around but the reason a 28BYJ-48 wired ' +
      'to one has its common on the supply rather than on ground, and why wiring it the other way produces a ' +
      'stepper that does nothing. The flyback diodes to COM are not modelled as clamps.',
  },
);

/** DPDT relay: one coil, two mechanically linked changeover sections. */
export const RELAY_DPDT = def(
  'comp.relay-dpdt', 'Relay (DPDT, 5V)', 'Motors', 30, 24, 'relay',
  [
    pin('vcc', 'VCC', 3, 23.4, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('gnd', 'GND', 8, 23.4, { type: 'ground', caps: ['ground'] }),
    pin('in', 'IN', 13, 23.4, { type: 'digital', caps: ['digital-in'] }),
    pin('com1', 'COM1', 3, 0.6, { type: 'passive' }),
    pin('no1', 'NO1', 9, 0.6, { type: 'passive' }),
    pin('nc1', 'NC1', 15, 0.6, { type: 'passive' }),
    pin('com2', 'COM2', 21, 0.6, { type: 'passive' }),
    pin('no2', 'NO2', 27, 0.6, { type: 'passive' }),
    pin('nc2', 'NC2', 27, 12, { type: 'passive' }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.relay',
    description:
      'Two changeover sections on one armature. At rest each COM is joined to its NC; energise the coil and ' +
      'both move together to NO — you cannot switch one pole without the other, which is the whole reason to ' +
      'use a DPDT. The contacts are the same model a switch uses, moved by the coil rather than by a finger, ' +
      'so a relay switching a real load behaves like a switch switching one. The coil needs most of its rated ' +
      'voltage to pull in, and a module whose ground was forgotten does not click. Behavioural: coil ' +
      'inductance, the flyback a driving transistor needs, contact bounce and contact ratings are not modelled.',
  },
);

// ---------- Power sources, regulators and converters ----------

/**
 * A voltage source: two terminals and a voltage it actually imposes.
 *
 * Only these and a board's own rails source anything. A module's VCC pin is an
 * input however it is labelled, and artwork sources nothing at all — which is
 * the rule that keeps "there is a 5V label here" from becoming "there is 5 V
 * here".
 */
function voltageSource(
  id: string,
  name: string,
  volts: number,
  widthMm: number,
  heightMm: number,
  artworkId: string,
  description: string,
  adjustable = false,
): ComponentDefinition {
  return def(
    id, name, 'Power', widthMm, heightMm, artworkId,
    [
      pin('plus', '+', widthMm * 0.3, heightMm - 0.6, { type: 'power-vin', caps: ['power'], voltage: volts }),
      pin('minus', '−', widthMm * 0.7, heightMm - 0.6, { type: 'ground', caps: ['ground'] }),
    ],
    'simulated',
    {
      simulationAdapterId: 'sim.supply',
      properties: [
        prop('voltage', 'Voltage', 'number', volts, {
          unit: 'V',
          min: adjustable ? 1 : volts,
          max: adjustable ? 30 : volts,
        }),
      ],
      description,
    },
  );
}

export const CELL_15 = voltageSource(
  'comp.cell-15', 'Cell (1.5V)', 1.5, 26, 10, 'battery-aa',
  'A single 1.5 V cell. It imposes its voltage across its terminals, which is what makes a series stack behave ' +
    'like a stack. Behavioural: capacity, internal resistance and discharge are not modelled — it never goes flat.',
);

export const COIN_CELL = voltageSource(
  'comp.battery-coin', 'Coin cell (CR2032)', 3, 16, 16, 'battery-coin',
  'A 3 V lithium coin cell. Behavioural: capacity, internal resistance and discharge are not modelled, which ' +
    'matters more here than for most sources — a CR2032 cannot in reality supply what a project often asks of it.',
);

export const DC_SUPPLY = voltageSource(
  'comp.dc-supply', 'Adjustable DC supply', 5, 36, 24, 'dc-supply',
  'A bench supply, set by its voltage property. It imposes exactly that across its terminals. Behavioural: ' +
    'current limiting, ripple and load regulation are not modelled.',
  true,
);

/** A three-terminal regulator or converter module. */
function regulatorPart(
  id: string,
  name: string,
  widthMm: number,
  heightMm: number,
  artworkId: string,
  description: string,
  nominal: number,
  withEnable = false,
): ComponentDefinition {
  const pins: PinDefinition[] = [
    pin('vin', 'IN', widthMm * 0.2, heightMm - 0.6, { type: 'power-vin', caps: ['power'] }),
    pin('gnd', 'GND', widthMm * 0.5, heightMm - 0.6, { type: 'ground', caps: ['ground'] }),
    pin('vout', 'OUT', widthMm * 0.8, heightMm - 0.6, { type: 'passive', caps: ['power'] }),
  ];
  if (withEnable) pins.push(pin('en', 'EN', widthMm * 0.5, 0.6, { type: 'digital', caps: ['digital-in'] }));
  return def(id, name, 'Power', widthMm, heightMm, artworkId, pins, 'simulated', {
    simulationAdapterId: 'sim.regulator',
    properties: [prop('outputVoltage', 'Output', 'number', nominal, { unit: 'V' })],
    description,
  });
}

export const REGULATOR_5 = regulatorPart(
  'comp.regulator-5', 'Linear regulator (5V, 7805)', 14, 18, 'regulator',
  'A 7805. It imposes 5 V on its output when its input is at least two volts above that and its ground is ' +
    'wired — which is why feeding one 5 V gives nothing, and why a floating ground gives nothing whatever the ' +
    'input is. Behavioural: ripple, efficiency, dropout curve, thermal shutdown, transient response and ' +
    'current limit are not modelled.',
  5,
);

export const REGULATOR_33 = regulatorPart(
  'comp.regulator-33', 'Linear regulator (3.3V)', 14, 18, 'regulator',
  'A 3.3 V linear regulator, needing about 1.5 V of headroom. Behavioural: ripple, efficiency, dropout curve, ' +
    'thermal shutdown, transient response and current limit are not modelled.',
  3.3,
);

export const LDO_33 = regulatorPart(
  'comp.ldo', 'LDO regulator (3.3V, enable)', 14, 18, 'regulator',
  'A low-dropout regulator: it holds 3.3 V from an input only a few hundred millivolts above it, which is the ' +
    'entire reason to choose one over a 7805-style part. Its enable pin is pulled up on the module, so leaving ' +
    'it unwired runs it and driving it low shuts it off. Behavioural: ripple, quiescent current, thermal ' +
    'shutdown and current limit are not modelled.',
  3.3,
  true,
);

export const BUCK_CONVERTER = regulatorPart(
  'comp.buck-converter', 'Buck converter (step-down)', 22, 16, 'converter',
  'A step-down switching module. It holds its set output from any input above it with a volt of headroom, and ' +
    'needs at least six volts in to start. Behavioural and deliberately so: switching frequency, efficiency, ' +
    'ripple, inductor behaviour and current limit are not modelled, and no efficiency figure is claimed.',
  5,
);

export const BOOST_CONVERTER = regulatorPart(
  'comp.boost-converter', 'Boost converter (step-up)', 22, 16, 'converter',
  'A step-up switching module. It holds its set output from any input BELOW that output and above about two ' +
    'volts — feed it more than its output and it does not regulate, which is the mistake this model exists to ' +
    'reproduce. Behavioural: switching frequency, efficiency, ripple and current limit are not modelled.',
  5,
);

// ---------- ADC, DAC, memory and clocks ----------

export const ADS1115 = def(
  'comp.ads1115', 'ADS1115 (16-bit I²C ADC)', 'ICs', 22, 20, 'dip-ic',
  [
    pin('vcc', 'VDD', 1.2, 3, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('gnd', 'GND', 1.2, 6, { type: 'ground', caps: ['ground'] }),
    pin('scl', 'SCL', 1.2, 9, { type: 'digital', caps: ['i2c-scl'] }),
    pin('sda', 'SDA', 1.2, 12, { type: 'digital', caps: ['i2c-sda'] }),
    pin('addr', 'ADDR', 1.2, 15, { type: 'digital', caps: ['digital-in'] }),
    pin('alrt', 'ALRT', 1.2, 18, { type: 'digital', caps: ['digital-out'] }),
    pin('a0', 'A0', 20.8, 3, { type: 'analog', caps: ['analog-in'] }),
    pin('a1', 'A1', 20.8, 7, { type: 'analog', caps: ['analog-in'] }),
    pin('a2', 'A2', 20.8, 11, { type: 'analog', caps: ['analog-in'] }),
    pin('a3', 'A3', 20.8, 15, { type: 'analog', caps: ['analog-in'] }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.ads1115',
    validationRules: ['i2c-pins'],
    properties: [prop('i2cAddress', 'I²C address', 'text', '')],
    description:
      'A 16-bit ADC over I²C. The number firmware reads is computed from the volts actually on the input pins ' +
      'through the mux and gain it selected — there is no way to set a reading. So the mistakes are the real ' +
      'ones: 5 V into the default ±2.048 V range rails rather than reading 5 V, a differential mux gives a ' +
      'signed result, an unwired input is not an input at 0 V, and the conversion register holds the last ' +
      'result until something starts a new one. Single-shot and continuous modes both work. NOT modelled: ' +
      'conversion time as a real delay (a conversion completes immediately and OS always reads ready), the ' +
      'comparator and the ALERT pin, and input impedance.',
  },
);

export const MCP3008 = def(
  'comp.mcp3008', 'MCP3008 (8-channel SPI ADC)', 'ICs', 22, 24, 'dip-ic',
  [
    ...Array.from({ length: 8 }, (_, i) =>
      pin(`ch${i}`, `CH${i}`, 1.2, 2.5 + i * 2.4, { type: 'analog', caps: ['analog-in'] }),
    ),
    pin('dgnd', 'DGND', 1.2, 22, { type: 'ground', caps: ['ground'] }),
    pin('cs', 'CS', 20.8, 2.5, { type: 'digital', caps: ['digital-in'] }),
    pin('din', 'DIN', 20.8, 5.5, { type: 'digital', caps: ['spi-mosi'] }),
    pin('dout', 'DOUT', 20.8, 8.5, { type: 'digital', caps: ['spi-miso'] }),
    pin('clk', 'CLK', 20.8, 11.5, { type: 'digital', caps: ['spi-sck'] }),
    pin('agnd', 'AGND', 20.8, 14.5, { type: 'ground', caps: ['ground'] }),
    pin('vref', 'VREF', 20.8, 17.5, { type: 'passive', caps: ['power'] }),
    pin('vcc', 'VDD', 20.8, 20.5, { type: 'power-5v', caps: ['power'], voltage: 5 }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.mcp3008',
    description:
      'Eight 10-bit channels over SPI, with no register map at all: the controller clocks in a start bit, a ' +
      'mode bit and three channel bits, and the part clocks back a null bit and ten data bits in the exact ' +
      'positions the usual three-byte transfer expects. The reference is a wire, so the same input reads ' +
      'differently on a part fed 3.3 V and one fed 5 V — which is the second most common source of confusion ' +
      'with these. An unwired channel is reported as unwired rather than as 0 V. NOT modelled: the input-range ' +
      'rules of true differential conversion, conversion time, and input impedance.',
  },
);

export const DS1307 = def(
  'comp.ds1307', 'DS1307 Real-Time Clock', 'ICs', 22, 16, 'dip-ic',
  [
    pin('vcc', 'VCC', 1.2, 3, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('gnd', 'GND', 1.2, 7, { type: 'ground', caps: ['ground'] }),
    pin('sda', 'SDA', 1.2, 11, { type: 'digital', caps: ['i2c-sda'] }),
    pin('scl', 'SCL', 20.8, 3, { type: 'digital', caps: ['i2c-scl'] }),
    pin('sqw', 'SQW', 20.8, 7, { type: 'digital', caps: ['digital-out'] }),
    pin('bat', 'BAT', 20.8, 11, { type: 'passive', caps: ['power'] }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.ds1307',
    validationRules: ['i2c-pins'],
    description:
      'The classic I²C real-time clock. Time advances from the simulation clock, never from the host, so a ' +
      'sketch that sets the time and waits sees exactly the time it waited — and a test gives the same answer ' +
      'on any machine at any hour. Every register is packed BCD, as on the part, so a sketch that forgets to ' +
      'convert reads nonsense here too. The clock-halt bit is real: a fresh DS1307 comes up with its ' +
      'oscillator stopped and does nothing until firmware clears it. The 56 bytes of user RAM work. NOT ' +
      'modelled: the square-wave output, battery backup as distinct from main supply, and oscillator trim.',
  },
);

export const FRAM_I2C = def(
  'comp.fram', 'FRAM (FM24CL64, 8KB I²C)', 'Memory', 20, 16, 'dip-ic',
  [
    pin('a0', 'A0', 1.2, 3, { type: 'digital', caps: ['digital-in'] }),
    pin('a1', 'A1', 1.2, 7, { type: 'digital', caps: ['digital-in'] }),
    pin('a2', 'A2', 1.2, 11, { type: 'digital', caps: ['digital-in'] }),
    pin('gnd', 'GND', 1.2, 15, { type: 'ground', caps: ['ground'] }),
    pin('vcc', 'VCC', 18.8, 3, { type: 'power-3v3', caps: ['power'], voltage: 3.3 }),
    pin('wp', 'WP', 18.8, 7, { type: 'digital', caps: ['digital-in'] }),
    pin('scl', 'SCL', 18.8, 11, { type: 'digital', caps: ['i2c-scl'] }),
    pin('sda', 'SDA', 18.8, 15, { type: 'digital', caps: ['i2c-sda'] }),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.fram',
    validationRules: ['i2c-pins'],
    description:
      'Ferroelectric RAM on the same pins and the same addresses as a 24C-series EEPROM, which is the trap: a ' +
      'sketch written for one runs against the other and nothing complains. The difference is the writes. An ' +
      'EEPROM writes a page at a time and is busy for milliseconds afterwards, NACKing everything until it ' +
      'finishes; this writes a byte at bus speed, has no page boundary, and is never busy. That is the whole ' +
      'reason to choose the part, so it is exactly where the two models differ. Contents survive a board ' +
      'reset and are saved with the project. NOT modelled: the write-protect pin, endurance, and the ' +
      'device-ID sequence.',
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
    pin('plus', '+', 6.0, 2.0, { type: 'power-vin', caps: ['power'], voltage: 3 }),
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
  'simulated',
  {
    simulationAdapterId: 'sim.regulator',
    properties: [prop('outputVoltage', 'Output', 'number', 5, { unit: 'V' })],
    description:
      'A three-terminal linear regulator. It imposes its set output when its input is at least two volts ' +
      'above that and its ground is wired — so feeding a 5 V part 5 V gives nothing, and a floating ground ' +
      'gives nothing whatever the input. Behavioural: ripple, efficiency, dropout curve, thermal shutdown, ' +
      'transient response and current limit are not modelled.',
  },
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

// ---------- Inputs: contacts ----------
//
// Everything below is built on the shared contact model, so what makes them
// different from each other is pin geometry and how many poles they have —
// not a separate simulation each.

export const PUSH_BUTTON_6MM = def(
  'comp.push-button-6mm', 'Push Button (6mm)', 'Inputs', 6.5, 6.5, 'push-button-6mm',
  [
    pin('1a', '1a', 0.6, 0.6), pin('1b', '1b', 0.6, 5.9),
    pin('2a', '2a', 5.9, 0.6), pin('2b', '2b', 5.9, 5.9),
  ],
  'simulated',
  {
    internalGroups: { '1a': 'side1', '1b': 'side1', '2a': 'side2', '2b': 'side2' },
    validationRules: ['button-floating-input'],
    simulationAdapterId: 'sim.push-button',
    description: 'Compact 6mm tactile switch. Legs 1a/1b are internally joined, as are 2a/2b; pressing bridges the two sides.',
  },
);

export const SLIDE_SWITCH = def(
  'comp.slide-switch', 'Slide Switch (SPDT)', 'Inputs', 11, 7, 'slide-switch',
  [pin('no', 'NO', 2.5, 6.6), pin('com', 'COM', 5.5, 6.6), pin('nc', 'NC', 8.5, 6.6)],
  'simulated',
  {
    simulationAdapterId: 'sim.slide-switch',
    description: 'SPDT slide switch. COM is bridged to NO in one position and to NC in the other — break before make, so NO and NC are never joined.',
  },
);

export const LIMIT_SWITCH = def(
  'comp.limit-switch', 'Limit Switch (SPDT)', 'Inputs', 20, 11, 'limit-switch',
  [pin('com', 'COM', 3.0, 10.6), pin('no', 'NO', 8.0, 10.6), pin('nc', 'NC', 13.0, 10.6)],
  'simulated',
  {
    simulationAdapterId: 'sim.limit-switch',
    description: 'Lever-actuated microswitch used as an end stop. COM-NC conducts at rest and COM-NO conducts while the lever is held, which is why an unpressed end stop reads as a closed circuit.',
  },
);

/** A DIP bank: N poles at 2.54mm pitch, pins a1/b1 … aN/bN. */
function makeDipSwitch(id: string, name: string, ways: number): ComponentDefinition {
  const pitch = 2.54;
  const widthMm = ways * pitch + 2.6;
  const heightMm = 9.5;
  const pins: PinDefinition[] = [];
  for (let i = 1; i <= ways; i++) {
    const x = 1.3 + (i - 0.5) * pitch;
    pins.push(pin(`a${i}`, `${i}`, x, 0.6));
    pins.push(pin(`b${i}`, `${i}'`, x, heightMm - 0.6));
  }
  return def(id, name, 'Inputs', widthMm, heightMm, 'dip-switch', pins, 'simulated', {
    simulationAdapterId: 'sim.dip-switch',
    description: `${ways}-way DIP switch. Each numbered pole is an independent contact between its top and bottom pin — set them individually while the simulation runs.`,
  });
}

export const DIP_SWITCH_4 = makeDipSwitch('comp.dip-switch-4', 'DIP Switch (4-way)', 4);
export const DIP_SWITCH_6 = makeDipSwitch('comp.dip-switch-6', 'DIP Switch (6-way)', 6);
export const DIP_SWITCH_8 = makeDipSwitch('comp.dip-switch-8', 'DIP Switch (8-way)', 8);

export const ROTARY_ENCODER = def(
  'comp.rotary-encoder', 'Rotary Encoder (KY-040)', 'Inputs', 20, 26, 'rotary-encoder',
  [
    pin('gnd', 'GND', 3.0, 25.6, { type: 'ground', caps: ['ground'] }),
    pin('vcc', '+', 7.5, 25.6, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('sw', 'SW', 12.0, 25.6),
    pin('dt', 'DT', 16.5, 25.6),
    pin('clk', 'CLK', 16.5, 0.4),
  ],
  'simulated',
  {
    properties: [prop('detents', 'Detents per turn', 'number', 20)],
    simulationAdapterId: 'sim.rotary-encoder',
    description:
      'Incremental rotary encoder. CLK and DT are two contacts to ground, offset by half a detent, so turning produces a real quadrature sequence and the direction has to be decoded from which line moved first. The shaft also pushes in as a momentary switch on SW.',
  },
);

export const JOYSTICK = def(
  'comp.joystick', 'Analog Joystick', 'Inputs', 34, 30, 'joystick',
  [
    pin('gnd', 'GND', 6.0, 29.6, { type: 'ground', caps: ['ground'] }),
    pin('vcc', '+5V', 11.0, 29.6, { type: 'power-5v', caps: ['power'], voltage: 5 }),
    pin('vrx', 'VRx', 16.0, 29.6, { type: 'analog', caps: ['analog-in'] }),
    pin('vry', 'VRy', 21.0, 29.6, { type: 'analog', caps: ['analog-in'] }),
    pin('sw', 'SW', 26.0, 29.6),
  ],
  'simulated',
  {
    simulationAdapterId: 'sim.joystick',
    description:
      'Two-axis thumb joystick: VRx and VRy are potentiometer wipers between GND and +5V, so a centred stick reads about half scale on a real ADC channel. Pressing the stick in closes SW to ground.',
  },
);

// ---------- Keyboards & Keypads ----------
//
// A membrane keypad has no electronics in it. Pressing a key shorts one row
// line to one column line and that is all it does, so that is all these model:
// the firmware does its own scanning, exactly as it must on the bench.

function makeKeypad(
  id: string,
  name: string,
  rows: number,
  cols: number,
  artworkId: string,
  description: string,
  properties: PropertyDefinition[] = [],
): ComponentDefinition {
  const pitch = 2.54;
  const keyPitch = 9.0;
  const widthMm = Math.max(cols * keyPitch + 8, (rows + cols) * pitch + 6);
  const heightMm = rows * keyPitch + 16;
  const pins: PinDefinition[] = [];
  const originX = (widthMm - (rows + cols - 1) * pitch) / 2;
  for (let r = 0; r < rows; r++) {
    pins.push(pin(`row${r + 1}`, `R${r + 1}`, originX + r * pitch, heightMm - 0.6));
  }
  for (let c = 0; c < cols; c++) {
    pins.push(pin(`col${c + 1}`, `C${c + 1}`, originX + (rows + c) * pitch, heightMm - 0.6));
  }
  return def(id, name, 'Keyboards & Keypads', widthMm, heightMm, artworkId, pins, 'simulated', {
    properties,
    simulationAdapterId: 'sim.keypad',
    description,
  });
}

export const KEYPAD_3X4 = makeKeypad(
  'comp.keypad-3x4', 'Membrane Keypad 3×4', 4, 3, 'keypad',
  'Standard 12-key membrane keypad, four rows by three columns. Each key is a plain contact between its row and column line — there is no controller and no character output, so firmware scans it exactly as it would real hardware. Several keys can be held at once.',
);

export const KEYPAD_4X4 = makeKeypad(
  'comp.keypad-4x4', 'Membrane Keypad 4×4', 4, 4, 'keypad',
  'Standard 16-key membrane keypad, four rows by four columns. Each key shorts one row to one column; with no diodes fitted, holding three keys in an L can produce a phantom fourth exactly as it does on the bench.',
);

export const KEYPAD_MATRIX = makeKeypad(
  'comp.keypad-matrix', 'Matrix Keypad (configurable)', 4, 4, 'keypad',
  'Matrix keypad with a configurable number of rows and columns, for layouts that are not 3×4 or 4×4. Electrically identical to the fixed keypads: one contact per crossing, scanned by firmware.',
  [
    prop('rows', 'Rows', 'number', 4),
    prop('cols', 'Columns', 'number', 4),
  ],
);

export const MINI_KEYBOARD = def(
  'comp.mini-keyboard', 'Mini Matrix Keyboard (50-key)', 'Keyboards & Keypads', 118, 54, 'mini-keyboard',
  (() => {
    const pins: PinDefinition[] = [];
    const pitch = 2.54;
    const originX = (118 - 14 * pitch) / 2;
    for (let r = 0; r < 5; r++) pins.push(pin(`row${r + 1}`, `R${r + 1}`, originX + r * pitch, 53.4));
    for (let c = 0; c < 10; c++) pins.push(pin(`col${c + 1}`, `C${c + 1}`, originX + (5 + c) * pitch, 53.4));
    return pins;
  })(),
  'simulated',
  {
    simulationAdapterId: 'sim.keypad',
    description:
      'A 50-key keyboard wired as a plain 5×10 matrix with five row pins and ten column pins. No controller, no USB and no protocol: pressing a key shorts one row to one column, and the sketch decides what that means. Enough keys for a terminal, a calculator or a small computer, and it works with any board that has fifteen spare GPIOs.',
  },
);

import { ALL_LOGIC_DEFS } from './logicDefinitions';
import { ALL_SENSOR_DEFS, DISPLAY_DEFS, EXPANDER_DEFS } from './sensorDefinitions';

export const COMPONENT_DEFINITIONS: ComponentDefinition[] = [
  BREADBOARD_HALF, BREADBOARD_MINI,
  LED, RGB_LED, RESISTOR, CAPACITOR, DIODE, TRANSISTOR_NPN, MOSFET,
  PUSH_BUTTON, TOGGLE_SWITCH, POTENTIOMETER,
  BUZZER, SPEAKER, RELAY,
  SERVO, DC_MOTOR, STEPPER, MOTOR_DRIVER,
  GEARMOTOR, VIBRATION_MOTOR, DC_MOTOR_ENCODER, SOLENOID, STEPPER_28BYJ, A4988, ULN2003, RELAY_DPDT,
  LCD1602, LCD1602_PARALLEL, LCD2004_PARALLEL, OLED, SH1107_OLED, SEVEN_SEGMENT,
  SEVEN_SEGMENT_CA, SEVEN_SEGMENT_2, SEVEN_SEGMENT_4, LED_MATRIX_8X8, TM1637,
  NOKIA5110, ILI9341, ST7735, ST7789, GC9A01, SSD1331, EPAPER29,
  NEOPIXEL, NEOPIXEL_RING, NEOPIXEL_STRIP, NEOPIXEL_MATRIX,
  ULTRASONIC, TMP36, LDR, BMP280, PULSE_SENSOR, MPU6050,
  GPS, BLUETOOTH, WIFI_ESP01,
  BATTERY_9V, BATTERY_AA, REGULATOR, LEVEL_CONVERTER,
  CELL_15, COIN_CELL, DC_SUPPLY, REGULATOR_5, REGULATOR_33, LDO_33, BUCK_CONVERTER, BOOST_CONVERTER,
  HC595, HC165, SD_CARD, SPI_FLASH, EEPROM_24C, DS3231, MCP4725,
  ADS1115, MCP3008, DS1307, FRAM_I2C,
  GENERIC_IC, HEADER_CONNECTOR,
  PUSH_BUTTON_6MM, SLIDE_SWITCH, LIMIT_SWITCH,
  DIP_SWITCH_4, DIP_SWITCH_6, DIP_SWITCH_8,
  ROTARY_ENCODER, JOYSTICK,
  KEYPAD_3X4, KEYPAD_4X4, KEYPAD_MATRIX, MINI_KEYBOARD,
  ...ALL_LOGIC_DEFS,
  ...ALL_SENSOR_DEFS,
  ...DISPLAY_DEFS,
  ...EXPANDER_DEFS,
];

export { MM };
