export interface CodeFilePayload {
  name: string;
  content: string;
}

export interface CompileRequest {
  projectId?: string;
  /** Canonical board id (preferred) or FQBN; resolved against the strict allowlist. */
  boardId?: string;
  fqbn: string;
  files: CodeFilePayload[];
}

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'note';
  message: string;
}

export interface MemoryUsage {
  flashBytes: number;
  flashMaxBytes: number;
  ramBytes: number;
  ramMaxBytes: number;
}

export interface CompileResult {
  success: boolean;
  toolchain: 'arduino-cli' | 'avr-gcc' | 'none';
  toolchainVersion: string;
  stdout: string;
  stderr: string;
  diagnostics: Diagnostic[];
  firmware?: {
    format: 'intel-hex' | 'uf2' | 'bin' | 'esp-image';
    /** intel-hex is plain text; uf2/bin are base64. */
    data: string;
    /**
     * Other regions the toolchain places in flash, at their real offsets.
     *
     * An ESP build's executed artifact is the application image, but the chip
     * also reads its partition table out of flash before it will run anything,
     * so the parts that are not executed still have to be there. Each entry is
     * base64. Absent for targets whose firmware is the whole flash.
     */
    regions?: { offset: number; data: string }[];
  };
  memory?: MemoryUsage;
  /**
   * Things that are true about this build that the compiler cannot say.
   *
   * Chiefly: a library that compiles for this target and then does nothing,
   * because CircuitDesk does not model the peripheral it drives. That is not a
   * compiler diagnostic — the build is genuinely fine — but it is the single
   * most confusing state a simulator can leave a user in, so it travels with
   * the result instead of being discovered by staring at a motionless servo.
   */
  simulationNotes?: {
    header: string;
    kind: 'unsupported' | 'no-effect';
    reason: string;
    alternative?: string;
    workaround?: string;
  }[];
  durationMs: number;
  /**
   * Where the time went, in milliseconds, measured rather than estimated.
   *
   * Present on every build so a slow one can be explained without re-running it
   * under a profiler: "the ESP32 is slow" and "arduino-cli spends half a second
   * loading platforms before it compiles anything" are different problems with
   * different fixes, and only one of them is ours.
   */
  timings?: {
    /** Writing the sketch and its files to the build directory. */
    prepareMs: number;
    /** The arduino-cli process, wall clock. */
    compileMs: number;
    /** Reading the artifacts back and base64-encoding them. */
    artifactMs: number;
  };
  /**
   * How this result was produced.
   *
   * `compiled` ran the toolchain. `cached` came from the artifact cache without
   * running anything. `joined` waited on a build another request had already
   * started for the identical key.
   */
  source?: 'compiled' | 'cached' | 'joined';
  /** Board this firmware was built for — execution paths refuse a mismatch. */
  boardId?: string;
  /** Toolchain target this firmware was built for. */
  fqbn?: string;
  error?: string;
  errorCode?:
    | 'TOOLCHAIN_MISSING'
    | 'CORE_MISSING'
    | 'INVALID_SOURCE'
    | 'BUILD_TIMEOUT'
    | 'UNSUPPORTED_BOARD'
    | 'MISSING_LIBRARY'
    | 'MALFORMED_PROJECT'
    | 'BUSY'
    | 'INTERNAL';
}

/**
 * Strict compile-target allowlist. A request is only ever compiled as the
 * exact target matched by canonical board id or FQBN — there is no default
 * target and no fallback to another board.
 */
export interface BoardTarget {
  /** Canonical CircuitDesk board id. */
  id: string;
  fqbn: string;
  name: string;
  arch: 'avr' | 'rp2040' | 'esp32c3' | 'esp32c6' | 'samd21' | 'sam3x' | 'stm32f4';
  /** arduino-cli core that provides this target. */
  core: string;
  fCpuHz: number;
  flashMaxBytes: number;
  ramMaxBytes: number;
  /** AVR-only fields for the avr-g++ fallback toolchain. */
  mcu?: string;
  variant?: string;
  boardDefine?: string;
  usbVid?: string;
  usbPid?: string;
}

