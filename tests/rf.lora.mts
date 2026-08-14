// The SX1278, driven by firmware that speaks its register file.
//
// LoRa's whole reason to exist is time on air: the same sixteen bytes take
// 51.5 ms at SF7 and 1.155 seconds at SF12, and every design decision anyone
// makes with it follows from that. So the airtime formula is checked against
// the datasheet's, not approximated, and a packet occupies the medium for as
// long as it really would.
//
// The other half is compatibility. Two modules talk only when their frequency,
// spreading factor, bandwidth and sync word all agree, and mismatched settings
// are the single commonest LoRa failure. Every one of those is asserted here
// as a negative, on the same machinery that carries the positive.
//
// Section 6 is the acceptance: board A's firmware writes a payload into the
// FIFO over SPI, sets RegOpMode to TX, and the packet crosses the shared
// medium to board B, which sees RxDone, reads RegRxNbBytes and clocks the
// bytes back out of its own FIFO. No injection, no callback.

import { Sx1278Device, SX_REG, SX_MODE, IRQ_RX_DONE, IRQ_TX_DONE, IRQ_CRC_ERROR } from '../src/simulation/devices/sx1278';
import { RfMedium, RF_BAND } from '../src/simulation/devices/rfMedium';
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

/** One SPI transaction: address byte then data, exactly as the chip wants. */
function spi(d: Sx1278Device, bytes: number[]): number[] {
  d.select(true);
  const out = bytes.map((b) => d.transfer(b) ?? 0);
  d.select(false);
  return out;
}
const write = (d: Sx1278Device, reg: number, ...values: number[]) => spi(d, [0x80 | reg, ...values]);
const read = (d: Sx1278Device, reg: number) => spi(d, [reg, 0])[1];

/** Frf registers for a frequency, the way every library computes them. */
function frfFor(hz: number): [number, number, number] {
  const frf = Math.round((hz / 32_000_000) * 2 ** 19);
  return [(frf >> 16) & 0xff, (frf >> 8) & 0xff, frf & 0xff];
}

interface Setup {
  hz?: number;
  sf?: number;
  bwIndex?: number;
  sync?: number;
}
function configure(d: Sx1278Device, s: Setup = {}): void {
  write(d, SX_REG.OP_MODE, 0x80 | SX_MODE.SLEEP); // LoRa can only be entered from sleep
  const [msb, mid, lsb] = frfFor(s.hz ?? 433_000_000);
  write(d, SX_REG.FRF_MSB, msb, mid, lsb);
  write(d, SX_REG.MODEM_CONFIG_1, ((s.bwIndex ?? 7) << 4) | (1 << 1)); // CR 4/5, explicit header
  write(d, SX_REG.MODEM_CONFIG_2, ((s.sf ?? 7) << 4) | 0x04); // CRC on
  write(d, SX_REG.SYNC_WORD, s.sync ?? 0x12);
  write(d, SX_REG.PREAMBLE_MSB, 0x00, 0x08);
  write(d, SX_REG.FIFO_TX_BASE_ADDR, 0x80);
  write(d, SX_REG.FIFO_RX_BASE_ADDR, 0x00);
  write(d, SX_REG.OP_MODE, 0x80 | SX_MODE.STANDBY);
}

function send(d: Sx1278Device, payload: number[]): void {
  write(d, SX_REG.FIFO_ADDR_PTR, 0x80);
  spi(d, [0x80 | SX_REG.FIFO, ...payload]);
  write(d, SX_REG.PAYLOAD_LENGTH, payload.length);
  write(d, SX_REG.OP_MODE, 0x80 | SX_MODE.TX);
}

