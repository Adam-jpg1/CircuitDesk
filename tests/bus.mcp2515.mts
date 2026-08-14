// The MCP2515: firmware, SPI, register file, wire, and back again.
//
// The bit-level arbitration is proved in bus.can.mts. What is proved here is
// that a sketch can reach it: the chip's own SPI command set, the mode machine
// that refuses to transmit from configuration mode, the bitrate computed from
// CNF1-3 rather than declared, and a frame that leaves board A's transmit
// buffer, crosses a real wire and arrives in board B's receive buffer with
// board B's own SPI reading it out.
//
// There is no CAN library in either sketch. Every SPI transaction is built by
// hand, so what is being exercised is the chip.

import {
  Mcp2515Device, MCP_REG, MCP_MODE, MCP_CMD, INT_RX0, INT_TX0, DEFAULT_CRYSTAL_HZ,
} from '../src/simulation/devices/mcp2515';
import { CanBus } from '../src/simulation/devices/canBus';
import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject } from '../src/project/templates';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import { COMPONENT_COVERAGE } from '../src/components-library/componentCoverage';
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
const defOf = (id: string) => COMPONENT_DEFINITIONS.find((d) => d.id === id);
const inst = (definitionId: string): ComponentInstance => ({
  id: uid('c'), definitionId, x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
});
function wire(p: CircuitProject, a: string, ap: string, b: string, bp: string) {
  p.connections.push({
    id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
    netId: '', color: '#000', points: [], routing: 'smooth',
  } as CircuitProject['connections'][number]);
}

function spi(d: Mcp2515Device, bytes: number[]): number[] {
  d.select(true);
  const out = bytes.map((b) => d.transfer(b) ?? 0);
  d.select(false);
  return out;
}
const write = (d: Mcp2515Device, reg: number, ...values: number[]) => spi(d, [MCP_CMD.WRITE, reg, ...values]);
const read = (d: Mcp2515Device, reg: number) => spi(d, [MCP_CMD.READ, reg, 0])[2];

/**
 * 500 kbit/s on a 16 MHz crystal, and these are the real library's values.
 *
 * BRP 0 makes a quantum 125 ns; CNF2 0xF0 is PropSeg 1 and PS1 7; CNF3 0x86 is
 * PS2 7. One sync quantum plus 1 + 7 + 7 is sixteen quanta to a bit, and
 * 8 MHz over sixteen is 500 kbit/s.
 */
const CNF_500K = { cnf1: 0x00, cnf2: 0xf0, cnf3: 0x86 };

function configure(d: Mcp2515Device, cnf = CNF_500K, mode: number = MCP_MODE.NORMAL): void {
  spi(d, [MCP_CMD.RESET]);
  write(d, MCP_REG.CANCTRL, MCP_MODE.CONFIG << 5);
  write(d, MCP_REG.CNF3, cnf.cnf3);
  write(d, MCP_REG.CNF2, cnf.cnf2);
  write(d, MCP_REG.CNF1, cnf.cnf1);
  write(d, MCP_REG.CANINTE, INT_RX0 | INT_TX0);
  write(d, MCP_REG.CANCTRL, mode << 5);
}

function loadAndSend(d: Mcp2515Device, id: number, data: number[]): void {
  write(d, MCP_REG.TXB0CTRL + 1, (id >> 3) & 0xff, (id & 0x07) << 5, 0, 0, data.length, ...data);
  spi(d, [MCP_CMD.RTS | 0x01]);
}

