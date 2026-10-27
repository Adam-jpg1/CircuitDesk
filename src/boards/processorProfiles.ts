// What CircuitDesk knows about a microcontroller, in one place.
//
// A board and a processor are different things, and conflating them is what
// stops anyone from bringing their own board. An ATmega328P is an ATmega328P
// whether it is on an Arduino Uno, on a Nano, or on a board somebody designed
// last week — the pin count, the ADC channels, the UARTs and what the emulator
// can do with them belong to the CHIP. The board contributes a name, an
// outline, and which pad each of its headers goes to.
//
// So this file holds the chip half. A native board names a profile; a custom
// board names the same profile; and every part of the app that needs to reason
// about the MCU — validation, the pin-mapping editor, the capability summary —
// reads it from here rather than keeping its own copy.
//
// Two rules keep this honest:
//
//   - a profile describes the PROCESSOR, not the runtime. `padCount` is how
//     many GPIOs the chip has; whether CircuitDesk can execute code on it is a
//     runtime profile's business, and they are deliberately separate so a board
//     can be compile-supported and runtime-unsupported without lying either way.
//   - nothing here may claim a peripheral the chip does not have. A profile is
//     the thing custom boards are validated against, so a wrong entry produces
//     a board that maps a pin to a pad that does not exist.

import type { BoardArchitecture } from '../types';

/**
 * Architectures a processor profile can belong to.
 *
 * Finer-grained than the board-level `BoardArchitecture`, deliberately: a board
 * is an "esp32" board, and the chip on it is specifically an ESP32-C3 or an
 * ESP32-C6, which are different machines with different memory maps. The coarse
 * family is carried alongside as `boardArchitecture` rather than derived by
 * string matching, so the two vocabularies stay explicitly linked.
 */
export type ProcessorArchitecture = 'avr' | 'rp2040' | 'esp32c3' | 'esp32c6';

export interface PeripheralController {
  /** Controller id as the chip's own documentation names it: `i2c0`, `usart1`. */
  id: string;
  /**
   * What a sketch calls this controller — `Wire`, `SPI1`, `Serial1`.
   *
   * Carried here because it is the only name the user can act on. A message
   * that says "put both lines on i2c0" is a datasheet fact; one that says "put
   * both lines on Wire" is something they can type. The two names are not
   * derivable from each other (the RP2040's uart0 is Arduino's Serial1), so the
   * profile states both rather than letting a consumer guess.
   */
  arduinoName?: string;
  /** Pads this controller's signals may use, by signal name. */
  signals: Record<string, string[]>;
  /** Pads used when firmware does not say otherwise (Wire.begin(), Serial1). */
  defaults?: Record<string, string>;
}

export interface ProcessorProfile {
  /** Stable id. Referenced by boards and by compile/runtime profiles. */
  id: string;
  /** What the chip is called on its own datasheet. */
  name: string;
  architecture: ProcessorArchitecture;
  /** The board-level family this chip belongs to, as BoardArchitecture spells it. */
  boardArchitecture: BoardArchitecture;
  /** Vendor of the silicon, not of any board carrying it. */
  vendor: string;
  /** Core clock in Hz at the configuration CircuitDesk compiles for. */
  clockHz: number;
  flashBytes: number;
  ramBytes: number;
  /**
   * Every GPIO pad the chip exposes, in its own naming.
   *
   * This is the namespace a custom board maps its physical pins INTO: a board
   * pin labelled MOTOR_PWM maps to `GP15`, and `GP15` has to be in this list or
   * the mapping is refused.
   */
  pads: string[];
  /** Pads that can be read by the ADC, and the channel each one is. */
  adcChannels: Record<string, number>;
  /** Pads that can produce PWM. Empty when the runtime models none. */
  pwmPads: string[];
  uarts: PeripheralController[];
  i2c: PeripheralController[];
  spi: PeripheralController[];
  /** Pads that can raise an external interrupt. */
  interruptPads: string[];
  /** Operating logic level in volts, for wiring checks. */
  logicVolts: number;
  /**
   * Things about this chip that CircuitDesk does not model, in plain words.
   *
   * Carried on the PROCESSOR because they are properties of the silicon as
   * CircuitDesk sees it; a custom board inherits them and cannot opt out.
   */
  notModelled: string[];
}

