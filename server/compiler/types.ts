export interface CodeFilePayload {
  name: string;
  content: string;
}

export interface CompileRequest {
  projectId?: string;
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
    format: 'intel-hex';
    data: string;
  };
  memory?: MemoryUsage;
  durationMs: number;
  error?: string;
  errorCode?:
    | 'TOOLCHAIN_MISSING'
    | 'CORE_MISSING'
    | 'INVALID_SOURCE'
    | 'BUILD_TIMEOUT'
    | 'UNSUPPORTED_BOARD'
    | 'MISSING_LIBRARY'
    | 'MALFORMED_PROJECT'
    | 'INTERNAL';
}

export interface BoardTarget {
  fqbn: string;
  name: string;
  mcu: string;
  fCpuHz: number;
  flashMaxBytes: number;
  ramMaxBytes: number;
}

export const SUPPORTED_TARGETS: BoardTarget[] = [
  {
    fqbn: 'arduino:avr:uno',
    name: 'Arduino Uno R3 (ATmega328P)',
    mcu: 'atmega328p',
    fCpuHz: 16_000_000,
    flashMaxBytes: 32_256,
    ramMaxBytes: 2_048,
  },
  {
    fqbn: 'arduino:avr:nano',
    name: 'Arduino Nano (ATmega328P)',
    mcu: 'atmega328p',
    fCpuHz: 16_000_000,
    flashMaxBytes: 30_720,
    ramMaxBytes: 2_048,
  },
];

export function findTarget(fqbn: string): BoardTarget | undefined {
  return SUPPORTED_TARGETS.find((t) => t.fqbn === fqbn);
}
