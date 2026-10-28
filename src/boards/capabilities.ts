// Canonical per-board capability table — the single source of truth for
// architecture, aliases, compiler targets and simulation support. Badges are
// DERIVED from this data (see project/support.ts); they are never hand-edited.
//
// Honesty rules enforced here and by tests/boards.profile.mts:
//  - simulation.supported=true only for boards with a registered simulator
//    adapter, a board-specific pin map, and passing runtime tests.
//  - compiler.supported=true only for boards on the backend's strict
//    allowlist. Core availability is reported live by
//    /api/compiler/capabilities; a missing core produces a clear error,
//    never a silent fallback to another board.

import type { BoardArchitecture, BoardCompilerInfo, BoardSimulationInfo, PinCapability } from '../types';

/**
 * Used where a board is an open or widely-cloned design rather than one
 * company's product. Saying this is more accurate than picking a vendor, and
 * it keeps CircuitDesk from implying a relationship that does not exist.
 */
export const MULTI_VENDOR_DESIGN = 'Various manufacturers';

export interface BoardCapabilityEntry {
  architecture: BoardArchitecture;
  /**
   * The chip, the toolchain and the emulator, named separately.
   *
   * A native board names the same three profiles a custom board does, which is
   * what makes them one code path: the adapter registry matches on the runtime
   * profile and the processor, not on a list of board ids it was told about.
   * Absent for boards CircuitDesk neither compiles nor runs.
   */
  processorProfileId?: string;
  compileProfileId?: string;
  runtimeProfileId?: string;
  /**
   * The id the COMPILER SERVICE knows this board by, when it is not this board.
   *
   * The service keeps a strict allowlist and refuses ids it has never heard
   * of. Most boards are on it under their own name and leave this unset. A
   * board that is a different product carrying a chip we already build for —
   * a XIAO RP2040, a Pro Mini — names the target its pipeline uses instead,
   * and the artifact is still stamped with this board.
   *
   * Deliberately per-board and explicit rather than derived from the compile
   * profile: the Uno and the Nano share a profile whose target is the Uno, and
   * a rule that preferred the profile would quietly build Nano firmware for an
   * Uno — wrong FQBN, and two pins that do not exist there.
   */
  serverTargetId?: string;
  /**
   * Physical pin id -> processor pad, where a board labels its pins something
   * other than the pad behind them. A XIAO's D0 is GP26.
   */
  padMap?: Record<string, string>;
  aliases: string[];
  compiler?: BoardCompilerInfo;
  simulation?: BoardSimulationInfo;
  /** Arduino pin number of A0 (AVR boards with Arduino numbering). */
  analogPinBase?: number;
  /** Chip variant discriminator (e.g. esp32 vs esp32s3 vs esp32c3). */
  variant?: string;
  /** Add capabilities to pins whose id matches (e.g. RP2040: PWM on every GP pin). */
  extraPinCaps?: { pattern: RegExp; add: PinCapability[] }[];
  /** Honest statement of the biggest current limitation, surfaced in tooltips. */
  limitation?: string;
  /**
   * Who actually makes this board.
   *
   * Distinct from `family`, which groups by chip. Several popular boards are
   * open designs produced by many vendors, and naming one of them as the maker
   * would be a claim CircuitDesk cannot support — those carry
   * MULTI_VENDOR_DESIGN instead of a company.
   */
  manufacturer?: string;
  /** Why an entry is generic, when it is. Shown so the ambiguity is visible. */
  identityNote?: string;
}

/** The APIs every AVR board runs, each measured on real compiled firmware. */
const AVR_COMMON_APIS = [
  'external interrupts',
  'pin-change interrupts',
  'Wire (I2C master)',
  'SPI (master)',
  'Servo and tone()',
  'EEPROM (kept across the reset button; erased when the simulation starts)',
];

const AVR_SIM_APIS = [
  'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogWrite (PWM)',
  'delay/millis/micros', 'Serial (UART both directions)', 'timers', ...AVR_COMMON_APIS,
];

/**
 * The Mega runs the same list on its own wiring: INT0-INT7 and PCINT0-2 at
 * the ATmega2560's vectors (tests/boards.eepromInterrupts.mts), not the 328P's.
 */
const MEGA_SIM_APIS = AVR_SIM_APIS;

/**
 * The Leonardo's list is written out rather than filtered, because two entries
 * differ in meaning: "Serial" on this board is native USB CDC, served by the
 * 32U4 USB controller model (tests/leonardo.usbSerial.mts) rather than by a
 * UART, and PWM exists on five of the seven physical PWM pins because Timer4
 * is not modeled.
 */