// ============================================ 1. the chip's own interface ====
section('1. the SPI command set and the mode machine');
{
  const bus = new CanBus('bus');
  const d = new Mcp2515Device('m', 'cs', bus);

  check(d.mode === MCP_MODE.CONFIG, 'the chip powers up in CONFIGURATION mode, as the datasheet says');
  check((read(d, MCP_REG.CANSTAT) >> 5) === MCP_MODE.CONFIG, 'and CANSTAT says so');

  write(d, MCP_REG.CNF1, 0x03);
  check(read(d, MCP_REG.CNF1) === 0x03, 'a written register reads back');

  // BIT MODIFY changes only the bits in its mask, which is how every library
  // sets a mode without disturbing the rest of CANCTRL.
  write(d, MCP_REG.CANCTRL, 0x00);
  spi(d, [MCP_CMD.BIT_MODIFY, MCP_REG.CANCTRL, 0xe0, MCP_MODE.LOOPBACK << 5]);
  check(d.mode === MCP_MODE.LOOPBACK, 'BIT MODIFY sets the mode');
  spi(d, [MCP_CMD.BIT_MODIFY, MCP_REG.CANCTRL, 0x04, 0x04]);
  check(d.mode === MCP_MODE.LOOPBACK, 'and leaves the bits outside its mask alone');
  check((read(d, MCP_REG.CANCTRL) & 0x04) === 0x04, 'while setting the ones inside it');

  // CANSTAT is read-only, and a write must not move the mode.
  write(d, MCP_REG.CANSTAT, 0x00);
  check(d.mode === MCP_MODE.LOOPBACK, 'CANSTAT is read-only');

  // A burst read walks the register file, which is how a library reads a
  // whole receive buffer in one transaction.
  write(d, MCP_REG.TXB0CTRL + 1, 0x11, 0x22, 0x33);
  const burst = spi(d, [MCP_CMD.READ, MCP_REG.TXB0CTRL + 1, 0, 0, 0]).slice(2);
  check(burst.join(',') === '17,34,51', `a burst read walks forward (${burst.join(',')})`);

  spi(d, [MCP_CMD.RESET]);
  check(d.mode === MCP_MODE.CONFIG, 'RESET puts it back in configuration mode');
  check(read(d, MCP_REG.CNF1) === 0, 'and clears the registers');
}

// ============================================ 2. the bitrate is computed =====
section('2. bit timing comes from CNF1-3, not from a property');
{
  const bus = new CanBus('bus');
  const d = new Mcp2515Device('m', 'cs', bus);
  check(d.crystalHz === DEFAULT_CRYSTAL_HZ, 'the crystal is the 16 MHz one every board uses');

  configure(d, CNF_500K);
  check(d.bitrate === 500_000, `CNF for 500 kbit/s gives 500 kbit/s (${d.bitrate})`);

  // Doubling the prescaler halves the bitrate. This is the calculation people
  // get wrong, and getting it wrong here has the same consequence it does on
  // a bench.
  configure(d, { ...CNF_500K, cnf1: 0x01 });
  check(d.bitrate === 250_000, `doubling BRP halves it (${d.bitrate})`);
  configure(d, { ...CNF_500K, cnf1: 0x03 });
  check(d.bitrate === 125_000, `and again (${d.bitrate})`);
}

// ================================= 3. configuration mode transmits nothing ===
section('3. a chip left in configuration mode sends nothing');
{
  const bus = new CanBus('bus');
  const a = new Mcp2515Device('a', 'cs', bus);
  const b = new Mcp2515Device('b', 'cs', bus);
  configure(a, CNF_500K, MCP_MODE.CONFIG); // deliberately never left config
  configure(b, CNF_500K, MCP_MODE.NORMAL);

  loadAndSend(a, 0x101, [1, 2, 3]);
  for (let i = 0; i < 400; i++) bus.stepBit();
  a.settle();
  b.settle();
  check(a.sentCount === 0, 'nothing left the chip');
  check(b.receivedCount === 0, 'and nothing arrived anywhere');
  check((read(a, MCP_REG.TXB0CTRL) & 0x08) === 0, 'and TXREQ was cleared rather than left hanging');

  // Ask for normal mode and the same request works.
  write(a, MCP_REG.CANCTRL, MCP_MODE.NORMAL << 5);
  loadAndSend(a, 0x101, [1, 2, 3]);
  for (let i = 0; i < 400; i++) bus.stepBit();
  a.settle();
  b.settle();
  check(a.sentCount === 1, 'leaving configuration mode fixes it');
  check(b.receivedCount === 1, 'and the frame arrives');
}

