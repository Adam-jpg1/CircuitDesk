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
import { TIMER_FUNCTION_E, TIMER_FUNCTION_F } from '../simulation/samd21/timers';

/**
 * Architectures a processor profile can belong to.
 *
 * Finer-grained than the board-level `BoardArchitecture`, deliberately: a board
 * is an "esp32" board, and the chip on it is specifically an ESP32-C3 or an
 * ESP32-C6, which are different machines with different memory maps. The coarse
 * family is carried alongside as `boardArchitecture` rather than derived by
 * string matching, so the two vocabularies stay explicitly linked.
 */
export type ProcessorArchitecture = 'avr' | 'rp2040' | 'esp32c3' | 'esp32c6' | 'samd21';

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
  notModelled: ['EEPROM across simulation restarts', 'watchdog reset', 'sleep modes', 'analog comparator'],
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
  uarts: [
    { id: 'usart0', arduinoName: 'Serial', signals: { tx: ['PE1'], rx: ['PE0'] }, defaults: { tx: 'PE1', rx: 'PE0' } },
    { id: 'usart1', arduinoName: 'Serial1', signals: { tx: ['PD3'], rx: ['PD2'] }, defaults: { tx: 'PD3', rx: 'PD2' } },
    { id: 'usart2', arduinoName: 'Serial2', signals: { tx: ['PH1'], rx: ['PH0'] }, defaults: { tx: 'PH1', rx: 'PH0' } },
    { id: 'usart3', arduinoName: 'Serial3', signals: { tx: ['PJ1'], rx: ['PJ0'] }, defaults: { tx: 'PJ1', rx: 'PJ0' } },
  ],
  i2c: [{ id: 'twi0', arduinoName: 'Wire', signals: { sda: ['PD1'], scl: ['PD0'] }, defaults: { sda: 'PD1', scl: 'PD0' } }],
  spi: [
    {
      id: 'spi0',
      arduinoName: 'SPI',
      signals: { sck: ['PB1'], miso: ['PB3'], mosi: ['PB2'], ss: ['PB0'] },
      defaults: { sck: 'PB1', miso: 'PB3', mosi: 'PB2', ss: 'PB0' },
    },
  ],
  // INT0-3 on PD0-3 and INT4-7 on PE4-7, with this chip's own vectors.
  interruptPads: ['PD0', 'PD1', 'PD2', 'PD3', 'PE4', 'PE5', 'PE6', 'PE7'],
  logicVolts: 5,
  notModelled: [
    'EEPROM across simulation restarts',
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
  // INT0-3 on PD0-3 and INT6 on PE6.
  interruptPads: ['PD0', 'PD1', 'PD2', 'PD3', 'PE6'],
  logicVolts: 5,
  notModelled: [
    'native USB beyond the CDC serial port — Keyboard and Mouse enumerate, but nothing reads their reports',
    'Timer4, so no PWM on the two pads it drives',
    'EEPROM across simulation restarts',
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
  notModelled: ['DMA feeding PIO', 'USB other than the CDC serial port (no HID, no mass storage)', 'the second core', 'Wi-Fi on W variants'],
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
  // ADC1 channels 0-4 on IO0-IO4, ADC2 channel 0 on IO5 (espRiscv/sarAdc.ts).
  adcChannels: { IO0: 0, IO1: 1, IO2: 2, IO3: 3, IO4: 4, IO5: 5 },
  // The GPIO matrix can route LEDC, I2C0, SPI2 and the GPIO interrupt to any
  // pad, so every pad carries them; the defaults are Arduino-ESP32's variant's.
  pwmPads: Array.from({ length: 22 }, (_, i) => `IO${i}`),
  uarts: [],
  i2c: [
    {
      id: 'i2c0',
      arduinoName: 'Wire',
      signals: { sda: Array.from({ length: 22 }, (_, i) => `IO${i}`), scl: Array.from({ length: 22 }, (_, i) => `IO${i}`) },
      defaults: { sda: 'IO8', scl: 'IO9' },
    },
  ],
  spi: [
    {
      id: 'spi2',
      arduinoName: 'SPI',
      signals: {
        sck: Array.from({ length: 22 }, (_, i) => `IO${i}`),
        mosi: Array.from({ length: 22 }, (_, i) => `IO${i}`),
        miso: Array.from({ length: 22 }, (_, i) => `IO${i}`),
      },
      defaults: { sck: 'IO4', mosi: 'IO6', miso: 'IO5' },
    },
  ],
  interruptPads: Array.from({ length: 22 }, (_, i) => `IO${i}`),
  logicVolts: 3.3,
  notModelled: ['Wi-Fi and Bluetooth', 'USB Serial/JTAG', 'LEDC hardware fades'],
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
  // ADC1 channels 0-6 on IO0-IO6 (espRiscv/sarAdc.ts).
  adcChannels: { IO0: 0, IO1: 1, IO2: 2, IO3: 3, IO4: 4, IO5: 5, IO6: 6 },
  // The GPIO matrix can route LEDC, I2C0, SPI2 and the GPIO interrupt to any
  // pad, so every pad carries them; the defaults are Arduino-ESP32's variant's.
  pwmPads: Array.from({ length: 31 }, (_, i) => `IO${i}`),
  uarts: [],
  i2c: [
    {
      id: 'i2c0',
      arduinoName: 'Wire',
      signals: { sda: Array.from({ length: 31 }, (_, i) => `IO${i}`), scl: Array.from({ length: 31 }, (_, i) => `IO${i}`) },
      defaults: { sda: 'IO23', scl: 'IO22' },
    },
  ],
  spi: [
    {
      id: 'spi2',
      arduinoName: 'SPI',
      signals: {
        sck: Array.from({ length: 31 }, (_, i) => `IO${i}`),
        mosi: Array.from({ length: 31 }, (_, i) => `IO${i}`),
        miso: Array.from({ length: 31 }, (_, i) => `IO${i}`),
      },
      defaults: { sck: 'IO21', mosi: 'IO19', miso: 'IO20' },
    },
  ],
  interruptPads: Array.from({ length: 31 }, (_, i) => `IO${i}`),
  logicVolts: 3.3,
  notModelled: ['Wi-Fi, Bluetooth, 802.15.4', 'USB Serial/JTAG', 'LEDC hardware fades'],
};

/**
 * The ATSAMD21 (G18 on the Feather M0, E18 on the QT Py M0).
 *
 * The bus tables are empty on purpose. A SERCOM can put a UART, I2C or SPI on
 * many pad combinations; the runtime follows whichever the firmware muxes
 * (src/simulation/samd21/sercomPads.ts), and a board's own pin capabilities
 * say which pins its Wire, SPI and Serial1 use. A table here would claim every
 * combination as a board-independent fact, which validation would then approve.
 */
const SAMD21: ProcessorProfile = {
  id: 'proc.samd21',
  name: 'ATSAMD21 (Cortex-M0+)',
  architecture: 'samd21',
  boardArchitecture: 'samd',
  vendor: 'Microchip',
  clockHz: 48_000_000,
  flashBytes: 262_144,
  ramBytes: 32_768,
  pads: [
    ...Array.from({ length: 32 }, (_, i) => `PA${String(i).padStart(2, '0')}`),
    ...Array.from({ length: 32 }, (_, i) => `PB${String(i).padStart(2, '0')}`),
  ],
  // AIN<n> behind each pad, from the datasheet's I/O multiplexing table.
  adcChannels: {
    PA02: 0, PA03: 1, PB08: 2, PB09: 3, PA04: 4, PA05: 5, PA06: 6, PA07: 7,
    PB00: 8, PB01: 9, PB02: 10, PB03: 11, PB04: 12, PB05: 13, PB06: 14, PB07: 15,
    PA08: 16, PA09: 17, PA10: 18, PA11: 19,
  },
  // Every pad a TCC or TC can drive (peripheral function E or F).
  pwmPads: [...new Set([...Object.keys(TIMER_FUNCTION_E), ...Object.keys(TIMER_FUNCTION_F)].map(Number))]
    .sort((a, b) => a - b)
    .map((pad) => `P${pad < 32 ? 'A' : 'B'}${String(pad % 32).padStart(2, '0')}`),
  uarts: [],
  i2c: [],
  spi: [],
  interruptPads: [],
  logicVolts: 3.3,
  notModelled: [
    'timer modes other than normal PWM, so Servo and tone() do nothing',
    'SERCOM I2C and SPI beyond the bus behind Wire and SPI, and any UART beyond Serial1',
    'I2C slave mode, SPI slave mode, DMA',
    'external interrupts (EIC), DMA, the DAC, the RTC and sleep modes',
    'USB other than the CDC serial port',
  ],
};

export const PROCESSOR_PROFILES: ProcessorProfile[] = [
  ATMEGA328P,
  ATMEGA2560,
  ATMEGA32U4,
  RP2040,
  ESP32C3,
  ESP32C6,
  SAMD21,
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
