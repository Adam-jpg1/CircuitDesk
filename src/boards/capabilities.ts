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
  'EEPROM (kept for the whole run, through the sketch\'s own resets; Run and Reset start it erased)',
];

const AVR_SIM_APIS = [
  'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogWrite (PWM)',
  'delay/millis/micros', 'Serial (UART both directions)', 'timers', ...AVR_COMMON_APIS,
];

/**
 * The Mega runs the same list on its own wiring (INT0-INT7 and PCINT0-2 at
 * the ATmega2560's vectors, tests/boards.eepromInterrupts.mts), plus its three further USARTs.
 */
const MEGA_SIM_APIS = [...AVR_SIM_APIS, 'Serial1, Serial2 and Serial3 (USART1-3, both directions, to the parts on their pins)'];

/**
 * The Leonardo's list is written out rather than filtered, because two entries
 * differ in meaning: "Serial" on this board is native USB CDC, served by the
 * 32U4 USB controller model (tests/leonardo.usbSerial.mts) rather than by a
 * UART, and D6 and D13's PWM comes from the 32U4's own Timer4 (avr/timer4.ts),
 * not one of the timers it shares with the Uno.
 */
const LEONARDO_SIM_APIS = [
  'pinMode', 'digitalWrite', 'digitalRead', 'analogRead (A0-A5)',
  'analogWrite (PWM on D3, D5, D6, D9, D10, D11, D13)', 'delay/millis/micros',
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
/** DevKit V1 silkscreen labels to ESP32 GPIOs. */
export const ESP32_DEVKIT_PADS: Record<string, string> = {
  VP: 'GPIO36', VN: 'GPIO39', D34: 'GPIO34', D35: 'GPIO35', D32: 'GPIO32', D33: 'GPIO33', D25: 'GPIO25', D26: 'GPIO26',
  D27: 'GPIO27', D14: 'GPIO14', D12: 'GPIO12', D13: 'GPIO13', D15: 'GPIO15', D2: 'GPIO2', D4: 'GPIO4', RX2: 'GPIO16',
  TX2: 'GPIO17', D5: 'GPIO5', D18: 'GPIO18', D19: 'GPIO19', D21: 'GPIO21', RX0: 'GPIO3', TX0: 'GPIO1', D22: 'GPIO22',
  D23: 'GPIO23',
};

/** What the ESP32 runtime executes and has been checked to work. */
const ESP32_SIM_APIS = [
  'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'delay/millis/micros', 'Serial (UART0)', 'floating point',
  'analogWrite (PWM)', 'tone()', 'Servo pulses through the ESP32Servo library', 'attachInterrupt', 'Wire (I2C)', 'SPI',
];
const ESP32_SIM_PERIPHERALS = [
  'both Xtensa LX6 cores under FreeRTOS', 'GPIO matrix and interrupts', 'timer groups', 'UART0', 'SAR ADC1/ADC2',
  'LED PWM controller', 'I2C0/I2C1 (master)', 'HSPI/VSPI (master)',
];
const ESP32_LIMITATION =
  'Real Xtensa execution of the compiled image on both cores, under ESP-IDF\'s own startup and FreeRTOS: GPIO and '
  + 'interrupts, timing, Serial, floating point, analogRead(), PWM/tone()/servos, Wire and SPI. The ADC converts '
  + 'ideally (no noise or curve). Wi-Fi and Bluetooth are not simulated — sketches using them compile, run, and do nothing.';

const ESP32C3_SIM_APIS = [
  'pinMode (INPUT, OUTPUT, INPUT_PULLUP, INPUT_PULLDOWN)',
  'digitalWrite',
  'digitalRead',
  'delay/millis/micros',
  'setup() and repeated loop()',
  'Serial (UART0 through the ESP-IDF driver, both directions, at the baud rate set)',
  'analogRead (12-bit, on IO0-IO5)',
  'floating point (float and double, bit-exact IEEE-754 through the ROM soft-float routines)',
  'analogWrite, ledcWrite and tone() (the LED PWM controller)',
  'Servo pulses through the ESP32Servo library',
  'external interrupts (attachInterrupt)',
  'Wire (I2C master, on SDA/SCL or wherever Wire.begin() routes it)',
  'SPI (master, on SCK/MOSI/MISO or wherever SPI.begin() routes it)',
  'EEPROM and Preferences (NVS on the flash, kept for the whole run; Run and Reset start it erased)',
];

const ESP32C3_SIM_PERIPHERALS = [
  'GPIO with the IO MUX and GPIO matrix',
  'System timer, which drives the FreeRTOS tick',
  'Interrupt matrix and CPU interrupt controller',
  'SPI flash and the flash MMU',
  'UART0 — FIFOs, the TX-empty, RX-full, RX-timeout and TX-done interrupts, baud from the programmed divider',
  'SAR ADC one-shot conversions, at the attenuation the sketch sets',
  'GPIO interrupts, through the interrupt matrix',
  'LED PWM controller: four timers, six channels, routed through the GPIO matrix',
  'I2C0 in master mode, running the command list on the shared device bus',
  'GP-SPI2 in master mode, on the shared device bus',
];

/**
 * Said plainly, because the gap between what this runs and what an ESP32-C3
 * does is large and a student should not have to discover it by being wrong.
 */
const ESP32C3_LIMITATION =
  'Real RISC-V execution of the compiled application image: ESP-IDF startup, FreeRTOS, setup() and loop(), GPIO and ' +
  'interrupts, floating point, Serial on UART0, analogRead(), analogWrite()/tone()/servos on the LED PWM controller, ' +
  'Wire, SPI and EEPROM/Preferences. Wi-Fi, Bluetooth LE and USB Serial/JTAG are not simulated — sketches using them ' +
  'compile and run, but those radios and that port do nothing.';

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
  'floating point (float and double, bit-exact IEEE-754 through the ROM soft-float routines)',
  'analogWrite, ledcWrite and tone() (the LED PWM controller)',
  'Servo pulses through the ESP32Servo library',
  'external interrupts (attachInterrupt)',
  'Wire (I2C master, on SDA/SCL or wherever Wire.begin() routes it)',
  'SPI (master, on SCK/MOSI/MISO or wherever SPI.begin() routes it)',
  'EEPROM and Preferences (NVS on the flash, kept for the whole run; Run and Reset start it erased)',
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
  'GPIO interrupts, through the interrupt matrix',
  'LED PWM controller: four timers, six channels, routed through the GPIO matrix',
  'I2C0 in master mode, running the command list on the shared device bus',
  'GP-SPI2 in master mode, on the shared device bus',
];

