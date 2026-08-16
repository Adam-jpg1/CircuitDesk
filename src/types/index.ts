// CircuitDesk core data model.

export type SupportLevel = 'visual-only' | 'wiring' | 'validation' | 'compile' | 'simulated';

export const SUPPORT_LEVEL_LABEL: Record<SupportLevel, string> = {
  'visual-only': 'Visual only',
  wiring: 'Wiring',
  validation: 'Validation',
  compile: 'Compile',
  simulated: 'Simulated',
};

export type PinType =
  | 'digital'
  | 'analog'
  | 'power-5v'
  | 'power-3v3'
  | 'power-vin'
  | 'ground'
  | 'reset'
  | 'aref'
  | 'passive'
  | 'anode'
  | 'cathode'
  | 'nc';

export type PinCapability =
  | 'digital-in'
  | 'digital-out'
  | 'analog-in'
  | 'pwm'
  | 'uart-tx'
  | 'uart-rx'
  | 'i2c-sda'
  | 'i2c-scl'
  | 'spi-mosi'
  | 'spi-miso'
  | 'spi-sck'
  | 'spi-ss'
  | 'interrupt'
  | 'power'
  | 'ground';

export interface PinDefinition {
  id: string;
  label: string;
  number?: string;
  /** Position in canvas units (1 unit = 0.25 mm), relative to part origin. */
  x: number;
  y: number;
  type: PinType;
  capabilities: PinCapability[];
  voltage?: number;
  maxCurrentMa?: number;
  aliases?: string[];
  description?: string;
}

export interface BoardArtwork {
  kind: 'builtin' | 'svg' | 'image';
  builtinId?: string;
  svg?: string;
  imageDataUrl?: string;
}

export type ComponentArtwork = BoardArtwork;

export type BoardArchitecture =
  | 'avr'
  | 'sam'
  | 'samd'
  | 'renesas'
  | 'rp2040'
  | 'esp8266'
  | 'esp32'
  | 'stm32'
  | 'nrf52'
  | 'imxrt'
  | 'linux'
  | 'other';

export interface BoardCompilerInfo {
  provider: 'arduino-cli' | 'none';
  fqbn?: string;
  /** Core the compiler service must have installed (e.g. "arduino:avr"). */
  requiredCore?: string;
  /**
   * True only when CircuitDesk's compiler backend genuinely targets this
   * board (strict server-side allowlist). Cores that must be installed at
   * deploy time are still reported honestly by /api/compiler/capabilities.
   */
  supported: boolean;
  note?: string;
}

export interface BoardSimulationInfo {
  engine: 'avr8js' | 'rp2040js' | 'esp32c3' | 'esp32c6' | 'none';
  supported: boolean;
  /** APIs genuinely exercised by automated tests for this board. */
  supportedApis: string[];
  supportedPeripherals: string[];
}

/** @deprecated superseded by BoardCompilerInfo; kept for stored-project compatibility. */
export interface CompilerTarget {
  fqbn: string;
  mcu: string;
  fCpuHz: number;
}

export interface BoardDefinition {
  id: string;
  name: string;
  /** Alternate names/identifiers this board is known by. */
  aliases?: string[];
  family: string;
  /**
   * Who makes the board, when a single company does.
   *
   * `family` groups by chip and is not a maker: an ESP32 DevKit V1 is an
   * Espressif-chip board that Espressif does not sell. Absent when unknown;
   * set to a plain statement when the design has many producers.
   */
  manufacturer?: string;
  /** Optional for backward compatibility with stored custom boards; treat undefined as 'other'. */
  architecture?: BoardArchitecture;
  processor: string;
  widthMm: number;
  heightMm: number;
  artwork: BoardArtwork;
  pins: PinDefinition[];
  compiler?: BoardCompilerInfo;
  simulation?: BoardSimulationInfo;
  /** @deprecated use `compiler` */
  compilerTarget?: CompilerTarget;
  /** @deprecated use `simulation` */
  simulationAdapterId?: string;
  supportLevel: SupportLevel;
  metadata: Record<string, unknown>;
  description?: string;
  isBoard: true;
}

export interface PropertyDefinition {
  key: string;
  label: string;
  kind: 'number' | 'text' | 'select' | 'boolean' | 'color';
  options?: { value: string; label: string }[];
  unit?: string;
  min?: number;
  max?: number;
  default: unknown;
}

export interface ComponentDefinition {
  id: string;
  name: string;
  category: string;
  widthMm: number;
  heightMm: number;
  artwork: ComponentArtwork;
  pins: PinDefinition[];
  properties: PropertyDefinition[];
  validationRules: string[];
  simulationAdapterId?: string;
  supportLevel: SupportLevel;
  description?: string;
  /** Breadboard-style internal connectivity: pinId -> internal net group key. */
  internalGroups?: Record<string, string>;
  isBoard?: false;
}

export type PartDefinition = BoardDefinition | ComponentDefinition;

