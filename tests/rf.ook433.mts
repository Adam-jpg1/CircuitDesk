// The 433 MHz pair: a wire made of air.
//
// These modules have no protocol, and the point of this test is that the model
// does not invent one. Whatever the sketch puts on the transmitter's DATA pin
// comes out of the receiver's DATA pin at the same timing, so the encoding
// lives in the firmware — which is why these things get used for doorbells,
// garage doors and a hundred incompatible remotes.
//
// Section 3 is the acceptance and it is deliberately awkward: board A bangs out
// a pulse train of its own invention, board B measures the pulse widths with
// micros() in a pin-change interrupt and prints them back. If the medium were
// packet-oriented, or if the timing were quantised to a scheduling slice, the
// widths would come back wrong and the test would say so.

import { Ook433Receiver, Ook433Transmitter, OOK_MODULATION, OOK_DEFAULT_KHZ } from '../src/simulation/devices/ook433';
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
const inst = (definitionId: string, properties: Record<string, unknown> = {}): ComponentInstance => ({
  id: uid('c'), definitionId, x: 0, y: 0, rotation: 0, properties, simulationState: {},
});
function wire(p: CircuitProject, a: string, ap: string, b: string, bp: string) {
  p.connections.push({
    id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
    netId: '', color: '#000', points: [], routing: 'smooth',
  } as CircuitProject['connections'][number]);
}

const listenerOn = (khz: number) => ({ band: RF_BAND, channel: khz, match: { modulation: OOK_MODULATION } });

// =========================================== 1. the carrier is a waveform ====
section('1. keying the pin keys the carrier');
{
  const m = new RfMedium();
  const tx = new Ook433Transmitter('tx');
  const key = (high: boolean, us: number) => {
    tx.noteKeyed(high);
    if (high) m.beginLive(tx.instanceId, tx.frequencyKhz, us, { modulation: OOK_MODULATION });
    else m.endLive(tx.instanceId, us);
  };

  check(!m.energisedBy(listenerOn(OOK_DEFAULT_KHZ), 0).length, 'the air starts quiet');
  key(true, 1000);
  check(m.energisedBy(listenerOn(OOK_DEFAULT_KHZ), 1500).length === 1, 'DATA high puts a carrier there');
  check(m.isLive('tx'), 'and it stays on with no end yet, because nothing knows when the sketch will stop');
  key(false, 1350);
  check(!m.isLive('tx'), 'DATA low ends it');
  check(m.energisedBy(listenerOn(OOK_DEFAULT_KHZ), 1200).length === 1, 'the mark covers the time it was on');
  check(m.energisedBy(listenerOn(OOK_DEFAULT_KHZ), 1400).length === 0, 'and nothing after');

  // A receiver on another frequency hears none of it.
  check(m.energisedBy(listenerOn(315_000), 1200).length === 0, 'a 315 MHz receiver hears nothing');
}

// ========================================= 2. the receiver follows edges =====
section('2. the receiver reproduces the pulse widths');
{
  const m = new RfMedium();
  const tx = new Ook433Transmitter('tx');
  const rx = new Ook433Receiver('rx');
  const listener = listenerOn(OOK_DEFAULT_KHZ);

  // A short train of the kind an encoder emits: 350 us sync, then a few bits.
  const train: [boolean, number][] = [
    [true, 0], [false, 350], [true, 1400], [false, 1750], [true, 2100], [false, 3150],
  ];
  for (const [high, at] of train) {
    if (high) m.beginLive('tx', tx.frequencyKhz, at, { modulation: OOK_MODULATION });
    else m.endLive('tx', at);
  }
  for (const t of m.waveformTransitions(listener, -1, 10_000)) {
    const state = m.sampleWaveform(listener, t);
    rx.setEnergised(state.energised, t, state.sources);
  }

  check(rx.edgeCount === 6, `every edge arrived (${rx.edgeCount})`);
  const widths = rx.recentPulses;
  check(widths.join(',') === '350,1050,350,350,1050', `with the widths intact (${widths.join(',')} us)`);
  check(!rx.outputHigh, 'and it ends low');
}

