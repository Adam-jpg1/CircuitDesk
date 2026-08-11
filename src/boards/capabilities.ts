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

const AVR_SIM_APIS = [
  'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogWrite (PWM)',
  'delay/millis/micros', 'Serial (UART both directions)', 'timers', 'external interrupts',
];

/**
 * The Mega's list deliberately omits external interrupts: the emulator's
 * INT/PCINT wiring is ATmega328P-specific (INT0/INT1 on PD2/PD3, PCINT0 at the
 * 328P vector), which does not match the ATmega2560's INT0-INT7 / PCINT0-2
 * layout. Until Mega-correct interrupt configs exist, attachInterrupt is
 * declared unsupported rather than silently emulated wrong.
 */
const MEGA_SIM_APIS = AVR_SIM_APIS.filter((api) => api !== 'external interrupts');

/**
 * The Leonardo's list is written out rather than filtered, because two entries
 * differ in meaning: "Serial" on this board is native USB CDC (not emulated),
 * so only Serial1 is claimed, and PWM exists on five of the seven physical
 * PWM pins because Timer4 is not modeled.
 */
const LEONARDO_SIM_APIS = [
  'pinMode', 'digitalWrite', 'digitalRead', 'analogRead (A0-A5)',
  'analogWrite (PWM on D3, D5, D9, D10, D11)', 'delay/millis/micros',
  'Serial1 (hardware UART on D0/D1, both directions)', 'timers',
];
const AVR_SIM_PERIPHERALS = ['GPIO ports', 'Timer0/1/2', 'USART0', 'ADC'];

/**
 * The RP2040 lists are written from what the integration tests actually
 * exercise on real compiled firmware, not from what the chip can do.
 *
 * Deliberately absent, because nothing here tests them: Wi-Fi, USB (including
 * the USB-CDC `Serial` object, which is why only `Serial1` is claimed), PIO,
 * the second core, and hardware I2C/SPI device support.
 *
 * `analogWrite()` is absent for a licensing reason rather than an engineering
 * one. The Arduino-Pico core is built against the Pico SDK's ROM floating-point
 * implementation, so every float operation is dispatched through a table in
 * the Raspberry Pi boot ROM. That table is the third-party mufplib code
 * CircuitDesk is not licensed to redistribute (see THIRD_PARTY_NOTICES.md), and
 * `analogWrite()` computes its PWM divisor in floating point. A sketch that
 * needs those routines is stopped with an explanation rather than allowed to
 * run on fabricated values. Integer arithmetic, digital I/O, `analogRead()`
 * and `Serial1` do not touch them.
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
];

const ESP32C3_SIM_PERIPHERALS = [
  'GPIO with the IO MUX and GPIO matrix',
  'System timer, which drives the FreeRTOS tick',
  'Interrupt matrix and CPU interrupt controller',
  'SPI flash and the flash MMU',
];

/**
 * Said plainly, because the gap between what this runs and what an ESP32-C3
 * does is large and a student should not have to discover it by being wrong.
 */
const ESP32C3_LIMITATION =
  'Real RISC-V execution of the compiled application image: ESP-IDF startup, FreeRTOS, setup() and loop(), and GPIO. ' +
  'Wi-Fi, Bluetooth LE, USB Serial/JTAG, ADC, PWM, I2C, SPI to devices and the hardware UART are not simulated — ' +
  'sketches using them compile and run, but those peripherals do nothing.';

const RP2040_SIM_APIS = [
  'pinMode (INPUT, OUTPUT, INPUT_PULLUP)',
  'digitalWrite',
  'digitalRead',
  'analogRead (GP26/GP27/GP28, 0-3.3 V, 12-bit)',
  'delay/millis/micros',
  'Serial1 (hardware UART0 on GP0/GP1)',
  'Wire (hardware I2C, including repeated START and NACK)',
  'SPI (hardware SPI, all four modes, MSB first)',
];
const RP2040_SIM_PERIPHERALS = [
  'SIO and GPIO pads (GP0-GP28, including pad pull resistors)',
  'ADC channels 0-2',
  'UART0',
  'I2C0 and I2C1',
  'SPI0 and SPI1',
  'system timer',
  'clock tree (PLLs, clk_sys, clk_peri)',
];

