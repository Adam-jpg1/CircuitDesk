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
export type ArtifactFormat = 'intel-hex' | 'uf2' | 'bin' | 'elf' | 'esp-image';

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
  adapter: 'arduino-cli' | 'none';
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
  serverTargetId?: string;
  artifactFormat: ArtifactFormat;
  /** Libraries this profile guarantees are installed. */
  libraries?: string[];
  description: string;
}

export interface RuntimeProfile {
  id: string;
  name: string;
  /** The emulator that executes the artifact. */
  engine: 'avr8js' | 'rp2040js' | 'esp32c3' | 'esp32c6' | 'none';
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
    id: 'compile.avr-arduino',
    name: 'Arduino AVR',
    adapter: 'arduino-cli',
    processorProfileIds: ['proc.atmega328p'],
    requiredCore: 'arduino:avr',
    fqbn: 'arduino:avr:uno',
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
    description: 'Executes ATmega32U4 firmware on avr8js. Native USB is not emulated.',
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
    supportedPeripherals: ['SIO GPIO', 'ADC', 'PWM slices', 'UART0/1', 'I2C0/1', 'SPI0/1', 'timers'],
    description: 'Executes RP2040 UF2 images on rp2040js. PIO, USB and the second core are not modelled.',
  },
  {
    id: 'runtime.esp32c3',
    name: 'CircuitDesk ESP32-C3',
    engine: 'esp32c3',
    processorProfileIds: ['proc.esp32c3'],
    acceptsFormats: ['esp-image'],
    supportedApis: ['pinMode', 'digitalWrite', 'digitalRead', 'delay/millis/micros'],
    supportedPeripherals: ['GPIO matrix', 'system timer'],
    description: 'Executes ESP32-C3 application images on the CircuitDesk RISC-V core. GPIO only.',
  },
  {
    id: 'runtime.esp32c6',
    name: 'CircuitDesk ESP32-C6',
    engine: 'esp32c6',
    processorProfileIds: ['proc.esp32c6'],
    acceptsFormats: ['esp-image'],
    supportedApis: ['pinMode', 'digitalWrite', 'digitalRead', 'delay/millis/micros'],
    supportedPeripherals: ['GPIO matrix', 'system timer'],
    description: 'Executes ESP32-C6 application images on the CircuitDesk RISC-V core. GPIO only.',
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