/**
 * Said plainly. Everything the C6 does not do is listed, because a sketch that
 * uses any of it will compile, run, and quietly do nothing.
 */
const ESP32C6_LIMITATION =
  'Real RISC-V execution of the compiled application image: ESP-IDF startup, FreeRTOS, setup() and loop(), GPIO ' +
  'with its pulls and interrupts, floating point, Serial on UART0, analogRead(), analogWrite()/tone()/servos on the LED ' +
  'PWM controller, Wire, SPI and EEPROM/Preferences. Wi-Fi, Bluetooth LE, Zigbee/802.15.4, Thread and USB Serial/JTAG ' +
  'are not simulated — sketches using them compile and run, but those radios and that port do nothing.';

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

const DUE_SIM_APIS = [
  'pinMode (INPUT, OUTPUT, INPUT_PULLUP)',
  'digitalWrite',
  'digitalRead',
  'analogRead (A0-A11, 10-bit by default, analogReadResolution up to 12, 3.3 V reference)',
  'analogWrite (PWM on D2-D13: the PWM controller on D6-D9, the timer counters on the rest, at 1 kHz)',
  'Wire (I2C master on D20/D21) and Wire1 (on SDA1/SCL1)',
  'SPI (master, on the SPI header)',
  'delay/millis/micros',
  'Serial (the programming port: the UART on D0/D1, both directions)',
  'Serial1, Serial2 and Serial3 (USART0, USART1, USART3 on D18/19, D16/17, D14/15, both directions)',
  'attachInterrupt on any digital pin (CHANGE, RISING, FALLING, LOW, HIGH)',
  "Servo, on the timer counters' interrupts (the Due's core has no tone())",
];

const DUE_SIM_PERIPHERALS = [
  'ARMv7-M Cortex-M3 core: Thumb-2, NVIC, SysTick',
  'PMC clock and PLL ready flags; EEFC flash controller with page programming',
  'PIOA-D: output, input, open drain, pull-ups, peripheral muxing and pin-change interrupts',
  'UART and USART0-3, interrupt driven, paced at the programmed baud',
  'TC0-TC2 (nine channels) in waveform mode, with compare outputs and interrupts',
  'PWM controller channels (PWML4-7)',
  'ADC software-triggered conversions; DACC conversion data',
  'TWI0/TWI1 I2C master and SPI0 master, on the shared device buses',
];