// ================================================ 1. it answers as a chip ====
section('1. the register file is an SX1278');
{
  const m = new RfMedium();
  const d = new Sx1278Device('l', 'nss', m, () => 0);

  check(read(d, SX_REG.VERSION) === 0x12, 'RegVersion reads 0x12, which is what every library checks first');
  check(read(d, SX_REG.SYNC_WORD) === 0x12, 'and the sync word resets to 0x12');
  check(!d.loraMode, 'the chip wakes in FSK mode, as the hardware does');

  write(d, SX_REG.OP_MODE, 0x80 | SX_MODE.SLEEP);
  check(d.loraMode, 'setting LongRangeMode enters LoRa');

  // The address byte's top bit is the read/write flag, and getting that wrong
  // would make every write a read.
  write(d, SX_REG.PAYLOAD_LENGTH, 42);
  check(read(d, SX_REG.PAYLOAD_LENGTH) === 42, 'a written register reads back');
  check(read(d, SX_REG.VERSION) === 0x12, 'and a read-only register does not change');
  write(d, SX_REG.VERSION, 0x99);
  check(read(d, SX_REG.VERSION) === 0x12, 'even when written to');

  // Burst access walks the register file, which is how libraries read Frf.
  const [msb, mid, lsb] = frfFor(433_000_000);
  write(d, SX_REG.FRF_MSB, msb, mid, lsb);
  const burst = spi(d, [SX_REG.FRF_MSB, 0, 0, 0]).slice(1);
  check(burst.join(',') === [msb, mid, lsb].join(','), `a burst read walks forward (${burst.join(',')})`);
  check(Math.abs(d.frequencyHz - 433_000_000) < 100, `and decodes to 433 MHz (${d.frequencyHz} Hz)`);

  // The FIFO does not walk the register file — it walks its own pointer.
  write(d, SX_REG.FIFO_ADDR_PTR, 0x10);
  spi(d, [0x80 | SX_REG.FIFO, 0xaa, 0xbb, 0xcc]);
  check(read(d, SX_REG.FIFO_ADDR_PTR) === 0x13, 'writing the FIFO advances RegFifoAddrPtr');
  check(d.fifoByte(0x10) === 0xaa && d.fifoByte(0x12) === 0xcc, 'and the bytes land where the pointer said');

  // Write-one-to-clear on the interrupt flags.
  write(d, SX_REG.IRQ_FLAGS, 0xff);
  check(read(d, SX_REG.IRQ_FLAGS) === 0, 'the IRQ flags clear on a write of one');
}

// ================================================= 2. airtime is the point ===
section('2. time on air comes from the datasheet, not from a guess');
{
  const m = new RfMedium();
  const d = new Sx1278Device('l', 'nss', m, () => 0);

  configure(d, { sf: 7 });
  const sf7 = d.airtimeUs(16);
  configure(d, { sf: 12 });
  const sf12 = d.airtimeUs(16);
  console.log(`   16 bytes: SF7 ${(sf7 / 1000).toFixed(1)} ms, SF12 ${(sf12 / 1000).toFixed(1)} ms`);

  // The datasheet numbers for 16 bytes, explicit header, CRC on, CR 4/5,
  // 125 kHz, 8-symbol preamble. Worked through by hand: the symbol time is
  // 2^SF/BW, the preamble is 12.25 symbols, and the payload comes to 38
  // symbols at SF7 and 23 at SF12 — 51.5 ms against 1155 ms.
  check(Math.abs(sf7 / 1000 - 51.5) < 0.5, `SF7 is 51.5 ms (${(sf7 / 1000).toFixed(1)})`);
  check(Math.abs(sf12 / 1000 - 1155) < 5, `SF12 is 1.155 seconds (${(sf12 / 1000).toFixed(0)} ms)`);
  check(sf12 / sf7 > 20, `which is more than twenty times longer (${(sf12 / sf7).toFixed(0)}x)`);

  // Bandwidth halves the airtime when it doubles, because the symbol time is
  // 2^SF over the bandwidth.
  configure(d, { sf: 7, bwIndex: 7 });
  const bw125 = d.airtimeUs(16);
  configure(d, { sf: 7, bwIndex: 8 });
  const bw250 = d.airtimeUs(16);
  check(Math.abs(bw125 / bw250 - 2) < 0.01, `doubling the bandwidth halves the air (${(bw125 / bw250).toFixed(2)}x)`);

  // And a real transmission occupies exactly that much of the medium.
  configure(d, { sf: 9 });
  const expected = d.airtimeUs(8);
  send(d, [1, 2, 3, 4, 5, 6, 7, 8]);
  const t = m.lastTransmission;
  check(t !== undefined, 'entering TX puts a transmission in the air');
  if (t) {
    check(Math.abs(t.endUs - t.startUs - expected) < 1, `occupying ${((t.endUs - t.startUs) / 1000).toFixed(1)} ms`);
    check(t.band === RF_BAND, 'on the shared band');
    check(t.channel === 433_000, `at 433 000 kHz (${t.channel})`);
    check(t.match.modulation === 'lora', 'marked as LoRa modulation');
    check(t.match.sf === 9 && t.match.bw === 125_000, 'carrying the modem settings a receiver must match');
  }
}

