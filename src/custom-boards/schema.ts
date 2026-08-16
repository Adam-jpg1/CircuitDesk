// A board somebody brought themselves.
//
// The shape of this file is decided by one product goal: a user should not have
// to wait for CircuitDesk to add their board. So a custom board is a first-class
// description of hardware — an identity, an outline, a set of physical pins, and
// a choice of processor, toolchain and emulator — and NOT a pile of loose fields
// that the rest of the app has to interpret differently from a native board.
//
// Three decisions run through everything here.
//
// IDENTITY IS AN ID. `id` is generated once and never derived from the name.
// Renaming "My Controller" to "Robot Controller Rev B" changes a label and
// nothing else: instances reference the id, wires reference pin ids, and the
// compile cache keys on the pipeline rather than on anything visible.
//
// THE BOARD IS NOT THE PROCESSOR. A board names a processor profile, a compile
// profile and a runtime profile, exactly as a native board does. That is what
// lets somebody's own RP2040 board use the RP2040 toolchain and the RP2040
// emulator without pretending to be a Raspberry Pi Pico, and what makes
// "wiring only" a real answer rather than a failure.
//
// THE FILE IS UNTRUSTED. A .cdboard.json arrives from another person. Every
// field is bounded and every value validated before anything is built from it:
// there is no field here that can name a program to run, a path to read, or
// markup to execute. See validate.ts for the checks and svgSanitize.ts for the
// artwork.

/** Bumped when the shape changes in a way an older build could misread. */
export const CUSTOM_BOARD_SCHEMA_VERSION = '1.0.0';

/**
 * Limits, applied to every imported board.
 *
 * Not tuning knobs — they are the boundary between "a board" and "a payload".
 * A 100-pin board is a real thing; a 100,000-pin board is a denial of service,
 * and a 40 MB SVG is a way to make the editor stop responding.
 */
export const CUSTOM_BOARD_LIMITS = {
  maxPins: 256,
  maxNameLength: 80,
  maxDescriptionLength: 2000,
  maxLabelLength: 24,
  maxIdLength: 64,
  maxAliasesPerPin: 8,
  maxArtworkBytes: 512 * 1024,
  maxBoardMm: 400,
  minBoardMm: 5,
} as const;

/** What a physical pin is, and where it goes. */
export interface CustomBoardPin {
  /**
   * Stable identity. Wires are stored against this, so it survives a rename,
   * a move, a relabel and a change of processor pad.
   */
  id: string;
  /** What is printed next to the pin on the board — what the canvas shows. */
  label: string;
  /**
   * The processor pad this pin is wired to on the PCB, in the processor's own
   * naming (`GP15`, `PB5`, `IO2`), or null for a pin that reaches no processor.
   *
   * This is the heart of custom-board support: the canvas shows MOTOR_PWM and
   * the firmware and the runtime see GP15, and both identities are real.
   */
  pad: string | null;
  /** Position in millimetres from the board's top-left corner. */
  xMm: number;
  yMm: number;
  /** Electrical role, which is what wiring rules and the validator read. */
  type: PinRole;
  /** What the pin can do, over and above what the pad implies. */
  capabilities: string[];
  /** Other names this pin answers to, for imports that use a different sheet. */
  aliases?: string[];
  /** Nominal voltage for a power pin. Ignored for everything else. */
  voltage?: number;
  description?: string;
}

/**
 * Pin roles a custom board may declare.
 *
 * Deliberately the same vocabulary the rest of the app uses, so a custom board's
 * pins are checked by the same wiring rules as a native board's — a power pin
 * shorted to a ground pin is the same mistake whoever made the board.
 */
export type PinRole =
  | 'digital'
  | 'analog'
  | 'power-5v'
  | 'power-3v3'
  | 'power-vin'
  | 'ground'
  | 'reset'
  | 'aref'
  | 'nc';

export interface CustomBoardIdentity {
  /** Display name. Changing it must break nothing. */
  name: string;
  /** Who made the board. Never filled in with CircuitDesk. */
  creator?: string;
  description?: string;
  /** The creator's own version string, distinct from `revision`. */
  hardwareVersion?: string;
}

export interface CustomBoardOutline {
  widthMm: number;
  heightMm: number;
  /**
   * Sanitised SVG for the board's face, or absent for a generated outline.
   *
   * Stored as text rather than a URL because a project has to be portable: a
   * board that referenced a file on its author's machine would arrive at the
   * next person as a broken image.
   */
  artworkSvg?: string;
  /** Board colour used when there is no artwork. */
  color?: string;
}

/**
 * Which controller a bus signal on this board is expected to use.
 *
 * Optional, and only meaningful when the processor has more than one: a board
 * whose SDA/SCL header goes to i2c1 says so, and the validator then checks the
 * pads against that controller rather than against every controller on the chip.
 */
export interface PeripheralAssignment {
  /** `i2c`, `spi` or `uart`. */
  kind: 'i2c' | 'spi' | 'uart';
  /** Controller id from the processor profile: `i2c0`, `uart1`. */
  controller: string;
  /** Signal name to board pin id: `{ sda: 'SENSOR_SDA' }`. */
  pins: Record<string, string>;
}

export interface CustomBoardDefinition {
  /** Which version of THIS schema the file was written against. */
  schemaVersion: string;
  /**
   * Stable id, generated once. Never derived from the name.
   *
   * Prefixed `custom.` so it can never collide with a built-in board id, and so
   * anything reading an id can tell where the definition has to come from.
   */
  id: string;
  /**
   * Bumped every time the definition is edited.
   *
   * A project embeds the revision it was built against. Editing a board in the
   * library therefore cannot silently reroute wires in a project already using
   * it — the project keeps the revision it knows until somebody chooses to
   * upgrade it.
   */
  revision: number;
  identity: CustomBoardIdentity;
  outline: CustomBoardOutline;
  pins: CustomBoardPin[];
  /**
   * The chip, or null for a board that is wiring and geometry only.
   *
   * Null is a legitimate, supported state: plenty of useful boards carry a
   * processor CircuitDesk cannot execute, and they are still worth wiring,
   * validating and saving. What must never happen is such a board quietly
   * running on some other processor.
   */
  processorProfileId: string | null;
  compileProfileId: string;
  runtimeProfileId: string;
  /**
   * A more specific target within the compile profile, when the board needs one.
   *
   * Bounded by the compile profile: it may only be an FQBN that profile
   * declares, so this cannot become a way to name an arbitrary build target.
   */
  fqbnOverride?: string;
  peripherals?: PeripheralAssignment[];
  /** Free-form, bounded, and never interpreted as behaviour. */
  metadata?: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * A custom board as a project stores it.
 *
 * The definition travels INSIDE the project. That is the portability rule: a
 * project that referenced a board in the author's personal library, or a path
 * on their disk, would open at the next person as a hole where a board used to
 * be. Everything needed to draw, wire, compile and run the board is here.
 */
export interface EmbeddedCustomBoard {
  definition: CustomBoardDefinition;
  /** Where it came from, for the user's benefit. Never a filesystem path. */
  source?: 'studio' | 'csv' | 'bundle' | 'import';
}

export function isCustomBoardId(id: string): boolean {
  return id.startsWith('custom.');
}
