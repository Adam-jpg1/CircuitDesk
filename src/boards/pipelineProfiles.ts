// The two halves of "can this board run", kept apart on purpose.
//
// A COMPILE profile turns source into an artifact: a toolchain, a target, and
// the format it emits. A RUNTIME profile turns an artifact into a running
// machine: an emulator and the processor it executes. They are separate because
// they genuinely can be — a board may compile perfectly and have no runtime,
// which is the honest state for most of the library, and modelling that as one
// opaque "pipeline" would force a board to claim both or neither.
//
// The rule that makes this safe: a runtime profile declares the ARTIFACT FORMAT
// it accepts and the PROCESSOR it executes. A board whose compile profile emits
// a format its runtime does not accept is refused with both named, rather than
// discovering it inside an emulator.
//
// Nothing here names a board. That is the whole point: `pipe.rp2040-arduino`
// compiles for the RP2040, and a Raspberry Pi Pico and somebody's own RP2040
// board are equally entitled to use it.

import type { ProcessorArchitecture } from './processorProfiles';

/** Artifact formats the pipeline system can represent. */
export type ArtifactFormat = 'intel-hex' | 'uf2' | 'bin' | 'elf' | 'esp-image' | 'python';

export interface CompileProfile {
  id: string;
  name: string;
  /**
   * How the artifact is produced.
   *
   * `arduino-cli` is the only adapter that executes anything today, and it does
   * so only against the server's own allowlist of targets. `none` is a real
   * choice, not a failure: a board can be wiring-only and still be a board.
   */
  adapter: 'arduino-cli' | 'python' | 'none';
  /** Processor profiles this compile profile targets. */
  processorProfileIds: string[];
  /** arduino-cli core the compiler service must have installed. */
  requiredCore?: string;
  /**
   * The DEFAULT target within this toolchain, used by boards that do not pin
   * their own.
   *
   * A profile is a family — a core, a processor and an artifact format — and a
   * board may name a more specific variant inside it. An Arduino Nano and a
   * custom ATmega328P board both use the Arduino AVR profile; the Nano pins
   * `arduino:avr:nano` on its own definition, and the custom board takes this.
   */
  fqbn?: string;
  /**
   * The compile target the SERVER knows the default FQBN by.
   *
   * The server has its own strict allowlist and refuses anything not on it, so
   * a custom board compiles by naming the target its pipeline uses — never its
   * own id, which the server has correctly never heard of. Boards that pin
   * their own FQBN name their own server target instead.
   */
  /**
   * Other build targets this same chip may be built as.
   *
   * A real need — an RP2040 board that wants the Pico W variant, a 328P board
   * that wants the Nano's bootloader — and a deliberately short list. Every
   * entry must be the SAME processor: a target for another chip would produce
   * firmware the runtime cannot execute, and an override is a text field, not a
   * place to redefine what the board is. The compiler service enforces the same
   * rule independently, because this list is client-side and the service is the
   * trust boundary.
   */
  alternateFqbns?: string[];
  serverTargetId?: string;
  artifactFormat: ArtifactFormat;
  /**
   * Flags and macros this profile adds to every build.
   *
   * Part of the compile fingerprint, which is what stops two profiles that
   * target the same FQBN with different flags from sharing an artifact.
   */
  buildFlags?: string[];
  /** Libraries this profile guarantees are installed. */
  libraries?: string[];
  description: string;
}

export interface RuntimeProfile {
  id: string;
  name: string;
  /** The emulator that executes the artifact. */
  engine: 'avr8js' | 'rp2040js' | 'esp32' | 'esp32s3' | 'esp32c3' | 'esp32c6' | 'samd21' | 'armv7m' | 'python' | 'none';
  /** Processor profiles this runtime can genuinely execute. */
  processorProfileIds: string[];
  /** Formats the engine accepts. An artifact of any other format is refused. */
  acceptsFormats: ArtifactFormat[];
  /**
   * What this runtime genuinely does, exercised by tests.
   *
   * Inherited by every board that selects it, custom or native. A board cannot
   * add to this list — that is what stops an importer from typing "Simulated".
   */
  supportedApis: string[];
  supportedPeripherals: string[];
  description: string;
}

// -------------------------------------------------------- compile profiles --

