import type { BoardTarget } from './types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { CLI_CACHE_ROOT } from './buildCache.js';
import { dataDirFor, resolveSharedDataDir } from './coreDataDirs.js';

/**
 * Environment every arduino-cli call runs with.
 *
 * The only thing set here is where its build cache lives, so the compiled core
 * archives it shares between builds — and the per-sketch intermediate
 * directories that used to grow without limit — are somewhere this service can
 * measure and trim.
 */
const CLI_ENV = { ...process.env, ARDUINO_BUILD_CACHE_PATH: CLI_CACHE_ROOT };

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
  /**
   * Installed version per core id.
   *
   * "The core is installed" and "the core is the version this service was built
   * and validated against" are different claims, and a deployment that has
   * drifted looks healthy under the first one.
   */
  coreVersions: Record<string, string>;
  /**
   * Installed version per library name, from `arduino-cli lib list`.
   *
   * Reported for the same reason coreVersions is: a sketch that includes
   * Servo.h either compiles or does not, and which of those it is depends on
   * something the service can state up front instead of finding out per build.
   */
  libraryVersions: Record<string, string>;
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
    const coreVersions: Record<string, string> = {};
    try {
      const cores = await execFileAsync('arduino-cli', ['core', 'list'], { timeout: 20_000 });
      for (const line of cores.stdout.split('\n')) {
        const match = /^([a-z0-9_]+:[a-z0-9_]+)\s+(\S+)\s/i.exec(line.trim());
        if (!match) continue;
        installedCores.push(match[1]);
        coreVersions[match[1]] = match[2];
      }
    } catch {
      installedCores = [];
    }
    const libraryVersions = await listLibraries();
    const avrCoreInstalled = installedCores.includes('arduino:avr');
    cached = {
      available: true,
      version,
      installedCores,
      coreVersions,
      libraryVersions,
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
      coreVersions: {},
      libraryVersions: {},
      avrCoreInstalled: false,
      reason: 'arduino-cli is not installed or not on PATH.',
    };
  }
  return cached;
}

/**
 * `name -> version` for every installed library.
 *
 * The JSON key for this listing has moved between arduino-cli releases, so both
 * spellings are accepted; guessing one and reporting every library as missing
 * after an upgrade would be the same class of silent drift the pins exist to
 * prevent.
 */
