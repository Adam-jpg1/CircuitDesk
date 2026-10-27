// Installs the arduino-cli cores the compiler service promises, at the versions
// it is validated against.
//
// This exists because production could not compile for the ESP32-C6 and nobody
// noticed until the multi-target build report started naming targets one at a
// time. The image installed arduino:avr and rp2040:rp2040 and never installed
// esp32:esp32 at all — the core had only ever been put in a development
// container by hand, so a fresh deployment had never had it. An install that
// lives in someone's shell history is not a deployment.
//
// Run from the Dockerfile, before the application is built. Plain Node with no
// dependencies, because at that point in the image there is no node_modules.
//
//   node server/compiler/installCores.mjs            install everything pinned
//   node server/compiler/installCores.mjs --verify   check, install nothing
//
// Versions come from cores.json and are never guessed here. `--verify` is what
// the deployment smoke test uses, and it exits non-zero if a required core is
// missing or is not the pinned version, so a drifted image fails loudly instead
// of compiling firmware the emulator was never validated against.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'cores.json'), 'utf8'));
/** @type {{id:string,version:string,additionalUrl?:string,required?:boolean,keepChips?:string[],targets:string[]}[]} */
const CORES = manifest.cores;
/** @type {{version:string}|undefined} */
const CLI_PIN = manifest.arduinoCli;

const verifyOnly = process.argv.includes('--verify');

