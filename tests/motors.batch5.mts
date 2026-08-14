// The servo: position comes from the pulse, or it comes from nowhere.
//
// A servo is the easiest component in a simulator to fake — a sketch calls
// `write(90)` and the picture turns to 90°, and nobody notices for a long
// time. The difference that matters is whether the angle is derived from the
// width of the pulse that actually appeared on the signal wire, because that
// is the only version where writing your own `digitalWrite`/`delayMicroseconds`
// loop works, where a wrong PWM frequency misbehaves, and where an unwired
// signal pin does nothing.
//
// So every case here drives the servo from a hand-written pulse loop rather
// than through the Servo library. That isolates the model: nothing in this file
// can pass because something intercepted `Servo::write`, because nothing here
// calls it.
//
// The library route is now pinned and tested separately, in
// tests/compiler.libraries.mts — an Uno running the real Servo library reaches
// the same three angles this file reaches by hand. The two together are what
// rule out an API shim: one proves the angle comes from the wire, the other
// proves the library reaches the wire.

import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject } from '../src/project/templates';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
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

function servoProject(source: string): { project: CircuitProject; servo: ComponentInstance } {
  const p = emptyProject('servo');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.arduino-uno', x: 0, y: 0, rotation: 0,
    properties: {}, simulationState: {},
  };
  const servo: ComponentInstance = {
    id: uid('s'), definitionId: 'comp.servo', x: 300, y: 0, rotation: 0,
    properties: {}, simulationState: {},
  };
  p.boardInstances.push(board);
  p.componentInstances.push(servo);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: source, language: 'cpp' }];
  const wire = (a: string, ap: string, b: string, bp: string) =>
    p.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#000', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  wire(board.id, '5V', servo.id, 'vcc');
  wire(board.id, 'GND_TOP', servo.id, 'gnd');
  wire(board.id, 'D9', servo.id, 'sig');
  return { project: p, servo };
}

/** The angle the canvas is showing for a servo instance. */
function servoAngle(instanceId: string): number | undefined {
  simulationController.publishNow();
  const visuals = useSimulationStore.getState().visuals as Record<string, { servoAngle?: number }>;
  return visuals[instanceId]?.servoAngle;
}

// ============================ 1. a hand-written pulse loop, no Servo library ==
section('1. the angle comes from the pulse width, not from an API call');
{
  // Deliberately not the Servo library: a bare loop that produces the pulse
  // itself. If the angle were injected by intercepting `Servo::write`, none of
  // this would move at all.
  const PULSE_LOOP = [
    'const int SIG = 9;',
    'int widthUs = 1000;',
    'void setup() { pinMode(SIG, OUTPUT); Serial.begin(9600); }',
    'void loop() {',
    '  digitalWrite(SIG, HIGH);',
    '  delayMicroseconds(widthUs);',
    '  digitalWrite(SIG, LOW);',
    '  delay(20);',
    '  if (millis() > 1500) widthUs = 1500;',
    '  if (millis() > 3000) widthUs = 2000;',
    '}',
  ].join('\n');

  const { project, servo } = servoProject(PULSE_LOOP);
  simulationController.stop();
  const report = await simulationController.build(project);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);

  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the servo firmware test cannot run');
  } else {
    simulationController.pause();

    // ~1 ms: one extreme.
    simulationController.advance(1200);
    const atOne = servoAngle(servo.id);
    console.log(`   1.0 ms pulse → ${atOne?.toFixed(1)}°`);
    check(atOne !== undefined && atOne < 15, `a 1 ms pulse puts the shaft near one extreme (${atOne?.toFixed(1)}°)`);

    // ~1.5 ms: centre.
    simulationController.advance(1800);
    const atMid = servoAngle(servo.id);
    console.log(`   1.5 ms pulse → ${atMid?.toFixed(1)}°`);
    check(atMid !== undefined && Math.abs(atMid - 90) < 15, `a 1.5 ms pulse centres it (${atMid?.toFixed(1)}°)`);

    // ~2 ms: the other extreme.
    simulationController.advance(1800);
    const atTwo = servoAngle(servo.id);
    console.log(`   2.0 ms pulse → ${atTwo?.toFixed(1)}°`);
    check(atTwo !== undefined && atTwo > 165, `a 2 ms pulse drives it to the other extreme (${atTwo?.toFixed(1)}°)`);

    check(
      atOne !== undefined && atMid !== undefined && atTwo !== undefined && atOne < atMid && atMid < atTwo,
      'and the three positions are ordered, so the angle tracks the width',
    );
  }
  simulationController.stop();
}

