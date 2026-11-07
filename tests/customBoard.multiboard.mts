// Custom boards in company: with each other, with native boards, and with parts.
//
// A board that only works alone is not really a board. The claims under test:
//
//   * two instances of one custom definition are two independent machines that
//     happen to share a design — one runner each, one sketch assignment each,
//     and nothing crossing between them;
//   * a custom board and a board CircuitDesk ships sit on one canvas and both
//     run, neither borrowing the other's identity;
//   * two custom boards on different architectures run side by side;
//   * a real I2C part wired to a custom board's OWN pin names exchanges real
//     traffic with firmware — which is the point at which a custom board stops
//     being a picture and starts being a board.
//
// The last one is the load-bearing test. Everything upstream can be right and
// the device still never attaches, because attaching asks a question the pad
// map has to answer: which runner pin is the user's BUS_DATA?

import { simulationController } from '../src/simulation/simulationController';
import { emptyProject } from '../src/project/templates';
import { embedBoard } from '../src/custom-boards/projectBoards';
import { resolveCustomBoard } from '../src/custom-boards/resolve';
import { resolveWorkspaceTargets } from '../src/compiler/targets';
import { sketchFor, boardsUsingSketch, filesForBoard } from '../src/project/sketches';
import { runnerPinIndex } from '../src/simulation/boardRunner';
import { CUSTOM_BOARD_SCHEMA_VERSION, type CustomBoardDefinition, type CustomBoardPin } from '../src/custom-boards/schema';
import type { CircuitProject, ComponentInstance, CodeFile } from '../src/types';

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

let seq = 0;
const uid = (p: string) => `${p}${++seq}`;

const pin = (
  id: string, label: string, pad: string | null, index: number,
  type: CustomBoardPin['type'] = 'digital',
): CustomBoardPin => ({
  id, label, pad, xMm: 3, yMm: 4 + index * 4, type, capabilities: [],
  ...(type === 'power-5v' ? { voltage: 5 } : type === 'power-3v3' ? { voltage: 3.3 } : {}),
});

// -------------------------------------------------------------- the boards

/** An ATmega328P board with an I2C header the maker named themselves. */
const LOGGER: CustomBoardDefinition = {
  schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
  id: 'custom.field-logger',
  revision: 1,
  identity: { name: 'Field Logger', creator: 'Fieldwork Instruments' },
  outline: { widthMm: 30, heightMm: 46, color: '#2f4f3f' },
  pins: [
    pin('V5', '5V', null, 0, 'power-5v'),
    pin('GND', 'GND', null, 1, 'ground'),
    pin('BEACON', 'BEACON', 'PB5', 2),
    pin('BUS_DATA', 'BUS_DATA', 'PC4', 3),
    pin('BUS_CLK', 'BUS_CLK', 'PC5', 4),
    pin('AUX', 'AUX', 'PD6', 5),
  ],
  processorProfileId: 'proc.atmega328p',
  compileProfileId: 'compile.avr-arduino',
  runtimeProfileId: 'runtime.avr8js-328p',
};

/** An RP2040 board, for the cross-architecture pairing. */
const ROVER: CustomBoardDefinition = {
  schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
  id: 'custom.rover-brain',
  revision: 1,
  identity: { name: 'Rover Brain', creator: 'Fieldwork Instruments' },
  outline: { widthMm: 36, heightMm: 50, color: '#123f5e' },
  pins: [
    pin('V3', '3V3', null, 0, 'power-3v3'),
    pin('GND', 'GND', null, 1, 'ground'),
    pin('HEADLAMP', 'HEADLAMP', 'GP15', 2),
    pin('BUMPER', 'BUMPER', 'GP16', 3),
  ],
  processorProfileId: 'proc.rp2040',
  compileProfileId: 'compile.rp2040-arduino',
  runtimeProfileId: 'runtime.rp2040js',
};

