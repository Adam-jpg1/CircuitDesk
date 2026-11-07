// What makes two builds the same build, and the collision that used to be possible.
//
// The old key was the FQBN plus the source text. That was only INCIDENTALLY
// safe: it happened to be correct because no two compile profiles targeted the
// same FQBN while changing compilation semantics. The moment one did — the same
// core, the same target, different flags — two different firmwares would have
// shared a cache entry, and one of them would have run the other's bytes.
//
// So the key is now a fingerprint of the effective compile configuration, and
// this file holds it to both halves of the contract:
//
//   IN, because it changes the bytes: the profile and its revision, the
//   adapter, the processor, the target, the flags, the toolchain and core
//   versions, the libraries, and every source byte.
//
//   OUT, because it cannot: the board's name, artwork, colour, dimensions,
//   position, instance id and pin labels. A user renaming a board or dragging
//   it across the canvas must cost zero compiles, and the only way to be sure
//   is that none of it is reachable from the fingerprint.
//
// The runtime profile is deliberately absent, and section 5 says why.

import { compileFingerprint, fingerprintForBoard, checkArtifactRuntime, COMPILE_PROFILE_REVISION } from '../src/compiler/fingerprint';
import { compileProfile } from '../src/boards/pipelineProfiles';
import { resolveCustomBoard } from '../src/custom-boards/resolve';
import { getBoardDefinition } from '../src/boards/definitions';
import { CUSTOM_BOARD_SCHEMA_VERSION, type CustomBoardDefinition } from '../src/custom-boards/schema';
import type { BoardDefinition } from '../src/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

const FILES = [{ name: 'sketch.ino', content: 'void setup(){}\nvoid loop(){}' }];

const BASE = {
  compileProfileId: 'compile.rp2040-arduino',
  compileProfileRevision: COMPILE_PROFILE_REVISION,
  adapter: 'arduino-cli',
  processorProfileId: 'proc.rp2040',
  fqbn: 'rp2040:rp2040:rpipico',
  buildFlags: [] as string[],
  toolchainVersions: { 'rp2040:rp2040': '6.0.0' },
  libraries: ['Servo'],
  files: FILES,
};

// ==================================== 1. everything firmware-affecting is in =
section('1. anything that can change the bytes changes the fingerprint');
{
  const base = compileFingerprint(BASE);
  const variants: [string, Parameters<typeof compileFingerprint>[0]][] = [
    ['the compile profile', { ...BASE, compileProfileId: 'compile.avr-arduino' }],
    ['the profile revision', { ...BASE, compileProfileRevision: COMPILE_PROFILE_REVISION + 1 }],
    ['the compiler adapter', { ...BASE, adapter: 'other-adapter' }],
    ['the processor target', { ...BASE, processorProfileId: 'proc.atmega328p' }],
    ['the FQBN', { ...BASE, fqbn: 'rp2040:rp2040:rpipicow' }],
    ['a build flag', { ...BASE, buildFlags: ['-DDEBUG=1'] }],
    ['the core version', { ...BASE, toolchainVersions: { 'rp2040:rp2040': '6.0.1' } }],
    ['a library version', { ...BASE, libraries: ['Servo@1.3.0'] }],
    ['the sketch source', { ...BASE, files: [{ name: 'sketch.ino', content: 'void setup(){}\nvoid loop(){delay(1);}' }] }],
    ['an included .h', { ...BASE, files: [...FILES, { name: 'helper.h', content: '#pragma once' }] }],
    ['an included .cpp', { ...BASE, files: [...FILES, { name: 'helper.cpp', content: 'int x(){return 1;}' }] }],
  ];
  for (const [what, input] of variants) {
    check(compileFingerprint(input) !== base, `${what} produces a different build`);
  }

  // Two sources that could be run together into one string must not collide.
  const a = compileFingerprint({ ...BASE, files: [{ name: 'a.ino', content: 'xy' }, { name: 'b.h', content: 'z' }] });
  const b = compileFingerprint({ ...BASE, files: [{ name: 'a.ino', content: 'x' }, { name: 'b.h', content: 'yz' }] });
  check(a !== b, 'and file contents cannot be rearranged into a colliding key');

  // Reordering the tabs is the same build.
  const forward = compileFingerprint({ ...BASE, files: [{ name: 'a.ino', content: '1' }, { name: 'b.h', content: '2' }] });
  const backward = compileFingerprint({ ...BASE, files: [{ name: 'b.h', content: '2' }, { name: 'a.ino', content: '1' }] });
  check(forward === backward, 'while reordering the files is not');
}