// ====================================== 3. two modules, and the negatives ====
section('3. a link needs every setting to agree');
{
  const pair = (rxSetup: Setup) => {
    const m = new RfMedium();
    let now = 0;
    const tx = new Sx1278Device('tx', 'nss', m, () => now);
    const rx = new Sx1278Device('rx', 'nss', m, () => now);
    configure(tx, {});
    configure(rx, rxSetup);
    write(rx, SX_REG.OP_MODE, 0x80 | SX_MODE.RX_CONTINUOUS);
    send(tx, [0x4c, 0x6f, 0x52, 0x61]);
    now = 500_000; // well past any airtime used here
    rx.radioReceive();
    tx.radioTransmit();
    return { m, tx, rx };
  };

  const good = pair({});
  check(good.rx.receivedCount === 1, 'matching settings receive the packet');
  check((read(good.rx, SX_REG.IRQ_FLAGS) & IRQ_RX_DONE) !== 0, 'RxDone is raised');
  check(read(good.rx, SX_REG.RX_NB_BYTES) === 4, 'with the length in RegRxNbBytes');
  check(good.rx.irqAsserted, 'and DIO0 would be high');
  check((read(good.tx, SX_REG.IRQ_FLAGS) & IRQ_TX_DONE) !== 0, 'the transmitter saw TxDone');

  check(pair({ hz: 868_000_000 }).rx.receivedCount === 0, 'a different frequency hears nothing');
  check(pair({ sf: 10 }).rx.receivedCount === 0, 'a different spreading factor hears nothing');
  check(pair({ bwIndex: 8 }).rx.receivedCount === 0, 'a different bandwidth hears nothing');
  check(pair({ sync: 0x34 }).rx.receivedCount === 0, 'and a different sync word hears nothing');

  // Silence is a terrible diagnostic, so the module can say what differs.
  const m = new RfMedium();
  const a = new Sx1278Device('a', 'nss', m, () => 0);
  const b = new Sx1278Device('b', 'nss', m, () => 0);
  configure(a, {});
  configure(b, { sf: 11 });
  const why = a.explainDeafnessTo(b);
  check(why !== null && /spreading factor/.test(why), `and can explain why ("${why}")`);
  configure(b, {});
  check(a.explainDeafnessTo(b) === null, 'with nothing to explain when they agree');
}

// ============================================== 4. reading the FIFO back =====
section('4. the payload comes out of the FIFO where the chip put it');
{
  const m = new RfMedium();
  let now = 0;
  const tx = new Sx1278Device('tx', 'nss', m, () => now);
  const rx = new Sx1278Device('rx', 'nss', m, () => now);
  configure(tx, {});
  configure(rx, {});
  write(rx, SX_REG.OP_MODE, 0x80 | SX_MODE.RX_CONTINUOUS);

  send(tx, [0xca, 0xfe, 0xba, 0xbe]);
  now = 500_000;
  rx.radioReceive();

  const length = read(rx, SX_REG.RX_NB_BYTES);
  const current = read(rx, SX_REG.FIFO_RX_CURRENT_ADDR);
  write(rx, SX_REG.FIFO_ADDR_PTR, current);
  const bytes = spi(rx, [SX_REG.FIFO, 0, 0, 0, 0]).slice(1);
  check(length === 4, `RegRxNbBytes says four (${length})`);
  check(bytes.map((b) => b.toString(16)).join('') === 'cafebabe', `and the FIFO holds them (${bytes.map((b) => b.toString(16)).join(' ')})`);
}