async function listLibraries(): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};
  try {
    const { stdout } = await execFileAsync('arduino-cli', ['lib', 'list', '--format', 'json'], {
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed: unknown = JSON.parse(stdout);
    const container = parsed as Record<string, unknown> | unknown[];
    const list = Array.isArray(container)
      ? container
      : ((container?.['installed_libraries'] ?? container?.['installedLibraries'] ?? []) as unknown[]);
    for (const entry of Array.isArray(list) ? list : []) {
      const row = entry as { library?: { name?: string; version?: string }; name?: string; version?: string };
      const lib = row.library ?? row;
      if (lib?.name) versions[lib.name] = lib.version ?? 'unknown';
    }
  } catch {
    return {};
  }
  return versions;
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
  /** Time spent reading artifacts back off disk and encoding them. */
  artifactMs?: number;
}

/**
 * Build steps this service pays for and never reads.
 *
 * The ESP32 core's fourth post-objcopy hook runs esptool a third time to write
 * a padded 4 MB `.merged.bin` — the whole flash image, for flashing a physical
 * chip over a serial port. Nothing here flashes anything: the artifacts that
 * leave this service are the application image, the bootloader and the
 * partition table, each picked by name, and `.merged.bin` is explicitly
 * excluded from that choice. Writing it cost about 300 ms and 4 MB of disk on
 * every ESP32 build.
 *
 * Overriding a numbered hook is version-specific by nature, so the artifacts a
 * build produces with this applied are asserted byte-for-byte against a build
 * without it — see tests/compiler.performance.mts. If a future core renumbers
 * its hooks, that test fails rather than a needed artifact quietly vanishing.
 */
const SKIP_MERGED_IMAGE = ['--build-property', 'recipe.hooks.objcopy.postobjcopy.3.pattern=/usr/bin/env true'];

/**
 * The second-stage bootloader each ESP32 target's builds produce, by FQBN.
 *
 * Every ESP32 build starts by running esptool to turn the core's prebuilt
 * bootloader ELF into a flash image — about 250 ms, for a result that depends
 * only on the target and the core, never on the sketch, and is the same bytes
 * every time (tests/compiler.espArtifacts.mts compares it across builds). The
 * core's own prebuild recipe checks for a `bootloader.bin` in the sketch
 * folder first and copies it instead of running esptool; that is the hook a
 * user would use for a custom bootloader, and here it is handed the very image
 * esptool produced on this target's first build in this process.
 *
 * It can only ever hold the stock image: a request's files are restricted to
 * source extensions (fileService), so no build here has a user-supplied
 * bootloader to learn from, and the first build of each target — the warm-up —
 * always runs esptool. tests/compiler.espBootloader.mts asserts the artifacts
 * are byte-identical either way.
 */
const stockBootloaders = new Map<string, Buffer>();
const BOOTLOADER_FILE = 'bootloader.bin';

/**
 * Cores whose own compiler cannot run here, built with another installed one.
 *
 * The sandeepmistry nRF5 core ships GCC 5.2 for 32-bit x86 only, which a
 * 64-bit container without i386 libraries cannot execute. Its sources build
 * with the 64-bit GCC 7 the Arduino Renesas core installs. This is fixed
 * server configuration keyed by core — never anything a request supplies —
 * and it is passed as one argument, not through a shell.
 */
const TOOLCHAIN_OVERRIDES: Record<string, { packager: string; tool: string; version: string }> = {
  'sandeepmistry:nRF5': { packager: 'arduino', tool: 'arm-none-eabi-gcc', version: '7-2017q4' },
};

/** Intel HEX to the bytes it describes from `base` up, gaps left erased. */
export function hexToImage(hex: string, base: number): Buffer {
  const chunks: [number, Buffer][] = [];
  let upper = 0;
  let end = 0;
  for (const raw of hex.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith(':')) continue;
    const bytes = Buffer.from(line.slice(1), 'hex');
    const count = bytes[0];
    const type = bytes[3];
    if (type === 0x04) upper = ((bytes[4] << 8) | bytes[5]) * 0x10000;
    else if (type === 0x02) upper = ((bytes[4] << 8) | bytes[5]) * 16;
    else if (type === 0x01) break;
    else if (type === 0x00) {
      const at = upper + ((bytes[1] << 8) | bytes[2]) - base;
      if (at < 0) continue;
      chunks.push([at, bytes.subarray(4, 4 + count)]);
      end = Math.max(end, at + count);
    }
  }
  const image = Buffer.alloc(end, 0xff);
  for (const [at, data] of chunks) data.copy(image, at);
  return image;
}

async function toolchainOverride(fqbn: string): Promise<string[]> {
  const core = fqbn.split(':').slice(0, 2).join(':');
  const o = TOOLCHAIN_OVERRIDES[core];
  if (!o) return [];
  const shared = await resolveSharedDataDir();
  if (!shared) return [];
  const bin = path.join(shared, 'packages', o.packager, 'tools', o.tool, o.version, 'bin');
  return existsSync(bin) ? ['--build-property', `compiler.path=${bin}${path.sep}`] : [];
}

/** The Espressif targets, whose builds produce an application image plus bootloader and partitions. */
function isEspArch(arch: BoardTarget['arch']): boolean {
  return arch === 'esp32' || arch === 'esp32c3' || arch === 'esp32c6';
}

