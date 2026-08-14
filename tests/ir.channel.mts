// Infrared as a channel, not a message bus.
//
// The thing being proved here is a negative as much as a positive. A remote in
// this simulator cannot name a receiver: it flashes an LED into one shared
// medium, and every receiver that can see the light decodes whatever arrives.
// So the tests check that a code gets through, and equally that a second
// remote pressed at the same time WRECKS it, that a receiver tuned to another
// carrier hears nothing, and that firmware gets its data by decoding the pin
// itself rather than being handed a command.
//
// The last one matters most. The sketch in section 5 contains a hand-written
// NEC decoder — no library, timing measured with micros() on a pin-change
// interrupt — so if the receiver's output did not carry real mark and space
// timing on the microsecond clock, the sketch would decode nothing.

import { IrMedium, carrierHeard } from '../src/simulation/devices/irMedium';
import {
  NEC_TIMING, NEC_CARRIER_HZ, atTime, decodeNecMarks, necFrameMarks, necRepeatMarks,
} from '../src/simulation/devices/necCodec';
import { IrReceiverDevice, STARTER_REMOTE_KEYS } from '../src/simulation/devices/irParts';
import { contactStateKey } from '../src/simulation/devices/contacts';
import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject } from '../src/project/templates';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import { COMPONENT_COVERAGE } from '../src/components-library/componentCoverage';
import { interactiveHotspots } from '../src/components-library/artwork/interactiveGeometry';
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

// ============================================ 1. the NEC timings are real ===
section('1. NEC frames carry the timings a decoder expects');
{
  const marks = necFrameMarks(0x00, 0x45);
  check(marks.length === 34, `a frame is a leader, 32 bits and a stop mark (${marks.length})`);
  check(marks[0].endUs - marks[0].startUs === NEC_TIMING.leaderMarkUs, '9 ms leader mark');
  check(marks[1].startUs - marks[0].endUs === NEC_TIMING.leaderSpaceUs, 'then a 4.5 ms space');

  // Bit 0 of 0x00 is a zero and bit 0 of the inverted address is a one, so the
  // two space lengths both appear in the first two bits of any frame.
  const space0 = marks[2].startUs - marks[1].endUs;
  check(space0 === NEC_TIMING.zeroSpaceUs, `a zero is a short space (${space0} us)`);

  const decoded = decodeNecMarks(marks);
  check(decoded.kind === 'frame', 'a frame decodes');
  if (decoded.kind === 'frame') {
    check(decoded.frame.address === 0x00 && decoded.frame.command === 0x45, 'to the address and command it was built from');
    check(!decoded.frame.extended, 'as standard NEC');
  }

  const ext = decodeNecMarks(necFrameMarks(0x2010, 0x12, true));
  check(ext.kind === 'frame' && ext.frame.address === 0x2010, 'an extended frame keeps its 16-bit address');

  check(decodeNecMarks(necRepeatMarks()).kind === 'repeat', 'a repeat burst decodes as a repeat, not a frame');

  // The inverted-command byte is a checksum and has to be enforced, because a
  // corrupted frame is exactly what a collision produces.
  const broken = necFrameMarks(0x00, 0x45);
  broken[20] = { startUs: broken[20].startUs, endUs: broken[20].startUs + 560 };
  const shifted = broken.map((m, i) => (i > 20 ? { startUs: m.startUs + 1130, endUs: m.endUs + 1130 } : m));
  const bad = decodeNecMarks(shifted);
  check(bad.kind !== 'frame', `a frame with a flipped bit does not decode as valid (${bad.kind})`);
}

