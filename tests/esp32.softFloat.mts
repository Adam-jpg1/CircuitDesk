// Floating point on the ESP32-C3 and ESP32-C6.
//
// Neither chip has an FPU: GCC turns every float and double operation into a
// call to a libgcc routine, and both chips' linker scripts send those calls to
// the mask ROM. Until those routines were provided, the first floating-point
// operation in any sketch — map(), a sensor formula, a servo library — stopped
// it with an unimplemented-ROM-call error.
//
// This runs real compiled firmware that does each kind of operation on values
// chosen to exercise rounding, and prints the result's bit pattern. The test
// computes what IEEE-754 says each result must be and requires the same bits:
// not close, identical. Values come over Serial so the compiler cannot fold
// the arithmetic away at build time.

import { compileProject } from '../server/compiler/compilerService';
import { detectArduinoCli } from '../server/compiler/arduinoCli';
import { getSimulatorAdapter } from '../src/simulation/adapters';
import { getBoardDefinition } from '../src/boards/definitions';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const cli = await detectArduinoCli();
if (!cli.available) {
  console.log('SKIP: arduino-cli is not available here');
  process.exit(0);
}

// Each line of input is "a b n": two doubles and an integer.
const SKETCH = `#include <string.h>
static void hd(const char *k, double v) { uint64_t b; memcpy(&b, &v, 8); Serial.printf("%s %08lx%08lx\\n", k, (unsigned long)(b >> 32), (unsigned long)b); }
static void hf(const char *k, float v) { uint32_t b; memcpy(&b, &v, 4); Serial.printf("%s %08lx\\n", k, (unsigned long)b); }
void setup() { Serial.begin(115200); }
void loop() {
  if (!Serial.available()) return;
  String line = Serial.readStringUntil('\\n');
  double a = strtod(line.c_str(), NULL);
  const char *rest = strchr(line.c_str(), ' ');
  double b = strtod(rest + 1, NULL);
  long n = atol(strchr(rest + 1, ' ') + 1);
  float fa = (float)a, fb = (float)b;
  hd("dadd", a + b); hd("dsub", a - b); hd("dmul", a * b); hd("ddiv", a / b);
  hf("fadd", fa + fb); hf("fsub", fa - fb); hf("fmul", fa * fb); hf("fdiv", fa / fb);
  hf("trunc", (float)a); hd("ext", (double)fa);
  Serial.printf("toi %ld\\n", (long)a); Serial.printf("ftoi %ld\\n", (long)fa);
  hd("fromi", (double)n); hf("ffromi", (float)n);
  long long big = (long long)n * 1000003LL * 1000003LL;
  hd("fromll", (double)big); hf("ffromll", (float)big);
  Serial.printf("cmp %d %d %d %d\\n", a < b, a <= b, a == b, a > b);
  Serial.printf("fcmp %d %d %d %d\\n", fa < fb, fa <= fb, fa == fb, fa > fb);
  Serial.printf("map %ld\\n", map(n, 0, 1023, 0, 255));
  Serial.println("end");
}`;

const view = new DataView(new ArrayBuffer(8));
const dbits = (v: number) => {
  view.setFloat64(0, v);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};
const fbits = (v: number) => {
  view.setFloat32(0, v);
  return view.getUint32(0).toString(16).padStart(8, '0');
};
const f = Math.fround;

/** binary32 of a 64-bit integer, rounded once (Number() then fround would round twice). */
function floatOfBig(v: bigint): number {
  const neg = v < 0n;
  let m = neg ? -v : v;
  const bits = m.toString(2).length;
  if (bits > 24) {
    const drop = BigInt(bits - 24);
    const rest = m & ((1n << drop) - 1n);
    const half = 1n << (drop - 1n);
    m >>= drop;
    if (rest > half || (rest === half && (m & 1n) === 1n)) m += 1n;
    m <<= drop;
  }
  return f(neg ? -Number(m) : Number(m));
}

function expected(a: number, b: number, n: number): Record<string, string> {
  const fa = f(a);
  const fb = f(b);
  // C wraps both products: long is 32 bits and long long 64.
  const big = BigInt.asIntN(64, BigInt(n) * 1000003n * 1000003n);
  const cmp = (x: number, y: number) => `${+(x < y)} ${+(x <= y)} ${+(x === y)} ${+(x > y)}`;
  return {
    dadd: dbits(a + b), dsub: dbits(a - b), dmul: dbits(a * b), ddiv: dbits(a / b),
    fadd: fbits(f(fa + fb)), fsub: fbits(f(fa - fb)), fmul: fbits(f(fa * fb)), fdiv: fbits(f(fa / fb)),
    trunc: fbits(f(a)), ext: dbits(fa),
    toi: String(Math.trunc(a)), ftoi: String(Math.trunc(fa)),
    fromi: dbits(n), ffromi: fbits(f(n)),
    fromll: dbits(Number(big)), ffromll: fbits(floatOfBig(big)),
    cmp: cmp(a, b), fcmp: cmp(fa, fb),
    // Arduino's map() is 32-bit long arithmetic: (x - in_min) * (out_max - out_min) / (in_max - in_min) + out_min,
    // the product wrapping as it does on the chip.
    map: String(Math.trunc(Math.imul(n, 255) / 1023)),
  };
}

// Rounding cases: ties, values that are not representable, tiny and huge
// magnitudes, a negative divisor and equal operands.
const CASES: [string, number, number, number][] = [
  ['0.1 0.2 512', 0.1, 0.2, 512],
  ['3.14159265358979 -2.71828182845905 1023', 3.14159265358979, -2.71828182845905, 1023],
  ['1e-30 3e+29 7', 1e-30, 3e29, 7],
  ['16777217 1 -9876543', 16777217, 1, -9876543],
  ['-1234.5678 -1234.5678 300', -1234.5678, -1234.5678, 300],
  ['1 3 2147483', 1, 3, 2147483],
];

const BOARDS = [
  ['board.esp32-c3', 'esp32:esp32:esp32c3'],
  ['board.esp32-c6-devkitc-1', 'esp32:esp32:esp32c6'],
] as const;

for (const [boardId, fqbn] of BOARDS) {
  console.log(`\n=== ${boardId}`);
  const built = await compileProject({ fqbn, boardId, files: [{ name: 'sketch.ino', content: SKETCH }] }, false);
  if (!built.firmware) {
    console.log(`SKIP: ${boardId} did not build here`);
    skipped++;
    continue;
  }
  const def = getBoardDefinition(boardId)!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r: any = await getSimulatorAdapter(def)!.createRunner(built.firmware, def);
  let text = '';
  r.onSerialByte = (b: number) => (text += String.fromCharCode(b));
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += 10) r.runFor(10);
  };
  run(400);
  for (const [line, a, b, n] of CASES) {
    text = '';
    r.queueSerialInput(`${line}\n`);
    for (let t = 0; t < 2000 && !text.includes('end'); t += 50) run(50);
    const got = Object.fromEntries(
      text.split(/\r?\n/).filter((l) => l.includes(' ')).map((l) => [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1).trim()]),
    );
    const want = expected(a, b, n);
    const wrong = Object.keys(want).filter((k) => got[k] !== want[k]);
    check(
      wrong.length === 0,
      `${line}: ${Object.keys(want).length} results bit-identical to IEEE-754${wrong.length ? ` — wrong: ${wrong.map((k) => `${k} got ${got[k]} want ${want[k]}`).join('; ')}` : ''}`,
    );
  }
  r.dispose?.();
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