// ============================================ 2. an unwired servo does nothing ==
section('2. no signal, no movement');
{
  // The same pulse loop, with the signal wire cut. The sketch still drives D9
  // exactly as before; nothing reaches the servo, so nothing moves. If the
  // angle came from the firmware rather than from the wire, this would still
  // swing to the far end.
  const PULSE_LOOP = [
    'const int SIG = 9;',
    'void setup() { pinMode(SIG, OUTPUT); }',
    'void loop() {',
    '  digitalWrite(SIG, HIGH);',
    '  delayMicroseconds(2000);',
    '  digitalWrite(SIG, LOW);',
    '  delay(20);',
    '}',
  ].join('\n');

  const { project, servo } = servoProject(PULSE_LOOP);
  project.connections = project.connections.filter((c) => c.targetPinId !== 'sig');

  simulationController.stop();
  const report = await simulationController.build(project);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the unwired variant would not start');
  } else {
    simulationController.pause();
    simulationController.advance(1500);
    const angle = servoAngle(servo.id);
    console.log(`   signal disconnected → ${angle?.toFixed(1)}°`);
    check(
      angle === undefined || Math.abs(angle - 90) < 1,
      `a servo with no signal wire stays at rest however the firmware drives its pin (${angle?.toFixed(1)}°)`,
    );
  }
  simulationController.stop();
}

// ================================ 3. a pulse outside the range is ignored =====
section('3. an out-of-range pulse does not move it');
{
  // Servos ignore pulses well outside the 1-2 ms window rather than slamming
  // to an end stop, and a model that mapped any width linearly would not.
  const WILD = [
    'const int SIG = 9;',
    'void setup() { pinMode(SIG, OUTPUT); }',
    'void loop() {',
    '  digitalWrite(SIG, HIGH);',
    '  delayMicroseconds(6000);',
    '  digitalWrite(SIG, LOW);',
    '  delay(20);',
    '}',
  ].join('\n');

  const { project, servo } = servoProject(WILD);
  simulationController.stop();
  const report = await simulationController.build(project);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the out-of-range variant would not start');
  } else {
    simulationController.pause();
    simulationController.advance(1500);
    const angle = servoAngle(servo.id);
    console.log(`   6 ms pulse → ${angle?.toFixed(1)}°`);
    check(
      angle !== undefined && Math.abs(angle - 90) < 1,
      `a 6 ms pulse is outside the servo's window and is ignored (${angle?.toFixed(1)}°)`,
    );
  }
  simulationController.stop();
}

// ======================================================== 4. the part itself ==
section('4. the servo in the library');
{
  const def = defOf('comp.servo');
  check(def !== undefined, 'the servo is in the library');
  if (def) {
    check(def.supportLevel === 'simulated', 'badged Simulated');
    check(def.pins.some((p) => p.id === 'sig'), 'it has a signal pin');
    check(def.pins.some((p) => p.id === 'vcc') && def.pins.some((p) => p.id === 'gnd'), 'and both supply pins');
    // No angle property: the angle is an output of the model, not an input.
    check(
      !def.properties.some((p) => /angle|position/i.test(p.key)),
      'and no angle property — the position is produced by the pulse, not set on the part',
    );
  }
}

console.log(
  failures === 0
    ? `\nServo checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