export const SUPPORTED_TARGETS: BoardTarget[] = [
  {
    id: 'board.arduino-uno',
    fqbn: 'arduino:avr:uno',
    name: 'Arduino Uno R3 (ATmega328P)',
    arch: 'avr',
    core: 'arduino:avr',
    mcu: 'atmega328p',
    variant: 'standard',
    boardDefine: 'ARDUINO_AVR_UNO',
    fCpuHz: 16_000_000,
    flashMaxBytes: 32_256,
    ramMaxBytes: 2_048,
  },
  {
    id: 'board.arduino-nano',
    fqbn: 'arduino:avr:nano',
    name: 'Arduino Nano (ATmega328P)',
    arch: 'avr',
    core: 'arduino:avr',
    mcu: 'atmega328p',
    variant: 'eightanaloginputs',
    boardDefine: 'ARDUINO_AVR_NANO',
    fCpuHz: 16_000_000,
    flashMaxBytes: 30_720,
    ramMaxBytes: 2_048,
  },
  {
    id: 'board.arduino-mega2560',
    fqbn: 'arduino:avr:mega',
    name: 'Arduino Mega 2560 (ATmega2560)',
    arch: 'avr',
    core: 'arduino:avr',
    mcu: 'atmega2560',
    variant: 'mega',
    boardDefine: 'ARDUINO_AVR_MEGA2560',
    fCpuHz: 16_000_000,
    flashMaxBytes: 253_952,
    ramMaxBytes: 8_192,
  },
  {
    id: 'board.arduino-leonardo',
    fqbn: 'arduino:avr:leonardo',
    name: 'Arduino Leonardo (ATmega32U4)',
    arch: 'avr',
    core: 'arduino:avr',
    mcu: 'atmega32u4',
    variant: 'leonardo',
    boardDefine: 'ARDUINO_AVR_LEONARDO',
    usbVid: '0x2341',
    usbPid: '0x8036',
    fCpuHz: 16_000_000,
    flashMaxBytes: 28_672,
    ramMaxBytes: 2_560,
  },
  // The Pro Mini is its own entry in arduino:avr ("Arduino Pro or Pro Mini"),
  // and its default processor option is the 5 V 16 MHz ATmega328P, so the
  // plain three-part FQBN is exactly that board. Its variant is the Nano's
  // eight-analog-input one; the Uno's counts six.
  {
    id: 'board.arduino-pro-mini',
    fqbn: 'arduino:avr:pro',
    name: 'Arduino Pro Mini 5 V 16 MHz (ATmega328P)',
    arch: 'avr',
    core: 'arduino:avr',
    mcu: 'atmega328p',
    variant: 'eightanaloginputs',
    boardDefine: 'ARDUINO_AVR_PRO',
    fCpuHz: 16_000_000,
    flashMaxBytes: 30_720,
    ramMaxBytes: 2_048,
  },
  // RP2040 targets use the Arduino-Pico core (rp2040:rp2040). It emits a .uf2
  // without also emitting a .hex, which is what an RP2040 image should be
  // delivered as — the Mbed core emits both, and a HEX-first artifact rule
  // would hand back an ARM image labelled 'intel-hex'. Each board also has its
  // own FQBN here, so the Pico W is built as a Pico W rather than as a Pico.
  {
    id: 'board.raspberry-pi-pico',
    fqbn: 'rp2040:rp2040:rpipico',
    name: 'Raspberry Pi Pico (RP2040)',
    arch: 'rp2040',
    core: 'rp2040:rp2040',
    fCpuHz: 133_000_000,
    flashMaxBytes: 2_093_056,
    ramMaxBytes: 262_144,
  },
  {
    id: 'board.raspberry-pi-pico-w',
    fqbn: 'rp2040:rp2040:rpipicow',
    name: 'Raspberry Pi Pico W (RP2040, Wi-Fi APIs not simulated)',
    arch: 'rp2040',
    core: 'rp2040:rp2040',
    fCpuHz: 133_000_000,
    flashMaxBytes: 2_093_056,
    ramMaxBytes: 262_144,
  },
  // The XIAO's own variant: D0-D10 as printed (D0 is GP26), LED_BUILTIN on
  // GP17, and Wire on the RP2040's i2c1 at GP6/GP7 — the pads printed SDA and
  // SCL. Built as a Pico, D0 is GP0 (the pad printed D6), and Wire starts on
  // GP4/GP5 — the pad printed D9 and a pin that is not brought out at all — so
  // the sketch compiles and drives the wrong pins.
  {
    id: 'board.seeed-xiao-rp2040',
    fqbn: 'rp2040:rp2040:seeed_xiao_rp2040',
    name: 'Seeed XIAO RP2040',
    arch: 'rp2040',
    core: 'rp2040:rp2040',
    fCpuHz: 125_000_000,
    flashMaxBytes: 2_093_056,
    ramMaxBytes: 262_144,
  },
  // The ESP32-C3 is RISC-V, not Xtensa, so it is its own target rather than a
  // variant of the ESP32 entries. The FQBN is the Espressif core's generic C3
  // entry ("ESP32C3 Dev Module"), which is what every Espressif C3 development
  // board is built as; the flash ceiling is that entry's own default partition
  // layout rather than the raw 4 MB the module carries.
  {
    id: 'board.esp32-c3',
    fqbn: 'esp32:esp32:esp32c3',
    name: 'ESP32-C3 (RISC-V RV32IMC)',
    arch: 'esp32c3',
    core: 'esp32:esp32',
    mcu: 'esp32c3',
    variant: 'esp32c3',
    fCpuHz: 160_000_000,
    flashMaxBytes: 1_310_720,
    ramMaxBytes: 327_680,
  },
  // The Arduino Due, built for its programming port so Serial is the UART.
  {
    id: 'board.arduino-due',
    fqbn: 'arduino:sam:arduino_due_x_dbg',
    name: 'Arduino Due (AT91SAM3X8E)',
    arch: 'sam3x',
    core: 'arduino:sam',
    mcu: 'sam3x8e',
    fCpuHz: 84_000_000,
    flashMaxBytes: 524_288,
    ramMaxBytes: 98_304,
  },
  // The Nucleo-64 F401RE, through STM32duino. Serial is USART2, the ST-LINK's
  // virtual COM port.
  {
    id: 'board.stm32-nucleo',
    fqbn: 'STMicroelectronics:stm32:Nucleo_64:pnum=NUCLEO_F401RE',
    name: 'STM32 Nucleo-64 (STM32F401RE)',
    arch: 'stm32f4',
    core: 'STMicroelectronics:stm32',
    mcu: 'stm32f401re',
    fCpuHz: 84_000_000,
    flashMaxBytes: 524_288,
    ramMaxBytes: 98_304,
  },
  // SAMD21 boards: Adafruit's core, which links the application at 0x2000,
  // above the boards' 8 KB UF2 bootloader — hence 248 KB of the 256 KB flash.
  {
    id: 'board.adafruit-feather',
    fqbn: 'adafruit:samd:adafruit_feather_m0',
    name: 'Adafruit Feather M0 (ATSAMD21G18)',
    arch: 'samd21',
    core: 'adafruit:samd',
    mcu: 'samd21g18a',
    fCpuHz: 48_000_000,
    flashMaxBytes: 253_952,
    ramMaxBytes: 32_768,
  },
  {
    id: 'board.adafruit-qtpy',
    fqbn: 'adafruit:samd:adafruit_qtpy_m0',
    name: 'Adafruit QT Py M0 (ATSAMD21E18)',
    arch: 'samd21',
    core: 'adafruit:samd',
    mcu: 'samd21e18a',
    fCpuHz: 48_000_000,
    flashMaxBytes: 253_952,
    ramMaxBytes: 32_768,
  },
  {
    id: 'board.seeed-xiao',
    fqbn: 'Seeeduino:samd:seeed_XIAO_m0',
    name: 'Seeed Studio XIAO SAMD21 (ATSAMD21G18)',
    arch: 'samd21',
    core: 'Seeeduino:samd',
    mcu: 'samd21g18a',
    fCpuHz: 48_000_000,
    flashMaxBytes: 253_952,
    ramMaxBytes: 32_768,
  },
  {
    id: 'board.esp32-c6-devkitc-1',
    fqbn: 'esp32:esp32:esp32c6',
    name: 'ESP32-C6-DevKitC-1',
    arch: 'esp32c6',
    core: 'esp32:esp32',
    mcu: 'esp32c6',
    variant: 'esp32c6',
    fCpuHz: 160_000_000,
    flashMaxBytes: 1_310_720,
    ramMaxBytes: 327_680,
  },
];

