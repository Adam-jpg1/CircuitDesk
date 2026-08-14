// Does this compiler deployment actually deliver what it promises?
//
// Written because production could not build for the ESP32-C6 and nothing said
// so until the multi-target build report started naming targets one at a time.
// The image installed arduino:avr and rp2040:rp2040 and never installed
// esp32:esp32; the core had only ever been put into a development container by
// hand. Everything looked healthy, because "the service is up" and "the service
// can build for your board" were the same question.
//
// So this asks the second question, and asks it the way CircuitDesk does: over
// HTTP, against the same endpoints the app calls. A local `arduino-cli compile`
// proves a toolchain exists on a machine; it does not prove the deployment can
// serve a build.
//
//   CIRCUITDESK_URL=https://compiler.example  npx tsx tests/compiler.deployment.mts
//
// Rate limiting is respected rather than worked around: the service allows 60
// builds per five minutes and this makes four, spaced. A test that needed the
// limiter relaxed would be testing a service nobody runs.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const BASE = process.env.CIRCUITDESK_URL ?? 'http://localhost:3411';
const manifest = JSON.parse(readFileSync(new URL('../server/compiler/cores.json', import.meta.url), 'utf8')) as {
  cores: { id: string; version: string; targets: string[]; required?: boolean }[];
};
const libManifest = JSON.parse(
  readFileSync(new URL('../server/compiler/libraries.json', import.meta.url), 'utf8'),
) as {
  libraries: { id: string; version: string; provides: string[]; required?: boolean }[];
  headers: { header: string; via: { source: string; targets: string[]; effect?: string }[] }[];
};

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function skip(msg: string) {
  console.log('SKIP:', msg);
  skipped++;
}

// ============================ 1. the environment, before any HTTP is involved
//
// `--verify` is the same check the image runs at build time. Running it here
// proves a clean environment came up with the pinned cores rather than being
// patched by hand afterwards — which is exactly what went wrong.
//
// Only meaningful when the service under test is the one on this machine.
// Pointed at a deployed service, this would check the wrong computer: the
// deployment's own environment is what /api/compiler/capabilities reports, and
// that is verified below.
const LOCAL_TARGET = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE);
if (!LOCAL_TARGET) {
  skip(`${BASE} is a remote deployment — its environment is checked through /api/compiler/capabilities, not this machine's arduino-cli`);
} else {
  const verify = spawnSync('node', ['server/compiler/installCores.mjs', '--verify'], {
    encoding: 'utf8',
    cwd: new URL('..', import.meta.url).pathname,
  });
  const output = `${verify.stdout ?? ''}${verify.stderr ?? ''}`;
  if (verify.error) {
    skip(`the core verifier could not run: ${verify.error.message}`);
  } else {
    console.log(output.trim().split('\n').map((l) => `   ${l}`).join('\n'));
    check(verify.status === 0, `every pinned core is installed at its pinned version (exit ${verify.status})`);
    for (const core of manifest.cores) {
      check(output.includes(`ok       ${core.id}@${core.version}`), `${core.id} is ${core.version}, the version this service is validated against`);
      for (const fqbn of core.targets) {
        check(output.includes(`ok       ${fqbn}`), `${fqbn} resolves through arduino-cli board details`);
      }
    }
    check(output.includes('esp32:esp32@'), 'the ESP32 core is part of the environment at all, which is the regression this covers');
  }

  // Libraries are the same class of promise as cores. A deployment without the
  // Servo library cannot build the sketch every servo tutorial in the world is
  // written as, and would report itself perfectly healthy while doing it.
  const libVerify = spawnSync('node', ['server/compiler/installLibraries.mjs', '--verify'], {
    encoding: 'utf8',
    cwd: new URL('..', import.meta.url).pathname,
  });
  const libOutput = `${libVerify.stdout ?? ''}${libVerify.stderr ?? ''}`;
  if (libVerify.error) {
    skip(`the library verifier could not run: ${libVerify.error.message}`);
  } else {
    console.log(libOutput.trim().split('\n').map((l) => `   ${l}`).join('\n'));
    check(libVerify.status === 0, `every pinned library is installed at its pinned version (exit ${libVerify.status})`);
    for (const lib of libManifest.libraries) {
      check(libOutput.includes(`ok       ${lib.id}@${lib.version}`), `${lib.id} is ${lib.version}, the version this service is validated against`);
    }
  }
}

