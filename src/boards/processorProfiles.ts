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
export type ProcessorArchitecture = 'avr' | 'rp2040' | 'xtensa-esp32' | 'esp32c3' | 'esp32c6' | 'samd21' | 'sam3x' | 'stm32f4' | 'ra4m1' | 'nrf52' | 'imxrt' | 'bcm';

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
  // Timer0/1/3 drive the first five; Timer4 drives PC7 (OC4A) and PD7 (OC4D).
  pwmPads: ['PD0', 'PC6', 'PB5', 'PB6', 'PB7', 'PC7', 'PD7'],
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
    'Timer4\'s OC4B, complementary outputs, dead time and PLL clock (OC4A and OC4D, which analogWrite uses, are modelled)',
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

/**
 * The ESP32's bonded GPIOs. 6-11 carry the module's flash and 20, 24 and
 * 28-31 are not bonded out, so none of those is offered; 34-39 are input-only.
 */
export const ESP32_GPIO_PADS = [0, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 37, 38, 39].map((n) => `GPIO${n}`);
const ESP32_OUTPUT_PADS = ESP32_GPIO_PADS.filter((p) => Number(p.slice(4)) < 34);

const ESP32: ProcessorProfile = {
  id: 'proc.esp32',
  name: 'ESP32 (Xtensa LX6, dual core)',
  architecture: 'xtensa-esp32',
  boardArchitecture: 'esp32',
  vendor: 'Espressif',
  clockHz: 240_000_000,
  flashBytes: 1_310_720,
  ramBytes: 327_680,
  pads: ESP32_GPIO_PADS,
  // The runner numbers an ADC input by its GPIO (esp32/adc.ts): ADC1 on 32-39, ADC2 on 0, 2, 4, 12-15, 25-27.
  adcChannels: Object.fromEntries([36, 37, 38, 39, 32, 33, 34, 35, 4, 0, 2, 15, 13, 12, 14, 27, 25, 26].map((n) => [`GPIO${n}`, n])),
  // The GPIO matrix carries LEDC, both I2C controllers and both SPI masters to any output pad.
  pwmPads: ESP32_OUTPUT_PADS,
  uarts: [],
  i2c: [
    { id: 'i2c0', arduinoName: 'Wire', signals: { sda: ESP32_OUTPUT_PADS, scl: ESP32_OUTPUT_PADS }, defaults: { sda: 'GPIO21', scl: 'GPIO22' } },
  ],
  spi: [
    {
      id: 'vspi',
      arduinoName: 'SPI',
      signals: { sck: ESP32_OUTPUT_PADS, mosi: ESP32_OUTPUT_PADS, miso: ESP32_GPIO_PADS },
      defaults: { sck: 'GPIO18', mosi: 'GPIO23', miso: 'GPIO19' },
    },
  ],
  interruptPads: ESP32_GPIO_PADS,
  logicVolts: 3.3,
  notModelled: [
    'Wi-Fi and Bluetooth',
    'touch sensing, the DACs and the hall sensor',
    'the ADC\'s non-linearity and noise (conversions are ideal)',
    'LEDC fades, RMT, PCNT, I2S and the motor PWM',
    'deep sleep',
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

const SAM3X8E: ProcessorProfile = {
  id: 'proc.sam3x8e',
  name: 'AT91SAM3X8E (Cortex-M3)',
  architecture: 'sam3x',
  boardArchitecture: 'sam',
  vendor: 'Microchip',
  clockHz: 84_000_000,
  flashBytes: 524_288,
  ramBytes: 98_304,
  pads: ['A', 'B', 'C', 'D'].flatMap((port) => Array.from({ length: 32 }, (_, i) => `P${port}${i}`)),
  adcChannels: {
    PA2: 0, PA3: 1, PA4: 2, PA6: 3, PA22: 4, PA23: 5, PA24: 6, PA16: 7,
    PB12: 8, PB13: 9, PB17: 10, PB18: 11, PB19: 12, PB20: 13, PB21: 14,
  },
  // TIOA/TIOB and PWML outputs the Due's analogWrite reaches.
  pwmPads: ['PB25', 'PC28', 'PC26', 'PC25', 'PC24', 'PC23', 'PC22', 'PC21', 'PC29', 'PD7', 'PD8', 'PB27'],
  uarts: [
    { id: 'uart', arduinoName: 'Serial', signals: { tx: ['PA9'], rx: ['PA8'] }, defaults: { tx: 'PA9', rx: 'PA8' } },
    { id: 'usart0', arduinoName: 'Serial1', signals: { tx: ['PA11'], rx: ['PA10'] }, defaults: { tx: 'PA11', rx: 'PA10' } },
    { id: 'usart1', arduinoName: 'Serial2', signals: { tx: ['PA13'], rx: ['PA12'] }, defaults: { tx: 'PA13', rx: 'PA12' } },
    { id: 'usart3', arduinoName: 'Serial3', signals: { tx: ['PD4'], rx: ['PD5'] }, defaults: { tx: 'PD4', rx: 'PD5' } },
  ],
  i2c: [
    { id: 'twi1', arduinoName: 'Wire', signals: { sda: ['PB12'], scl: ['PB13'] }, defaults: { sda: 'PB12', scl: 'PB13' } },
    { id: 'twi0', arduinoName: 'Wire1', signals: { sda: ['PA17'], scl: ['PA18'] }, defaults: { sda: 'PA17', scl: 'PA18' } },
  ],
  spi: [
    { id: 'spi0', arduinoName: 'SPI', signals: { sck: ['PA27'], mosi: ['PA26'], miso: ['PA25'] }, defaults: { sck: 'PA27', mosi: 'PA26', miso: 'PA25' } },
  ],
  interruptPads: ['A', 'B', 'C', 'D'].flatMap((port) => Array.from({ length: 32 }, (_, i) => `P${port}${i}`)),
  logicVolts: 3.3,
  notModelled: [
    'the native USB port (SerialUSB), CAN, EMAC, DMA and the HSMCI',
    "the DAC's analog output onto the canvas (conversion data is modelled)",
    'timer capture mode and the quadrature decoder',
    'sleep and backup modes, the RTC and RTT',
  ],
};

const nrfPads = (p1: number) => [
  ...Array.from({ length: 32 }, (_, i) => `P0.${String(i).padStart(2, '0')}`),
  ...Array.from({ length: p1 }, (_, i) => `P1.${String(i).padStart(2, '0')}`),
];

const NRF52833: ProcessorProfile = {
  id: 'proc.nrf52833',
  name: 'Nordic nRF52833 (Cortex-M4F)',
  architecture: 'nrf52',
  boardArchitecture: 'nrf52',
  vendor: 'Nordic Semiconductor',
  clockHz: 64_000_000,
  flashBytes: 524_288,
  ramBytes: 131_072,
  pads: nrfPads(10),
  adcChannels: { 'P0.02': 0, 'P0.03': 1, 'P0.04': 2, 'P0.05': 3, 'P0.28': 4, 'P0.29': 5, 'P0.30': 6, 'P0.31': 7 },
  // The PWM peripherals can drive any pad.
  pwmPads: nrfPads(10),
  uarts: [{ id: 'uart0', arduinoName: 'Serial', signals: { tx: nrfPads(10), rx: nrfPads(10) }, defaults: { tx: 'P0.06', rx: 'P1.08' } }],
  i2c: [{ id: 'twi1', arduinoName: 'Wire', signals: { sda: nrfPads(10), scl: nrfPads(10) }, defaults: { sda: 'P1.00', scl: 'P0.26' } }],
  spi: [{ id: 'spi2', arduinoName: 'SPI', signals: { sck: nrfPads(10), mosi: nrfPads(10), miso: nrfPads(10) }, defaults: { sck: 'P0.17', mosi: 'P0.13', miso: 'P0.01' } }],
  interruptPads: nrfPads(10),
  logicVolts: 3.3,
  notModelled: [
    'the 2.4 GHz radio (Bluetooth), NFC, I2S, PDM and the crypto blocks',
    'PPI channels linking events to tasks across peripherals',
    'low-power modes beyond waiting for an interrupt',
  ],
};

const NRF52840: ProcessorProfile = {
  ...NRF52833,
  id: 'proc.nrf52840',
  name: 'Nordic nRF52840 (Cortex-M4F)',
  flashBytes: 1_048_576,
  ramBytes: 262_144,
  pads: nrfPads(16),
  pwmPads: nrfPads(16),
  // As the Arduino mbed core's Nano 33 BLE variant assigns them.
  uarts: [{ id: 'uarte0', arduinoName: 'Serial1', signals: { tx: nrfPads(16), rx: nrfPads(16) }, defaults: { tx: 'P1.03', rx: 'P1.10' } }],
  i2c: [{ id: 'twim0', arduinoName: 'Wire', signals: { sda: nrfPads(16), scl: nrfPads(16) }, defaults: { sda: 'P0.31', scl: 'P0.02' } }],
  spi: [{ id: 'spim2', arduinoName: 'SPI', signals: { sck: nrfPads(16), mosi: nrfPads(16), miso: nrfPads(16) }, defaults: { sck: 'P0.13', mosi: 'P1.01', miso: 'P1.08' } }],
  interruptPads: nrfPads(16),
  notModelled: [
    ...NRF52833.notModelled,
    'USB beyond a CDC serial port: suspend, resume and isochronous endpoints',
  ],
};

// The pads the Teensy 4.1 brings out, from its core's core_pins.h.
const teensyPads = [
  'GPIO1_02', 'GPIO1_03', 'GPIO1_12', 'GPIO1_13', 'GPIO1_16', 'GPIO1_17', 'GPIO1_18', 'GPIO1_19', 'GPIO1_20', 'GPIO1_21',
  'GPIO1_22', 'GPIO1_23', 'GPIO1_24', 'GPIO1_25', 'GPIO1_26', 'GPIO1_27', 'GPIO1_28', 'GPIO1_29', 'GPIO1_30', 'GPIO1_31',
  'GPIO2_00', 'GPIO2_01', 'GPIO2_02', 'GPIO2_03', 'GPIO2_10', 'GPIO2_11', 'GPIO2_12', 'GPIO2_16', 'GPIO2_17', 'GPIO2_18',
  'GPIO2_19', 'GPIO2_28', 'GPIO2_29', 'GPIO3_18', 'GPIO3_22', 'GPIO3_23', 'GPIO4_04', 'GPIO4_05', 'GPIO4_06', 'GPIO4_07',
  'GPIO4_08', 'GPIO4_31',
];

const IMXRT1062: ProcessorProfile = {
  id: 'proc.imxrt1062',
  name: 'NXP i.MX RT1062 (Cortex-M7)',
  architecture: 'imxrt',
  boardArchitecture: 'imxrt',
  vendor: 'NXP',
  clockHz: 60_000_000,
  flashBytes: 8_126_464,
  ramBytes: 1_048_576,
  pads: teensyPads,
  // Every ADC input is a GPIO1 pad; the channel is its bit.
  adcChannels: Object.fromEntries(
    ['12', '13', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31'].map((b) => [`GPIO1_${b}`, Number(b)]),
  ),
  pwmPads: [
    'GPIO1_02', 'GPIO1_03', 'GPIO1_12', 'GPIO1_13', 'GPIO1_16', 'GPIO1_17', 'GPIO1_18', 'GPIO1_19', 'GPIO1_24', 'GPIO1_25',
    'GPIO2_00', 'GPIO2_01', 'GPIO2_02', 'GPIO2_03', 'GPIO2_10', 'GPIO2_11', 'GPIO2_16', 'GPIO2_17', 'GPIO2_18', 'GPIO2_19',
    'GPIO3_18', 'GPIO4_04', 'GPIO4_05', 'GPIO4_06', 'GPIO4_07', 'GPIO4_08', 'GPIO4_31',
  ],
  uarts: [{ id: 'lpuart6', arduinoName: 'Serial1', signals: { tx: ['GPIO1_02'], rx: ['GPIO1_03'] }, defaults: { tx: 'GPIO1_02', rx: 'GPIO1_03' } }],
  i2c: [{ id: 'lpi2c1', arduinoName: 'Wire', signals: { sda: ['GPIO1_17'], scl: ['GPIO1_16'] }, defaults: { sda: 'GPIO1_17', scl: 'GPIO1_16' } }],
  spi: [{ id: 'lpspi4', arduinoName: 'SPI', signals: { sck: ['GPIO2_03'], mosi: ['GPIO2_02'], miso: ['GPIO2_01'] }, defaults: { sck: 'GPIO2_03', mosi: 'GPIO2_02', miso: 'GPIO2_01' } }],
  interruptPads: teensyPads,
  logicVolts: 3.3,
  notModelled: [
    'LPUART1-5/7/8, LPI2C2-4 and LPSPI1-3 (Serial2-8, Wire1/2, SPI1/2)',
    'PIT and GPT timers (IntervalTimer, tone), eDMA, FlexIO, ENET, uSDHC, the external PSRAM',
    'the EEPROM emulation in flash',
    'clock reconfiguration: the CPU runs at the speed the sketch was built for',
  ],
};

const piGpio = Array.from({ length: 28 }, (_, i) => `GPIO${i}`);

const RPI_GPIO: ProcessorProfile = {
  id: 'proc.rpi-gpio',
  name: 'Raspberry Pi GPIO header (BCM GPIO 0-27)',
  architecture: 'bcm',
  boardArchitecture: 'linux',
  vendor: 'Raspberry Pi',
  clockHz: 1_000_000_000,
  flashBytes: 0,
  ramBytes: 0,
  pads: piGpio,
  pwmPads: piGpio,
  uarts: [],
  i2c: [],
  spi: [],
  interruptPads: piGpio,
  logicVolts: 3.3,
  notModelled: [
    'Linux itself: the script runs in CircuitDesk\'s Python interpreter, not on an emulated Pi',
    'I2C, SPI and UART from Python (smbus, spidev, pyserial), hardware PWM, the camera, audio, networking and files',
  ],
};

const ra4m1Pads = [
  ...['P000', 'P001', 'P002', 'P003', 'P004', 'P010', 'P011', 'P012', 'P013', 'P014', 'P015'],
  ...Array.from({ length: 13 }, (_, i) => `P1${String(i).padStart(2, '0')}`),
  ...['P200', 'P201', 'P204', 'P205', 'P206', 'P212', 'P213'],
  ...['P300', 'P301', 'P302', 'P303', 'P304'],
  ...['P400', 'P401', 'P402', 'P407', 'P408', 'P409', 'P410', 'P411'],
  ...['P500', 'P501', 'P502'],
];

const RA4M1: ProcessorProfile = {
  id: 'proc.ra4m1',
  name: 'Renesas RA4M1 (R7FA4M1AB, Cortex-M4F)',
  architecture: 'ra4m1',
  boardArchitecture: 'renesas',
  vendor: 'Renesas',
  clockHz: 48_000_000,
  flashBytes: 262_144,
  ramBytes: 32_768,
  pads: ra4m1Pads,
  adcChannels: {
    P000: 0, P001: 1, P002: 2, P003: 3, P004: 4, P010: 5, P011: 6, P012: 7, P013: 8, P014: 9, P015: 10,
    P500: 16, P501: 17, P502: 18, P103: 19, P102: 20, P101: 21, P100: 22,
  },
  // GPT outputs, from the core's pinmux table.
  pwmPads: ['P100', 'P101', 'P102', 'P103', 'P104', 'P105', 'P106', 'P107', 'P108', 'P109', 'P110', 'P111', 'P112',
    'P300', 'P301', 'P302', 'P303', 'P304', 'P400', 'P401', 'P409', 'P408', 'P411', 'P410', 'P212', 'P213', 'P205', 'P204',
    'P500', 'P501', 'P502', 'P000', 'P001', 'P002', 'P003', 'P010', 'P011', 'P012', 'P013', 'P014'],
  uarts: [{ id: 'sci2', arduinoName: 'Serial1', signals: { tx: ['P302'], rx: ['P301'] }, defaults: { tx: 'P302', rx: 'P301' } }],
  i2c: [{ id: 'iic1', arduinoName: 'Wire', signals: { sda: ['P101'], scl: ['P100'] }, defaults: { sda: 'P101', scl: 'P100' } }],
  spi: [{ id: 'spi1', arduinoName: 'SPI', signals: { sck: ['P111'], mosi: ['P109'], miso: ['P110'] }, defaults: { sck: 'P111', mosi: 'P109', miso: 'P110' } }],
  interruptPads: ['P400', 'P401', 'P402', 'P213', 'P212', 'P411', 'P410', 'P409', 'P408', 'P206', 'P205', 'P304', 'P302', 'P301',
    'P110', 'P111', 'P105', 'P104', 'P101', 'P100', 'P501', 'P502', 'P015', 'P011', 'P004', 'P002', 'P001', 'P000'],
  logicVolts: 5,
  notModelled: [
    'DMA and DTC transfers, CAN, the capacitive touch unit (CTSU), the RTC and the watchdogs',
    "the DAC's analog output onto the canvas (its conversion register is modelled)",
    'the clock tree: the CPU runs at the 48 MHz the core sets up from the start',
    'low-power modes beyond waiting for an interrupt',
  ],
};

const stm32Pads = ['A', 'B', 'C', 'D', 'H'].flatMap((port) =>
  Array.from({ length: port === 'D' ? 3 : port === 'H' ? 2 : 16 }, (_, i) => `P${port}${i}`),
);

const STM32F401RE: ProcessorProfile = {
  id: 'proc.stm32f401re',
  name: 'STM32F401RE (Cortex-M4F)',
  architecture: 'stm32f4',
  boardArchitecture: 'stm32',
  vendor: 'STMicroelectronics',
  clockHz: 84_000_000,
  flashBytes: 524_288,
  ramBytes: 98_304,
  pads: stm32Pads,
  adcChannels: {
    PA0: 0, PA1: 1, PA2: 2, PA3: 3, PA4: 4, PA5: 5, PA6: 6, PA7: 7,
    PB0: 8, PB1: 9, PC0: 10, PC1: 11, PC2: 12, PC3: 13, PC4: 14, PC5: 15,
  },
  // Timer channel outputs, from the core's PeripheralPins.c.
  pwmPads: ['PA0', 'PA1', 'PA2', 'PA3', 'PA5', 'PA6', 'PA7', 'PA8', 'PA9', 'PA10', 'PA11', 'PA15', 'PB0', 'PB1', 'PB3',
    'PB4', 'PB5', 'PB6', 'PB7', 'PB8', 'PB9', 'PB10', 'PB13', 'PB14', 'PB15', 'PC6', 'PC7', 'PC8', 'PC9'],
  uarts: [
    { id: 'usart2', arduinoName: 'Serial', signals: { tx: ['PA2'], rx: ['PA3'] }, defaults: { tx: 'PA2', rx: 'PA3' } },
    { id: 'usart1', arduinoName: 'Serial1', signals: { tx: ['PA9', 'PB6'], rx: ['PA10', 'PB7'] }, defaults: { tx: 'PA9', rx: 'PA10' } },
    { id: 'usart6', arduinoName: 'Serial6', signals: { tx: ['PA11', 'PC6'], rx: ['PA12', 'PC7'] }, defaults: { tx: 'PA11', rx: 'PA12' } },
  ],
  i2c: [
    { id: 'i2c1', arduinoName: 'Wire', signals: { sda: ['PB9', 'PB7'], scl: ['PB8', 'PB6'] }, defaults: { sda: 'PB9', scl: 'PB8' } },
    { id: 'i2c2', signals: { sda: ['PB3'], scl: ['PB10'] }, defaults: { sda: 'PB3', scl: 'PB10' } },
    { id: 'i2c3', signals: { sda: ['PB4', 'PC9'], scl: ['PA8'] }, defaults: { sda: 'PC9', scl: 'PA8' } },
  ],
  spi: [
    { id: 'spi1', arduinoName: 'SPI', signals: { sck: ['PA5', 'PB3'], mosi: ['PA7', 'PB5'], miso: ['PA6', 'PB4'] }, defaults: { sck: 'PA5', mosi: 'PA7', miso: 'PA6' } },
    { id: 'spi2', signals: { sck: ['PB10', 'PB13'], mosi: ['PB15', 'PC3'], miso: ['PB14', 'PC2'] }, defaults: { sck: 'PB13', mosi: 'PB15', miso: 'PB14' } },
  ],
  // EXTI takes one pad of each number, from any port.
  interruptPads: stm32Pads,
  logicVolts: 3.3,
  notModelled: [
    'DMA, the RTC, the watchdogs, SDIO and the USB OTG port',
    'timer input capture, encoder and one-pulse modes, and timers counting down or centre-aligned',
    'ADC scan, injected and DMA conversions',
    'the clock tree: the CPU runs at 84 MHz from reset, the speed the Nucleo variant configures',
    'sleep and stop modes beyond waiting for an interrupt',
  ],
};

export const PROCESSOR_PROFILES: ProcessorProfile[] = [
  ATMEGA328P,
  ATMEGA2560,
  ATMEGA32U4,
  RP2040,
  ESP32C3,
  ESP32C6,
  ESP32,
  SAMD21,
  SAM3X8E,
  STM32F401RE,
  RA4M1,
  NRF52833,
  NRF52840,
  IMXRT1062,
  RPI_GPIO,
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