const LEONARDO_SIM_APIS = [
  'pinMode', 'digitalWrite', 'digitalRead', 'analogRead (A0-A5)',
  'analogWrite (PWM on D3, D5, D9, D10, D11)', 'delay/millis/micros',
  'Serial (native USB CDC, to the serial monitor, both directions; while (!Serial) returns once connected)',
  'Serial1 (hardware UART on D0/D1, both directions)', 'timers', ...AVR_COMMON_APIS,
];
const AVR_SIM_PERIPHERALS = ['GPIO ports', 'Timer0/1/2', 'USART0', 'ADC'];

/**
 * The RP2040 lists are written from what the integration tests actually
 * exercise on real compiled firmware, not from what the chip can do.
 *
 * Deliberately absent, because nothing here tests them: Wi-Fi, USB other than
 * the CDC serial port (tests/rp2040.usbSerial.mts) and the second core. PIO is
 * listed for what tests/rp2040.pio.mts proves on it: Servo and tone().
 *
 * Floating point, and with it `analogWrite()` (which computes its PWM divisor
 * in floating point), goes through tables in the boot ROM. Raspberry Pi's
 * routines behind them are not shipped (see THIRD_PARTY_NOTICES.md); the
 * simulator's ROM provides the tables with independent implementations of
 * each documented slot, checked value by value in tests/rp2040.integration.mts.
 */
/**
 * What a sketch on this board can actually rely on.
 *
 * The list is deliberately short. Everything on it is exercised by a test
 * against real compiled firmware; anything absent is absent because it is not
 * modelled, not because it was forgotten.
 */
const ESP32C3_SIM_APIS = [
  'pinMode (INPUT, OUTPUT, INPUT_PULLUP, INPUT_PULLDOWN)',
  'digitalWrite',
  'digitalRead',
  'delay/millis/micros',
  'setup() and repeated loop()',
  'Serial (UART0 through the ESP-IDF driver, both directions, at the baud rate set)',
  'analogRead (12-bit, on IO0-IO5)',
];

const ESP32C3_SIM_PERIPHERALS = [
  'GPIO with the IO MUX and GPIO matrix',
  'System timer, which drives the FreeRTOS tick',
  'Interrupt matrix and CPU interrupt controller',
  'SPI flash and the flash MMU',
  'UART0 — FIFOs, the TX-empty, RX-full, RX-timeout and TX-done interrupts, baud from the programmed divider',
  'SAR ADC one-shot conversions, at the attenuation the sketch sets',
];

/**
 * Said plainly, because the gap between what this runs and what an ESP32-C3
 * does is large and a student should not have to discover it by being wrong.
 */
const ESP32C3_LIMITATION =
  'Real RISC-V execution of the compiled application image: ESP-IDF startup, FreeRTOS, setup() and loop(), GPIO, ' +
  'Serial on UART0 and analogRead(). Wi-Fi, Bluetooth LE, USB Serial/JTAG, PWM, I2C and SPI to devices are not simulated — ' +
  'sketches using them compile and run, but those peripherals do nothing.';

/**
 * The ESP32-C6's list, which is the C3's minus the pull-down.
 *
 * Written separately rather than shared, because the two parts are not the same
 * runtime and a list that drifted into claiming one chip's support for the
 * other is exactly the kind of quiet inaccuracy these lists exist to prevent.
 */
const ESP32C6_SIM_APIS = [
  'pinMode (INPUT, OUTPUT, INPUT_PULLUP, INPUT_PULLDOWN)',
  'digitalWrite',
  'digitalRead',
  'delay/millis/micros',
  'setup() and repeated loop()',
  'Serial (UART0 through the ESP-IDF driver, both directions, at the baud rate set)',
  'analogRead (12-bit, on IO0-IO6)',
];

const ESP32C6_SIM_PERIPHERALS = [
  'GPIO with the IO MUX and GPIO matrix',
  'System timer, which drives the FreeRTOS tick',
  'Interrupt matrix and the RISC-V PLIC that delivers to the CPU',
  'Low-power timer, which is where the runtime reads the time',
  'SPI flash and the flash MMU',
  'ROM watchdog, heap, system-timer and flash drivers this part boots on',
  'UART0 — FIFOs, the TX-empty, RX-full, RX-timeout and TX-done interrupts, baud from the programmed divider',
  'SAR ADC one-shot conversions, at the attenuation the sketch sets',
];

/**
 * Said plainly. Everything the C6 does not do is listed, because a sketch that
 * uses any of it will compile, run, and quietly do nothing.
 */
const ESP32C6_LIMITATION =
  'Real RISC-V execution of the compiled application image: ESP-IDF startup, FreeRTOS, setup() and loop(), GPIO ' +
  'with its pulls, Serial on UART0 and analogRead(). Wi-Fi, Bluetooth LE, Zigbee/802.15.4, Thread, USB Serial/JTAG, PWM, ' +
  'I2C and SPI to devices are not simulated — sketches using them compile and run, but those peripherals do nothing.';