// ==================================== 4. two controllers on one wire =========
section('4. a frame from one register file into another');
{
  const bus = new CanBus('bus');
  const a = new Mcp2515Device('a', 'cs', bus);
  const b = new Mcp2515Device('b', 'cs', bus);
  configure(a);
  configure(b);

  loadAndSend(a, 0x123, [0xca, 0xfe]);
  for (let i = 0; i < 400; i++) bus.stepBit();
  a.settle();
  b.settle();

  check((read(b, MCP_REG.CANINTF) & INT_RX0) !== 0, 'the receiver raised RX0IF');
  check(b.irqAsserted, 'and INT would be low');
  const sidh = read(b, MCP_REG.RXB0CTRL + 1);
  const sidl = read(b, MCP_REG.RXB0CTRL + 2);
  const id = (sidh << 3) | (sidl >> 5);
  check(id === 0x123, `with the identifier in RXB0SIDH/SIDL (0x${id.toString(16)})`);
  check(read(b, MCP_REG.RXB0CTRL + 5) === 2, 'and a DLC of two');
  check(read(b, MCP_REG.RXB0CTRL + 6) === 0xca, 'and the first data byte');
  check(read(b, MCP_REG.RXB0CTRL + 7) === 0xfe, 'and the second');

  check((read(a, MCP_REG.CANINTF) & INT_TX0) !== 0, 'the sender raised TX0IF');
  check((read(a, MCP_REG.TXB0CTRL) & 0x08) === 0, 'and TXREQ cleared, so the buffer is free again');

  // READ RX BUFFER clears the flag, which is why libraries use it.
  spi(b, [MCP_CMD.READ_RX | 0x00, 0, 0, 0, 0, 0]);
  check((read(b, MCP_REG.CANINTF) & INT_RX0) === 0, 'READ RX BUFFER clears RX0IF');
  check(!b.irqAsserted, 'and releases INT');
}

// ======================================= 5. arbitration through the chips ====
section('5. two controllers keying up together arbitrate on the wire');
{
  const bus = new CanBus('bus');
  const low = new Mcp2515Device('low', 'cs', bus);
  const high = new Mcp2515Device('high', 'cs', bus);
  const watcher = new Mcp2515Device('watcher', 'cs', bus);
  for (const d of [low, high, watcher]) configure(d);

  loadAndSend(low, 0x0a0, [1]);
  loadAndSend(high, 0x0b0, [2]);
  // Step only until the first frame is complete, so the loser has not yet had
  // a turn — the point is the ORDER, and a longer run would hide it.
  let bits = 0;
  while (bits < 400 && low.sentCount === 0) {
    bus.stepBit();
    bits++;
  }
  for (const d of [low, high, watcher]) d.settle();
  console.log(`   the winning frame took ${bits} bit(s) on the wire`);

  check(low.sentCount === 1, 'the lower identifier went first');
  check(high.arbitrationLosses === 1, 'and the higher one detected that it lost');
  check(high.sentCount === 0, 'without having sent yet');

  for (let i = 0; i < 400; i++) bus.stepBit();
  for (const d of [low, high, watcher]) d.settle();
  check(high.sentCount === 1, 'then it transmits on the free bus');
  check(watcher.receivedCount === 2, `and the third node has both (${watcher.receivedCount})`);
}

// ============================ 6. a bitrate mismatch is not survivable =======
section('6. a node with different bit timing wrecks the bus');
{
  const bus = new CanBus('bus');
  const a = new Mcp2515Device('a', 'cs', bus);
  const b = new Mcp2515Device('b', 'cs', bus);
  configure(a, CNF_500K);
  configure(b, { ...CNF_500K, cnf1: 0x03 }); // 125 kbit/s
  check(a.bitrate !== b.bitrate, `the two chips are on different bitrates (${a.bitrate} vs ${b.bitrate})`);

  loadAndSend(a, 0x111, [9]);
  for (let i = 0; i < 400; i++) bus.stepBit();
  a.settle();
  b.settle();
  check(b.receivedCount === 0, 'the mismatched node decodes nothing');
}

