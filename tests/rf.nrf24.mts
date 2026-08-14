// The nRF24L01+, driven by firmware that talks to the register file.
//
// There is no library on either side. The sketches build the SPI transactions
// themselves — command byte, register, payload — so what is being tested is
// the chip's own interface rather than someone's wrapper around it. If the
// register model were wrong, these sketches would fail here exactly as they
// would fail on a bench.
//
// The acceptance that matters is section 4 onwards: board A's firmware writes
// a payload over SPI, the radio puts it in the shared medium with real
// airtime, board B's radio picks it up, raises RX_DR, pulls IRQ low, and
// board B's firmware reads it back over its own SPI. Nothing is injected into
// a FIFO by the test, nothing is handed to firmware by a callback, and the
// negative cases — wrong channel, wrong address, collision, unwired CE — are
// asserted with the same machinery.

import { Nrf24Device, NRF_REG, NRF24_BASE_KHZ } from '../src/simulation/devices/nrf24';
import { RF_BAND } from '../src/simulation/devices/rfMedium';
import { RfMedium } from '../src/simulation/devices/rfMedium';
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
const inst = (definitionId: string, properties: Record<string, unknown> = {}): ComponentInstance => ({
  id: uid('c'), definitionId, x: 0, y: 0, rotation: 0, properties, simulationState: {},
});
function wire(p: CircuitProject, a: string, ap: string, b: string, bp: string) {
  p.connections.push({
    id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
    netId: '', color: '#000', points: [], routing: 'smooth',
  } as CircuitProject['connections'][number]);
}

/** Drives a device's SPI the way a sketch does: select, clock, deselect. */
function spi(device: Nrf24Device, bytes: number[]): number[] {
  device.select(true);
  const out = bytes.map((b) => device.transfer(b) ?? 0);
  device.select(false);
  return out;
}
const writeReg = (d: Nrf24Device, reg: number, ...values: number[]) => spi(d, [0x20 | reg, ...values]);
const readReg = (d: Nrf24Device, reg: number) => spi(d, [reg, 0xff])[1];

/**
 * A radio configured the way every tutorial configures one, so the tests below
 * differ only in the thing they are testing.
 */
function configure(d: Nrf24Device, opts: { rx: boolean; channel?: number; address?: number[] }): void {
  const address = opts.address ?? [0xe1, 0xe1, 0xe1, 0xe1, 0xe1];
  writeReg(d, NRF_REG.RF_CH, opts.channel ?? 76);
  writeReg(d, NRF_REG.RF_SETUP, 0x06); // 1 Mbps
  writeReg(d, NRF_REG.SETUP_RETR, 0x3f); // slowest retry, 15 attempts
  writeReg(d, NRF_REG.EN_RXADDR, 0x01);
  writeReg(d, NRF_REG.RX_PW_P0, 4);
  writeReg(d, NRF_REG.RX_ADDR_P0, ...address);
  writeReg(d, NRF_REG.TX_ADDR, ...address);
  writeReg(d, NRF_REG.CONFIG, opts.rx ? 0x0b : 0x0a); // EN_CRC | PWR_UP | PRIM_RX?
}

// ======================================= 1. the register file is the chip ====
section('1. registers behave the way the datasheet says');
{
  const m = new RfMedium();
  const d = new Nrf24Device('r', 'csn', m, () => 0);

  check(readReg(d, NRF_REG.CONFIG) === 0x08, 'CONFIG powers up with CRC enabled and the radio down');
  check(readReg(d, NRF_REG.EN_AA) === 0x3f, 'auto-ack is on for every pipe by default');
  check(readReg(d, NRF_REG.RF_CH) === 0x02, 'and the default channel is 2');
  check(readReg(d, NRF_REG.SETUP_AW) === 0x03, 'with five-byte addresses');

  writeReg(d, NRF_REG.RF_CH, 76);
  check(readReg(d, NRF_REG.RF_CH) === 76, 'a written register reads back');

  // Five-byte address registers are not one byte, and getting that wrong is
  // the difference between a working link and silence.
  writeReg(d, NRF_REG.TX_ADDR, 0x01, 0x02, 0x03, 0x04, 0x05);
  const back = spi(d, [NRF_REG.TX_ADDR, 0, 0, 0, 0, 0]).slice(1);
  check(back.join(',') === '1,2,3,4,5', `TX_ADDR holds all five bytes (${back.join(',')})`);

  // Every transaction answers with STATUS on the command byte.
  const status = spi(d, [0xff])[0];
  check((status & 0x0e) === 0x0e, `NOP returns STATUS with an empty RX pipe (0x${status.toString(16)})`);

  // Read-only registers must not become writable.
  writeReg(d, NRF_REG.OBSERVE_TX, 0xff);
  check(readReg(d, NRF_REG.OBSERVE_TX) === 0, 'OBSERVE_TX is read-only');
  check(readReg(d, NRF_REG.RPD) === 0, 'and RPD reads zero rather than inventing a signal strength');

  // Write-one-to-clear on the interrupt bits.
  writeReg(d, NRF_REG.CONFIG, 0x0a);
  writeReg(d, NRF_REG.STATUS, 0x70);
  check((readReg(d, NRF_REG.STATUS) & 0x70) === 0, 'the interrupt bits clear on a write of one');
}

