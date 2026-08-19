// The ESP32 build step this service skips, and the proof that skipping it is free.
//
// An ESP32 build runs esptool three times. Two of them produce artifacts this
// service ships — the bootloader image and the application image — and the
// third writes a padded 4 MB `.merged.bin`, the whole flash laid out for
// programming a physical chip over a serial port. Nothing here programs
// anything: the artifacts that leave the service are picked by name and
// `.merged.bin` is explicitly excluded from that choice. Producing it cost
// about 300 ms and 4 MB of disk on every ESP32 build.
//
// It is skipped by overriding a NUMBERED hook in the core's platform.txt, which
// is version-specific by nature: if a future esp32 core renumbers its hooks, the
// same override would silence a different step and something that matters would
// vanish quietly. So this builds the sketch three times from one path and
// compares — which turns out to need care, because an ESP32 application image
// is not byte-reproducible: it carries a build timestamp at 0xc6e and two
// hashes computed over it, so two builds of unchanged source already differ in
// about 66 bytes. Two of the three builds are therefore unmodified, to measure
// that variation, and the assertion is that skipping the hook changes nothing
// outside it. The bootloader and partition table have no stamp and are compared
// byte for byte.

import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

/** The exact override the compiler service applies. Kept in step by assertion. */
const SKIP_ARG = 'recipe.hooks.objcopy.postobjcopy.3.pattern=/usr/bin/env true';

const SKETCH = [
  '// esp artifact equivalence check',
  'void setup() { Serial.begin(115200); pinMode(2, OUTPUT); }',
  'void loop() { digitalWrite(2, HIGH); delay(120); digitalWrite(2, LOW); delay(120); }',
].join('\n');

