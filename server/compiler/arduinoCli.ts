import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 180_000;

export interface CliAvailability {
  available: boolean;
  version: string;
  /** Core ids reported installed by `arduino-cli core list` (e.g. "arduino:avr"). */
  installedCores: string[];
  avrCoreInstalled: boolean;
  reason?: string;
}

let cached: CliAvailability | undefined;

export async function detectArduinoCli(): Promise<CliAvailability> {
  if (cached) return cached;
  try {
    const { stdout } = await execFileAsync('arduino-cli', ['version'], { timeout: 10_000 });
    const version = stdout.trim();
    let installedCores: string[] = [];
    try {
      const cores = await execFileAsync('arduino-cli', ['core', 'list'], { timeout: 20_000 });
      installedCores = cores.stdout
        .split('\n')
        .map((line) => /^([a-z0-9_]+:[a-z0-9_]+)\s/i.exec(line.trim())?.[1])
        .filter((c): c is string => Boolean(c));
    } catch {
      installedCores = [];
    }
    const avrCoreInstalled = installedCores.includes('arduino:avr');
    cached = {
      available: true,
      version,
      installedCores,
      avrCoreInstalled,
      reason: avrCoreInstalled
        ? undefined
        : 'arduino-cli is installed but the AVR core is missing. Run: arduino-cli core install arduino:avr',
    };
  } catch {
    cached = {
      available: false,
      version: '',
      installedCores: [],
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
  /** base64-encoded binary firmware for non-AVR targets (.uf2 preferred, else .bin). */
  binaryBase64?: string;
  binaryFormat?: 'uf2' | 'bin';
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
    let binaryBase64: string | undefined;
    let binaryFormat: 'uf2' | 'bin' | undefined;
    if (!syntaxOnly) {
      const files = await readdir(outputDir);
      const hexFile = files.find((f) => f.endsWith('.hex') && !f.endsWith('.with_bootloader.hex'));
      if (hexFile) hex = await readFile(path.join(outputDir, hexFile), 'utf8');
      if (!hexFile) {
        const uf2 = files.find((f) => f.endsWith('.uf2'));
        const bin = files.find((f) => f.endsWith('.bin'));
        const chosen = uf2 ?? bin;
        if (chosen) {
          binaryBase64 = (await readFile(path.join(outputDir, chosen))).toString('base64');
          binaryFormat = uf2 ? 'uf2' : 'bin';
        }
      }
    }
    const flashMatch = /Sketch uses (\d+) bytes/.exec(stdout);
    const ramMatch = /Global variables use (\d+) bytes/.exec(stdout);
    return {
      code: 0,
      stdout,
      stderr,
      hex,
      binaryBase64,
      binaryFormat,
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