// ============================================== 2. the FIFOs are real ========
section('2. both FIFOs have real depth');
{
  const m = new RfMedium();
  const d = new Nrf24Device('r', 'csn', m, () => 0);
  configure(d, { rx: false });

  check((readReg(d, NRF_REG.FIFO_STATUS) & 0x11) === 0x11, 'both FIFOs start empty');
  for (let i = 0; i < 3; i++) spi(d, [0xa0, i, i, i, i]);
  check(d.txQueued === 3, `three payloads fit (${d.txQueued})`);
  check((readReg(d, NRF_REG.FIFO_STATUS) & 0x20) !== 0, 'and the fourth would overflow — TX_FULL is set');
  check((spi(d, [0xff])[0] & 0x01) !== 0, 'which STATUS reports too');

  spi(d, [0xa0, 9, 9, 9, 9]);
  check(d.txQueued === 3, 'a write to a full FIFO is dropped, not silently grown');

  spi(d, [0xe1]); // FLUSH_TX
  check(d.txQueued === 0, 'FLUSH_TX empties it');
  check((readReg(d, NRF_REG.FIFO_STATUS) & 0x10) !== 0, 'and TX_EMPTY comes back');
}

// ============================ 3. nothing transmits without the conditions ====
section('3. a packet needs everything the hardware needs');
{
  const mk = () => {
    const m = new RfMedium();
    const d = new Nrf24Device('r', 'csn', m, () => 0);
    return { m, d };
  };

  {
    const { m, d } = mk();
    configure(d, { rx: false });
    spi(d, [0xa0, 1, 2, 3, 4]);
    d.radioTransmit();
    check(m.transmissionCount === 0, 'CE low: nothing goes out, however full the FIFO is');
    d.setCe(true);
    check(m.transmissionCount === 1, 'and raising CE launches it');
  }
  {
    const { m, d } = mk();
    configure(d, { rx: false });
    writeReg(d, NRF_REG.CONFIG, 0x08); // CRC on, PWR_UP off
    spi(d, [0xa0, 1, 2, 3, 4]);
    d.setCe(true);
    d.radioTransmit();
    check(m.transmissionCount === 0, 'a powered-down radio transmits nothing');
  }
  {
    const { m, d } = mk();
    configure(d, { rx: false });
    d.setCe(true);
    d.radioTransmit();
    check(m.transmissionCount === 0, 'and an empty FIFO transmits nothing');
  }
}

