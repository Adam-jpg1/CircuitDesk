// Where builds happen, and what is remembered about them.
//
// Three separate things live here, and keeping them separate matters:
//
//   1. the build KEY — what makes two compile requests the same build;
//   2. the build DIRECTORY — a stable place on disk per key, so arduino-cli can
//      find its own intermediate objects again instead of starting from nothing;
//   3. the artifact CACHE — the finished result for a key, so an identical
//      request does not run the toolchain at all.
//
// The key is a hash of everything that can change the bytes: the target, the
// toolchain and core versions, whether this is a full build or a syntax check,
// and every source file's name and content. Nothing about the request's origin
// goes into it, which is what makes sharing safe — two requests with the same
// key have byte-identical sources by construction, so one cannot see anything
// of the other's that it did not already have. Nothing about the *project*
// goes into it either: renaming a board, moving a part or dragging a wire
// cannot change the key, so none of those can cost a compile.
//
// The directory is content-keyed for two reasons. It keeps one request's sketch
// objects out of another's, which is the isolation rule; and because
// arduino-cli derives its own intermediate directory from a hash of the sketch
// path, a stable sketch path means a stable intermediate directory that it can
// reuse. What must NOT be done is to pass --build-path: that opts out of the
// shared core-archive cache, and an ESP32-C6 build goes from 4.2 s to 21.3 s
// because it recompiles the entire core every time.
//
// Both trees are bounded here. arduino-cli's own sketch cache had grown to
// 2.2 GB on the machine this was measured on, because a fresh mkdtemp per build
// meant a fresh cache entry per build and its time-based purge never caught up.

import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CompileResult } from './types.js';

/**
 * Root for build directories.
 *
 * Under the OS temp directory by default, which on Render is ephemeral local
 * disk: the cache is a speed-up, never a source of truth, and a service that
 * restarts with an empty one is slower for a few builds and correct throughout.
 * COMPILE_CACHE_DIR points it at a persistent disk where one exists.
 */
export const CACHE_ROOT = process.env.COMPILE_CACHE_DIR ?? path.join(tmpdir(), 'circuitdesk-builds');

/**
 * arduino-cli's own build cache, pointed somewhere we can measure and trim.
 *
 * Left at its default (~/.cache/arduino) it holds two things: `cores`, a few
 * tens of MB of compiled core archives that every build reuses and that must be
 * kept, and `sketches`, one intermediate directory per distinct sketch path
 * that nothing ever removes. Setting this before the first arduino-cli call
 * puts both under our root so the second one can be bounded. It is handed to
 * arduino-cli explicitly on every invocation rather than exported into the
 * process environment, so nothing depends on which module loaded first.
 */
export const CLI_CACHE_ROOT = process.env.ARDUINO_BUILD_CACHE_PATH ?? path.join(CACHE_ROOT, 'acli');

/**
 * How much build tree to keep.
 *
 * A measured ESP32 build directory is about 28 MB and an AVR one about 1 MB, so
 * the defaults hold roughly twenty ESP builds or several hundred AVR ones. The
 * ceiling is deliberately modest: this is ephemeral disk on a small instance,
 * and an unbounded cache is how ~/.cache/arduino/sketches reached 2.2 GB on the
 * machine this was measured on. Both limits are enforced — whichever binds
 * first evicts, oldest to newest.
 */
const MAX_BUILD_DIRS = Math.max(4, Number(process.env.COMPILE_CACHE_MAX_DIRS ?? '48') || 48);
const MAX_BUILD_BYTES = Math.max(
  64 * 1024 * 1024,
  Number(process.env.COMPILE_CACHE_MAX_BYTES ?? String(512 * 1024 * 1024)) || 512 * 1024 * 1024,
);

/** How many finished results to keep in memory, and how much they may weigh. */
const MAX_ARTIFACTS = Math.max(4, Number(process.env.COMPILE_ARTIFACT_MAX ?? '32') || 32);
// Artifacts live in the compiler process's heap, which shares 512 MB with the
// compiler itself. A 300 KB ESP32 image base64s to about 400 KB, so 32 MB is
// roughly eighty of them and nowhere near the headroom COMPILE_JOBS=1 exists
// to protect.
const MAX_ARTIFACT_BYTES = Math.max(
  4 * 1024 * 1024,
  Number(process.env.COMPILE_ARTIFACT_MAX_BYTES ?? String(32 * 1024 * 1024)) || 32 * 1024 * 1024,
);