export const COMPILE_PROFILES: CompileProfile[] = [
  {
    id: 'compile.nrf5-microbit',
    name: 'Arduino nRF5 (nRF52833)',
    adapter: 'arduino-cli',
    processorProfileIds: ['proc.nrf52833'],
    requiredCore: 'sandeepmistry:nRF5',
    fqbn: 'sandeepmistry:nRF5:BBCmicrobitV2',
    serverTargetId: 'board.microbit',
    artifactFormat: 'bin',
    description: 'The Arduino nRF5 core for the BBC micro:bit V2. Emits a raw binary linked at 0, the start of flash.',
  },
  {
    id: 'compile.mbed-nano33ble',
    name: 'Arduino mbed (nRF52840)',
    adapter: 'arduino-cli',
    processorProfileIds: ['proc.nrf52840'],
    requiredCore: 'arduino:mbed_nano',
    fqbn: 'arduino:mbed_nano:nano33ble',
    serverTargetId: 'board.nano-33-ble',
    artifactFormat: 'bin',
    description: 'The Arduino mbed core for the Nano 33 BLE. Emits a raw binary linked at 0x10000, above the board\'s bootloader.',
  },
  {
    id: 'compile.teensy41',
    name: 'Teensy 4 (i.MX RT1062)',
    adapter: 'arduino-cli',
    processorProfileIds: ['proc.imxrt1062'],
    requiredCore: 'teensy:avr',
    fqbn: 'teensy:avr:teensy41:speed=60',
    serverTargetId: 'board.teensy41',
    artifactFormat: 'bin',
    description: 'The Teensy 4 core for the Teensy 4.1 at its 60 MHz setting. Emits the flash image from 0x60000000, boot header and image vector table included.',
  },
  {
    id: 'compile.python-pi',
    name: 'Python (Raspberry Pi GPIO)',
    adapter: 'python',
    processorProfileIds: ['proc.rpi-gpio'],
    fqbn: 'python:rpi:gpio',
    serverTargetId: 'board.rpi-gpio',
    artifactFormat: 'python',
    description: 'A Python script for the Pi\'s GPIO header. Checked for syntax in the browser; nothing is sent to the compiler service.',
  },
  {
    id: 'compile.renesas-uno',
    name: 'Arduino Renesas (RA4M1)',
    adapter: 'arduino-cli',
    processorProfileIds: ['proc.ra4m1'],
    requiredCore: 'arduino:renesas_uno',
    fqbn: 'arduino:renesas_uno:minima',
    serverTargetId: 'board.arduino-uno-r4',
    artifactFormat: 'bin',
    description: 'The Arduino Renesas core for the Uno R4 Minima. Emits a raw binary linked at 0x4000, above the bootloader.',
  },
  {
    id: 'compile.stm32-nucleo',
    name: 'STM32duino (STM32F401RE)',
    adapter: 'arduino-cli',
    processorProfileIds: ['proc.stm32f401re'],
    requiredCore: 'STMicroelectronics:stm32',
    fqbn: 'STMicroelectronics:stm32:Nucleo_64:pnum=NUCLEO_F401RE',
    serverTargetId: 'board.stm32-nucleo',
    artifactFormat: 'bin',
    description: "STMicroelectronics' STM32duino core for the Nucleo-64 F401RE. Emits a raw binary linked at 0x08000000, the start of flash.",
  },
  {
    id: 'compile.sam-arduino',
    name: 'Arduino SAM (SAM3X8E)',
    adapter: 'arduino-cli',
    processorProfileIds: ['proc.sam3x8e'],
    requiredCore: 'arduino:sam',
    fqbn: 'arduino:sam:arduino_due_x_dbg',
    serverTargetId: 'board.arduino-due',
    artifactFormat: 'bin',
    description: "The Arduino SAM core for the Due's programming port. Emits a raw binary linked at 0x80000, the start of flash.",
  },
  {
    id: 'compile.samd21-adafruit',
    name: 'Adafruit SAMD (SAMD21)',
    adapter: 'arduino-cli',
    processorProfileIds: ['proc.samd21'],
    requiredCore: 'adafruit:samd',
    fqbn: 'adafruit:samd:adafruit_feather_m0',
    alternateFqbns: ['adafruit:samd:adafruit_qtpy_m0'],
    serverTargetId: 'board.adafruit-feather',
    artifactFormat: 'intel-hex',
    description:
      'Adafruit\'s SAMD core, built for a SAMD21. Emits Intel HEX linked at 0x2000, above the boards\' bootloader.',
  },
  {
    id: 'compile.samd21-seeed',
    name: 'Seeed SAMD (SAMD21)',
    adapter: 'arduino-cli',
    processorProfileIds: ['proc.samd21'],
    requiredCore: 'Seeeduino:samd',
    fqbn: 'Seeeduino:samd:seeed_XIAO_m0',
    serverTargetId: 'board.seeed-xiao',
    artifactFormat: 'intel-hex',
    description: 'Seeed\'s SAMD core, built for the XIAO SAMD21. Emits Intel HEX linked at 0x2000, above its bootloader.',
  },
  {
    id: 'compile.avr-arduino',
    name: 'Arduino AVR',
    adapter: 'arduino-cli',
    processorProfileIds: ['proc.atmega328p'],
    requiredCore: 'arduino:avr',
    fqbn: 'arduino:avr:uno',
    alternateFqbns: ['arduino:avr:nano'],
    serverTargetId: 'board.arduino-uno',
    artifactFormat: 'intel-hex',
    libraries: ['Servo'],
    description:
      'The Arduino AVR core, built for an ATmega328P at 16 MHz. Emits Intel HEX. ' +
      'Any board carrying that chip can use it — the target is the processor, not a product.',
  },
  {
    id: 'compile.avr-arduino-mega',
    name: 'Arduino AVR (ATmega2560)',
    adapter: 'arduino-cli',
    processorProfileIds: ['proc.atmega2560'],
    requiredCore: 'arduino:avr',
    fqbn: 'arduino:avr:mega',
    serverTargetId: 'board.arduino-mega2560',
    artifactFormat: 'intel-hex',
    libraries: ['Servo'],
    description: 'The Arduino AVR core built for an ATmega2560. Emits Intel HEX.',
  },
  {
    id: 'compile.avr-arduino-32u4',
    name: 'Arduino AVR (ATmega32U4)',
    adapter: 'arduino-cli',
    processorProfileIds: ['proc.atmega32u4'],
    requiredCore: 'arduino:avr',
    fqbn: 'arduino:avr:leonardo',
    serverTargetId: 'board.arduino-leonardo',
    artifactFormat: 'intel-hex',
    libraries: ['Servo'],
    description: 'The Arduino AVR core built for an ATmega32U4. Emits Intel HEX.',
  },
  {
    id: 'compile.rp2040-arduino',
    name: 'Arduino-Pico (RP2040)',
    adapter: 'arduino-cli',
    processorProfileIds: ['proc.rp2040'],
    requiredCore: 'rp2040:rp2040',
    fqbn: 'rp2040:rp2040:rpipico',
    alternateFqbns: ['rp2040:rp2040:rpipicow'],
    serverTargetId: 'board.raspberry-pi-pico',
    artifactFormat: 'uf2',
    libraries: ['Servo'],
    description:
      'The Arduino-Pico core, built for an RP2040. Emits UF2. The FQBN names a Pico because that is ' +
      'the core\'s generic RP2040 target — the board using this profile keeps its own identity.',
  },
  {
    id: 'compile.esp32c3-arduino',
    name: 'Arduino ESP32 (C3)',
    adapter: 'arduino-cli',
    processorProfileIds: ['proc.esp32c3'],
    requiredCore: 'esp32:esp32',
    fqbn: 'esp32:esp32:esp32c3',
    serverTargetId: 'board.esp32-c3',
    artifactFormat: 'esp-image',
    libraries: ['ESP32Servo'],
    description: 'The Espressif Arduino core built for an ESP32-C3. Emits an ESP application image.',
  },
  {
    id: 'compile.esp32-arduino',
    name: 'Arduino ESP32',
    adapter: 'arduino-cli',
    processorProfileIds: ['proc.esp32'],
    requiredCore: 'esp32:esp32',
    fqbn: 'esp32:esp32:esp32',
    serverTargetId: 'board.esp32',
    artifactFormat: 'esp-image',
    libraries: [],
    description: 'The Espressif Arduino core built for the ESP32 (ESP32 Dev Module). Emits an ESP application image.',
  },
  {
    id: 'compile.esp32s3-arduino',
    name: 'Arduino ESP32 (S3)',
    adapter: 'arduino-cli',
    processorProfileIds: ['proc.esp32s3'],
    requiredCore: 'esp32:esp32',
    fqbn: 'esp32:esp32:esp32s3',
    serverTargetId: 'board.esp32-s3',
    artifactFormat: 'esp-image',
    libraries: [],
    description: 'The Espressif Arduino core built for the ESP32-S3 (ESP32S3 Dev Module). Emits an ESP application image.',
  },
  {
    id: 'compile.esp32c6-arduino',
    name: 'Arduino ESP32 (C6)',
    adapter: 'arduino-cli',
    processorProfileIds: ['proc.esp32c6'],
    requiredCore: 'esp32:esp32',
    fqbn: 'esp32:esp32:esp32c6',
    serverTargetId: 'board.esp32-c6-devkitc-1',
    artifactFormat: 'esp-image',
    libraries: ['ESP32Servo'],
    description: 'The Espressif Arduino core built for an ESP32-C6. Emits an ESP application image.',
  },
  {
    id: 'compile.none',
    name: 'No compilation',
    adapter: 'none',
    processorProfileIds: [],
    artifactFormat: 'bin',
    description:
      'For boards that exist to be wired and validated. Nothing is compiled, and Run says so ' +
      'rather than building for a processor the board does not have.',
  },
];

