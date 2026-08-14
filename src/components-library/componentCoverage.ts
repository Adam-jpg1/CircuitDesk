// What CircuitDesk's part library is, and what it is aiming at.
//
// This is an internal engineering tracker, not product copy and not a
// marketing claim. It exists so "add more parts" can be planned against a
// real target instead of a feeling, and so a part can never quietly drift
// from "we drew it" to "we simulate it".
//
// PROVENANCE OF THE PARITY FLAGS
//
//   wokwi      Grounded in Wokwi's public parts index and supported-hardware
//              page. Where a part is known to exist only as a user-authored
//              custom chip rather than a first-class element, it is marked
//              false and called out in `note`.
//   tinkercad  A best-effort engineering assessment. Tinkercad does not
//              publish a machine-readable catalogue, so these flags come from
//              its documented component palette rather than from a fetched
//              list. Treat them as approximate; they steer priority, they do
//              not settle arguments.
//
// No artwork, code, netlist or asset is taken from either product. The only
// thing recorded here is whether a part of that general kind exists, which is
// a fact about the market rather than anyone's intellectual property.

/** The shelf a part sits on in the library panel. */
export type PartCategory =
  | 'Boards'
  | 'Basic'
  | 'Inputs'
  | 'Keyboards & Keypads'
  | 'Sensors'
  | 'Displays'
  | 'LEDs'
  | 'Motors & Actuators'
  | 'Communication'
  | 'Logic'
  | 'ICs'
  | 'Memory & Storage'
  | 'Power'
  | 'Instruments'
  | 'Prototyping'
  | 'CircuitDesk Extras';

/**
 * The simulation primitive a part is built on.
 *
 * The point of naming these is that a part sharing a `modelType` with an
 * implemented part should be cheap: if the I2C register-device family already
 * exists, the next I2C sensor is a register map and a datasheet, not an
 * engine. A part whose modelType has no implementation yet is the expensive
 * kind, and the matrix makes that visible before anyone promises a date.
 */
export type ModelType =
  | 'structural' // breadboards, headers: connectivity only, no behaviour
  | 'passive' // resistor, capacitor: conduction/behavioural analog
  | 'contact' // mechanical contacts: buttons, switches, relays
  | 'matrix' // row/column contact arrays: keypads, keyboards
  | 'analog-source' // sensors and supplies that impose a voltage
  | 'gpio-device' // talks over plain digital pins, no standard bus
  | 'i2c-register' // I2C device with a documented register map
  | 'spi-register' // SPI device with a documented command set
  | 'uart-device' // AT-command or NMEA style serial peripheral
  | 'onewire-device' // 1-Wire timing protocol
  | 'logic-ic' // combinational or sequential 74xx/CD4xxx part
  | 'display-controller' // framebuffer or DDRAM behind a bus
  | 'addressable-led' // WS2812-family timed serial pixel stream
  | 'actuator' // motors, servos, steppers, solenoids
  | 'memory' // nonvolatile storage
  | 'power' // sources, regulators, converters
  | 'instrument'; // probes and lab instruments

/** Where a part actually is, which is never the same as whether it is drawn. */
export type CoverageStatus =
  /** Electrical behaviour, interaction, protocol and renderer all real, with tests. */
  | 'simulated'
  /** Real but deliberately simplified physics, documented in `note`. */
  | 'behavioral'
  /** Pins and connectivity are real; the part does nothing on its own. */
  | 'wiring'
  /** Drawn only. Must never carry a Simulated badge. */
  | 'artwork'
  /** Not in the library at all yet. */
  | 'missing';

export type Protocol = 'gpio' | 'analog' | 'i2c' | 'spi' | 'uart' | 'onewire' | 'pwm' | 'ir' | 'rf' | 'can';

export interface CoverageEntry {
  /** `comp.*` id. Present even when missing, so the id is decided once. */
  id: string;
  name: string;
  category: PartCategory;
  sourceParity: {
    wokwi: boolean;
    tinkercad: boolean;
    /** True when this part exists in neither and is ours to lead on. */
    circuitdeskExtra: boolean;
  };
  modelType: ModelType;
  status: CoverageStatus;
  protocols: Protocol[];
  /** Simulation infrastructure this part needs before it can be honest. */
  dependencies: string[];
  artworkStatus: 'hardware' | 'basic' | 'none';
  /** Test files that actually exercise it. Empty means untested. */
  tests: string[];
  /** Exactly what is and is not modelled. Required for anything not 'simulated'. */
  note?: string;
}

type Parity = 'wt' | 'w' | 't' | '-';

function entry(
  id: string,
  name: string,
  category: PartCategory,
  parity: Parity,
  modelType: ModelType,
  status: CoverageStatus,
  protocols: Protocol[],
  dependencies: string[],
  artworkStatus: CoverageEntry['artworkStatus'],
  tests: string[],
  note?: string,
): CoverageEntry {
  return {
    id,
    name,
    category,
    sourceParity: {
      wokwi: parity === 'wt' || parity === 'w',
      tinkercad: parity === 'wt' || parity === 't',
      circuitdeskExtra: parity === '-',
    },
    modelType,
    status,
    protocols,
    dependencies,
    artworkStatus,
    tests,
    note,
  };
}

/** Empty list, usable wherever protocols, dependencies or tests are absent. */
const NONE: never[] = [];

// ---------------------------------------------------------------- Prototyping
const PROTOTYPING: CoverageEntry[] = [
  entry('comp.breadboard-half', 'Breadboard (half, 400pt)', 'Prototyping', 'wt', 'structural', 'simulated', NONE, NONE, 'hardware', ['tests/qa.beta.mts']),
  entry('comp.breadboard-mini', 'Breadboard (mini, 170pt)', 'Prototyping', 'wt', 'structural', 'simulated', NONE, NONE, 'hardware', ['tests/qa.beta.mts']),
  entry('comp.header-4', 'Header (4-pin)', 'Prototyping', 'wt', 'structural', 'wiring', NONE, NONE, 'basic', NONE, 'Connector only — it has no behaviour to simulate.'),
  entry('comp.breadboard-psu', 'Breadboard power module', 'Prototyping', '-', 'power', 'missing', NONE, NONE, 'none', NONE, 'Planned: 3.3V/5V rail selection feeding breadboard rails.'),
];

