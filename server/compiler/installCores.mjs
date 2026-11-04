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
/** @type {{id:string,version:string,additionalUrl?:string,required?:boolean,keepChips?:string[],keepCmsisLibs?:string[],keepStm32Series?:string[],keepMultilibs?:string[],teensyKeepMultilibs?:string[],removeTools?:string[],targets:string[]}[]} */
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
    // The Xtensa toolchain, when only RISC-V parts are kept.
    const allRiscv = [...keep].every((c) => /^esp32(c|h|p)\d/.test(c));
    if (entry === 'esp-x32' && allRiscv) {
      rmSync(join(tools, entry), { recursive: true, force: true });
      removed.push(entry);
      continue;
    }
    // When it is kept, only the kept Xtensa chips' multilibs are: the
    // toolchain carries esp32, esp32s2 and esp32s3 builds of libc, libstdc++
    // and libgcc side by side. picolibc goes too unless a kept chip's libraries
    // were configured for it — Arduino-ESP32's are built with newlib
    // (CONFIG_LIBC_NEWLIB in each esp*-libs/sdkconfig). A build with these
    // removed was checked to produce a byte-identical image.
    if (entry === 'esp-x32') {
      for (const version of readdirSync(join(tools, entry))) {
        const root = join(tools, entry, version);
        const multilibDirs = [join(root, 'xtensa-esp-elf', 'lib')];
        const gccLib = join(root, 'lib', 'gcc', 'xtensa-esp-elf');
        if (existsSync(gccLib)) for (const v of readdirSync(gccLib)) multilibDirs.push(join(gccLib, v));
        for (const dir of multilibDirs) {
          for (const chip of ['esp32', 'esp32s2', 'esp32s3']) {
            if (keep.has(chip) || !existsSync(join(dir, chip))) continue;
            rmSync(join(dir, chip), { recursive: true, force: true });
            removed.push(`${entry}/${version}: ${chip} multilib`);
          }
        }
        const picolibcWanted = [...keep].some((chip) => {
          const config = join(tools, `${chip}-libs`);
          if (!existsSync(config)) return false;
          return readdirSync(config).some((v) => {
            const sdk = join(config, v, 'sdkconfig');
            return existsSync(sdk) && /^CONFIG_LIBC_PICOLIBC=y$/m.test(readFileSync(sdk, 'utf8'));
          });
        });
        if (!picolibcWanted && existsSync(join(root, 'picolibc'))) {
          rmSync(join(root, 'picolibc'), { recursive: true, force: true });
          removed.push(`${entry}/${version}: picolibc`);
        }
      }
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

/**
 * Drops what an M0 build never reads from an ARM core's tools: CMSIS's
 * prebuilt DSP libraries for every other Cortex core, its documentation and
 * packs, and the compiler's HTML manuals. Each SAMD core carries its own
 * copy of CMSIS (448 MB for Adafruit's, 345 MB for Seeed's), and a SAMD21
 * build uses three things from it: Core/Include, DSP/Include and
 * libarm_cortexM0l_math.a, which `keepLibs` names.
 *
 * Like the ESP pruning, it never reaches inside the compiler itself.
 */
function pruneArmTools(vendor, keepLibs) {
  const tools = join(dataDir(), 'packages', vendor, 'tools');
  const removed = [];
  const rm = (path) => {
    rmSync(path, { recursive: true, force: true });
    removed.push(path.slice(tools.length + 1));
  };
  // Only the GCC build of the libraries named, wherever a CMSIS keeps them.
  const pruneLib = (lib) => {
    if (!existsSync(lib)) return;
    for (const entry of readdirSync(lib)) {
      if (entry !== 'GCC') {
        rm(join(lib, entry));
        continue;
      }
      for (const file of readdirSync(join(lib, 'GCC'))) {
        if (!keepLibs.includes(file)) rm(join(lib, 'GCC', file));
      }
    }
  };
  const cmsis = join(tools, 'CMSIS');
  for (const version of existsSync(cmsis) ? readdirSync(cmsis) : []) {
    const root = join(cmsis, version);
    for (const entry of readdirSync(root)) {
      if (!['CMSIS', 'Device', 'LICENSE.txt', 'ARM.CMSIS.pdsc'].includes(entry)) rm(join(root, entry));
    }
    const inner = join(root, 'CMSIS');
    if (!existsSync(inner)) continue;
    for (const entry of readdirSync(inner)) {
      if (entry === 'Core' || entry === 'Include') continue;
      if (entry === 'Lib') {
        pruneLib(join(inner, 'Lib'));
      } else if (entry === 'DSP') {
        for (const sub of readdirSync(join(inner, 'DSP'))) {
          if (sub === 'Lib') pruneLib(join(inner, 'DSP', 'Lib'));
          else if (sub !== 'Include') rm(join(inner, 'DSP', sub));
        }
      } else {
        rm(join(inner, entry));
      }
    }
  }
  const gcc = join(tools, 'arm-none-eabi-gcc');
  for (const version of existsSync(gcc) ? readdirSync(gcc) : []) {
    const doc = join(gcc, version, 'share', 'doc');
    if (existsSync(doc)) rm(doc);
  }
  return { removed };
}

/**
 * Narrows the STM32duino core to the series CircuitDesk builds for. The core
 * ships the HAL, CMSIS device headers and variants of every STM32 family —
 * 2.5 GB installed — plus an 800 MB SVD database used only by debuggers, and a
 * compiler with libraries for every ARM profile. An F401 build reads its own
 * series' HAL, CMSIS headers and variants, and the compiler's Cortex-M4F
 * (v7e-m+fp) multilib; the rest is removed. `keepSeries` names directories as
 * the core spells them (STM32F4xx); `keepMultilibs` names them as the compiler
 * does (thumb/v7e-m+fp).
 */
function pruneStm32(keepSeries, keepMultilibs) {
  const pkg = join(dataDir(), 'packages', 'STMicroelectronics');
  const removed = [];
  const rm = (path) => {
    rmSync(path, { recursive: true, force: true });
    removed.push(path.slice(pkg.length + 1));
  };
  const keepDir = (name) => keepSeries.some((series) => name === series || name === `${series.replace(/xx$/, '')}xx_HAL_Driver`);
  const hardware = join(pkg, 'hardware', 'stm32');
  for (const version of existsSync(hardware) ? readdirSync(hardware) : []) {
    const root = join(hardware, version);
    const drivers = join(root, 'system', 'Drivers');
    for (const entry of existsSync(drivers) ? readdirSync(drivers) : []) {
      if (entry.endsWith('_HAL_Driver') && !keepDir(entry)) rm(join(drivers, entry));
    }
    const devices = join(drivers, 'CMSIS', 'Device', 'ST');
    for (const entry of existsSync(devices) ? readdirSync(devices) : []) {
      if (/^STM32\w+$/.test(entry) && !keepDir(entry)) rm(join(devices, entry));
    }
    const variants = join(root, 'variants');
    for (const entry of existsSync(variants) ? readdirSync(variants) : []) {
      if (!keepDir(entry)) rm(join(variants, entry));
    }
    for (const extra of ['CI', 'cmake']) if (existsSync(join(root, extra))) rm(join(root, extra));
  }
  const tools = join(pkg, 'tools');
  if (existsSync(join(tools, 'STM32_SVD'))) rm(join(tools, 'STM32_SVD'));
  const gcc = join(tools, 'xpack-arm-none-eabi-gcc');
  for (const version of existsSync(gcc) ? readdirSync(gcc) : []) {
    const base = join(gcc, version);
    const keep = new Set(keepMultilibs);
    // Multilib trees: the C libraries and libgcc, per architecture profile.
    const trees = [join(base, 'arm-none-eabi', 'lib')];
    const libgcc = join(base, 'lib', 'gcc', 'arm-none-eabi');
    for (const v of existsSync(libgcc) ? readdirSync(libgcc) : []) trees.push(join(libgcc, v));
    for (const tree of trees) {
      for (const mode of ['thumb', 'arm']) {
        const dir = join(tree, mode);
        for (const entry of existsSync(dir) ? readdirSync(dir) : []) {
          if (!keep.has(`${mode}/${entry}`)) rm(join(dir, entry));
        }
      }
    }
    const doc = join(base, 'share', 'doc');
    if (existsSync(doc)) rm(doc);
  }
  return { removed };
}

/**
 * Narrows the Teensy package to what a Teensy 4.1 build reads: its compiler
 * bundle carries an ARM toolchain with libraries for every ARM profile and an
 * AVR toolchain for the 8-bit Teensys. The AVR one goes, and of the ARM
 * multilibs only `keepMultilibs` (thumb/v7e-m+dp, the Cortex-M7's) stays.
 */
function pruneTeensy(keepMultilibs) {
  const compile = join(dataDir(), 'packages', 'teensy', 'tools', 'teensy-compile');
  const removed = [];
  const rm = (path) => {
    rmSync(path, { recursive: true, force: true });
    removed.push(path.slice(compile.length + 1));
  };
  const keep = new Set(keepMultilibs);
  for (const version of existsSync(compile) ? readdirSync(compile) : []) {
    const base = join(compile, version);
    if (existsSync(join(base, 'avr'))) rm(join(base, 'avr'));
    const arm = join(base, 'arm');
    const trees = [join(arm, 'arm-none-eabi', 'lib')];
    const libgcc = join(arm, 'lib', 'gcc', 'arm-none-eabi');
    for (const v of existsSync(libgcc) ? readdirSync(libgcc) : []) trees.push(join(libgcc, v));
    for (const tree of trees) {
      for (const mode of ['thumb', 'arm']) {
        const dir = join(tree, mode);
        for (const entry of existsSync(dir) ? readdirSync(dir) : []) {
          if (!keep.has(`${mode}/${entry}`)) rm(join(dir, entry));
        }
      }
    }
    for (const doc of [join(arm, 'share', 'doc'), join(arm, 'share', 'info'), join(arm, 'share', 'man')]) if (existsSync(doc)) rm(doc);
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
  if (core.removeTools) {
    const vendor = core.id.split(':')[0];
    for (const tool of core.removeTools) {
      const dir = join(dataDir(), 'packages', vendor, 'tools', tool);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        console.log(`[cores] removed ${vendor}'s ${tool}: it is replaced by another installed toolchain`);
      }
    }
  }
  if (core.keepStm32Series) {
    const { removed } = pruneStm32(core.keepStm32Series, core.keepMultilibs ?? []);
    console.log(`[cores] pruned ${removed.length} STM32 series, debugger and multilib entr(ies) not built for`);
  }
  if (core.teensyKeepMultilibs) {
    const { removed } = pruneTeensy(core.teensyKeepMultilibs);
    console.log(`[cores] pruned ${removed.length} Teensy compiler entr(ies) not built for`);
  }
  if (core.keepCmsisLibs) {
    const vendor = core.id.split(':')[0];
    const { removed } = pruneArmTools(vendor, core.keepCmsisLibs);
    console.log(`[cores] pruned ${removed.length} unused ${vendor} CMSIS and documentation entr(ies)`);
  }
}

if (failed > 0) {
  console.error(`[cores] ${failed} required core(s) failed to install.`);
  process.exit(1);
}
console.log('[cores] all pinned cores installed.');