// ================================================== 4. airtime is real =======
section('4. a packet occupies the air for as long as it should');
{
  const m = new RfMedium();
  let now = 0;
  const d = new Nrf24Device('r', 'csn', m, () => now);
  configure(d, { rx: false });
  spi(d, [0xa0, 1, 2, 3, 4]); // four bytes
  d.setCe(true);

  const t = m.lastTransmission;
  check(t !== undefined, 'a transmission exists');
  if (t) {
    // 1 Mbps, 1 preamble + 5 address + 4 payload + 1 CRC bytes + 9 bits PCF.
    const expected = (8 * (1 + 5 + 4 + 1) + 9) / 1_000_000 * 1_000_000;
    const airtime = t.endUs - t.startUs;
    check(Math.abs(airtime - expected) < 1, `airtime is ${airtime.toFixed(0)} us, not instant`);
    check(t.band === RF_BAND, 'on the shared band every radio uses');
    check(t.channel === NRF24_BASE_KHZ + 76_000, `at 2476 MHz, the frequency channel 76 actually is (${t.channel} kHz)`);
    check(t.match.modulation === 'gfsk', 'marked as GFSK, so only its own family can demodulate it');
    check(String(t.match.address) === 'e1e1e1e1e1', 'addressed to TX_ADDR');
  }

  // 250 kbps is four times the air, which is the whole reason people use it.
  const m2 = new RfMedium();
  const slow = new Nrf24Device('s', 'csn', m2, () => 0);
  configure(slow, { rx: false });
  writeReg(slow, NRF_REG.RF_SETUP, 0x26); // RF_DR_LOW
  spi(slow, [0xa0, 1, 2, 3, 4]);
  slow.setCe(true);
  const slowT = m2.lastTransmission;
  check(slow.dataRate === 250_000, 'RF_DR_LOW selects 250 kbps');
  if (slowT && m.lastTransmission) {
    const ratio = (slowT.endUs - slowT.startUs) / (m.lastTransmission.endUs - m.lastTransmission.startUs);
    check(Math.abs(ratio - 4) < 0.01, `and takes four times as long (${ratio.toFixed(2)}x)`);
  }
}

// ============================== 5. two radios on one medium, end to end ======
section('5. one radio to another through the shared medium');
{
  const m = new RfMedium();
  let now = 0;
  const tx = new Nrf24Device('tx', 'csn', m, () => now);
  const rx = new Nrf24Device('rx', 'csn', m, () => now);
  configure(tx, { rx: false });
  configure(rx, { rx: true });
  rx.setCe(true);

  spi(tx, [0xa0, 0xde, 0xad, 0xbe, 0xef]);
  tx.setCe(true);
  now = 1000;
  rx.radioReceive();
  tx.radioTransmit();

  check(rx.rxQueued === 1, `the packet reached the other radio's FIFO (${rx.rxQueued})`);
  check((readReg(rx, NRF_REG.STATUS) & 0x40) !== 0, 'RX_DR is set');
  check(rx.irqAsserted, 'and IRQ is asserted');

  const payload = spi(rx, [0x61, 0, 0, 0, 0]).slice(1);
  check(payload.map((b) => b.toString(16)).join('') === 'deadbeef', `carrying the bytes sent (${payload.map((b) => b.toString(16)).join(' ')})`);
  check(rx.rxQueued === 0, 'and reading it empties the FIFO');

  // Auto-ack: the receiver answered, and the transmitter heard it.
  now = 2000;
  tx.radioTransmit();
  check((readReg(tx, NRF_REG.STATUS) & 0x20) !== 0, 'the transmitter saw TX_DS');
  check(tx.sentCount === 1, 'and counts one packet delivered');
  check(tx.txQueued === 0, 'with the payload gone from its FIFO');
}