// --------------------------------------------------------------------- Basic
const BASIC: CoverageEntry[] = [
  entry('comp.resistor', 'Resistor', 'Basic', 'wt', 'passive', 'simulated', NONE, NONE, 'hardware', ['tests/sim.behaviors.mts']),
  entry('comp.capacitor', 'Capacitor', 'Basic', 'wt', 'passive', 'wiring', NONE, ['analog-solver'], 'hardware', NONE, 'Drawn and wired. Charge/discharge needs the analog solver; no transient is modelled.'),
  entry('comp.capacitor-electrolytic', 'Electrolytic capacitor', 'Basic', 'wt', 'passive', 'missing', NONE, ['analog-solver'], 'none', NONE, 'Polarity warning is useful even before transients are modelled.'),
  entry('comp.capacitor-ceramic', 'Ceramic capacitor', 'Basic', 'wt', 'passive', 'missing', NONE, ['analog-solver'], 'none', NONE),
  entry('comp.inductor', 'Inductor', 'Basic', 'wt', 'passive', 'missing', NONE, ['analog-solver'], 'none', NONE),
  entry('comp.diode', 'Diode (1N4148)', 'Basic', 'wt', 'passive', 'behavioral', NONE, NONE, 'hardware', ['tests/sim.behaviors.mts'], 'Conducts one way with a fixed series resistance. No I/V curve, no reverse recovery.'),
  entry('comp.diode-schottky', 'Schottky diode', 'Basic', 'wt', 'passive', 'missing', NONE, NONE, 'none', NONE),
  entry('comp.diode-zener', 'Zener diode', 'Basic', 'wt', 'passive', 'missing', NONE, ['analog-solver'], 'none', NONE, 'Reverse breakdown clamping needs the analog solver to be meaningful.'),
  entry('comp.fuse', 'Fuse', 'Basic', 't', 'passive', 'missing', NONE, ['current-sensing'], 'none', NONE, 'Needs modelled branch current before blowing means anything.'),
  entry('comp.polyfuse', 'Resettable fuse (PPTC)', 'Basic', 't', 'passive', 'missing', NONE, ['current-sensing'], 'none', NONE),
  entry('comp.crystal', 'Crystal', 'Basic', 't', 'passive', 'missing', NONE, NONE, 'none', NONE),
  entry('comp.clock-generator', 'Clock generator', 'Basic', 'w', 'gpio-device', 'missing', ['gpio'], NONE, 'none', NONE, 'Square wave source at a configurable frequency, driven off the world clock.'),
];

// -------------------------------------------------------------------- Inputs
const INPUTS: CoverageEntry[] = [
  entry('comp.push-button', 'Pushbutton (12mm)', 'Inputs', 'wt', 'contact', 'simulated', ['gpio'], ['contacts'], 'hardware', ['tests/sim.behaviors.mts', 'tests/inputs.contacts.mts']),
  entry('comp.push-button-6mm', 'Pushbutton (6mm)', 'Inputs', 'w', 'contact', 'simulated', ['gpio'], ['contacts'], 'hardware', ['tests/inputs.contacts.mts']),
  entry('comp.toggle-switch', 'Toggle switch (SPDT)', 'Inputs', 'wt', 'contact', 'simulated', ['gpio'], ['contacts'], 'hardware', ['tests/sim.behaviors.mts']),
  entry('comp.slide-switch', 'Slide switch (SPDT)', 'Inputs', 'wt', 'contact', 'simulated', ['gpio'], ['contacts'], 'hardware', ['tests/inputs.contacts.mts']),
  entry('comp.dip-switch-4', 'DIP switch (4-way)', 'Inputs', 't', 'contact', 'simulated', ['gpio'], ['contacts'], 'hardware', ['tests/inputs.contacts.mts']),
  entry('comp.dip-switch-6', 'DIP switch (6-way)', 'Inputs', 't', 'contact', 'simulated', ['gpio'], ['contacts'], 'hardware', ['tests/inputs.contacts.mts']),
  entry('comp.dip-switch-8', 'DIP switch (8-way)', 'Inputs', 'wt', 'contact', 'simulated', ['gpio'], ['contacts'], 'hardware', ['tests/inputs.contacts.mts']),
  entry('comp.limit-switch', 'Limit switch (SPDT)', 'Inputs', 't', 'contact', 'simulated', ['gpio'], ['contacts'], 'hardware', ['tests/inputs.contacts.mts']),
  entry('comp.tilt-switch', 'Tilt switch', 'Sensors', 't', 'gpio-device', 'simulated', ['gpio'], NONE, 'hardware', ['tests/sensors.batch3.mts']),
  entry('comp.potentiometer', 'Potentiometer', 'Inputs', 'wt', 'passive', 'simulated', ['analog'], NONE, 'hardware', ['tests/sim.behaviors.mts']),
  entry('comp.slide-potentiometer', 'Slide potentiometer', 'Inputs', 'w', 'passive', 'missing', ['analog'], NONE, 'none', NONE),
  entry('comp.rotary-encoder', 'Rotary encoder (KY-040)', 'Inputs', 'w', 'contact', 'simulated', ['gpio'], ['contacts'], 'hardware', ['tests/inputs.encoder.mts']),
  entry('comp.joystick', 'Analog joystick', 'Inputs', 'w', 'analog-source', 'simulated', ['analog', 'gpio'], ['contacts'], 'hardware', ['tests/inputs.joystick.mts']),
  entry('comp.rotary-switch', 'Rotary switch', 'Inputs', '-', 'contact', 'missing', ['gpio'], ['contacts'], 'none', NONE),
  entry('comp.touch-button', 'Capacitive touch button (TTP223)', 'Inputs', '-', 'gpio-device', 'missing', ['gpio'], NONE, 'none', NONE),
];

// ------------------------------------------------------- Keyboards & Keypads
const KEYPADS: CoverageEntry[] = [
  entry('comp.keypad-3x4', 'Membrane keypad 3×4', 'Keyboards & Keypads', 'wt', 'matrix', 'simulated', ['gpio'], ['contacts', 'matrix-input'], 'hardware', ['tests/inputs.keypad.mts']),
  entry('comp.keypad-4x4', 'Membrane keypad 4×4', 'Keyboards & Keypads', 'wt', 'matrix', 'simulated', ['gpio'], ['contacts', 'matrix-input'], 'hardware', ['tests/inputs.keypad.mts']),
  entry('comp.keypad-matrix', 'Configurable matrix keypad', 'Keyboards & Keypads', '-', 'matrix', 'simulated', ['gpio'], ['contacts', 'matrix-input'], 'hardware', ['tests/inputs.keypad.mts']),
  entry('comp.mini-keyboard', 'Mini matrix keyboard', 'Keyboards & Keypads', '-', 'matrix', 'simulated', ['gpio'], ['contacts', 'matrix-input'], 'hardware', ['tests/inputs.keyboard.mts']),
  entry('comp.keyboard-i2c', 'I2C keyboard module', 'Keyboards & Keypads', '-', 'i2c-register', 'missing', ['i2c'], ['i2c-register-device'], 'none', NONE),
  entry('comp.keyboard-ps2', 'PS/2 keyboard', 'Keyboards & Keypads', '-', 'gpio-device', 'missing', ['gpio'], ['ps2-protocol'], 'none', NONE, 'Needs a real bidirectional clocked PS/2 model; not a character injector.'),
  entry('comp.keyboard-usb-hid', 'USB HID keyboard', 'Keyboards & Keypads', '-', 'uart-device', 'missing', NONE, ['usb-host-stack'], 'none', NONE, 'Blocked: requires genuine USB host/device modelling. Will not be faked.'),
];

