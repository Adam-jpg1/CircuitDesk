import path from 'node:path';
import { detectArduinoCli, cliCompile } from './arduinoCli.js';
import { detectGccToolchain, gccCompile, parseDiagnostics, BuildTimeoutError } from './gccToolchain.js';
import { buildSketchDir, buildCliSketchDir } from './sketchBuilder.js';
import { cleanupDir, createBuildDir, validateFiles, InputValidationError } from './fileService.js';
import { findTarget, type CompileRequest, type CompileResult, type Diagnostic } from './types.js';

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

export async function compileProject(req: CompileRequest, syntaxOnly: boolean): Promise<CompileResult> {
  const started = Date.now();
  const base: Omit<CompileResult, 'success'> = {
    toolchain: 'none',
    toolchainVersion: '',
    stdout: '',
    stderr: '',
    diagnostics: [],
    durationMs: 0,
  };

  const target = findTarget(req.fqbn);
  if (!target) {
    return {
      ...base,
      success: false,
      error: `Board "${req.fqbn}" has no compile support yet. Compilation currently targets AVR boards (arduino:avr:uno, arduino:avr:nano). Other boards are wiring/validation level for now.`,
      errorCode: 'UNSUPPORTED_BOARD',
      durationMs: Date.now() - started,
    };
  }

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

  const buildDir = await createBuildDir();
  try {
    if (health.toolchain === 'arduino-cli') {
      const sketchDir = await buildCliSketchDir(buildDir, req.files);
      const outDir = path.join(buildDir, 'out');
      const out = await cliCompile(sketchDir, outDir, target.fqbn, syntaxOnly);
      const nameMap = new Map<string, string>([['cdsketch.ino', 'sketch.ino']]);
      const diagnostics = parseDiagnostics(out.stderr, nameMap);
      return finish(out.code === 0, 'arduino-cli', health.version, out, diagnostics, target, started, syntaxOnly);
    }

    const gcc = await detectGccToolchain();
    const sketch = await buildSketchDir(buildDir, req.files);
    const sourcesText = req.files.map((f) => f.content);
    const out = await gccCompile(buildDir, target, gcc.coreRoot!, sketch.units, sourcesText, syntaxOnly);
    const diagnostics = parseDiagnostics(out.stderr, sketch.nameMap);
    if (out.missingLibraries.length > 0 && out.code !== 0) {
      const result = finish(false, 'avr-gcc', gcc.version, out, diagnostics, target, started, syntaxOnly);
      result.error = `Missing library: ${out.missingLibraries.join(', ')}. Only the Arduino core libraries (Wire, SPI, EEPROM, SoftwareSerial) are bundled with the local toolchain.`;
      result.errorCode = 'MISSING_LIBRARY';
      return result;
    }
    return finish(out.code === 0, 'avr-gcc', gcc.version, out, diagnostics, target, started, syntaxOnly);
  } catch (err) {
    if (err instanceof BuildTimeoutError) {
      return {
        ...base,
        success: false,
        error: err.message,
        errorCode: 'BUILD_TIMEOUT',
        durationMs: Date.now() - started,
      };
    }
    return {
      ...base,
      success: false,
      error: err instanceof Error ? err.message.slice(0, 2000) : 'Internal compiler error.',
      errorCode: 'INTERNAL',
      durationMs: Date.now() - started,
    };
  } finally {
    await cleanupDir(buildDir);
  }
}

function finish(
  success: boolean,
  toolchain: 'arduino-cli' | 'avr-gcc',
  version: string,
  out: { stdout: string; stderr: string; hex?: string; flashBytes?: number; ramBytes?: number },
  diagnostics: Diagnostic[],
  target: { flashMaxBytes: number; ramMaxBytes: number },
  started: number,
  syntaxOnly: boolean,
): CompileResult {
  const result: CompileResult = {
    success,
    toolchain,
    toolchainVersion: version,
    stdout: out.stdout.slice(0, 64 * 1024),
    stderr: out.stderr.slice(0, 64 * 1024),
    diagnostics,
    durationMs: Date.now() - started,
  };
  if (success && !syntaxOnly) {
    if (out.hex) {
      result.firmware = { format: 'intel-hex', data: out.hex };
    } else {
      result.success = false;
      result.error = 'Build succeeded but no HEX firmware was produced.';
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