/** An ESP32-C6 board, likewise. */
const RELAY: CustomBoardDefinition = {
  schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
  id: 'custom.mesh-relay-2',
  revision: 1,
  identity: { name: 'Mesh Relay', creator: 'Fieldwork Instruments' },
  outline: { widthMm: 26, heightMm: 40, color: '#4f2f3f' },
  pins: [
    pin('V3', '3V3', null, 0, 'power-3v3'),
    pin('GND', 'GND', null, 1, 'ground'),
    pin('LINK_LED', 'LINK_LED', 'IO15', 2),
  ],
  processorProfileId: 'proc.esp32c6',
  compileProfileId: 'compile.esp32c6-arduino',
  runtimeProfileId: 'runtime.esp32c6',
};

const blink = (n: number, ms: number) => [
  'void setup() {',
  `  pinMode(${n}, OUTPUT);`,
  '}',
  'void loop() {',
  `  digitalWrite(${n}, HIGH);`,
  `  delay(${ms});`,
  `  digitalWrite(${n}, LOW);`,
  `  delay(${ms});`,
  '}',
].join('\n');

/** Holds a pin steady, so "did the other board move it?" is answerable. */
const holdLow = (n: number) => [
  'void setup() {',
  `  pinMode(${n}, OUTPUT);`,
  `  digitalWrite(${n}, LOW);`,
  '}',
  'void loop() {}',
].join('\n');

// ---------------------------------------------------------------- harness

function addBoard(project: CircuitProject, def: CustomBoardDefinition, sketchId?: string): ComponentInstance {
  embedBoard(project, def);
  const instance: ComponentInstance = {
    id: uid('b'), definitionId: def.id, x: 40, y: 40, rotation: 0, properties: {}, simulationState: {},
    ...(sketchId ? { sketchId } : {}),
  } as ComponentInstance;
  project.boardInstances.push(instance);
  return instance;
}

function sketch(project: CircuitProject, name: string, content: string): CodeFile {
  const file: CodeFile = { id: uid('f'), name, content, language: 'cpp' };
  project.codeFiles.push(file);
  return file;
}

function wire(project: CircuitProject, a: string, ap: string, b: string, bp: string) {
  project.connections.push({
    id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
    netId: '', color: '#888', points: [], routing: 'smooth',
  } as CircuitProject['connections'][number]);
}

// ============================ 1. two of the same custom board ================
section('1. two instances of one custom design are two machines');
{
  const project = emptyProject('twin loggers');
  project.codeFiles = [];
  const fast = sketch(project, 'fast.ino', blink(13, 20));
  const still = sketch(project, 'still.ino', holdLow(13));
  const a = addBoard(project, LOGGER, fast.id);
  const b = addBoard(project, LOGGER, still.id);

  check(a.definitionId === b.definitionId, 'both instances are the same design');
  check(a.id !== b.id, 'and different machines');
  check(sketchFor(project, a.id)?.name === 'fast.ino', 'each carries its own sketch assignment');
  check(sketchFor(project, b.id)?.name === 'still.ino', 'independently of the other');
  check(boardsUsingSketch(project, fast.id).length === 1, 'and a sketch knows which boards run it');
  // The build sees one .ino, under the name a sketch folder wants; which
  // document it came from is what differs between the twins.
  check(
    filesForBoard(project, a.id).some((f) => f.content === blink(13, 20)) &&
    !filesForBoard(project, a.id).some((f) => f.content === holdLow(13)),
    'a board\'s build contains its own sketch and not its twin\'s',
  );

  const { targets, unbuildable } = resolveWorkspaceTargets(project);
  check(unbuildable.length === 0, `both are buildable${unbuildable.map((u) => ` — ${u.reason}`).join('')}`);
  check(targets.length === 2, `two builds are needed, because the sources differ (${targets.length})`);
  check(
    targets.every((t) => t.boardId === LOGGER.id),
    'both stamped with the same custom board id, which is what they are',
  );
  check(
    new Set(targets.map((t) => t.sketchId)).size === 2,
    'from two different sketch documents, because different firmware is different firmware',
  );
  check(
    targets.every((t) => t.instanceIds.length === 1),
    'and neither build is shared between the two machines',
  );

  simulationController.stop();
  const report = await simulationController.build(project);
  if (!report.anyRunnable) {
    skip('the AVR toolchain is unavailable here');
  } else {
    const started = await simulationController.start();
    check(started, 'both start');
    if (started) {
      simulationController.pause();
      const runnerA = simulationController.runnerFor(a.id);
      const runnerB = simulationController.runnerFor(b.id);
      check(runnerA !== undefined && runnerB !== undefined, 'each instance has its own runner');
      check(runnerA !== runnerB, 'and they are not the same object');
      let high = false;
      let bMoved = false;
      for (let i = 0; i < 120 && !high; i++) {
        simulationController.advance(10);
        if (runnerA?.digitalPinLevel(13) === 'high') high = true;
        if (runnerB?.digitalPinLevel(13) === 'high') bMoved = true;
      }
      check(high, 'the blinking one blinks');
      check(!bMoved, 'and the still one stays still — no state crosses between twins');
    }
    simulationController.stop();
  }
}

