// RS-485 as a bus, which is the only thing that makes it worth having.
//
// A point-to-point link would have been far easier to build and would have
// been a lie. The character of RS-485 is entirely in what happens when more
// than two nodes share a pair: who is allowed to drive, what everyone else
// hears while they do, and what happens when two of them drive at once. So the
// acceptance here is three boards on one pair, not two.
//
// The pair carries bytes rather than individual bits, which the emulator forces:
// an AVR's USART hands its output to a callback and never drives the TX pad,
// so there are no edges on DI to put on a wire. What that costs is stated in
// the part's own description. What it does NOT cost is any of the bus
// behaviour: DE still decides who reaches the pair, /RE still decides who
// hears — including the sender's own echo — and two drivers at once still
// destroy each other's traffic instead of one of them winning.

import { Max485Device, Rs485Bus, mangle } from '../src/simulation/devices/rs485';
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

// ================================================ 1. the bus is a bus ========
section('1. drivers, silence, echo and contention on one pair');
{
  const bus = new Rs485Bus('pair');
  const a = new Max485Device('a');
  const b = new Max485Device('b');
  const c = new Max485Device('c');

  check(bus.idle, 'a bus with nobody driving is idle');
  check(bus.carry(0x41, 'a') === null, 'a node with DE low puts nothing on the pair at all');

  a.setDriverEnable(true);
  bus.setDriver('a', a.driving);
  const clean = bus.carry(0x41, 'a');
  check(clean !== null && !clean.corrupted && clean.value === 0x41, 'raising DE lets its byte through unchanged');
  check(!bus.idle && bus.driverCount === 1, 'as the only driver');

  // Every listening node hears it, and so does the sender if it forgot /RE.
  check(b.receive(clean!) === 0x41, 'another node hears it');
  check(c.receive(clean!) === 0x41, 'and so does a third — this is a bus');
  check(a.receive(clean!) === 0x41, 'and the sender hears its own echo, because its receiver is still on');
  c.setReceiverEnable(false);
  check(c.receive(clean!) === null, 'a node holding RE high is deaf, because RE is ACTIVE LOW');

  // Two drivers enabled at once destroy whatever crosses the pair.
  b.setDriverEnable(true);
  bus.setDriver('b', b.driving);
  const fought = bus.carry(0x41, 'a');
  check(fought !== null && fought.corrupted, 'with two drivers enabled, a byte is corrupted');
  check(fought!.value === mangle(0x41), 'to something neither of them sent');
  check(fought!.value !== 0x41, 'so a listener cannot mistake it for the message');
  check(bus.contentionCount > 0, `and the contention is counted (${bus.contentionCount})`);
  check(b.receive(fought!) === fought!.value, 'listeners get the wreckage rather than a winner');
  check(b.corruptedCount > 0, 'and know it was wreckage');

  b.setDriverEnable(false);
  bus.setDriver('b', b.driving);
  const after = bus.carry(0x42, 'a');
  check(after !== null && !after.corrupted, 'releasing one driver makes the bus usable again');

  a.setDriverEnable(false);
  bus.setDriver('a', a.driving);
  check(bus.idle, 'and releasing the last one returns it to idle');
}

