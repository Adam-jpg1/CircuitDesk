import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { BoardTarget } from './types.js';

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 180_000;

export interface CliAvailability {
  available: boolean;
  version: string;
  avrCoreInstalled: boolean;
  reason?: string;
}

let cached: CliAvailability | undefined;

export async function detectArduinoCli(): Promise<CliAvailability> {
  if (cached) return cached;
  try {
    const { stdout } = await execFileAsync('arduino-cli', ['version'], { timeout: 10_000 });
    const version = stdout.trim();
    let avrCoreInstalled = false;
    try {
      const cores = await execFileAsync('arduino-cli', ['core', 'list'], { timeout: 20_000 });
      avrCoreInstalled = /arduino:avr/.test(cores.stdout);
    } catch {
      avrCoreInstalled = false;
    }
    cached = {
      available: true,
      version,
      avrCoreInstalled,
      reason: avrCoreInstalled
        ? undefined
        : 'arduino-cli is installed but the AVR core is missing. Run: arduino-cli core install arduino:avr',
    };
  } catch {
    cached = {
      available: false,
      version: '',
      avrCoreInstalled: false,
      reason: 'arduino-cli is not installed or not on PATH.',
    };
  }
  return cached;
}

export interface CliBuildOutput {
  code: number;
  stdout: string;
  stderr: string;
  hex?: string;
  flashBytes?: number;
  ramBytes?: number;
}

export async function cliCompile(
  sketchDir: string,
  outputDir: string,
  fqbn: string,
  syntaxOnly: boolean,
): Promise<CliBuildOutput> {
  const args = syntaxOnly
    ? ['compile', '--fqbn', fqbn, '--warnings', 'default', '--dry-run', sketchDir]
    : ['compile', '--fqbn', fqbn, '--warnings', 'default', '--output-dir', outputDir, sketchDir];
  try {
    const { stdout, stderr } = await execFileAsync('arduino-cli', args, {
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    let hex: string | undefined;
    if (!syntaxOnly) {
      const files = await readdir(outputDir);
      const hexFile = files.find((f) => f.endsWith('.hex') && !f.endsWith('.with_bootloader.hex'));
      if (hexFile) hex = await readFile(path.join(outputDir, hexFile), 'utf8');
    }
    const flashMatch = /Sketch uses (\d+) bytes/.exec(stdout);
    const ramMatch = /Global variables use (\d+) bytes/.exec(stdout);
    return {
      code: 0,
      stdout,
      stderr,
      hex,
      flashBytes: flashMatch ? Number(flashMatch[1]) : undefined,
      ramBytes: ramMatch ? Number(ramMatch[1]) : undefined,
    };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? (e.killed ? 'Build timed out.' : 'arduino-cli failed.'),
    };
  }
}

export function targetFqbnSupported(target: BoardTarget): boolean {
  return target.fqbn.startsWith('arduino:avr:');
}