/** The AVR pads, in the ports the emulator actually drives. */
const avrPads = (ports: Record<string, number>): string[] =>
  Object.entries(ports).flatMap(([port, count]) =>
    Array.from({ length: count }, (_, i) => `P${port}${i}`),
  );

const ATMEGA328P: ProcessorProfile = {
  id: 'proc.atmega328p',
  name: 'ATmega328P',
  architecture: 'avr',
  boardArchitecture: 'avr',
  vendor: 'Microchip',
  clockHz: 16_000_000,
  flashBytes: 32_768,
  ramBytes: 2_048,
  pads: avrPads({ B: 8, C: 7, D: 8 }),
  adcChannels: { PC0: 0, PC1: 1, PC2: 2, PC3: 3, PC4: 4, PC5: 5 },
  pwmPads: ['PD3', 'PD5', 'PD6', 'PB1', 'PB2', 'PB3'],
  uarts: [{ id: 'usart0', arduinoName: 'Serial', signals: { tx: ['PD1'], rx: ['PD0'] }, defaults: { tx: 'PD1', rx: 'PD0' } }],
  i2c: [{ id: 'twi0', arduinoName: 'Wire', signals: { sda: ['PC4'], scl: ['PC5'] }, defaults: { sda: 'PC4', scl: 'PC5' } }],
  spi: [
    {
      id: 'spi0',
      arduinoName: 'SPI',
      signals: { sck: ['PB5'], miso: ['PB4'], mosi: ['PB3'], ss: ['PB2'] },
      defaults: { sck: 'PB5', miso: 'PB4', mosi: 'PB3', ss: 'PB2' },
    },
  ],
  interruptPads: ['PD2', 'PD3'],
  logicVolts: 5,
  notModelled: ['EEPROM persistence', 'watchdog reset', 'sleep modes', 'analog comparator'],
};

const ATMEGA2560: ProcessorProfile = {
  id: 'proc.atmega2560',
  name: 'ATmega2560',
  architecture: 'avr',
  boardArchitecture: 'avr',
  vendor: 'Microchip',
  clockHz: 16_000_000,
  flashBytes: 262_144,
  ramBytes: 8_192,
  pads: avrPads({ A: 8, B: 8, C: 8, D: 8, E: 8, F: 8, G: 6, H: 8, J: 8, K: 8, L: 8 }),
  adcChannels: {
    PF0: 0, PF1: 1, PF2: 2, PF3: 3, PF4: 4, PF5: 5, PF6: 6, PF7: 7,
    PK0: 8, PK1: 9, PK2: 10, PK3: 11, PK4: 12, PK5: 13, PK6: 14, PK7: 15,
  },
  pwmPads: ['PE4', 'PE5', 'PE3', 'PH3', 'PH4', 'PH5', 'PB4', 'PB5', 'PB6', 'PB7', 'PL3', 'PL4', 'PL5'],
  uarts: [{ id: 'usart0', arduinoName: 'Serial', signals: { tx: ['PE1'], rx: ['PE0'] }, defaults: { tx: 'PE1', rx: 'PE0' } }],
  i2c: [{ id: 'twi0', arduinoName: 'Wire', signals: { sda: ['PD1'], scl: ['PD0'] }, defaults: { sda: 'PD1', scl: 'PD0' } }],
  spi: [
    {
      id: 'spi0',
      arduinoName: 'SPI',
      signals: { sck: ['PB1'], miso: ['PB3'], mosi: ['PB2'], ss: ['PB0'] },
      defaults: { sck: 'PB1', miso: 'PB3', mosi: 'PB2', ss: 'PB0' },
    },
  ],
  // The emulator's interrupt wiring is 328P-specific, so this chip declares
  // none rather than offering pads that would do nothing.
  interruptPads: [],
  logicVolts: 5,
  notModelled: [
    'USART1-3 (only USART0 is emulated)',
    'external and pin-change interrupts',
    'EEPROM persistence',
  ],
};

