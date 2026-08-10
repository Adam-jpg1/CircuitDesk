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
  durationMs: number;
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
  arch: 'avr' | 'rp2040' | 'esp32c3';
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
