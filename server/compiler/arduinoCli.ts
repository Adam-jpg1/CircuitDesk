import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 180_000;
/** Cap on captured compiler output; beyond this the build fails loudly. */
const OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * Parallel compiler jobs. arduino-cli defaults to one job per detected CPU,
 * but inside a container it sees the HOST's CPU count, not the memory the
 * instance actually has. Measured peak RSS for one RP2040 sketch on 4 CPUs:
 *
 *   default jobs : 685-690 MB across 9-13 processes
 *   --jobs 2     : 465-500 MB
 *   --jobs 1     : 354-375 MB
 *
 * A 512 MB instance cannot survive the default, which is what produced the
 * out-of-memory restarts (and the resulting 502s) on the deployed service.
 * Override with COMPILE_JOBS where there is more headroom.
 */
const COMPILE_JOBS = Math.max(1, Number(process.env.COMPILE_JOBS ?? '1') || 1);

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
  binaryFormat?: 'uf2' | 'bin' | 'esp-image';
  /** Other flash regions, at their real offsets, base64 encoded. */
  binaryRegions?: { offset: number; data: string }[];
  flashBytes?: number;
  ramBytes?: number;
}

export async function cliCompile(
  sketchDir: string,
  outputDir: string,
  fqbn: string,
  syntaxOnly: boolean,
  arch: 'avr' | 'rp2040' | 'esp32c3' | 'esp32c6' = 'avr',
): Promise<CliBuildOutput> {
  const jobs = ['--jobs', String(COMPILE_JOBS)];
  const args = syntaxOnly
    ? ['compile', ...jobs, '--fqbn', fqbn, '--warnings', 'default', '--dry-run', sketchDir]
    : ['compile', ...jobs, '--fqbn', fqbn, '--warnings', 'default', '--output-dir', outputDir, sketchDir];
  try {
    const { stdout, stderr } = await execFileAsync('arduino-cli', args, {
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: OUTPUT_LIMIT_BYTES,
      killSignal: 'SIGKILL',
    });
    let hex: string | undefined;
    let binaryBase64: string | undefined;
    let binaryFormat: 'uf2' | 'bin' | 'esp-image' | undefined;
    let binaryRegions: { offset: number; data: string }[] | undefined;
    if (!syntaxOnly) {
      const files = await readdir(outputDir);
      // Artifact choice follows the TARGET's architecture, not whatever the
      // core happens to emit first: an RP2040 build must never be handed back
      // as Intel HEX just because the core also wrote a .hex file.
      if (arch === 'rp2040') {
        const uf2 = files.find((f) => f.endsWith('.uf2'));
        const bin = files.find((f) => f.endsWith('.bin'));
        const chosen = uf2 ?? bin;
        if (chosen) {
          binaryBase64 = (await readFile(path.join(outputDir, chosen))).toString('base64');
          binaryFormat = uf2 ? 'uf2' : 'bin';
        }
      } else if (arch === 'esp32c3' || arch === 'esp32c6') {
        // An ESP build writes several .bin files: the application image, the
        // second-stage bootloader, the partition table and a merged 4 MB flash
        // image. The application image is the one that is executed, and it is
        // self-describing — it carries its own segment load addresses and entry
        // point — so it is picked by name rather than by taking whichever .bin
        // the directory listing happens to yield first.
        const app = files.find(
          (f) =>
            f.endsWith('.bin') &&
            !f.endsWith('.bootloader.bin') &&
            !f.endsWith('.partitions.bin') &&
            !f.endsWith('.merged.bin'),
        );
        if (app) {
          binaryBase64 = (await readFile(path.join(outputDir, app))).toString('base64');
          binaryFormat = 'esp-image';
          // The chip reads its partition table out of flash before it will run
          // anything, and reports the flash as unresponsive without it, so the
          // parts that are not executed still have to be shipped. These are the
          // offsets the core's own flashing recipe uses.
          const bootloader = files.find((f) => f.endsWith('.bootloader.bin'));
          const partitions = files.find((f) => f.endsWith('.partitions.bin'));
          binaryRegions = [];
          if (bootloader) {
            binaryRegions.push({ offset: 0x0, data: (await readFile(path.join(outputDir, bootloader))).toString('base64') });
          }
          if (partitions) {
            binaryRegions.push({ offset: 0x8000, data: (await readFile(path.join(outputDir, partitions))).toString('base64') });
          }
        }
      } else {
        const hexFile = files.find((f) => f.endsWith('.hex') && !f.endsWith('.with_bootloader.hex'));
        if (hexFile) hex = await readFile(path.join(outputDir, hexFile), 'utf8');
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
      binaryRegions,
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


