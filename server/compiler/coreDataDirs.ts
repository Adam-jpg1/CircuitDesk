// One arduino-cli data directory per core, so a build loads only its own.
//
// arduino-cli has no way to say "load just this platform". Every invocation
// reads every installed package before it compiles anything, so an Uno build
// pays to parse the ESP32 core's two hundred boards and its toolchain manifest,
// then throws them away. Measured on this service, with the cores warm:
//
//   board details, all cores installed     541-593 ms
//   board details, only arduino:avr        296 ms
//   Uno compile, shared data directory     905-908 ms
//   Uno compile, AVR-only data directory   592-747 ms
//
// That is a quarter of every AVR build, which is most builds, spent on nothing.
//
// The fix is a data directory per packager that contains only that packager's
// package — the core AND its tools, which live together under packages/<vendor>
// — plus arduino-cli's own `builtin` tools, with the package indexes linked in
// so dependency resolution sees the same metadata. Everything is a symlink into
// the real installation: nothing is copied, nothing is installed twice, and the
// pinned versions are exactly the ones installCores.mjs put there.
//
// What is NOT shared is what arduino-cli writes: its tmp, staging and inventory
// files are created fresh inside each directory, so two directories can never
// write over one another's state.
//
// Each directory is checked once by asking arduino-cli to resolve a board from
// it. A directory that does not resolve is never used, and builds for that core
// keep the shared directory — slower, but never a build that fails because of
// an optimisation.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, symlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { CLI_CACHE_ROOT } from './buildCache.js';

const execFileAsync = promisify(execFile);

/** Where the split directories live: beside arduino-cli's caches, never evicted. */
export const SPLIT_DATA_ROOT = path.join(CLI_CACHE_ROOT, 'data');

let sharedDataDir: Promise<string | undefined> | undefined;

/** The real data directory the cores were installed into. */
export function resolveSharedDataDir(): Promise<string | undefined> {
  sharedDataDir ??= (async () => {
    if (process.env.ARDUINO_DIRECTORIES_DATA) return process.env.ARDUINO_DIRECTORIES_DATA;
    try {
      const { stdout } = await execFileAsync('arduino-cli', ['config', 'get', 'directories.data'], { timeout: 10_000 });
      const dir = stdout.trim().split('\n')[0]?.trim();
      return dir && existsSync(dir) ? dir : undefined;
    } catch {
      return undefined;
    }
  })();
  return sharedDataDir;
}

/** The packager half of an FQBN or core id: "esp32:esp32:esp32c3" -> "esp32". */
export function packagerOf(fqbnOrCore: string): string | undefined {
  const vendor = fqbnOrCore.split(':')[0];
  return vendor && /^[a-z0-9_.-]+$/i.test(vendor) ? vendor : undefined;
}

async function linkIfAbsent(target: string, linkPath: string): Promise<void> {
  try {
    await lstat(linkPath);
    return; // already there
  } catch {
    /* create it */
  }
  await symlink(target, linkPath);
}

/** Builds (or repairs) the directory for one packager. Returns its path. */
async function assemble(shared: string, vendor: string): Promise<string | undefined> {
  const realPackage = path.join(shared, 'packages', vendor);
  if (!existsSync(realPackage)) return undefined;
  const dir = path.join(SPLIT_DATA_ROOT, vendor);
  await mkdir(path.join(dir, 'packages'), { recursive: true });
  await linkIfAbsent(realPackage, path.join(dir, 'packages', vendor));
  const builtin = path.join(shared, 'packages', 'builtin');
  if (existsSync(builtin)) await linkIfAbsent(builtin, path.join(dir, 'packages', 'builtin'));
  // The package indexes, so tool dependencies resolve against the same
  // metadata the shared directory has. Read-only to a compile.
  for (const name of await readdir(shared)) {
    if (/^package_.*index\.json(\.sig)?$/.test(name)) {
      await linkIfAbsent(path.join(shared, name), path.join(dir, name));
    }
  }
  return dir;
}

/** Per packager: the directory to use, or undefined for "use the shared one". */
const chosen = new Map<string, Promise<string | undefined>>();

/**
 * The data directory a build for `fqbn` should run with, or undefined to keep
 * the shared one. Checked once per packager by resolving `fqbn` from it.
 */
export function dataDirFor(fqbn: string): Promise<string | undefined> {
  if (process.env.CIRCUITDESK_SPLIT_DATA_DIRS === '0') return Promise.resolve(undefined);
  const vendor = packagerOf(fqbn);
  if (!vendor) return Promise.resolve(undefined);
  let pending = chosen.get(vendor);
  if (!pending) {
    pending = (async () => {
      const shared = await resolveSharedDataDir();
      if (!shared) return undefined;
      try {
        const dir = await assemble(shared, vendor);
        if (!dir) return undefined;
        await execFileAsync('arduino-cli', ['board', 'details', '-b', fqbn], {
          timeout: 30_000,
          env: { ...process.env, ARDUINO_DIRECTORIES_DATA: dir },
        });
        return dir;
      } catch {
        return undefined;
      }
    })();
    chosen.set(vendor, pending);
  }
  return pending.then((dir) => {
    // Something removed it since it was checked: rebuild on the next call, and
    // use the shared directory for this one rather than a half-present tree.
    if (dir && !existsSync(path.join(dir, 'packages', vendor))) {
      chosen.delete(vendor);
      return undefined;
    }
    return dir;
  });
}

/** For the capability report and tests: which packagers run from their own directory. */
export async function splitDataDirReport(): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const [vendor, pending] of chosen) out[vendor] = (await pending) ?? null;
  return out;
}