// -------------------------------------------------------- runtime profiles --

const AVR_APIS = [
  'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogWrite (PWM)',
  'delay/millis/micros', 'Serial (UART both directions)', 'timers', 'external interrupts',
];

export const RUNTIME_PROFILES: RuntimeProfile[] = [
  {
    id: 'runtime.python-pi',
    name: 'CircuitDesk Python (Raspberry Pi GPIO)',
    engine: 'python',
    processorProfileIds: ['proc.rpi-gpio'],
    acceptsFormats: ['python'],
    supportedApis: [
      'RPi.GPIO: setmode, setup, output, input, PWM, add_event_detect, wait_for_edge, cleanup',
      'gpiozero: LED, PWMLED, Button, Buzzer, MotionSensor, LineSensor, Servo, AngularServo, digital devices',
      'time, math, random, signal.pause, print and input on the Serial Monitor',
    ],
    supportedPeripherals: ['GPIO 0-27', 'software PWM', 'edge detection'],
    description:
      "Runs a Raspberry Pi GPIO script in CircuitDesk's own Python interpreter on simulated time. Not a Linux emulator: " +
      'the script\'s GPIO is what is simulated, through RPi.GPIO and gpiozero.',
  },
  {
    id: 'runtime.armv7m-imxrt',
    name: 'CircuitDesk ARMv7-M (i.MX RT1062)',
    engine: 'armv7m',
    processorProfileIds: ['proc.imxrt1062'],
    acceptsFormats: ['bin'],
    supportedApis: [
      'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogWrite', 'Wire', 'SPI', 'delay/millis/micros',
      'Serial (USB CDC)', 'Serial1', 'attachInterrupt',
    ],
    supportedPeripherals: ['GPIO', 'IOMUXC', 'ADC', 'FlexPWM', 'QuadTimer', 'LPUART', 'LPI2C', 'LPSPI', 'USB'],
    description:
      "Executes i.MX RT1062 firmware on CircuitDesk's ARMv7-M core (Cortex-M7, double-precision FPU) with a model of the " +
      'parts the Teensy 4 core uses: clocks, IOMUXC, GPIO, ADC, FlexPWM and QuadTimer, LPUART6, LPI2C1, LPSPI4 and USB.',
  },
  {
    id: 'runtime.armv7m-nrf52',
    name: 'CircuitDesk ARMv7-M (nRF52)',
    engine: 'armv7m',
    processorProfileIds: ['proc.nrf52833', 'proc.nrf52840'],
    acceptsFormats: ['bin'],
    supportedApis: [
      'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogWrite', 'Wire', 'SPI', 'delay/millis/micros',
      'Serial (UART)', 'Serial (USB CDC, nRF52840)', 'attachInterrupt', 'LED matrix', 'buttons A/B',
    ],
    supportedPeripherals: ['GPIO', 'GPIOTE', 'RTC', 'TIMER', 'UART', 'SAADC', 'PWM', 'TWI', 'SPI', 'USBD (nRF52840)'],
    description:
      "Executes nRF52 firmware on CircuitDesk's ARMv7-M core with an nRF52833 or nRF52840 model: clocks, RTC, timers, GPIO and " +
      'GPIOTE, UART, SAADC, PWM, TWI and SPI, and on the nRF52840 the USB device controller.',
  },
  {
    id: 'runtime.armv7m-ra4m1',
    name: 'CircuitDesk ARMv7-M (RA4M1)',
    engine: 'armv7m',
    processorProfileIds: ['proc.ra4m1'],
    acceptsFormats: ['bin'],
    supportedApis: [
      'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogWrite', 'Wire', 'SPI', 'delay/millis/micros',
      'Serial (native USB)', 'Serial1 (SCI2)', 'attachInterrupt', 'Servo', 'tone', 'EEPROM',
    ],
    supportedPeripherals: ['PORT/PFS', 'ICU', 'AGT', 'SCI', 'GPT', 'ADC', 'IIC', 'SPI', 'USBFS'],
    description:
      "Executes Arduino Uno R4 firmware on CircuitDesk's ARMv7-M core with an RA4M1 model: ICU, PORT, AGT, SCI, GPT, " +
      'ADC, IIC, SPI and the USB device controller.',
  },
  {
    id: 'runtime.armv7m-stm32f4',
    name: 'CircuitDesk ARMv7-M (STM32F401RE)',
    engine: 'armv7m',
    processorProfileIds: ['proc.stm32f401re'],
    acceptsFormats: ['bin'],
    supportedApis: [
      'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogWrite', 'tone', 'Wire', 'SPI', 'delay/millis/micros',
      'Serial (USART2)', 'Uart on USART1/USART6', 'attachInterrupt', 'Servo', 'EEPROM', 'HardwareTimer',
    ],
    supportedPeripherals: ['GPIO', 'EXTI', 'SysTick', 'USART', 'TIM', 'ADC', 'I2C', 'SPI', 'FLASH'],
    description:
      "Executes STM32duino firmware on CircuitDesk's ARMv7-M core with an STM32F401RE model: RCC, GPIO, EXTI, USARTs, " +
      'timers, ADC, I2C, SPI and flash programming.',
  },
  {
    id: 'runtime.armv7m-sam3x',
    name: 'CircuitDesk ARMv7-M (SAM3X8E)',
    engine: 'armv7m',
    processorProfileIds: ['proc.sam3x8e'],
    acceptsFormats: ['bin'],
    supportedApis: [
      'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogWrite', 'Wire', 'Wire1', 'SPI', 'delay/millis/micros',
      'Serial (UART)', 'Serial1-Serial3 (USART)', 'attachInterrupt', 'Servo',
    ],
    supportedPeripherals: ['PIO', 'SysTick', 'UART/USART', 'TC', 'PWM', 'ADC', 'TWI', 'SPI'],
    description:
      "Executes Arduino Due firmware on CircuitDesk's ARMv7-M core with a SAM3X8E model: PMC, PIO, UART and USARTs, " +
      'timer counters, PWM, ADC, TWI and SPI.',
  },
  {
    id: 'runtime.samd21',
    name: 'CircuitDesk SAMD21',
    engine: 'samd21',
    processorProfileIds: ['proc.samd21'],
    acceptsFormats: ['intel-hex'],
    supportedApis: [
      'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogWrite', 'Wire', 'SPI', 'delay/millis/micros',
      'Serial (native USB CDC, both directions)', 'Serial1 (the hardware UART, both directions)',
    ],
    supportedPeripherals: ['PORT GPIO', 'SysTick', 'ADC', 'TCC/TC PWM', 'USB device (CDC)', 'SERCOM USART (Serial1)', 'SERCOM I2C and SPI master'],
    description:
      'Executes SAMD21 firmware on rp2040js\'s Cortex-M0+ core with a SAMD21 chip model: PORT, the clock and NVM ' +
      'flags startup waits on, SysTick, the ADC and the USB device with a host on the CDC port.',
  },
  {
    id: 'runtime.avr8js-328p',
    name: 'CircuitDesk AVR (ATmega328P)',
    engine: 'avr8js',
    processorProfileIds: ['proc.atmega328p'],
    acceptsFormats: ['intel-hex'],
    supportedApis: AVR_APIS,
    supportedPeripherals: ['GPIO ports', 'Timer0/1/2', 'USART0', 'ADC'],
    description: 'Executes ATmega328P firmware on avr8js with the 328P memory map and vector table.',
  },
  {
    id: 'runtime.avr8js-2560',
    name: 'CircuitDesk AVR (ATmega2560)',
    engine: 'avr8js',
    processorProfileIds: ['proc.atmega2560'],
    acceptsFormats: ['intel-hex'],
    supportedApis: AVR_APIS.filter((a) => a !== 'external interrupts'),
    supportedPeripherals: [
      'GPIO ports A-L',
      'Timer0/1/2 plus Timer3/4/5',
      'USART0 (Serial)',
      'ADC 16 channels',
    ],
    description: 'Executes ATmega2560 firmware on avr8js with the 2560 memory map — never the 328P profile.',
  },
  {
    id: 'runtime.avr8js-32u4',
    name: 'CircuitDesk AVR (ATmega32U4)',
    engine: 'avr8js',
    processorProfileIds: ['proc.atmega32u4'],
    acceptsFormats: ['intel-hex'],
    supportedApis: [
      'pinMode', 'digitalWrite', 'digitalRead', 'analogRead (A0-A5)',
      'analogWrite (PWM on the Timer0/1/3 pads)', 'delay/millis/micros',
      'Serial1 (hardware UART)', 'timers',
    ],
    supportedPeripherals: ['GPIO ports B/C/D/E/F', 'Timer0, Timer1, Timer3', 'USART1', 'ADC channels 0-7'],
    description: 'Executes ATmega32U4 firmware on avr8js, with the 32U4 USB controller serving the CDC serial port.',
  },
  {
    id: 'runtime.rp2040js',
    name: 'CircuitDesk RP2040',
    engine: 'rp2040js',
    processorProfileIds: ['proc.rp2040'],
    acceptsFormats: ['uf2'],
    supportedApis: [
      'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogWrite (PWM)',
      'delay/millis/micros', 'Serial1 (hardware UART)', 'Wire (I2C)', 'SPI',
    ],
    supportedPeripherals: ['SIO GPIO', 'ADC', 'PWM slices', 'PIO', 'UART0/1', 'I2C0/1', 'SPI0/1', 'timers'],
    description: 'Executes RP2040 UF2 images on rp2040js, with a USB host on the CDC serial port and PIO on the simulated clock. Other USB classes and the second core are not modelled.',
  },
  {
    id: 'runtime.esp32c3',
    name: 'CircuitDesk ESP32-C3',
    engine: 'esp32c3',
    processorProfileIds: ['proc.esp32c3'],
    acceptsFormats: ['esp-image'],
    supportedApis: [
      'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'delay/millis/micros', 'Serial (UART0)',
      'floating point', 'analogWrite (PWM)', 'tone()', 'Servo (ESP32Servo)', 'attachInterrupt', 'Wire', 'SPI', 'EEPROM',
    ],
    supportedPeripherals: ['GPIO matrix', 'GPIO interrupts', 'system timer', 'UART0', 'SAR ADC (one-shot)', 'LED PWM controller', 'I2C0 (master)', 'GP-SPI2 (master)', 'NVS on SPI flash'],
    description: 'Executes ESP32-C3 application images on the CircuitDesk RISC-V core: GPIO, UART0, the ADC, LED PWM, I2C, SPI and NVS.',
  },
  {
    id: 'runtime.esp32',
    name: 'CircuitDesk ESP32',
    engine: 'esp32',
    processorProfileIds: ['proc.esp32'],
    acceptsFormats: ['esp-image'],
    supportedApis: [
      'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'delay/millis/micros', 'Serial (UART0)',
      'floating point', 'analogWrite (PWM)', 'tone()', 'Servo (ESP32Servo)', 'attachInterrupt', 'Wire', 'SPI',
    ],
    supportedPeripherals: ['both Xtensa LX6 cores', 'GPIO matrix', 'GPIO interrupts', 'timer groups', 'UART0', 'SAR ADC1/ADC2 (one-shot)', 'LED PWM controller', 'I2C0/I2C1 (master)', 'HSPI/VSPI (master)'],
    description: 'Executes ESP32 application images on the CircuitDesk Xtensa core, both CPUs, under ESP-IDF\'s own FreeRTOS: GPIO, UART0, the ADC, LED PWM, I2C and SPI.',
  },
  {
    id: 'runtime.esp32s3',
    name: 'CircuitDesk ESP32-S3',
    engine: 'esp32s3',
    processorProfileIds: ['proc.esp32s3'],
    acceptsFormats: ['esp-image'],
    supportedApis: [
      'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'delay/millis/micros', 'Serial (UART0)',
      'floating point', 'analogWrite (PWM)', 'tone()', 'Servo (ESP32Servo)', 'attachInterrupt', 'Wire', 'SPI',
    ],
    supportedPeripherals: ['both Xtensa LX7 cores', 'GPIO matrix', 'GPIO interrupts', 'system timer', 'timer groups', 'UART0/UART1', 'SAR ADC1/ADC2 (one-shot)', 'LED PWM controller', 'I2C0/I2C1 (master)', 'GP-SPI2/SPI3 (master)'],
    description: 'Executes ESP32-S3 application images on the CircuitDesk Xtensa core, both CPUs, under ESP-IDF\'s own FreeRTOS.',
  },
  {
    id: 'runtime.esp32c6',
    name: 'CircuitDesk ESP32-C6',
    engine: 'esp32c6',
    processorProfileIds: ['proc.esp32c6'],
    acceptsFormats: ['esp-image'],
    supportedApis: [
      'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'delay/millis/micros', 'Serial (UART0)',
      'floating point', 'analogWrite (PWM)', 'tone()', 'Servo (ESP32Servo)', 'attachInterrupt', 'Wire', 'SPI', 'EEPROM',
    ],
    supportedPeripherals: ['GPIO matrix', 'GPIO interrupts', 'system timer', 'UART0', 'SAR ADC (one-shot)', 'LED PWM controller', 'I2C0 (master)', 'GP-SPI2 (master)', 'NVS on SPI flash'],
    description: 'Executes ESP32-C6 application images on the CircuitDesk RISC-V core (RV32IMAC): GPIO, UART0, the ADC, LED PWM, I2C, SPI and NVS.',
  },
  {
    id: 'runtime.none',
    name: 'No simulation',
    engine: 'none',
    processorProfileIds: [],
    acceptsFormats: [],
    supportedApis: [],
    supportedPeripherals: [],
    description:
      'The board wires and validates but does not execute. Run says exactly that, rather than ' +
      'running the sketch on some other processor.',
  },
];

