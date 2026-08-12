// Saying who is fighting over a wire.
//
// Two outputs on one net is the most damaging mistake a learner can make, and
// "Net contention detected" tells them it happened without telling them where.
// The binding has always known exactly which board pins were driving; this
// covers turning that into a sentence.
//
// Two halves, tested separately because they are separate concerns:
//
//   * `describeContention` — the wording, the plural cases, and the rules about
//     what is *not* a conflict. Pure, so it is exercised directly.
//   * the production controller — that real firmware driving real pads through
//     real canvas nets produces the message, with the right boards named.

import { describeContention, buildSerialLabels, type ContentionDriverInfo } from '../src/simulation/serialLog';
import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject } from '../src/project/templates';
import type { CircuitProject, ComponentInstance } from '../src/types';

const PICO = 'board.raspberry-pi-pico';
const C6 = 'board.esp32-c6-devkitc-1';

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

const driver = (instanceId: string, pinId: string, level: 'high' | 'low'): ContentionDriverInfo => ({
  instanceId, pinId, level,
});

// ==================================================== 1. the wording itself ==
{
  const labels = new Map([
    ['b1', 'Raspberry Pi Pico #1'],
    ['b2', 'ESP32-C6-DevKitC-1 #1'],
    ['b3', 'Raspberry Pi Pico #2'],
  ]);
  const label = (id: string) => labels.get(id) ?? id;

  const two = describeContention([driver('b1', 'GP14', 'high'), driver('b2', 'IO2', 'low')], label);
  check(
    two === 'Net contention: Raspberry Pi Pico #1 GP14 (HIGH) and ESP32-C6-DevKitC-1 #1 IO2 (LOW) are driving conflicting levels.',
    `two conflicting outputs are named with their pins (${two})`,
  );

  const three = describeContention(
    [driver('b1', 'GP14', 'high'), driver('b2', 'IO2', 'low'), driver('b3', 'GP9', 'low')],
    label,
  );
  check(three !== null && /GP14 \(HIGH\), ESP32-C6-DevKitC-1 #1 IO2 \(LOW\) and Raspberry Pi Pico #2 GP9 \(LOW\)/.test(three), `three drivers all appear, read as a list (${three})`);

  // Not conflicts.
  check(describeContention([driver('b1', 'GP14', 'high')], label) === null, 'one driver is not contention');
  check(describeContention([], label) === null, 'and neither is none');
  check(
    describeContention([driver('b1', 'GP14', 'high'), driver('b2', 'IO2', 'high')], label) === null,
    'HIGH against HIGH is not contention — those pins agree',
  );
  check(
    describeContention([driver('b1', 'GP14', 'low'), driver('b2', 'IO2', 'low')], label) === null,
    'nor LOW against LOW',
  );

  // Identity is the instance id; the name is whatever the label function says.
  const renamed = describeContention(
    [driver('b1', 'GP14', 'high'), driver('b2', 'IO2', 'low')],
    (id) => (id === 'b1' ? 'Sensor node' : 'Actuator node'),
  );
  check(
    renamed === 'Net contention: Sensor node GP14 (HIGH) and Actuator node IO2 (LOW) are driving conflicting levels.',
    `a user's own board names are what appear (${renamed})`,
  );

  // Two boards of the same type must not both be called the same thing.
  const sameType = buildSerialLabels([
    { instanceId: 'x1', boardName: 'Raspberry Pi Pico' },
    { instanceId: 'x2', boardName: 'Raspberry Pi Pico' },
  ]);
  const twoPicos = describeContention(
    [driver('x1', 'GP14', 'high'), driver('x2', 'GP14', 'low')],
    (id) => sameType.get(id) ?? id,
  );
  check(
    twoPicos === 'Net contention: Raspberry Pi Pico #1 GP14 (HIGH) and Raspberry Pi Pico #2 GP14 (LOW) are driving conflicting levels.',
    `two boards of one type are told apart (${twoPicos})`,
  );
  check(
    (twoPicos ?? '').includes('#1') && (twoPicos ?? '').includes('#2'),
    'so the same pin on two identical boards is not one ambiguous name twice',
  );

  // A custom label on one of two identical boards wins, and the other keeps a
  // distinct name.
  const mixed = buildSerialLabels([
    { instanceId: 'y1', boardName: 'Raspberry Pi Pico', label: 'Left wing' },
    { instanceId: 'y2', boardName: 'Raspberry Pi Pico' },
  ]);
  const mixedText = describeContention(
    [driver('y1', 'GP14', 'high'), driver('y2', 'GP14', 'low')],
    (id) => mixed.get(id) ?? id,
  );
  check(/Left wing GP14 \(HIGH\)/.test(mixedText ?? ''), `a custom label is used verbatim (${mixedText})`);
  check(/Raspberry Pi Pico GP14 \(LOW\)/.test(mixedText ?? ''), 'and the unnamed board keeps its product name');
}

// ======================== 2. through the production controller, on real pads ==
let seq = 0;
const uid = (p: string) => `${p}${++seq}`;

function projectOf(
  boards: { id: string; definitionId: string; label?: string }[],
  wires: [string, string, string, string][],
  source: string,
): CircuitProject {
  const project = emptyProject('contention');
  project.codeFiles = [{ id: 'f1', name: 'sketch.ino', content: source, language: 'cpp' }];
  for (const b of boards) {
    project.boardInstances.push({
      id: b.id, definitionId: b.definitionId, x: 0, y: 0, rotation: 0,
      properties: {}, simulationState: {}, ...(b.label ? { label: b.label } : {}),
    } as ComponentInstance);
  }
  for (const [a, ap, b, bp] of wires) {
    project.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#e8590c', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  }
  return project;
}

async function run(project: CircuitProject): Promise<boolean> {
  simulationController.stop();
  const report = await simulationController.build(project);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable) return false;
  if (!(await simulationController.start())) return false;
  simulationController.pause();
  simulationController.advance(80);
  simulationController.publishNow();
  return true;
}

// Two Picos, same sketch. GP14 is driven HIGH on one board and LOW on the
// other, GP12/GP11 are both HIGH, and GP13 is an input.
const PICO_SOURCE = [
  'void setup() {',
  '  pinMode(15, OUTPUT); pinMode(14, OUTPUT);',
  '  pinMode(12, OUTPUT); pinMode(11, OUTPUT); pinMode(10, OUTPUT);',
  '  pinMode(13, INPUT);',
  '}',
  'void loop() {',
  '  digitalWrite(15, HIGH); digitalWrite(14, LOW);',
  '  digitalWrite(12, HIGH); digitalWrite(11, HIGH); digitalWrite(10, HIGH);',
  '}',
].join('\n');

{
  const a = uid('b');
  const b = uid('b');
  const project = projectOf(
    [{ id: a, definitionId: PICO }, { id: b, definitionId: PICO }],
    [
      [a, 'GND1', b, 'GND1'],
      [a, 'GP15', b, 'GP14'],   // HIGH against LOW     -> contention
      [a, 'GP12', b, 'GP11'],   // HIGH against HIGH    -> agreement
      [a, 'GP13', b, 'GP10'],   // input against output -> not a conflict
    ],
    PICO_SOURCE,
  );

  if (!(await run(project))) {
    skip('the RP2040 toolchain is unavailable — the controller sections cannot run');
  } else {
    const messages = useSimulationStore.getState().contention;
    console.log('   reported:', JSON.stringify(messages));
    check(messages.length === 1, `exactly one conflict is reported (${messages.length})`);
    const line = messages[0] ?? '';
    check(/^Net contention: /.test(line), 'it reads as a contention message');
    check(/GP15 \(HIGH\)/.test(line), `and names the pin driving high (${line})`);
    check(/GP14 \(LOW\)/.test(line), 'and the pin driving low');
    check(/Raspberry Pi Pico #1/.test(line) && /Raspberry Pi Pico #2/.test(line), 'with the two identical boards told apart');
    check(!/GP12|GP11/.test(line), 'the agreeing pair is not reported');
    check(!/GP13/.test(line), 'and the input is not named as a driver');

    // The binding's own record: inputs must not appear as drivers at all.
    const binding = (simulationController as unknown as {
      binding: { contentionDrivers: Map<string, { pinId: string; level: string }[]> };
    }).binding;
    const drivers = [...binding.contentionDrivers.values()].flat();
    check(drivers.length === 2, `the binding recorded two drivers for the contended net (${drivers.length})`);
    check(
      drivers.every((d) => d.level === 'high' || d.level === 'low'),
      'both of which were genuinely driving a level',
    );
  }
}

// ------------------- a custom board label reaches the message ---------------
{
  const a = uid('b');
  const b = uid('b');
  const project = projectOf(
    [{ id: a, definitionId: PICO, label: 'Left wing' }, { id: b, definitionId: PICO }],
    [
      [a, 'GND1', b, 'GND1'],
      [a, 'GP15', b, 'GP14'],
    ],
    PICO_SOURCE,
  );
  if (!(await run(project))) {
    skip('the labelled-board project would not start');
  } else {
    const line = useSimulationStore.getState().contention[0] ?? '';
    console.log('   reported:', JSON.stringify(line));
    check(/Left wing GP15 \(HIGH\)/.test(line), `the user's own board name is used (${line})`);
    check(/Raspberry Pi Pico GP14 \(LOW\)/.test(line), 'and the unnamed board keeps its product name');
    check(!/Left wing.*Left wing/.test(line), 'each board appears once');
  }
}

// ---------------- three drivers, across two board families ------------------
{
  const p1 = uid('b');
  const p2 = uid('b');
  const c6 = uid('b');
  // The C6 half drives IO2 low; both Picos drive their GP15 high. One net,
  // three real outputs, two architectures.
  const source = [
    '#if defined(ARDUINO_ARCH_RP2040)',
    'void setup() { pinMode(15, OUTPUT); }',
    'void loop() { digitalWrite(15, HIGH); }',
    '#else',
    'void setup() { pinMode(2, OUTPUT); }',
    'void loop() { digitalWrite(2, LOW); }',
    '#endif',
  ].join('\n');
  const project = projectOf(
    [{ id: p1, definitionId: PICO }, { id: p2, definitionId: PICO }, { id: c6, definitionId: C6 }],
    [
      [p1, 'GND1', p2, 'GND1'],
      [p1, 'GND2', c6, 'GND1'],
      [p1, 'GP15', p2, 'GP15'],
      [p2, 'GP15', c6, 'IO2'],
    ],
    source,
  );
  if (!(await run(project))) {
    skip('the three-board project would not start');
  } else {
    const line = useSimulationStore.getState().contention[0] ?? '';
    console.log('   reported:', JSON.stringify(line));
    check(useSimulationStore.getState().contention.length === 1, 'one net, one message');
    const named = (line.match(/\(HIGH\)|\(LOW\)/g) ?? []).length;
    check(named === 3, `all three drivers are named (${named})`);
    check(/Raspberry Pi Pico #1/.test(line) && /Raspberry Pi Pico #2/.test(line), 'the two Picos are distinguished');
    check(/ESP32-C6-DevKitC-1/.test(line), 'and the C6 is named as itself');
    check(/ and /.test(line) && /, /.test(line), `three drivers read as a list rather than a pair (${line})`);
  }
}

simulationController.stop();
console.log(
  failures === 0
    ? `\nContention reporting checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