const DUE_LIMITATION =
  "Real SAM3X8E firmware on CircuitDesk's ARMv7-M core: startup, setup() and loop(), GPIO, analogRead, analogWrite, Wire, " +
  "SPI, Serial to Serial3, attachInterrupt and Servo. tone() and the EEPROM library are not part of the Due's core. The native USB port (SerialUSB), CAN, EMAC (Ethernet), " +
  "DMA and the DAC's analog output onto the canvas are not simulated — sketches using them compile and run, but those " +
  'peripherals do nothing. The Due has no EEPROM; DueFlashStorage writes to the simulated flash.';

const NUCLEO_SIM_APIS = [
  'pinMode (INPUT, OUTPUT, INPUT_PULLUP, INPUT_PULLDOWN, OUTPUT_OPEN_DRAIN)',
  'digitalWrite',
  'digitalRead',
  'analogRead (A0-A5 and every ADC pad, 10-bit by default, analogReadResolution up to 12, 3.3 V reference)',
  'analogWrite (PWM on the timer pins: D3, D5, D6, D9, D10, D11 and more, at 1 kHz)',
  'tone() and noTone()',
  'Wire (I2C1 master on D14/D15, PB9/PB8)',
  'SPI (SPI1 master on D11-D13)',
  'delay/millis/micros',
  "Serial (USART2 on PA2/PA3, which the ST-LINK carries to the monitor, both directions)",
  'Uart (HardwareSerial) instances on USART1 and USART6, both directions',
  'attachInterrupt on any pin (CHANGE, RISING, FALLING)',
  'Servo',
  'EEPROM (emulated in the last flash sector, as the core does it)',
  'HardwareTimer: update and compare callbacks',
];

const NUCLEO_SIM_PERIPHERALS = [
  'ARMv7-M Cortex-M4 core with the single-precision FPU: Thumb-2, NVIC, SysTick',
  'RCC oscillator and PLL ready flags; FLASH sector erase and programming',
  'GPIOA-E and H: output, input, open drain, pulls, alternate functions; EXTI and SYSCFG',
  'USART1, USART2 and USART6, interrupt driven, paced at the programmed baud',
  'TIM1-TIM5 and TIM9-TIM11: PWM and output compare, update and compare interrupts',
  'ADC1 software-triggered conversions, with the internal reference and temperature channels',
  'I2C1-3 masters (event and error interrupts) and SPI1-4 masters, on the shared device buses',
];

const NUCLEO_LIMITATION =
  "Real STM32F401RE firmware from the STM32duino core on CircuitDesk's ARMv7-M core: startup, setup() and loop(), GPIO, " +
  'analogRead, analogWrite, tone, Wire, SPI, Serial, attachInterrupt, Servo and EEPROM. DMA, USB, the RTC, the watchdogs ' +
  'and timer input capture are not simulated — sketches using them compile and run, but those peripherals do nothing. ' +
  'The CPU runs at the 84 MHz the Nucleo variant sets up from the start; the clock tree itself is not modelled.';

const R4_SIM_APIS = [
  'pinMode (INPUT, OUTPUT, INPUT_PULLUP)',
  'digitalWrite',
  'digitalRead',
  'analogRead (A0-A5, 10-bit by default, analogReadResolution up to 14, 5 V reference)',
  'analogWrite (PWM on 3, 5, 6, 9, 10 and 11, on the GPT timers)',
  'Wire (I2C master on A4/A5, the IIC1 controller)',
  'SPI (master on 11-13, the SPI1 controller)',
  'delay/millis/micros',
  'Serial (native USB: enumerated by a simulated host, both directions)',
  'Serial1 (the UART on D0/D1, both directions)',
  'attachInterrupt on 2 and 3 and the other IRQ pins (CHANGE, RISING, FALLING)',
  'Servo and tone(), on the GPT timers',
  'EEPROM (kept in the data flash through Renesas\' virtual EEPROM, as the core does it)',
];

const R4_SIM_PERIPHERALS = [
  'ARMv7-M Cortex-M4 core with the single-precision FPU: Thumb-2, NVIC, SysTick',
  'ICU event linking, with the IRQ0-15 pin interrupts',
  'PORT and PFS: output, input, pull-ups, open drain and peripheral selection',
  'AGT0/1 timers (millis runs on AGT0), GPT0-7 PWM with buffered compares',
  'SCI asynchronous UARTs, IIC and SPI masters on the shared device buses',
  'ADC 12/14-bit single scans; the USBFS device controller with a CDC host',
];

