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

  // Displays.
  'comp.lcd1602': ['lcd', 'character display', '16x2', 'hd44780', 'text display'],
  'comp.oled': ['ssd1306', 'oled', 'graphic display', '128x64', 'screen'],
  'comp.seven-segment': ['7 segment', 'seven segment', 'digit', 'numeric display'],

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