export interface BuildKeyInput {
  fqbn: string;
  /** arduino-cli version string, so a toolchain upgrade invalidates everything. */
  toolchainVersion: string;
  /** Installed version of the core that builds this target. */
  coreVersion: string;
  syntaxOnly: boolean;
  files: { name: string; content: string }[];
}

/**
 * The identity of a build.
 *
 * Order-independent in the files (a project that reorders its tabs is the same
 * build) and length-delimited (so two files cannot be concatenated into a third
 * that hashes the same).
 */
export function buildKey(input: BuildKeyInput): string {
  const h = createHash('sha256');
  h.update('circuitdesk-build-v1\0');
  h.update(`${input.fqbn}\0${input.toolchainVersion}\0${input.coreVersion}\0${input.syntaxOnly ? 'syntax' : 'full'}\0`);
  const files = [...input.files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const f of files) {
    h.update(`${f.name.length}:${f.name}\0`);
    h.update(`${Buffer.byteLength(f.content, 'utf8')}:`);
    h.update(f.content, 'utf8');
    h.update('\0');
  }
  return h.digest('hex');
}

/** The build directory for a key, created if it does not exist yet. */
export async function buildDirFor(key: string): Promise<string> {
  const dir = path.join(CACHE_ROOT, key.slice(0, 32));
  await mkdir(dir, { recursive: true });
  return dir;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        try {
          total += (await stat(full)).size;
        } catch {
          /* raced with eviction */
        }
      }
    }
  }
  return total;
}

/**
 * Sizes already measured, by directory and the mtime they were measured at.
 *
 * Walking an ESP32 build directory is a few thousand stat calls, and sixty of
 * them on every build would cost more than the eviction saves. A directory that
 * has not been touched since it was last measured has not changed size.
 */
const sizeCache = new Map<string, { mtime: number; size: number }>();
let lastEviction = 0;

/** How often the tree is walked, however many builds happen in between. */
const EVICT_INTERVAL_MS = 60_000;

/**
 * Trims the build tree back inside its limits, oldest first.
 *
 * Deliberately after the build rather than before it: evicting first would risk
 * throwing away the directory the next request is about to reuse, and the whole
 * point is that the directory survives to be reused.
 */
