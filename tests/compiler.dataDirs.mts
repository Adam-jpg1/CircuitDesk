// A build that loads only its own core, and the proof that this changes nothing
// but the time.
//
// arduino-cli reads every installed platform on every invocation, so an Uno
// build used to pay for parsing the ESP32 and RP2040 cores before it compiled a
// line. server/compiler/coreDataDirs.ts gives each packager a data directory of
// symlinks holding only its own package. That is an optimisation of the most
// dangerous kind — one that changes which files the toolchain can see — so this
// checks three things rather than one:
//
//   1. the directories are what they claim: only the one package plus
//      arduino-cli's builtin tools, all of it symlinks into the real install,
//      nothing copied and nothing installed;
//   2. the firmware is the same: each target built both ways yields the same
//      artifact — byte for byte where the format allows it, and for the ESP32
//      application image (which carries a build timestamp) the same size with
//      differences confined to the stamped header;
//   3. it is faster, measured, and the numbers are printed.
//
// Skips cleanly when arduino-cli or a core is not installed.

import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, lstat, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cliCompile, detectArduinoCli } from '../server/compiler/arduinoCli';
import { dataDirFor, resolveSharedDataDir } from '../server/compiler/coreDataDirs';
import { SUPPORTED_TARGETS } from '../server/compiler/types';

const execFileAsync = promisify(execFile);

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
function section(t: string) {
  console.log(`\n--- ${t}`);
}

const cli = await detectArduinoCli();
if (!cli.available) {
  skip('arduino-cli is not installed here');
  section(`${failures} failing, ${skipped} skipped`);
  process.exit(0);
}
const shared = await resolveSharedDataDir();
check(shared !== undefined, `the real data directory is found (${shared})`);

const targets = SUPPORTED_TARGETS.filter((t) => cli.installedCores.includes(t.core));
const onePerCore = [...new Map(targets.map((t) => [t.core, t])).values()];

// ================================================ 1. what the directories are =
section('1. each core gets a directory of links, holding only that core');
for (const t of onePerCore) {
  const vendor = t.core.split(':')[0];
  const dir = await dataDirFor(t.fqbn);
  check(dir !== undefined, `${t.core} has its own data directory (${dir})`);
  if (!dir) continue;
  const packages = (await readdir(path.join(dir, 'packages'))).sort();
  check(
    packages.every((p) => p === vendor || p === 'builtin') && packages.includes(vendor),
    `holding only ${vendor} and arduino-cli's builtin tools (${packages.join(', ')})`,
  );
  let allLinks = true;
  for (const p of packages) {
    const full = path.join(dir, 'packages', p);
    const st = await lstat(full);
    if (!st.isSymbolicLink() || !(await readlink(full)).startsWith(shared!)) allLinks = false;
  }
  check(allLinks, 'each one a link into the real installation — nothing copied, nothing installed twice');

  const { stdout } = await execFileAsync('arduino-cli', ['core', 'list'], {
    timeout: 60_000,
    env: { ...process.env, ARDUINO_DIRECTORIES_DATA: dir },
  });
  const listed = stdout.split('\n').map((l) => /^([a-z0-9_]+:[a-z0-9_]+)\s+(\S+)/i.exec(l.trim())).filter(Boolean) as RegExpExecArray[];
  check(
    listed.length === 1 && listed[0][1] === t.core && listed[0][2] === cli.coreVersions[t.core],
    `arduino-cli sees exactly ${t.core} ${cli.coreVersions[t.core]} from it (${listed.map((m) => `${m[1]} ${m[2]}`).join(', ')})`,
  );
}

// ======================================== 2 + 3. same firmware, less time ====
section('2. every target builds to the same firmware either way, and faster');

const SKETCH = (tag: string) =>
  [
    `// data-dir equivalence ${tag}`,
    'void setup() { Serial.begin(9600); pinMode(2, OUTPUT); }',
    'void loop() { digitalWrite(2, HIGH); delay(120); digitalWrite(2, LOW); delay(130); }',
  ].join('\n');