// ------------------------------------------------------------------- Sensors
const SENSORS: CoverageEntry[] = [
  entry('comp.dht11', 'DHT11 temperature/humidity', 'Sensors', 'wt', 'onewire-device', 'missing', ['onewire'], ['dht-timing'], 'none', NONE),
  entry('comp.dht22', 'DHT22 temperature/humidity', 'Sensors', 'w', 'onewire-device', 'missing', ['onewire'], ['dht-timing'], 'none', NONE),
  entry('comp.ds18b20', 'DS18B20 temperature', 'Sensors', 'wt', 'onewire-device', 'missing', ['onewire'], ['onewire-bus'], 'none', NONE),
  entry('comp.bmp180', 'BMP180 pressure', 'Sensors', 'w', 'i2c-register', 'missing', ['i2c'], ['i2c-register-device'], 'none', NONE),
  entry('comp.bmp280', 'BMP280 pressure/temperature', 'Sensors', 'w', 'i2c-register', 'simulated', ['i2c'], ['i2c-register-device'], 'hardware', ['tests/components.i2c.mts']),
  entry('comp.bme280', 'BME280 environmental', 'Sensors', 'w', 'i2c-register', 'simulated', ['i2c'], ['i2c-register-device'], 'hardware', ['tests/sensors.batch3.mts']),
  entry('comp.sht31', 'SHT31 temperature/humidity', 'Sensors', '-', 'i2c-register', 'simulated', ['i2c'], ['i2c-register-device'], 'hardware', ['tests/sensors.batch3.mts']),
  entry('comp.tmp36', 'TMP36 temperature', 'Sensors', 't', 'analog-source', 'simulated', ['analog'], NONE, 'hardware', ['tests/sim.behaviors.mts']),
  entry('comp.lm35', 'LM35 temperature', 'Sensors', 't', 'analog-source', 'simulated', ['analog'], NONE, 'hardware', ['tests/sensors.batch3.mts']),
  entry('comp.ntc-thermistor', 'NTC thermistor', 'Sensors', 'wt', 'analog-source', 'simulated', ['analog'], NONE, 'hardware', ['tests/sensors.batch3.mts']),
  entry('comp.max6675', 'MAX6675 thermocouple', 'Sensors', '-', 'spi-register', 'missing', ['spi'], ['spi-register-device'], 'none', NONE),
  entry('comp.mpu6050', 'MPU6050 accelerometer/gyro', 'Sensors', 'w', 'i2c-register', 'simulated', ['i2c'], ['i2c-register-device'], 'hardware', ['tests/components.i2c.mts']),
  entry('comp.pir', 'PIR motion sensor', 'Sensors', 'wt', 'gpio-device', 'simulated', ['gpio'], NONE, 'hardware', ['tests/sensors.batch3.mts']),
  entry('comp.vibration-sensor', 'Vibration sensor (SW-420)', 'Sensors', '-', 'gpio-device', 'simulated', ['gpio'], NONE, 'hardware', ['tests/sensors.batch3.mts']),
  entry('comp.hall-sensor', 'Hall-effect sensor', 'Sensors', 't', 'gpio-device', 'simulated', ['gpio'], NONE, 'hardware', ['tests/sensors.batch3.mts']),
  entry('comp.ldr', 'Photoresistor (LDR)', 'Sensors', 'wt', 'analog-source', 'simulated', ['analog'], NONE, 'hardware', ['tests/sim.behaviors.mts']),
  entry('comp.photodiode', 'Photodiode', 'Sensors', 't', 'analog-source', 'behavioral', ['analog'], NONE, 'hardware', ['tests/sensors.batch3.mts'], 'Photocurrent taken as linear in illuminance through a fixed transimpedance. Junction physics needs the analog solver.'),
  entry('comp.phototransistor', 'Phototransistor', 'Sensors', 't', 'analog-source', 'missing', ['analog'], NONE, 'none', NONE),
  entry('comp.veml7700', 'VEML7700 ambient light', 'Sensors', '-', 'i2c-register', 'missing', ['i2c'], ['i2c-register-device'], 'none', NONE),
  entry('comp.tcs34725', 'TCS34725 colour sensor', 'Sensors', '-', 'i2c-register', 'missing', ['i2c'], ['i2c-register-device'], 'none', NONE),
  entry('comp.ultrasonic', 'HC-SR04 ultrasonic', 'Sensors', 'wt', 'gpio-device', 'simulated', ['gpio'], NONE, 'hardware', ['tests/sim.behaviors.mts']),
  entry('comp.vl53l0x', 'VL53L0X time-of-flight', 'Sensors', '-', 'i2c-register', 'missing', ['i2c'], ['i2c-register-device'], 'none', NONE),
  entry('comp.flex-sensor', 'Flex sensor', 'Sensors', 't', 'analog-source', 'simulated', ['analog'], NONE, 'hardware', ['tests/sensors.batch3.mts']),
  entry('comp.fsr', 'Force-sensitive resistor', 'Sensors', 't', 'analog-source', 'simulated', ['analog'], NONE, 'hardware', ['tests/sensors.batch3.mts']),
  entry('comp.hx711', 'HX711 + load cell', 'Sensors', 'w', 'gpio-device', 'missing', ['gpio'], NONE, 'none', NONE),
  entry('comp.pulse-sensor', 'Pulse sensor', 'Sensors', '-', 'analog-source', 'wiring', ['analog'], NONE, 'hardware', NONE, 'Drawn and wired; no waveform is generated yet.'),
  entry('comp.mq2', 'MQ-2 gas sensor', 'Sensors', 'wt', 'analog-source', 'behavioral', ['analog'], NONE, 'hardware', ['tests/sensors.batch3.mts'], 'Logarithmic response curve only. No heater warm-up, no gas selectivity, no per-gas calibration.'),
  entry('comp.soil-moisture', 'Soil moisture sensor', 'Sensors', 't', 'analog-source', 'simulated', ['analog'], NONE, 'hardware', ['tests/sensors.batch3.mts']),
  entry('comp.rain-sensor', 'Rain sensor', 'Sensors', '-', 'analog-source', 'behavioral', ['analog'], NONE, 'hardware', ['tests/sensors.batch3.mts'], 'Surface resistance falls when wet. Behavioural only — no droplet detection or hysteresis.'),
  entry('comp.fingerprint', 'Fingerprint sensor (R307)', 'Sensors', '-', 'uart-device', 'missing', ['uart'], ['uart-endpoint'], 'none', NONE),
];