// ============================ 2. a custom board beside a native one ==========
section('2. a custom board and an Arduino Uno on one canvas');
{
  const project = emptyProject('mixed');
  project.codeFiles = [];
  const s = sketch(project, 'blink.ino', blink(13, 25));
  const custom = addBoard(project, ROVER, s.id);
  const uno: ComponentInstance = {
    id: uid('b'), definitionId: 'board.arduino-uno', x: 400, y: 40, rotation: 0,
    properties: {}, simulationState: {}, sketchId: s.id,
  } as ComponentInstance;
  project.boardInstances.push(uno);

  const { targets, unbuildable } = resolveWorkspaceTargets(project);
  check(unbuildable.length === 0, `both build${unbuildable.map((u) => ` — ${u.reason}`).join('')}`);
  check(targets.length === 2, `for two different chips (${targets.length})`);
  const byBoard = new Map(targets.map((t) => [t.boardId, t]));
  check(byBoard.get(ROVER.id)?.fqbn === 'rp2040:rp2040:rpipico', 'the custom board builds for its RP2040');
  check(byBoard.get('board.arduino-uno')?.fqbn === 'arduino:avr:uno', 'and the Uno for its ATmega328P');
  check(
    byBoard.get(ROVER.id)?.serverBoardId !== byBoard.get('board.arduino-uno')?.serverBoardId,
    'through different pipelines',
  );

  simulationController.stop();
  const report = await simulationController.build(project);
  if (!report.anyRunnable) {
    skip('a toolchain is unavailable here');
  } else {
    check(report.builds.length === 2, `both were built (${report.builds.length})`);
    check(report.builds.every((b) => b.status === 'built'), 'successfully');
    const started = await simulationController.start();
    check(started, 'and both run');
    if (started) {
      simulationController.pause();
      const rover = simulationController.runnerFor(custom.id);
      const arduino = simulationController.runnerFor(uno.id);
      check(rover !== undefined && arduino !== undefined, 'each with its own runner');
      // The same sketch drives pin 13 on both. On the Uno that is D13; on the
      // custom RP2040 board it is nothing the maker brought out, which is the
      // honest answer rather than an invented one.
      let unoBlinked = false;
      for (let i = 0; i < 120 && !unoBlinked; i++) {
        simulationController.advance(10);
        if (arduino?.digitalPinLevel(13) === 'high') unoBlinked = true;
      }
      check(unoBlinked, 'the Uno blinks its D13');
      check(
        runnerPinIndex(resolveCustomBoard(ROVER).board, 'HEADLAMP') === 15,
        'while the custom board\'s HEADLAMP is still its own pad 15',
      );
    }
    simulationController.stop();
  }
}