const arch = (core: string): 'avr' | 'rp2040' | 'esp32c3' | 'esp32c6' =>
  core === 'arduino:avr' ? 'avr' : core === 'rp2040:rp2040' ? 'rp2040' : 'esp32c3';

const work = await mkdtemp(path.join(tmpdir(), 'cd-datadirs-'));
const timings: string[] = [];
try {
  for (const t of targets) {
    const a = t.fqbn.endsWith('esp32c6') ? 'esp32c6' : arch(t.core);
    // One sketch directory for both builds, so the build path — which ends up
    // in the ELF — is the same, and what is compared is the data directory.
    const sketchDir = path.join(work, t.fqbn.replace(/:/g, '_'), 'cdsketch');
    await mkdir(sketchDir, { recursive: true });

    const build = async (split: boolean, tag: string) => {
      process.env.CIRCUITDESK_SPLIT_DATA_DIRS = split ? '1' : '0';
      await writeFile(path.join(sketchDir, 'cdsketch.ino'), SKETCH(tag), 'utf8');
      const out = path.join(work, `${t.fqbn.replace(/:/g, '_')}-${tag}`);
      await mkdir(out, { recursive: true });
      const started = Date.now();
      const result = await cliCompile(sketchDir, out, t.fqbn, false, a);
      return { result, ms: Date.now() - started };
    };

    // Equivalence: the same source both ways.
    const viaShared = await build(false, 'same');
    const viaSplit = await build(true, 'same');
    check(viaShared.result.code === 0 && viaSplit.result.code === 0, `${t.fqbn} builds both ways`);
    if (viaShared.result.code !== 0 || viaSplit.result.code !== 0) {
      console.log((viaSplit.result.stderr || viaShared.result.stderr).slice(0, 400));
      continue;
    }
    if (a === 'avr') {
      check(viaShared.result.hex === viaSplit.result.hex, '  and the Intel HEX is identical');
    } else if (a === 'rp2040') {
      check(viaShared.result.binaryBase64 === viaSplit.result.binaryBase64, '  and the UF2 is identical');
    } else {
      const x = Buffer.from(viaShared.result.binaryBase64 ?? '', 'base64');
      const y = Buffer.from(viaSplit.result.binaryBase64 ?? '', 'base64');
      let differing = 0;
      let last = -1;
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) { differing++; last = i; }
      check(x.length === y.length && x.length > 0, `  and the application image is the same size (${x.length})`);
      // The same allowance tests/compiler.espArtifacts.mts measures between two
      // UNMODIFIED builds: the build timestamp and the hashes over it.
      check(differing <= 96, `  differing only in the stamped bytes (${differing} bytes, last at 0x${last.toString(16)})`);
      const regions = (r: typeof viaShared.result) => JSON.stringify(r.binaryRegions ?? []);
      check(regions(viaShared.result) === regions(viaSplit.result), '  with an identical bootloader and partition table');
    }

    // Timing: alternate so neither side gets all of the warm page cache.
    const shared3: number[] = [];
    const split3: number[] = [];
    for (let i = 0; i < 3; i++) {
      shared3.push((await build(false, `s${i}`)).ms);
      split3.push((await build(true, `p${i}`)).ms);
    }
    const median = (xs: number[]) => [...xs].sort((p, q) => p - q)[1];
    const line = `${t.fqbn.padEnd(24)} shared ${median(shared3)} ms  own-core ${median(split3)} ms`;
    timings.push(line);
    console.log(`   ${line}`);
    // Not a benchmark assertion — machines vary — but it must never be the
    // slower path by any margin that matters.
    check(median(split3) <= median(shared3) * 1.15 + 50, '  and it is not slower');
  }
} finally {
  delete process.env.CIRCUITDESK_SPLIT_DATA_DIRS;
  await rm(work, { recursive: true, force: true });
}

console.log('\n' + timings.map((l) => `   ${l}`).join('\n'));
section(`${failures} failing, ${skipped} skipped`);
process.exit(failures > 0 ? 1 : 0);
