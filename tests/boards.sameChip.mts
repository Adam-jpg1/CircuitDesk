// Three boards that are not the boards they build through.
//
// CircuitDesk executes four chips. Up to now it offered them only under the
// names of the dev kits they first arrived on, which is a limitation of the
// catalogue and not of the emulator: a XIAO RP2040 is an RP2040, a Pro Mini is
// an ATmega328P at 16 MHz, an ESP32-C3 SuperMini is an ESP32-C3. The separation
// of board, processor, toolchain and runtime exists so that adding them costs
// a capability entry rather than a new emulator.
//
// What that separation has to be held to is the part that is easy to get wrong:
// these boards must build through a target the compiler service already knows
// WITHOUT becoming that board anywhere a user can see, and the boards that were
// already here must not shift targets because a new rule was added. So this
// asserts both halves — the new boards compile and genuinely execute, and the
// old boards' service ids and FQBNs are exactly what they were.
//
// Skips the execution section cleanly when the toolchain is unavailable.

import { simulationController } from '../src/simulation/simulationController';
import { emptyProject } from '../src/project/templates';
import { getBoardDefinition } from '../src/boards/definitions';
import { resolveWorkspaceTargets } from '../src/compiler/targets';
import { getSimulatorAdapter } from '../src/simulation/adapters';
import { runnerPinIndex } from '../src/simulation/boardRunner';
import type { CircuitProject, ComponentInstance } from '../src/types';

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

/** A board, a sketch, and the one pad the sketch drives. */
interface Case {
  boardId: string;
  /** What the service is asked to build, and with which FQBN. */
  serviceId: string;
  fqbn: string;
  /** The firmware format its runtime executes. */
  format: 'intel-hex' | 'uf2' | 'esp-image';
  /** The pin the user sees, and the pad behind it. */
  pinId: string;
  pad: number;
  source: string;
  /** Words that must not appear anywhere in the board a user can read. */
  forbidden: string[];
}

/** Firmware addresses the pad, which is what firmware does. */
const avrBlink = (pin: number) =>
  [
    'void setup() {',
    `  pinMode(${pin}, OUTPUT);`,
    '}',
    'void loop() {',
    `  digitalWrite(${pin}, HIGH);`,
    '  delay(30);',
    `  digitalWrite(${pin}, LOW);`,
    '  delay(30);',
    '}',
  ].join('\n');

const CASES: Case[] = [
  {
    boardId: 'board.arduino-pro-mini',
    serviceId: 'board.arduino-uno',
    fqbn: 'arduino:avr:uno',
    format: 'intel-hex',
    pinId: 'D13',
    pad: 13,
    source: avrBlink(13),
    // "Uno" is legitimate in the compiler note and nowhere else.
    forbidden: ['Uno R3'],
  },
  {
    boardId: 'board.seeed-xiao-rp2040',
    serviceId: 'board.raspberry-pi-pico',
    fqbn: 'rp2040:rp2040:rpipico',
    format: 'uf2',
    // The silkscreen says D0. The pad is GP26, and 26 is what the sketch names.
    pinId: 'D0',
    pad: 26,
    source: avrBlink(26),
    forbidden: ['Raspberry Pi Pico'],
  },
  {
    boardId: 'board.esp32-c3-supermini',
    serviceId: 'board.esp32-c3',
    fqbn: 'esp32:esp32:esp32c3',
    format: 'esp-image',
    pinId: 'IO8',
    pad: 8,
    source: avrBlink(8),
    forbidden: ['DevKitM'],
  },
];

function projectFor(c: Case): { project: CircuitProject; instance: ComponentInstance } {
  const project = emptyProject(`same-chip ${c.boardId}`);
  const instance: ComponentInstance = {
    id: uid('b'), definitionId: c.boardId, x: 40, y: 40, rotation: 0, properties: {}, simulationState: {},
  };
  project.boardInstances = [instance];
  project.componentInstances = [];
  project.connections = [];
  project.codeFiles = [{ id: 'f1', name: 'sketch.ino', content: c.source, language: 'cpp' }];
  return { project, instance };
}

// ===================================== 1. each is its own product ===========
section('1. its own product, not the kit it builds through');
for (const c of CASES) {
  const def = getBoardDefinition(c.boardId);
  check(def !== undefined, `${c.boardId} is in the catalogue`);
  if (!def) continue;
  check(def.id !== c.serviceId, `its id is not the build target's (${def.id})`);
  // Identity text a user reads: name, description, processor, maker. The
  // compiler note legitimately names the target, so it is excluded.
  const visible = [def.name, def.description ?? '', def.processor ?? '', def.manufacturer ?? ''].join(' | ');
  for (const word of c.forbidden) {
    check(!visible.includes(word), `nothing a user reads calls it a ${word}`);
  }
  check(def.supportLevel === 'simulated', `it is badged simulated (${def.supportLevel})`);
  check(getSimulatorAdapter(def) !== null, 'because an adapter genuinely claims it');
  check(def.compiler?.supported === true, 'and the toolchain is declared supported');
  check(def.compiler?.fqbn === c.fqbn, `with FQBN ${def.compiler?.fqbn}`);
  check(
    typeof def.compiler?.note === 'string' && def.compiler.note.length > 0,
    'and a note saying which target it builds through, rather than leaving it implicit',
  );
  check(
    typeof def.metadata?.limitation === 'string' && def.metadata.limitation.length > 0,
    'and a stated limitation, so the badge is not read as "everything works"',
  );
}

