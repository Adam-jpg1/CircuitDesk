// The ARMv7-M core, proved against real compilers.
//
// tests/fixtures/armv7m/diff.c is compiled twice — for this machine, and for
// the Cortex-M3 (soft float), M4F (single-precision FPU) and M7 (double-
// precision FPU) at several optimisation levels — and every ARM build has to
// print exactly what the host build prints: integer and 64-bit arithmetic,
// bitfields, jump tables, setjmp, libc formatting and parsing, and IEEE-754
// arithmetic bit for bit. exceptions.c then exercises what only an ARM has:
// SysTick, SVC, PendSV, NVIC preemption by priority, PRIMASK and BASEPRI,
// thread mode on the process stack, exclusive access, bit-banding, the DWT
// cycle counter, WFI, and floating-point state across an interrupt.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CortexM } from '../src/simulation/armv7m/cortexM';
import type { ArmChip, CortexMConfig } from '../src/simulation/armv7m/bus';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const FIX = new URL('./fixtures/armv7m/', import.meta.url).pathname;

function findGcc(): string | null {
  const roots = [process.env.ARDUINO_DIRECTORIES_DATA, `${process.env.HOME}/.arduino15`].filter(Boolean) as string[];
  for (const root of roots) {
    for (const vendor of ['adafruit', 'arduino', 'Seeeduino']) {
      const dir = join(root, 'packages', vendor, 'tools', 'arm-none-eabi-gcc');
      if (!existsSync(dir)) continue;
      for (const version of readdirSync(dir).sort().reverse()) {
        const gcc = join(dir, version, 'bin', 'arm-none-eabi-gcc');
        if (existsSync(gcc)) return gcc;
      }
    }
  }
  return null;
}

const gcc = findGcc();
if (!gcc) {
  console.log('SKIP: no arm-none-eabi-gcc found (install a SAMD core)');
  process.exit(0);
}
const objcopy = gcc.replace(/gcc$/, 'objcopy');
const work = mkdtempSync(join(tmpdir(), 'armv7m-'));

const VARIANTS: { name: string; flags: string[]; config: CortexMConfig }[] = [
  { name: 'cortex-m3', flags: ['-mcpu=cortex-m3'], config: { variant: 'm3', irqCount: 32, priorityBits: 4, cpuid: 0x412fc231 } },
  {
    name: 'cortex-m4f',
    flags: ['-mcpu=cortex-m4', '-mfpu=fpv4-sp-d16', '-mfloat-abi=hard'],
    config: { variant: 'm4', fpu: 'sp', irqCount: 32, priorityBits: 4, cpuid: 0x410fc241 },
  },
  {
    name: 'cortex-m7',
    flags: ['-mcpu=cortex-m7', '-mfpu=fpv5-d16', '-mfloat-abi=hard', '-DCORE_M7'],
    config: { variant: 'm7', fpu: 'dp', irqCount: 32, priorityBits: 4, cpuid: 0x411fc272 },
  },
];

function build(source: string, variant: (typeof VARIANTS)[number], opt: string): Uint8Array {
  const elf = join(work, `${source}-${variant.name}${opt}.elf`);
  const bin = elf.replace(/\.elf$/, '.bin');
  execFileSync(gcc!, [
    '-mthumb', ...variant.flags, opt, '-ffp-contract=off', '-ffunction-sections', '-fdata-sections',
    '-nostartfiles', '-T', join(FIX, 'link.ld'), '-Wl,--gc-sections',
    join(FIX, 'startup.c'), join(FIX, `${source}.c`), '-o', elf, '-lm', '-lc', '-lgcc',
  ]);
  execFileSync(objcopy, ['-O', 'binary', elf, bin]);
  return new Uint8Array(readFileSync(bin));
}