// =================== 3. real firmware banging its own encoding across =======
section('3. board A invents an encoding and board B measures it');
{
  // Deliberately not a standard protocol: the sketch makes one up, which is
  // the whole point of these modules. Board B measures the widths with
  // micros() and prints them, so a model that quantised the timing to a
  // scheduling slice would be caught immediately.
  const SOURCE = [
    '#define TX 3',
    '#define RX 2',
    'bool isTx;',
    'volatile uint32_t last = 0;',
    'volatile uint16_t widths[8];',
    'volatile uint8_t n = 0;',
    'void onEdge() {',
    '  uint32_t now = micros();',
    '  if (last != 0 && n < 8) widths[n++] = (uint16_t)(now - last);',
    '  last = now;',
    '}',
    'void setup() {',
    '  Serial.begin(9600);',
    '  pinMode(4, INPUT_PULLUP);',
    '  delay(5);',
    '  isTx = digitalRead(4) == LOW;',
    '  if (isTx) {',
    '    pinMode(TX, OUTPUT); digitalWrite(TX, LOW);',
    '    delay(20);',
    // 400 / 800 / 400 / 1600 microseconds, all well inside one scheduling slice
    '    digitalWrite(TX, HIGH); delayMicroseconds(400);',
    '    digitalWrite(TX, LOW);  delayMicroseconds(800);',
    '    digitalWrite(TX, HIGH); delayMicroseconds(400);',
    '    digitalWrite(TX, LOW);  delayMicroseconds(1600);',
    '    digitalWrite(TX, HIGH); delayMicroseconds(400);',
    '    digitalWrite(TX, LOW);',
    '  } else {',
    '    pinMode(RX, INPUT);',
    '    attachInterrupt(digitalPinToInterrupt(RX), onEdge, CHANGE);',
    '  }',
    '}',
    'bool printed = false;',
    'void loop() {',
    '  if (isTx || printed) return;',
    '  if (n >= 5 && micros() - last > 20000) {',
    '    Serial.print("W=");',
    '    for (uint8_t i = 0; i < 5; i++) { Serial.print(widths[i]); Serial.print(i < 4 ? "," : ""); }',
    '    Serial.println();',
    '    printed = true;',
    '  }',
    '}',
  ].join('\n');

  const p = emptyProject('ook433');
  const boardA = inst('board.arduino-uno');
  const boardB = inst('board.arduino-uno');
  const txMod = inst('comp.rf433-tx');
  const rxMod = inst('comp.rf433-rx');
  p.boardInstances.push(boardA, boardB);
  p.componentInstances.push(txMod, rxMod);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];

  wire(p, boardA.id, '5V', txMod.id, 'vcc');
  wire(p, boardA.id, 'GND_TOP', txMod.id, 'gnd');
  wire(p, boardA.id, 'D3', txMod.id, 'data');
  wire(p, boardA.id, 'D4', boardA.id, 'GND_PWR1'); // board A transmits
  wire(p, boardB.id, '5V', rxMod.id, 'vcc');
  wire(p, boardB.id, 'GND_TOP', rxMod.id, 'gnd');
  wire(p, boardB.id, 'D2', rxMod.id, 'data');

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the two-board 433 MHz test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(300);
    simulationController.publishNow();

    const binding = (simulationController as unknown as {
      binding: { ookDeviceFor(id: string): unknown } | null;
    }).binding;
    const txModel = binding?.ookDeviceFor(txMod.id);
    const rxModel = binding?.ookDeviceFor(rxMod.id);
    if (txModel instanceof Ook433Transmitter) console.log(`   tx: ${txModel.snapshot().status}`);
    if (rxModel instanceof Ook433Receiver) console.log(`   rx: ${rxModel.snapshot().status}`);

    check(txModel instanceof Ook433Transmitter && txModel.markCount === 3, 'the transmitter keyed three marks');
    check(rxModel instanceof Ook433Receiver && rxModel.edgeCount >= 5, 'and the receiver saw every edge');

    const serial = useSimulationStore.getState().serialText;
    console.log(`   serial: ${JSON.stringify(serial.trim().split('\n').slice(-2))}`);
    const measured = /W=([\d,]+)/.exec(serial);
    check(measured !== null, "board B's firmware measured the pulses off its own pin");
    if (measured) {
      const widths = measured[1].split(',').map(Number);
      // Allow for digitalWrite and interrupt overhead on a real AVR; what must
      // not happen is quantisation to a scheduling slice.
      const want = [400, 800, 400, 1600, 400];
      const close = widths.every((w, i) => Math.abs(w - want[i]) < 60);
      check(close, `and got back what was sent (${widths.join(',')} vs ${want.join(',')})`);
    }
  }
  simulationController.stop();
}