// ================================================= 2. the medium is shared ===
section('2. the medium is a room, not a wire');
{
  const medium = new IrMedium();
  medium.emit('remote-a', NEC_CARRIER_HZ, atTime(necFrameMarks(0, 0x45), 1_000_000));

  check(medium.illuminated(38000, 1_000_000), 'a 38 kHz receiver sees the leader');
  check(!medium.illuminated(38000, 1_009_500), 'and the leader space is dark');
  check(medium.litBy(38000, 1_000_000).length === 1, 'from exactly one emitter');

  // Passband, not a match: a 56 kHz module hears nothing from a 38 kHz remote.
  check(!carrierHeard(56000, 38000), 'a 56 kHz module is out of band for a 38 kHz carrier');
  check(!medium.illuminated(56000, 1_000_000), 'so it stays dark through the whole burst');
  check(carrierHeard(38000, 40000), 'but 40 kHz is inside a 38 kHz passband');

  // Nothing here is addressed, so a second receiver on the same carrier sees
  // the identical thing. That is the property, not a coincidence.
  check(medium.illuminated(38000, 1_000_100), 'every 38 kHz receiver sees the same air');
}

// ======================================= 3. two remotes at once collide ======
section('3. two transmitters are not arbitrated');
{
  const medium = new IrMedium();
  const clean = new IrReceiverDevice('rx-clean');
  const play = (rx: IrReceiverDevice, start: number, end: number) => {
    for (const t of medium.transitionsAfter(rx.centreHz, start - 1, end)) {
      rx.setIlluminated(medium.sample(rx.centreHz, t).illuminated, t);
    }
    rx.flushIfIdle(end + 100000);
  };

  medium.emit('a', NEC_CARRIER_HZ, atTime(necFrameMarks(0, 0x45), 1_000_000));
  play(clean, 1_000_000, 1_100_000);
  check(clean.frameCount === 1, 'one remote alone decodes cleanly');
  check(clean.command === 0x45, `to command 0x${(clean.command ?? 0).toString(16)}`);

  const messy = new IrReceiverDevice('rx-messy');
  const medium2 = new IrMedium();
  medium2.emit('a', NEC_CARRIER_HZ, atTime(necFrameMarks(0, 0x45), 2_000_000));
  // The second remote starts 3 ms in, part-way through the other's leader.
  medium2.emit('b', NEC_CARRIER_HZ, atTime(necFrameMarks(0, 0x18), 2_003_000));
  for (const t of medium2.transitionsAfter(38000, 1_999_999, 2_200_000)) {
    messy.setIlluminated(medium2.sample(38000, t).illuminated, t);
  }
  messy.flushIfIdle(2_300_000);
  check(messy.frameCount === 0, 'two remotes at once decode to nothing');
  check(messy.undecodableCount >= 1, `and the failure is recorded (${messy.undecodableCount})`);
  check(medium2.collisionCount > 0, `with the overlap counted (${medium2.collisionCount})`);
  check(messy.command === null, 'no command is invented from the wreckage');
}

// ============================== 4. a held key repeats, it does not re-send ===
section('4. holding a key sends repeat codes');
{
  const marks = necRepeatMarks();
  check(marks.length === 2, 'a repeat is a leader and one mark');
  const space = marks[1].startUs - marks[0].endUs;
  check(space === NEC_TIMING.repeatSpaceUs, `with the short 2.25 ms space (${space} us)`);
  check(decodeNecMarks(marks).kind === 'repeat', 'and is not mistaken for a frame');
  check(NEC_TIMING.repeatPeriodUs === 108000, 'repeats are 108 ms apart, frame start to frame start');
}

