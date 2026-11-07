import path from 'node:path';
import { detectArduinoCli, cliCompile } from './arduinoCli.js';
import { detectGccToolchain, gccCompile, parseDiagnostics, BuildTimeoutError } from './gccToolchain.js';
import { buildSketchDir, buildCliSketchDir } from './sketchBuilder.js';
import { cleanupDir, createBuildDir, validateFiles, InputValidationError } from './fileService.js';
import {
  findTarget,
  resolveRequestedFqbn,
  buildFqbnFor,
  SUPPORTED_TARGETS,
  type BoardTarget,
  type CompileRequest,
  type CompileResult,
  type Diagnostic,
} from './types.js';
import { PINNED_CORES } from './cores.js';
import { includeWarnings } from './libraries.js';

/**
 * Every FQBN this service will build, from the pinned core manifest.
 *
 * The manifest rather than "whatever arduino-cli reports installed": the pinned
 * list is the one the image bootstrap obeyed and the capability endpoint
 * reports, and a target that appeared on the machine by some other route is not
 * a target this service is validated for.
 */
const ALLOWED_FQBNS: string[] = PINNED_CORES.flatMap((c) => c.targets);
import type { FirmwareSymbols } from './firmwareSymbols.js';
import { buildKey, buildDirFor, cachedResult, rememberResult, runDeduplicated, evictBuildDirs } from './buildCache.js';

export interface CompilerHealth {
  available: boolean;
  toolchain: 'arduino-cli' | 'avr-gcc' | 'none';
  version: string;
  detail: string;
}

export async function getCompilerHealth(): Promise<CompilerHealth> {
  const cli = await detectArduinoCli();
  if (cli.available && cli.avrCoreInstalled) {
    return {
      available: true,
      toolchain: 'arduino-cli',
      version: cli.version,
      detail: 'Compiling with arduino-cli (arduino:avr core installed).',
    };
  }
  const gcc = await detectGccToolchain();
  if (gcc.available) {
    return {
      available: true,
      toolchain: 'avr-gcc',
      version: gcc.version,
      detail:
        'Compiling with the local avr-g++ toolchain and the Arduino AVR core' +
        (cli.available ? ` (arduino-cli found, but: ${cli.reason})` : ' (arduino-cli not installed).'),
    };
  }
  return {
    available: false,
    toolchain: 'none',
    version: '',
    detail: [cli.reason, gcc.reason].filter(Boolean).join(' '),
  };
}

/**
 * A build, or the memory of one.
 *
 * Three ways out, in order of cost:
 *   - the artifact cache already holds this exact build: no toolchain runs;
 *   - a build with this exact key is already running: wait for it rather than
 *     starting a second one;
 *   - run it, in a build directory derived from the key, so arduino-cli finds
 *     the objects it left there last time instead of starting from nothing.
 *
 * "This exact build" means the sources, the target, the toolchain version and
 * the core version — see buildKey. Nothing about the project's layout is in
 * there, so moving a part or renaming a board can never cost a compile.
 */
/**
 * Where a build waits for the toolchain.
 *
 * Passed in rather than imported so the HTTP server can hand over its compile
 * gate while tests and tools run unqueued. Only work that actually starts the
 * toolchain goes through it: a cached result or a build already running for
 * the same key never takes a place in the queue, so asking twice for the same
 * firmware can never be what fills it.
 */
export type ToolchainSlot = <T>(work: () => Promise<T>) => Promise<T>;
const unqueued: ToolchainSlot = (work) => work();