export async function cliCompile(
  sketchDir: string,
  outputDir: string,
  fqbn: string,
  syntaxOnly: boolean,
  arch: BoardTarget['arch'] = 'avr',
): Promise<CliBuildOutput> {
  const jobs = ['--jobs', String(COMPILE_JOBS)];
  const skip = isEspArch(arch) ? SKIP_MERGED_IMAGE : [];
  // Syntax-only is a real compile with the artifacts thrown away, not a flag.
  // It used to pass `--dry-run`, which arduino-cli 1.5.1 does not have: every
  // call to /api/compiler/validate failed with "unknown flag: --dry-run" and
  // reported it as a build failure. Nothing in the app calls that endpoint, so
  // it went unnoticed. Omitting --output-dir leaves the artifacts in
  // arduino-cli's own build directory, where they are never read.
  // Deliberately no --build-path. arduino-cli derives one from a hash of the
  // sketch's own path and keeps compiled CORE archives in a cache shared across
  // all builds — and passing --build-path opts out of that sharing, so the core
  // is rebuilt from nothing every time. Measured on an ESP32-C6: 4.2 s with the
  // shared core cache, 21.3 s without it. The sketch directory this is handed
  // is content-keyed instead, which is what keeps one user's sketch objects out
  // of another's while the core archives, which contain nobody's source, are
  // shared.
  const toolchain = await toolchainOverride(fqbn);
  const args = syntaxOnly
    ? ['compile', ...jobs, ...skip, ...toolchain, '--fqbn', fqbn, '--warnings', 'default', sketchDir]
    : ['compile', ...jobs, ...skip, ...toolchain, '--fqbn', fqbn, '--warnings', 'default', '--output-dir', outputDir, sketchDir];
  // A data directory holding only this core's package, so arduino-cli does not
  // parse every other installed platform before compiling — see coreDataDirs.
  const dataDir = await dataDirFor(fqbn);
  const isEsp = isEspArch(arch);
  const stockBootloader = isEsp && !syntaxOnly ? stockBootloaders.get(fqbn) : undefined;
  if (stockBootloader) await writeFile(path.join(sketchDir, BOOTLOADER_FILE), stockBootloader);
  const env = dataDir ? { ...CLI_ENV, ARDUINO_DIRECTORIES_DATA: dataDir } : CLI_ENV;
  try {
    const { stdout, stderr } = await execFileAsync('arduino-cli', args, {
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: OUTPUT_LIMIT_BYTES,
      killSignal: 'SIGKILL',
      env,
    });
    let hex: string | undefined;
    let binaryBase64: string | undefined;
    let binaryFormat: 'uf2' | 'bin' | 'esp-image' | undefined;
    let binaryRegions: { offset: number; data: string }[] | undefined;
    const artifactStart = Date.now();
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
      } else if (isEspArch(arch)) {
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
            const image = await readFile(path.join(outputDir, bootloader));
            // Learnt only from a build where esptool made it.
            if (!stockBootloader && image.length > 0) stockBootloaders.set(fqbn, image);
            // The classic ESP32's ROM loads the bootloader from 0x1000; the C3 and C6 from 0.
            binaryRegions.push({ offset: arch === 'esp32' ? 0x1000 : 0x0, data: image.toString('base64') });
          }
          if (partitions) {
            binaryRegions.push({ offset: 0x8000, data: (await readFile(path.join(outputDir, partitions))).toString('base64') });
          }
        }
      } else if (arch === 'imxrt1062') {
        // The Teensy core writes only Intel HEX, of the flash from 0x60000000;
        // the chip model takes it as a raw image of that flash.
        const hexFile = files.find((f) => f.endsWith('.ino.hex'));
        if (hexFile) {
          binaryBase64 = hexToImage(await readFile(path.join(outputDir, hexFile), 'utf8'), 0x60000000).toString('base64');
          binaryFormat = 'bin';
        }
      } else if (arch === 'sam3x' || arch === 'stm32f4' || arch === 'ra4m1' || arch === 'nrf52833' || arch === 'nrf52840') {
        // The ARM cores write a raw binary of flash from its first byte, which
        // is what the chip model loads; a .hex beside it (where a core makes
        // one) is the same image in another encoding.
        const bin = files.find((f) => f.endsWith('.ino.bin'));
        if (bin) {
          binaryBase64 = (await readFile(path.join(outputDir, bin))).toString('base64');
          binaryFormat = 'bin';
        }
      } else {
        const hexFile = files.find((f) => f.endsWith('.hex') && !f.endsWith('.with_bootloader.hex'));
        if (hexFile) hex = await readFile(path.join(outputDir, hexFile), 'utf8');
      }
    }
    const artifactMs = Date.now() - artifactStart;
    if (stockBootloader) await rm(path.join(sketchDir, BOOTLOADER_FILE), { force: true });
    const flashMatch = /Sketch uses (\d+) bytes/.exec(stdout);
    const ramMatch = /Global variables use (\d+) bytes/.exec(stdout);
    return {
      artifactMs,
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
    if (stockBootloader) await rm(path.join(sketchDir, BOOTLOADER_FILE), { force: true });
    const e = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? (e.killed ? 'Build timed out.' : 'arduino-cli failed.'),
    };
  }
}



/** For tests: forget the learnt bootloaders, so the next build runs esptool. */
export function forgetStockBootloaders(): void {
  stockBootloaders.clear();
}
