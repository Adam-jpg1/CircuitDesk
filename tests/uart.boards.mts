// Every board CircuitDesk simulates hears a part wired to its UART pads.
//
// A NEO-6M GPS on the canvas, powered from the board and wired TX to RX, is
// the test: compiled firmware reads the board's hardware UART and reports the
// latitude it parsed out of a $GPRMC sentence. Nothing in the sketch is
// simulator-specific, so if the bytes did not travel through the board's own
// UART peripheral, it prints nothing.
//
// On boards whose Serial is native USB (Leonardo, Pico, XIAO RP2040 and the
// SAMD21 boards), the UART is Serial1 and the sketch also watches Serial: a
// sentence that arrived there would be the simulator delivering a wire to the
// USB cable, which no board does.

import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { BOARDS_WITH_UART } from '../src/simulation/circuitSim';
import { BOARD_DEFINITIONS } from '../src/boards/definitions';
import { emptyProject } from '../src/project/templates';
import type { CircuitProject, ComponentInstance } from '../src/types';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

let seq = 0;
const uid = (p: string) => `${p}${++seq}`;
const inst = (definitionId: string, properties: Record<string, unknown> = {}): ComponentInstance => ({
  id: uid('c'), definitionId, x: 0, y: 0, rotation: 0, properties, simulationState: {},
});
function wire(p: CircuitProject, a: string, ap: string, b: string, bp: string) {
  p.connections.push({
    id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
    netId: '', color: '#000', points: [], routing: 'smooth',
  } as CircuitProject['connections'][number]);
}

/** Boards whose Serial is a USB port, so the UART is Serial1. */
const USB_CONSOLE = new Set([
  'board.arduino-leonardo',
  'board.arduino-uno-r4',
  'board.nano-33-ble',
  'board.teensy41',
  'board.raspberry-pi-pico',
  'board.raspberry-pi-pico-w',
  'board.seeed-xiao-rp2040',
  'board.adafruit-feather',
  'board.adafruit-qtpy',
  'board.seeed-xiao',
]);

function sketchFor(port: string, usb: boolean): string {
  return [
    'char line[100];',
    'uint8_t n = 0;',
    'void setup() {',
    // One port at the GPS's rate; the USB console's rate means nothing.
    usb ? '  Serial.begin(115200);' : '',
    `  ${port}.begin(9600);`,
    '}',
    'void loop() {',
    `  while (${port}.available()) {`,
    `    char c = ${port}.read();`,
    '    if (c == 0x0A) {',
    '      line[n] = 0;',
    // Field 3 of an RMC is the latitude.
    '      if (n > 20 && line[0] == 0x24 && line[3] == 0x52 && line[4] == 0x4D && line[5] == 0x43) {',
    '        int field = 0; const char *p = line;',
    '        while (*p && field < 3) { if (*p == 0x2C) field++; p++; }',
    '        Serial.print("LAT "); for (int i = 0; i < 9 && p[i]; i++) Serial.print(p[i]); Serial.println();',
    '      }',
    '      n = 0;',
    '    } else if (n < 98 && c != 0x0D) {',
    '      line[n++] = c;',
    '    }',
    '  }',
    usb ? '  while (Serial.available()) { Serial.read(); Serial.println("LEAK"); }' : '',
    '}',
  ].join('\n');
}

/**
 * Boards whose only UART goes to an on-board USB bridge rather than to a pin:
 * Serial works, but there is nowhere on the board to wire a GPS. Each must
 * also bring out no pin claiming a UART capability.
 */
const NO_PIN_UART = new Set(['board.microbit']);

/**
 * Boards whose UART pins are real but whose runtime has no way to use them:
 * the Raspberry Pi headers run Python, and pyserial is not provided. They must
 * not be offered to UART parts either.
 */
const NO_UART_RUNTIME = new Set(['board.rpi-zero-gpio', 'board.rpi4-gpio']);
for (const id of NO_UART_RUNTIME) check(!BOARDS_WITH_UART.has(id), `${id} has no UART runtime, and no part is offered one`);

const simulated = BOARD_DEFINITIONS.filter((b) => b.supportLevel === 'simulated' && !NO_PIN_UART.has(b.id) && !NO_UART_RUNTIME.has(b.id));
check(
  simulated.every((b) => BOARDS_WITH_UART.has(b.id)),
  `every Simulated board is in BOARDS_WITH_UART (${simulated.filter((b) => !BOARDS_WITH_UART.has(b.id)).map((b) => b.id).join(', ') || 'all'})`,
);
for (const id of NO_PIN_UART) {
  const def = BOARD_DEFINITIONS.find((b) => b.id === id);
  check(
    !!def && !BOARDS_WITH_UART.has(id) && !def.pins.some((p) => p.capabilities.some((c) => c.startsWith('uart'))),
    `${id} brings out no UART, and no part is offered one`,
  );
}

/** Boards whose first UART pads are not Serial's: the DevKit lists RX2/TX2 (Serial2) first. */
const CONSOLE_PADS: Record<string, { rx: string; tx: string }> = { 'board.esp32-devkit': { rx: 'RX0', tx: 'TX0' } };

