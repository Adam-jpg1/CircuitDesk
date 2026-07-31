// Backend compiler suite: proves every supported target still builds, that the
// RP2040 target returns a genuine UF2 (not Intel HEX), and that firmware
// carries the identity of the board it was built for.
//
// Runs the compiler service in-process, so it needs arduino-cli on PATH with
// the relevant cores installed. Targets whose core is missing are reported as
// SKIP rather than failing, so an AVR-only environment stays green.

import { compileProject, getCompilerHealth } from '../server/compiler/compilerService';
import { SUPPORTED_TARGETS, findTarget } from '../server/compiler/types';

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

const BLINK = `void setup(){ pinMode(LED_BUILTIN, OUTPUT); }
void loop(){ digitalWrite(LED_BUILTIN, HIGH); delay(100); digitalWrite(LED_BUILTIN, LOW); delay(100); }`;

const health = await getCompilerHealth();
console.log(`toolchain: ${health.toolchain} ${health.version.split('\n')[0]}`);

async function build(boardId: string) {
  const target = findTarget('', boardId)!;
  return {
    target,
    result: await compileProject(
      { boardId, fqbn: target.fqbn, files: [{ name: 'sketch.ino', content: BLINK }] },
      false,
    ),
  };
}

// ---------- 1. Every AVR target still compiles and is stamped ----------
for (const boardId of ['board.arduino-uno', 'board.arduino-nano', 'board.arduino-mega2560', 'board.arduino-leonardo']) {
  const { target, result } = await build(boardId);
  if (!result.success && result.errorCode === 'CORE_MISSING') {
    skip(`${target.name}: core ${target.core} not installed here`);
    continue;
  }
  check(result.success, `${target.name} compiles (${target.fqbn}) via ${result.toolchain}`);
  check(result.firmware?.format === 'intel-hex', `${target.name} returns Intel HEX (got ${result.firmware?.format})`);
  check(result.boardId === boardId && result.fqbn === target.fqbn, `${target.name} firmware is stamped with its board id and FQBN`);
  check(
    (result.memory?.flashMaxBytes ?? 0) === target.flashMaxBytes,
    `${target.name} reports its own flash budget (${result.memory?.flashMaxBytes})`,
  );
}

// ---------- 2. UF2 structure ----------
const UF2_MAGIC0 = 0x0a324655;
const UF2_MAGIC1 = 0x9e5d5157;
const UF2_MAGIC_END = 0x0ab16f30;
const RP2040_FAMILY_ID = 0xe48bff56;
const FLASH_BASE = 0x10000000;
const FLASH_SIZE = 2 * 1024 * 1024;

function parseUf2(buf: Buffer) {
  const problems: string[] = [];
  const addresses: number[] = [];
  const families = new Set<number>();
  const seen = new Set<number>();
  let bytes = 0;
  if (buf.length % 512 !== 0) problems.push(`image length ${buf.length} is not a multiple of 512`);
  const blocks = Math.floor(buf.length / 512);
  for (let i = 0; i < blocks; i++) {
    const o = i * 512;
    const magic0 = buf.readUInt32LE(o);
    const magic1 = buf.readUInt32LE(o + 4);
    const flags = buf.readUInt32LE(o + 8);
    const addr = buf.readUInt32LE(o + 12);
    const payload = buf.readUInt32LE(o + 16);
    const blockNo = buf.readUInt32LE(o + 20);
    const numBlocks = buf.readUInt32LE(o + 24);
    const familyId = buf.readUInt32LE(o + 28);
    const magicEnd = buf.readUInt32LE(o + 508);
    if (magic0 !== UF2_MAGIC0) problems.push(`block ${i}: bad magic0 0x${magic0.toString(16)}`);
    if (magic1 !== UF2_MAGIC1) problems.push(`block ${i}: bad magic1 0x${magic1.toString(16)}`);
    if (magicEnd !== UF2_MAGIC_END) problems.push(`block ${i}: bad final magic 0x${magicEnd.toString(16)}`);
    if (payload > 476) problems.push(`block ${i}: payload ${payload} exceeds 476`);
    if (blockNo !== i) problems.push(`block ${i}: blockNo says ${blockNo}`);
    if (numBlocks !== blocks) problems.push(`block ${i}: numBlocks ${numBlocks} != ${blocks}`);
    if (addr < FLASH_BASE || addr + payload > FLASH_BASE + FLASH_SIZE) {
      problems.push(`block ${i}: address 0x${addr.toString(16)} outside flash`);
    }
    if (seen.has(addr)) problems.push(`block ${i}: duplicate target address 0x${addr.toString(16)}`);
    seen.add(addr);
    if (flags & 0x2000) families.add(familyId);
    addresses.push(addr);
    bytes += payload;
  }
  return { blocks, bytes, families, addresses, problems };
}

// ---------- 3. RP2040 target ----------
{
  const { target, result } = await build('board.raspberry-pi-pico');
  if (!result.success && result.errorCode === 'CORE_MISSING') {
    skip(`${target.name}: core ${target.core} not installed here`);
  } else {
    check(result.success, `${target.name} compiles (${target.fqbn}) — error: ${result.error ?? 'none'}`);
    check(target.fqbn === 'rp2040:rp2040:rpipico', `Pico uses the Arduino-Pico FQBN (${target.fqbn})`);
    check(result.firmware?.format === 'uf2', `Pico returns a UF2 artifact (got ${result.firmware?.format})`);
    check(
      result.boardId === 'board.raspberry-pi-pico' && result.fqbn === target.fqbn,
      'Pico firmware is stamped with its board id and FQBN',
    );

    if (result.firmware?.format === 'uf2') {
      const buf = Buffer.from(result.firmware.data, 'base64');
      const report = parseUf2(buf);
      check(report.problems.length === 0, `UF2 structure valid (${report.problems.slice(0, 3).join('; ') || 'no problems'})`);
      check(report.blocks > 0, `UF2 has ${report.blocks} blocks carrying ${report.bytes} bytes of firmware`);
      check(
        report.families.size === 1 && report.families.has(RP2040_FAMILY_ID),
        `every block declares the RP2040 family id 0xE48BFF56 (${[...report.families].map((f) => '0x' + f.toString(16)).join(',')})`,
      );
      check(report.addresses[0] === FLASH_BASE, `first block targets the XIP flash base 0x${report.addresses[0]?.toString(16)}`);
      const asText = buf.toString('utf8', 0, 64);
      check(!asText.trimStart().startsWith(':'), 'UF2 is not Intel HEX text and cannot be parsed as AVR firmware');
      check(result.firmware.format !== 'intel-hex', 'Pico firmware is never labelled intel-hex');
    }
  }
}

// ---------- 4. Target table integrity ----------
{
  const pico = findTarget('', 'board.raspberry-pi-pico')!;
  const picow = findTarget('', 'board.raspberry-pi-pico-w')!;
  check(pico.fqbn !== picow.fqbn, `Pico and Pico W have distinct FQBNs (${pico.fqbn} vs ${picow.fqbn})`);
  check(
    SUPPORTED_TARGETS.filter((t) => t.arch === 'avr').every((t) => t.core === 'arduino:avr'),
    'every AVR target still resolves to the arduino:avr core',
  );
  check(findTarget('', 'board.esp32-devkit') === undefined, 'unsupported boards are still refused, not defaulted');
}

console.log(
  failures === 0
    ? `\nBackend compiler checks passed${skipped ? ` (${skipped} skipped)` : ''}.`
    : `\n${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
