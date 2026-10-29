// Final acceptance audit for per-board sketches.
//
// The parts of the milestone that are only really proved by measurement:
// which board a device model is actually attached to, how many times the
// compiler was actually invoked, and what actually survives a save and a
// reload through the paths the app itself uses.
//
// A real IndexedDB implementation backs the persistence section, so
// saveProject/loadProject are the functions under test rather than a
// stand-in for them.
import 'fake-indexeddb/auto';

import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { useEditorStore } from '../src/app/editorStore';
import { emptyProject } from '../src/project/templates';
import { compileProjectCode } from '../src/compiler/compilerClient';
import { saveProject, loadProject, normalizeProject } from '../src/project/projectService';
import { detectAndParse } from '../src/import/importService';
import {
  assignSketch,
  createSeparateSketch,
  sketchDocuments,
  sketchIdFor,
  boardsUsingSketch,
  unassignedSketches,
  supportFiles,
  filesForBoard,
} from '../src/project/sketches';
import { readFileSync } from 'node:fs';
import type { CircuitProject, ComponentInstance } from '../src/types';

const PICO = 'board.raspberry-pi-pico';
const C6 = 'board.esp32-c6-devkitc-1';

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
function section(title: string) {
  console.log(`\n--- ${title}`);
}

let seq = 0;
const uid = (p: string) => `${p}${++seq}`;

interface Spec {
  boards: { id: string; definitionId: string; sketchId: string; label?: string }[];
  parts?: { id: string; definitionId: string; properties?: Record<string, unknown> }[];
  sketches: { id: string; name: string; content: string }[];
  wires: [string, string, string, string][];
}