// ================== 5. an executed sketch decoding the pin for itself ========
section('5. firmware decodes the receiver pin with its own timing');
{
  // A hand-written NEC decoder. No library, no help: it measures the gaps
  // between falling edges on the receiver's output and reconstructs the bits.
  // Nothing hands it a command — if the pin did not carry real timing this
  // would print nothing at all.
  const SOURCE = [
    'volatile uint32_t lastUs = 0;',
    'volatile uint8_t idx = 0;',
    'volatile uint32_t bits = 0;',
    'volatile bool ready = false;',
    'volatile uint32_t code = 0;',
    'void onEdge() {',
    '  uint32_t now = micros();',
    '  uint32_t gap = now - lastUs;',
    '  lastUs = now;',
    '  if (gap > 12000) { idx = 0; bits = 0; return; }',   // leader: 9000 + 4500
    '  if (idx < 32) {',
    '    if (gap > 1600) bits |= (1UL << idx);',
    '    idx++;',
    '    if (idx == 32) { code = bits; ready = true; }',
    '  }',
    '}',
    'void setup() {',
    '  Serial.begin(9600);',
    '  pinMode(2, INPUT);',
    '  attachInterrupt(digitalPinToInterrupt(2), onEdge, FALLING);',
    '}',
    'void loop() {',
    '  if (ready) {',
    '    ready = false;',
    '    uint8_t cmd = (code >> 16) & 0xFF;',
    '    uint8_t inv = (code >> 24) & 0xFF;',
    '    Serial.print("CMD=");',
    '    Serial.print(cmd, HEX);',
    '    Serial.print(" OK=");',
    '    Serial.println((uint8_t)(cmd ^ inv) == 0xFF ? 1 : 0);',
    '  }',
    '}',
  ].join('\n');

  const p = emptyProject('ir');
  const board = inst('board.arduino-uno');
  const rx = inst('comp.ir-receiver');
  const remote = inst('comp.ir-remote', { address: 0 });
  p.boardInstances.push(board);
  p.componentInstances.push(rx, remote);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  wire(p, board.id, '5V', rx.id, 'vcc');
  wire(p, board.id, 'GND_TOP', rx.id, 'gnd');
  wire(p, board.id, 'D2', rx.id, 'out');

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the wired IR test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(60);

    // Press "5", which is NEC command 0x1C on this key set.
    const five = STARTER_REMOTE_KEYS.find((k) => k.key === 'five');
    const stateKey = contactStateKey(remote.id, 'five');
    const sim = useSimulationStore.getState();
    sim.pressButton(stateKey, true);
    simulationController.advance(5);
    sim.pressButton(stateKey, false);
    // A NEC frame is about 68 ms long; give it room to finish and be decoded.
    simulationController.advance(140);
    simulationController.publishNow();

    const binding = (simulationController as unknown as {
      binding: { irDeviceFor(id: string): unknown } | null;
    }).binding;
    const model = binding?.irDeviceFor(rx.id);
    if (model instanceof IrReceiverDevice) {
      console.log(`   module: ${model.snapshot().status}`);
      check(model.frameCount >= 1, `the receiver demodulated a frame (${model.frameCount})`);
      check(model.command === five?.command, `carrying command 0x${(model.command ?? 0).toString(16)}`);
    } else {
      check(false, 'the receiver model was reachable from the binding');
    }

    const serial = useSimulationStore.getState().serialText;
    console.log(`   serial: ${serial.trim().split('\n').slice(-2).join(' | ')}`);
    check(/CMD=1C/i.test(serial), 'and the sketch decoded the same command from the pin');
    check(/OK=1/.test(serial), "with the frame's own inverted-byte check passing");
  }
  simulationController.stop();
}