// ================================= 6. the negatives, on the same machinery ===
section('6. wrong channel, wrong address, and a collision');
{
  const pair = (rxOpts: { channel?: number; address?: number[] }) => {
    const m = new RfMedium();
    let now = 0;
    const tx = new Nrf24Device('tx', 'csn', m, () => now);
    const rx = new Nrf24Device('rx', 'csn', m, () => now);
    configure(tx, { rx: false });
    configure(rx, { rx: true, ...rxOpts });
    rx.setCe(true);
    spi(tx, [0xa0, 1, 2, 3, 4]);
    tx.setCe(true);
    now = 1000;
    rx.radioReceive();
    tx.radioTransmit();
    return { m, tx, rx, at: (t: number) => { now = t; } };
  };

  check(pair({}).rx.rxQueued === 1, 'the same channel and address works');
  check(pair({ channel: 40 }).rx.rxQueued === 0, 'a different channel hears nothing');
  check(pair({ address: [0xaa, 0xbb, 0xcc, 0xdd, 0xee] }).rx.rxQueued === 0, 'a different address hears nothing');

  // And the transmitter notices it was never acknowledged, rather than
  // reporting success into the void.
  const deaf = pair({ channel: 40 });
  for (let t = 2000; t < 200000; t += 1000) {
    deaf.at(t);
    deaf.rx.radioReceive();
    deaf.tx.radioTransmit();
  }
  check((readReg(deaf.tx, NRF_REG.STATUS) & 0x10) !== 0, 'the transmitter raised MAX_RT');
  check(deaf.tx.lostCount === 1, 'and counted the loss exactly once');
  check(deaf.tx.txQueued === 1, 'leaving the payload in the FIFO, as the hardware does');
  // The datasheet is explicit: MAX_RT blocks the radio until it is cleared.
  // A sketch that ignores the flag ends up with a module that has stopped,
  // which is one of the most common nRF24 faults there is.
  check(deaf.m.transmissionCount === 16, `and it stopped after ARC+1 attempts (${deaf.m.transmissionCount})`);

  // A collision destroys the packet instead of delivering it.
  const m = new RfMedium();
  let now = 0;
  const a = new Nrf24Device('a', 'csn', m, () => now);
  const b = new Nrf24Device('b', 'csn', m, () => now);
  const listener = new Nrf24Device('c', 'csn', m, () => now);
  for (const d of [a, b]) configure(d, { rx: false });
  configure(listener, { rx: true });
  listener.setCe(true);
  spi(a, [0xa0, 1, 1, 1, 1]);
  spi(b, [0xa0, 2, 2, 2, 2]);
  a.setCe(true);
  b.setCe(true); // same instant, same channel, same address
  now = 1000;
  listener.radioReceive();
  check(listener.rxQueued === 0, 'two radios keyed up together deliver nothing');
  check(m.collisionCount > 0, `and the collision is recorded (${m.collisionCount})`);
}

// ========================== 7. two pairs on different channels stay apart ====
section('7. independent pairs do not leak into each other');
{
  const m = new RfMedium();
  let now = 0;
  const a1 = new Nrf24Device('a1', 'csn', m, () => now);
  const a2 = new Nrf24Device('a2', 'csn', m, () => now);
  const b1 = new Nrf24Device('b1', 'csn', m, () => now);
  const b2 = new Nrf24Device('b2', 'csn', m, () => now);
  configure(a1, { rx: false, channel: 20, address: [0xa1, 0xa1, 0xa1, 0xa1, 0xa1] });
  configure(a2, { rx: true, channel: 20, address: [0xa1, 0xa1, 0xa1, 0xa1, 0xa1] });
  configure(b1, { rx: false, channel: 90, address: [0xb1, 0xb1, 0xb1, 0xb1, 0xb1] });
  configure(b2, { rx: true, channel: 90, address: [0xb1, 0xb1, 0xb1, 0xb1, 0xb1] });
  a2.setCe(true);
  b2.setCe(true);

  spi(a1, [0xa0, 0x11, 0x11, 0x11, 0x11]);
  spi(b1, [0xa0, 0x22, 0x22, 0x22, 0x22]);
  a1.setCe(true);
  b1.setCe(true);
  now = 1000;
  a2.radioReceive();
  b2.radioReceive();

  check(a2.rxQueued === 1 && b2.rxQueued === 1, 'both pairs delivered');
  check(spi(a2, [0x61, 0, 0, 0, 0])[1] === 0x11, "and pair A got pair A's bytes");
  check(spi(b2, [0x61, 0, 0, 0, 0])[1] === 0x22, "and pair B got pair B's");
  check(m.collisionCount === 0, 'with no collision, because they are on different channels');
}