// ------------------------------------------------------------------ Displays
const DISPLAYS: CoverageEntry[] = [
  entry('comp.lcd1602', 'LCD 1602 (I2C)', 'Displays', 'wt', 'display-controller', 'simulated', ['i2c'], ['i2c-register-device'], 'hardware', ['tests/artwork.displays.mts', 'tests/components.i2c.mts']),
  entry('comp.lcd1602-parallel', 'LCD 1602 (parallel)', 'Displays', 'wt', 'display-controller', 'simulated', ['gpio'], NONE, 'hardware', ['tests/displays.parallel.mts']),
  entry('comp.lcd2004-parallel', 'LCD 2004 (parallel)', 'Displays', 'wt', 'display-controller', 'simulated', ['gpio'], NONE, 'hardware', ['tests/displays.parallel.mts']),
  entry('comp.lcd2004', 'LCD 2004 (I2C)', 'Displays', 'wt', 'display-controller', 'simulated', ['i2c'], ['i2c-register-device'], 'hardware', ['tests/displays.batch4.mts']),
  entry('comp.oled', 'OLED 128×64 (SSD1306)', 'Displays', 'wt', 'display-controller', 'simulated', ['i2c'], ['i2c-register-device'], 'hardware', ['tests/artwork.displays.mts', 'tests/components.i2c.mts']),
  entry('comp.sh1107', 'OLED 128×128 (SH1107)', 'Displays', 'w', 'display-controller', 'simulated', ['i2c'], NONE, 'hardware', ['tests/displays.mono.mts']),
  entry('comp.nokia5110', 'Nokia 5110 (PCD8544)', 'Displays', 'w', 'display-controller', 'simulated', ['spi'], NONE, 'hardware', ['tests/displays.spi.mts']),
  entry('comp.ili9341', 'ILI9341 2.8" TFT', 'Displays', 'w', 'display-controller', 'simulated', ['spi'], NONE, 'hardware', ['tests/displays.tft.mts']),
  entry('comp.ili9341-touch', 'ILI9341 TFT with touch', 'Displays', 'w', 'display-controller', 'missing', ['spi'], ['spi-register-device'], 'none', NONE),
  entry('comp.st7735', 'ST7735 TFT', 'Displays', '-', 'display-controller', 'simulated', ['spi'], NONE, 'hardware', ['tests/displays.tft.mts']),
  entry('comp.st7789', 'ST7789 TFT', 'Displays', '-', 'display-controller', 'simulated', ['spi'], NONE, 'hardware', ['tests/displays.tft.mts']),
  entry('comp.gc9a01', 'GC9A01 round TFT', 'Displays', '-', 'display-controller', 'simulated', ['spi'], NONE, 'hardware', ['tests/displays.tft.mts']),
  entry('comp.ssd1331', 'SSD1331 colour OLED', 'Displays', '-', 'display-controller', 'simulated', ['spi'], NONE, 'hardware', ['tests/displays.tft.mts']),
  entry('comp.epaper29', '2.9" e-paper', 'Displays', 'w', 'display-controller', 'simulated', ['spi'], NONE, 'hardware', ['tests/displays.epaper.mts']),
  entry('comp.seven-segment', 'Seven-segment (1 digit)', 'Displays', 'wt', 'gpio-device', 'simulated', ['gpio'], NONE, 'hardware', ['tests/sim.behaviors.mts']),
  entry('comp.seven-segment-ca', 'Seven-segment (1 digit, common anode)', 'Displays', 'wt', 'gpio-device', 'simulated', ['gpio'], NONE, 'hardware', ['tests/displays.multiplexed.mts']),
  entry('comp.seven-segment-2', 'Seven-segment (2 digit)', 'Displays', 't', 'gpio-device', 'simulated', ['gpio'], NONE, 'hardware', ['tests/displays.multiplexed.mts']),
  entry('comp.seven-segment-4', 'Seven-segment (4 digit)', 'Displays', 'wt', 'gpio-device', 'simulated', ['gpio'], NONE, 'hardware', ['tests/displays.multiplexed.mts']),
  entry('comp.tm1637', 'TM1637 4-digit display', 'Displays', 'w', 'gpio-device', 'simulated', ['gpio'], NONE, 'hardware', ['tests/displays.tm1637.mts']),
  entry('comp.max7219', 'MAX7219 8x8 matrix (chainable)', 'Displays', 'w', 'spi-register', 'simulated', ['spi'], ['spi-register-device', 'device-chaining'], 'hardware', ['tests/displays.batch4.mts']),
  entry('comp.led-matrix', 'LED matrix 8×8', 'Displays', 'w', 'gpio-device', 'simulated', ['gpio'], NONE, 'hardware', ['tests/displays.multiplexed.mts']),
];

// ---------------------------------------------------------------------- LEDs
const LEDS: CoverageEntry[] = [
  entry('comp.led', 'LED', 'LEDs', 'wt', 'passive', 'simulated', ['gpio', 'analog'], NONE, 'hardware', ['tests/sim.behaviors.mts']),
  entry('comp.rgb-led', 'RGB LED', 'LEDs', 'wt', 'passive', 'simulated', ['gpio', 'pwm'], NONE, 'hardware', ['tests/sim.behaviors.mts']),
  entry('comp.led-bar-graph', 'LED bar graph', 'LEDs', 'wt', 'passive', 'missing', ['gpio'], NONE, 'none', NONE),
  entry('comp.neopixel', 'NeoPixel (WS2812)', 'LEDs', 'w', 'addressable-led', 'simulated', ['gpio'], NONE, 'hardware', ['tests/leds.addressable.mts']),
  entry('comp.neopixel-ring', 'NeoPixel ring', 'LEDs', 'w', 'addressable-led', 'simulated', ['gpio'], NONE, 'hardware', ['tests/leds.addressable.mts']),
  entry('comp.neopixel-strip', 'NeoPixel strip', 'LEDs', 'w', 'addressable-led', 'simulated', ['gpio'], NONE, 'hardware', ['tests/leds.addressable.mts']),
  entry('comp.neopixel-matrix', 'NeoPixel matrix', 'LEDs', 'w', 'addressable-led', 'simulated', ['gpio'], NONE, 'hardware', ['tests/leds.addressable.mts']),
];

