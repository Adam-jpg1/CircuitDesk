// Five boards nobody added, across three architectures, each one built and run.
//
// The RP2040 acceptance test proved the premise once. This proves it is not a
// property of the RP2040: an ATmega328P board, an ATmega2560 board, an
// ATmega32U4 board, an ESP32-C3 board and an ESP32-C6 board, none of them a
// product CircuitDesk ships, all of them compiled by the real toolchain for
// their own processor and executed on the runtime that matches it.
//
// Every board here is deliberately unlike the native board carrying the same
// chip. Different name, different maker, different outline, different pin
// count, and — the part that actually matters — different PIN NAMES. Not one
// of them has a pin called D13. The firmware still says 13, because firmware is
// written against the core's numbering, and the pin that moves is the one the
// maker labelled. Both are true simultaneously; keeping them attached is the
// whole mechanism.
//
// The sixth board has no processor at all. It exists to prove the honest
// failure: it wires, it validates, and it says plainly that it does not run.
//
// Skips cleanly per board when a toolchain is unavailable rather than
// pretending a board passed.

import { simulationController } from '../src/simulation/simulationController';
import { emptyProject } from '../src/project/templates';
import { normalizeProject } from '../src/project/projectService';
import { embedBoard } from '../src/custom-boards/projectBoards';
import { validateCustomBoard, isError } from '../src/custom-boards/validate';
import { resolveCustomBoard, capabilitySummary } from '../src/custom-boards/resolve';
import { resolveDefinition } from '../src/project/partsRegistry';
import { resolveWorkspaceTargets } from '../src/compiler/targets';
import { runnerPinIndex, runnerPinCount } from '../src/simulation/boardRunner';
import { CUSTOM_BOARD_SCHEMA_VERSION, type CustomBoardDefinition, type CustomBoardPin } from '../src/custom-boards/schema';
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

const pin = (
  id: string, label: string, pad: string | null, index: number,
  type: CustomBoardPin['type'] = 'digital',
): CustomBoardPin => ({
  id, label, pad, xMm: 3, yMm: 4 + index * 4, type, capabilities: [],
  ...(type === 'power-5v' ? { voltage: 5 } : type === 'power-3v3' ? { voltage: 3.3 } : {}),
});

interface Acceptance {
  /** The board a user brought. */
  board: CustomBoardDefinition;
  /** The firmware they wrote, against the core's numbering. */
  sketch: string;
  /** The pin the maker labelled, which must be the pin that moves. */
  drivenPin: string;
  /** The core pin number the sketch drives — what `drivenPin` has to resolve to. */
  drivenIndex: number;
  processorName: string;
  artifactFormat: string;
}

/** A blink written against a core pin number, as firmware is. */
const blink = (n: number) => [
  'void setup() {',
  `  pinMode(${n}, OUTPUT);`,
  '}',
  'void loop() {',
  `  digitalWrite(${n}, HIGH);`,
  '  delay(30);',
  `  digitalWrite(${n}, LOW);`,
  '  delay(30);',
  '}',
].join('\n');