// ===================== 8. real firmware, real SPI, two real boards ===========
section('8. board A firmware to board B firmware, over SPI and the air');
{
  // No library. The sketch builds every SPI transaction itself, so what is
  // being exercised is the chip's register interface. A strap on D4 chooses
  // which end this board is.
  const SOURCE = [
    '#include <SPI.h>',
    '#define CSN 10',
    '#define CE 9',
    'bool isTx;',
    'uint8_t xfer(uint8_t cmd, uint8_t *buf, uint8_t len) {',
    '  digitalWrite(CSN, LOW);',
    '  uint8_t status = SPI.transfer(cmd);',
    '  for (uint8_t i = 0; i < len; i++) buf[i] = SPI.transfer(buf[i]);',
    '  digitalWrite(CSN, HIGH);',
    '  return status;',
    '}',
    'void wreg(uint8_t reg, uint8_t v) { uint8_t b = v; xfer(0x20 | reg, &b, 1); }',
    'uint8_t rreg(uint8_t reg) { uint8_t b = 0xFF; xfer(reg, &b, 1); return b; }',
    'void waddr(uint8_t reg) {',
    '  uint8_t a[5] = {0xE1, 0xE1, 0xE1, 0xE1, 0xE1};',
    '  xfer(0x20 | reg, a, 5);',
    '}',
    'void setup() {',
    '  Serial.begin(9600);',
    '  pinMode(4, INPUT_PULLUP);',
    '  pinMode(CSN, OUTPUT); digitalWrite(CSN, HIGH);',
    '  pinMode(CE, OUTPUT); digitalWrite(CE, LOW);',
    '  SPI.begin();',
    '  delay(10);',
    '  isTx = digitalRead(4) == LOW;',
    '  wreg(0x05, 76);',            // RF_CH
    '  wreg(0x06, 0x06);',          // 1 Mbps
    '  wreg(0x04, 0x3F);',          // slow retries, plenty of them
    '  wreg(0x02, 0x01);',          // EN_RXADDR pipe 0
    '  wreg(0x11, 4);',             // RX_PW_P0
    '  waddr(0x0A);',               // RX_ADDR_P0
    '  waddr(0x10);',               // TX_ADDR
    '  wreg(0x07, 0x70);',          // clear the interrupt flags
    '  if (isTx) {',
    '    wreg(0x00, 0x0A);',        // EN_CRC | PWR_UP
    '    delay(5);',
    '    uint8_t p[4] = {0xC0, 0xFF, 0xEE, 0x01};',
    '    xfer(0xA0, p, 4);',
    '    digitalWrite(CE, HIGH); delayMicroseconds(15); digitalWrite(CE, LOW);',
    '  } else {',
    '    wreg(0x00, 0x0B);',        // EN_CRC | PWR_UP | PRIM_RX
    '    digitalWrite(CE, HIGH);',
    '  }',
    '}',
    'bool done = false;',
    'void loop() {',
    '  if (done) return;',
    '  uint8_t s = rreg(0x07);',
    '  if (isTx) {',
    '    if (s & 0x20) { Serial.println("TX=OK"); done = true; }',
    '    else if (s & 0x10) { Serial.println("TX=MAXRT"); done = true; }',
    '  } else if (s & 0x40) {',
    '    uint8_t p[4] = {0, 0, 0, 0};',
    '    xfer(0x61, p, 4);',
    '    wreg(0x07, 0x40);',
    '    Serial.print("RX=");',
    '    for (uint8_t i = 0; i < 4; i++) { if (p[i] < 16) Serial.print("0"); Serial.print(p[i], HEX); }',
    '    Serial.println();',
    '    done = true;',
    '  }',
    '}',
  ].join('\n');

  const p = emptyProject('nrf24');
  const boardA = inst('board.arduino-uno');
  const boardB = inst('board.arduino-uno');
  const radioA = inst('comp.nrf24l01');
  const radioB = inst('comp.nrf24l01');
  p.boardInstances.push(boardA, boardB);
  p.componentInstances.push(radioA, radioB);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];

  const hookUp = (board: ComponentInstance, radio: ComponentInstance) => {
    wire(p, board.id, '3V3', radio.id, 'vcc');
    wire(p, board.id, 'GND_TOP', radio.id, 'gnd');
    wire(p, board.id, 'D13', radio.id, 'sck');
    wire(p, board.id, 'D11', radio.id, 'mosi');
    wire(p, board.id, 'D12', radio.id, 'miso');
    wire(p, board.id, 'D10', radio.id, 'csn');
    wire(p, board.id, 'D9', radio.id, 'ce');
    wire(p, board.id, 'D2', radio.id, 'irq');
  };
  hookUp(boardA, radioA);
  hookUp(boardB, radioB);
  wire(p, boardA.id, 'D4', boardA.id, 'GND_PWR1'); // board A is the transmitter

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the two-board radio test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(400);
    simulationController.publishNow();

    const binding = (simulationController as unknown as {
      binding: { spiDevices: unknown[] } | null;
    }).binding;
    const radios = (binding?.spiDevices ?? []).filter((d): d is Nrf24Device => d instanceof Nrf24Device);
    check(radios.length === 2, `both radios attached to their boards' SPI (${radios.length})`);
    for (const r of radios) console.log(`   radio: ${r.snapshot().status}`);

    const sender = radios.find((r) => r.sentCount > 0);
    const receiver = radios.find((r) => r.receivedCount > 0);
    check(sender !== undefined, 'one radio transmitted a packet');
    check(receiver !== undefined, 'and the other received one');
    check(sender !== receiver, 'and they are different radios');

    const serial = useSimulationStore.getState().serialText;
    console.log(`   serial: ${JSON.stringify(serial.trim().split('\n').slice(-3))}`);
    check(/RX=C0FFEE01/i.test(serial), "board B's firmware read the payload back over its own SPI");
    check(/TX=OK/.test(serial), "and board A's firmware saw TX_DS, meaning it was acknowledged");
    check(!/TX=MAXRT/.test(serial), 'rather than giving up');
  }
  simulationController.stop();
}

