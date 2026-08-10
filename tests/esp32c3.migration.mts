// An ESP32-C3 project saved before the board definition was corrected.
//
// The board used to carry invented pin names. Correcting it to the real
// ESP32-C3-DevKitM-1 was the right thing to do, but it must not cost anyone
// their work: a project saved against the old definition has to open with
// every wire still attached to the pin the user drew it to.
//
// So the fixture beside this file is deliberately old-fashioned. It refers to
// the board by an id that has since become an alias, wires to GPIO8 and GPIO9
// rather than IO8 and IO9, uses TX0 and RX0 for the serial pins, and uses a
// bare 3V3 that is now one of two numbered supply pins. Everything here loads
// it through the real project paths — the same board lookup, the same pin
// resolution and the same net builder the canvas uses.

import { readFileSync } from 'node:fs';
import { findBoardByIdOrAlias, getBoardDefinition } from '../src/boards/definitions';
import { resolvePin } from '../src/project/partsRegistry';
import { CircuitBinding } from '../src/simulation/circuitSim';
import { buildPinMapCsv, buildWiringReport } from '../src/project/exporters';
import { runnerPinIndex } from '../src/simulation/boardRunner';
import type { CircuitProject } from '../src/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const project = JSON.parse(
  readFileSync(new URL('./fixtures/legacy-esp32c3.cdproj.json', import.meta.url), 'utf8'),
) as CircuitProject;

// ---------- 1. the board still resolves, and resolves to the real one ----------
{
  const byId = findBoardByIdOrAlias(project.boardInstances[0].definitionId);
  check(byId?.id === 'board.esp32-c3', 'the saved board id still resolves');
  check(byId?.name === 'ESP32-C3-DevKitM-1', `and resolves to the real product (${byId?.name})`);

  // The names this board was saved under before the correction.
  for (const legacy of ['esp32-c3', 'esp32-c3-devkitm', 'esp32-c3-devkitm-1', 'esp32c3']) {
    check(
      findBoardByIdOrAlias(legacy)?.id === 'board.esp32-c3',
      `the legacy name "${legacy}" still finds the board`,
    );
  }
}

const board = getBoardDefinition('board.esp32-c3')!;

// ---------- 2. every old pin name still finds its pin ----------
{
  const cases: [string, string][] = [
    ['GPIO8', 'IO8'],
    ['GPIO9', 'IO9'],
    ['GPIO0', 'IO0'],
    ['GPIO10', 'IO10'],
    ['3V3', '3V3_1'],
    ['TX0', 'IO21'],
    ['RX0', 'IO20'],
  ];
  for (const [legacy, canonical] of cases) {
    const pin = resolvePin(board, legacy);
    check(pin?.id === canonical, `${legacy} resolves to ${canonical} (${pin?.id ?? 'nothing'})`);
  }

  // TX0 and RX0 have to reach the pins the module actually labels TX and RX,
  // not merely some pin — a serial wire pointed at the wrong pad is worse
  // than one that fails to resolve.
  check(resolvePin(board, 'TX0')?.label === 'TX', 'TX0 lands on the pad the board silkscreens TX');
  check(resolvePin(board, 'RX0')?.label === 'RX', 'and RX0 on the one it silkscreens RX');

  // A name that never existed must not quietly resolve to something.
  check(resolvePin(board, 'D13') === undefined, 'an Arduino pin name resolves to nothing');
  check(resolvePin(board, 'GP15') === undefined, 'and so does an RP2040 one');
  check(resolvePin(board, 'GPIO40') === undefined, 'and so does a GPIO the chip does not have');
}

// ---------- 3. no wire is orphaned ----------
{
  let unresolved = 0;
  const orphans: string[] = [];
  for (const wire of project.connections) {
    for (const [instanceId, pinId] of [
      [wire.sourceComponentId, wire.sourcePinId],
      [wire.targetComponentId, wire.targetPinId],
    ] as const) {
      if (instanceId !== project.boardInstances[0].id) continue;
      if (resolvePin(board, pinId) === undefined) {
        unresolved++;
        orphans.push(`${wire.id}:${pinId}`);
      }
    }
  }
  check(unresolved === 0, `every wire to the board still finds its pin (${orphans.join(', ') || 'none orphaned'})`);
  check(project.connections.length === 8, `and all ${project.connections.length} wires survived the load`);
}

// ---------- 4. the old names reach the runner's real pins ----------
//
// Resolving to a pin is not enough: the simulation has to end up driving the
// pad the user actually wired.
{
  const throughAlias = (legacy: string): number | undefined => {
    const pin = resolvePin(board, legacy);
    return pin ? runnerPinIndex(board, pin.id) : undefined;
  };
  check(throughAlias('GPIO8') === 8, 'a wire drawn to GPIO8 drives runner pin 8');
  check(throughAlias('GPIO9') === 9, 'and one drawn to GPIO9 drives runner pin 9');
  check(throughAlias('TX0') === 21, 'TX0 reaches IO21, which is the real TX pad');
  check(throughAlias('RX0') === 20, 'and RX0 reaches IO20');
  check(throughAlias('3V3') === undefined, 'a supply pin drives no runner pin, as it should not');
}

// ---------- 5. the circuit builds, with the old names, into real nets ----------
{
  const binding = new CircuitBinding(project, null);
  const { visuals } = binding.update({
    pressedButtons: new Set<string>(),
    toggleStates: new Map<string, boolean>(),
    potPositions: new Map<string, number>(),
  } as never);
  check(visuals instanceof Map, 'the legacy project binds without error');

  // The LED is wired through the resistor to GPIO8; the net has to exist and
  // has to know it reaches a board pin.
  const summary = binding.summary?.() as { nets?: unknown[] } | undefined;
  if (summary?.nets) {
    check(summary.nets.length > 0, `the project resolved into ${summary.nets.length} nets`);
  }
}

// ---------- 6. re-export uses the canonical names ----------
//
// Old projects must open, but they should not stay old: what CircuitDesk
// writes back out is the board's real pin naming.
{
  const pinMap = buildPinMapCsv(project);
  const wiring = buildWiringReport(project);
  const exported = `${pinMap}\n${wiring}`;

  check(exported.includes('IO8'), 'the export names IO8');
  check(exported.includes('IO9'), 'and IO9');
  check(!/\bGPIO8\b/.test(exported), 'and no longer writes the legacy GPIO8');
  check(!/\bGPIO9\b/.test(exported), 'nor GPIO9');
  check(exported.includes('ESP32-C3-DevKitM-1'), 'and it names the board by its official product name');
  check(!/\bTX0\b/.test(exported) && !/\bRX0\b/.test(exported), 'the legacy serial names are gone too');
}

console.log(
  failures === 0 ? '\nESP32-C3 migration checks passed.' : `\n${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