// ======================= 2. the label and the pad are both real =============
section('2. the user wires the label, the firmware drives the pad');
for (const c of CASES) {
  const def = getBoardDefinition(c.boardId)!;
  const pin = def.pins.find((p) => p.id === c.pinId);
  check(pin !== undefined, `${c.boardId} has a pin called ${c.pinId}`);
  check(runnerPinIndex(def, c.pinId) === c.pad, `and it resolves to pad ${c.pad} (${runnerPinIndex(def, c.pinId)})`);
}
{
  const xiao = getBoardDefinition('board.seeed-xiao-rp2040')!;
  check(xiao.padMap?.D0 === 'GP26', 'the XIAO states the translation in its own definition');
  check(
    xiao.pins.every((p) => !/^GP\d+$/.test(p.label)),
    'and no pin is LABELLED with a pad name — the labels are the ones printed on the board',
  );
  const promini = getBoardDefinition('board.arduino-pro-mini')!;
  check(promini.padMap === undefined, 'the Pro Mini needs no pad map, because its labels ARE the Arduino numbers');
}

// ============== 3. the new rule did not move any existing board =============
section('3. boards that were already here build exactly as they did');
{
  // The one that would hurt: the Uno and the Nano share a compile profile whose
  // target is the Uno. A rule that derived the service id from the profile
  // would build Nano firmware as an Uno — wrong FQBN, and two pins that do not
  // exist there. These are spelled out rather than computed, so a regression
  // has to disagree with a written number.
  const expected: [string, string, string][] = [
    ['board.arduino-uno', 'board.arduino-uno', 'arduino:avr:uno'],
    ['board.arduino-nano', 'board.arduino-nano', 'arduino:avr:nano'],
    ['board.arduino-mega2560', 'board.arduino-mega2560', 'arduino:avr:mega'],
    ['board.arduino-leonardo', 'board.arduino-leonardo', 'arduino:avr:leonardo'],
    ['board.raspberry-pi-pico', 'board.raspberry-pi-pico', 'rp2040:rp2040:rpipico'],
    ['board.raspberry-pi-pico-w', 'board.raspberry-pi-pico-w', 'rp2040:rp2040:rpipicow'],
    ['board.esp32-c3', 'board.esp32-c3', 'esp32:esp32:esp32c3'],
  ];
  for (const [boardId, serviceId, fqbn] of expected) {
    const project = emptyProject(`unchanged ${boardId}`);
    project.boardInstances = [{
      id: uid('b'), definitionId: boardId, x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
    }];
    project.componentInstances = [];
    project.connections = [];
    project.codeFiles = [{ id: 'f1', name: 'sketch.ino', content: avrBlink(13), language: 'cpp' }];
    const { targets, unbuildable } = resolveWorkspaceTargets(project);
    check(unbuildable.length === 0, `${boardId} is still buildable`);
    check(targets[0]?.serverBoardId === serviceId, `and still asks the service for ${targets[0]?.serverBoardId}`);
    check(targets[0]?.fqbn === fqbn, `with ${targets[0]?.fqbn}`);
  }
}

// ======================== 4. and the new boards resolve a target ============
section('4. the new boards name a target the service already knows');
for (const c of CASES) {
  const { project } = projectFor(c);
  const { targets, unbuildable } = resolveWorkspaceTargets(project);
  check(unbuildable.length === 0, `${c.boardId} is buildable${unbuildable.map((u) => ` — ${u.reason}`).join('')}`);
  check(targets[0]?.boardId === c.boardId, 'the build belongs to this board');
  check(targets[0]?.serverBoardId === c.serviceId, `and is requested as ${targets[0]?.serverBoardId}`);
  check(targets[0]?.fqbn === c.fqbn, `with ${targets[0]?.fqbn}`);
}

// ============================= 5. it compiles, and it runs ==================
section('5. real firmware, really executed');
for (const c of CASES) {
  const { project, instance } = projectFor(c);
  simulationController.stop();
  const report = await simulationController.build(project);
  for (const b of report.builds) console.log(`   ${c.boardId}: ${b.detail}`);

  if (!report.anyRunnable) {
    skip(`the toolchain for ${c.boardId} is unavailable here`);
    continue;
  }
  const build = report.builds[0];
  check(build?.status === 'built', `${c.boardId} built (${build?.status})`);
  if (build?.status !== 'built') {
    simulationController.stop();
    continue;
  }
  check(
    build.result?.firmware?.format === c.format,
    `producing a ${c.format} (${build.result?.firmware?.format})`,
  );
  check(
    build.result?.boardId === c.boardId,
    `stamped with this board rather than the build target (${build.result?.boardId})`,
  );

  const started = await simulationController.start();
  check(started, 'and it starts');
  if (started) {
    simulationController.pause();
    const runner = simulationController.runnerFor(instance.id);
    check(runner !== undefined, 'with a runner of its own');
    simulationController.advance(300);
    check(runner?.isOutput(c.pad) === true, `the firmware made pad ${c.pad} an output`);
    let sawHigh = false;
    let sawLow = false;
    for (let i = 0; i < 120 && !(sawHigh && sawLow); i++) {
      simulationController.advance(10);
      const level = runner?.digitalPinLevel(c.pad);
      if (level === 'high') sawHigh = true;
      if (level === 'low') sawLow = true;
    }
    check(sawHigh && sawLow, `and pad ${c.pad} — the pin labelled ${c.pinId} — toggles (high=${sawHigh} low=${sawLow})`);
  }
  simulationController.stop();
}

section(`${failures} failing, ${skipped} skipped`);
process.exit(failures > 0 ? 1 : 0);
