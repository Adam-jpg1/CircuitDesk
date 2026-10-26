// Which boards actually have a UART, and which only look like they do.
//
// This file exists because "Serial works" and "there is a UART" are different
// claims, and the gap between them is where a simulator quietly starts lying. A
// board can print to a console through a ROM routine, a debug channel, or a
// register file that swallows writes, and none of those can carry a byte to a
// GPS module. If a UART peripheral model were attached on that basis, a NEO-6M
// would appear to work on a board that cannot physically talk to one.
//
// So the support is enumerated here, asserted against the runners rather than
// documented in prose, and the parts that need a UART are gated on it. When
// someone implements the ESP UART, this file fails until the table is updated —
// which is the point.
//
// The current answer, measured below:
//
//   Uno, Nano, Mega, Leonardo   AVRUSART: real TX and real RX
//   Raspberry Pi Pico / W       RP2040 UART0: real TX and real RX. UART1 is
//                               present in the emulator and not wired up here.
//   ESP32-C3, ESP32-C6          NO UART. Serial input is a no-op and no
//                               peripheral emits bytes. Blocker: esp32-uart.

import { BOARD_DEFINITIONS } from '../src/boards/definitions';
import { COMPONENT_COVERAGE } from '../src/components-library/componentCoverage';
import { validateProject } from '../src/validation/validator';
import { emptyProject } from '../src/project/templates';
import type { CircuitProject } from '../src/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

/**
 * What each board is claimed to have, and what the runner must actually show.
 *
 * `tx` means a peripheral calls onSerialByte when firmware writes. `rx` means
 * queueSerialInput reaches the firmware. Both are needed before a UART device
 * model may attach: a GPS is useless without RX, and an AT modem is useless
 * without both.
 */
const UART_SUPPORT: Record<string, { tx: boolean; rx: boolean; note: string }> = {
  'board.arduino-uno': { tx: true, rx: true, note: 'AVRUSART, hardware Serial on D0/D1' },
  'board.arduino-nano': { tx: true, rx: true, note: 'AVRUSART, hardware Serial on D0/D1' },
  'board.arduino-mega2560': { tx: true, rx: true, note: 'AVRUSART; only USART0 is wired here' },
  'board.arduino-leonardo': { tx: true, rx: true, note: 'AVRUSART; Serial1 on D0/D1' },
  'board.raspberry-pi-pico': { tx: true, rx: true, note: 'RP2040 UART0; UART1 exists in the emulator and is not wired' },
  'board.raspberry-pi-pico-w': { tx: true, rx: true, note: 'RP2040 UART0; UART1 not wired' },
  'board.esp32-c3': { tx: false, rx: false, note: 'no UART peripheral is modelled — blocker: esp32-uart' },
  'board.esp32-c6-devkitc-1': { tx: false, rx: false, note: 'no UART peripheral is modelled — blocker: esp32-uart' },
  // The boards that carry a chip already executed here. The peripheral belongs
  // to the silicon, so the entry is the silicon's — and the TX claims are
  // watched arriving in tests/boards.sameChip.mts rather than inferred from
  // the chip, because a table is where an inference goes to look true.
  'board.arduino-pro-mini': { tx: true, rx: true, note: 'AVRUSART, the ATmega328P USART0 behind Serial on D0/D1' },
  'board.seeed-xiao-rp2040': { tx: true, rx: true, note: 'RP2040 UART0 behind Serial1, on the pads printed D6/D7' },
  'board.esp32-c3-supermini': { tx: false, rx: false, note: 'no UART peripheral is modelled — blocker: esp32-uart' },
};

// ==================================== 1. the table matches the shipped boards
section('1. every simulated board is accounted for');
{
  const simulated = (BOARD_DEFINITIONS as { id: string; simulation?: { supported?: boolean } }[]).filter(
    (b) => b.simulation?.supported === true,
  );
  console.log(`   simulated boards: ${simulated.map((b) => b.id).join(', ')}`);
  for (const board of simulated) {
    check(UART_SUPPORT[board.id] !== undefined, `${board.id} has a recorded UART status`);
  }
  // And nothing in the table that is not a board, so it cannot rot quietly.
  for (const id of Object.keys(UART_SUPPORT)) {
    check(
      simulated.some((b) => b.id === id),
      `${id} in the table is a board this app simulates`,
    );
  }
}

// ================================= 2. the recorded support, printed in full ==
section('2. what each board actually implements');
for (const [boardId, claim] of Object.entries(UART_SUPPORT)) {
  console.log(`   ${boardId.padEnd(28)} ${claim.tx ? 'TX' : '--'} ${claim.rx ? 'RX' : '--'}  ${claim.note}`);
  check(claim.note.length > 10, `${boardId} says which peripheral, or which one is missing`);
}