const R4_LIMITATION =
  "Real RA4M1 firmware from the Arduino Renesas core on CircuitDesk's ARMv7-M core: startup, setup() and loop(), GPIO, " +
  'analogRead, analogWrite, Wire, SPI, Serial over USB, Serial1, attachInterrupt, Servo, tone and EEPROM. DMA, CAN, the capacitive touch unit and ' +
  "the DAC's analog output onto the canvas are not simulated — sketches using them compile and run, but those peripherals do " +
  'nothing. The CPU runs at the 48 MHz the core configures from the start.';

const MICROBIT_SIM_APIS = [
  'pinMode (INPUT, OUTPUT, INPUT_PULLUP, INPUT_PULLDOWN)',
  'digitalWrite / digitalRead on the edge connector',
  'the 5 x 5 LED matrix (rows high, columns low), drawn on the board',
  'buttons A and B (pins 5 and 11, active low), pressed on the board',
  'analogRead (0, 1, 2, 3, 4 and 10; 10-bit, 3.0 V full scale as the core configures it)',
  'analogWrite (PWM on any pin)',
  'delay/millis/micros',
  'Serial (through the USB interface chip, both directions)',
  'Wire (I2C master on 19/20) and SPI (master on 13-15)',
  'attachInterrupt on any pin',
];

const NRF52_SIM_PERIPHERALS = [
  'ARMv7-M Cortex-M4 core with the single-precision FPU: Thumb-2, NVIC, SysTick',
  'CLOCK/POWER, RTC0-2, TIMER0-4 with compare events and shorts',
  'GPIO P0/P1 with pulls and drive modes; GPIOTE edge events',
  'UART and UARTE, SAADC with EasyDMA results, PWM sequences',
  'TWI/TWIM and SPI/SPIM masters on the shared device buses',
];

const MICROBIT_LIMITATION =
  "Real nRF52833 firmware from the Arduino nRF5 core on CircuitDesk's ARMv7-M core: startup, setup() and loop(), the edge " +
  'pins, the LED matrix, buttons A and B, analogRead, analogWrite, Serial, Wire, SPI and attachInterrupt. The radio ' +
  '(Bluetooth), the microphone, the speaker, the touch logo, the motion sensor and NFC are not simulated.';

const NANO33_SIM_APIS = [
  'pinMode (INPUT, OUTPUT, INPUT_PULLUP, INPUT_PULLDOWN)',
  'digitalWrite / digitalRead',
  'analogRead (A0-A7; 10-bit by default, analogReadResolution up to 12)',
  'analogWrite (PWM on any pin)',
  'delay/millis/micros, on mbed OS',
  'Serial (native USB CDC, both directions)',
  'Serial1 (UARTE on TX1/RX0, both directions)',
  'attachInterrupt',
  'Wire (A4/A5)',
  'SPI (D11-D13)',
];

const NANO33_SIM_PERIPHERALS = [
  ...NRF52_SIM_PERIPHERALS,
  'USBD (EasyDMA endpoints, control transfers, a simulated host that opens the CDC port)',
  'NVMC/UICR programming and the system reset mbed asks for on first boot',
];

const NANO33_LIMITATION =
  "Real nRF52840 firmware from the Arduino mbed core (mbed OS and its RTOS) on CircuitDesk's ARMv7-M core: startup, " +
  'setup() and loop(), GPIO, analogRead, analogWrite, Serial over USB, Serial1, Wire, SPI and attachInterrupt. Bluetooth ' +
  "(the ArduinoBLE library), the onboard IMU, and the board's own LEDs other than the one on D13 are not simulated. " +
  "The board's bootloader is not run: the sketch starts directly, as it does after the bootloader hands over.";

const TEENSY41_SIM_APIS = [
  'pinMode (INPUT, OUTPUT, INPUT_PULLUP, INPUT_PULLDOWN)',
  'digitalWrite / digitalRead',
  'analogRead (A0-A17; 10-bit by default, analogReadResolution 8-12)',
  'analogWrite (the FlexPWM and QuadTimer pins)',
  'delay/millis/micros',
  'Serial (native USB CDC, both directions)',
  'Serial1 (LPUART6 on pins 0/1, both directions)',
  'attachInterrupt (RISING, FALLING, CHANGE, LOW, HIGH)',
  'Wire (pins 18/19)',
  'SPI (pins 11-13)',
];