export function findTarget(idOrFqbn: string, boardId?: string): BoardTarget | undefined {
  if (boardId) {
    const byId = SUPPORTED_TARGETS.find((t) => t.id === boardId);
    if (byId) return byId;
    // A boardId that is present but unknown must NOT silently resolve via fqbn.
    return undefined;
  }
  return SUPPORTED_TARGETS.find((t) => t.id === idOrFqbn) ?? SUPPORTED_TARGETS.find((t) => t.fqbn === idOrFqbn);
}

/**
 * The FQBN a request is actually compiled with.
 *
 * A board may ask for a build target other than its allowlisted default — an
 * RP2040 board that wants the Pico W variant, say — and that is a genuine
 * need. It is also the most dangerous string in the whole custom-board feature,
 * because it is user input that ends up in a compiler invocation, so it passes
 * four gates and none of them is "looks fine":
 *
 *   1. shape. Three colon-separated segments of a restricted alphabet, and
 *      nothing else. No board options, no spaces, no separators of any kind —
 *      an FQBN that could be read as two arguments is refused rather than
 *      trimmed.
 *   2. membership. It must be one of the FQBNs the PINNED cores declare. Not
 *      "a core that happens to be installed": the pinned manifest, which is the
 *      same list the image bootstrap obeyed.
 *   3. same core. It must come from the core the allowlisted target already
 *      uses. Otherwise an RP2040 board could ask for an AVR build and receive
 *      an artifact its runtime cannot execute — and the artifact-format
 *      contract the whole pipeline rests on would be broken by a text field.
 *   4. refusal, not repair. A request that fails any of these is answered with
 *      an error naming what was allowed. It is never quietly compiled as the
 *      default, because a user who asked for one target and silently got
 *      another has been lied to.
 *
 * Note what is NOT a gate: escaping. Nothing here is escaped, because nothing
 * is interpolated — arduino-cli is invoked through execFile with an argument
 * array, so a shell never sees any of this. The gates exist to keep the value
 * meaningful, not to make a dangerous string safe.
 */