export function compileProfile(id: string): CompileProfile | undefined {
  return COMPILE_PROFILES.find((p) => p.id === id);
}

export function runtimeProfile(id: string): RuntimeProfile | undefined {
  return RUNTIME_PROFILES.find((p) => p.id === id);
}

/** Compile profiles that can build for a processor. */
export function compileProfilesFor(processorProfileId: string): CompileProfile[] {
  return COMPILE_PROFILES.filter((p) => p.processorProfileIds.includes(processorProfileId));
}

/** Runtime profiles that can execute a processor. */
export function runtimeProfilesFor(processorProfileId: string): RuntimeProfile[] {
  return RUNTIME_PROFILES.filter((p) => p.processorProfileIds.includes(processorProfileId));
}

export interface PipelineMismatch {
  code: 'processor-not-compilable' | 'processor-not-runnable' | 'artifact-format';
  message: string;
}

/**
 * Whether a processor, a compile profile and a runtime profile fit together.
 *
 * The artifact-format check is the one that earns its keep: a compile profile
 * emitting Intel HEX and a runtime accepting UF2 is a combination that looks
 * fine in a form and fails inside an emulator, so it is refused here with both
 * halves named.
 */
export function checkPipeline(
  processorProfileId: string,
  compile: CompileProfile,
  runtime: RuntimeProfile,
): PipelineMismatch[] {
  const problems: PipelineMismatch[] = [];
  if (compile.adapter !== 'none' && !compile.processorProfileIds.includes(processorProfileId)) {
    problems.push({
      code: 'processor-not-compilable',
      message: `${compile.name} does not build for this processor. It targets ${compile.processorProfileIds.join(', ') || 'nothing'}.`,
    });
  }
  if (runtime.engine !== 'none' && !runtime.processorProfileIds.includes(processorProfileId)) {
    problems.push({
      code: 'processor-not-runnable',
      message: `${runtime.name} cannot execute this processor. It runs ${runtime.processorProfileIds.join(', ') || 'nothing'}.`,
    });
  }
  if (runtime.engine !== 'none' && compile.adapter !== 'none' && !runtime.acceptsFormats.includes(compile.artifactFormat)) {
    problems.push({
      code: 'artifact-format',
      message:
        `${runtime.name} accepts ${runtime.acceptsFormats.join(' or ')} artifacts, ` +
        `but ${compile.name} outputs ${compile.artifactFormat}.`,
    });
  }
  return problems;
}