export async function compileProject(
  req: CompileRequest,
  syntaxOnly: boolean,
  slot: ToolchainSlot = unqueued,
): Promise<CompileResult> {
  const started = Date.now();
  const base: Omit<CompileResult, 'success'> = {
    toolchain: 'none',
    toolchainVersion: '',
    stdout: '',
    stderr: '',
    diagnostics: [],
    durationMs: 0,
  };

  const target = findTarget(req.fqbn, req.boardId);
  if (!target) {
    return {
      ...base,
      success: false,
      error:
        `Board "${req.boardId ?? req.fqbn}" is not on the compile allowlist. ` +
        'Supported targets: ' + SUPPORTED_TARGETS.map((t) => `${t.id} (${t.fqbn})`).join(', ') + '. ' +
        'Unsupported boards are never compiled as a different board.',
      errorCode: 'UNSUPPORTED_BOARD',
      durationMs: Date.now() - started,
    };
  }

  // The build target, which may be a variant the board asked for. Refused
  // rather than repaired when it is not one this service is built against —
  // silently compiling for the default after a user named a different target
  // produces firmware that does not match what they were told they got.
  const requested = resolveRequestedFqbn(target, req.fqbn, ALLOWED_FQBNS);
  if ('error' in requested) {
    return {
      ...base,
      success: false,
      error: requested.error,
      errorCode: 'UNSUPPORTED_BOARD',
      durationMs: Date.now() - started,
    };
  }
  const fqbn = requested.fqbn;

  try {
    validateFiles(req.files);
  } catch (err) {
    if (err instanceof InputValidationError) {
      return {
        ...base,
        success: false,
        error: err.message,
        errorCode: 'MALFORMED_PROJECT',
        durationMs: Date.now() - started,
      };
    }
    throw err;
  }

  // Computed from the sources as submitted, before anything is written to
  // disk, so it is reported on a failed build as readily as a successful one:
  // a sketch that includes a header this target cannot build should say so
  // even when there are twenty other errors above it.
  const notes = includeWarnings(req.files.map((f) => f.content).join('\n'), fqbn);

  const cli = await detectArduinoCli();

  // Non-AVR architectures (RP2040, ESP32) compile ONLY through arduino-cli with
  // the exact required core installed. There is no fallback to any other
  // architecture or board.
  if (target.arch !== 'avr') {
    if (!cli.available) {
      return {
        ...base,
        success: false,
        error: `Compiling ${target.name} requires arduino-cli with the ${target.core} core, but arduino-cli is not installed on the compiler service.`,
        errorCode: 'TOOLCHAIN_MISSING',
        durationMs: Date.now() - started,
      };
    }
    if (!cli.installedCores.includes(target.core)) {
      return {
        ...base,
        success: false,
        error: `The ${target.core} core is not installed on the compiler service, so ${target.name} cannot be compiled here. Install it with: arduino-cli core install ${target.core}. The board was NOT compiled as any other target.`,
        errorCode: 'CORE_MISSING',
        durationMs: Date.now() - started,
      };
    }
    return cliBuild(req, target, buildFqbnFor(fqbn, req.files.map((f) => f.content).join('\n')), cli, syntaxOnly, notes, base, started, slot);
  }

  const health = await getCompilerHealth();
  if (!health.available) {
    return {
      ...base,
      success: false,
      error: `No compiler toolchain is available on this machine. ${health.detail}`,
      errorCode: 'TOOLCHAIN_MISSING',
      durationMs: Date.now() - started,
    };
  }

  if (health.toolchain === 'arduino-cli') {
    return cliBuild(req, target, buildFqbnFor(fqbn, req.files.map((f) => f.content).join('\n')), cli, syntaxOnly, notes, base, started, slot);
  }

  // The local avr-g++ fallback. Not the deployed path, and not cached: it exists
  // so a machine without arduino-cli can still build an Uno.
  return slot(() => gccBuild(req, target, syntaxOnly, notes, base, started));
}

async function gccBuild(
  req: CompileRequest,
  target: BoardTarget,
  syntaxOnly: boolean,
  notes: CompileResult['simulationNotes'],
  base: Omit<CompileResult, 'success'>,
  started: number,
): Promise<CompileResult> {
  const buildDir = await createBuildDir();
  try {
    const gcc = await detectGccToolchain();
    const sketch = await buildSketchDir(buildDir, req.files);
    const sourcesText = req.files.map((f) => f.content);
    const out = await gccCompile(buildDir, target, gcc.coreRoot!, sketch.units, sourcesText, syntaxOnly);
    const diagnostics = parseDiagnostics(out.stderr, sketch.nameMap);
    if (out.missingLibraries.length > 0 && out.code !== 0) {
      const result = finish(false, 'avr-gcc', gcc.version, out, diagnostics, target, started, syntaxOnly, notes);
      result.error = `Missing library: ${out.missingLibraries.join(', ')}. Only the Arduino core libraries (Wire, SPI, EEPROM, SoftwareSerial) are bundled with the local toolchain.`;
      result.errorCode = 'MISSING_LIBRARY';
      return result;
    }
    return finish(out.code === 0, 'avr-gcc', gcc.version, out, diagnostics, target, started, syntaxOnly, notes);
  } catch (err) {
    return failure(err, base, started);
  } finally {
    await cleanupDir(buildDir);
  }
}

/** Turns a thrown build error into the result shape the API promises. */
function failure(err: unknown, base: Omit<CompileResult, 'success'>, started: number): CompileResult {
  if (err instanceof BuildTimeoutError) {
    return { ...base, success: false, error: err.message, errorCode: 'BUILD_TIMEOUT', durationMs: Date.now() - started };
  }
  return {
    ...base,
    success: false,
    error: err instanceof Error ? err.message.slice(0, 2000) : 'Internal compiler error.',
    errorCode: 'INTERNAL',
    durationMs: Date.now() - started,
  };
}

