// Installs the Arduino libraries the compiler service promises, at the versions
// it is validated against.
//
// The sibling of installCores.mjs, and for the same reason: a library that is
// installed by hand in one container and not in the image is a service that
// compiles a Servo sketch in development and rejects it in production. Versions
// come from libraries.json and are never guessed here.
//
//   node server/compiler/installLibraries.mjs            install everything pinned
//   node server/compiler/installLibraries.mjs --verify   check versions, install nothing
//   node server/compiler/installLibraries.mjs --probe    compile every recorded claim
//
// --verify is what the image bootstrap and the deployment smoke test run: it is
// a version check and takes about a second.
//
// --probe is the one that keeps the manifest honest, and is deliberately not in
// the image build. It compiles the probe sketch for every (header, target) pair
// the manifest records as building, and every pair it records as NOT building,
// and fails if reality disagrees in either direction. A wrong "unavailable" is
// as much a bug as a wrong "available" — it would send a user to a workaround
// they do not need. It compiles for real, so it costs minutes, not seconds;
// it belongs in a test run, not in a layer.
//
//   node server/compiler/installLibraries.mjs --probe --target arduino:avr:uno
//
// narrows it to one FQBN.

import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'libraries.json'), 'utf8'));
/** @type {{id:string,version:string,provides:string[],required?:boolean,note?:string}[]} */
const LIBRARIES = manifest.libraries;
/** @type {{header:string,probe:string,via:{source:string,targets:string[]}[],unavailable?:{targets:string[],reason:string,alternative?:string}[]}[]} */
const HEADERS = manifest.headers;

const args = process.argv.slice(2);
const verifyOnly = args.includes('--verify');
const probeOnly = args.includes('--probe');
const targetFilter = (() => {
  const i = args.indexOf('--target');
  return i >= 0 ? args[i + 1] : undefined;
})();

function cli(argv, { allowFailure = false, timeout = 600_000 } = {}) {
  const run = spawnSync('arduino-cli', argv, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  });
  if (run.error) {
    if (allowFailure) return { code: 127, stdout: '', stderr: String(run.error.message) };
    console.error(`arduino-cli is not on PATH: ${run.error.message}`);
    process.exit(1);
  }
  return { code: run.status ?? 0, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

/** Installed libraries as `name -> version`, from arduino-cli's own listing. */
function installedLibraries() {
  const { code, stdout } = cli(['lib', 'list', '--format', 'json'], { allowFailure: true, timeout: 60_000 });
  const map = new Map();
  if (code !== 0) return map;
  try {
    const parsed = JSON.parse(stdout);
    // arduino-cli has moved this key between releases; accept either shape
    // rather than silently reporting every library as missing after an upgrade.
    const list = parsed?.installed_libraries ?? parsed?.installedLibraries ?? parsed ?? [];
    for (const entry of Array.isArray(list) ? list : []) {
      const lib = entry?.library ?? entry;
      if (lib?.name) map.set(lib.name, lib.version ?? 'unknown');
    }
  } catch {
    return map;
  }
  return map;
}

// -------------------------------------------------------------------- probe

/** Compiles `source` for `fqbn` in a throwaway sketch directory. */
function compileProbe(source, fqbn) {
  const root = mkdtempSync(join(tmpdir(), 'cd-libprobe-'));
  try {
    const name = 'probe';
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, `${name}.ino`), source);
    const { code, stdout, stderr } = cli(['compile', '--jobs', '1', '--fqbn', fqbn, dir], {
      allowFailure: true,
    });
    return { ok: code === 0, output: `${stdout}\n${stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function firstError(output) {
  const line = output.split('\n').find((l) => /error:/i.test(l));
  return (line ?? output.split('\n').filter(Boolean).slice(-1)[0] ?? '').trim().slice(0, 200);
}

if (probeOnly) {
  let bad = 0;
  let ran = 0;
  for (const claim of HEADERS) {
    for (const via of claim.via) {
      for (const fqbn of via.targets) {
        if (targetFilter && fqbn !== targetFilter) continue;
        ran++;
        const { ok, output } = compileProbe(claim.probe, fqbn);
        if (ok) console.log(`ok         ${claim.header} builds for ${fqbn} (${via.source})`);
        else {
          console.error(`BROKEN     ${claim.header} is recorded as building for ${fqbn} via ${via.source}, but does not: ${firstError(output)}`);
          bad++;
        }
      }
    }
    for (const gap of claim.unavailable ?? []) {
      for (const fqbn of gap.targets) {
        if (targetFilter && fqbn !== targetFilter) continue;
        ran++;
        const { ok } = compileProbe(claim.probe, fqbn);
        if (!ok) console.log(`ok         ${claim.header} does not build for ${fqbn}, as recorded`);
        else {
          // Good news that is still a manifest bug: a user is being told to use
          // a workaround for something that now works.
          console.error(`STALE      ${claim.header} is recorded as unavailable for ${fqbn}, but it compiles. Remove the entry.`);
          bad++;
        }
      }
    }
  }
  if (ran === 0) {
    console.error(targetFilter ? `No claims recorded for ${targetFilter}.` : 'No claims to probe.');
    process.exit(1);
  }
  console.log(bad === 0 ? `\nAll ${ran} recorded claim(s) match reality.` : `\n${bad} of ${ran} claim(s) are wrong.`);
  process.exit(bad === 0 ? 0 : 1);
}

// ------------------------------------------------------------------- verify

if (verifyOnly) {
  const have = installedLibraries();
  let bad = 0;
  for (const lib of LIBRARIES) {
    const version = have.get(lib.id);
    if (!version) {
      const level = lib.required === false ? 'absent  ' : 'MISSING ';
      console[lib.required === false ? 'log' : 'error'](`${level} ${lib.id} (want ${lib.version})`);
      if (lib.required !== false) bad++;
    } else if (version !== lib.version) {
      console.error(`DRIFTED  ${lib.id} is ${version}, pinned at ${lib.version}`);
      bad++;
    } else {
      console.log(`ok       ${lib.id}@${version}`);
    }
  }
  process.exit(bad === 0 ? 0 : 1);
}

// ------------------------------------------------------------------ install

cli(['lib', 'update-index'], { allowFailure: true, timeout: 300_000 });

let failed = 0;
for (const lib of LIBRARIES) {
  console.log(`[libs] installing ${lib.id}@${lib.version}`);
  const { code, stderr } = cli(['lib', 'install', `${lib.id}@${lib.version}`], {
    allowFailure: true,
    timeout: 300_000,
  });
  if (code !== 0) {
    console.error(`[libs] FAILED ${lib.id}@${lib.version}: ${stderr.trim().split('\n').slice(-3).join(' ')}`);
    if (lib.required !== false) failed++;
  }
}

if (failed > 0) {
  console.error(`[libs] ${failed} required librar(ies) failed to install.`);
  process.exit(1);
}
console.log(`[libs] all ${LIBRARIES.length} pinned librar(ies) installed.`);