function cli(args, { allowFailure = false } = {}) {
  const run = spawnSync('arduino-cli', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.error) {
    if (allowFailure) return { code: 127, stdout: '', stderr: String(run.error.message) };
    console.error(`arduino-cli is not on PATH: ${run.error.message}`);
    process.exit(1);
  }
  return { code: run.status ?? 0, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

/** Installed cores as `id -> version`, from arduino-cli's own listing. */
function installedCores() {
  const { code, stdout } = cli(['core', 'list'], { allowFailure: true });
  const map = new Map();
  if (code !== 0) return map;
  for (const line of stdout.split('\n')) {
    const m = /^([a-z0-9_]+:[a-z0-9_]+)\s+(\S+)\s/i.exec(line.trim());
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

/** Where arduino-cli keeps packages, asked of the tool rather than assumed. */
function dataDir() {
  const { code, stdout } = cli(['config', 'dump', '--format', 'json'], { allowFailure: true });
  if (code === 0) {
    try {
      const cfg = JSON.parse(stdout);
      const dir = cfg?.directories?.data ?? cfg?.config?.directories?.data;
      if (dir) return dir;
    } catch {
      /* fall through to the environment */
    }
  }
  return process.env.ARDUINO_DIRECTORIES_DATA ?? join(process.env.HOME ?? '/root', '.arduino15');
}

/**
 * Drops the parts of the Arduino-ESP32 core CircuitDesk cannot compile for.
 *
 * The full core is 5.5 GB installed, and almost all of it is toolchains and
 * per-chip libraries for parts this service does not offer: the Xtensa
 * compiler, and the precompiled libraries for the ESP32, S2, S3, H2, C5, P4.
 * CircuitDesk's allowlist has exactly two ESP targets, both RISC-V, so the rest
 * is weight a deployment carries and never uses.
 *
 * Deliberately conservative: it removes whole per-chip library bundles and the
 * debuggers, and never reaches inside a toolchain to guess which multilib
 * variants matter. Anything it cannot identify confidently is left alone.
 */
function pruneEspToolchains(keepChips) {
  const data = dataDir();
  const tools = join(data, 'packages', 'esp32', 'tools');
  if (!existsSync(tools)) return { removed: [], freedNote: 'esp32 tools directory not present' };

  const keep = new Set(keepChips);
  const removed = [];
  for (const entry of readdirSync(tools)) {
    // Per-chip precompiled libraries: "esp32c6-libs", "esp32s3-libs", ...
    const libs = /^(esp32[a-z0-9_]*)-libs$/.exec(entry);
    if (libs) {
      if (!keep.has(libs[1])) {
        rmSync(join(tools, entry), { recursive: true, force: true });
        removed.push(entry);
      }
      continue;
    }
    // The Xtensa toolchain, when only RISC-V parts are kept. Both ESP targets
    // CircuitDesk supports are RISC-V; if that ever changes, keepChips changes
    // with it and this stops matching.
    const allRiscv = [...keep].every((c) => /^esp32(c|h|p)\d/.test(c));
    if (entry === 'esp-x32' && allRiscv) {
      rmSync(join(tools, entry), { recursive: true, force: true });
      removed.push(entry);
      continue;
    }
    // Debuggers. A build server compiles; it does not attach to a target.
    if (entry === 'xtensa-esp-elf-gdb' || entry === 'riscv32-esp-elf-gdb' || entry === 'openocd-esp32') {
      rmSync(join(tools, entry), { recursive: true, force: true });
      removed.push(entry);
    }
  }
  return { removed };
}

function install(core) {
  const args = ['core', 'install', `${core.id}@${core.version}`];
  if (core.additionalUrl) args.push('--additional-urls', core.additionalUrl);
  // Third-party board indexes are not always reachable on the first try, so a
  // failure is retried after re-fetching that core's own index.
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[cores] installing ${core.id}@${core.version}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
    const { code, stderr } = cli(args, { allowFailure: true });
    if (code === 0) return true;
    console.error(`[cores] FAILED ${core.id}@${core.version}: ${stderr.trim().split('\n').slice(-3).join(' ')}`);
    if (core.additionalUrl) cli(['core', 'update-index', '--additional-urls', core.additionalUrl], { allowFailure: true });
  }
  return false;
}

// ------------------------------------------------------------------- verify

if (verifyOnly) {
  const have = installedCores();
  let bad = 0;
  if (CLI_PIN) {
    // The build driver is pinned too. It used to come from install.sh on
    // master, which is how the deployed service ran a different arduino-cli
    // from the container the tests were written in.
    const { stdout } = cli(['version'], { allowFailure: true });
    const found = /Version:\s*(\S+)/.exec(stdout)?.[1] ?? 'unknown';
    if (found === CLI_PIN.version) console.log(`ok       arduino-cli ${found}`);
    else {
      console.error(`DRIFTED  arduino-cli is ${found}, pinned at ${CLI_PIN.version}`);
      bad++;
    }
  }
  const absent = new Set();
  for (const core of CORES) {
    const version = have.get(core.id);
    if (!version && !core.required) {
      // An optional core that could not be installed: its boards say so when
      // asked to compile, and the rest of the service is unaffected.
      console.warn(`OPTIONAL ${core.id} is not installed; its targets will report a missing core`);
      absent.add(core.id);
    } else if (!version) {
      console.error(`MISSING  ${core.id} (want ${core.version})`);
      bad++;
    } else if (version !== core.version) {
      console.error(`DRIFTED  ${core.id} is ${version}, pinned at ${core.version}`);
      bad++;
    } else {
      console.log(`ok       ${core.id}@${version}`);
    }
  }
  // Cores are not enough on their own: a target has to actually resolve, which
  // is what proves the toolchain for that chip survived any pruning.
  for (const core of CORES) {
    if (absent.has(core.id)) continue;
    for (const fqbn of core.targets) {
      const { code } = cli(['board', 'details', '-b', fqbn], { allowFailure: true });
      if (code === 0) console.log(`ok       ${fqbn}`);
      else {
        console.error(`UNRESOLVED ${fqbn}`);
        bad++;
      }
    }
  }
  process.exit(bad === 0 ? 0 : 1);
}

// ------------------------------------------------------------------ install

const urls = CORES.map((c) => c.additionalUrl).filter(Boolean);
const updateArgs = ['core', 'update-index'];
if (urls.length > 0) updateArgs.push('--additional-urls', urls.join(','));
cli(updateArgs, { allowFailure: true });

let failed = 0;
for (const core of CORES) {
  if (!install(core) && core.required) failed++;
}

for (const core of CORES) {
  if (core.id === 'esp32:esp32' && core.keepChips) {
    const { removed } = pruneEspToolchains(core.keepChips);
    console.log(`[cores] pruned ${removed.length} unused ESP32 tool bundle(s): ${removed.join(', ') || 'none'}`);
  }
}

if (failed > 0) {
  console.error(`[cores] ${failed} required core(s) failed to install.`);
  process.exit(1);
}
console.log('[cores] all pinned cores installed.');