// ============================ 2. the collision the old key allowed ==========
section('2. two profiles on one FQBN with different flags do not collide');
{
  // The exact case the old FQBN+source key could not tell apart: same core,
  // same target, same sketch, different compilation.
  const debug = compileFingerprint({ ...BASE, compileProfileId: 'compile.rp2040-debug', buildFlags: ['-DDEBUG=1', '-Og'] });
  const release = compileFingerprint({ ...BASE, compileProfileId: 'compile.rp2040-release', buildFlags: ['-DNDEBUG', '-O2'] });
  check(debug !== release, 'two pipelines on one FQBN with different flags are two builds');
  check(debug !== compileFingerprint(BASE), 'and neither is the unflagged build');

  // Flag ORDER is not meaningful, so it must not split the cache.
  const oneWay = compileFingerprint({ ...BASE, buildFlags: ['-DA', '-DB'] });
  const other = compileFingerprint({ ...BASE, buildFlags: ['-DB', '-DA'] });
  check(oneWay === other, 'but the order of the flags is not a difference');
}

// ================= 3. nothing about how a board LOOKS is in the key =========
section('3. nothing visible about a board can cost a compile');
{
  const board: CustomBoardDefinition = {
    schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
    id: 'custom.fingerprint-board',
    revision: 1,
    identity: { name: 'Board One', creator: 'Someone', description: 'first' },
    outline: { widthMm: 30, heightMm: 40, color: '#111111' },
    pins: [
      { id: 'LED', label: 'LED', pad: 'GP15', xMm: 2, yMm: 4, type: 'digital', capabilities: [] },
      { id: 'GND', label: 'GND', pad: null, xMm: 2, yMm: 10, type: 'ground', capabilities: [] },
    ],
    processorProfileId: 'proc.rp2040',
    compileProfileId: 'compile.rp2040-arduino',
    runtimeProfileId: 'runtime.rp2040js',
  };
  const original = fingerprintForBoard(resolveCustomBoard(board).board, FILES);

  const cosmetic: [string, CustomBoardDefinition][] = [
    ['renaming the board', { ...board, identity: { ...board.identity, name: 'Robot Controller Rev B' } }],
    ['changing the description', { ...board, identity: { ...board.identity, description: 'rewritten' } }],
    ['changing the creator', { ...board, identity: { ...board.identity, creator: 'Someone Else' } }],
    ['resizing the outline', { ...board, outline: { ...board.outline, widthMm: 90, heightMm: 120 } }],
    ['recolouring it', { ...board, outline: { ...board.outline, color: '#ff00ff' } }],
    ['adding artwork', { ...board, outline: { ...board.outline, artworkSvg: '<svg><rect width="10" height="10"/></svg>' } }],
    ['relabelling a pin', { ...board, pins: [{ ...board.pins[0], label: 'STATUS' }, board.pins[1]] }],
    ['moving a pin', { ...board, pins: [{ ...board.pins[0], xMm: 25, yMm: 33 }, board.pins[1]] }],
    ['bumping the revision', { ...board, revision: 7 }],
  ];
  for (const [what, next] of cosmetic) {
    check(
      fingerprintForBoard(resolveCustomBoard(next).board, FILES) === original,
      `${what} costs no compile`,
    );
  }

  // And the things that MUST rebuild, on the same board.
  const remapped: CustomBoardDefinition = {
    ...board,
    processorProfileId: 'proc.atmega328p',
    compileProfileId: 'compile.avr-arduino',
    runtimeProfileId: 'runtime.avr8js-328p',
    pins: [{ ...board.pins[0], pad: 'PB5' }, board.pins[1]],
  };
  check(
    fingerprintForBoard(resolveCustomBoard(remapped).board, FILES) !== original,
    'while changing the processor and pipeline does rebuild',
  );
}