const SAMD21_SIM_APIS = [
  'pinMode (INPUT, OUTPUT, INPUT_PULLUP, INPUT_PULLDOWN)',
  'digitalWrite',
  'digitalRead',
  'analogRead (10-bit, 3.3 V reference)',
  'analogWrite (PWM on the pins the board gives a TCC or TC, at ~732 Hz)',
  'Wire (I2C master, on the board\'s SDA/SCL)',
  'SPI (master, on the board\'s SCK/MOSI/MISO)',
  'delay/millis/micros',
  'Serial (native USB CDC, to the serial monitor, both directions; while (!Serial) returns once connected)',
  'Serial1 (the hardware UART, both directions — a part wired to RX/TX reaches it)',
  'Servo (544-2400 µs pulses every 20 ms) and tone(), on the timers\' interrupts',
  'external interrupts (attachInterrupt)',
];

const SAMD21_SIM_PERIPHERALS = [
  'PORT, with pulls and the single-cycle IOBUS',
  'SysTick, which millis() counts',
  'ADC, single conversions',
  'TCC0-2 and TC3-7 counting on the simulated clock: normal PWM and match frequency, compare and overflow interrupts',
  'EIC, the external interrupt controller, on every EXTINT line',
  'SERCOM I2C master and SPI master, on the shared device buses',
  'USB device controller — the CDC serial port, enumerated by a modelled host',
  'the SERCOM USART behind Serial1 (SERCOM0 on the Adafruit boards, SERCOM4 on the XIAO), with its receive interrupt',
];

const SAMD21_LIMITATION =
  'Real SAMD21 firmware on a Cortex-M0+ core: startup, setup() and loop(), GPIO, analogRead, analogWrite (PWM), Wire, SPI, ' +
  'Servo, tone(), attachInterrupt(), Serial over native USB and Serial1 on the UART pins. ' +
  'DMA, the DAC and sleep are not simulated — sketches using them compile and run, but those peripherals do nothing. ' +
  'The SAMD21 has no EEPROM, so the EEPROM library does not exist for these boards; FlashStorage is the usual stand-in.';

const samd21Compiler = (fqbn: string): BoardCompilerInfo => ({
  provider: 'arduino-cli',
  fqbn,
  requiredCore: 'adafruit:samd',
  supported: true,
  note: `Built with Adafruit's SAMD core (${fqbn}), linked above the board's 8 KB bootloader.`,
});

const RP2040_SIM_APIS = [
  'pinMode (INPUT, OUTPUT, INPUT_PULLUP)',
  'digitalWrite',
  'digitalRead',
  'analogRead (GP26/GP27/GP28, 0-3.3 V, 12-bit)',
  'delay/millis/micros',
  'Serial (USB CDC, to the serial monitor, both directions)',
  'Serial1 (hardware UART0 on GP0/GP1)',
  'Wire (hardware I2C, including repeated START and NACK)',
  'SPI (hardware SPI, all four modes, MSB first)',
  'analogWrite (PWM duty on any GP pin)',
  'float and double arithmetic, including sin/cos/sqrt/exp/log',
  'Servo and tone() (PIO programs, on the simulated clock)',
];
const RP2040_SIM_PERIPHERALS = [
  'SIO and GPIO pads (GP0-GP28, including pad pull resistors)',
  'ADC channels 0-2',
  'UART0',
  'I2C0 and I2C1',
  'SPI0 and SPI1',
  'PWM slices',
  'PIO state machines, run on the simulated clock',
  'system timer',
  'clock tree (PLLs, clk_sys, clk_peri)',
];

/** Shared by both RP2040 boards, so the two texts cannot drift apart. */
const RP2040_LIMITATION =
  'The RP2040 CPU, GPIO, ADC, PWM, UART0, I2C, SPI and the USB serial port are simulated by executing the real ' +
  'compiled firmware, and the I2C and SPI device models are the same ones the AVR boards drive. ' +
  'Buses follow whichever pins the firmware muxes, defaulting to the Arduino-Pico core\'s GP4/GP5 for Wire ' +
  'and GP18/GP19/GP16 for SPI. ' +
  'Floating point runs on CircuitDesk\'s own implementation of the boot ROM\'s float tables, not Raspberry Pi\'s. ' +
  'PIO runs on the simulated clock, so Servo and tone() work. ' +
  'EEPROM writes go to the simulated flash and survive the reset button. ' +
  'The second core and PIO-fed DMA are not simulated.';

const avrCliCompiler = (fqbn: string): BoardCompilerInfo => ({
  provider: 'arduino-cli',
  fqbn,
  requiredCore: 'arduino:avr',
  supported: true,
});