// ================= 5b. one press, two boards, because it is a room ==========
section('5b. two boards with their own receivers both hear one press');
{
  // The property that makes this a channel: nothing is addressed, so a second
  // board watching the same air gets the same frame. A per-pair link would
  // deliver to one of them.
  const SOURCE = [
    'volatile uint8_t idx = 0;',
    'volatile uint32_t bits = 0, code = 0, lastUs = 0;',
    'volatile bool ready = false;',
    'void onEdge() {',
    '  uint32_t now = micros();',
    '  uint32_t gap = now - lastUs;',
    '  lastUs = now;',
    '  if (gap > 12000) { idx = 0; bits = 0; return; }',
    '  if (idx < 32) { if (gap > 1600) bits |= (1UL << idx); idx++; if (idx == 32) { code = bits; ready = true; } }',
    '}',
    'void setup() {',
    '  Serial.begin(9600);',
    '  pinMode(2, INPUT);',
    '  attachInterrupt(digitalPinToInterrupt(2), onEdge, FALLING);',
    '}',
    'void loop() {',
    '  if (ready) { ready = false; Serial.print("GOT="); Serial.println((uint8_t)((code >> 16) & 0xFF), HEX); }',
    '}',
  ].join('\n');

  const p = emptyProject('ir-two-boards');
  const boardA = inst('board.arduino-uno');
  const boardB = inst('board.arduino-uno');
  const rxA = inst('comp.ir-receiver');
  const rxB = inst('comp.ir-receiver');
  const remote = inst('comp.ir-remote');
  p.boardInstances.push(boardA, boardB);
  p.componentInstances.push(rxA, rxB, remote);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  for (const [board, rx] of [[boardA, rxA], [boardB, rxB]] as const) {
    wire(p, board.id, '5V', rx.id, 'vcc');
    wire(p, board.id, 'GND_TOP', rx.id, 'gnd');
    wire(p, board.id, 'D2', rx.id, 'out');
  }

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the two-board IR test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(60);
    const sim = useSimulationStore.getState();
    sim.pressButton(contactStateKey(remote.id, 'one'), true);
    simulationController.advance(5);
    sim.pressButton(contactStateKey(remote.id, 'one'), false);
    simulationController.advance(140);
    simulationController.publishNow();

    const binding = (simulationController as unknown as {
      binding: { irDeviceFor(id: string): unknown } | null;
    }).binding;
    const one = STARTER_REMOTE_KEYS.find((k) => k.key === 'one');
    for (const [label, rx] of [['board A', rxA], ['board B', rxB]] as const) {
      const model = binding?.irDeviceFor(rx.id);
      const ok = model instanceof IrReceiverDevice && model.frameCount >= 1 && model.command === one?.command;
      check(ok, `${label}'s receiver decoded the same frame`);
    }
    const serial = useSimulationStore.getState().serialText;
    const gots = (serial.match(/GOT=C\b/gi) ?? []).length;
    console.log(`   serial: ${JSON.stringify(serial.trim().split('\n').slice(-4))}`);
    check(gots >= 2, `and both sketches printed it, once each (${gots})`);
  }
  simulationController.stop();
}

// ================================================ 6. the parts as shipped ====
section('6. the IR parts in the library');
{
  const rx = defOf('comp.ir-receiver');
  check(rx !== undefined, 'the receiver is in the library');
  if (rx) {
    check(rx.supportLevel === 'simulated', 'badged Simulated');
    for (const pinId of ['out', 'gnd', 'vcc']) {
      check(rx.pins.some((pp) => pp.id === pinId), `it exposes ${pinId}`);
    }
    check(/active low/i.test(rx.description ?? ''), 'and says its output is active low');
    check(/Distance, angle/.test(rx.description ?? ''), 'and names what it does not model');
  }

  const remote = defOf('comp.ir-remote');
  check(remote !== undefined, 'the remote is in the library');
  if (remote) {
    check(remote.pins.length === 0, 'with no pins, because a remote has no wires');
    const spots = interactiveHotspots(remote, inst('comp.ir-remote'));
    check(spots.length === STARTER_REMOTE_KEYS.length, `every key is clickable (${spots.length})`);
    check(
      spots.every((s) => STARTER_REMOTE_KEYS.some((k) => k.key === s.key)),
      'and the clickable keys are the keys that send codes',
    );
    check(/cannot address a receiver/.test(remote.description ?? ''), 'and it says it cannot address a receiver');
  }

  for (const id of ['comp.ir-receiver', 'comp.ir-remote']) {
    const cov = COMPONENT_COVERAGE.find((c) => c.id === id);
    check(cov?.status === 'simulated', `${id} is recorded as simulated`);
    check((cov?.tests ?? []).includes('tests/ir.channel.mts'), `${id} names this file as its proof`);
  }
}

console.log(
  failures === 0
    ? `\nIR channel checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