export async function evictBuildDirs(force = false): Promise<{ removed: number; bytes: number; keptBytes: number }> {
  const now = Date.now();
  if (!force && now - lastEviction < EVICT_INTERVAL_MS) return { removed: 0, bytes: 0, keptBytes: 0 };
  lastEviction = now;
  let entries;
  try {
    entries = await readdir(CACHE_ROOT, { withFileTypes: true });
  } catch {
    return { removed: 0, bytes: 0, keptBytes: 0 };
  }
  const dirs: { dir: string; mtime: number; size: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // arduino-cli's cache lives under this root too, and it is NOT a build
    // directory: deleting it takes the compiled core archives with it, and the
    // next build of that target pays a full core compile. Measured cost of
    // getting this wrong: an ESP32-C6 build at 20 s instead of 3.7 s, at
    // whatever interval the eviction happened to fire. Its `sketches` half is
    // trimmed below, by name, so `cores` is never a candidate.
    if (path.join(CACHE_ROOT, entry.name) === CLI_CACHE_ROOT) continue;
    const full = path.join(CACHE_ROOT, entry.name);
    try {
      const s = await stat(full);
      const known = sizeCache.get(full);
      const size = known && known.mtime === s.mtimeMs ? known.size : await dirSize(full);
      sizeCache.set(full, { mtime: s.mtimeMs, size });
      dirs.push({ dir: full, mtime: s.mtimeMs, size });
    } catch {
      /* gone already */
    }
  }
  // arduino-cli's own intermediate directories are the other half of the tree
  // and grow the same way, so they are trimmed by the same rule. Its `cores`
  // directory is deliberately NOT in this list: those archives are what every
  // build reuses, they are small, and throwing one away costs a full core
  // rebuild — 17 seconds on an ESP32.
  try {
    const sketches = path.join(CLI_CACHE_ROOT, 'sketches');
    for (const entry of await readdir(sketches, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(sketches, entry.name);
      try {
        const s = await stat(full);
        const known = sizeCache.get(full);
        const size = known && known.mtime === s.mtimeMs ? known.size : await dirSize(full);
        sizeCache.set(full, { mtime: s.mtimeMs, size });
        dirs.push({ dir: full, mtime: s.mtimeMs, size });
      } catch {
        /* gone already */
      }
    }
  } catch {
    /* arduino-cli has not built anything yet */
  }

  // Newest first: everything past the limits is what goes.
  dirs.sort((a, b) => b.mtime - a.mtime);
  let keptBytes = 0;
  let removed = 0;
  let bytes = 0;
  for (let i = 0; i < dirs.length; i++) {
    const over = i >= MAX_BUILD_DIRS || keptBytes + dirs[i].size > MAX_BUILD_BYTES;
    if (over) {
      await rm(dirs[i].dir, { recursive: true, force: true }).catch(() => undefined);
      sizeCache.delete(dirs[i].dir);
      removed++;
      bytes += dirs[i].size;
    } else {
      keptBytes += dirs[i].size;
    }
  }
  return { removed, bytes, keptBytes };
}

// --------------------------------------------------------- artifact cache ---

interface Entry {
  result: CompileResult;
  bytes: number;
  usedAt: number;
}

const artifacts = new Map<string, Entry>();
let artifactBytes = 0;
let hits = 0;
let misses = 0;

/** Rough weight of a result, dominated by the firmware payload. */
function weigh(result: CompileResult): number {
  let n = result.stdout.length + result.stderr.length + 512;
  if (result.firmware) {
    n += result.firmware.data.length;
    for (const region of result.firmware.regions ?? []) n += region.data.length;
  }
  return n;
}

export function cachedResult(key: string): CompileResult | undefined {
  const entry = artifacts.get(key);
  if (!entry) {
    misses++;
    return undefined;
  }
  hits++;
  entry.usedAt = Date.now();
  // A fresh object each time: the caller owns its copy and may stamp `source`
  // and `durationMs` on it without editing what the next caller will get.
  return { ...entry.result, source: 'cached' };
}

/**
 * Remembers a finished build.
 *
 * Only successful full builds are worth keeping: a failure is cheap to
 * reproduce and its diagnostics are the product, so caching one risks handing
 * back a stale error after the toolchain has been fixed underneath it.
 */
export function rememberResult(key: string, result: CompileResult): void {
  if (!result.success || !result.firmware) return;
  const bytes = weigh(result);
  if (bytes > MAX_ARTIFACT_BYTES) return;
  const existing = artifacts.get(key);
  if (existing) artifactBytes -= existing.bytes;
  artifacts.set(key, { result: { ...result, source: undefined }, bytes, usedAt: Date.now() });
  artifactBytes += bytes;
  while (artifacts.size > MAX_ARTIFACTS || artifactBytes > MAX_ARTIFACT_BYTES) {
    let oldestKey: string | undefined;
    let oldest = Infinity;
    for (const [k, v] of artifacts) {
      if (v.usedAt < oldest) {
        oldest = v.usedAt;
        oldestKey = k;
      }
    }
    if (oldestKey === undefined) break;
    artifactBytes -= artifacts.get(oldestKey)!.bytes;
    artifacts.delete(oldestKey);
  }
}

// -------------------------------------------------- in-flight deduplication --

const inFlight = new Map<string, Promise<CompileResult>>();

/**
 * Runs a build, or joins the one already running for the same key.
 *
 * The case this exists for is ordinary: a project with three boards running the
 * same sketch used to compile it three times in a row behind the gate, so the
 * third board waited for two builds it could have had for nothing.
 */
export async function runDeduplicated(key: string, run: () => Promise<CompileResult>): Promise<CompileResult> {
  const existing = inFlight.get(key);
  if (existing) return { ...(await existing), source: 'joined' };
  const promise = run();
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

export function cacheStats() {
  return {
    entries: artifacts.size,
    bytes: artifactBytes,
    hits,
    misses,
    inFlight: inFlight.size,
    maxEntries: MAX_ARTIFACTS,
    maxBytes: MAX_ARTIFACT_BYTES,
    root: CACHE_ROOT,
    cliRoot: CLI_CACHE_ROOT,
    maxDirs: MAX_BUILD_DIRS,
    maxDirBytes: MAX_BUILD_BYTES,
  };
}

/** Test hook: forgets everything, so a benchmark can measure a cold service. */
export function resetCache(): void {
  artifacts.clear();
  artifactBytes = 0;
  hits = 0;
  misses = 0;
  lastEviction = 0;
}