// ============================== 2. three boards, one pair, real firmware =====
section('2. three nodes on one bus, with real UARTs at both ends');
{
  // Every board runs the same sketch. A strap on D7 makes one of them the
  // talker; the other two listen and report what their own USART decoded. The
  // talker raises RE while it drives, as half-duplex demands, and drops DE
  // when it is done — the discipline a real bus needs and this one enforces.
  const SOURCE = [
    '#define DE 3',
    '#define RE 4',
    'bool isTalker;',
    'void setup() {',
    '  pinMode(7, INPUT_PULLUP);',
    '  pinMode(DE, OUTPUT);',
    '  pinMode(RE, OUTPUT);',
    '  delay(5);',
    '  isTalker = digitalRead(7) == LOW;',
    '  Serial.begin(9600);',
    '  if (isTalker) {',
    '    digitalWrite(RE, HIGH);',   // deaf while driving, as half-duplex demands
    '    digitalWrite(DE, HIGH);',
    '    delay(20);',
    '    Serial.print("PING");',
    '    Serial.flush();',
    '    digitalWrite(DE, LOW);',    // release the bus
    '    digitalWrite(RE, LOW);',
    '  } else {',
    '    digitalWrite(DE, LOW);',
    '    digitalWrite(RE, LOW);',    // listening
    '  }',
    '}',
    'char buf[8];',
    'uint8_t n = 0;',
    'bool reported = false;',
    'void loop() {',
    '  if (isTalker || reported) return;',
    '  while (Serial.available() && n < 7) buf[n++] = Serial.read();',
    '  if (n >= 4) { buf[n] = 0; Serial.print("GOT:"); Serial.println(buf); reported = true; }',
    '}',
  ].join('\n');

  const p = emptyProject('rs485');
  const boards = [inst('board.arduino-uno'), inst('board.arduino-uno'), inst('board.arduino-uno')];
  const nodes = [inst('comp.max485'), inst('comp.max485'), inst('comp.max485')];
  p.boardInstances.push(...boards);
  p.componentInstances.push(...nodes);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];

  boards.forEach((board, i) => {
    const node = nodes[i];
    wire(p, board.id, '5V', node.id, 'vcc');
    wire(p, board.id, 'GND_TOP', node.id, 'gnd');
    wire(p, board.id, 'D1', node.id, 'di'); // board TX drives DI
    wire(p, board.id, 'D0', node.id, 'ro'); // RO drives board RX
    wire(p, board.id, 'D3', node.id, 'de');
    wire(p, board.id, 'D4', node.id, 're');
  });
  // The pair itself: every node's A to every other node's A, and B to B.
  wire(p, nodes[0].id, 'a', nodes[1].id, 'a');
  wire(p, nodes[1].id, 'a', nodes[2].id, 'a');
  wire(p, nodes[0].id, 'b', nodes[1].id, 'b');
  wire(p, nodes[1].id, 'b', nodes[2].id, 'b');
  // Board 0 is the talker.
  wire(p, boards[0].id, 'D7', boards[0].id, 'GND_PWR1');

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the three-node bus test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(400);
    simulationController.publishNow();

    const binding = (simulationController as unknown as {
      binding: { rs485DeviceFor(id: string): unknown; rs485BusFor(id: string): unknown } | null;
    }).binding;
    const models = nodes.map((n) => binding?.rs485DeviceFor(n.id));
    for (const m of models) if (m instanceof Max485Device) console.log(`   node: ${m.snapshot().status}`);

    check(models.every((m) => m instanceof Max485Device), 'all three transceivers attached');
    const sender = models.find((m) => m instanceof Max485Device && m.sentCount > 0);
    check(sender !== undefined, 'one node put bytes on the pair');
    const buses = new Set(nodes.map((n) => binding?.rs485BusFor(n.id)));
    check(buses.size === 1 && !buses.has(undefined), `and all three are on ONE bus (${buses.size})`);

    const serial = useSimulationStore.getState().serialText;
    console.log(`   serial: ${JSON.stringify(serial.trim().split('\n').slice(-4))}`);
    const heard = (serial.match(/GOT:PING/g) ?? []).length;
    check(heard === 2, `both listening nodes decoded PING with their own UARTs (${heard})`);
    check(!/GOT:P?I?N?G[^\s]/.test(serial.replace(/GOT:PING/g, '')), 'and nothing decoded anything else');
  }
  simulationController.stop();
}