const ATMEGA32U4: ProcessorProfile = {
  id: 'proc.atmega32u4',
  name: 'ATmega32U4',
  architecture: 'avr',
  boardArchitecture: 'avr',
  vendor: 'Microchip',
  clockHz: 16_000_000,
  flashBytes: 28_672,
  ramBytes: 2_560,
  pads: avrPads({ B: 8, C: 8, D: 8, E: 8, F: 8 }),
  adcChannels: { PF0: 0, PF1: 1, PF4: 4, PF5: 5, PF6: 6, PF7: 7 },
  // Timer4 is not modelled, so its two PWM pads are deliberately absent.
  pwmPads: ['PD0', 'PC6', 'PB5', 'PB6', 'PB7'],
  uarts: [{ id: 'usart1', arduinoName: 'Serial1', signals: { tx: ['PD3'], rx: ['PD2'] }, defaults: { tx: 'PD3', rx: 'PD2' } }],
  i2c: [{ id: 'twi0', arduinoName: 'Wire', signals: { sda: ['PD1'], scl: ['PD0'] }, defaults: { sda: 'PD1', scl: 'PD0' } }],
  spi: [
    {
      id: 'spi0',
      arduinoName: 'SPI',
      signals: { sck: ['PB1'], miso: ['PB3'], mosi: ['PB2'], ss: ['PB0'] },
      defaults: { sck: 'PB1', miso: 'PB3', mosi: 'PB2', ss: 'PB0' },
    },
  ],
  interruptPads: [],
  logicVolts: 5,
  notModelled: [
    'native USB beyond the CDC serial port — Keyboard and Mouse enumerate, but nothing reads their reports',
    'Timer4, so no PWM on the two pads it drives',
    'external and pin-change interrupts',
    'SPI, I2C and EEPROM persistence',
  ],
};

const RP2040: ProcessorProfile = {
  id: 'proc.rp2040',
  name: 'RP2040',
  architecture: 'rp2040',
  boardArchitecture: 'rp2040',
  vendor: 'Raspberry Pi',
  clockHz: 133_000_000,
  flashBytes: 2_093_056,
  ramBytes: 262_144,
  pads: Array.from({ length: 30 }, (_, i) => `GP${i}`),
  adcChannels: { GP26: 0, GP27: 1, GP28: 2, GP29: 3 },
  // Every GPIO can be a PWM output on this part.
  pwmPads: Array.from({ length: 30 }, (_, i) => `GP${i}`),
  uarts: [
    {
      id: 'uart0',
      arduinoName: 'Serial1',
      signals: { tx: ['GP0', 'GP12', 'GP16', 'GP28'], rx: ['GP1', 'GP13', 'GP17', 'GP29'] },
      defaults: { tx: 'GP0', rx: 'GP1' },
    },
    {
      id: 'uart1',
      arduinoName: 'Serial2',
      signals: { tx: ['GP4', 'GP8', 'GP20', 'GP24'], rx: ['GP5', 'GP9', 'GP21', 'GP25'] },
      defaults: { tx: 'GP4', rx: 'GP5' },
    },
  ],
  i2c: [
    {
      id: 'i2c0',
      arduinoName: 'Wire',
      signals: {
        sda: ['GP0', 'GP4', 'GP8', 'GP12', 'GP16', 'GP20', 'GP24', 'GP28'],
        scl: ['GP1', 'GP5', 'GP9', 'GP13', 'GP17', 'GP21', 'GP25', 'GP29'],
      },
      defaults: { sda: 'GP4', scl: 'GP5' },
    },
    {
      id: 'i2c1',
      arduinoName: 'Wire1',
      signals: {
        sda: ['GP2', 'GP6', 'GP10', 'GP14', 'GP18', 'GP22', 'GP26'],
        scl: ['GP3', 'GP7', 'GP11', 'GP15', 'GP19', 'GP23', 'GP27'],
      },
      defaults: { sda: 'GP2', scl: 'GP3' },
    },
  ],
  spi: [
    {
      id: 'spi0',
      arduinoName: 'SPI',
      signals: {
        sck: ['GP2', 'GP6', 'GP18', 'GP22'],
        mosi: ['GP3', 'GP7', 'GP19', 'GP23'],
        miso: ['GP0', 'GP4', 'GP16', 'GP20'],
        ss: ['GP1', 'GP5', 'GP17', 'GP21'],
      },
      defaults: { sck: 'GP18', mosi: 'GP19', miso: 'GP16', ss: 'GP17' },
    },
    {
      id: 'spi1',
      arduinoName: 'SPI1',
      signals: {
        sck: ['GP10', 'GP14', 'GP26'],
        mosi: ['GP11', 'GP15', 'GP27'],
        miso: ['GP8', 'GP12', 'GP24', 'GP28'],
        ss: ['GP9', 'GP13', 'GP25', 'GP29'],
      },
      defaults: { sck: 'GP10', mosi: 'GP11', miso: 'GP12', ss: 'GP13' },
    },
  ],
  interruptPads: Array.from({ length: 30 }, (_, i) => `GP${i}`),
  logicVolts: 3.3,
  notModelled: ['PIO', 'USB other than the CDC serial port (no HID, no mass storage)', 'the second core', 'Wi-Fi on W variants'],
};