/** Shared by both RP2040 boards, so the two texts cannot drift apart. */
const RP2040_LIMITATION =
  'The RP2040 CPU, GPIO, ADC, UART0, I2C and SPI are simulated by executing the real compiled firmware, ' +
  'and the I2C and SPI device models are the same ones the AVR boards drive. ' +
  'Buses follow whichever pins the firmware muxes, defaulting to the Arduino-Pico core\'s GP4/GP5 for Wire ' +
  'and GP18/GP19/GP16 for SPI. ' +
  'Floating-point arithmetic is not available, because the Arduino-Pico core performs it through ' +
  'routines built into the Raspberry Pi boot ROM that CircuitDesk is not licensed to redistribute; ' +
  'this also rules out analogWrite(), which computes its PWM divisor in floating point. ' +
  'USB (the Serial object), PIO, the second core and hardware I2C/SPI device support are not simulated.';

const avrCliCompiler = (fqbn: string): BoardCompilerInfo => ({
  provider: 'arduino-cli',
  fqbn,
  requiredCore: 'arduino:avr',
  supported: true,
});

export const BOARD_CAPABILITIES: Record<string, BoardCapabilityEntry> = {
  // ---------------- AVR (genuinely simulated where tested) ----------------
  'board.arduino-uno': {
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
      'Serial1-Serial3 (USART1-3) are not emulated; only Serial (USART0) is. ' +
      'attachInterrupt is not emulated on this board either: external interrupts (INT0-INT7) and pin-change interrupts (PCINT0-2) are not modeled for the ATmega2560, so those pins still wire and validate but produce no interrupt behavior.',
  },
  'board.arduino-leonardo': {
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
        'ADC channels 0-7 (A0-A5)',
      ],
    },
    analogPinBase: 18,
    limitation:
      'Runs its own ATmega32U4 profile (2.5 KB SRAM, 32U4 vector table, ports B-F) — never the Uno profile. ' +
      'Native USB is NOT emulated: the "Serial" object (USB CDC), Keyboard and Mouse produce nothing, and a sketch that waits on "while (!Serial)" will never proceed — use Serial1 (D0/D1), which is genuinely emulated. ' +
      'Timer4 is not modeled, so analogWrite on D6 and D13 produces no PWM (digitalWrite on those pins works normally). ' +
      'The A6-A11 alternate ADC channels, attachInterrupt (INT0-INT3/INT6), pin-change interrupts, SPI, I2C and EEPROM persistence are not emulated.',
  },

  // ---------------- SAM / SAMD / Renesas ----------------
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
      'Feather M0 is a family of boards sharing the Feather pin layout. This entry models the shared layout rather than one specific variant.',
    architecture: 'samd',
    aliases: ['feather-m0'],
    limitation: 'SAMD21 toolchain not installed; wiring only.',
  },
  'board.adafruit-qtpy': {
    manufacturer: 'Adafruit',
    architecture: 'samd',
    aliases: ['qt-py', 'adafruit qt py', 'qt py'],
    limitation: 'SAMD21 toolchain not installed; wiring only.',
  },
  'board.seeed-xiao': {
    manufacturer: 'Seeed Studio',
    architecture: 'samd',
    aliases: ['xiao', 'seeeduino-xiao', 'seeed studio xiao', 'xiao'],
    limitation: 'SAMD21 toolchain not installed; wiring only.',
  },

  // ---------------- RP2040 ----------------
  // Both boards build through the Arduino-Pico core (rp2040:rp2040), each with
  // its own FQBN. The retired arduino:mbed_rp2040:pico identifier is kept only
  // as a lookup alias — see the note on the Pico's alias list below.
  'board.raspberry-pi-pico': {
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
  // nothing here claims simulation. The compiler target is genuine — the core's
  // generic esp32c6 target is what this board is built for.
  'board.esp32-c6-devkitc-1': {
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
    limitation:
      'Compiles for the real target. Firmware execution is not implemented for this board yet, and Wi-Fi, Bluetooth LE, ' +
      'Zigbee/802.15.4 and Thread are not simulated at all.',
  },
  'board.esp32-c3': {
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