/** The arduino-cli path, with the cache, the dedup and the reusable build dir. */
async function cliBuild(
  req: CompileRequest,
  target: BoardTarget,
  fqbn: string,
  cli: { version: string; coreVersions: Record<string, string> },
  syntaxOnly: boolean,
  notes: CompileResult['simulationNotes'],
  base: Omit<CompileResult, 'success'>,
  started: number,
  slot: ToolchainSlot,
): Promise<CompileResult> {
  const key = buildKey({
    fqbn,
    toolchainVersion: cli.version,
    coreVersion: cli.coreVersions[target.core] ?? 'unknown',
    syntaxOnly,
    files: req.files,
  });

  const hit = cachedResult(key);
  if (hit) return { ...hit, durationMs: Date.now() - started };

  // Joining a build already running for this key needs no place in the queue;
  // only the first request for it waits for the toolchain.
  return runDeduplicated(key, () => slot(async () => {
    const buildRoot = await buildDirFor(key);
    const prepareStart = Date.now();
    try {
      const sketchDir = await buildCliSketchDir(buildRoot, req.files);
      const outDir = path.join(buildRoot, 'out');
      const prepareMs = Date.now() - prepareStart;

      const compileStart = Date.now();
      const out = await cliCompile(sketchDir, outDir, fqbn, syntaxOnly, target.arch);
      const compileMs = Date.now() - compileStart;

      // The handoff directories are read and finished with. An ESP32 build
      // leaves a 6.5 MB .elf and an 8.4 MB .map in them that nothing here reads
      // — 30 MB per build of pure sediment, against a cache budget of 512 MB.
      // The sketch directory itself stays: arduino-cli derives its intermediate
      // cache path from a hash of that path, and moving it would throw away the
      // reuse this whole arrangement exists for.
      await cleanupDir(outDir);
      await cleanupDir(path.join(sketchDir, 'build'));

      const nameMap = new Map<string, string>([['cdsketch.ino', 'sketch.ino']]);
      const diagnostics = parseDiagnostics(out.stderr, nameMap);
      const result = finish(out.code === 0, 'arduino-cli', cli.version, out, diagnostics, target, started, syntaxOnly, notes);
      result.timings = { prepareMs, compileMs, artifactMs: out.artifactMs ?? 0 };
      result.source = 'compiled';
      rememberResult(key, result);
      return result;
    } catch (err) {
      return failure(err, base, started);
    } finally {
      // The directory is the cache, so it stays. Trimming afterwards cannot
      // throw away the one that is about to be reused.
      void evictBuildDirs().catch(() => undefined);
    }
  }));
}

function finish(
  success: boolean,
  toolchain: 'arduino-cli' | 'avr-gcc',
  version: string,
  out: { stdout: string; stderr: string; hex?: string; binaryBase64?: string; binaryFormat?: 'uf2' | 'bin' | 'esp-image'; binaryRegions?: { offset: number; data: string }[]; binarySymbols?: FirmwareSymbols; flashBytes?: number; ramBytes?: number },
  diagnostics: Diagnostic[],
  target: { id: string; fqbn: string; flashMaxBytes: number; ramMaxBytes: number },
  started: number,
  syntaxOnly: boolean,
  simulationNotes: CompileResult['simulationNotes'],
): CompileResult {
  const result: CompileResult = {
    success,
    toolchain,
    toolchainVersion: version,
    stdout: out.stdout.slice(0, 64 * 1024),
    stderr: out.stderr.slice(0, 64 * 1024),
    diagnostics,
    durationMs: Date.now() - started,
    // Firmware identity travels with the artifact so no consumer has to infer
    // which board a build belongs to.
    boardId: target.id,
    fqbn: target.fqbn,
  };
  if (simulationNotes && simulationNotes.length > 0) result.simulationNotes = simulationNotes;
  if (success && !syntaxOnly) {
    if (out.hex) {
      result.firmware = { format: 'intel-hex', data: out.hex };
    } else if (out.binaryBase64 && out.binaryFormat) {
      result.firmware = { format: out.binaryFormat, data: out.binaryBase64, regions: out.binaryRegions };
      if (out.binarySymbols) result.firmware.symbols = out.binarySymbols;
    } else {
      result.success = false;
      result.error = 'Build succeeded but produced no firmware artifact for this target.';
      result.errorCode = 'INTERNAL';
    }
    if (out.flashBytes !== undefined && out.ramBytes !== undefined) {
      result.memory = {
        flashBytes: out.flashBytes,
        flashMaxBytes: target.flashMaxBytes,
        ramBytes: out.ramBytes,
        ramMaxBytes: target.ramMaxBytes,
      };
    }
  }
  if (!success && !result.error) {
    const firstError = diagnostics.find((d) => d.severity === 'error');
    result.error = firstError
      ? `${firstError.file}:${firstError.line}: ${firstError.message}`
      : 'Compilation failed. See compiler output for details.';
    result.errorCode = 'INVALID_SOURCE';
  }
  return result;
}