const TEENSY41_SIM_PERIPHERALS = [
  'ARMv7-M Cortex-M7 core with the double-precision FPU: Thumb-2, NVIC, SysTick on its 100 kHz reference',
  'ITCM, DTCM and OCRAM; execution from the QSPI flash; the boot ROM\'s jump through the image vector table',
  'clock, PLL, DCDC and temperature-monitor status; IOMUXC pin muxing and pulls',
  'GPIO1-5 and the fast GPIO6-9 with edge and level interrupts',
  'ADC1/ADC2, FlexPWM1-4 and QuadTimer1-3 outputs, LPUART6, LPI2C1, LPSPI4',
  'USB OTG1 in device mode (queue heads, transfer descriptors, a simulated host that opens the CDC port)',
];

const TEENSY41_LIMITATION =
  "Real i.MX RT1062 firmware from the Teensy 4 core on CircuitDesk's ARMv7-M core: startup, setup() and loop(), GPIO, " +
  'analogRead, analogWrite, Serial over USB, Serial1, Wire, SPI and attachInterrupt. Built at the core\'s 60 MHz speed ' +
  'setting rather than 600 MHz, so heavy computation runs slower than on the board while timing stays exact. Serial2-8, ' +
  'the other I2C and SPI ports, IntervalTimer and tone(), EEPROM, DMA, Ethernet, the SD card slot, the external PSRAM ' +
  'and audio are not simulated.';

const PI_SIM_APIS = [
  'Python 3: functions, classes, loops, try/except, comprehensions, f-strings',
  'RPi.GPIO: setmode (BCM, BOARD), setup with pull-ups, output, input, PWM, add_event_detect, wait_for_edge, cleanup',
  'gpiozero: LED, PWMLED, Button (when_pressed / when_released / when_held), Buzzer, MotionSensor, LineSensor, Servo, AngularServo',
  'time.sleep / time.time / time.monotonic on simulated time, math, random, signal.pause',
  'print() and input() on the Serial Monitor',
];