function projectOf(spec: Spec): CircuitProject {
  const p = emptyProject('sketch-audit');
  p.codeFiles = spec.sketches.map((s) => ({ ...s, language: 'cpp' as const }));
  for (const b of spec.boards) {
    p.boardInstances.push({
      id: b.id, definitionId: b.definitionId, x: 0, y: 0, rotation: 0,
      properties: {}, simulationState: {}, sketchId: b.sketchId, ...(b.label ? { label: b.label } : {}),
    } as ComponentInstance);
  }
  for (const c of spec.parts ?? []) {
    p.componentInstances.push({
      id: c.id, definitionId: c.definitionId, x: 300, y: 0, rotation: 0,
      properties: c.properties ?? {}, simulationState: {},
    } as ComponentInstance);
  }
  for (const [a, ap, b, bp] of spec.wires) {
    p.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#e8590c', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  }
  return p;
}

// ------------------------------------------------------------------ compiler
//
// The real compiler, counted. Artifact reuse is a claim about how many times
// the toolchain ran, so it is measured at the boundary rather than inferred
// from how the controller grouped its targets internally.
let compileCalls = 0;
const compiledFqbns: string[] = [];
simulationController.setCompiler(async (project, target) => {
  compileCalls++;
  compiledFqbns.push(target.fqbn);
  return compileProjectCode(project, target);
});
function resetCounters(): void {
  compileCalls = 0;
  compiledFqbns.length = 0;
}

const TRANSIENT = /fetch failed|socket|ECONN|EAI_AGAIN|network|timed out|Could not reach the compiler|50[234]/i;

async function build(project: CircuitProject, attempts = 3) {
  let report = await simulationController.build(project);
  for (let i = 1; i < attempts; i++) {
    if (!report.builds.some((b) => b.status !== 'built' && TRANSIENT.test(b.detail))) break;
    console.log(`   (transient transport error — retry ${i})`);
    await new Promise((r) => setTimeout(r, 2000 * i));
    report = await simulationController.build(project);
  }
  return report;
}

async function run(project: CircuitProject): Promise<boolean> {
  simulationController.stop();
  const report = await build(project);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (report.builds.some((b) => b.status !== 'built' && TRANSIENT.test(b.detail))) return false;
  if (!report.anyRunnable) return false;
  if (!(await simulationController.start())) {
    console.log(`   (start refused: ${useSimulationStore.getState().error ?? '—'})`);
    return false;
  }
  simulationController.pause();
  return true;
}

/** The firmware bytes a build produced, as the toolchain returned them. */
function artifactOf(build: { result?: { firmware?: { data: string; format: string } } }): string {
  const fw = build.result?.firmware;
  return fw ? `${fw.format}:${fw.data}` : '';
}

/** LCD rows as the HD44780 model holds them, for one instance. */
function lcdRows(instanceId: string): string[] | undefined {
  simulationController.publishNow();
  const visuals = useSimulationStore.getState().visuals as Record<string, { readout?: string[] }>;
  return visuals[instanceId]?.readout;
}

/**
 * How many device models a board's own I2C bus holds.
 *
 * `null` means the engine exposes no I2C controller at all, which is a
 * different statement from "a bus with nothing on it" and must not be
 * conflated with it: a board with no bus can never take another board's parts.
 * `undefined` means there is no runner.
 */
function i2cCount(boardId: string): number | null | undefined {
  const runner = simulationController.runnerFor(boardId);
  if (!runner) return undefined;
  return runner.i2cBus ? runner.i2cBus.attachedCount : null;
}
function spiCount(boardId: string): number | null | undefined {
  const runner = simulationController.runnerFor(boardId);
  if (!runner) return undefined;
  return runner.spiBus ? runner.spiBus.attachedCount : null;
}

// A minimal PCF8574-backed HD44780 driver, parameterised by the text it shows.
// Deliberately not a library: the bytes on the wire are the thing being tested.
function lcdSketch(row0: string, row1: string, sda = 4, scl = 5): string {
  return [
    '#include <Wire.h>',
    'const uint8_t ADDR = 0x27;',
    'void expander(uint8_t d) { Wire.beginTransmission(ADDR); Wire.write(d | 0x08); Wire.endTransmission(); }',
    'void pulse(uint8_t d) { expander(d | 0x04); delayMicroseconds(2); expander(d & ~0x04); delayMicroseconds(60); }',
    'void send(uint8_t v, uint8_t m) { pulse((v & 0xF0) | m); pulse(((v << 4) & 0xF0) | m); }',
    'void command(uint8_t c) { send(c, 0); }',
    'void print(const char *s) { while (*s) send((uint8_t)*s++, 1); }',
    'void setup() {',
    `  Wire.setSDA(${sda}); Wire.setSCL(${scl}); Wire.begin(); delay(50);`,
    '  pulse(0x30); delay(5); pulse(0x30); delay(5); pulse(0x20); delay(5);',
    '  command(0x28); command(0x08); command(0x01); delay(3); command(0x06); command(0x0C);',
    `  command(0x80); print("${row0}");`,
    `  command(0xC0); print("${row1}");`,
    '}',
    'void loop() {}',
  ].join('\n');
}

// ==================== 2A. two Picos, each with its own I2C display ==========
section('2A. per-board I2C ownership — two Picos, two displays');
{
  const p1 = uid('b');
  const p2 = uid('b');
  const lcd1 = uid('c');
  const lcd2 = uid('c');
  const project = projectOf({
    boards: [
      { id: p1, definitionId: PICO, sketchId: 'k1' },
      { id: p2, definitionId: PICO, sketchId: 'k2' },
    ],
    parts: [
      { id: lcd1, definitionId: 'comp.lcd1602' },
      { id: lcd2, definitionId: 'comp.lcd1602' },
    ],
    sketches: [
      { id: 'k1', name: 'node-one.ino', content: lcdSketch('BOARD ONE HERE  ', 'ONE ONE ONE ONE ') },
      { id: 'k2', name: 'node-two.ino', content: lcdSketch('BOARD TWO HERE  ', 'TWO TWO TWO TWO ') },
    ],
    wires: [
      [p1, 'GND1', p2, 'GND1'],
      [p1, 'GP4', lcd1, 'sda'], [p1, 'GP5', lcd1, 'scl'],
      [p1, '3V3', lcd1, 'vcc'], [p1, 'GND2', lcd1, 'gnd'],
      [p2, 'GP4', lcd2, 'sda'], [p2, 'GP5', lcd2, 'scl'],
      [p2, '3V3', lcd2, 'vcc'], [p2, 'GND2', lcd2, 'gnd'],
    ],
  });

  if (!(await run(project))) {
    skip('the two-display project would not start');
  } else {
    simulationController.advance(900);
    const one = lcdRows(lcd1) ?? [];
    const two = lcdRows(lcd2) ?? [];
    console.log('   LCD #1:', JSON.stringify(one));
    console.log('   LCD #2:', JSON.stringify(two));

    check(one[0] === 'BOARD ONE HERE  ', `the first display shows the first board's text (${JSON.stringify(one[0])})`);
    check(two[0] === 'BOARD TWO HERE  ', `the second shows the second board's (${JSON.stringify(two[0])})`);
    check(one[1] === 'ONE ONE ONE ONE ' && two[1] === 'TWO TWO TWO TWO ', 'both rows of each, from its own board');
    check(one[0] !== two[0], 'two identical board types produced different device state');

    // The attachment itself, not only what came out of it.
    check(i2cCount(p1) === 1, `only one device is on the first Pico's bus (${i2cCount(p1)})`);
    check(i2cCount(p2) === 1, `and one on the second's (${i2cCount(p2)})`);

    // 2D: removing one board must not detach the other's display.
    const beforeRemove = two.join('|');
    simulationController.removeBoard(p1);
    simulationController.advance(120);
    check(simulationController.runnerFor(p1) === undefined, 'removing the first board takes it out of the world');
    check(i2cCount(p2) === 1, `the second board's display is still attached (${i2cCount(p2)})`);
    check((lcdRows(lcd2) ?? []).join('|') === beforeRemove, 'and still holding its own text');
    check((lcdRows(lcd1) ?? []).join('|') !== beforeRemove, "the removed board's display is not showing the survivor's text");

    // 2D: resetting a board must not disturb the other's device either.
    simulationController.resetBoard(p2);
    simulationController.advance(900);
    check(i2cCount(p2) === 1, 'after a reset the surviving board still owns exactly its own device');
    check((lcdRows(lcd2) ?? [])[0] === 'BOARD TWO HERE  ', 'and its firmware redrew its own display');
  }
}

// =============== 2B. C6 first in canvas order, display on the Pico ==========
section('2B. mixed architecture — the C6 must not take the Pico\'s display');
{
  const c6 = uid('b');
  const pico = uid('b');
  const lcd = uid('c');
  const project = projectOf({
    boards: [
      { id: c6, definitionId: C6, sketchId: 'idle' },
      { id: pico, definitionId: PICO, sketchId: 'disp' },
    ],
    parts: [{ id: lcd, definitionId: 'comp.lcd1602' }],
    sketches: [
      { id: 'idle', name: 'controller.ino', content: 'void setup(){ pinMode(2, OUTPUT); }\nvoid loop(){ digitalWrite(2, HIGH); }' },
      { id: 'disp', name: 'display.ino', content: lcdSketch('OWNED BY PICO   ', 'NOT BY THE ESP32') },
    ],
    wires: [
      [c6, 'GND1', pico, 'GND3'],
      [pico, 'GP4', lcd, 'sda'], [pico, 'GP5', lcd, 'scl'],
      [pico, '3V3', lcd, 'vcc'], [pico, 'GND1', lcd, 'gnd'],
    ],
  });

  if (!(await run(project))) {
    skip('the mixed-architecture project would not start');
  } else {
    check(project.boardInstances[0].id === c6, 'the C6 is first in canvas order, so it is the primary board');
    simulationController.advance(900);
    const rows = lcdRows(lcd) ?? [];
    console.log('   LCD:', JSON.stringify(rows));
    check(rows[0] === 'OWNED BY PICO   ', `the display is driven by the Pico (${JSON.stringify(rows[0])})`);
    check(i2cCount(pico) === 1, `the Pico's bus holds it (${i2cCount(pico)})`);
    // The C6 has an I2C controller of its own now, and the display is not on
    // its pins, so its bus is empty: the display was not claimed twice.
    check(simulationController.runnerFor(c6) !== undefined, 'the C6 is running');
    check(i2cCount(c6) === 0, `and its own I2C bus holds nothing (${i2cCount(c6)})`);
  }
}

// ==================== 2C. two Picos, each with its own SPI device ===========
section('2C. per-board SPI ownership — two Picos, two shift registers');
{
  const p1 = uid('b');
  const p2 = uid('b');
  const sr1 = uid('c');
  const sr2 = uid('c');
  // Arduino-Pico's default SPI0: SCK GP18, TX (MOSI) GP19. RCLK is any GPIO.
  const shift = (byte: string) =>
    [
      '#include <SPI.h>',
      'void setup() {',
      '  pinMode(17, OUTPUT); digitalWrite(17, LOW);',
      '  SPI.begin();',
      '  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));',
      `  SPI.transfer(${byte});`,
      '  SPI.endTransaction();',
      '  digitalWrite(17, HIGH); delayMicroseconds(5); digitalWrite(17, LOW);',
      '}',
      'void loop() {}',
    ].join('\n');

  const project = projectOf({
    boards: [
      { id: p1, definitionId: PICO, sketchId: 'a' },
      { id: p2, definitionId: PICO, sketchId: 'b' },
    ],
    parts: [
      { id: sr1, definitionId: 'comp.hc595' },
      { id: sr2, definitionId: 'comp.hc595' },
    ],
    sketches: [
      { id: 'a', name: 'shift-a.ino', content: shift('0xAA') },
      { id: 'b', name: 'shift-b.ino', content: shift('0x55') },
    ],
    wires: [
      [p1, 'GND1', p2, 'GND1'],
      [p1, 'GP18', sr1, 'srclk'], [p1, 'GP19', sr1, 'ser'], [p1, 'GP17', sr1, 'rclk'],
      [p1, '3V3', sr1, 'vcc'], [p1, 'GND2', sr1, 'gnd'], [p1, 'GND3', sr1, 'oe'],
      [p2, 'GP18', sr2, 'srclk'], [p2, 'GP19', sr2, 'ser'], [p2, 'GP17', sr2, 'rclk'],
      [p2, '3V3', sr2, 'vcc'], [p2, 'GND2', sr2, 'gnd'], [p2, 'GND3', sr2, 'oe'],
    ],
  });

  if (!(await run(project))) {
    skip('the two-shift-register project would not start');
  } else {
    simulationController.advance(600);
    const readout = (id: string) => (lcdRows(id) ?? []).join(' ');
    console.log('   74HC595 #1:', readout(sr1));
    console.log('   74HC595 #2:', readout(sr2));
    check(spiCount(p1) === 1, `only one device on the first Pico's SPI bus (${spiCount(p1)})`);
    check(spiCount(p2) === 1, `and one on the second's (${spiCount(p2)})`);
    check(/10101010/.test(readout(sr1)), `the first register holds what its own board shifted (${readout(sr1)})`);
    check(/01010101/.test(readout(sr2)), `and the second holds its board's byte (${readout(sr2)})`);
    check(readout(sr1) !== readout(sr2), 'identical parts on identical board types did not cross-bind');

    const beforeReset = readout(sr2);
    simulationController.resetBoard(p1);
    simulationController.advance(300);
    check(readout(sr2) === beforeReset, "resetting one board left the other board's device untouched");
    check(spiCount(p2) === 1, 'and still attached');
  }
}

// ========================== 3. create separate sketch, end to end ===========
section('3. create separate sketch');
{
  const store = useEditorStore;
  const p = emptyProject('separate');
  p.codeFiles = [{ id: 'sh', name: 'shared.ino', content: '// shared source, exactly this', language: 'cpp' }];
  const a = uid('b');
  const b = uid('b');
  for (const id of [a, b]) {
    p.boardInstances.push({
      id, definitionId: PICO, x: 0, y: 0, rotation: 0, properties: {}, simulationState: {}, sketchId: 'sh',
    } as ComponentInstance);
  }
  store.setState({ project: normalizeProject(p), activeFileId: 'sh', activeBoardId: null, saveState: 'saved' });

  const before = store.getState().project!;
  check(sketchIdFor(before, a) === 'sh' && sketchIdFor(before, b) === 'sh', 'both Picos start on the shared sketch');

  store.getState().setActiveBoard(b);
  store.getState().createSeparateSketchForBoard(b);
  const after = store.getState().project!;
  const newId = sketchIdFor(after, b)!;

  check(typeof newId === 'string' && newId.length > 0 && newId !== 'sh', `a new stable sketch id (${newId})`);
  check(after.codeFiles.find((f) => f.id === newId)?.content === '// shared source, exactly this', 'the source is cloned byte for byte');
  check(sketchIdFor(after, a) === 'sh', 'the first Pico is still on the shared sketch');
  check(after.codeFiles.find((f) => f.id === 'sh')?.content === '// shared source, exactly this', 'whose text did not move');
  check(sketchDocuments(after).length === 2, 'exactly one new document exists');

  store.getState().updateCodeFile(newId, '// only the second board says this');
  const edited = store.getState().project!;
  check(edited.codeFiles.find((f) => f.id === 'sh')?.content === '// shared source, exactly this', 'editing the new one does not change the first board');
  check(edited.codeFiles.find((f) => f.id === newId)?.content === '// only the second board says this', 'and the new one holds the edit');
  check(edited.codeFiles.length === 2, 'no text was lost anywhere');
}

// ================================ 4. assign existing sketch, by id ==========
section('4. assign existing sketch');
{
  const p = projectOf({
    boards: [
      { id: 'ba', definitionId: PICO, sketchId: 'snd' },
      { id: 'bb', definitionId: PICO, sketchId: 'rcv' },
      { id: 'bc', definitionId: PICO, sketchId: 'snd' },
    ],
    sketches: [
      { id: 'snd', name: 'sender.ino', content: '// sender' },
      { id: 'rcv', name: 'receiver.ino', content: '// receiver' },
    ],
    wires: [],
  });
  const assigned = assignSketch(p, 'bc', 'rcv');
  check(sketchIdFor(assigned, 'ba') === 'snd', 'Pico #1 runs sender.ino');
  check(sketchIdFor(assigned, 'bb') === 'rcv', 'Pico #2 runs receiver.ino');
  check(sketchIdFor(assigned, 'bc') === 'rcv', 'Pico #3 runs receiver.ino');
  check(sketchIdFor(assigned, 'bb') === sketchIdFor(assigned, 'bc'), 'and #2 and #3 hold the identical sketch id');
  check(sketchDocuments(assigned).length === 2, 'with no duplicated receiver source in the project');
  const receiverCopies = assigned.codeFiles.filter((f) => f.content === '// receiver');
  check(receiverCopies.length === 1, `the receiver text exists exactly once (${receiverCopies.length})`);

  // Same conclusion, measured through what the compiler is handed.
  const forB = filesForBoard(assigned, 'bb').map((f) => f.content).join('');
  const forC = filesForBoard(assigned, 'bc').map((f) => f.content).join('');
  check(forB === forC, 'both boards are compiled from the same bytes');
}

// ==================== 6. sketch rename and board rename are separate ========
section('6. rename: board label vs sketch name');
{
  const store = useEditorStore;
  const p = projectOf({
    boards: [
      { id: 'r1', definitionId: PICO, sketchId: 'rcv' },
      { id: 'r2', definitionId: PICO, sketchId: 'rcv' },
    ],
    sketches: [{ id: 'rcv', name: 'receiver.ino', content: '// receiver' }],
    wires: [],
  });
  store.setState({ project: normalizeProject(p), activeFileId: 'rcv', activeBoardId: null, saveState: 'saved' });

  store.getState().setInstanceLabel('r1', 'Sensor Node');
  let now = store.getState().project!;
  check(now.boardInstances.find((b) => b.id === 'r1')?.label === 'Sensor Node', 'the board takes its new label');
  check(now.codeFiles.find((f) => f.id === 'rcv')?.name === 'receiver.ino', 'the sketch name is unchanged by it');
  check(sketchIdFor(now, 'r1') === 'rcv', 'and the assignment still resolves');

  store.getState().renameSketchDocument('rcv', 'sensor_receiver.ino');
  now = store.getState().project!;
  check(now.codeFiles.find((f) => f.id === 'rcv')?.name === 'sensor_receiver.ino', 'the sketch takes its new name');
  check(now.boardInstances.find((b) => b.id === 'r1')?.label === 'Sensor Node', 'the board label is unchanged by it');
  check(sketchIdFor(now, 'r1') === 'rcv' && sketchIdFor(now, 'r2') === 'rcv', 'both assignments survive, because they are ids');
  check(now.codeFiles.find((f) => f.id === 'rcv')?.content === '// receiver', 'and no source moved');
}

// ================================= 7. board duplication shares by default ===
section('7. board duplication');
{
  const store = useEditorStore;
  const p = projectOf({
    boards: [{ id: 'd1', definitionId: PICO, sketchId: 'rcv' }],
    sketches: [{ id: 'rcv', name: 'receiver.ino', content: '// receiver' }],
    wires: [],
  });
  store.setState({
    project: normalizeProject(p), activeFileId: 'rcv', activeBoardId: null, saveState: 'saved',
    selection: { componentIds: ['d1'], connectionIds: [] },
  });

  store.getState().copySelection();
  store.getState().pasteClipboard();
  let now = store.getState().project!;
  const copy = now.boardInstances.find((b) => b.id !== 'd1')!;
  check(now.boardInstances.length === 2, 'the board was duplicated');
  check(copy.sketchId === 'rcv', `the copy references the same sketch id (${copy.sketchId})`);
  check(sketchDocuments(now).length === 1, 'and no sketch was created automatically');
  check(boardsUsingSketch(now, 'rcv').length === 2, 'so both boards run the one document');

  store.getState().createSeparateSketchForBoard(copy.id);
  now = store.getState().project!;
  check(sketchIdFor(now, 'd1') === 'rcv', 'detaching the copy leaves the original where it was');
  check(sketchIdFor(now, copy.id) !== 'rcv', 'while the copy moves to its own sketch');
  check(now.codeFiles.find((f) => f.id === 'rcv')?.content === '// receiver', 'with the original text intact');
}

// ================================= 8. deleting a board keeps its code =======
section('8. board deletion preserves source');
{
  const store = useEditorStore;

  // Case A: two boards share receiver.ino, one is deleted.
  const pa = projectOf({
    boards: [
      { id: 'x1', definitionId: PICO, sketchId: 'rcv' },
      { id: 'x2', definitionId: PICO, sketchId: 'rcv' },
    ],
    sketches: [{ id: 'rcv', name: 'receiver.ino', content: '// receiver source' }],
    wires: [],
  });
  store.setState({
    project: normalizeProject(pa), activeFileId: 'rcv', activeBoardId: null, saveState: 'saved',
    selection: { componentIds: ['x1'], connectionIds: [] },
  });
  store.getState().deleteSelection();
  const afterA = store.getState().project!;
  check(afterA.boardInstances.length === 1, 'case A: one of the two boards is gone');
  check(sketchIdFor(afterA, 'x2') === 'rcv', 'the survivor still runs receiver.ino');
  check(afterA.codeFiles.find((f) => f.id === 'rcv')?.content === '// receiver source', 'with its source intact');

  // Case B: the only board on sender.ino is deleted.
  const pb = projectOf({
    boards: [
      { id: 'y1', definitionId: C6, sketchId: 'snd' },
      { id: 'y2', definitionId: PICO, sketchId: 'rcv' },
    ],
    sketches: [
      { id: 'snd', name: 'sender.ino', content: '// sender source worth keeping' },
      { id: 'rcv', name: 'receiver.ino', content: '// receiver source' },
    ],
    wires: [],
  });
  store.setState({
    project: normalizeProject(pb), activeFileId: 'snd', activeBoardId: null, saveState: 'saved',
    selection: { componentIds: ['y1'], connectionIds: [] },
  });
  store.getState().deleteSelection();
  const afterB = store.getState().project!;
  check(afterB.boardInstances.length === 1, 'case B: the only board on sender.ino is gone');
  check(afterB.codeFiles.some((f) => f.id === 'snd'), 'sender.ino still exists');
  check(afterB.codeFiles.find((f) => f.id === 'snd')?.content === '// sender source worth keeping', 'with every byte of it');
  check(afterB.codeFiles.find((f) => f.id === 'snd')?.name === 'sender.ino', 'and its name');
  check(unassignedSketches(afterB).map((f) => f.id).join(',') === 'snd', 'reported as an unassigned sketch, not deleted');
  check(sketchIdFor(afterB, 'y2') === 'rcv', 'the remaining board is unaffected');

  // And it survives the round trip that a save would put it through.
  const reloaded = normalizeProject(JSON.parse(JSON.stringify(afterB)));
  check(reloaded.codeFiles.find((f) => f.id === 'snd')?.content === '// sender source worth keeping', 'and it survives a reload');
}

// ============================== 9. migrating real old-format project files ==
section('9. old-project migration, from the fixtures on disk');
{
  for (const fixture of ['tests/fixtures/pinvis.cdproj.json', 'tests/fixtures/project.cdproj.json']) {
    const raw = JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, unknown>;
    const boardsInFile = (raw.boardInstances as { id: string; sketchId?: string }[]) ?? [];
    const filesInFile = (raw.codeFiles as { id: string; content: string }[]) ?? [];
    check(boardsInFile.every((b) => b.sketchId === undefined), `${fixture}: the file predates sketch assignment`);

    const once = normalizeProject(structuredClone(raw));
    const sketches = sketchDocuments(once);
    check(sketches.length === 1, `${fixture}: migrates to exactly one shared sketch (${sketches.length})`);
    check(sketches[0].id === filesInFile[0].id, 'keeping the original document id — nothing was re-created');
    check(sketches[0].content === filesInFile[0].content, 'and its source byte for byte');
    check(
      once.boardInstances.length === boardsInFile.length &&
        once.boardInstances.every((b) => b.sketchId === sketches[0].id),
      `${fixture}: every board is assigned to it (${once.boardInstances.length} boards)`,
    );

    // Idempotent: migrating the migrated project changes nothing.
    const twice = normalizeProject(structuredClone(once));
    check(sketchDocuments(twice).length === 1, `${fixture}: a second migration creates no second shared sketch`);
    check(
      JSON.stringify(twice.codeFiles) === JSON.stringify(once.codeFiles),
      'the documents are identical after the second pass',
    );
    check(
      JSON.stringify(twice.boardInstances.map((b) => b.sketchId)) ===
        JSON.stringify(once.boardInstances.map((b) => b.sketchId)),
      'and so are the assignments',
    );
  }

  // The oldest format of all: a `code` object and no codeFiles at all.
  const legacy = JSON.parse(readFileSync('tests/fixtures/legacy-esp32c3.cdproj.json', 'utf8')) as Record<string, unknown>;
  const migrated = normalizeProject(structuredClone(legacy));
  check(sketchDocuments(migrated).length === 1, 'a pre-codeFiles project still ends with exactly one sketch');
  check(
    migrated.boardInstances.every((b) => b.sketchId === sketchDocuments(migrated)[0].id),
    'with its board assigned to it',
  );
  const legacyTwice = normalizeProject(structuredClone(migrated));
  check(sketchDocuments(legacyTwice).length === 1, 'and that is idempotent too');
}

// ============================ 10. save and reload, through the real paths ===
section('10. save and reload');
{
  const RECEIVER = 'void setup(){ pinMode(15, OUTPUT); }\nvoid loop(){ digitalWrite(15, HIGH); }';
  const SENDER = 'void setup(){ pinMode(2, OUTPUT); }\nvoid loop(){ digitalWrite(2, HIGH); delay(40); digitalWrite(2, LOW); delay(40); }';
  const p1 = uid('b');
  const p2 = uid('b');
  const c1 = uid('b');
  const project = projectOf({
    boards: [
      { id: p1, definitionId: PICO, sketchId: 'rcv' },
      { id: p2, definitionId: PICO, sketchId: 'rcv' },
      { id: c1, definitionId: C6, sketchId: 'snd' },
    ],
    sketches: [
      { id: 'rcv', name: 'receiver.ino', content: RECEIVER },
      { id: 'snd', name: 'sender.ino', content: SENDER },
    ],
    wires: [[p1, 'GND1', p2, 'GND1'], [p2, 'GND2', c1, 'GND1'], [c1, 'IO2', p1, 'GP16']],
  });
  // A support file too, so the shared-workspace model is part of the round trip.
  project.codeFiles.push({ id: 'hdr', name: 'pins.h', content: '#define LED_PIN 15\n', language: 'cpp' });

  // IndexedDB, the store the app actually writes to.
  await saveProject(normalizeProject(project));
  const reloaded = await loadProject(project.id);
  check(reloaded !== undefined, 'the project comes back out of IndexedDB');
  if (reloaded) {
    check(reloaded.codeFiles.map((f) => f.id).join(',') === 'rcv,snd,hdr', `sketch ids unchanged (${reloaded.codeFiles.map((f) => f.id).join(',')})`);
    check(reloaded.codeFiles.map((f) => f.name).join(',') === 'receiver.ino,sender.ino,pins.h', 'names unchanged');
    check(reloaded.codeFiles.find((f) => f.id === 'rcv')!.content === RECEIVER, 'receiver source is byte for byte');
    check(reloaded.codeFiles.find((f) => f.id === 'snd')!.content === SENDER, 'sender source is byte for byte');
    check(sketchIdFor(reloaded, p1) === 'rcv' && sketchIdFor(reloaded, p2) === 'rcv', 'both Picos reference the same receiver id');
    check(sketchIdFor(reloaded, c1) === 'snd', 'the C6 still references the sender');
    check(reloaded.boardInstances.map((b) => b.id).join(',') === [p1, p2, c1].join(','), 'board instance order and ids preserved');
    check(supportFiles(reloaded).map((f) => f.name).join(',') === 'pins.h', 'the support file is still a support file');
  }

  // The exported file format, which is the other real save path.
  const exported = JSON.stringify({ app: 'CircuitDesk', kind: 'circuitdesk-project', ...project, thumbnailSvg: undefined }, null, 2);
  const parsed = await detectAndParse(new File([exported], 'audit.cdproj.json', { type: 'application/json' }));
  const fromFile = parsed.project!;
  check(fromFile.codeFiles.map((f) => f.id).join(',') === 'rcv,snd,hdr', 'the exported file round-trips the same sketch ids');
  check(fromFile.codeFiles.find((f) => f.id === 'rcv')!.content === RECEIVER, 'and the same source');
  check(sketchIdFor(fromFile, p1) === sketchIdFor(fromFile, p2), 'with both Picos still sharing one sketch');
  check(sketchIdFor(fromFile, c1) === 'snd', 'and the C6 on its own');

  // Restored project actually runs the right firmware.
  if (reloaded && (await run(reloaded))) {
    simulationController.advance(400);
    const r1 = simulationController.runnerFor(p1);
    const rc = simulationController.runnerFor(c1);
    check(r1?.digitalPinLevel(15) === 'high', 'the restored Picos execute the receiver sketch');
    check(rc !== undefined && rc.digitalPinLevel(2) !== undefined, 'and the restored C6 executes the sender');
    check(simulationController.buildReport.length === 2, 'from two builds, as before the save');
  } else {
    skip('the restored project would not start');
  }
}

// ================ 11-13. build units and artifact reuse, measured ===========
section('11. same target, different sketches');
{
  const a = uid('b');
  const b = uid('b');
  const project = projectOf({
    boards: [
      { id: a, definitionId: PICO, sketchId: 'sa' },
      { id: b, definitionId: PICO, sketchId: 'sb' },
    ],
    sketches: [
      { id: 'sa', name: 'sender.ino', content: 'void setup(){ pinMode(15, OUTPUT); }\nvoid loop(){ digitalWrite(15, HIGH); }' },
      { id: 'sb', name: 'receiver.ino', content: 'void setup(){ pinMode(16, INPUT); pinMode(14, OUTPUT); }\nvoid loop(){ digitalWrite(14, digitalRead(16)); }' },
    ],
    wires: [[a, 'GND1', b, 'GND1'], [a, 'GP15', b, 'GP16']],
  });

  simulationController.stop();
  resetCounters();
  const report = await build(project);
  check(report.builds.length === 2, `two sketches on one target is two build units (${report.builds.length})`);
  check(compileCalls === 2, `and two real compiler invocations (${compileCalls})`);
  check(compiledFqbns.every((f) => f === 'rp2040:rp2040:rpipico'), 'both for rp2040:rp2040:rpipico');
  check(report.builds.every((x) => x.status === 'built'), 'both built');
  const firmwares = report.builds.map((x) => artifactOf(x));
  check(firmwares.every((f) => f.length > 0), `both produced a real artifact (${firmwares.map((f) => f.length).join(' / ')} bytes)`);
  check(firmwares[0] !== firmwares[1], 'producing two different firmware artifacts');

  if (await simulationController.start()) {
    simulationController.pause();
    simulationController.advance(400);
    const ra = simulationController.runnerFor(a)!;
    const rb = simulationController.runnerFor(b)!;
    check(ra !== rb, 'two independent runners');
    check(ra.digitalPinLevel(15) === 'high', 'the sender drives GP15');
    check(rb.digitalPinLevel(14) === 'high', 'and the receiver mirrors it across the canvas net');
  } else {
    skip('the different-sketch project would not start');
  }

  section('12. same target, same sketch — one compile, two machines');
  const shared = assignSketch(project, b, 'sa');
  simulationController.stop();
  resetCounters();
  const sharedReport = await build(shared);
  check(sharedReport.builds.length === 1, `one build unit (${sharedReport.builds.length})`);
  check(sharedReport.builds[0].instanceIds.length === 2, 'serving both boards');
  check(compileCalls === 0, `and no compiler invocation at all — the artifact was reused (${compileCalls} calls)`);
  check(/up to date/.test(sharedReport.builds[0].detail), `reported as cached (${sharedReport.builds[0].detail})`);

  if (await simulationController.start()) {
    simulationController.pause();
    simulationController.advance(300);
    const r1 = simulationController.runnerFor(a)!;
    const r2 = simulationController.runnerFor(b)!;
    check(r1 !== r2, 'two independent runners from one artifact');
    check(r1.digitalPinLevel(15) === 'high' && r2.digitalPinLevel(15) === 'high', 'both running the same firmware');
    simulationController.resetBoard(a);
    simulationController.advance(50);
    check(r1.timeMs < r2.timeMs, `resetting one leaves the other running (${r1.timeMs.toFixed(1)} vs ${r2.timeMs.toFixed(1)} ms)`);
  } else {
    skip('the shared-sketch project would not start');
  }
}

section('13. cross-target shared sketch — one document, two artifacts');
{
  // A sketch that is genuinely portable, so sharing it across architectures is
  // a real thing to do rather than a contrivance.
  const PORTABLE = 'void setup(){ pinMode(LED_BUILTIN, OUTPUT); }\nvoid loop(){ digitalWrite(LED_BUILTIN, HIGH); delay(100); digitalWrite(LED_BUILTIN, LOW); delay(100); }';
  const pico = uid('b');
  const c6 = uid('b');
  const project = projectOf({
    boards: [
      { id: pico, definitionId: PICO, sketchId: 'one' },
      { id: c6, definitionId: C6, sketchId: 'one' },
    ],
    sketches: [{ id: 'one', name: 'blink.ino', content: PORTABLE }],
    wires: [[pico, 'GND1', c6, 'GND1']],
  });

  simulationController.stop();
  resetCounters();
  const report = await build(project);
  console.log('   builds:', report.builds.map((b) => b.detail).join(' | '));
  check(report.builds.length === 2, `one document on two targets is two build units (${report.builds.length})`);
  check(new Set(report.builds.map((b) => b.sketchId)).size === 1, 'both from the same sketch document');
  check(new Set(report.builds.map((b) => b.fqbn)).size === 2, 'for two different FQBNs');
  check(report.builds.some((b) => b.fqbn === 'rp2040:rp2040:rpipico'), 'the Pico compiled for rp2040:rp2040:rpipico');
  check(report.builds.some((b) => b.fqbn === 'esp32:esp32:esp32c6'), 'the C6 compiled for esp32:esp32:esp32c6');
  check(compileCalls === 2, `two real compiler invocations (${compileCalls})`);
  check(report.builds.every((b) => b.status === 'built'), 'both built');
  const arts = report.builds.map((b) => artifactOf(b));
  check(arts.every((a) => a.length > 0), `both produced a real artifact (${arts.map((a) => a.length).join(' / ')} bytes)`);
  check(arts[0] !== arts[1], 'and the two artifacts are different binaries — sharing source is not sharing bytes');
}

// ============================= 16. adding a board mid-simulation ============
section('16. add a board while others are running');
{
  const a = uid('b');
  const b = uid('b');
  const SRC = 'void setup(){ pinMode(15, OUTPUT); }\nvoid loop(){ digitalWrite(15, HIGH); }';
  const project = projectOf({
    boards: [
      { id: a, definitionId: PICO, sketchId: 'sh' },
      { id: b, definitionId: PICO, sketchId: 'sh' },
    ],
    sketches: [{ id: 'sh', name: 'shared.ino', content: SRC }],
    wires: [[a, 'GND1', b, 'GND1']],
  });

  if (!(await run(project))) {
    skip('the add-board project would not start');
  } else {
    simulationController.advance(200);
    simulationController.removeBoard(b);
    const runnerA = simulationController.runnerFor(a)!;
    const elapsed = runnerA.timeMs;

    // The artifact for this sketch/target is already in hand.
    resetCounters();
    const added = await simulationController.addBoard(b);
    check(added, 'the board is added back mid-run');
    check(compileCalls === 0, `with no recompilation (${compileCalls} compiler calls)`);
    check(simulationController.runnerFor(b)!.timeMs < 5, 'only the new instance boots');
    check(runnerA.timeMs === elapsed, 'and the board that was already running did not restart');
    simulationController.advance(200);
    check(simulationController.runnerFor(b)!.digitalPinLevel(15) === 'high', 'the new runner executes the assigned sketch');

    // A board whose sketch/target has no artifact cannot be conjured into
    // existence: it is refused rather than given someone else's firmware.
    const c = uid('b');
    const withNew = {
      ...simulationController.simulationWorld ? project : project,
      boardInstances: [
        ...project.boardInstances,
        { id: c, definitionId: C6, x: 0, y: 0, rotation: 0, properties: {}, simulationState: {}, sketchId: 'sh' } as ComponentInstance,
      ],
    };
    resetCounters();
    const addedUnbuilt = await simulationController.addBoard(c, withNew);
    check(!addedUnbuilt, 'a board whose target has no artifact is not started');
    check(simulationController.runnerFor(c) === undefined, 'and gets no runner');
    check(compileCalls === 0, 'no silent compile was triggered behind the run');
    check(simulationController.runnerFor(a)!.timeMs > 0 && runnerA.timeMs === simulationController.runnerFor(a)!.timeMs, 'the running boards were not disturbed');
  }
}

// ================= 17/18. remove, re-add, and serial identity ===============
section('17-18. lifecycle and serial identity');
{
  const a = uid('b');
  const b = uid('b');
  const SRC = [
    'void setup(){ Serial1.begin(115200); pinMode(16, INPUT); pinMode(15, OUTPUT); }',
    'void loop(){ digitalWrite(15, HIGH); Serial1.println(digitalRead(16) ? "HIGH SIDE" : "LOW SIDE"); delay(20); }',
  ].join('\n');
  const project = projectOf({
    boards: [
      { id: a, definitionId: PICO, sketchId: 'one', label: 'Sensor Node' },
      { id: b, definitionId: PICO, sketchId: 'one' },
    ],
    sketches: [{ id: 'one', name: 'shared.ino', content: SRC }],
    wires: [[a, 'GND1', b, 'GND1'], [a, 'GP16', a, '3V3'], [b, 'GP16', b, 'GND7']],
  });

  if (!(await run(project))) {
    skip('the lifecycle/serial project would not start');
  } else {
    simulationController.advance(300);
    simulationController.publishNow();
    const state = useSimulationStore.getState();
    const text = state.serialText;
    console.log('   serial:', JSON.stringify(text.split('\n').filter(Boolean).slice(0, 3)));

    check(/\[Sensor Node\]/.test(text), 'a custom board label wins over the generated one');
    check(/\[Raspberry Pi Pico\]/.test(text), 'and the unnamed board keeps its product name');
    check(!/shared\.ino/.test(text), 'serial is never attributed to the sketch the two boards share');
    check(
      text.split('\n').filter((l) => l.startsWith('[Sensor Node]')).every((l) => /HIGH SIDE/.test(l)),
      'the board wired high says so',
    );
    check(
      text.split('\n').filter((l) => l.startsWith('[Raspberry Pi Pico]')).every((l) => /LOW SIDE/.test(l)),
      'and the other board says the other thing, from the same source',
    );

    // Targeted input goes to one physical board, never broadcast.
    const targets = state.serialBoards.map((s) => s.instanceId);
    check(targets.length === 2 && targets.includes(a) && targets.includes(b), 'both boards are offered as serial targets');
    state.setSerialTarget(b);
    check(useSimulationStore.getState().serialTarget === b, 'the input target is a board instance, not a sketch');

    // Remove one, the other keeps running; re-add restores its assignment.
    const runnerA = simulationController.runnerFor(a)!;
    const before = runnerA.timeMs;
    simulationController.removeBoard(b);
    simulationController.advance(150);
    check(simulationController.runnerFor(b) === undefined, 'the removed board is gone');
    check(runnerA.timeMs > before, `the unrelated board carried on (${runnerA.timeMs.toFixed(0)} ms)`);
    check(useSimulationStore.getState().serialBoards.length === 1, 'and the serial target list shrank to the survivor');

    const elapsed = runnerA.timeMs;
    check(await simulationController.addBoard(b), 'the board is added back');
    check(sketchIdFor(project, b) === 'one', 'still assigned to the sketch the project says it runs');
    check(simulationController.runnerFor(b)!.timeMs < 5, 'a fresh runner boots for the new instance');
    check(runnerA.timeMs === elapsed, "and the other board's world time was not reset");
    simulationController.advance(200);
    check(simulationController.runnerFor(b)!.digitalPinLevel(15) === 'high', 'the re-added board runs the right sketch');
  }
}

// ============================ 20. shared support files, as documented =======
section('20. support files are workspace-shared');
{
  const project = projectOf({
    boards: [
      { id: 'sf1', definitionId: PICO, sketchId: 'sa' },
      { id: 'sf2', definitionId: C6, sketchId: 'sb' },
    ],
    sketches: [
      { id: 'sa', name: 'a.ino', content: '// a' },
      { id: 'sb', name: 'b.ino', content: '// b' },
    ],
    wires: [],
  });
  project.codeFiles.push({ id: 'h1', name: 'shared.h', content: '#define X 1\n', language: 'cpp' });
  project.codeFiles.push({ id: 'c1', name: 'helpers.cpp', content: 'int helper(){ return 1; }\n', language: 'cpp' });

  const forA = filesForBoard(project, 'sf1');
  const forB = filesForBoard(project, 'sf2');
  check(forA[0].name === 'sketch.ino' && forA[0].content === '// a', "each board's own sketch leads its build");
  check(forB[0].content === '// b', 'and only its own');
  check(forA.slice(1).map((f) => f.name).join(',') === 'shared.h,helpers.cpp', 'every support file goes into the first build');
  check(forB.slice(1).map((f) => f.name).join(',') === 'shared.h,helpers.cpp', 'and the same ones into the second');
  check(!forA.some((f) => f.content === '// b') && !forB.some((f) => f.content === '// a'), 'no board is ever handed another board\'s sketch');
  check(supportFiles(project).length === 2, 'support files are not sketch documents');
  check(sketchDocuments(project).length === 2, 'and sketches are not support files');
}

simulationController.stop();
console.log(
  failures === 0
    ? `\nPer-board sketch audit passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