// ============ 4. legitimate sharing between a custom board and a native one =
section('4. the same pipeline and the same source is one build');
{
  const pico = getBoardDefinition('board.raspberry-pi-pico')!;
  const custom = resolveCustomBoard({
    schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
    id: 'custom.twin',
    revision: 1,
    identity: { name: 'Not A Pico' },
    outline: { widthMm: 30, heightMm: 40 },
    pins: [{ id: 'LED', label: 'LED', pad: 'GP15', xMm: 2, yMm: 4, type: 'digital', capabilities: [] }],
    processorProfileId: 'proc.rp2040',
    compileProfileId: 'compile.rp2040-arduino',
    runtimeProfileId: 'runtime.rp2040js',
  }).board;

  check(
    fingerprintForBoard(pico, FILES) === fingerprintForBoard(custom, FILES),
    'a custom RP2040 board and a Pico on the same pipeline and source share one artifact',
  );
  check(pico.name !== custom.name, 'even though they are different boards');

  // The Pico W is a different FQBN, so it is a different build.
  const picoW = getBoardDefinition('board.raspberry-pi-pico-w')!;
  check(
    fingerprintForBoard(picoW, FILES) !== fingerprintForBoard(pico, FILES),
    'and the Pico W, on a different target, is not',
  );

  // The Nano pins its own FQBN inside the shared AVR profile.
  const uno = getBoardDefinition('board.arduino-uno')!;
  const nano = getBoardDefinition('board.arduino-nano')!;
  check(uno.compileProfileId === nano.compileProfileId, 'the Uno and the Nano share a compile profile');
  check(
    fingerprintForBoard(uno, FILES) !== fingerprintForBoard(nano, FILES),
    'but not a build, because they pin different targets inside it',
  );
}

// ================= 5. the runtime is checked, not folded into the key =======
section('5. compilation and execution are separate questions');
{
  const pico = getBoardDefinition('board.raspberry-pi-pico')!;
  // Two boards identical in every compile-relevant way, differing only in how
  // they would be executed, are the same build: the emulator does not change
  // what the compiler emits.
  const noRuntime: BoardDefinition = { ...pico, runtimeProfileId: 'runtime.none' };
  check(
    fingerprintForBoard(noRuntime, FILES) === fingerprintForBoard(pico, FILES),
    'changing only the runtime does not rebuild the firmware',
  );

  // Which makes a separate compatibility check necessary, and it names both.
  check(checkArtifactRuntime(pico, 'uf2') === null, 'a UF2 and the RP2040 runtime fit together');

  const wrongFormat = checkArtifactRuntime(pico, 'intel-hex');
  check(wrongFormat?.code === 'format-mismatch', 'a HEX artifact for the RP2040 runtime is refused');
  check(
    Boolean(wrongFormat && /uf2/i.test(wrongFormat.message) && /intel-hex/i.test(wrongFormat.message)),
    `and the message names both formats ("${wrongFormat?.message ?? ''}")`,
  );

  const none = checkArtifactRuntime(noRuntime, 'uf2');
  check(none?.code === 'no-runtime', 'a board with no runtime is refused execution');
  check(
    Boolean(none && /not executed/.test(none.message) && /another processor/.test(none.message)),
    'and told it is not being run as something else',
  );

  const wrongChip: BoardDefinition = { ...pico, processorProfileId: 'proc.atmega328p' };
  const mismatch = checkArtifactRuntime(wrongChip, 'uf2');
  check(mismatch?.code === 'processor-mismatch', 'a runtime that cannot execute the board\'s processor is refused');
}

// ============================ 6. one definition, used everywhere ============
section('6. the fingerprint is not reconstructed anywhere else');
{
  const { readFile } = await import('node:fs/promises');
  const controller = await readFile('src/simulation/simulationController.ts', 'utf8');
  check(
    /fingerprintForBoard/.test(controller),
    'the build orchestrator uses the shared fingerprint',
  );
  check(
    !/function buildKey/.test(controller),
    'and has no key function of its own',
  );

  // The profile the fingerprint reads its flags from is the same object the
  // rest of the app uses, so a flag added there is in the key automatically.
  const profile = compileProfile('compile.rp2040-arduino')!;
  check('buildFlags' in profile || profile.buildFlags === undefined, 'compile profiles can carry build flags');
  check(
    fingerprintForBoard(getBoardDefinition('board.raspberry-pi-pico')!, FILES).includes(profile.id),
    'and the fingerprint carries the profile that built it',
  );
}

console.log(
  failures === 0
    ? '\nCompile fingerprint checks passed.'
    : `\n${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