const CASES: Acceptance[] = [
  {
    // An ATmega328P board that is not an Uno and not a Nano.
    board: {
      schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
      id: 'custom.weather-node',
      revision: 1,
      identity: { name: 'Weather Station Node', creator: 'Fieldwork Instruments' },
      outline: { widthMm: 28, heightMm: 44, color: '#2f4f3f' },
      pins: [
        pin('VBAT', 'VBAT', null, 0, 'power-5v'),
        pin('GND', 'GND', null, 1, 'ground'),
        pin('BEACON', 'BEACON', 'PB5', 2),
        pin('RAIN', 'RAIN', 'PC0', 3, 'analog'),
        pin('BUS_DATA', 'BUS_DATA', 'PC4', 4),
        pin('BUS_CLK', 'BUS_CLK', 'PC5', 5),
        pin('HEATER', 'HEATER', 'PD6', 6),
        pin('LINK_TX', 'LINK_TX', 'PD1', 7),
        pin('LINK_RX', 'LINK_RX', 'PD0', 8),
      ],
      processorProfileId: 'proc.atmega328p',
      compileProfileId: 'compile.avr-arduino',
      runtimeProfileId: 'runtime.avr8js-328p',
    },
    sketch: blink(13), // PB5 is core pin 13 in the Uno numbering this builds with
    drivenPin: 'BEACON',
    drivenIndex: 13,
    processorName: 'ATmega328P',
    artifactFormat: 'intel-hex',
  },
  {
    // An ATmega2560 board that is not a Mega.
    board: {
      schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
      id: 'custom.gantry-controller',
      revision: 1,
      identity: { name: 'Gantry Controller', creator: 'Fieldwork Instruments' },
      outline: { widthMm: 70, heightMm: 90, color: '#3b2f4f' },
      pins: [
        pin('V5', '5V', null, 0, 'power-5v'),
        pin('GND', 'GND', null, 1, 'ground'),
        pin('SPINDLE', 'SPINDLE', 'PB7', 2),
        pin('LIMIT_X', 'LIMIT_X', 'PE4', 3),
        pin('LIMIT_Y', 'LIMIT_Y', 'PE5', 4),
        pin('PROBE', 'PROBE', 'PF0', 5, 'analog'),
        pin('BUS_DATA', 'BUS_DATA', 'PD1', 6),
        pin('BUS_CLK', 'BUS_CLK', 'PD0', 7),
      ],
      processorProfileId: 'proc.atmega2560',
      compileProfileId: 'compile.avr-arduino-mega',
      runtimeProfileId: 'runtime.avr8js-2560',
    },
    sketch: blink(13), // PB7 is core pin 13 on the mega variant
    drivenPin: 'SPINDLE',
    drivenIndex: 13,
    processorName: 'ATmega2560',
    artifactFormat: 'intel-hex',
  },
  {
    // An ATmega32U4 board that is not a Leonardo.
    board: {
      schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
      id: 'custom.macro-pad',
      revision: 1,
      identity: { name: 'Studio Macro Pad', creator: 'Fieldwork Instruments' },
      outline: { widthMm: 60, heightMm: 40, color: '#4f3b2f' },
      pins: [
        pin('V5', '5V', null, 0, 'power-5v'),
        pin('GND', 'GND', null, 1, 'ground'),
        pin('BACKLIGHT', 'BACKLIGHT', 'PC7', 2),
        pin('KEY1', 'KEY1', 'PB4', 3),
        pin('KEY2', 'KEY2', 'PB5', 4),
        pin('BUS_DATA', 'BUS_DATA', 'PD1', 5),
        pin('BUS_CLK', 'BUS_CLK', 'PD0', 6),
      ],
      processorProfileId: 'proc.atmega32u4',
      compileProfileId: 'compile.avr-arduino-32u4',
      runtimeProfileId: 'runtime.avr8js-32u4',
    },
    sketch: blink(13), // PC7 is core pin 13 on the leonardo variant
    drivenPin: 'BACKLIGHT',
    drivenIndex: 13,
    processorName: 'ATmega32U4',
    artifactFormat: 'intel-hex',
  },
  {
    // An ESP32-C3 board that is not a DevKitM.
    board: {
      schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
      id: 'custom.shelf-tag',
      revision: 1,
      identity: { name: 'Shelf Tag C3', creator: 'Fieldwork Instruments' },
      outline: { widthMm: 24, heightMm: 36, color: '#2f3f4f' },
      pins: [
        pin('V3', '3V3', null, 0, 'power-3v3'),
        pin('GND', 'GND', null, 1, 'ground'),
        pin('INK_BUSY', 'INK_BUSY', 'IO8', 2),
        pin('INK_DC', 'INK_DC', 'IO7', 3),
        pin('BUS_DATA', 'BUS_DATA', 'IO4', 4),
        pin('BUS_CLK', 'BUS_CLK', 'IO5', 5),
      ],
      processorProfileId: 'proc.esp32c3',
      compileProfileId: 'compile.esp32c3-arduino',
      runtimeProfileId: 'runtime.esp32c3',
    },
    sketch: blink(8),
    drivenPin: 'INK_BUSY',
    drivenIndex: 8,
    processorName: 'ESP32-C3',
    artifactFormat: 'esp-image',
  },
  {
    // An ESP32-C6 board that is not a DevKitC.
    board: {
      schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
      id: 'custom.mesh-relay',
      revision: 1,
      identity: { name: 'Mesh Relay C6', creator: 'Fieldwork Instruments' },
      outline: { widthMm: 26, heightMm: 40, color: '#4f2f3f' },
      pins: [
        pin('V3', '3V3', null, 0, 'power-3v3'),
        pin('GND', 'GND', null, 1, 'ground'),
        pin('LINK_LED', 'LINK_LED', 'IO15', 2),
        pin('RELAY_A', 'RELAY_A', 'IO18', 3),
        pin('BUS_DATA', 'BUS_DATA', 'IO23', 4),
        pin('BUS_CLK', 'BUS_CLK', 'IO22', 5),
      ],
      processorProfileId: 'proc.esp32c6',
      compileProfileId: 'compile.esp32c6-arduino',
      runtimeProfileId: 'runtime.esp32c6',
    },
    sketch: blink(15),
    drivenPin: 'LINK_LED',
    drivenIndex: 15,
    processorName: 'ESP32-C6',
    artifactFormat: 'esp-image',
  },
];

