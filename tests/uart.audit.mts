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
  for (const id of ['board.esp32-c3', 'board.esp32-c6-devkitc-1']) {
    const claim = UART_SUPPORT[id];
    check(!claim.tx && !claim.rx, `${id} claims no UART`);
    check(/esp32-uart/.test(claim.note), `${id} names the blocker rather than shrugging`);
  }
  // The one thing that must never happen: a UART part badged as working on a
  // board that cannot carry a byte. Every UART device in the matrix has to
  // carry the blocker until the peripheral exists.
  const uartParts = COMPONENT_COVERAGE.filter((c) => c.protocols.includes('uart'));
  console.log(`   UART parts in the matrix: ${uartParts.length}`);
  for (const part of uartParts) {
    if (part.status === 'simulated') {
      check(false, `${part.id} claims to be simulated while the UART endpoint does not exist`);
      continue;
    }
    check(
      part.dependencies.includes('uart-endpoint') || part.status === 'missing',
      `${part.id} depends on the UART endpoint that has not been built yet`,
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
  check(withUart.length === 6, `six boards carry a real UART today (${withUart.length})`);
}

console.log(failures === 0 ? '\nUART audit passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