export function resolveRequestedFqbn(
  target: BoardTarget,
  requested: string | undefined,
  allowedFqbns: string[],
): { fqbn: string } | { error: string } {
  if (!requested || requested === target.fqbn) return { fqbn: target.fqbn };

  // What the message offers: targets for the SAME chip, which is the set that
  // could actually produce firmware this board's runtime can execute.
  const sameChip = SUPPORTED_TARGETS
    .filter((t) => allowedFqbns.includes(t.fqbn) && t.core === target.core && t.arch === target.arch && t.mcu === target.mcu)
    .map((t) => t.fqbn);
  const refuse = (why: string) => ({
    error:
      `Build target "${String(requested).slice(0, 80)}" was refused: ${why}. ` +
      `${target.name} may be built as: ${sameChip.join(', ') || target.fqbn}.`,
  });

  if (!/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/.test(requested)) {
    return refuse('an FQBN is three colon-separated names and nothing else');
  }
  if (!allowedFqbns.includes(requested)) {
    return refuse('it is not a target of any core this service is built against');
  }
  const other = SUPPORTED_TARGETS.find((t) => t.fqbn === requested);
  if (!other || other.core !== target.core) {
    return refuse(`it belongs to a different core (this board builds with ${target.core})`);
  }
  if (other.arch !== target.arch || other.mcu !== target.mcu) {
    return refuse(
      `it is a different chip (${other.name} is ${other.mcu ?? other.arch}, this board is ${target.mcu ?? target.arch})`,
    );
  }
  return { fqbn: requested };
}