export interface ComponentInstance {
  id: string;
  definitionId: string;
  x: number;
  y: number;
  rotation: number;
  properties: Record<string, unknown>;
  simulationState: Record<string, unknown>;
  label?: string;
  /**
   * For a board instance: the sketch document it runs, by stable id.
   *
   * A reference rather than a copy, so several boards can intentionally run one
   * source without the user having to edit it in several places. Absent on
   * projects written before per-board sketches, and on components, where it
   * means nothing; `sketchIdFor()` resolves the fallback.
   */
  sketchId?: string;
}

export interface Connection {
  id: string;
  sourceComponentId: string;
  sourcePinId: string;
  targetComponentId: string;
  targetPinId: string;
  netId: string;
  color: string;
  /** Optional intermediate waypoints, flat [x1,y1,x2,y2,...] in canvas units. */
  points: number[];
  routing: 'smooth' | 'orthogonal' | 'straight';
  label?: string;
}

export interface CodeFile {
  id: string;
  name: string;
  content: string;
  language: 'cpp' | 'plaintext';
}

export interface TestInputEvent {
  atMs: number;
  action: 'press' | 'release' | 'toggle' | 'set-analog' | 'set-value';
  componentId: string;
  value?: number;
}

export interface TestAssertion {
  id: string;
  kind: 'pin-high' | 'pin-low' | 'pin-becomes-high' | 'pin-becomes-low' | 'serial-contains' | 'pin-toggles';
  pin?: number;
  text?: string;
  withinMs?: number;
  atMs?: number;
  holdMs?: number;
  minToggles?: number;
}

export interface TestCase {
  id: string;
  name: string;
  description?: string;
  events: TestInputEvent[];
  assertions: TestAssertion[];
  timeoutMs: number;
}

export interface TestAssertionResult {
  assertionId: string;
  passed: boolean;
  expected: string;
  actual: string;
  atMs?: number;
}

export interface TestResult {
  testId: string;
  status: 'passed' | 'failed' | 'error' | 'skipped';
  durationMs: number;
  assertionResults: TestAssertionResult[];
  message?: string;
  serialOutput?: string;
  timeline?: { atMs: number; event: string }[];
}

export interface CustomDefinition {
  kind: 'board' | 'component';
  definition: PartDefinition;
  createdAt: string;
  source?: string;
}

export interface ProjectSettings {
  boardFqbn?: string;
  simulationSpeed?: number;
  assemblyNotes?: string;
  serialBaud?: number;
}

export interface CircuitProject {
  id: string;
  name: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  boardInstances: ComponentInstance[];
  componentInstances: ComponentInstance[];
  connections: Connection[];
  codeFiles: CodeFile[];
  tests: TestCase[];
  customDefinitions: CustomDefinition[];
  settings: ProjectSettings;
  thumbnailSvg?: string;
}

export const PROJECT_SCHEMA_VERSION = '1.1.0';

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: string;
  createdAt: string;
  primaryBoard: string;
  componentCount: number;
  supportLevel: SupportLevel;
  validationStatus?: 'ok' | 'warnings' | 'errors' | 'unknown';
  thumbnailSvg?: string;
}

export interface ValidationIssue {
  id: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  description: string;
  why?: string;
  affectedComponentIds: string[];
  affectedConnectionIds: string[];
  suggestedFix?: string;
  ruleId: string;
}

// ---- Compiler API (mirrors server/compiler/types.ts) ----

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'note';
  message: string;
}

/** One include the build is fine with and the simulation is not. */
export interface SimulationNote {
  header: string;
  /** `unsupported` — will not compile. `no-effect` — compiles and moves nothing. */
  kind: 'unsupported' | 'no-effect';
  reason: string;
  /** A header to use instead, for `unsupported`. */
  alternative?: string;
  /** A different way to get the same result, for `no-effect`. */
  workaround?: string;
}

export interface CompileResult {
  success: boolean;
  toolchain: 'arduino-cli' | 'avr-gcc' | 'none';
  toolchainVersion: string;
  stdout: string;
  stderr: string;
  diagnostics: Diagnostic[];
  firmware?: { format: 'intel-hex' | 'uf2' | 'bin' | 'esp-image'; data: string };
  memory?: { flashBytes: number; flashMaxBytes: number; ramBytes: number; ramMaxBytes: number };
  /**
   * True things about this build that are not compiler diagnostics.
   *
   * A library can compile perfectly for the selected board and still do
   * nothing, because CircuitDesk does not model the peripheral it drives —
   * Servo.h on a Pico goes through PIO, and the pin never moves. The build is
   * not wrong, so it is not an error; but a silent dead circuit is the worst
   * thing to leave someone debugging, so it is said out loud.
   */
  simulationNotes?: SimulationNote[];
  durationMs: number;
  error?: string;
  errorCode?: string;
  /** Board this firmware was built for — required before it may be executed. */
  boardId?: string;
  /** Toolchain target this firmware was built for. */
  fqbn?: string;
}

export interface CompilerHealth {
  available: boolean;
  toolchain: 'arduino-cli' | 'avr-gcc' | 'none';
  version: string;
  detail: string;
}

// ---- Canvas ----

/** Canvas scale: units per millimetre. */
export const UNITS_PER_MM = 4;

export function uid(prefix = 'id'): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}