// ================================================== 5. collisions destroy ====
section('5. two transmitters on one frequency wreck each other');
{
  const m = new RfMedium();
  let now = 0;
  const a = new Sx1278Device('a', 'nss', m, () => now);
  const b = new Sx1278Device('b', 'nss', m, () => now);
  const listener = new Sx1278Device('c', 'nss', m, () => now);
  for (const d of [a, b, listener]) configure(d, {});
  write(listener, SX_REG.OP_MODE, 0x80 | SX_MODE.RX_CONTINUOUS);

  send(a, [1, 1, 1, 1]);
  send(b, [2, 2, 2, 2]);
  now = 500_000;
  listener.radioReceive();

  check(listener.receivedCount === 0, 'no clean packet is delivered');
  check(listener.corruptedCount > 0, `and the corruption is recorded (${listener.corruptedCount})`);
  check((read(listener, SX_REG.IRQ_FLAGS) & IRQ_CRC_ERROR) !== 0, 'with PayloadCrcError raised, as a real modem does');

  // A LoRa module and a radio of another family on the SAME frequency also
  // collide — energy is energy — but neither can demodulate the other.
  const m2 = new RfMedium();
  const lora = new Sx1278Device('l', 'nss', m2, () => 0);
  configure(lora, {});
  write(lora, SX_REG.OP_MODE, 0x80 | SX_MODE.RX_CONTINUOUS);
  m2.transmit({
    transmitterId: 'other-family', band: RF_BAND, channel: 433_000,
    startUs: 0, endUs: 1000, payload: Uint8Array.from([9, 9]),
    match: { modulation: 'ook' },
  });
  lora.radioReceive();
  check(lora.receivedCount === 0, 'and a different modulation on the same frequency is not demodulated');
}

// ==================== 6. real firmware, real SPI, two real boards ============
section('6. board A firmware to board B firmware, over SPI and the air');
{
  // No library. The sketch writes the registers itself, which is the point:
  // what is being exercised is the chip's interface.
  const SOURCE = [
    '#include <SPI.h>',
    '#define NSS 10',
    'bool isTx;',
    'void wreg(uint8_t reg, uint8_t v) {',
    '  digitalWrite(NSS, LOW); SPI.transfer(reg | 0x80); SPI.transfer(v); digitalWrite(NSS, HIGH);',
    '}',
    'uint8_t rreg(uint8_t reg) {',
    '  digitalWrite(NSS, LOW); SPI.transfer(reg & 0x7F);',
    '  uint8_t v = SPI.transfer(0x00); digitalWrite(NSS, HIGH); return v;',
    '}',
    'void setup() {',
    '  Serial.begin(9600);',
    '  pinMode(4, INPUT_PULLUP);',
    '  pinMode(NSS, OUTPUT); digitalWrite(NSS, HIGH);',
    '  SPI.begin();',
    '  delay(10);',
    '  isTx = digitalRead(4) == LOW;',
    '  if (rreg(0x42) != 0x12) { Serial.println("NOCHIP"); return; }',
    '  wreg(0x01, 0x80);',            // LoRa sleep
    '  wreg(0x06, 0x6C); wreg(0x07, 0x40); wreg(0x08, 0x00);', // 433 MHz
    '  wreg(0x1D, 0x72);',            // BW 125 kHz, CR 4/5, explicit header
    '  wreg(0x1E, 0x74);',            // SF7, CRC on
    '  wreg(0x39, 0x12);',            // sync word
    '  wreg(0x20, 0x00); wreg(0x21, 0x08);',
    '  wreg(0x0E, 0x80); wreg(0x0F, 0x00);',
    '  wreg(0x12, 0xFF);',            // clear the flags
    '  wreg(0x01, 0x81);',            // standby
    '  if (isTx) {',
    '    wreg(0x0D, 0x80);',
    '    digitalWrite(NSS, LOW); SPI.transfer(0x80);',
    '    SPI.transfer(0x4C); SPI.transfer(0x6F); SPI.transfer(0x52); SPI.transfer(0x61);',
    '    digitalWrite(NSS, HIGH);',
    '    wreg(0x22, 4);',
    '    wreg(0x01, 0x83);',          // TX
    '  } else {',
    '    wreg(0x01, 0x85);',          // RX continuous
    '  }',
    '}',
    'bool done = false;',
    'void loop() {',
    '  if (done) return;',
    '  uint8_t flags = rreg(0x12);',
    '  if (isTx) {',
    '    if (flags & 0x08) { Serial.println("TX=DONE"); done = true; }',
    '  } else if (flags & 0x40) {',
    '    uint8_t n = rreg(0x13);',
    '    wreg(0x0D, rreg(0x10));',
    '    Serial.print("RX=");',
    '    digitalWrite(NSS, LOW); SPI.transfer(0x00);',
    '    for (uint8_t i = 0; i < n; i++) Serial.write(SPI.transfer(0x00));',
    '    digitalWrite(NSS, HIGH);',
    '    Serial.println();',
    '    wreg(0x12, 0xFF);',
    '    done = true;',
    '  }',
    '}',
  ].join('\n');

  const p = emptyProject('lora');
  const boardA = inst('board.arduino-uno');
  const boardB = inst('board.arduino-uno');
  const loraA = inst('comp.lora-sx1278');
  const loraB = inst('comp.lora-sx1278');
  p.boardInstances.push(boardA, boardB);
  p.componentInstances.push(loraA, loraB);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];

  const hookUp = (board: ComponentInstance, radio: ComponentInstance) => {
    wire(p, board.id, '3V3', radio.id, 'vcc');
    wire(p, board.id, 'GND_TOP', radio.id, 'gnd');
    wire(p, board.id, 'D13', radio.id, 'sck');
    wire(p, board.id, 'D11', radio.id, 'mosi');
    wire(p, board.id, 'D12', radio.id, 'miso');
    wire(p, board.id, 'D10', radio.id, 'nss');
    wire(p, board.id, 'D2', radio.id, 'dio0');
  };
  hookUp(boardA, loraA);
  hookUp(boardB, loraB);
  wire(p, boardA.id, 'D4', boardA.id, 'GND_PWR1'); // board A transmits

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the two-board LoRa test cannot run');
  } else {
    simulationController.pause();
    // An SF7 packet is about 37 ms on air; give it several times that.
    simulationController.advance(500);
    simulationController.publishNow();

    const binding = (simulationController as unknown as { binding: { spiDevices: unknown[] } | null }).binding;
    const radios = (binding?.spiDevices ?? []).filter((d): d is Sx1278Device => d instanceof Sx1278Device);
    check(radios.length === 2, `both modules attached to their boards' SPI (${radios.length})`);
    for (const r of radios) console.log(`   module: ${r.snapshot().status}`);

    check(radios.some((r) => r.sentCount > 0), 'one module transmitted');
    check(radios.some((r) => r.receivedCount > 0), 'and the other received');

    const serial = useSimulationStore.getState().serialText;
    console.log(`   serial: ${JSON.stringify(serial.trim().split('\n').slice(-3))}`);
    check(!/NOCHIP/.test(serial), 'both sketches found a chip answering RegVersion');
    check(/RX=LoRa/.test(serial), "board B's firmware read the payload out of its own FIFO");
    check(/TX=DONE/.test(serial), "and board A's firmware saw TxDone");
  }
  simulationController.stop();
}