function projectFor(c: Acceptance): { project: CircuitProject; instance: ComponentInstance } {
  const project = emptyProject(c.board.identity.name);
  embedBoard(project, c.board);
  const instance: ComponentInstance = {
    id: 'board1', definitionId: c.board.id, x: 40, y: 40, rotation: 0, properties: {}, simulationState: {},
  };
  project.boardInstances.push(instance);
  project.codeFiles = [{ id: 'f1', name: 'sketch.ino', content: c.sketch, language: 'cpp' }];
  return { project, instance };
}

// ========================================================= the matrix ========

for (const c of CASES) {
  section(`${c.board.identity.name} — a custom ${c.processorName}`);

  // 1. It is a valid board, and it is its own board.
  const { problems, board: validated } = validateCustomBoard(c.board);
  check(
    problems.filter(isError).length === 0,
    `accepted as a board${problems.filter(isError).map((p) => ` — ${p.message}`).join('')}`,
  );
  if (!validated) continue;

  const { board: resolved } = resolveCustomBoard(validated);
  check(resolved.processor === c.processorName, `its processor is the ${c.processorName} (${resolved.processor})`);
  check(
    resolved.pins.every((p) => !/^D\d+$/.test(p.id) && !/^A\d+$/.test(p.id)),
    'and not one of its pins is named the way the core numbers them',
  );
  check(resolved.supportLevel === 'simulated', `it is simulated, derived not typed (${resolved.supportLevel})`);

  // 2. The pin the maker labelled resolves to the pad the firmware drives.
  //    This is the join the whole milestone rests on.
  const index = runnerPinIndex(resolved, c.drivenPin);
  check(
    index === c.drivenIndex,
    `${c.drivenPin} reaches core pin ${c.drivenIndex} through pad ${c.board.pins.find((p) => p.id === c.drivenPin)?.pad} (got ${index})`,
  );
  check(runnerPinCount(resolved) > 0, `and the runtime knows how many pins this chip has (${runnerPinCount(resolved)})`);

  // 3. It compiles through the pipeline it chose, as itself.
  const { project, instance } = projectFor(c);
  const { targets, unbuildable } = resolveWorkspaceTargets(project);
  check(unbuildable.length === 0, `it is buildable${unbuildable.map((u) => ` — ${u.reason}`).join('')}`);
  check(targets[0]?.boardId === c.board.id, 'the build belongs to the custom board');
  check(
    targets[0]?.serverBoardId !== c.board.id,
    `while the service is asked for its own allowed target (${targets[0]?.serverBoardId})`,
  );

  simulationController.stop();
  const report = await simulationController.build(project);
  const build = report.builds[0];
  console.log(`   build: ${build?.detail}`);

  if (!report.anyRunnable) {
    skip(`the ${c.processorName} toolchain is unavailable here — not claiming this board passed`);
    continue;
  }

  check(build?.status === 'built', `it built (${build?.status})`);
  check(build?.boardName === c.board.identity.name, `reported under its own name (${build?.boardName})`);
  check(
    build?.result?.boardId === c.board.id,
    `and the artifact is stamped with the custom board (${build?.result?.boardId})`,
  );
  check(
    build?.result?.firmware?.format === c.artifactFormat,
    `producing ${c.artifactFormat} (${build?.result?.firmware?.format})`,
  );

  // 4. It runs, and the pin the user sees is the pin that moves.
  const started = await simulationController.start();
  check(started, 'it starts');
  if (started) {
    simulationController.pause();
    const runner = simulationController.runnerFor(instance.id);
    check(runner !== undefined, 'with a runner of its own');
    simulationController.advance(400);
    check(runner?.isOutput(c.drivenIndex) === true, `the firmware made pin ${c.drivenIndex} an output`);
    let high = false;
    let low = false;
    for (let i = 0; i < 80 && !(high && low); i++) {
      simulationController.advance(10);
      const level = runner?.digitalPinLevel(c.drivenIndex);
      if (level === 'high') high = true;
      if (level === 'low') low = true;
    }
    check(high && low, `and ${c.drivenPin} toggles (high=${high} low=${low})`);
  }
  simulationController.stop();

  // 5. It survives being saved and opened somewhere else.
  const reopened = normalizeProject(JSON.parse(JSON.stringify(project)));
  const def = resolveDefinition(c.board.id, reopened);
  check(def?.name === c.board.identity.name, 'and it reopens from the saved project with nothing installed');
  check(
    runnerPinIndex(def!, c.drivenPin) === c.drivenIndex,
    'with the pad mapping intact after the round trip',
  );
}