const ESP32C3: ProcessorProfile = {
  id: 'proc.esp32c3',
  name: 'ESP32-C3',
  architecture: 'esp32c3',
  boardArchitecture: 'esp32',
  vendor: 'Espressif',
  clockHz: 160_000_000,
  flashBytes: 1_310_720,
  ramBytes: 327_680,
  pads: Array.from({ length: 22 }, (_, i) => `IO${i}`),
  // The ADC is not modelled on this runtime, so no pad claims a channel.
  adcChannels: {},
  pwmPads: [],
  uarts: [],
  i2c: [],
  spi: [],
  interruptPads: [],
  logicVolts: 3.3,
  notModelled: [
    'UART — the peripheral is not modelled, so Serial produces nothing',
    'ADC',
    'LEDC/PWM',
    'I2C and SPI controllers',
    'Wi-Fi and Bluetooth',
  ],
};

const ESP32C6: ProcessorProfile = {
  id: 'proc.esp32c6',
  name: 'ESP32-C6',
  architecture: 'esp32c6',
  boardArchitecture: 'esp32',
  vendor: 'Espressif',
  clockHz: 160_000_000,
  flashBytes: 1_310_720,
  ramBytes: 327_680,
  pads: Array.from({ length: 31 }, (_, i) => `IO${i}`),
  adcChannels: {},
  pwmPads: [],
  uarts: [],
  i2c: [],
  spi: [],
  interruptPads: [],
  logicVolts: 3.3,
  notModelled: [
    'UART — the peripheral is not modelled, so Serial produces nothing',
    'ADC',
    'LEDC/PWM',
    'I2C and SPI controllers',
    'Wi-Fi, Bluetooth, 802.15.4',
  ],
};

export const PROCESSOR_PROFILES: ProcessorProfile[] = [
  ATMEGA328P,
  ATMEGA2560,
  ATMEGA32U4,
  RP2040,
  ESP32C3,
  ESP32C6,
];

export function processorProfile(id: string): ProcessorProfile | undefined {
  return PROCESSOR_PROFILES.find((p) => p.id === id);
}

/** True when the pad exists on this chip. The check a pin mapping is refused by. */
export function hasPad(profile: ProcessorProfile, pad: string): boolean {
  return profile.pads.includes(pad);
}

/**
 * The controller and signal a pad can serve, across every bus on the chip.
 *
 * Used by the mapping editor to say "GP4 can be i2c0 SDA or uart1 TX" without
 * anyone writing that table out a second time.
 */
export function padRoles(profile: ProcessorProfile, pad: string): { controller: string; signal: string }[] {
  const out: { controller: string; signal: string }[] = [];
  for (const group of [profile.uarts, profile.i2c, profile.spi]) {
    for (const controller of group) {
      for (const [signal, pads] of Object.entries(controller.signals)) {
        if (pads.includes(pad)) out.push({ controller: controller.id, signal });
      }
    }
  }
  if (profile.adcChannels[pad] !== undefined) {
    out.push({ controller: 'adc', signal: `channel ${profile.adcChannels[pad]}` });
  }
  if (profile.pwmPads.includes(pad)) out.push({ controller: 'pwm', signal: 'output' });
  return out;
}