// ================================ 3. the negatives, on the same three nodes ==
section('3. DE low sends nothing and RE high hears nothing');
{
  // Same three boards, but the talker never raises DE — the single most common
  // RS-485 mistake there is. Nothing should reach the bus at all.
  const SOURCE = [
    '#define DE 3',
    '#define RE 4',
    'bool isTalker;',
    'void setup() {',
    '  pinMode(7, INPUT_PULLUP);',
    '  pinMode(8, INPUT_PULLUP);',
    '  pinMode(DE, OUTPUT);',
    '  pinMode(RE, OUTPUT);',
    '  delay(5);',
    '  isTalker = digitalRead(7) == LOW;',
    '  bool deaf = digitalRead(8) == LOW;',
    '  Serial.begin(9600);',
    '  digitalWrite(DE, LOW);',                 // deliberately never raised
    '  digitalWrite(RE, deaf ? HIGH : LOW);',
    '  if (isTalker) { delay(20); Serial.print("PING"); Serial.flush(); }',
    '}',
    'char buf[8];',
    'uint8_t n = 0;',
    'bool reported = false;',
    'void loop() {',
    '  if (isTalker || reported) return;',
    '  while (Serial.available() && n < 7) buf[n++] = Serial.read();',
    '  if (n >= 4) { buf[n] = 0; Serial.print("GOT:"); Serial.println(buf); reported = true; }',
    '}',
  ].join('\n');

  const p = emptyProject('rs485-de-low');
  const boards = [inst('board.arduino-uno'), inst('board.arduino-uno'), inst('board.arduino-uno')];
  const nodes = [inst('comp.max485'), inst('comp.max485'), inst('comp.max485')];
  p.boardInstances.push(...boards);
  p.componentInstances.push(...nodes);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];

  boards.forEach((board, i) => {
    const node = nodes[i];
    wire(p, board.id, '5V', node.id, 'vcc');
    wire(p, board.id, 'GND_TOP', node.id, 'gnd');
    wire(p, board.id, 'D1', node.id, 'di');
    wire(p, board.id, 'D0', node.id, 'ro');
    wire(p, board.id, 'D3', node.id, 'de');
    wire(p, board.id, 'D4', node.id, 're');
  });
  wire(p, nodes[0].id, 'a', nodes[1].id, 'a');
  wire(p, nodes[1].id, 'a', nodes[2].id, 'a');
  wire(p, nodes[0].id, 'b', nodes[1].id, 'b');
  wire(p, nodes[1].id, 'b', nodes[2].id, 'b');
  wire(p, boards[0].id, 'D7', boards[0].id, 'GND_PWR1'); // talker
  wire(p, boards[2].id, 'D8', boards[2].id, 'GND_PWR1'); // node C is deaf

  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the DE-low test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(400);
    simulationController.publishNow();

    const binding = (simulationController as unknown as {
      binding: { rs485DeviceFor(id: string): unknown; rs485BusFor(id: string): unknown } | null;
    }).binding;
    const bus = binding?.rs485BusFor(nodes[0].id);
    check(bus instanceof Rs485Bus && bus.driverCount === 0, 'nobody is driving the bus');
    const serial = useSimulationStore.getState().serialText;
    console.log(`   serial: ${JSON.stringify(serial.trim().split('\n').slice(-3))}`);
    check(!/GOT:/.test(serial), 'and with DE never raised, nothing reached either listener');

    const deafNode = binding?.rs485DeviceFor(nodes[2].id);
    check(deafNode instanceof Max485Device && !deafNode.listening, 'the node holding RE high is deaf, as RE is active low');
  }
  simulationController.stop();
}