async function buildInto(dir: string, fqbn: string, skipMerged: boolean, tag: string): Promise<Map<string, Buffer>> {
  const sketchDir = path.join(dir, 'espart');
  await mkdir(sketchDir, { recursive: true });
  await writeFile(path.join(sketchDir, 'espart.ino'), SKETCH, 'utf8');
  const outDir = path.join(dir, `out-${tag}`);
  // --clean so each of these is a real full build from the same path: the build
  // path is baked into the ELF, so comparing builds from different paths would
  // measure the path rather than the change under test.
  const args = [
    'compile',
    '--jobs', '1',
    '--clean',
    ...(skipMerged ? ['--build-property', SKIP_ARG] : []),
    '--fqbn', fqbn,
    '--warnings', 'default',
    '--output-dir', outDir,
    sketchDir,
  ];
  await execFileAsync('arduino-cli', args, { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  const files = new Map<string, Buffer>();
  for (const name of await readdir(outDir)) {
    files.set(name.replace(/^espart\.ino/, 'sketch'), await readFile(path.join(outDir, name)));
  }
  return files;
}

// The source is asserted against, so the two cannot drift apart silently.
section('1. the override the service applies is the one tested here');
{
  const source = await readFile('server/compiler/arduinoCli.ts', 'utf8');
  check(source.includes(SKIP_ARG), `the service skips exactly this hook (${SKIP_ARG})`);
  check(
    /arch === 'esp32c3' \|\| arch === 'esp32c6'/.test(source),
    'and only on the ESP32 targets, which are the only ones with a merged image',
  );
  check(
    /!f\.endsWith\('\.merged\.bin'\)/.test(source),
    'and the artifact picker never wanted the merged image in the first place',
  );
}

section('2. the artifacts are the same with the step and without it');
{
  let available = false;
  try {
    const { stdout } = await execFileAsync('arduino-cli', ['core', 'list'], { timeout: 30_000 });
    available = /esp32:esp32/.test(stdout);
  } catch {
    available = false;
  }

  if (!available) {
    skip('the esp32 core is not installed — the artifact equivalence check cannot run');
  } else {
    const dir = await mkdtemp(path.join(tmpdir(), 'cd-esp-eq-'));
    try {
      // Four builds of one sketch from one path, all forced clean: three with
      // the core's own recipe, one with the hook skipped. The unmodified ones
      // are needed because an ESP32 build is NOT byte-reproducible — the image
      // carries a build timestamp and two hashes computed over it — so "did
      // skipping the hook change the firmware" can only be answered against how
      // much an unchanged build varies from itself.
      //
      // THREE unmodified builds rather than two, because one pair understates
      // the varying fields: two timestamps a second apart share most of their
      // digits, and a hash byte can coincide by chance, so a single pair's
      // differing bytes are a lower bound on the field. Taking the union over
      // independent pairs converges on the real extent — which is exactly the
      // flake this suite produced when a byte two positions inside the
      // timestamp happened to match in the pair that defined the region.
      const first = await buildInto(dir, 'esp32:esp32:esp32c6', false, 'one');
      const second = await buildInto(dir, 'esp32:esp32:esp32c6', false, 'two');
      const third = await buildInto(dir, 'esp32:esp32:esp32c6', false, 'three');
      const skippedBuild = await buildInto(dir, 'esp32:esp32:esp32c6', true, 'skip');

      check(first.has('sketch.merged.bin'), 'the unmodified build writes the merged flash image');
      check(!skippedBuild.has('sketch.merged.bin'), "and the service's build does not");
      const savedBytes = first.get('sketch.merged.bin')?.length ?? 0;
      console.log(`   skipping it saves ${(savedBytes / 1024 / 1024).toFixed(1)} MB of disk per build`);

      // The parts that are deterministic must be exactly equal.
      for (const name of ['sketch.bootloader.bin', 'sketch.partitions.bin']) {
        const a = first.get(name);
        const b = skippedBuild.get(name);
        check(a !== undefined && b !== undefined, `${name} is produced either way`);
        if (a && b) check(a.equals(b), `and ${name} is byte-identical (${a.length} bytes)`);
      }

      // The application image is the one that carries the stamp.
      const a = first.get('sketch.bin');
      const b = second.get('sketch.bin');
      const c = skippedBuild.get('sketch.bin');
      check(a !== undefined && b !== undefined && c !== undefined, 'the application image is produced either way');
      if (a && b && c) {
        check(a.length === c.length, `and is the same size (${a.length} bytes)`);

        const differing = (x: Buffer, y: Buffer) => {
          const out = new Set<number>();
          for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) out.add(i);
          return out;
        };
        // How much an ESP32 build varies from itself, with nothing changed —
        // over every unmodified pair, not one of them.
        const d = third.get('sketch.bin');
        const stamp = new Set<number>([
          ...differing(a, b),
          ...(d ? differing(a, d) : []),
          ...(d && b ? differing(b, d) : []),
        ]);
        const withSkip = differing(a, c);
        console.log(
          `   identical ESP32 builds already differ in ${stamp.size} bytes ` +
          `(build stamp and the hashes over it); skipping the hook differs in ${withSkip.size}`,
        );
        check(stamp.size > 0, 'an ESP32 image is not byte-reproducible even with nothing changed');

        // Compared as REGIONS rather than as exact offsets: the stamp is a
        // timestamp and two hashes over it, so which individual bytes inside
        // those fields happen to differ varies from pair to pair — a hash byte
        // can coincide by chance. What must hold is that every byte the hook
        // skip changes lies inside a field that already varies on its own.
        const regions: [number, number][] = [];
        for (const i of [...stamp].sort((x, y) => x - y)) {
          const last = regions[regions.length - 1];
          if (last && i - last[1] <= 16) last[1] = i;
          else regions.push([i, i]);
        }
        const inside = (i: number) => regions.some(([lo, hi]) => i >= lo && i <= hi);
        console.log(
          `   the varying fields are ${regions.map(([lo, hi]) => `0x${lo.toString(16)}-0x${hi.toString(16)}`).join(', ')}`,
        );
        const outside = [...withSkip].filter((i) => !inside(i));
        check(
          outside.length === 0,
          `every byte the skip changes is inside a field that varies anyway` +
          `${outside.length ? ` (${outside.length} outside: ${outside.slice(0, 4).map((i) => `0x${i.toString(16)}`).join(', ')})` : ''}`,
        );

        // And the same, stated the other way round: outside those fields, the
        // firmware that gets executed is byte-identical.
        let same = true;
        for (let i = 0; i < a.length; i++) if (!inside(i) && a[i] !== c[i]) same = false;
        check(same, 'so outside the stamp, the executed firmware is byte-identical');
      }

      const shipped = [...skippedBuild.keys()].filter((n) => n.endsWith('.bin')).sort();
      console.log(`   artifacts produced: ${shipped.join(', ')}`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

console.log(
  failures === 0
    ? `\nESP32 artifact checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
