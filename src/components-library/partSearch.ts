// Finding a part without already knowing its name.
//
// A flat list works at forty parts and stops working somewhere before two
// hundred. The failure is not really length though — it is that the library
// indexes what a part is *called*, and users search for what it *does*. Nobody
// types "MPU6050" when they want to detect tilt; they type "accelerometer".
//
// So every part gets aliases, and the search matches them. The aliases are
// deliberately the words people actually use, including the wrong-but-common
// ones, because a search that only accepts the correct term is a quiz.

import type { PartDefinition } from '../types';

/**
 * Extra search terms per part id.
 *
 * Only terms that are not already in the part's name — the name is always
 * searched, so repeating it here would be noise.
 */
export const PART_ALIASES: Record<string, string[]> = {
  // Boards people describe by chip or nickname rather than product name.
  'board.arduino-uno': ['atmega328', '328p', 'avr'],
  'board.arduino-nano': ['atmega328', 'avr'],
  'board.arduino-mega2560': ['atmega2560', 'avr'],
  'board.arduino-leonardo': ['atmega32u4', 'avr'],
  'board.raspberry-pi-pico': ['rp2040', 'pico'],
  'board.raspberry-pi-pico-w': ['rp2040', 'pico', 'wifi'],
  'board.esp32-c6-devkitc-1': ['esp32', 'riscv', 'wifi', 'c6'],
  'board.esp32-c3': ['esp32', 'riscv', 'wifi', 'c3'],
  'board.esp32-devkit': ['esp32', 'wifi', 'xtensa'],

  // Inputs.
  'comp.push-button': ['switch', 'momentary', 'tactile', 'press'],
  'comp.push-button-6mm': ['switch', 'momentary', 'tactile', 'small button'],
  'comp.toggle-switch': ['spdt', 'changeover', 'flip'],
  'comp.slide-switch': ['spdt', 'changeover', 'sliding'],
  'comp.limit-switch': ['microswitch', 'end stop', 'endstop', 'lever'],
  'comp.dip-switch-4': ['dipswitch', 'address', 'config switch'],
  'comp.dip-switch-6': ['dipswitch', 'address', 'config switch'],
  'comp.dip-switch-8': ['dipswitch', 'address', 'config switch'],
  'comp.potentiometer': ['pot', 'variable resistor', 'knob', 'dial', 'trimmer'],
  'comp.rotary-encoder': ['ky040', 'ky-040', 'encoder', 'quadrature', 'knob', 'dial'],
  'comp.joystick': ['thumbstick', 'stick', 'ky-023', 'analog stick', 'gamepad'],

  // Keyboards and keypads.
  'comp.keypad-3x4': ['keypad', 'membrane', 'numeric', 'phone keypad', '12 key', 'matrix'],
  'comp.keypad-4x4': ['keypad', 'membrane', 'hex keypad', '16 key', 'matrix'],
  'comp.keypad-matrix': ['keypad', 'custom keypad', 'matrix', 'configurable'],
  'comp.mini-keyboard': ['keyboard', 'qwerty', 'typing', 'terminal', 'thumb keyboard', 'matrix'],

  // Sensors, searched by phenomenon far more often than by part number.
  'comp.mpu6050': ['accelerometer', 'gyroscope', 'gyro', 'imu', 'tilt', 'motion', 'orientation'],
  'comp.bmp280': ['pressure', 'barometer', 'altitude', 'temperature', 'weather'],
  'comp.tmp36': ['temperature', 'thermometer', 'analog temperature'],
  'comp.ldr': ['light', 'photoresistor', 'photocell', 'brightness', 'light sensor'],
  'comp.ultrasonic': ['distance', 'range', 'proximity', 'sonar', 'hc-sr04', 'hcsr04'],
  'comp.pulse-sensor': ['heart rate', 'heartbeat', 'bpm', 'pulse'],

  // Batch 3 sensors.
  'comp.bme280': ['temperature', 'humidity', 'pressure', 'weather', 'environmental', 'barometer', 'bosch'],
  'comp.sht31': ['temperature', 'humidity', 'sensirion', 'rh'],
  'comp.lm35': ['temperature', 'thermometer', 'analog temperature', 'to-92'],
  'comp.ntc-thermistor': ['temperature', 'thermistor', 'ntc', 'thermometer'],
  'comp.pir': ['motion', 'movement', 'presence', 'infrared', 'hc-sr501', 'occupancy'],
  'comp.tilt-switch': ['tilt', 'orientation', 'ball switch', 'motion'],
  'comp.vibration-sensor': ['vibration', 'shock', 'knock', 'sw-420', 'tap'],
  'comp.hall-sensor': ['hall', 'magnet', 'magnetic', 'proximity', 'rpm'],
  'comp.photodiode': ['light', 'optical', 'photo', 'brightness'],
  'comp.flex-sensor': ['bend', 'flex', 'glove', 'strain'],
  'comp.fsr': ['force', 'pressure', 'weight', 'touch', 'fsr'],
  'comp.soil-moisture': ['soil', 'moisture', 'water', 'plant', 'garden', 'humidity'],
  'comp.mq2': ['gas', 'smoke', 'lpg', 'methane', 'air quality', 'mq2'],
  'comp.rain-sensor': ['rain', 'water', 'wet', 'weather', 'leak'],

  // Displays.
  'comp.lcd1602': ['lcd', 'character display', '16x2', 'hd44780', 'text display'],
  'comp.oled': ['ssd1306', 'oled', 'graphic display', '128x64', 'screen'],
  'comp.seven-segment': ['7 segment', 'seven segment', 'digit', 'numeric display'],

  // Logic — searched by function far more often than by part number.
  'comp.gate-and': ['logic gate', 'and', 'symbol'],
  'comp.gate-or': ['logic gate', 'or', 'symbol'],
  'comp.gate-not': ['inverter', 'logic gate', 'not'],
  'comp.gate-nand': ['logic gate', 'nand', 'universal gate'],
  'comp.gate-nor': ['logic gate', 'nor'],
  'comp.gate-xor': ['logic gate', 'xor', 'exclusive or'],
  'comp.gate-xnor': ['logic gate', 'xnor'],
  'comp.buffer-tristate': ['tristate', 'three state', 'high-z', 'bus buffer', 'logic gate'],
  'comp.schmitt-trigger': ['hysteresis', 'debounce', 'squarer', 'logic gate'],
  'comp.74hc00': ['nand', 'logic gate', '7400', 'quad nand'],
  'comp.74hc02': ['nor', 'logic gate', '7402'],
  'comp.74hc04': ['inverter', 'not', 'logic gate', '7404', 'hex inverter'],
  'comp.74hc08': ['and', 'logic gate', '7408'],
  'comp.74hc14': ['schmitt', 'hysteresis', 'debounce', 'inverter', '7414'],
  'comp.74hc32': ['or', 'logic gate', '7432'],
  'comp.74hc86': ['xor', 'exclusive or', 'logic gate', '7486'],
  'comp.74hc125': ['tristate', 'buffer', 'high-z', 'bus'],
  'comp.74hc126': ['tristate', 'buffer', 'high-z', 'bus'],
  'comp.74hc244': ['buffer', 'octal', 'bus driver', 'tristate'],
  'comp.74hc245': ['transceiver', 'bus', 'bidirectional', 'octal', 'tristate'],
  'comp.74hc74': ['flip flop', 'flipflop', 'd flip-flop', 'register', 'storage'],
  'comp.flipflop-jk': ['flip flop', 'flipflop', 'toggle', 'divide by two', 'storage'],
  'comp.latch-sr': ['latch', 'set reset', 'memory', 'storage'],
  'comp.latch-d': ['latch', 'transparent', 'storage'],
  'comp.74hc573': ['latch', 'octal', 'transparent', 'address latch', '573'],
  'comp.74hc574': ['register', 'octal', 'flip flop', '574'],
  'comp.74hc161': ['counter', 'binary counter', '4 bit', '161'],
  'comp.74hc193': ['counter', 'up down counter', 'bidirectional', '193'],
  'comp.cd4017': ['counter', 'decade', 'sequencer', 'chaser', 'johnson', '4017'],
  'comp.cd4026': ['counter', 'seven segment', '7 segment', 'digit', '4026'],
  'comp.cd4040': ['counter', 'ripple', 'divider', 'clock divider', '4040'],
  'comp.74hc138': ['decoder', 'demux', 'demultiplexer', 'address decoder', '3 to 8', '138'],
  'comp.74hc139': ['decoder', 'demux', 'demultiplexer', '2 to 4', '139'],
  'comp.74hc151': ['mux', 'multiplexer', 'selector', '8 to 1', '151'],
  'comp.74hc153': ['mux', 'multiplexer', 'selector', '4 to 1', '153'],
  'comp.74hc157': ['mux', 'multiplexer', 'selector', '2 to 1', '157'],
  'comp.74hc283': ['adder', 'arithmetic', 'sum', 'alu', '283'],
  'comp.74hc85': ['comparator', 'magnitude', 'compare', 'greater than', '85'],
  'comp.cd4511': ['bcd', 'seven segment', '7 segment', 'decoder', 'driver', '4511'],
  'comp.74hc164': ['shift register', 'serial to parallel', '164'],

  // Logic and ICs.
  'comp.hc595': ['shift register', '595', 'serial to parallel', 'expand outputs'],
  'comp.hc165': ['shift register', '165', 'parallel to serial', 'expand inputs'],
  'comp.mcp4725': ['dac', 'digital to analog', 'analog out'],
  'comp.generic-ic': ['dip', 'chip', 'package'],

  // Memory and time.
  'comp.eeprom-24c': ['eeprom', 'memory', 'storage', '24c256', 'nonvolatile'],
  'comp.spi-flash': ['flash', 'memory', 'storage', 'nor'],
  'comp.sd-card': ['sd', 'microsd', 'card', 'storage', 'filesystem'],
  'comp.ds3231': ['rtc', 'clock', 'real time clock', 'time', 'date'],

  // Motors and output.
  'comp.servo': ['sg90', 'rc servo', 'angle', 'rotate'],
  'comp.dc-motor': ['motor', 'spin'],
  'comp.stepper': ['stepper', 'nema'],
  'comp.motor-driver': ['l298', 'h-bridge', 'hbridge', 'motor controller'],
  'comp.relay': ['switch load', 'mains', 'contactor'],
  'comp.buzzer': ['piezo', 'beeper', 'sound', 'tone', 'speaker'],

  // Power.
  'comp.battery-9v': ['battery', 'power', 'pp3', 'supply'],
  'comp.battery-aa': ['battery', 'power', 'cell', 'supply'],
  'comp.regulator': ['ldo', '7805', 'voltage regulator'],
  'comp.level-converter': ['level shifter', '3.3v to 5v', 'logic level'],
  'comp.led': ['light', 'indicator', 'lamp'],
  'comp.rgb-led': ['colour led', 'color led', 'tricolour', 'multicolour'],
  'comp.resistor': ['ohm', 'current limiting'],
  'comp.capacitor': ['cap', 'farad', 'decoupling'],
  'comp.diode': ['1n4148', 'rectifier'],
  'comp.transistor-npn': ['bjt', '2n2222', 'switch'],
  'comp.mosfet': ['fet', 'nmos', 'switch'],
  'comp.breadboard-half': ['protoboard', 'solderless'],
  'comp.breadboard-mini': ['protoboard', 'solderless'],
};