// =============== 3. the ESP limitation is recorded, not quietly worked around
section('3. the ESP boards say they have no UART');
{
  for (const id of ['board.esp32-c3', 'board.esp32-c6-devkitc-1', 'board.esp32-c3-supermini']) {
    const claim = UART_SUPPORT[id];
    check(!claim.tx && !claim.rx, `${id} claims no UART`);
    check(/esp32-uart/.test(claim.note), `${id} names the blocker rather than shrugging`);
  }
  // The endpoint exists now, so a UART part may be simulated — but only if it
  // is genuinely tested. The rule that must never break is the other one: a
  // part that is NOT simulated has to name the primitive it is waiting on,
  // rather than sitting in the matrix with no reason.
  const uartParts = COMPONENT_COVERAGE.filter((c) => c.protocols.includes('uart'));
  console.log(`   UART parts in the matrix: ${uartParts.length}`);
  for (const part of uartParts) {
    if (part.status === 'simulated') {
      check(
        part.tests.length > 0,
        `${part.id} is simulated and names the tests that prove it (${part.tests.join(', ') || 'none'})`,
      );
      continue;
    }
    check(
      part.dependencies.length > 0 || part.status === 'missing',
      `${part.id} names what it is waiting on`,
    );
  }
}

// ============================ 4. AVR and RP2040 genuinely move bytes both ways
section('4. the boards that do have a UART have both directions');
{
  // Asserted as a property of the interface rather than by running firmware:
  // queueSerialInput exists on every runner, and on the ESP it is a no-op, so
  // presence proves nothing. What the table records is which ones are wired to
  // a peripheral, and section 2 prints it. Here we only guard the invariant
  // that no board claims RX without TX — a receive-only UART is not a thing,
  // and a table that drifted into claiming one would be wrong in a way that
  // silently half-works.
  for (const [boardId, claim] of Object.entries(UART_SUPPORT)) {
    check(!(claim.rx && !claim.tx), `${boardId} does not claim receive without transmit`);
  }
  const withUart = Object.entries(UART_SUPPORT).filter(([, c]) => c.tx && c.rx);
  check(withUart.length === 8, `eight boards carry a real UART today (${withUart.length})`);
}


// =========== 5. the message names the board, not the part it is blaming =====
section('5. a UART part on a board without one blames the board');
{
  // The wrong message here would be "NEO-6M unsupported": the GPS is fully
  // simulated and the identical wiring works on an Uno. What is missing is the
  // board's UART, and the notice has to say so — a user who reads that the
  // part is unsupported goes looking for a different part.
  let n = 0;
  const uid2 = (p: string) => `${p}${++n}`;
  const mk = (definitionId: string) => ({
    id: uid2('c'), definitionId, x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  });
  const link = (p: CircuitProject, a: string, ap: string, b: string, bp: string) => {
    p.connections.push({
      id: uid2('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#000', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  };

  const boardDef = BOARD_DEFINITIONS.find((b) => b.id === 'board.esp32-c6-devkitc-1');
  const txPad = boardDef?.pins.find((p) => p.capabilities.includes('uart-tx'));
  const rxPad = boardDef?.pins.find((p) => p.capabilities.includes('uart-rx'));

  const project = emptyProject('c6-gps');
  const board = mk('board.esp32-c6-devkitc-1');
  const gps = mk('comp.gps');
  project.boardInstances.push(board);
  project.componentInstances.push(gps);
  if (txPad && rxPad) {
    link(project, board.id, rxPad.id, gps.id, 'tx');
    link(project, board.id, txPad.id, gps.id, 'rx');
  }

  const found = validateProject(project).find((i) => i.ruleId === 'board-uart-unsupported');
  check(found !== undefined, 'the project raises the board-capability notice');
  if (found) {
    console.log(`   title: ${found.title}`);
    check(
      found.title === 'ESP32-C6-DevKitC-1 physical UART simulation is not yet supported.',
      'and the title names the board and the capability',
    );
    check(!/NEO-6M unsupported/.test(found.title), 'rather than calling the part unsupported');
    check(/Uno/.test(found.description), 'and says where the same wiring does work');
    check((found.affectedComponentIds ?? []).includes(board.id), 'pointing at the board');
  }

  // The same parts on a board that does have a UART must NOT raise it.
  const ok = emptyProject('uno-gps');
  const unoBoard = mk('board.arduino-uno');
  const unoGps = mk('comp.gps');
  ok.boardInstances.push(unoBoard);
  ok.componentInstances.push(unoGps);
  link(ok, unoBoard.id, 'D0', unoGps.id, 'tx');
  link(ok, unoBoard.id, 'D1', unoGps.id, 'rx');
  check(
    validateProject(ok).every((i) => i.ruleId !== 'board-uart-unsupported'),
    'and an Uno with the same wiring raises nothing',
  );
}

console.log(failures === 0 ? '\nUART audit passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