export const BOARD_CAPABILITIES: Record<string, BoardCapabilityEntry> = {
  // ---------------- AVR (genuinely simulated where tested) ----------------
  'board.arduino-uno': {
    processorProfileId: 'proc.atmega328p',
    compileProfileId: 'compile.avr-arduino',
    runtimeProfileId: 'runtime.avr8js-328p',
    manufacturer: 'Arduino',
    architecture: 'avr',
    aliases: ['arduino-uno', 'uno', 'Arduino UNO R3', 'arduino:avr:uno'],
    compiler: avrCliCompiler('arduino:avr:uno'),
    simulation: {
      engine: 'avr8js',
      supported: true,
      supportedApis: AVR_SIM_APIS,
      supportedPeripherals: AVR_SIM_PERIPHERALS,
    },
    analogPinBase: 14,
  },
  'board.arduino-nano': {
    processorProfileId: 'proc.atmega328p',
    compileProfileId: 'compile.avr-arduino',
    runtimeProfileId: 'runtime.avr8js-328p',
    manufacturer: 'Arduino',
    architecture: 'avr',
    aliases: ['arduino-nano', 'nano', 'arduino:avr:nano'],
    compiler: avrCliCompiler('arduino:avr:nano'),
    simulation: {
      engine: 'avr8js',
      supported: true,
      supportedApis: AVR_SIM_APIS,
      supportedPeripherals: [...AVR_SIM_PERIPHERALS, 'A6/A7 ADC-only inputs'],
    },
    analogPinBase: 14,
    limitation: 'Same ATmega328P core as the Uno; A6/A7 are ADC-only, as on real hardware.',
  },
  'board.arduino-mega2560': {
    processorProfileId: 'proc.atmega2560',
    compileProfileId: 'compile.avr-arduino-mega',
    runtimeProfileId: 'runtime.avr8js-2560',
    manufacturer: 'Arduino',
    architecture: 'avr',
    aliases: ['arduino-mega', 'mega', 'mega2560', 'arduino:avr:mega'],
    compiler: avrCliCompiler('arduino:avr:mega'),
    simulation: {
      engine: 'avr8js',
      supported: true,
      supportedApis: MEGA_SIM_APIS,
      supportedPeripherals: [
        'GPIO ports A-L (D0-D53, A0-A15)',
        'Timer0/1/2 plus Mega-only Timer3/4/5 (PWM on pins 2-13 and 44-46)',
        'USART0 (Serial)',
        'ADC 16 channels incl. A8-A15 via MUX5',
      ],
    },
    analogPinBase: 54,
    limitation:
      'Runs its own ATmega2560 profile (8 KB SRAM at 0x200, Mega vector table, ports A-L) — never the Uno profile. ' +
      'attachInterrupt on pins 2, 3 and 18-21 and pin-change interrupts (PCINT0-2) use the ATmega2560\'s own vectors. ' +
      'Serial1-Serial3 (USART1-3) are not emulated; only Serial (USART0) is.',
  },
  'board.arduino-leonardo': {
    processorProfileId: 'proc.atmega32u4',
    compileProfileId: 'compile.avr-arduino-32u4',
    runtimeProfileId: 'runtime.avr8js-32u4',
    manufacturer: 'Arduino',
    architecture: 'avr',
    aliases: ['arduino-leonardo', 'leonardo', 'arduino:avr:leonardo'],
    compiler: avrCliCompiler('arduino:avr:leonardo'),
    simulation: {
      engine: 'avr8js',
      supported: true,
      supportedApis: LEONARDO_SIM_APIS,
      supportedPeripherals: [
        'GPIO ports B/C/D/E/F (D0-D17, A0-A5)',
        'Timer0, Timer1 and Timer3 (PWM on D3, D5, D9, D10, D11)',
        'USART1 — Arduino Serial1 on D0/D1',
        'USB device controller — the CDC serial port (Arduino Serial), enumerated by a modelled host',
        'ADC channels 0-7 (A0-A5)',
      ],
    },
    analogPinBase: 18,
    limitation:
      'Runs its own ATmega32U4 profile (2.5 KB SRAM, 32U4 vector table, ports B-F) — never the Uno profile. ' +
      'Serial is the native USB port and reaches the serial monitor; USB HID (Keyboard, Mouse) enumerates but nothing reads its reports. ' +
      'Timer4 is not modeled, so analogWrite on D6 and D13 produces no PWM (digitalWrite on those pins works normally). ' +
      'attachInterrupt (INT0-INT3, INT6), pin-change interrupts, SPI, I2C and EEPROM run on the 32U4\'s own registers and vectors. ' +
      'The A6-A11 alternate ADC channels are not emulated, and EEPROM starts erased each time the simulation starts.',
  },

  // ---------------- SAM / SAMD / Renesas ----------------
  // ---------------- same chips, different products ----------------
  //
  // These cost almost nothing, and that is the point of keeping board,
  // processor, toolchain and runtime separate: the chip is one we already
  // execute, so the emulator, the toolchain and every device model work
  // unchanged. Each names the service target its pipeline uses, because the
  // service's allowlist has never heard of these products.
  'board.arduino-pro-mini': {
    processorProfileId: 'proc.atmega328p',
    compileProfileId: 'compile.avr-arduino',
    runtimeProfileId: 'runtime.avr8js-328p',
    serverTargetId: 'board.arduino-pro-mini',
    manufacturer: 'Arduino',
    architecture: 'avr',
    analogPinBase: 14,
    aliases: ['pro-mini', 'arduino pro mini', 'promini'],
    // Its own target: arduino:avr:pro, whose default processor option is the
    // 5 V 16 MHz ATmega328P. It differs from the Uno's little — the board
    // define, and a variant with eight analog inputs rather than six — but it
    // is this board's, so it is the one used.
    compiler: {
      ...avrCliCompiler('arduino:avr:pro'),
      note: 'Built as an Arduino Pro Mini (arduino:avr:pro, ATmega328P 5 V 16 MHz), with its own variant: '
        + 'eight analog inputs, A6 and A7 included.',
    },
    simulation: {
      engine: 'avr8js',
      supported: true,
      supportedApis: AVR_SIM_APIS,
      supportedPeripherals: AVR_SIM_PERIPHERALS,
    },
    limitation:
      'The 5 V 16 MHz board. The 3.3 V 8 MHz version runs at half the clock and is a different build, not '
      + 'offered here.',
  },
  'board.seeed-xiao-rp2040': {
    processorProfileId: 'proc.rp2040',
    compileProfileId: 'compile.rp2040-arduino',
    runtimeProfileId: 'runtime.rp2040js',
    serverTargetId: 'board.seeed-xiao-rp2040',
    manufacturer: 'Seeed Studio',
    architecture: 'rp2040',
    aliases: ['xiao-rp2040', 'seeed xiao rp2040', 'xiao rp2040'],
    // The silkscreen and the silicon disagree, and both are right. D0 is the
    // label beside the pad; GP26 is the pad. The XIAO's own variant defines
    // D0 as 26, so a sketch's digitalWrite(D0) and this map agree.
    padMap: {
      D0: 'GP26', D1: 'GP27', D2: 'GP28', D3: 'GP29',
      D4: 'GP6', D5: 'GP7', D6: 'GP0', D7: 'GP1',
      D8: 'GP2', D9: 'GP4', D10: 'GP3',
    },
    extraPinCaps: [{ pattern: /^D\d+$/, add: ['pwm'] }],
    compiler: {
      provider: 'arduino-cli',
      fqbn: 'rp2040:rp2040:seeed_xiao_rp2040',
      requiredCore: 'rp2040:rp2040',
      supported: true,
      note: 'Built as a Seeed XIAO RP2040 (rp2040:rp2040:seeed_xiao_rp2040), with its own variant: D0-D10 as '
        + 'printed, LED_BUILTIN on GP17, and Wire on GP6/GP7 — the pads marked SDA and SCL.',
    },
    simulation: {
      engine: 'rp2040js',
      supported: true,
      supportedApis: RP2040_SIM_APIS,
      supportedPeripherals: RP2040_SIM_PERIPHERALS,
    },
    limitation:
      'The on-board WS2812 and the user LED are not wired to the canvas. Serial is the USB port and reaches '
      + 'the serial monitor; Serial1 is the UART on D6/D7.',
  },
  'board.esp32-c3-supermini': {
    processorProfileId: 'proc.esp32c3',
    compileProfileId: 'compile.esp32c3-arduino',
    runtimeProfileId: 'runtime.esp32c3',
    serverTargetId: 'board.esp32-c3',
    manufacturer: MULTI_VENDOR_DESIGN,
    architecture: 'esp32',
    variant: 'esp32c3',
    aliases: ['esp32-c3-supermini', 'c3-supermini', 'esp32c3 supermini'],
    identityNote:
      'A widely cloned third-party design rather than an Espressif product, so no single manufacturer is claimed.',
    compiler: {
      provider: 'arduino-cli',
      fqbn: 'esp32:esp32:esp32c3',
      requiredCore: 'esp32:esp32',
      supported: true,
      note: 'Built through the esp32:esp32 core\'s ESP32-C3 target — the same RISC-V chip and the same 4 MB flash '
        + 'layout as the DevKitM-1 entry. Never compiled through an Xtensa or AVR core.',
    },
    simulation: {
      engine: 'esp32c3',
      supported: true,
      supportedApis: ESP32C3_SIM_APIS,
      supportedPeripherals: ESP32C3_SIM_PERIPHERALS,
    },
    limitation:
      'Real RISC-V execution of the compiled image, with GPIO and Serial on UART0 (built through the generic C3 '
      + 'target, so Serial is the UART rather than the native USB port). Wi-Fi, Bluetooth, the ADC, PWM, I2C and SPI '
      + 'are not simulated — sketches using them compile, run, and do nothing.',
  },
  'board.arduino-due': {
    manufacturer: 'Arduino',
    architecture: 'sam',
    aliases: ['arduino-due', 'due'],
    limitation: 'SAM3X8E toolchain not installed on the compiler service; wiring + 3.3 V validation only.',
  },
  'board.arduino-uno-r4': {
    manufacturer: 'Arduino',
    architecture: 'renesas',
    aliases: ['uno-r4', 'uno-r4-minima'],
    limitation: 'Renesas RA4M1 toolchain not installed; wiring + validation only.',
  },
  'board.nano-33-ble': {
    manufacturer: 'Arduino',
    architecture: 'nrf52',
    aliases: ['nano-33-ble', 'nano33ble'],
    limitation: 'nRF52840 toolchain not installed; wiring + validation only.',
  },
  'board.adafruit-feather': {
    manufacturer: 'Adafruit',
    identityNote:
      'Built and run as the Feather M0 Basic, whose pin layout the radio and Wi-Fi Feather M0 variants share.',
    architecture: 'samd',
    aliases: ['feather-m0'],
    processorProfileId: 'proc.samd21',
    compileProfileId: 'compile.samd21-adafruit',
    runtimeProfileId: 'runtime.samd21',
    serverTargetId: 'board.adafruit-feather',
    // PWM where the variant gives the pin a TCC or TC: A1-A4 as well as the D pins.
    extraPinCaps: [{ pattern: /^A[1-4]$/, add: ['pwm'] }],
    // The Feather's labels and the pads behind them, from the core's variant.
    padMap: {
      A0: 'PA02', A1: 'PB08', A2: 'PB09', A3: 'PA04', A4: 'PA05', A5: 'PB02',
      SCK: 'PB11', MOSI: 'PB10', MISO: 'PA12', RX: 'PA11', TX: 'PA10',
      D13: 'PA17', D12: 'PA19', D11: 'PA16', D10: 'PA18', D9: 'PA07', D6: 'PA20', D5: 'PA15',
      SCL: 'PA23', SDA: 'PA22',
    },
    compiler: samd21Compiler('adafruit:samd:adafruit_feather_m0'),
    simulation: {
      engine: 'samd21',
      supported: true,
      supportedApis: SAMD21_SIM_APIS,
      supportedPeripherals: SAMD21_SIM_PERIPHERALS,
    },
    limitation: SAMD21_LIMITATION,
  },
  'board.adafruit-qtpy': {
    manufacturer: 'Adafruit',
    architecture: 'samd',
    aliases: ['qt-py', 'adafruit qt py', 'qt py', 'qt py m0'],
    processorProfileId: 'proc.samd21',
    compileProfileId: 'compile.samd21-adafruit',
    runtimeProfileId: 'runtime.samd21',
    serverTargetId: 'board.adafruit-qtpy',
    // PWM where the variant gives the pin a TCC or TC: every pin but A0 and A1.
    extraPinCaps: [{ pattern: /^(A2|A3|SDA|SCL|TX|RX|SCK|MISO|MOSI)$/, add: ['pwm'] }],
    padMap: {
      A0: 'PA02', A1: 'PA03', A2: 'PA04', A3: 'PA05', SDA: 'PA16', SCL: 'PA17', TX: 'PA06',
      RX: 'PA07', SCK: 'PA11', MISO: 'PA09', MOSI: 'PA10',
    },
    compiler: samd21Compiler('adafruit:samd:adafruit_qtpy_m0'),
    simulation: {
      engine: 'samd21',
      supported: true,
      supportedApis: SAMD21_SIM_APIS,
      supportedPeripherals: SAMD21_SIM_PERIPHERALS,
    },
    limitation: SAMD21_LIMITATION,
  },
  'board.seeed-xiao': {
    manufacturer: 'Seeed Studio',
    architecture: 'samd',
    aliases: ['xiao', 'seeeduino-xiao', 'seeed studio xiao', 'xiao samd21'],
    processorProfileId: 'proc.samd21',
    compileProfileId: 'compile.samd21-seeed',
    runtimeProfileId: 'runtime.samd21',
    serverTargetId: 'board.seeed-xiao',
    // PWM where the variant gives the pin a TCC or TC: every pin but A0. And
    // SPI on the three pins printed A8/SCK, A9/MISO and A10/MOSI — SERCOM0,
    // which the variant's SPI uses.
    extraPinCaps: [
      { pattern: /^(A([1-9]|10)|SDA|SCL|TX|RX)$/, add: ['pwm'] },
      { pattern: /^A8$/, add: ['spi-sck'] },
      { pattern: /^A9$/, add: ['spi-miso'] },
      { pattern: /^A10$/, add: ['spi-mosi'] },
    ],
    padMap: {
      A0: 'PA02', A1: 'PA04', A2: 'PA10', A3: 'PA11', SDA: 'PA08', SCL: 'PA09', TX: 'PB08', RX: 'PB09',
      A8: 'PA07', A9: 'PA05', A10: 'PA06',
    },
    compiler: {
      provider: 'arduino-cli',
      fqbn: 'Seeeduino:samd:seeed_XIAO_m0',
      requiredCore: 'Seeeduino:samd',
      supported: true,
      note: "Built with Seeed's SAMD core (Seeeduino:samd:seeed_XIAO_m0), linked above the board's 8 KB bootloader.",
    },
    simulation: {
      engine: 'samd21',
      supported: true,
      supportedApis: SAMD21_SIM_APIS,
      supportedPeripherals: SAMD21_SIM_PERIPHERALS,
    },
    limitation: SAMD21_LIMITATION,
  },

  // ---------------- RP2040 ----------------
  // Both boards build through the Arduino-Pico core (rp2040:rp2040), each with
  // its own FQBN. The retired arduino:mbed_rp2040:pico identifier is kept only
  // as a lookup alias — see the note on the Pico's alias list below.
  'board.raspberry-pi-pico': {
    processorProfileId: 'proc.rp2040',
    compileProfileId: 'compile.rp2040-arduino',
    runtimeProfileId: 'runtime.rp2040js',
    manufacturer: 'Raspberry Pi',
    architecture: 'rp2040',
    // 'arduino:mbed_rp2040:pico' stays purely so findBoardByIdOrAlias() still
    // resolves projects imported while that was the live target. Aliases are a
    // lookup mechanism only and are never shown in capability text.
    aliases: ['raspberry-pi-pico', 'pico', 'rp2040', 'rp2040:rp2040:rpipico', 'arduino:mbed_rp2040:pico'],
    compiler: {
      provider: 'arduino-cli',
      fqbn: 'rp2040:rp2040:rpipico',
      requiredCore: 'rp2040:rp2040',
      supported: true,
      note: 'Requires the rp2040:rp2040 (Arduino-Pico) core on the compiler service, installed in the production image. Never compiled through arduino:avr.',
    },
    simulation: {
      engine: 'rp2040js',
      supported: true,
      supportedApis: RP2040_SIM_APIS,
      supportedPeripherals: RP2040_SIM_PERIPHERALS,
    },
    // Every RP2040 GPIO can be routed to a PWM slice on the real chip.
    extraPinCaps: [{ pattern: /^GP\d+$/, add: ['pwm'] }],
    limitation: RP2040_LIMITATION,
  },
  'board.raspberry-pi-pico-w': {
    processorProfileId: 'proc.rp2040',
    compileProfileId: 'compile.rp2040-arduino',
    runtimeProfileId: 'runtime.rp2040js',
    manufacturer: 'Raspberry Pi',
    architecture: 'rp2040',
    aliases: ['raspberry-pi-pico-w', 'pico-w', 'rp2040:rp2040:rpipicow'],
    compiler: {
      provider: 'arduino-cli',
      fqbn: 'rp2040:rp2040:rpipicow',
      requiredCore: 'rp2040:rp2040',
      supported: true,
      note: 'Built as a Pico W in its own right (rp2040:rp2040:rpipicow), not as a plain Pico. The CYW43 Wi-Fi APIs are not included in this toolchain.',
    },
    simulation: {
      engine: 'rp2040js',
      supported: true,
      supportedApis: RP2040_SIM_APIS,
      supportedPeripherals: RP2040_SIM_PERIPHERALS,
    },
    extraPinCaps: [{ pattern: /^GP\d+$/, add: ['pwm'] }],
    limitation:
      'The CYW43 Wi-Fi radio and all network functionality are NOT simulated. ' + RP2040_LIMITATION,
  },

  // ---------------- Espressif (variants are distinct) ----------------
  'board.esp32-devkit': {
    manufacturer: MULTI_VENDOR_DESIGN,
    identityNote:
      '"ESP32 DevKit V1" is a widely cloned third-party design, not an Espressif product — Espressif\'s own boards are the ESP32-DevKitC series. It is produced by many vendors, so no single manufacturer is claimed.',
    architecture: 'esp32',
    variant: 'esp32',
    aliases: ['esp32-devkit-v1', 'esp32'],
    limitation: 'Xtensa LX6 execution is not simulated and the ESP32 core is not installed on the compiler service; wiring + 3.3 V validation only.',
  },
  'board.esp32-s3': {
    manufacturer: 'Espressif',
    architecture: 'esp32',
    variant: 'esp32s3',
    aliases: ['esp32-s3', 'esp32-s3 devkitc', 'esp32-s3-devkitc'],
    limitation: 'ESP32-S3 (Xtensa LX7) — validation only; distinct from the base ESP32.',
  },
  // The board is real and its pins are right; the runtime is not built yet, so
  // The compiler target is genuine — the core's generic esp32c6 target is what
  // this board is built for — and firmware execution is now real: ESP-IDF
  // startup, FreeRTOS with a delivered tick, setup(), loop() and GPIO. The
  // capability lists stay narrow, because everything else on this part still
  // does nothing.
  'board.esp32-c6-devkitc-1': {
    processorProfileId: 'proc.esp32c6',
    compileProfileId: 'compile.esp32c6-arduino',
    runtimeProfileId: 'runtime.esp32c6',
    architecture: 'esp32',
    variant: 'esp32c6',
    manufacturer: 'Espressif',
    aliases: ['esp32-c6-devkitc-1', 'esp32-c6', 'esp32c6', 'esp32:esp32:esp32c6'],
    compiler: {
      provider: 'arduino-cli',
      fqbn: 'esp32:esp32:esp32c6',
      requiredCore: 'esp32:esp32',
      supported: true,
      note: 'Requires the esp32:esp32 core. The ESP32-C6 is RISC-V, so it is never compiled through an Xtensa or AVR core.',
    },
    simulation: {
      engine: 'esp32c6',
      supported: true,
      supportedApis: ESP32C6_SIM_APIS,
      supportedPeripherals: ESP32C6_SIM_PERIPHERALS,
    },
    limitation: ESP32C6_LIMITATION,
  },
  'board.esp32-c3': {
    processorProfileId: 'proc.esp32c3',
    compileProfileId: 'compile.esp32c3-arduino',
    runtimeProfileId: 'runtime.esp32c3',
    manufacturer: 'Espressif',
    architecture: 'esp32',
    variant: 'esp32c3',
    // 'esp32-c3-devkitm' and the old display name stay as lookup aliases so
    // projects saved before this entry was corrected still resolve.
    aliases: ['esp32-c3', 'esp32-c3-devkitm-1', 'esp32-c3-devkitm', 'esp32c3', 'esp32:esp32:esp32c3'],
    compiler: {
      provider: 'arduino-cli',
      fqbn: 'esp32:esp32:esp32c3',
      requiredCore: 'esp32:esp32',
      supported: true,
      note: 'Requires the esp32:esp32 core on the compiler service. The ESP32-C3 is RISC-V, so it is never compiled through an Xtensa or AVR core.',
    },
    simulation: {
      engine: 'esp32c3',
      supported: true,
      supportedApis: ESP32C3_SIM_APIS,
      supportedPeripherals: ESP32C3_SIM_PERIPHERALS,
    },
    limitation: ESP32C3_LIMITATION,
  },
  'board.esp8266-nodemcu': {
    manufacturer: MULTI_VENDOR_DESIGN,
    identityNote:
      'NodeMCU is an open dev-kit and firmware project, not an Espressif product. Boards carrying the name are made by several vendors with differing layouts, so no single manufacturer is claimed.',
    architecture: 'esp8266',
    variant: 'esp8266',
    aliases: ['nodemcu', 'esp8266'],
    limitation: 'Single ADC (A0, 1.0 V range on the bare chip); not compiled or simulated.',
  },
  'board.esp32-cam': {
    manufacturer: MULTI_VENDOR_DESIGN,
    identityNote:
      'The ESP32-CAM design originated with Ai-Thinker and is widely cloned. It is not an Espressif product, so no single manufacturer is claimed.',
    architecture: 'esp32',
    variant: 'esp32',
    aliases: ['esp32-cam'],
    limitation: 'Visual reference; camera and execution are not modeled.',
  },

  // ---------------- STM32 / imxrt / nRF52 ----------------
  'board.stm32-nucleo': {
    manufacturer: 'STMicroelectronics',
    identityNote:
      'Nucleo-64 is a board family sharing one pin layout. This entry models that shared layout rather than one part number; the processor field names the variant it is dimensioned for.',
    architecture: 'stm32',
    aliases: ['nucleo-64', 'nucleo-f401re'],
    limitation: 'STM32 toolchain not installed; wiring only.',
  },
  'board.teensy41': {
    manufacturer: 'PJRC',
    architecture: 'imxrt',
    aliases: ['teensy-4.1'],
    limitation: 'IMXRT1062 toolchain not installed; wiring only.',
  },
  'board.microbit': {
    manufacturer: 'Micro:bit Educational Foundation',
    identityNote:
      'Originated by the BBC and now produced by the Micro:bit Educational Foundation, which is why the brand and the maker differ.',
    architecture: 'nrf52',
    aliases: ['micro:bit', 'microbit-v2'],
    limitation: 'Edge-connector visual reference only.',
  },

  // ---------------- Linux SBC headers ----------------
  'board.rpi-zero-gpio': {
    manufacturer: 'Raspberry Pi',
    architecture: 'linux',
    aliases: ['raspberry-pi-zero'],
    limitation:
      'Linux boards are not emulated. No behavioral GPIO runtime is implemented yet, so this stays at wiring level — it is never claimed as simulated.',
  },
  'board.rpi4-gpio': {
    manufacturer: 'Raspberry Pi',
    architecture: 'linux',
    aliases: ['raspberry-pi-4', 'raspberry-pi-5'],
    limitation:
      'Linux boards are not emulated. No behavioral GPIO runtime is implemented yet, so this stays at wiring level — it is never claimed as simulated.',
  },
};