// --------------------------------------------------------------------- Logic
const LOGIC: CoverageEntry[] = [
  entry('comp.gate-not', 'NOT gate', 'Logic', 't', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.gate-and', 'AND gate', 'Logic', 't', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.gate-or', 'OR gate', 'Logic', 't', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.gate-xor', 'XOR gate', 'Logic', 't', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.gate-nand', 'NAND gate', 'Logic', 't', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.gate-nor', 'NOR gate', 'Logic', 't', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.gate-xnor', 'XNOR gate', 'Logic', 't', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.buffer-tristate', 'Tri-state buffer', 'Logic', 't', 'logic-ic', 'simulated', ['gpio'], ['logic-ic', 'high-z'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.schmitt-trigger', 'Schmitt trigger', 'Logic', 't', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.74hc00', '74HC00 quad NAND', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.74hc02', '74HC02 quad NOR', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.74hc04', '74HC04 hex inverter', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.74hc08', '74HC08 quad AND', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.74hc14', '74HC14 Schmitt inverter', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.74hc32', '74HC32 quad OR', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.74hc86', '74HC86 quad XOR', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.74hc125', '74HC125 quad tri-state buffer', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic', 'high-z'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.74hc126', '74HC126 quad tri-state buffer', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic', 'high-z'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.74hc244', '74HC244 octal buffer', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic', 'high-z'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.74hc245', '74HC245 octal transceiver', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic', 'high-z'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.74hc74', '74HC74 dual D flip-flop', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic', 'edge-clock'], 'hardware', ['tests/logic.sequential.mts']),
  entry('comp.flipflop-jk', 'JK flip-flop', 'Logic', 't', 'logic-ic', 'simulated', ['gpio'], ['logic-ic', 'edge-clock'], 'hardware', ['tests/logic.sequential.mts']),
  entry('comp.latch-sr', 'SR latch', 'Logic', 't', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.sequential.mts']),
  entry('comp.latch-d', 'D latch', 'Logic', 't', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.sequential.mts']),
  entry('comp.74hc573', '74HC573 octal latch', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic', 'high-z'], 'hardware', ['tests/logic.sequential.mts']),
  entry('comp.74hc574', '74HC574 octal register', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic', 'edge-clock'], 'hardware', ['tests/logic.sequential.mts']),
  entry('comp.hc595', '74HC595 shift register', 'Logic', 'wt', 'spi-register', 'simulated', ['spi', 'gpio'], ['spi-register-device'], 'hardware', ['tests/spi.devices.mts', 'tests/sketches.audit.mts']),
  entry('comp.hc165', '74HC165 shift register', 'Logic', 'w', 'spi-register', 'simulated', ['spi', 'gpio'], ['spi-register-device'], 'hardware', ['tests/spi.devices.mts']),
  entry('comp.74hc164', '74HC164 shift register', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic', 'edge-clock'], 'hardware', ['tests/logic.sequential.mts']),
  entry('comp.74hc161', '74HC161 4-bit counter', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic', 'edge-clock'], 'hardware', ['tests/logic.sequential.mts']),
  entry('comp.74hc193', '74HC193 up/down counter', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic', 'edge-clock'], 'hardware', ['tests/logic.sequential.mts']),
  entry('comp.cd4017', 'CD4017 decade counter', 'Logic', 't', 'logic-ic', 'simulated', ['gpio'], ['logic-ic', 'edge-clock'], 'hardware', ['tests/logic.sequential.mts']),
  entry('comp.cd4026', 'CD4026 counter + 7-seg driver', 'Logic', 't', 'logic-ic', 'simulated', ['gpio'], ['logic-ic', 'edge-clock'], 'hardware', ['tests/logic.sequential.mts']),
  entry('comp.cd4040', 'CD4040 binary counter', 'Logic', 't', 'logic-ic', 'simulated', ['gpio'], ['logic-ic', 'edge-clock'], 'hardware', ['tests/logic.sequential.mts']),
  entry('comp.74hc138', '74HC138 3-to-8 decoder', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.74hc139', '74HC139 dual 2-to-4 decoder', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.74hc151', '74HC151 8-to-1 multiplexer', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.74hc153', '74HC153 dual 4-to-1 mux', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.74hc157', '74HC157 quad 2-to-1 mux', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.74hc4051', '74HC4051 8-channel analog mux', 'Logic', '-', 'logic-ic', 'missing', ['gpio', 'analog'], ['logic-ic', 'analog-pass'], 'none', NONE),
  entry('comp.74hc4052', '74HC4052 dual 4-channel mux', 'Logic', '-', 'logic-ic', 'missing', ['gpio', 'analog'], ['logic-ic', 'analog-pass'], 'none', NONE),
  entry('comp.74hc283', '74HC283 4-bit adder', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.74hc85', '74HC85 magnitude comparator', 'Logic', '-', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.gates.mts']),
  entry('comp.cd4511', 'CD4511 BCD to 7-segment', 'Logic', 't', 'logic-ic', 'simulated', ['gpio'], ['logic-ic'], 'hardware', ['tests/logic.sequential.mts']),
];

// ----------------------------------------------------------------------- ICs
const ICS: CoverageEntry[] = [
  entry('comp.ne555', 'NE555 timer', 'ICs', 't', 'logic-ic', 'missing', ['analog', 'gpio'], ['analog-solver'], 'none', NONE, 'Astable/monostable timing needs RC behaviour; a fixed-frequency stand-in would be dishonest.'),
  entry('comp.ne556', 'NE556 dual timer', 'ICs', 't', 'logic-ic', 'missing', ['analog', 'gpio'], ['analog-solver'], 'none', NONE),
  entry('comp.lm741', 'LM741 op-amp', 'ICs', 't', 'logic-ic', 'missing', ['analog'], ['analog-solver'], 'none', NONE),
  entry('comp.lm358', 'LM358 dual op-amp', 'ICs', 't', 'logic-ic', 'missing', ['analog'], ['analog-solver'], 'none', NONE),
  entry('comp.lm393', 'LM393 comparator', 'ICs', 't', 'logic-ic', 'missing', ['analog'], ['comparator'], 'none', NONE),
  entry('comp.optocoupler', 'Optocoupler (4N35)', 'ICs', 't', 'logic-ic', 'missing', ['gpio'], NONE, 'none', NONE),
  entry('comp.mcp4725', 'MCP4725 12-bit DAC', 'ICs', '-', 'i2c-register', 'simulated', ['i2c', 'analog'], ['i2c-register-device'], 'hardware', ['tests/components.i2c.mts']),
  entry('comp.ads1115', 'ADS1115 16-bit ADC', 'Sensors', 'wt', 'i2c-register', 'simulated', ['i2c','analog'], NONE, 'hardware', ['tests/data.converters.mts']),
  entry('comp.mcp3008', 'MCP3008 8-ch ADC', 'Sensors', 'w', 'spi-register', 'simulated', ['spi','analog'], NONE, 'hardware', ['tests/data.converters.mts']),
  entry('comp.ina219', 'INA219 current/voltage monitor', 'ICs', '-', 'i2c-register', 'missing', ['i2c'], ['i2c-register-device', 'current-sensing'], 'none', NONE),
  entry('comp.generic-ic', 'Generic IC (DIP)', 'ICs', 't', 'structural', 'wiring', NONE, NONE, 'basic', NONE, 'A package with pins and no behaviour, for sketching a layout.'),
];

// --------------------------------------------------------- Motors & Actuators
const MOTORS: CoverageEntry[] = [
  entry('comp.dc-motor', 'DC motor', 'Motors & Actuators', 'wt', 'actuator', 'behavioral', ['gpio', 'pwm'], NONE, 'hardware', ['tests/motors.drive.mts'], 'Direction and magnitude come from the terminal voltages; the shaft position is integrated from them. No inertia, back-EMF, torque or load — those need the analog solver.'),
  entry('comp.dc-motor-encoder', 'DC motor with encoder', 'Motors & Actuators', '-', 'actuator', 'behavioral', ['gpio', 'pwm'], NONE, 'hardware', ['tests/motors.drive.mts'], 'Both encoder channels are derived from the integrated shaft position, so direction is readable from the edge order. No inertia or load.'),
  entry('comp.gearmotor', 'Gearmotor', 'Motors & Actuators', 't', 'actuator', 'behavioral', ['gpio', 'pwm'], NONE, 'hardware', ['tests/motors.drive.mts'], 'Same terminal-derived model at a geared rating. No inertia, torque or load.'),
  entry('comp.vibration-motor', 'Vibration motor', 'Motors & Actuators', 't', 'actuator', 'behavioral', ['gpio', 'pwm'], NONE, 'hardware', ['tests/motors.drive.mts'], 'Same terminal-derived model at a 3 V rating. No inertia or torque.'),
  entry('comp.servo', 'Micro servo (SG90)', 'Motors & Actuators', 'wt', 'actuator', 'simulated', ['pwm'], NONE, 'hardware', ['tests/motors.batch5.mts', 'tests/compiler.libraries.mts', 'tests/sim.behaviors.mts'], 'The angle is decoded from the pulse on the signal wire. Driven by hand or by the Servo library on AVR; on RP2040 and ESP32 the stock libraries reach for PIO and LEDC, which are not modelled, so a build there is flagged as having no effect and the pulse must be written directly.'),
  entry('comp.stepper', 'Bipolar stepper', 'Motors & Actuators', 'wt', 'actuator', 'behavioral', ['gpio'], NONE, 'hardware', ['tests/motors.drive.mts'], 'Position is the coil pattern walked around a recognised sequence. No torque, missed steps under load, or coil current.'),
  entry('comp.stepper-28byj', '28BYJ-48 stepper', 'Motors & Actuators', 'w', 'actuator', 'behavioral', ['gpio'], NONE, 'hardware', ['tests/motors.drive.mts'], 'Position is the coil pattern walked around a recognised sequence, geared 4096 steps per output revolution. No torque or load.'),
  entry('comp.a4988', 'A4988 stepper driver', 'Motors & Actuators', 'w', 'actuator', 'behavioral', ['gpio'], NONE, 'hardware', ['tests/motors.drive.mts'], 'One microstep per rising STEP edge, in the DIR direction, gated by an active-low ENABLE and scaled by the MS1-MS3 divisor. No current limit, torque or thermal shutdown.'),
  entry('comp.uln2003', 'ULN2003 driver', 'Motors & Actuators', 'w', 'logic-ic', 'simulated', ['gpio'], NONE, 'hardware', ['tests/motors.drive.mts']),
  entry('comp.motor-driver', 'H-bridge motor driver (L298N)', 'Motors & Actuators', 't', 'actuator', 'behavioral', ['gpio', 'pwm'], NONE, 'hardware', ['tests/motors.drive.mts'], 'Each half drives its outputs from its inputs while its enable is high, from the motor supply. No bridge drop, shoot-through, current limit or thermal shutdown.'),
  entry('comp.relay', 'Relay (SPDT)', 'Motors & Actuators', 'wt', 'contact', 'behavioral', ['gpio'], NONE, 'hardware', ['tests/motors.relays.mts'], 'Contacts are moved by the coil through the shared contact model, with a one-slice pull-in that is faster than a real armature. Coil inductance, flyback, contact bounce and contact ratings are not modelled.'),
  entry('comp.relay-dpdt', 'Relay (DPDT)', 'Motors & Actuators', 't', 'contact', 'behavioral', ['gpio'], NONE, 'hardware', ['tests/motors.relays.mts'], 'Contacts are moved by the coil through the shared contact model, with a one-slice pull-in that is faster than a real armature. Coil inductance, flyback, contact bounce and contact ratings are not modelled.'),
  entry('comp.solenoid', 'Solenoid', 'Motors & Actuators', '-', 'actuator', 'behavioral', ['gpio'], NONE, 'hardware', ['tests/motors.drive.mts'], 'Energised or released from the voltage across it. No stroke, force, inductance or flyback.'),
];

// ------------------------------------------------------------- Communication
const COMMUNICATION: CoverageEntry[] = [
  entry('comp.ir-receiver', 'IR receiver (TSOP)', 'Communication', 'w', 'gpio-device', 'simulated', ['ir', 'gpio'], NONE, 'hardware', ['tests/ir.channel.mts'], 'Demodulates the shared IR medium and drives OUT active-low on the microsecond timeline, so firmware decodes the real mark and space timing itself. Distance, angle, ambient light and AGC recovery are not modelled.'),
  entry('comp.ir-led', 'IR LED / transmitter', 'Communication', 'w', 'gpio-device', 'simulated', ['ir', 'gpio'], NONE, 'hardware', ['tests/ir.channel.mts'], 'Emits into the shared medium only while its pin is genuinely toggling, at the carrier frequency measured from the edges. Brightness, current, beam angle and range are not modelled.'),
  entry('comp.ir-remote', 'Virtual IR remote', 'Communication', 'w', 'gpio-device', 'simulated', ['ir'], NONE, 'hardware', ['tests/ir.channel.mts'], 'Puts real NEC frames and repeat codes into the shared medium on a key press. It cannot address a receiver, so two remotes at once collide rather than being arbitrated.'),
  entry('comp.hc05', 'HC-05 Bluetooth module', 'Communication', '-', 'uart-device', 'behavioral', ['uart'], ['bluetooth-channel'], 'hardware', ['tests/uart.modules.mts'], 'The UART and AT-command side is real; there is no Bluetooth radio, pairing, inquiry, RFCOMM or profile handling. Data-mode bytes are recorded where a channel would attach.'),
  entry('comp.gps', 'GPS NEO-6M', 'Communication', '-', 'uart-device', 'simulated', ['uart'], NONE, 'hardware', ['tests/uart.link.mts']),
  entry('comp.esp01', 'ESP-01 AT modem', 'Communication', '-', 'uart-device', 'behavioral', ['uart'], ['network-stack'], 'hardware', ['tests/uart.esp01.mts'], 'The AT modem is real — parser, echo, CH_PD/RST gating, mode and association against a simulated access point. There is no network behind it, so AT+CIPSTART fails rather than reporting a connection that cannot exist.'),
  entry('comp.dfplayer', 'DFPlayer Mini', 'Communication', 'w', 'uart-device', 'behavioral', ['uart'], ['audio-decoder'], 'hardware', ['tests/uart.modules.mts'], 'The serial protocol, checksums and playback state are real; nothing decodes audio or models a file system, so a track number is a number.'),
  entry('comp.sim800l', 'SIM800L GSM modem', 'Communication', '-', 'uart-device', 'missing', ['uart'], ['uart-endpoint'], 'none', NONE),
  entry('comp.nrf24l01', 'nRF24L01 radio', 'Communication', '-', 'spi-register', 'simulated', ['spi', 'rf'], NONE, 'hardware', ['tests/rf.nrf24.mts'], 'Register file, both FIFOs, CE/CSN as separate signals, real airtime through the shared RF medium, and genuine auto-acknowledgement with retries and MAX_RT. RPD/RSSI read zero because the medium has no signal strength; ack payloads, payload reuse and per-bit CRC are not modelled.'),
  entry('comp.lora-sx1278', 'LoRa SX1278', 'Communication', '-', 'spi-register', 'simulated', ['spi', 'rf'], NONE, 'hardware', ['tests/rf.lora.mts'], 'Register file, FIFO with its own pointer, RegOpMode-driven modem, IRQ flags and DIO0, and datasheet time-on-air so SF7 and SF12 differ by thirty times. Frequency, spreading factor, bandwidth and sync word must all agree. RSSI, SNR, link budget, range, FSK/OOK mode, CAD and frequency hopping are not modelled.'),
  entry('comp.rf433-tx', '433 MHz transmitter (ASK)', 'Communication', '-', 'gpio-device', 'simulated', ['rf', 'gpio'], NONE, 'hardware', ['tests/rf.ook433.mts'], 'A waveform path, not a packet radio: DATA high keys the carrier and the timing is preserved exactly, so an encoding written in the sketch behaves as it would on a bench. Range, antenna length and supply dependence are not modelled.'),
  entry('comp.rf433-rx', '433 MHz receiver (ASK)', 'Communication', '-', 'gpio-device', 'simulated', ['rf', 'gpio'], NONE, 'hardware', ['tests/rf.ook433.mts'], 'DATA follows the carrier edge for edge on the microsecond clock. Deliberately kinder than the hardware in one place: a real idle receiver produces continuous AGC noise and this one reads low. Noise floor, squelch, range and bandwidth are not modelled.'),
  entry('comp.mcp2515', 'MCP2515 CAN controller', 'Communication', '-', 'spi-register', 'behavioral', ['spi', 'can'], ['can-filters'], 'hardware', ['tests/bus.can.mts', 'tests/bus.mcp2515.mts'], 'The SPI command set, register file, three transmit and two receive buffers, CANINTF/CANINTE and INT, a mode machine that refuses to transmit from configuration mode, and a bitrate computed from CNF1-3. Underneath is a bit-level bus with real wire arbitration. Acceptance filters and masks are stored but every frame is accepted; there are no error counters, so error-passive and bus-off never happen.'),
  entry('comp.max485', 'MAX485 RS-485 transceiver', 'Communication', '-', 'uart-device', 'simulated', ['uart'], NONE, 'hardware', ['tests/bus.rs485.mts'], 'A real shared bus: DE, active-low RE, self-echo, every node hearing every byte, and contention mangling traffic when two drivers are enabled at once. The pair carries bytes rather than bits because the emulator never drives the USART TX pad, so bit-banged framing on DI is not carried and a baud mismatch is not detected. Differential voltages, common-mode range, termination, cable length and slew-rate limits are not modelled.'),
  entry('comp.w5500', 'W5500 Ethernet', 'Communication', '-', 'spi-register', 'missing', ['spi'], ['spi-register-device', 'network-stack'], 'none', NONE),
  entry('comp.usb-uart', 'USB-UART adapter', 'Communication', '-', 'uart-device', 'missing', ['uart'], ['uart-endpoint'], 'none', NONE),
  entry('comp.rfid-rc522', 'MFRC522 RFID reader', 'Communication', 'w', 'spi-register', 'missing', ['spi'], ['spi-register-device'], 'none', NONE),
];

// ------------------------------------------------------- Port expanders / IO
const EXPANDERS: CoverageEntry[] = [
  entry('comp.pcf8574', 'PCF8574 I2C port expander', 'ICs', '-', 'i2c-register', 'simulated', ['i2c', 'gpio'], ['i2c-register-device', 'device-driven-pins'], 'hardware', ['tests/expanders.batch6.mts']),
  entry('comp.pcf8575', 'PCF8575 16-bit expander', 'ICs', '-', 'i2c-register', 'simulated', ['i2c', 'gpio'], ['i2c-register-device', 'device-driven-pins'], 'hardware', ['tests/expanders.batch6.mts']),
  entry('comp.mcp23017', 'MCP23017 16-bit expander', 'ICs', '-', 'i2c-register', 'simulated', ['i2c', 'gpio'], ['i2c-register-device', 'device-driven-pins'], 'hardware', ['tests/expanders.batch6.mts']),
];

// ---------------------------------------------------------- Memory & Storage
const MEMORY: CoverageEntry[] = [
  entry('comp.eeprom-24c', '24C256 I2C EEPROM', 'Memory & Storage', '-', 'memory', 'simulated', ['i2c'], ['i2c-register-device'], 'hardware', ['tests/components.i2c.mts']),
  entry('comp.eeprom-24c-variants', 'I2C EEPROM (24C02–24C512)', 'Memory & Storage', '-', 'memory', 'missing', ['i2c'], ['i2c-register-device'], 'none', NONE),
  entry('comp.fram', 'FRAM (FM24CL64)', 'Memory & Storage', '-', 'memory', 'simulated', ['i2c'], NONE, 'hardware', ['tests/data.converters.mts']),
  entry('comp.sram-23lc', 'SPI SRAM (23LC1024)', 'Memory & Storage', '-', 'memory', 'missing', ['spi'], ['spi-register-device'], 'none', NONE),
  entry('comp.spi-flash', 'SPI NOR flash', 'Memory & Storage', '-', 'memory', 'simulated', ['spi'], ['spi-register-device'], 'hardware', ['tests/spi.devices.mts']),
  entry('comp.sd-card', 'microSD card', 'Memory & Storage', 'w', 'memory', 'simulated', ['spi'], ['spi-register-device'], 'hardware', ['tests/spi.devices.mts']),
  entry('comp.ds3231', 'DS3231 RTC', 'Memory & Storage', '-', 'i2c-register', 'simulated', ['i2c'], ['i2c-register-device'], 'hardware', ['tests/components.i2c.mts']),
  entry('comp.ds1307', 'DS1307 RTC', 'ICs', 'wt', 'i2c-register', 'simulated', ['i2c'], NONE, 'hardware', ['tests/data.converters.mts']),
];

// --------------------------------------------------------------------- Power
const POWER: CoverageEntry[] = [
  entry('comp.cell-15', 'Cell (1.5V)', 'Power', 'wt', 'power', 'simulated', NONE, NONE, 'hardware', ['tests/power.rails.mts']),
  entry('comp.ldo', 'LDO regulator (3.3V)', 'Power', '-', 'power', 'behavioral', NONE, NONE, 'hardware', ['tests/power.rails.mts'], 'Low dropout: holds 3.3 V from a few hundred millivolts of headroom, with a module-pulled-up enable. Ripple, quiescent current, thermal shutdown and current limit are not modelled.'),
  entry('comp.battery-9v', '9V battery', 'Power', 'wt', 'power', 'simulated', NONE, NONE, 'hardware', ['tests/power.rails.mts']),
  entry('comp.battery-aa', 'AA battery (1.5V)', 'Power', 'wt', 'power', 'simulated', NONE, NONE, 'hardware', ['tests/power.rails.mts']),
  entry('comp.battery-coin', 'Coin cell (CR2032)', 'Power', 't', 'power', 'simulated', NONE, NONE, 'hardware', ['tests/power.rails.mts']),
  entry('comp.dc-supply', 'Adjustable DC supply', 'Power', 't', 'power', 'simulated', NONE, NONE, 'hardware', ['tests/power.rails.mts']),
  entry('comp.regulator', 'Linear regulator', 'Power', 't', 'power', 'behavioral', NONE, NONE, 'hardware', ['tests/power.rails.mts'], 'Imposes its nominal output when the input clears its dropout and its ground is fed. Ripple, efficiency, thermal shutdown, transient response and current limit are not modelled.'),
  entry('comp.regulator-33', '3.3V regulator', 'Power', 't', 'power', 'behavioral', NONE, NONE, 'hardware', ['tests/power.rails.mts'], 'Imposes 3.3 V when the input clears 1.5 V of headroom and its ground is fed. Ripple, efficiency, thermal shutdown, transient response and current limit are not modelled.'),
  entry('comp.regulator-5', '5V regulator', 'Power', 't', 'power', 'behavioral', NONE, NONE, 'hardware', ['tests/power.rails.mts'], 'Imposes 5 V when the input clears 2 V of headroom and its ground is fed. Ripple, efficiency, thermal shutdown, transient response and current limit are not modelled.'),
  entry('comp.buck-converter', 'Buck converter', 'Power', '-', 'power', 'behavioral', NONE, NONE, 'hardware', ['tests/power.rails.mts'], 'Holds its set output from any input above it with headroom. Switching frequency, efficiency, ripple, inductor behaviour and current limit are not modelled and no efficiency is claimed.'),
  entry('comp.boost-converter', 'Boost converter', 'Power', '-', 'power', 'behavioral', NONE, NONE, 'hardware', ['tests/power.rails.mts'], 'Holds its set output from an input below it. Switching frequency, efficiency, ripple and current limit are not modelled.'),
  entry('comp.level-converter', 'Logic level converter', 'Power', '-', 'passive', 'behavioral', NONE, NONE, 'hardware', ['tests/sim.behaviors.mts'], 'Channels conduct; the level shift itself is not voltage-translated.'),
  entry('comp.transistor-npn', 'NPN transistor', 'Power', 'wt', 'passive', 'wiring', NONE, ['analog-solver'], 'hardware', NONE, 'Drawn and wired. Switching behaviour needs the analog solver.'),
  entry('comp.transistor-pnp', 'PNP transistor', 'Power', 'wt', 'passive', 'missing', NONE, ['analog-solver'], 'none', NONE),
  entry('comp.mosfet', 'N-channel MOSFET', 'Power', 'wt', 'passive', 'wiring', NONE, ['analog-solver'], 'hardware', NONE, 'Drawn and wired. Switching behaviour needs the analog solver.'),
  entry('comp.mosfet-p', 'P-channel MOSFET', 'Power', 't', 'passive', 'missing', NONE, ['analog-solver'], 'none', NONE),
  entry('comp.mosfet-driver', 'MOSFET driver', 'Power', '-', 'logic-ic', 'missing', ['gpio'], ['logic-ic'], 'none', NONE),
];

// --------------------------------------------------------------- Instruments
const INSTRUMENTS: CoverageEntry[] = [
  entry('comp.multimeter', 'Multimeter', 'Instruments', 't', 'instrument', 'missing', ['analog'], ['probe-model'], 'none', NONE),
  entry('comp.oscilloscope', 'Oscilloscope', 'Instruments', 't', 'instrument', 'missing', ['analog'], ['probe-model', 'waveform-capture'], 'none', NONE, 'Must plot real net voltage against world time. A cosmetic waveform is not acceptable.'),
  entry('comp.logic-analyzer', 'Logic analyzer', 'Instruments', 'w', 'instrument', 'missing', ['gpio'], ['waveform-capture'], 'none', NONE),
  entry('comp.function-generator', 'Function generator', 'Instruments', 't', 'instrument', 'missing', ['analog'], ['waveform-source'], 'none', NONE),
  entry('comp.variable-supply', 'Variable DC power supply', 'Instruments', 't', 'instrument', 'missing', NONE, NONE, 'none', NONE),
  entry('comp.frequency-counter', 'Frequency counter', 'Instruments', '-', 'instrument', 'missing', ['gpio'], ['waveform-capture'], 'none', NONE),
];

// -------------------------------------------------------------------- Output
const OUTPUT: CoverageEntry[] = [
  entry('comp.buzzer', 'Piezo buzzer', 'Motors & Actuators', 'wt', 'actuator', 'simulated', ['gpio', 'pwm'], NONE, 'hardware', ['tests/sim.behaviors.mts']),
  entry('comp.speaker', 'Speaker', 'Motors & Actuators', 't', 'actuator', 'wiring', ['gpio'], NONE, 'hardware', NONE, 'Drawn and wired; no audio is synthesised.'),
];

export const COMPONENT_COVERAGE: CoverageEntry[] = [
  ...PROTOTYPING,
  ...BASIC,
  ...INPUTS,
  ...KEYPADS,
  ...SENSORS,
  ...DISPLAYS,
  ...LEDS,
  ...LOGIC,
  ...ICS,
  ...EXPANDERS,
  ...MOTORS,
  ...COMMUNICATION,
  ...MEMORY,
  ...POWER,
  ...INSTRUMENTS,
  ...OUTPUT,
];

export interface CoverageSummary {
  total: number;
  implemented: number;
  simulated: number;
  partial: number;
  missing: number;
  wokwiTargets: number;
  wokwiCovered: number;
  wokwiParityPct: number;
  tinkercadTargets: number;
  tinkercadCovered: number;
  tinkercadParityPct: number;
  beyondParity: number;
  beyondParityCovered: number;
}

/**
 * The counts, computed rather than maintained by hand.
 *
 * "Covered" deliberately means simulated or behavioral — a part that is only
 * drawn is not parity with a part that runs, and counting artwork toward a
 * parity number is the exact self-deception this file exists to prevent.
 */
export function coverageSummary(entries: CoverageEntry[] = COMPONENT_COVERAGE): CoverageSummary {
  const covered = (e: CoverageEntry) => e.status === 'simulated' || e.status === 'behavioral';
  const implemented = entries.filter((e) => e.status !== 'missing');
  const wokwi = entries.filter((e) => e.sourceParity.wokwi);
  const tinker = entries.filter((e) => e.sourceParity.tinkercad);
  const beyond = entries.filter((e) => e.sourceParity.circuitdeskExtra);
  const pct = (a: number, b: number) => (b === 0 ? 100 : Math.round((a / b) * 1000) / 10);
  return {
    total: entries.length,
    implemented: implemented.length,
    simulated: entries.filter((e) => e.status === 'simulated').length,
    partial: entries.filter((e) => e.status === 'behavioral' || e.status === 'wiring' || e.status === 'artwork').length,
    missing: entries.filter((e) => e.status === 'missing').length,
    wokwiTargets: wokwi.length,
    wokwiCovered: wokwi.filter(covered).length,
    wokwiParityPct: pct(wokwi.filter(covered).length, wokwi.length),
    tinkercadTargets: tinker.length,
    tinkercadCovered: tinker.filter(covered).length,
    tinkercadParityPct: pct(tinker.filter(covered).length, tinker.length),
    beyondParity: beyond.length,
    beyondParityCovered: beyond.filter(covered).length,
  };
}

/** Coverage entries grouped by the shelf they appear on. */
export function coverageByCategory(entries: CoverageEntry[] = COMPONENT_COVERAGE): Map<PartCategory, CoverageEntry[]> {
  const map = new Map<PartCategory, CoverageEntry[]>();
  for (const e of entries) map.set(e.category, [...(map.get(e.category) ?? []), e]);
  return map;
}

/** Infrastructure named by at least one entry, with how many parts wait on it. */
export function blockingDependencies(entries: CoverageEntry[] = COMPONENT_COVERAGE): { name: string; blocks: number }[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.status !== 'missing') continue;
    for (const dep of e.dependencies) counts.set(dep, (counts.get(dep) ?? 0) + 1);
  }
  return [...counts].map(([name, blocks]) => ({ name, blocks })).sort((a, b) => b.blocks - a.blocks);
}
