// The ESP32 bootloader, made once per target instead of once per build.
//
// Every ESP32 build used to run esptool to turn the core's prebuilt bootloader
// ELF into a flash image. That image depends on the target and the core and
// never on the sketch, so arduinoCli.ts now keeps the one esptool produced on a
// target's first build and hands it back through the core's own "bootloader.bin
// in the sketch folder" hook. This holds it to what it claims:
//
//   * the shipped artifacts are the same either way — bootloader and partition
//     table byte for byte, the application image the same size and different
//     only in its build stamp (the allowance tests/compiler.espArtifacts.mts
//     measures between two unmodified builds);
//   * the file it drops into the sketch folder is gone afterwards, so the
//     folder a later build hashes is the folder the user's sources made;
//   * it is faster, measured.
//
// Skips cleanly without the esp32 core.

import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cliCompile, detectArduinoCli, forgetStockBootloaders } from '../server/compiler/arduinoCli';
import { SUPPORTED_TARGETS } from '../server/compiler/types';

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
const espTargets = SUPPORTED_TARGETS.filter((t) => t.core === 'esp32:esp32' && cli.installedCores.includes(t.core));
if (!cli.available || espTargets.length === 0) {
  skip('the esp32 core is not installed here');
  section(`${failures} failing, ${skipped} skipped`);
  process.exit(0);
}

const SKETCH = (tag: string) =>
  [
    `// bootloader reuse ${tag}`,
    'void setup() { Serial.begin(115200); pinMode(2, OUTPUT); }',
    'void loop() { digitalWrite(2, HIGH); delay(150); digitalWrite(2, LOW); delay(150); }',
  ].join('\n');

const work = await mkdtemp(path.join(tmpdir(), 'cd-espboot-'));
try {
  for (const t of espTargets) {
    section(`${t.fqbn}`);
    const arch = t.fqbn.endsWith('esp32c6') ? 'esp32c6' : 'esp32c3';
    const sketchDir = path.join(work, arch, 'cdsketch');
    await mkdir(sketchDir, { recursive: true });
    const build = async (tag: string) => {
      await writeFile(path.join(sketchDir, 'cdsketch.ino'), SKETCH('same'), 'utf8');
      const out = path.join(work, `${arch}-${tag}`);
      await mkdir(out, { recursive: true });
      const started = Date.now();
      const result = await cliCompile(sketchDir, out, t.fqbn, false, arch);
      return { result, ms: Date.now() - started };
    };

    forgetStockBootloaders();
    const fresh = await build('esptool'); // runs esptool, and learns the image
    const reused = await build('reused'); // hands the learnt image back
    check(fresh.result.code === 0 && reused.result.code === 0, 'builds both ways');
    if (fresh.result.code !== 0 || reused.result.code !== 0) {
      console.log((reused.result.stderr || fresh.result.stderr).slice(0, 400));
      continue;
    }
    const regions = (r: typeof fresh.result) => r.binaryRegions ?? [];
    const boot = (r: typeof fresh.result) => regions(r).find((x) => x.offset === 0)?.data;
    const parts = (r: typeof fresh.result) => regions(r).find((x) => x.offset === 0x8000)?.data;
    check(boot(fresh.result) !== undefined && boot(fresh.result) === boot(reused.result), 'the bootloader at 0x0 is byte-identical');
    check(parts(fresh.result) !== undefined && parts(fresh.result) === parts(reused.result), 'and so is the partition table at 0x8000');
    const x = Buffer.from(fresh.result.binaryBase64 ?? '', 'base64');
    const y = Buffer.from(reused.result.binaryBase64 ?? '', 'base64');
    let differing = 0;
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) differing++;
    check(x.length > 0 && x.length === y.length, `the application image is the same size (${x.length})`);
    check(differing <= 96, `and differs only in its build stamp (${differing} bytes)`);
    check(!(await readdir(sketchDir)).includes('bootloader.bin'), 'and nothing is left behind in the sketch folder');

    // Timing, alternating so the page cache favours neither.
    const withEsptool: number[] = [];
    const withReuse: number[] = [];
    for (let i = 0; i < 3; i++) {
      forgetStockBootloaders();
      withEsptool.push((await build(`e${i}`)).ms); // learns again
      withReuse.push((await build(`r${i}`)).ms);
    }
    const median = (xs: number[]) => [...xs].sort((p, q) => p - q)[1];
    console.log(`   esptool each build ${median(withEsptool)} ms, reused ${median(withReuse)} ms`);
    check(median(withReuse) <= median(withEsptool) + 50, 'and reusing it is not slower');
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

section(`${failures} failing, ${skipped} skipped`);
process.exit(failures > 0 ? 1 : 0);