// ============================= 9. an unwired radio does not work =============
section('9. a radio with its control pins missing does nothing');
{
  const SOURCE = [
    '#include <SPI.h>',
    '#define CSN 10',
    'void setup() {',
    '  Serial.begin(9600);',
    '  pinMode(CSN, OUTPUT); digitalWrite(CSN, HIGH);',
    '  SPI.begin();',
    '  delay(10);',
    '  digitalWrite(CSN, LOW); SPI.transfer(0x20 | 0x00); SPI.transfer(0x0A); digitalWrite(CSN, HIGH);',
    '  uint8_t p[4] = {1, 2, 3, 4};',
    '  digitalWrite(CSN, LOW); SPI.transfer(0xA0);',
    '  for (uint8_t i = 0; i < 4; i++) SPI.transfer(p[i]);',
    '  digitalWrite(CSN, HIGH);',
    '}',
    'void loop() {}',
  ].join('\n');

  const p = emptyProject('nrf24-noce');
  const board = inst('board.arduino-uno');
  const radio = inst('comp.nrf24l01');
  p.boardInstances.push(board);
  p.componentInstances.push(radio);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  wire(p, board.id, '3V3', radio.id, 'vcc');
  wire(p, board.id, 'GND_TOP', radio.id, 'gnd');
  wire(p, board.id, 'D13', radio.id, 'sck');
  wire(p, board.id, 'D11', radio.id, 'mosi');
  wire(p, board.id, 'D12', radio.id, 'miso');
  wire(p, board.id, 'D10', radio.id, 'csn');
  // CE deliberately left unwired — the classic mistake.

  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the unwired-CE test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(200);
    const binding = (simulationController as unknown as { binding: { spiDevices: unknown[] } | null }).binding;
    const radios = (binding?.spiDevices ?? []).filter((d): d is Nrf24Device => d instanceof Nrf24Device);
    check(radios.length === 1, 'the radio is still on the SPI bus');
    if (radios[0]) {
      console.log(`   radio: ${radios[0].snapshot().status}`);
      check(radios[0].txQueued > 0, 'the payload reached its FIFO over SPI');
      check(!radios[0].ceHigh, 'but CE was never raised');
      check(radios[0].sentCount === 0, 'so nothing was transmitted — CE is not CSN');
    }
  }
  simulationController.stop();
}

// =============================================== 10. the part as shipped =====
section('10. the nRF24 in the library');
{
  const def = defOf('comp.nrf24l01');
  check(def !== undefined, 'the nRF24L01+ is in the library');
  if (def) {
    check(def.supportLevel === 'simulated', 'badged Simulated');
    for (const pinId of ['sck', 'mosi', 'miso', 'csn', 'ce', 'irq', 'vcc', 'gnd']) {
      check(def.pins.some((pp) => pp.id === pinId), `it exposes ${pinId}`);
    }
    check(/separate signals/.test(def.description ?? ''), 'and says CE and CSN are separate signals');
    check(/RPD and RSSI/.test(def.description ?? ''), 'and that it invents no signal strength');
  }
  const cov = COMPONENT_COVERAGE.find((c) => c.id === 'comp.nrf24l01');
  check(cov?.status === 'simulated', 'recorded as simulated');
  check((cov?.tests ?? []).includes('tests/rf.nrf24.mts'), 'and names this file as its proof');
  check((cov?.dependencies ?? []).length === 0, 'with no blocker left');
}

console.log(
  failures === 0
    ? `\nnRF24 checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