// ====================== 3. two custom boards, two architectures =============
section('3. a custom RP2040 and a custom ESP32-C6 together');
{
  const project = emptyProject('cross architecture');
  project.codeFiles = [];
  const roverSketch = sketch(project, 'rover.ino', blink(15, 20));
  const relaySketch = sketch(project, 'relay.ino', blink(15, 40));
  const rover = addBoard(project, ROVER, roverSketch.id);
  const relay = addBoard(project, RELAY, relaySketch.id);

  const { targets, unbuildable } = resolveWorkspaceTargets(project);
  check(unbuildable.length === 0, `both build${unbuildable.map((u) => ` — ${u.reason}`).join('')}`);
  check(
    targets.find((t) => t.boardId === ROVER.id)?.fqbn !== targets.find((t) => t.boardId === RELAY.id)?.fqbn,
    'against two different toolchain targets',
  );

  simulationController.stop();
  const report = await simulationController.build(project);
  if (!report.anyRunnable) {
    skip('a toolchain is unavailable here');
  } else {
    check(report.builds.every((b) => b.status === 'built'), `both built (${report.builds.map((b) => b.status).join(', ')})`);
    check(
      new Set(report.builds.map((b) => b.result?.firmware?.format)).size === 2,
      `producing different artifact formats, as different chips do (${report.builds.map((b) => b.result?.firmware?.format).join(', ')})`,
    );
    const started = await simulationController.start();
    check(started, 'and both run, on two different emulators');
    if (started) {
      simulationController.pause();
      const a = simulationController.runnerFor(rover.id);
      const b = simulationController.runnerFor(relay.id);
      let roverBlinked = false;
      let relayBlinked = false;
      for (let i = 0; i < 200 && !(roverBlinked && relayBlinked); i++) {
        simulationController.advance(10);
        if (a?.digitalPinLevel(15) === 'high') roverBlinked = true;
        if (b?.digitalPinLevel(15) === 'high') relayBlinked = true;
      }
      check(roverBlinked, 'the RP2040 board drives HEADLAMP');
      check(relayBlinked, 'and the C6 board drives LINK_LED, in the same world');
    }
    simulationController.stop();
  }
}

// ================= 4. a real I2C part on the maker's own pin names ===========
section('4. an EEPROM on BUS_DATA/BUS_CLK, exchanging real traffic');
{
  // Writes a byte over I2C, reads it back, and lights BEACON only if the byte
  // that came back is the byte that went out. Nothing here can pass by
  // accident: a device that never attached NACKs, and the readback fails.
  const ROUNDTRIP = [
    '#include <Wire.h>',
    'void setup() {',
    '  pinMode(13, OUTPUT);',
    '  digitalWrite(13, LOW);',
    '  Wire.begin();',
    '  Wire.beginTransmission(0x50);',
    '  Wire.write((uint8_t)0x00);',
    '  Wire.write((uint8_t)0x10);',
    '  Wire.write((uint8_t)0x5A);',
    '  Wire.endTransmission();',
    '  delay(10);',
    '  Wire.beginTransmission(0x50);',
    '  Wire.write((uint8_t)0x00);',
    '  Wire.write((uint8_t)0x10);',
    '  Wire.endTransmission();',
    '  Wire.requestFrom(0x50, 1);',
    '  uint8_t got = Wire.available() ? Wire.read() : 0;',
    '  if (got == 0x5A) digitalWrite(13, HIGH);',
    '}',
    'void loop() {}',
  ].join('\n');

  const project = emptyProject('custom board with a device');
  project.codeFiles = [];
  const s = sketch(project, 'roundtrip.ino', ROUNDTRIP);
  const board = addBoard(project, LOGGER, s.id);
  const eeprom: ComponentInstance = {
    id: uid('e'), definitionId: 'comp.eeprom-24c', x: 300, y: 40, rotation: 0,
    properties: {}, simulationState: {},
  } as ComponentInstance;
  project.componentInstances.push(eeprom);

  // Wired to the pins the maker printed, not to anything called SDA.
  wire(project, eeprom.id, 'sda', board.id, 'BUS_DATA');
  wire(project, eeprom.id, 'scl', board.id, 'BUS_CLK');
  wire(project, eeprom.id, 'vcc', board.id, 'V5');
  wire(project, eeprom.id, 'gnd', board.id, 'GND');
  wire(project, eeprom.id, 'a0', board.id, 'GND');
  wire(project, eeprom.id, 'a1', board.id, 'GND');
  wire(project, eeprom.id, 'a2', board.id, 'GND');

  const { board: resolved } = resolveCustomBoard(LOGGER);
  check(runnerPinIndex(resolved, 'BUS_DATA') === 18, 'BUS_DATA is the TWI SDA pad in the core\'s numbering');
  check(runnerPinIndex(resolved, 'BUS_CLK') === 19, 'and BUS_CLK the SCL pad');

  simulationController.stop();
  const report = await simulationController.build(project);
  if (!report.anyRunnable) {
    skip('the AVR toolchain is unavailable here');
  } else {
    check(report.builds[0]?.status === 'built', `the sketch built (${report.builds[0]?.status})`);
    const started = await simulationController.start();
    check(started, 'and it runs');
    if (started) {
      simulationController.pause();
      const runner = simulationController.runnerFor(board.id);
      let lit = false;
      for (let i = 0; i < 200 && !lit; i++) {
        simulationController.advance(10);
        if (runner?.digitalPinLevel(13) === 'high') lit = true;
      }
      check(
        lit,
        'the byte written over the custom board\'s own I2C pins came back — the device is genuinely attached',
      );
    }
    simulationController.stop();
  }
}