for (const def of simulated) {
  console.log(`\n--- ${def.id}`);
  const pads = CONSOLE_PADS[def.id];
  const tx = pads ? def.pins.find((p) => p.id === pads.tx) : def.pins.find((p) => p.capabilities.includes('uart-tx' as never));
  const rx = pads ? def.pins.find((p) => p.id === pads.rx) : def.pins.find((p) => p.capabilities.includes('uart-rx' as never));
  const power = def.pins.find((p) => p.type === 'power-3v3') ?? def.pins.find((p) => p.type === 'power-5v');
  const ground = def.pins.find((p) => p.type === 'ground');
  if (!tx || !rx || !power || !ground) {
    check(false, `${def.id} has UART pads, a supply and a ground to wire a GPS to`);
    continue;
  }
  const usb = USB_CONSOLE.has(def.id);
  const p = emptyProject(`gps-${def.id}`);
  const board = inst(def.id);
  const gps = inst('comp.gps', { latitude: 48.8584, longitude: 2.2945, satellites: 9, baud: 9600 });
  p.boardInstances.push(board);
  p.componentInstances.push(gps);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: sketchFor(usb ? 'Serial1' : 'Serial', usb), language: 'cpp' }];
  wire(p, board.id, power.id, gps.id, 'vcc');
  wire(p, board.id, ground.id, gps.id, 'gnd');
  wire(p, board.id, rx.id, gps.id, 'tx');
  wire(p, board.id, tx.id, gps.id, 'rx');

  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    console.log(`SKIP: ${def.id} did not build or start here (${report.builds.map((b) => b.detail).join('; ')})`);
    skipped++;
    continue;
  }
  simulationController.pause();
  simulationController.advance(3500);
  simulationController.publishNow();
  const text = useSimulationStore.getState().serialText ?? '';
  simulationController.stop();
  const lat = /LAT (\d+\.\d+)/.exec(text)?.[1];
  check(lat === '4851.5040', `firmware parsed the GPS's latitude off ${usb ? 'Serial1' : 'Serial'} on ${rx.id} (${lat ?? JSON.stringify(text.slice(-120))})`);
  if (usb) check(!text.includes('LEAK'), 'and nothing on the wire reached Serial, which is the USB port');
}

// The Mega's further UARTs. Each GPS is wired to one port's pins and the
// sketch reads that port: the latitude has to arrive there, and nothing on the
// other two ports or on Serial.
const MEGA_PORTS = [
  { port: 'Serial1', rx: 'D19', tx: 'D18' },
  { port: 'Serial2', rx: 'D17', tx: 'D16' },
  { port: 'Serial3', rx: 'D15', tx: 'D14' },
];
// And the ESP32 DevKit's Serial2, on the pads printed RX2/TX2 (UART2).
const EXTRA_PORTS = [
  ...MEGA_PORTS.map((m) => ({ ...m, board: 'board.arduino-mega2560', vcc: '5V', others: MEGA_PORTS.map((x) => x.port) })),
  { port: 'Serial2', rx: 'RX2', tx: 'TX2', board: 'board.esp32-devkit', vcc: '3V3', others: ['Serial2'] },
];
for (const { port, rx, tx, board: boardId, vcc, others: portsOnBoard } of EXTRA_PORTS) {
  console.log(`\n--- ${boardId} ${port}`);
  const p = emptyProject(`gps-${boardId}-${port}`);
  const board = inst(boardId);
  const gps = inst('comp.gps', { latitude: 48.8584, longitude: 2.2945, satellites: 9, baud: 9600 });
  p.boardInstances.push(board);
  p.componentInstances.push(gps);
  const others = ['Serial', ...portsOnBoard.filter((x) => x !== port)];
  const sketch = sketchFor(port, false).replace(
    `  ${port}.begin(9600);`,
    `  Serial.begin(9600);\n  ${port}.begin(9600);\n${others.filter((o) => o !== 'Serial').map((o) => `  ${o}.begin(9600);`).join('\n')}`,
  ).replace(
    /\n}$/,
    `\n${others.filter((o) => o !== 'Serial').map((o) => `  while (${o}.available()) { ${o}.read(); Serial.println("LEAK ${o}"); }`).join('\n')}\n}`,
  );
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: sketch, language: 'cpp' }];
  wire(p, board.id, vcc, gps.id, 'vcc');
  wire(p, board.id, 'GND1', gps.id, 'gnd');
  wire(p, board.id, rx, gps.id, 'tx');
  wire(p, board.id, tx, gps.id, 'rx');
  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    console.log(`SKIP: ${boardId} did not build or start here (${report.builds.map((b) => b.detail).join('; ')})`);
    skipped++;
    continue;
  }
  simulationController.pause();
  simulationController.advance(3500);
  simulationController.publishNow();
  const text = useSimulationStore.getState().serialText ?? '';
  simulationController.stop();
  const lat = /LAT (\d+\.\d+)/.exec(text)?.[1];
  check(lat === '4851.5040', `firmware parsed the GPS's latitude off ${port} on ${rx} (${lat ?? JSON.stringify(text.slice(-120))})`);
  check(!text.includes('LEAK'), `and the sentences reached ${port} only (${/LEAK \w+/.exec(text)?.[0] ?? 'no leak'})`);
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
