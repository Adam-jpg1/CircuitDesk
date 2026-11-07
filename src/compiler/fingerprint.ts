// What makes two builds the same build.
//
// One definition, used everywhere. The frontend groups its builds by it, the
// artifact cache keys on it, the build report quotes it and the tests assert
// against it — because a cache key reconstructed independently in three files
// is three chances to disagree, and the way that failure presents is a user
// running yesterday's firmware.
//
// The rule for what goes in: EVERYTHING that can change the bytes, and NOTHING
// that cannot.
//
// In, because it changes the firmware:
//   the compile profile and its revision, the compiler adapter, the processor
//   target, the FQBN, every source byte, build flags and macros, the toolchain
//   and core versions, and the libraries whose version affects resolution.
//
// Out, because it cannot:
//   the board's display name, its artwork, its colour, its dimensions, where it
//   sits on the canvas, the instance's id, and the labels its maker gave the
//   pins. Renaming a board or dragging it across the canvas must cost zero
//   compiles, and the only way to guarantee that is for none of it to be here.
//
// The runtime profile is deliberately ABSENT. Compilation and execution are
// separate concerns: which emulator will run an artifact does not change what
// the compiler produces, and putting it in the key would recompile identical
// firmware because somebody changed how it is executed. Whether the artifact
// and the runtime fit together is a real question, checked separately — see
// `checkArtifactRuntime` below.

import { compileProfile, runtimeProfile, type CompileProfile, type RuntimeProfile } from '../boards/pipelineProfiles';
import type { BoardDefinition } from '../types';

/** Everything about a build that can change its bytes. */
export interface CompileFingerprintInput {
  /** Which pipeline is building, and which revision of it. */
  compileProfileId: string;
  compileProfileRevision: number;
  /** The adapter that runs, and the version of the adapter contract. */
  adapter: string;
  /** The chip being built for. */
  processorProfileId: string;
  /** The exact target handed to the toolchain. */
  fqbn: string;
  /** Build flags and macros the profile adds, in a stable order. */
  buildFlags: string[];
  /** Core and toolchain versions, when the caller knows them. */
  toolchainVersions: Record<string, string>;
  /** Libraries whose version affects what the sketch resolves against. */
  libraries: string[];
  /** Every source file, by name and content. */
  files: readonly { name: string; content: string }[];
}

/**
 * The version of a compile profile's own configuration.
 *
 * Bumped when a profile's flags, core or target change in a way that alters
 * output. Without it, editing a profile in a future release would silently
 * reuse artifacts built by the old one.
 */
export const COMPILE_PROFILE_REVISION = 1;

/** The version of the fingerprint's own construction, so its shape can change. */
const FINGERPRINT_VERSION = 'cd-compile-v2';

/**
 * A stable string for a build.
 *
 * Field-separated and length-prefixed on the file contents, so no combination
 * of names and sources can be rearranged into a different build with the same
 * fingerprint.
 */
export function compileFingerprint(input: CompileFingerprintInput): string {
  const files = [...input.files]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((f) => `${f.name.length}:${f.name}\u0000${f.content.length}:${f.content}`)
    .join('\u0001');
  const versions = Object.entries(input.toolchainVersions)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  return [
    FINGERPRINT_VERSION,
    input.compileProfileId,
    String(input.compileProfileRevision),
    input.adapter,
    input.processorProfileId,
    input.fqbn,
    [...input.buildFlags].sort().join(' '),
    versions,
    [...input.libraries].sort().join(','),
    files,
  ].join('\u0002');
}

/**
 * The fingerprint for a board and a set of sources.
 *
 * The board contributes only what it compiles AS — its pipeline, its processor
 * and its target. Everything visible about it is deliberately not consulted, so
 * this function could not include a display name if it wanted to.
 */
export function fingerprintForBoard(
  board: BoardDefinition,
  files: readonly { name: string; content: string }[],
  toolchainVersions: Record<string, string> = {},
): string {
  const profile = board.compileProfileId ? compileProfile(board.compileProfileId) : undefined;
  return compileFingerprint({
    compileProfileId: profile?.id ?? 'compile.unknown',
    compileProfileRevision: COMPILE_PROFILE_REVISION,
    adapter: profile?.adapter ?? 'none',
    processorProfileId: board.processorProfileId ?? 'proc.unknown',
    // The board's own FQBN, because a board may pin a variant within its
    // profile — the Nano and a custom 328P board share a pipeline and do not
    // share a target.
    fqbn: board.compiler?.fqbn ?? profile?.fqbn ?? '',
    buildFlags: profile?.buildFlags ?? [],
    toolchainVersions: {
      ...(profile?.requiredCore ? { [profile.requiredCore]: toolchainVersions[profile.requiredCore] ?? 'unpinned' } : {}),
      ...toolchainVersions,
    },
    libraries: profile?.libraries ?? [],
    files,
  });
}

export interface ArtifactRuntimeMismatch {
  code: 'no-runtime' | 'processor-mismatch' | 'format-mismatch';
  message: string;
}

/**
 * Whether what the compiler produced is what the emulator can execute.
 *
 * The other half of keeping compilation and execution separate: they are not
 * in one key, so something has to check they fit, and it is better done here —
 * before an engine is handed an artifact — than inside a loader whose failure
 * reads as a corrupt file.
 */
export function checkArtifactRuntime(
  board: BoardDefinition,
  artifactFormat: string,
): ArtifactRuntimeMismatch | null {
  const runtime: RuntimeProfile | undefined = board.runtimeProfileId
    ? runtimeProfile(board.runtimeProfileId)
    : undefined;
  if (!runtime || runtime.engine === 'none') {
    return {
      code: 'no-runtime',
      message:
        `${board.name} has no simulation runtime configured, so its firmware is not executed. ` +
        'It compiles and validates; nothing runs it as another processor.',
    };
  }
  const processorId = board.processorProfileId;
  if (!processorId || !runtime.processorProfileIds.includes(processorId)) {
    return {
      code: 'processor-mismatch',
      message:
        `${board.name} runs on ${runtime.name}, which executes ` +
        `${runtime.processorProfileIds.join(', ') || 'nothing'}, not ${processorId ?? 'an unspecified processor'}.`,
    };
  }
  if (!runtime.acceptsFormats.includes(artifactFormat as CompileProfile['artifactFormat'])) {
    return {
      code: 'format-mismatch',
      message:
        `${runtime.name} accepts ${runtime.acceptsFormats.join(' or ')} artifacts, ` +
        `but the build for ${board.name} produced ${artifactFormat}.`,
    };
  }
  return null;
}