// ============================= 5. a device on the WRONG pins does not work ===
section('5. and the same part on pins that are not the bus is honestly dead');
{
  const project = emptyProject('mis-wired');
  project.codeFiles = [];
  const s = sketch(project, 'roundtrip.ino', [
    '#include <Wire.h>',
    'void setup() {',
    '  pinMode(13, OUTPUT); digitalWrite(13, LOW);',
    '  Wire.begin();',
    '  Wire.beginTransmission(0x50);',
    '  Wire.write((uint8_t)0x00); Wire.write((uint8_t)0x10); Wire.write((uint8_t)0x5A);',
    '  Wire.endTransmission();',
    '  delay(10);',
    '  Wire.beginTransmission(0x50);',
    '  Wire.write((uint8_t)0x00); Wire.write((uint8_t)0x10);',
    '  Wire.endTransmission();',
    '  Wire.requestFrom(0x50, 1);',
    '  uint8_t got = Wire.available() ? Wire.read() : 0;',
    '  if (got == 0x5A) digitalWrite(13, HIGH);',
    '}',
    'void loop() {}',
  ].join('\n'));
  const board = addBoard(project, LOGGER, s.id);
  const eeprom: ComponentInstance = {
    id: uid('e'), definitionId: 'comp.eeprom-24c', x: 300, y: 40, rotation: 0,
    properties: {}, simulationState: {},
  } as ComponentInstance;
  project.componentInstances.push(eeprom);
  // AUX is a perfectly good GPIO and is not the I2C bus.
  wire(project, eeprom.id, 'sda', board.id, 'AUX');
  wire(project, eeprom.id, 'scl', board.id, 'BUS_CLK');
  wire(project, eeprom.id, 'vcc', board.id, 'V5');
  wire(project, eeprom.id, 'gnd', board.id, 'GND');

  simulationController.stop();
  const report = await simulationController.build(project);
  if (!report.anyRunnable) {
    skip('the AVR toolchain is unavailable here');
  } else {
    const started = await simulationController.start();
    if (started) {
      simulationController.pause();
      const runner = simulationController.runnerFor(board.id);
      let lit = false;
      for (let i = 0; i < 120 && !lit; i++) {
        simulationController.advance(10);
        if (runner?.digitalPinLevel(13) === 'high') lit = true;
      }
      check(!lit, 'nothing answered, because nothing was on the bus');
    }
    simulationController.stop();
  }
}

console.log(
  failures === 0
    ? `\nCustom-board multi-board checks passed${skipped ? ` (${skipped} skipped)` : ''}.`
    : `\n${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