/**
 * The compact second line on a part card.
 *
 * Deliberately terse — what it is, how it talks, what it measures. The full
 * description is still on the tooltip; this is the bit you read while
 * scanning, so anything longer than a glance defeats it.
 */
export const PART_SUMMARY: Record<string, string> = {
  'comp.bme280': 'Temperature • Humidity • Pressure · I²C',
  'comp.sht31': 'Temperature • Humidity · I²C · CRC-checked',
  'comp.lm35': 'Temperature · analog · 10 mV/°C',
  'comp.ntc-thermistor': 'Temperature · analog · beta model',
  'comp.pir': 'Motion · digital · holds after trigger',
  'comp.tilt-switch': 'Tilt · digital',
  'comp.vibration-sensor': 'Shock · digital · pulsed',
  'comp.hall-sensor': 'Magnetic field · digital · active low',
  'comp.photodiode': 'Illuminance · analog',
  'comp.flex-sensor': 'Bend · analog',
  'comp.fsr': 'Force · analog',
  'comp.soil-moisture': 'Soil water · analog · falls when wet',
  'comp.mq2': 'Combustible gas • smoke · analog',
  'comp.rain-sensor': 'Surface wetness · analog',
  'comp.gate-and': 'AND · logic symbol',
  'comp.gate-or': 'OR · logic symbol',
  'comp.gate-not': 'Inverter · logic symbol',
  'comp.gate-nand': 'NAND · logic symbol',
  'comp.gate-nor': 'NOR · logic symbol',
  'comp.gate-xor': 'XOR · logic symbol',
  'comp.gate-xnor': 'XNOR · logic symbol',
  'comp.buffer-tristate': 'Buffer with output enable · high-Z',
  'comp.schmitt-trigger': 'Inverter with hysteresis',
  'comp.74hc00': 'Quad 2-input NAND · 14-pin DIP',
  'comp.74hc02': 'Quad 2-input NOR · 14-pin DIP',
  'comp.74hc04': 'Hex inverter · 14-pin DIP',
  'comp.74hc08': 'Quad 2-input AND · 14-pin DIP',
  'comp.74hc14': 'Hex Schmitt inverter · 14-pin DIP',
  'comp.74hc32': 'Quad 2-input OR · 14-pin DIP',
  'comp.74hc86': 'Quad 2-input XOR · 14-pin DIP',
  'comp.74hc125': 'Quad tri-state buffer · active-low enable',
  'comp.74hc126': 'Quad tri-state buffer · active-high enable',
  'comp.74hc244': 'Octal buffer · two enables',
  'comp.74hc245': 'Octal transceiver · direction pin',
  'comp.74hc74': 'Dual D flip-flop · async preset/clear',
  'comp.flipflop-jk': 'JK flip-flop · toggles on J=K=1',
  'comp.latch-sr': 'Set-reset latch',
  'comp.latch-d': 'Transparent D latch',
  'comp.74hc573': 'Octal transparent latch · tri-state',
  'comp.74hc574': 'Octal D register · tri-state',
  'comp.74hc161': '4-bit synchronous counter · parallel load',
  'comp.74hc193': '4-bit up/down counter',
  'comp.cd4017': 'Decade counter · 10 decoded outputs',
  'comp.cd4026': 'Decade counter + 7-segment driver',
  'comp.cd4040': '12-stage ripple counter · clock divider',
  'comp.74hc138': '3-to-8 decoder · active-low outputs',
  'comp.74hc139': 'Dual 2-to-4 decoder',
  'comp.74hc151': '8-to-1 multiplexer',
  'comp.74hc153': 'Dual 4-to-1 multiplexer',
  'comp.74hc157': 'Quad 2-to-1 multiplexer',
  'comp.74hc283': '4-bit adder · carry in/out',
  'comp.74hc85': '4-bit magnitude comparator',
  'comp.cd4511': 'BCD to 7-segment · latch + blanking',
  'comp.74hc164': '8-bit shift register · serial in',
  'comp.keypad-3x4': '12-key membrane · 4 rows × 3 cols · matrix scan',
  'comp.keypad-4x4': '16-key membrane · 4 rows × 4 cols · matrix scan',
  'comp.keypad-matrix': 'Configurable matrix · rows × cols · matrix scan',
  'comp.mini-keyboard': '50-key keyboard · 5 rows × 10 cols · matrix scan',
  'comp.dip-switch-4': '4 independent poles · config / address',
  'comp.dip-switch-6': '6 independent poles · config / address',
  'comp.dip-switch-8': '8 independent poles · config / address',
  'comp.rotary-encoder': 'Incremental encoder · quadrature + push',
  'comp.joystick': 'Two axes · analog · push switch',
  'comp.limit-switch': 'SPDT lever · NC at rest',
  'comp.slide-switch': 'SPDT · break before make',
  'comp.push-button-6mm': 'Momentary · 6mm tactile',
  'comp.push-button': 'Momentary · 12mm tactile',
  'comp.toggle-switch': 'SPDT · latching',
  'comp.mpu6050': 'Accelerometer + gyro · I²C',
  'comp.bmp280': 'Pressure + temperature · I²C',
  'comp.lcd1602': 'Character display 16×2 · I²C',
  'comp.oled': 'Graphic OLED 128×64 · I²C',
  'comp.hc595': 'Serial-in / parallel-out shift register · SPI',
  'comp.hc165': 'Parallel-in / serial-out shift register · SPI',
  'comp.ds3231': 'Real-time clock · I²C',
  'comp.eeprom-24c': '256 kbit EEPROM · I²C',
  'comp.spi-flash': 'NOR flash · SPI',
  'comp.sd-card': 'microSD card · SPI',
  'comp.mcp4725': '12-bit DAC · I²C',
  'comp.ultrasonic': 'Distance 2–400 cm · trigger/echo',
  'comp.servo': 'Angle 0–180° · PWM',
  'comp.potentiometer': 'Variable resistor · analog',
  'comp.ldr': 'Light-dependent resistor · analog',
  'comp.tmp36': 'Temperature · analog',
};

/** Everything a query is matched against, lowercased. */
function haystack(def: PartDefinition): string {
  const aliases = PART_ALIASES[def.id] ?? [];
  const summary = PART_SUMMARY[def.id] ?? '';
  const family = 'family' in def && typeof def.family === 'string' ? def.family : '';
  return [def.name, def.id, family, summary, ...aliases].join(' ').toLowerCase();
}

/**
 * Whether a part matches a query.
 *
 * Every whitespace-separated word must match somewhere, so "i2c display"
 * narrows rather than widening — which is what a second word is for.
 */
export function partMatches(def: PartDefinition, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const hay = haystack(def);
  return q.split(/\s+/).every((word) => hay.includes(word));
}

/**
 * Ranks matches so an exact part number beats an incidental alias hit.
 *
 * Searching "595" should put the 74HC595 first even though several parts
 * mention shift registers. Lower is better.
 */
export function matchRank(def: PartDefinition, query: string): number {
  const q = query.trim().toLowerCase();
  if (q === '') return 0;
  const name = def.name.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if ((PART_ALIASES[def.id] ?? []).some((a) => a.toLowerCase() === q)) return 3;
  if (def.id.toLowerCase().includes(q)) return 4;
  return 5;
}