// ============================== 4. frequency and overlap, the negatives ======
section('4. the wrong frequency and two transmitters at once');
{
  const m = new RfMedium();
  m.beginLive('a', 433_920, 0, { modulation: OOK_MODULATION });
  m.endLive('a', 1000);

  const deaf = new Ook433Receiver('deaf', 315_000);
  for (const t of m.waveformTransitions(listenerOn(315_000), -1, 10_000)) {
    deaf.setEnergised(m.sampleWaveform(listenerOn(315_000), t).energised, t);
  }
  check(deaf.edgeCount === 0, 'a receiver on another frequency never moves');

  // Two transmitters keyed together: the receiver sees one continuous mark
  // covering both, which is what a detector with no way to tell them apart
  // would produce — and a decoder gets nonsense from it.
  const m2 = new RfMedium();
  m2.beginLive('a', 433_920, 0, { modulation: OOK_MODULATION });
  m2.beginLive('b', 433_920, 500, { modulation: OOK_MODULATION });
  m2.endLive('a', 1000);
  m2.endLive('b', 1500);

  const rx = new Ook433Receiver('rx');
  const listener = listenerOn(433_920);
  for (const t of m2.waveformTransitions(listener, -1, 10_000)) {
    const state = m2.sampleWaveform(listener, t);
    rx.setEnergised(state.energised, t, state.sources);
  }
  check(rx.edgeCount === 2, `the two overlapping marks merge into one (${rx.edgeCount} edges)`);
  check(rx.recentPulses[0] === 1500, `whose width is neither transmitter's (${rx.recentPulses[0]} us)`);
  check(rx.collisionCount > 0, `and the overlap is recorded (${rx.collisionCount})`);

  // A LoRa packet on the same frequency is heard as energy but is not OOK, so
  // an OOK receiver's detector does move — energy is energy. It is not
  // demodulated into anything, because there is nothing to demodulate.
  const m3 = new RfMedium();
  m3.transmit({
    transmitterId: 'lora', band: RF_BAND, channel: 433_920,
    startUs: 0, endUs: 5000, payload: Uint8Array.from([1, 2]),
    match: { modulation: 'lora', sf: 7, bw: 125_000, sync: 0x12 },
  });
  check(
    m3.energisedBy(listenerOn(433_920), 1000).length === 0,
    'a LoRa packet is not delivered to an OOK detector as OOK',
  );
}

// ================================================= 5. the parts as shipped ===
section('5. the 433 MHz pair in the library');
{
  const tx = defOf('comp.rf433-tx');
  const rx = defOf('comp.rf433-rx');
  check(tx !== undefined && rx !== undefined, 'both modules are in the library');
  if (tx) {
    check(tx.supportLevel === 'simulated', 'the transmitter is badged Simulated');
    check(tx.pins.some((p) => p.id === 'data'), 'with a DATA pin');
    check(/no protocol at all/.test(tx.description ?? ''), 'and says it has no protocol');
  }
  if (rx) {
    check(/KINDER than the hardware/.test(rx.description ?? ''), 'the receiver admits where it is kinder than reality');
    check(/noise/.test(rx.description ?? ''), 'and names the noise it does not model');
  }
  for (const id of ['comp.rf433-tx', 'comp.rf433-rx']) {
    const cov = COMPONENT_COVERAGE.find((c) => c.id === id);
    check(cov?.status === 'simulated', `${id} is recorded as simulated`);
    check((cov?.tests ?? []).includes('tests/rf.ook433.mts'), `${id} names this file as its proof`);
    check((cov?.dependencies ?? []).length === 0, `${id} has no blocker left`);
  }
}

console.log(
  failures === 0
    ? `\n433 MHz checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