// ================================= 2. what the service says it can build ====
interface Capabilities {
  status?: string;
  arduinoCli?: { available: boolean; version: string };
  missingRequiredCores?: string[];
  driftedCores?: string[];
  missingRequiredLibraries?: string[];
  driftedLibraries?: string[];
  libraries?: {
    id: string;
    expectedVersion: string;
    installedVersion: string | null;
    installed: boolean;
    matchesPin: boolean;
    required: boolean;
    provides: string[];
    reason?: string;
  }[];
  cores?: {
    id: string;
    expectedVersion: string;
    installedVersion: string | null;
    installed: boolean;
    matchesPin: boolean;
    required: boolean;
    fqbnFamilies: string[];
    reason?: string;
  }[];
  targets?: {
    id: string;
    fqbn: string;
    core: string;
    installed: boolean;
    coreVersion: string | null;
    headers?: { header: string; source: string; effect: string }[];
  }[];
}

let capabilities: Capabilities | null = null;
try {
  const res = await fetch(`${BASE}/api/compiler/capabilities`);
  capabilities = (await res.json()) as Capabilities;
} catch (e) {
  console.log(`   (capabilities request failed: ${(e as Error).message})`);
}

if (!capabilities) {
  skip(`the compiler service at ${BASE} is unreachable — nothing below can run`);
  console.log(failures === 0 ? `\nDeployment checks passed (${skipped} skipped).` : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

{
  check(capabilities.status === 'healthy', `the service reports itself healthy (${capabilities.status})`);
  check(
    (capabilities.missingRequiredCores ?? []).length === 0,
    `no required core is missing (${(capabilities.missingRequiredCores ?? []).join(', ') || 'none'})`,
  );
  check(
    (capabilities.driftedCores ?? []).length === 0,
    `no core has drifted from its pin (${(capabilities.driftedCores ?? []).join(', ') || 'none'})`,
  );
  // The report has to be machine-readable, not a sentence to parse.
  for (const core of manifest.cores) {
    const reported = capabilities.cores?.find((c) => c.id === core.id);
    check(reported !== undefined, `${core.id} appears in the capability report`);
    check(reported?.installed === true, `${core.id} is reported installed`);
    check(
      reported?.installedVersion === core.version,
      `${core.id} reports version ${core.version} (${reported?.installedVersion})`,
    );
    check(reported?.matchesPin === true, `${core.id} matches the pin this service was built against`);
    check(
      (reported?.fqbnFamilies ?? []).length > 0,
      `${core.id} lists the FQBN families it provides (${(reported?.fqbnFamilies ?? []).join(', ')})`,
    );
  }
  for (const fqbn of ['esp32:esp32:esp32c3', 'esp32:esp32:esp32c6', 'rp2040:rp2040:rpipico', 'arduino:avr:uno']) {
    const target = capabilities.targets?.find((t) => t.fqbn === fqbn);
    check(target?.installed === true, `${fqbn} is reported as buildable`);
  }

  check(
    (capabilities.missingRequiredLibraries ?? []).length === 0,
    `no required library is missing (${(capabilities.missingRequiredLibraries ?? []).join(', ') || 'none'})`,
  );
  check(
    (capabilities.driftedLibraries ?? []).length === 0,
    `no library has drifted from its pin (${(capabilities.driftedLibraries ?? []).join(', ') || 'none'})`,
  );
  for (const lib of libManifest.libraries) {
    const reported = capabilities.libraries?.find((l) => l.id === lib.id);
    check(reported !== undefined, `${lib.id} appears in the capability report`);
    check(reported?.installed === true, `${lib.id} is reported installed`);
    check(reported?.matchesPin === true, `${lib.id} matches the pin this service was built against`);
  }

  // The report has to say what a board can build, not only which core it uses.
  // Servo.h on an Uno is the case a user hits first.
  const uno = capabilities.targets?.find((t) => t.fqbn === 'arduino:avr:uno');
  const unoServo = uno?.headers?.find((h) => h.header === 'Servo.h');
  check(unoServo !== undefined, 'the Uno target reports that it can build Servo.h');
  check(unoServo?.effect === 'works', 'and that the library actually drives a pin there, not merely compiles');

  // And it has to be honest where it cannot. A Pico compiles Servo.h and moves
  // nothing; a capability report that hid that would be the same bug this file
  // was written for, one layer up.
  const pico = capabilities.targets?.find((t) => t.fqbn === 'rp2040:rp2040:rpipico');
  const picoServo = pico?.headers?.find((h) => h.header === 'Servo.h');
  check(picoServo?.effect === 'compiles-only', 'the Pico target reports Servo.h as compiling without effect');
}

// ================================ 3. real builds through the real endpoint ==
//
// Discovery is not a build. `board details` resolving proves the core is
// present; it does not prove the toolchain for that chip survived pruning, that
// python3 is there for the build recipe, or that the service can serve the
// artifact. Only compiling proves that.

interface CompileResponse {
  success: boolean;
  firmware?: { format: string; data: string; regions?: { offset: number; data: string }[] };
  error?: string;
  errorCode?: string;
  toolchain?: string;
  fqbn?: string;
  memory?: { flashBytes: number };
}

const SKETCH = [
  'void setup() { pinMode(LED_BUILTIN, OUTPUT); }',
  'void loop() { digitalWrite(LED_BUILTIN, HIGH); delay(200); digitalWrite(LED_BUILTIN, LOW); delay(200); }',
].join('\n');

async function build(boardId: string, fqbn: string): Promise<CompileResponse | null> {
  try {
    const res = await fetch(`${BASE}/api/compiler/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boardId, fqbn, files: [{ name: 'sketch.ino', content: SKETCH }] }),
    });
    if (res.status === 429) {
      console.log('   (rate limited — pausing rather than asking for the limiter to be relaxed)');
      await new Promise((r) => setTimeout(r, 65_000));
      return build(boardId, fqbn);
    }
    return (await res.json()) as CompileResponse;
  } catch (e) {
    console.log(`   (compile request for ${fqbn} failed: ${(e as Error).message})`);
    return null;
  }
}

const EXPECTED: { boardId: string; fqbn: string; label: string; format: string }[] = [
  { boardId: 'board.arduino-uno', fqbn: 'arduino:avr:uno', label: 'Arduino Uno', format: 'intel-hex' },
  { boardId: 'board.raspberry-pi-pico', fqbn: 'rp2040:rp2040:rpipico', label: 'Raspberry Pi Pico', format: 'uf2' },
  { boardId: 'board.esp32-c3', fqbn: 'esp32:esp32:esp32c3', label: 'ESP32-C3', format: 'esp-image' },
  { boardId: 'board.esp32-c6-devkitc-1', fqbn: 'esp32:esp32:esp32c6', label: 'ESP32-C6', format: 'esp-image' },
];

for (const target of EXPECTED) {
  const result = await build(target.boardId, target.fqbn);
  if (!result) {
    check(false, `${target.label}: the compile request reached the service`);
    continue;
  }
  check(result.success === true, `${target.label} builds over HTTP (${result.error ? result.error.split('\n')[0] : 'ok'})`);
  if (!result.success) continue;
  check(result.firmware !== undefined, `${target.label} returns an artifact`);
  check(
    result.firmware?.format === target.format,
    `${target.label} returns ${target.format}, its own artifact format (${result.firmware?.format})`,
  );
  check((result.firmware?.data.length ?? 0) > 1000, `${target.label}'s artifact has real content (${result.firmware?.data.length} chars)`);
  check(result.fqbn === target.fqbn, `${target.label}'s artifact is stamped with the target it was built for (${result.fqbn})`);
  check(result.toolchain === 'arduino-cli', `${target.label} was built by arduino-cli (${result.toolchain})`);
  if (target.format === 'esp-image') {
    // An ESP application image alone will not boot: the chip reads its
    // partition table out of flash first. A build that dropped the extra
    // regions would look successful and produce a board that does nothing.
    const regions = result.firmware?.regions ?? [];
    check(regions.length >= 2, `${target.label} carries its bootloader and partition table (${regions.length} extra regions)`);
    check(regions.every((r) => r.data.length > 0), `${target.label}'s extra regions are not empty`);
  }
  // Spacing: four builds inside the 60-per-5-minutes window is comfortable,
  // but back-to-back heavy builds on one instance are not.
  await new Promise((r) => setTimeout(r, 1500));
}

// ============ 4. an unsupported target is refused, not compiled as something =
{
  const res = await fetch(`${BASE}/api/compiler/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ boardId: 'board.made-up', fqbn: 'nonsense:chip:board', files: [{ name: 'sketch.ino', content: SKETCH }] }),
  });
  const json = (await res.json()) as CompileResponse;
  check(json.success === false, 'an unknown target is refused');
  check(json.errorCode === 'UNSUPPORTED_BOARD', `and says why (${json.errorCode})`);
  check(json.firmware === undefined, 'with no artifact — never another board\'s firmware');
}

console.log(
  failures === 0
    ? `\nCompiler deployment checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