// ================================================= 7. the part as shipped ====
section('7. the SX1278 in the library');
{
  const def = defOf('comp.lora-sx1278');
  check(def !== undefined, 'the SX1278 is in the library');
  if (def) {
    check(def.supportLevel === 'simulated', 'badged Simulated');
    for (const pinId of ['sck', 'mosi', 'miso', 'nss', 'dio0', 'rst', 'vcc', 'gnd']) {
      check(def.pins.some((pp) => pp.id === pinId), `it exposes ${pinId}`);
    }
    check(/SF12/.test(def.description ?? ''), 'and names the airtime difference that matters');
    check(/RSSI, SNR, link budget/.test(def.description ?? ''), 'and what it does not claim');
  }
  const cov = COMPONENT_COVERAGE.find((c) => c.id === 'comp.lora-sx1278');
  check(cov?.status === 'simulated', 'recorded as simulated');
  check((cov?.tests ?? []).includes('tests/rf.lora.mts'), 'and names this file as its proof');
  // `dependencies` on a FINISHED part is what it rests on, not what it waits
  // for. Asserting it is empty would quietly undo that: the point of recording
  // the shared radio medium here is that the next part built on it can be
  // estimated honestly, and the coverage audit derives "this primitive exists"
  // from exactly these rows.
  check((cov?.dependencies ?? []).includes('rf-channel'), 'and records the primitive it rests on');
}

console.log(
  failures === 0
    ? `\nLoRa checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