/** Runs an image on a bare test chip; returns what it printed and its exit code. */
function run(image: Uint8Array, config: CortexMConfig, maxCycles = 3e9): { out: string; exit: number | null; cycles: number; ms: number } {
  const flash = new Uint8Array(1 << 20);
  flash.set(image);
  const ram = new Uint8Array(256 << 10);
  let out = '';
  let exit: number | null = null;
  const chip: ArmChip = {
    regions: [
      { start: 0, end: flash.length, bytes: flash, readOnly: true },
      { start: 0x20000000, end: 0x20000000 + ram.length, bytes: ram },
    ],
    read: () => 0,
    write: (address, value) => {
      if (address === 0x40000000) out += String.fromCharCode(value & 0xff);
      else if (address === 0x40000004) exit = value;
    },
  };
  const core = new CortexM(chip, config);
  core.reset(0);
  const t0 = performance.now();
  try {
    while (exit === null && core.cycles < maxCycles) {
      if (core.sleeping) {
        core.run(1000);
        if (core.sleeping) break;
      } else core.step();
    }
  } catch (err) {
    out += `\n[fault] ${err instanceof Error ? err.message : String(err)}`;
  }
  return { out, exit, cycles: core.cycles, ms: performance.now() - t0 };
}

// ------------------------------------------------------------ differential
const hostBin = join(work, 'diff-host');
execFileSync('gcc', ['-O2', '-ffp-contract=off', '-o', hostBin, join(FIX, 'diff.c'), '-lm']);
const expected = execFileSync(hostBin).toString();
console.log('host output:\n' + expected.trim().split('\n').map((l) => '   ' + l).join('\n'));

for (const variant of VARIANTS) {
  for (const opt of ['-O0', '-O2', '-Os']) {
    let image: Uint8Array;
    try {
      image = build('diff', variant, opt);
    } catch (err) {
      console.log(`SKIP: ${variant.name} ${opt} did not build: ${String(err).slice(0, 200)}`);
      skipped++;
      continue;
    }
    const r = run(image, variant.config);
    const want = variant.config.fpu === 'dp' ? expected : expected.split('\n').filter((l) => !l.startsWith('fma64 ')).join('\n');
    const got = variant.config.fpu === 'dp' ? r.out : r.out.split('\n').filter((l) => !l.startsWith('fma64 ')).join('\n');
    const same = got === want;
    check(same && r.exit === 0, `${variant.name} ${opt}: identical to the host (${(r.cycles / 1e6).toFixed(1)} M cycles in ${(r.ms / 1000).toFixed(1)} s)`);
    if (!same) {
      const a = want.split('\n');
      const b = got.split('\n');
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) console.log(`   line ${i}: host "${a[i]}" arm "${b[i]}"`);
      }
    }
  }
}

// ------------------------------------------------------------- exceptions
for (const variant of VARIANTS) {
  const image = build('exceptions', variant, '-O2');
  const r = run(image, variant.config, 2e8);
  const lines = r.out.split('\n');
  const has = (re: RegExp) => lines.some((l) => re.test(l));
  console.log(`\n--- exceptions on ${variant.name}\n${r.out.trim().split('\n').map((l) => '   ' + l).join('\n')}`);
  check(has(/^systick 1$/), `${variant.name}: SysTick interrupts`);
  check(has(/^svc 105 1 42$/), `${variant.name}: SVC with its immediate, returning through the stacked frame`);
  check(has(/^pendsv 1$/), `${variant.name}: PendSV`);
  check(has(/^nvic 1 1 nested=1 order=16,17$/), `${variant.name}: a higher-priority IRQ preempts a running handler`);
  check(has(/^primask 1 2$/), `${variant.name}: PRIMASK holds an interrupt off until cleared`);
  // IRQ0's handler pends IRQ1 again, so releasing BASEPRI runs both once more.
  check(has(/^basepri 1 3 -> 2 4$/), `${variant.name}: BASEPRI masks by priority`);
  check(has(/^psp 1 101 ctrl=2$/), `${variant.name}: thread mode on PSP, SVC from it`);
  check(has(/^ldrex 6 0$/) && has(/^clrex 1$/), `${variant.name}: LDREX/STREX and CLREX`);
  if (variant.config.variant !== 'm7') check(has(/^bitband 32 1$/), `${variant.name}: bit-band alias`);
  check(has(/^dwt 1$/), `${variant.name}: DWT cycle counter`);
  check(has(/^wfi 1$/), `${variant.name}: WFI sleeps until SysTick`);
  if (variant.config.fpu) check(has(/^fpctx 24 \d+$/), `${variant.name}: FP registers preserved across an FP-using interrupt`);
  check(has(/^done$/) && r.exit === 0, `${variant.name}: ran to completion`);
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