// ================================ the board that honestly does nothing =======
section('A board with no processor says so, and is still useful');
{
  const BREAKOUT: CustomBoardDefinition = {
    schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
    id: 'custom.sensor-breakout',
    revision: 1,
    identity: {
      name: 'Thermocouple Breakout',
      creator: 'Fieldwork Instruments',
      description: 'A passive breakout. There is no chip on it to run anything.',
    },
    outline: { widthMm: 20, heightMm: 16, color: '#5a4a2a' },
    pins: [
      pin('V3', '3V3', null, 0, 'power-3v3'),
      pin('GND', 'GND', null, 1, 'ground'),
      pin('SO', 'SO', null, 2),
      pin('CS', 'CS', null, 3),
      pin('SCK', 'SCK', null, 4),
    ],
    processorProfileId: null,
    compileProfileId: 'compile.none',
    runtimeProfileId: 'runtime.none',
  };

  const { problems, board } = validateCustomBoard(BREAKOUT);
  check(problems.filter(isError).length === 0, 'a processor-less board is a legal board');
  const { board: resolved } = resolveCustomBoard(board!);
  check(resolved.supportLevel === 'wiring', `it is wiring-only (${resolved.supportLevel})`);
  check(resolved.compiler?.supported === false, 'nothing compiles for it');
  check(resolved.simulation?.supported === false, 'and nothing runs on it');
  check(
    resolved.simulation?.supportedApis.length === 0,
    'it claims no APIs, because a board cannot claim what no runtime gives it',
  );

  const summary = capabilitySummary(board!);
  check(summary.processor === 'None (wiring only)', `the summary says so plainly (${summary.processor})`);
  check(
    summary.notSimulated.some((s) => s.includes('no processor')),
    `and says why (${summary.notSimulated.join('; ')})`,
  );

  // It must not be quietly built for somebody else's chip.
  const project = emptyProject('breakout');
  embedBoard(project, board!);
  project.boardInstances.push({
    id: 'b1', definitionId: BREAKOUT.id, x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  } as ComponentInstance);
  const { targets, unbuildable } = resolveWorkspaceTargets(project);
  check(targets.length === 0, `no build is attempted (${targets.length})`);
  check(unbuildable.length === 1, 'and the reason is reported rather than swallowed');
  check(
    !JSON.stringify(unbuildable).includes('uno') && !JSON.stringify(unbuildable).includes('pico'),
    `with no other board's identity anywhere near it (${unbuildable[0]?.reason})`,
  );
}

// ================== a board that asks for a variant of its own chip =========
section('A board may ask for another target of the same chip, and gets it');
{
  const WIFI: CustomBoardDefinition = {
    schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
    id: 'custom.wifi-rover',
    revision: 1,
    identity: { name: 'WiFi Rover', creator: 'Fieldwork Instruments' },
    outline: { widthMm: 30, heightMm: 44, color: '#123f5e' },
    pins: [
      pin('V3', '3V3', null, 0, 'power-3v3'),
      pin('GND', 'GND', null, 1, 'ground'),
      pin('LAMP', 'LAMP', 'GP15', 2),
    ],
    processorProfileId: 'proc.rp2040',
    compileProfileId: 'compile.rp2040-arduino',
    runtimeProfileId: 'runtime.rp2040js',
    // The Pico W variant: same RP2040, different variant header. A real need,
    // and the only shape of override that is allowed.
    fqbnOverride: 'rp2040:rp2040:rpipicow',
  };

  const { problems, board } = validateCustomBoard(WIFI);
  check(problems.filter(isError).length === 0, `a declared alternate target is accepted${problems.filter(isError).map((p) => ` — ${p.message}`).join('')}`);

  const rejected = validateCustomBoard({ ...WIFI, fqbnOverride: 'arduino:avr:uno' });
  check(
    rejected.problems.some((p) => p.code === 'fqbn-not-in-profile'),
    'while a target from another chip is refused before it can be sent anywhere',
  );

  const project = emptyProject('wifi rover');
  embedBoard(project, board!);
  const instance: ComponentInstance = {
    id: 'board1', definitionId: WIFI.id, x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  project.boardInstances.push(instance);
  project.codeFiles = [{ id: 'f1', name: 'sketch.ino', content: blink(15), language: 'cpp' }];

  const { targets } = resolveWorkspaceTargets(project);
  check(targets[0]?.fqbn === 'rp2040:rp2040:rpipicow', `the build asks for the variant (${targets[0]?.fqbn})`);
  check(
    targets[0]?.serverBoardId === 'board.raspberry-pi-pico',
    'through the allowlisted target, which is still what the service is asked for',
  );

  simulationController.stop();
  const report = await simulationController.build(project);
  console.log(`   build: ${report.builds[0]?.detail}`);
  if (!report.anyRunnable) {
    skip('the RP2040 toolchain is unavailable here');
  } else {
    check(report.builds[0]?.status === 'built', `and the service really builds it as that variant (${report.builds[0]?.status})`);
  }
  simulationController.stop();
}

console.log(
  failures === 0
    ? `\nCustom-board acceptance passed${skipped ? ` (${skipped} skipped)` : ''}.`
    : `\n${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