// ======================================= 7. loopback never reaches the wire ==
section('7. loopback mode talks to itself');
{
  const bus = new CanBus('bus');
  const a = new Mcp2515Device('a', 'cs', bus);
  const b = new Mcp2515Device('b', 'cs', bus);
  configure(a, CNF_500K, MCP_MODE.LOOPBACK);
  configure(b, CNF_500K, MCP_MODE.NORMAL);

  loadAndSend(a, 0x222, [0x77]);
  for (let i = 0; i < 400; i++) bus.stepBit();
  a.settle();
  b.settle();

  check((read(a, MCP_REG.CANINTF) & INT_RX0) !== 0, 'the loopback chip received its own frame');
  check(read(a, MCP_REG.RXB0CTRL + 6) === 0x77, 'with its own data');
  check(b.receivedCount === 0, 'and nothing reached the other node — loopback is not the wire');
}

// ===================== 8. real firmware on two boards, over SPI and a wire ===
section('8. board A firmware to board B firmware, through two MCP2515s');
{
  const SOURCE = [
    '#include <SPI.h>',
    '#define CS 10',
    'bool isTx;',
    'void wreg(uint8_t reg, uint8_t v) {',
    '  digitalWrite(CS, LOW); SPI.transfer(0x02); SPI.transfer(reg); SPI.transfer(v); digitalWrite(CS, HIGH);',
    '}',
    'uint8_t rreg(uint8_t reg) {',
    '  digitalWrite(CS, LOW); SPI.transfer(0x03); SPI.transfer(reg);',
    '  uint8_t v = SPI.transfer(0); digitalWrite(CS, HIGH); return v;',
    '}',
    'void setup() {',
    '  Serial.begin(9600);',
    '  pinMode(4, INPUT_PULLUP);',
    '  pinMode(CS, OUTPUT); digitalWrite(CS, HIGH);',
    '  SPI.begin();',
    '  delay(10);',
    '  isTx = digitalRead(4) == LOW;',
    '  digitalWrite(CS, LOW); SPI.transfer(0xC0); digitalWrite(CS, HIGH);',  // RESET
    '  delay(5);',
    '  wreg(0x0F, 0x80);',   // configuration mode
    '  wreg(0x28, 0x86);',   // CNF3
    '  wreg(0x29, 0xF0);',   // CNF2
    '  wreg(0x2A, 0x00);',   // CNF1 -> 500 kbit/s
    '  wreg(0x2B, 0x03);',   // CANINTE: RX0IF and RX1IF
    '  wreg(0x0F, 0x00);',   // normal mode
    '  if (isTx) {',
    '    delay(20);',
    '    wreg(0x31, 0x24); wreg(0x32, 0x60);',   // id 0x123
    '    wreg(0x35, 3);',
    '    wreg(0x36, 0xC0); wreg(0x37, 0xDE); wreg(0x38, 0x01);',
    '    digitalWrite(CS, LOW); SPI.transfer(0x81); digitalWrite(CS, HIGH);', // RTS TXB0
    '  }',
    '}',
    'bool done = false;',
    'void loop() {',
    '  if (done) return;',
    '  uint8_t flags = rreg(0x2C);',
    '  if (isTx) {',
    '    if (flags & 0x04) { Serial.println("TX=OK"); done = true; }',
    '  } else if (flags & 0x01) {',
    '    uint16_t id = ((uint16_t)rreg(0x61) << 3) | (rreg(0x62) >> 5);',
    '    uint8_t n = rreg(0x65) & 0x0F;',
    '    Serial.print("RX="); Serial.print(id, HEX); Serial.print(":");',
    '    for (uint8_t i = 0; i < n; i++) { uint8_t b = rreg(0x66 + i); if (b < 16) Serial.print("0"); Serial.print(b, HEX); }',
    '    Serial.println();',
    '    wreg(0x2C, 0x00);',
    '    done = true;',
    '  }',
    '}',
  ].join('\n');

  const p = emptyProject('mcp2515');
  const boardA = inst('board.arduino-uno');
  const boardB = inst('board.arduino-uno');
  const canA = inst('comp.mcp2515');
  const canB = inst('comp.mcp2515');
  p.boardInstances.push(boardA, boardB);
  p.componentInstances.push(canA, canB);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];

  const hookUp = (board: ComponentInstance, chip: ComponentInstance) => {
    wire(p, board.id, '5V', chip.id, 'vcc');
    wire(p, board.id, 'GND_TOP', chip.id, 'gnd');
    wire(p, board.id, 'D13', chip.id, 'sck');
    wire(p, board.id, 'D11', chip.id, 'si');
    wire(p, board.id, 'D12', chip.id, 'so');
    wire(p, board.id, 'D10', chip.id, 'cs');
    wire(p, board.id, 'D2', chip.id, 'int');
  };
  hookUp(boardA, canA);
  hookUp(boardB, canB);
  // The bus itself.
  wire(p, canA.id, 'canh', canB.id, 'canh');
  wire(p, canA.id, 'canl', canB.id, 'canl');
  wire(p, boardA.id, 'D4', boardA.id, 'GND_PWR1'); // board A transmits

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the two-board CAN test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(400);
    simulationController.publishNow();

    const binding = (simulationController as unknown as {
      binding: { spiDevices: unknown[]; canBusOf(id: string): unknown } | null;
    }).binding;
    const chips = (binding?.spiDevices ?? []).filter((d): d is Mcp2515Device => d instanceof Mcp2515Device);
    check(chips.length === 2, `both controllers attached to their boards' SPI (${chips.length})`);
    for (const c of chips) console.log(`   chip: ${c.snapshot().status}`);

    const shared = binding?.canBusOf(canA.id);
    check(shared instanceof CanBus && shared === binding?.canBusOf(canB.id), 'and both are on ONE bus');
    if (shared instanceof CanBus) console.log(`   bus: ${shared.snapshot().status}`);

    check(chips.some((c) => c.sentCount > 0), 'one controller sent a frame');
    check(chips.some((c) => c.receivedCount > 0), 'and the other received one');

    const serial = useSimulationStore.getState().serialText;
    console.log(`   serial: ${JSON.stringify(serial.trim().split('\n').slice(-3))}`);
    check(/RX=123:C0DE01/i.test(serial), "board B's firmware read the frame out of its own receive buffer");
    check(/TX=OK/.test(serial), "and board A's firmware saw TX0IF");
  }
  simulationController.stop();
}

// ================================================= 9. the part as shipped ====
section('9. the MCP2515 in the library');
{
  const def = defOf('comp.mcp2515');
  check(def !== undefined, 'the MCP2515 is in the library');
  if (def) {
    check(def.supportLevel === 'simulated', 'badged Simulated');
    for (const pinId of ['sck', 'si', 'so', 'cs', 'int', 'canh', 'canl', 'vcc', 'gnd']) {
      check(def.pins.some((pp) => pp.id === pinId), `it exposes ${pinId}`);
    }
    check(/CONFIGURATION mode/.test(def.description ?? ''), 'and warns about configuration mode');
    check(/acceptance filters and masks/.test(def.description ?? ''), 'and names the filters it does not apply');
  }
  const cov = COMPONENT_COVERAGE.find((c) => c.id === 'comp.mcp2515');
  check(cov?.status === 'behavioral', 'recorded as behavioural, because the filters are not applied');
  check((cov?.dependencies ?? []).includes('can-filters'), 'with can-filters as its blocker');
  check((cov?.tests ?? []).includes('tests/bus.mcp2515.mts'), 'and names this file as its proof');
}

console.log(
  failures === 0
    ? `\nMCP2515 checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
