import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardTarget, Diagnostic } from './types.js';

const execFileAsync = promisify(execFile);

const COMPILE_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 512 * 1024;

/** Well-known locations of the Arduino AVR core (Debian/Ubuntu arduino-core-avr package first). */
const CORE_ROOT_CANDIDATES = [
  '/usr/share/arduino/hardware/arduino/avr',
  '/usr/local/share/arduino/hardware/arduino/avr',
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_ROOT = path.resolve(__dirname, '../../.server-cache');

export interface GccAvailability {
  available: boolean;
  version: string;
  coreRoot?: string;
  reason?: string;
}

let availability: GccAvailability | undefined;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function detectGccToolchain(): Promise<GccAvailability> {
  if (availability) return availability;
  try {
    const { stdout } = await execFileAsync('avr-g++', ['--version'], { timeout: 10_000 });
    const version = stdout.split('\n')[0]?.trim() ?? 'avr-g++';
    let coreRoot: string | undefined;
    for (const candidate of CORE_ROOT_CANDIDATES) {
      if (await exists(path.join(candidate, 'cores/arduino/Arduino.h'))) {
        coreRoot = candidate;
        break;
      }
    }
    if (!coreRoot) {
      availability = {
        available: false,
        version,
        reason:
          'avr-g++ found but the Arduino AVR core is missing. Install it with: apt-get install arduino-core-avr (or install arduino-cli and run: arduino-cli core install arduino:avr).',
      };
    } else {
      availability = { available: true, version, coreRoot };
    }
  } catch {
    availability = {
      available: false,
      version: '',
      reason:
        'avr-g++ not found. Install the AVR toolchain (apt-get install gcc-avr avr-libc arduino-core-avr) or install arduino-cli.',
    };
  }
  return availability;
}

function baseFlags(target: BoardTarget, coreRoot: string): string[] {
  // Per-target MCU, variant and board define — no target ever borrows the
  // Uno's flags. The allowlist in types.ts is the only source of targets.
  const flags = [
    `-mmcu=${target.mcu}`,
    `-DF_CPU=${target.fCpuHz}L`,
    '-DARDUINO=10819',
    `-D${target.boardDefine ?? 'ARDUINO_AVR'}`,
    '-DARDUINO_ARCH_AVR',
    `-I${path.join(coreRoot, 'cores/arduino')}`,
    `-I${path.join(coreRoot, `variants/${target.variant ?? 'standard'}`)}`,
    '-Os',
    '-ffunction-sections',
    '-fdata-sections',
    '-flto',
  ];
  if (target.usbVid && target.usbPid) {
    flags.push(`-DUSB_VID=${target.usbVid}`, `-DUSB_PID=${target.usbPid}`, '-DUSB_MANUFACTURER="Unknown"', '-DUSB_PRODUCT="USB IO Board"');
  }
  return flags;
}

const CPP_ONLY_FLAGS = ['-fno-exceptions', '-fno-threadsafe-statics', '-std=gnu++11'];

async function run(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      timeout: COMPILE_TIMEOUT_MS,
      maxBuffer: OUTPUT_LIMIT,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    return { code: 0, stdout, stderr };
  } catch (err: unknown) {
    const e = err as { code?: number | string; killed?: boolean; signal?: string; stdout?: string; stderr?: string };
    if (e.killed || e.signal === 'SIGTERM') {
      throw new BuildTimeoutError();
    }
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

export class BuildTimeoutError extends Error {
  constructor() {
    super('The build exceeded the time limit and was stopped.');
  }
}

/**
 * Compiles the Arduino core once per MCU and caches the resulting core.a
 * archive under .server-cache. Subsequent sketch builds link against the
 * cached archive, keeping compiles fast.
 */
export async function ensureCoreArchive(target: BoardTarget, coreRoot: string): Promise<string> {
  const cacheDir = path.join(CACHE_ROOT, `core-${target.mcu}-${target.variant ?? 'standard'}-f${target.fCpuHz}`);
  const archive = path.join(cacheDir, 'core.a');
  if (await exists(archive)) return archive;
  await mkdir(cacheDir, { recursive: true });

  const coreSrc = path.join(coreRoot, 'cores/arduino');
  const entries = await readdir(coreSrc);
  const flags = baseFlags(target, coreRoot).concat('-w');
  const objects: string[] = [];

  for (const entry of entries) {
    const src = path.join(coreSrc, entry);
    const obj = path.join(cacheDir, `${entry}.o`);
    let result: { code: number; stderr: string } | undefined;
    if (entry.endsWith('.c')) {
      result = await run('avr-gcc', [...flags, '-c', src, '-o', obj], cacheDir);
    } else if (entry.endsWith('.cpp')) {
      result = await run('avr-g++', [...flags, ...CPP_ONLY_FLAGS, '-c', src, '-o', obj], cacheDir);
    } else if (entry.endsWith('.S')) {
      result = await run('avr-gcc', [...flags, '-x', 'assembler-with-cpp', '-c', src, '-o', obj], cacheDir);
    } else {
      continue;
    }
    if (result.code !== 0) {
      throw new Error(`Failed to compile Arduino core file ${entry}: ${result.stderr.slice(0, 2000)}`);
    }
    objects.push(obj);
  }

  const ar = await run('avr-gcc-ar', ['rcs', archive, ...objects], cacheDir);
  if (ar.code !== 0) {
    throw new Error(`Failed to archive Arduino core: ${ar.stderr.slice(0, 2000)}`);
  }
  return archive;
}

/** Bundled Arduino core libraries (Wire, SPI, EEPROM, SoftwareSerial, ...). */
async function resolveCoreLibraries(
  coreRoot: string,
  sources: string[],
): Promise<{ includeDirs: string[]; units: string[]; missing: string[] }> {
  const libRoot = path.join(coreRoot, 'libraries');
  const includeRe = /^\s*#\s*include\s*<([A-Za-z0-9_\-./]+)\.h>/gm;
  const wanted = new Set<string>();
  for (const src of sources) {
    for (const m of src.matchAll(includeRe)) {
      wanted.add(m[1].split('/')[0]);
    }
  }
  const includeDirs: string[] = [];
  const units: string[] = [];
  const missing: string[] = [];
  const coreHeaders = new Set([
    'Arduino', 'HardwareSerial', 'Print', 'Stream', 'String', 'WString', 'Wire', 'SPI',
    'EEPROM', 'SoftwareSerial', 'avr', 'util', 'math', 'string', 'stdlib', 'stdio', 'stdint',
    'inttypes', 'ctype', 'errno', 'float', 'limits', 'locale', 'setjmp', 'signal', 'stdarg',
    'stddef', 'time', 'assert', 'alloca', 'stdbool', 'Printable', 'Client', 'Server', 'Udp',
    'IPAddress', 'USBAPI', 'PluggableUSB', 'pins_arduino', 'wiring_private', 'binary', 'new',
  ]);
  for (const name of wanted) {
    const dir = path.join(libRoot, name);
    const srcDir = path.join(dir, 'src');
    if (await exists(srcDir)) {
      includeDirs.push(srcDir);
      for (const f of await readdir(srcDir)) {
        if (f.endsWith('.cpp') || f.endsWith('.c')) units.push(path.join(srcDir, f));
      }
    } else if (await exists(dir)) {
      includeDirs.push(dir);
      for (const f of await readdir(dir)) {
        if (f.endsWith('.cpp') || f.endsWith('.c')) units.push(path.join(dir, f));
      }
    } else if (!coreHeaders.has(name)) {
      missing.push(name);
    }
  }
  return { includeDirs, units, missing };
}

export interface GccBuildOutput {
  code: number;
  stdout: string;
  stderr: string;
  hex?: string;
  flashBytes?: number;
  ramBytes?: number;
  missingLibraries: string[];
}

export async function gccCompile(
  buildDir: string,
  target: BoardTarget,
  coreRoot: string,
  units: string[],
  sourcesText: string[],
  syntaxOnly: boolean,
): Promise<GccBuildOutput> {
  const flags = baseFlags(target, coreRoot);
  const libs = await resolveCoreLibraries(coreRoot, sourcesText);
  const libIncludes = libs.includeDirs.map((d) => `-I${d}`);

  let stdoutAll = '';
  let stderrAll = '';

  if (syntaxOnly) {
    for (const unit of units) {
      const isC = unit.endsWith('.c');
      const args = [...flags, ...libIncludes, '-Wall', '-fsyntax-only', unit];
      const res = isC
        ? await run('avr-gcc', args, buildDir)
        : await run('avr-g++', [...flags, ...CPP_ONLY_FLAGS, ...libIncludes, '-Wall', '-fsyntax-only', unit], buildDir);
      stdoutAll += res.stdout;
      stderrAll += res.stderr;
      if (res.code !== 0) {
        return { code: res.code, stdout: stdoutAll, stderr: stderrAll, missingLibraries: libs.missing };
      }
    }
    return { code: 0, stdout: stdoutAll, stderr: stderrAll, missingLibraries: libs.missing };
  }

  const coreArchive = await ensureCoreArchive(target, coreRoot);
  const objects: string[] = [];

  for (const unit of units) {
    const obj = path.join(buildDir, `${path.basename(unit)}.o`);
    const isC = unit.endsWith('.c');
    const res = isC
      ? await run('avr-gcc', [...flags, ...libIncludes, '-Wall', '-c', unit, '-o', obj], buildDir)
      : await run(
          'avr-g++',
          [...flags, ...CPP_ONLY_FLAGS, ...libIncludes, '-Wall', '-c', unit, '-o', obj],
          buildDir,
        );
    stdoutAll += res.stdout;
    stderrAll += res.stderr;
    if (res.code !== 0) {
      return { code: res.code, stdout: stdoutAll, stderr: stderrAll, missingLibraries: libs.missing };
    }
    objects.push(obj);
  }

  for (const libUnit of libs.units) {
    const obj = path.join(buildDir, `lib_${path.basename(libUnit)}.o`);
    const isC = libUnit.endsWith('.c');
    const res = isC
      ? await run('avr-gcc', [...flags, ...libIncludes, '-w', '-c', libUnit, '-o', obj], buildDir)
      : await run('avr-g++', [...flags, ...CPP_ONLY_FLAGS, ...libIncludes, '-w', '-c', libUnit, '-o', obj], buildDir);
    stdoutAll += res.stdout;
    stderrAll += res.stderr;
    if (res.code !== 0) {
      return { code: res.code, stdout: stdoutAll, stderr: stderrAll, missingLibraries: libs.missing };
    }
    objects.push(obj);
  }

  const elf = path.join(buildDir, 'firmware.elf');
  const link = await run(
    'avr-gcc',
    [...flags, '-Wl,--gc-sections', '-fuse-linker-plugin', '-o', elf, ...objects, coreArchive, '-lm'],
    buildDir,
  );
  stdoutAll += link.stdout;
  stderrAll += link.stderr;
  if (link.code !== 0) {
    return { code: link.code, stdout: stdoutAll, stderr: stderrAll, missingLibraries: libs.missing };
  }

  const hexPath = path.join(buildDir, 'firmware.hex');
  const objcopy = await run('avr-objcopy', ['-O', 'ihex', '-R', '.eeprom', elf, hexPath], buildDir);
  stdoutAll += objcopy.stdout;
  stderrAll += objcopy.stderr;
  if (objcopy.code !== 0) {
    return { code: objcopy.code, stdout: stdoutAll, stderr: stderrAll, missingLibraries: libs.missing };
  }

  let flashBytes: number | undefined;
  let ramBytes: number | undefined;
  const size = await run('avr-size', [elf], buildDir);
  const line = size.stdout.trim().split('\n').pop() ?? '';
  const cols = line.trim().split(/\s+/);
  if (cols.length >= 3) {
    const text = Number(cols[0]);
    const data = Number(cols[1]);
    const bss = Number(cols[2]);
    if (Number.isFinite(text) && Number.isFinite(data)) flashBytes = text + data;
    if (Number.isFinite(data) && Number.isFinite(bss)) ramBytes = data + bss;
  }

  const hex = await readFile(hexPath, 'utf8');
  return {
    code: 0,
    stdout: stdoutAll,
    stderr: stderrAll,
    hex,
    flashBytes,
    ramBytes,
    missingLibraries: libs.missing,
  };
}

const DIAG_RE = /^([^\s:][^:\n]*):(\d+):(\d+):\s+(fatal error|error|warning|note):\s+(.*)$/;

export function parseDiagnostics(stderr: string, nameMap: Map<string, string>): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (const rawLine of stderr.split('\n')) {
    const m = DIAG_RE.exec(rawLine.trim());
    if (!m) continue;
    const rawFile = path.basename(m[1]);
    const file = nameMap.get(rawFile) ?? rawFile;
    const severity = m[4] === 'warning' ? 'warning' : m[4] === 'note' ? 'note' : 'error';
    diags.push({
      file,
      line: Number(m[2]),
      column: Number(m[3]),
      severity,
      message: m[5],
    });
    if (diags.length >= 200) break;
  }
  return diags;
}