const PI_RUNTIME = {
  processorProfileId: 'proc.rpi-gpio',
  compileProfileId: 'compile.python-pi',
  runtimeProfileId: 'runtime.python-pi',
  compiler: {
    provider: 'python' as const,
    fqbn: 'python:rpi:gpio',
    supported: true,
    note: 'main.py is checked for syntax in the browser; nothing is compiled or sent to the server.',
  },
  simulation: {
    engine: 'python' as const,
    supported: true,
    supportedApis: PI_SIM_APIS,
    supportedPeripherals: ['GPIO 0-27 with pull-ups and pull-downs', 'software PWM', 'edge detection with bounce time'],
  },
  limitation:
    "Runs main.py's GPIO in CircuitDesk's own Python interpreter on simulated time. It is not a Linux emulator, so " +
    'only the modules listed are available: no pip packages, files, networking, threads of your own, or I2C, SPI and ' +
    'UART from Python (smbus, spidev, pyserial). Statements take simulated time as on a real Pi, so busy loops still let the clock run.',
};

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
  'EEPROM writes go to the simulated flash and last the whole run. ' +
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
        'USART0 (Serial) and USART1-3 (Serial1, Serial2, Serial3)',
        'ADC 16 channels incl. A8-A15 via MUX5',
      ],
    },
    analogPinBase: 54,
    limitation:
      'Runs its own ATmega2560 profile (8 KB SRAM at 0x200, Mega vector table, ports A-L) — never the Uno profile. ' +
      'attachInterrupt on pins 2, 3 and 18-21 and pin-change interrupts (PCINT0-2) use the ATmega2560\'s own vectors. ' +
      'Serial (USART0) and Serial1-Serial3 (USART1-3, on pins 19/18, 17/16 and 15/14) are emulated, each reaching the parts wired to its own pins.',
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
      'analogWrite on D6 and D13 runs on a model of the 32U4\'s own Timer4, at its 490 Hz. ' +
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
      'Real RISC-V execution of the compiled image, with the same peripherals as the DevKitM-1 entry — GPIO and '
      + 'interrupts, floating point, analogRead(), PWM/tone()/servos, Wire, SPI and EEPROM — built through the generic C3 '
      + 'target, so Serial is the UART rather than the native USB port. Wi-Fi and Bluetooth are not simulated — sketches '
      + 'using them compile, run, and do nothing.',
  },
  'board.arduino-due': {
    manufacturer: 'Arduino',
    architecture: 'sam',
    aliases: ['arduino-due', 'due'],
    processorProfileId: 'proc.sam3x8e',
    compileProfileId: 'compile.sam-arduino',
    runtimeProfileId: 'runtime.armv7m-sam3x',
    serverTargetId: 'board.arduino-due',
    // Every label and the SAM3X pad behind it, from the core's variant.cpp.
    padMap: { D0: 'PA8', D1: 'PA9', D2: 'PB25', D3: 'PC28', D4: 'PC26', D5: 'PC25', D6: 'PC24', D7: 'PC23', D8: 'PC22', D9: 'PC21', D10: 'PC29', D11: 'PD7', D12: 'PD8', D13: 'PB27', D14: 'PD4', D15: 'PD5', D16: 'PA13', D17: 'PA12', D18: 'PA11', D19: 'PA10', D20: 'PB12', D21: 'PB13', D22: 'PB26', D23: 'PA14', D24: 'PA15', D25: 'PD0', D26: 'PD1', D27: 'PD2', D28: 'PD3', D29: 'PD6', D30: 'PD9', D31: 'PA7', D32: 'PD10', D33: 'PC1', D34: 'PC2', D35: 'PC3', D36: 'PC4', D37: 'PC5', D38: 'PC6', D39: 'PC7', D40: 'PC8', D41: 'PC9', D42: 'PA19', D43: 'PA20', D44: 'PC19', D45: 'PC18', D46: 'PC17', D47: 'PC16', D48: 'PC15', D49: 'PC14', D50: 'PC13', D51: 'PC12', D52: 'PB21', D53: 'PB14', A0: 'PA16', A1: 'PA24', A2: 'PA23', A3: 'PA22', A4: 'PA6', A5: 'PA4', A6: 'PA3', A7: 'PA2', A8: 'PB17', A9: 'PB18', A10: 'PB19', A11: 'PB20', DAC0: 'PB15', DAC1: 'PB16', CANRX: 'PA1', CANTX: 'PA0', SDA1: 'PA17', SCL1: 'PA18', MISO: 'PA25', MOSI: 'PA26', SCK: 'PA27' },
    compiler: {
      provider: 'arduino-cli',
      fqbn: 'arduino:sam:arduino_due_x_dbg',
      requiredCore: 'arduino:sam',
      supported: true,
      note: 'Built with the Arduino SAM core for the programming port, so Serial is the UART on D0/D1.',
    },
    simulation: {
      engine: 'armv7m',
      supported: true,
      supportedApis: DUE_SIM_APIS,
      supportedPeripherals: DUE_SIM_PERIPHERALS,
    },
    limitation: DUE_LIMITATION,
  },
  'board.arduino-uno-r4': {
    manufacturer: 'Arduino',
    architecture: 'renesas',
    aliases: ['uno-r4', 'uno-r4-minima'],
    processorProfileId: 'proc.ra4m1',
    compileProfileId: 'compile.renesas-uno',
    runtimeProfileId: 'runtime.armv7m-ra4m1',
    serverTargetId: 'board.arduino-uno-r4',
    // Every label and the RA4M1 pad behind it, from the core's variant.cpp.
    padMap: {
      D0: 'P301', D1: 'P302', D2: 'P105', D3: 'P104', D4: 'P103', D5: 'P102', D6: 'P106', D7: 'P107', D8: 'P304', D9: 'P303',
      D10: 'P112', D11: 'P109', D12: 'P110', D13: 'P111', A0: 'P014', A1: 'P000', A2: 'P001', A3: 'P002', A4: 'P101', A5: 'P100',
      SDA: 'P101', SCL: 'P100',
    },
    compiler: {
      provider: 'arduino-cli',
      fqbn: 'arduino:renesas_uno:minima',
      requiredCore: 'arduino:renesas_uno',
      supported: true,
      note: 'Built with the Arduino Renesas core for the Uno R4 Minima, linked above its 16 KB bootloader.',
    },
    simulation: {
      engine: 'armv7m',
      supported: true,
      supportedApis: R4_SIM_APIS,
      supportedPeripherals: R4_SIM_PERIPHERALS,
    },
    limitation: R4_LIMITATION,
  },
  'board.nano-33-ble': {
    manufacturer: 'Arduino',
    architecture: 'nrf52',
    aliases: ['nano-33-ble', 'nano33ble'],
    processorProfileId: 'proc.nrf52840',
    compileProfileId: 'compile.mbed-nano33ble',
    runtimeProfileId: 'runtime.armv7m-nrf52',
    serverTargetId: 'board.nano-33-ble',
    // The header pins and the nRF pads behind them, from the mbed core's variant.
    padMap: {
      TX1: 'P1.03', RX0: 'P1.10', D2: 'P1.11', D3: 'P1.12', D4: 'P1.15', D5: 'P1.13', D6: 'P1.14', D7: 'P0.23',
      D8: 'P0.21', D9: 'P0.27', D10: 'P1.02', D11: 'P1.01', D12: 'P1.08', D13: 'P0.13',
      A0: 'P0.04', A1: 'P0.05', A2: 'P0.30', A3: 'P0.29', A4: 'P0.31', A5: 'P0.02', A6: 'P0.28', A7: 'P0.03',
    },
    compiler: {
      provider: 'arduino-cli',
      fqbn: 'arduino:mbed_nano:nano33ble',
      requiredCore: 'arduino:mbed_nano',
      supported: true,
      note: 'Built with the Arduino mbed core for the Nano 33 BLE; linked at 0x10000, above the bootloader.',
    },
    simulation: {
      engine: 'armv7m',
      supported: true,
      supportedApis: NANO33_SIM_APIS,
      supportedPeripherals: NANO33_SIM_PERIPHERALS,
    },
    limitation: NANO33_LIMITATION,
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
    processorProfileId: 'proc.esp32',
    compileProfileId: 'compile.esp32-arduino',
    runtimeProfileId: 'runtime.esp32',
    serverTargetId: 'board.esp32',
    // Every label and the GPIO behind it, as the DevKit V1 silkscreen prints them.
    padMap: ESP32_DEVKIT_PADS,
    compiler: {
      provider: 'arduino-cli',
      fqbn: 'esp32:esp32:esp32',
      requiredCore: 'esp32:esp32',
      supported: true,
      note: 'Built as the Espressif core\'s "ESP32 Dev Module" — the ESP32-WROOM-32 with 4 MB of flash that the DevKit V1 carries.',
    },
    simulation: {
      engine: 'esp32',
      supported: true,
      supportedApis: ESP32_SIM_APIS,
      supportedPeripherals: ESP32_SIM_PERIPHERALS,
    },
    limitation: ESP32_LIMITATION,
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
    processorProfileId: 'proc.esp32',
    compileProfileId: 'compile.esp32-arduino',
    runtimeProfileId: 'runtime.esp32',
    serverTargetId: 'board.esp32',
    padMap: { IO0: 'GPIO0', IO2: 'GPIO2', IO4: 'GPIO4', IO12: 'GPIO12', IO13: 'GPIO13', IO14: 'GPIO14', IO15: 'GPIO15', IO16: 'GPIO16', U0R: 'GPIO3', U0T: 'GPIO1' },
    compiler: {
      provider: 'arduino-cli',
      fqbn: 'esp32:esp32:esp32',
      requiredCore: 'esp32:esp32',
      supported: true,
      note: 'Built as the Espressif core\'s "ESP32 Dev Module": the same ESP32 chip and 4 MB flash, without the board\'s PSRAM.',
    },
    simulation: {
      engine: 'esp32',
      supported: true,
      supportedApis: ESP32_SIM_APIS,
      supportedPeripherals: ESP32_SIM_PERIPHERALS,
    },
    limitation:
      'The ESP32 runs the compiled sketch exactly as on the DevKit: GPIO, timing, Serial, analogRead(), PWM, Wire and SPI '
      + 'on the pins the module brings out. The OV2640 camera, the microSD slot and the PSRAM are not simulated, so the '
      + 'camera library cannot be used; IO4 drives the module\'s flash LED on the real board. Wi-Fi and Bluetooth are not simulated.',
  },

  // ---------------- STM32 / imxrt / nRF52 ----------------
  'board.stm32-nucleo': {
    manufacturer: 'STMicroelectronics',
    identityNote:
      'Nucleo-64 is a board family sharing one pin layout. This entry models that shared layout rather than one part number; the processor field names the variant it is dimensioned for.',
    architecture: 'stm32',
    aliases: ['nucleo-64', 'nucleo-f401re'],
    processorProfileId: 'proc.stm32f401re',
    compileProfileId: 'compile.stm32-nucleo',
    runtimeProfileId: 'runtime.armv7m-stm32f4',
    serverTargetId: 'board.stm32-nucleo',
    compiler: {
      provider: 'arduino-cli',
      fqbn: 'STMicroelectronics:stm32:Nucleo_64:pnum=NUCLEO_F401RE',
      requiredCore: 'STMicroelectronics:stm32',
      supported: true,
      note: "Built with STMicroelectronics' STM32duino core for the Nucleo-64 F401RE.",
    },
    simulation: {
      engine: 'armv7m',
      supported: true,
      supportedApis: NUCLEO_SIM_APIS,
      supportedPeripherals: NUCLEO_SIM_PERIPHERALS,
    },
    limitation: NUCLEO_LIMITATION,
  },
  'board.teensy41': {
    manufacturer: 'PJRC',
    architecture: 'imxrt',
    aliases: ['teensy-4.1'],
    processorProfileId: 'proc.imxrt1062',
    compileProfileId: 'compile.teensy41',
    runtimeProfileId: 'runtime.armv7m-imxrt',
    serverTargetId: 'board.teensy41',
    // The pins and the GPIO pads behind them, from the Teensy 4 core's core_pins.h.
    padMap: {
      D0: 'GPIO1_03', D1: 'GPIO1_02', D2: 'GPIO4_04', D3: 'GPIO4_05', D4: 'GPIO4_06', D5: 'GPIO4_08', D6: 'GPIO2_10',
      D7: 'GPIO2_17', D8: 'GPIO2_16', D9: 'GPIO2_11', D10: 'GPIO2_00', D11: 'GPIO2_02', D12: 'GPIO2_01', D13: 'GPIO2_03',
      D14: 'GPIO1_18', D15: 'GPIO1_19', D16: 'GPIO1_23', D17: 'GPIO1_22', D18: 'GPIO1_17', D19: 'GPIO1_16', D20: 'GPIO1_26',
      D21: 'GPIO1_27', D22: 'GPIO1_24', D23: 'GPIO1_25', D24: 'GPIO1_12', D25: 'GPIO1_13', D26: 'GPIO1_30', D27: 'GPIO1_31',
      D28: 'GPIO3_18', D29: 'GPIO4_31', D30: 'GPIO3_23', D31: 'GPIO3_22', D32: 'GPIO2_12', D33: 'GPIO4_07', D34: 'GPIO2_29',
      D35: 'GPIO2_28', D36: 'GPIO2_18', D37: 'GPIO2_19', D38: 'GPIO1_28', D39: 'GPIO1_29', D40: 'GPIO1_20', D41: 'GPIO1_21',
    },
    compiler: {
      provider: 'arduino-cli',
      fqbn: 'teensy:avr:teensy41:speed=60',
      requiredCore: 'teensy:avr',
      supported: true,
      note: "Built with the Teensy 4 core at its 60 MHz speed setting, so the simulation keeps pace with real time; timing functions are exact at any speed.",
    },
    simulation: {
      engine: 'armv7m',
      supported: true,
      supportedApis: TEENSY41_SIM_APIS,
      supportedPeripherals: TEENSY41_SIM_PERIPHERALS,
    },
    limitation: TEENSY41_LIMITATION,
  },
  'board.microbit': {
    manufacturer: 'Micro:bit Educational Foundation',
    identityNote:
      'Originated by the BBC and now produced by the Micro:bit Educational Foundation, which is why the brand and the maker differ.',
    architecture: 'nrf52',
    aliases: ['micro:bit', 'microbit-v2'],
    processorProfileId: 'proc.nrf52833',
    compileProfileId: 'compile.nrf5-microbit',
    runtimeProfileId: 'runtime.armv7m-nrf52',
    serverTargetId: 'board.microbit',
    // Edge pins and the nRF pads behind them, from the nRF5 core's variant.
    padMap: {
      P0: 'P0.02', P1: 'P0.03', P2: 'P0.04', P3: 'P0.31', P4: 'P0.28', P5: 'P0.14', P6: 'P1.05', P7: 'P0.11',
      P8: 'P0.10', P9: 'P0.09', P10: 'P0.30', P11: 'P0.23', P12: 'P0.12', P13: 'P0.17', P14: 'P0.01', P15: 'P0.13',
      P16: 'P1.02', P19: 'P0.26', P20: 'P1.00',
    },
    compiler: {
      provider: 'arduino-cli',
      fqbn: 'sandeepmistry:nRF5:BBCmicrobitV2',
      requiredCore: 'sandeepmistry:nRF5',
      supported: true,
      note: "Built with the Arduino nRF5 core's micro:bit V2 target.",
    },
    simulation: {
      engine: 'armv7m',
      supported: true,
      supportedApis: MICROBIT_SIM_APIS,
      supportedPeripherals: NRF52_SIM_PERIPHERALS,
    },
    limitation: MICROBIT_LIMITATION,
  },

  // ---------------- Linux SBC headers ----------------
  'board.rpi-zero-gpio': {
    manufacturer: 'Raspberry Pi',
    architecture: 'linux',
    aliases: ['raspberry-pi-zero'],
    ...PI_RUNTIME,
  },
  'board.rpi4-gpio': {
    manufacturer: 'Raspberry Pi',
    architecture: 'linux',
    aliases: ['raspberry-pi-4', 'raspberry-pi-5'],
    ...PI_RUNTIME,
  },
};