// ======================================= 4. two talkers wreck each other =====
section('4. two nodes driving at once corrupt the bus');
{
  const SOURCE = [
    '#define DE 3',
    '#define RE 4',
    'bool isTalker;',
    'void setup() {',
    '  pinMode(7, INPUT_PULLUP);',
    '  pinMode(DE, OUTPUT);',
    '  pinMode(RE, OUTPUT);',
    '  delay(5);',
    '  isTalker = digitalRead(7) == LOW;',
    '  Serial.begin(9600);',
    '  if (isTalker) {',
    '    digitalWrite(RE, HIGH); digitalWrite(DE, HIGH);',
    '    delay(20);',
    '    Serial.print("AAAA");',
    '    Serial.flush();',
    '    digitalWrite(DE, LOW); digitalWrite(RE, LOW);',
    '  } else { digitalWrite(DE, LOW); digitalWrite(RE, LOW); }',
    '}',
    'char buf[16];',
    'uint8_t n = 0;',
    'bool reported = false;',
    'void loop() {',
    '  if (isTalker || reported) return;',
    '  while (Serial.available() && n < 15) buf[n++] = Serial.read();',
    '  if (n >= 4 && millis() > 200) { buf[n] = 0; Serial.print("GOT:"); Serial.println(buf); reported = true; }',
    '}',
  ].join('\n');

  const p = emptyProject('rs485-fight');
  const boards = [inst('board.arduino-uno'), inst('board.arduino-uno'), inst('board.arduino-uno')];
  const nodes = [inst('comp.max485'), inst('comp.max485'), inst('comp.max485')];
  p.boardInstances.push(...boards);
  p.componentInstances.push(...nodes);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];

  boards.forEach((board, i) => {
    const node = nodes[i];
    wire(p, board.id, '5V', node.id, 'vcc');
    wire(p, board.id, 'GND_TOP', node.id, 'gnd');
    wire(p, board.id, 'D1', node.id, 'di');
    wire(p, board.id, 'D0', node.id, 'ro');
    wire(p, board.id, 'D3', node.id, 'de');
    wire(p, board.id, 'D4', node.id, 're');
  });
  wire(p, nodes[0].id, 'a', nodes[1].id, 'a');
  wire(p, nodes[1].id, 'a', nodes[2].id, 'a');
  wire(p, nodes[0].id, 'b', nodes[1].id, 'b');
  wire(p, nodes[1].id, 'b', nodes[2].id, 'b');
  // TWO talkers, both strapped, both keying up at the same moment.
  wire(p, boards[0].id, 'D7', boards[0].id, 'GND_PWR1');
  wire(p, boards[1].id, 'D7', boards[1].id, 'GND_PWR1');

  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the contention test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(400);
    simulationController.publishNow();

    const binding = (simulationController as unknown as {
      binding: { rs485BusFor(id: string): unknown } | null;
    }).binding;
    const bus = binding?.rs485BusFor(nodes[0].id);
    check(bus instanceof Rs485Bus, 'the bus exists');
    if (bus instanceof Rs485Bus) {
      console.log(`   bus: ${bus.contentionCount} contention(s), ${bus.driverCount} driver(s) now`);
      check(bus.contentionCount > 0, `two drivers disagreed on the pair (${bus.contentionCount} times)`);
    }
    const serial = useSimulationStore.getState().serialText;
    console.log(`   serial: ${JSON.stringify(serial.trim().split('\n').slice(-3))}`);
    // Whatever the listener decoded, it must not be a clean copy of one
    // talker's message — that would mean the fight had a winner, and a
    // differential pair with two drivers on it does not.
    check(!/GOT:AAAA\b/.test(serial), 'and the listener did not receive one talker cleanly');
  }
  simulationController.stop();
}

// ================================================= 5. the part as shipped ====
section('5. the MAX485 in the library');
{
  const def = defOf('comp.max485');
  check(def !== undefined, 'the MAX485 is in the library');
  if (def) {
    check(def.supportLevel === 'simulated', 'badged Simulated');
    for (const pinId of ['ro', 're', 'de', 'di', 'a', 'b', 'vcc', 'gnd']) {
      check(def.pins.some((pp) => pp.id === pinId), `it exposes ${pinId}`);
    }
    check(/ACTIVE LOW/.test(def.description ?? ''), 'and warns that RE is active low');
    check(/every node hears every byte/.test(def.description ?? ''), 'and says it is a bus, not a private link');
    check(/carries BYTES rather than individual bits/.test(def.description ?? ''), 'and admits what the pair does not carry');
  }
  const cov = COMPONENT_COVERAGE.find((c) => c.id === 'comp.max485');
  check(cov?.status === 'simulated', 'recorded as simulated');
  check((cov?.tests ?? []).includes('tests/bus.rs485.mts'), 'and names this file as its proof');
  // `dependencies` on a FINISHED part is what it rests on, not what it waits
  // for. Asserting it is empty would quietly undo that: the point of recording
  // the shared differential bus here is that the next part built on it can be
  // estimated honestly, and the coverage audit derives "this primitive exists"
  // from exactly these rows.
  check((cov?.dependencies ?? []).includes('differential-bus'), 'and records the primitive it rests on');
}

console.log(
  failures === 0
    ? `\nRS-485 checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
