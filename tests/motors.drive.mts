// Motors: it turns because the circuit turns it.
//
// The shortcut here is a `speed` property, or an RPM the firmware sets. Either
// gives a motor that spins when the code says so rather than when the wiring
// says so — and then a missing ground, a backwards bridge, and an H-bridge
// whose enable pin was never brought high all look exactly like a working
// circuit. Those three are the most common reasons a real motor does not turn,
// so a simulator that hides them is worse than no simulator.
//
// There is therefore no speed input anywhere below. Every case drives real pins
// and asserts what the model derives from the resulting terminal voltages.

import { MotorModel, QuadratureEncoder, STALL_FRACTION } from '../src/simulation/devices/motorState';
import { CoilStepper, StepDirDriver, HALF_STEP_SEQUENCE, FULL_STEP_SEQUENCE } from '../src/simulation/devices/steppers';
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

// ================================== 1. direction and magnitude come from volts
section('1. the terminals decide everything');
{
  const m = new MotorModel('m', 6, 300);
  m.update(6, 0, 0);
  check(m.direction === 'forward', 'six volts across it, positive first, runs forward');
  check(Math.abs(m.magnitude - 1) < 0.001, `at full magnitude (${m.magnitude.toFixed(2)})`);

  m.update(0, 6, 10);
  check(m.direction === 'reverse', 'swapping the terminals reverses it');
  check(Math.abs(m.magnitude - 1) < 0.001, 'at the same magnitude');

  m.update(3, 0, 20);
  check(m.direction === 'forward' && Math.abs(m.magnitude - 0.5) < 0.001, `half the rating is half the drive (${m.magnitude.toFixed(2)})`);

  // Below the stall fraction it does not turn. This is why a low PWM duty does
  // nothing on a bench and should do nothing here.
  m.update(6 * (STALL_FRACTION - 0.02), 0, 30);
  check(m.direction === 'stopped', 'below the stall threshold it does not turn at all');
  check(m.magnitude === 0, 'and reports no magnitude');

  // A floating terminal is not a terminal at zero volts.
  m.update(6, null, 40);
  check(m.direction === 'stopped' && !m.current.connected, 'one lead disconnected stops it and reports it as unconnected');
  m.update(null, null, 50);
  check(!m.current.connected, 'and so does both');
}

// ============================================ 2. the shaft position integrates
section('2. the shaft is integrated, not injected');
{
  const m = new MotorModel('m', 6, 60); // 60 rpm = 1 rev/second at full drive
  m.update(6, 0, 0);
  m.update(6, 0, 1000);
  check(Math.abs(m.position - 1) < 0.01, `a second at full drive is one revolution (${m.position.toFixed(3)})`);

  m.update(0, 6, 2000);
  check(Math.abs(m.position - 2) < 0.01, 'the second second still counts forward — the reverse applies from here');
  m.update(0, 6, 3000);
  check(Math.abs(m.position - 1) < 0.01, `running backwards unwinds it (${m.position.toFixed(3)})`);

  m.update(0, 0, 4000);
  const parked = m.position;
  m.update(0, 0, 9000);
  check(m.position === parked, 'a stopped motor does not drift');
}

// ================================================== 3. the encoder is derived
section('3. both encoder channels come from the same shaft');
{
  const enc = new QuadratureEncoder(4);
  // A and B are a quarter cycle apart, which is what makes direction readable.
  const a: boolean[] = [];
  const b: boolean[] = [];
  for (let i = 0; i <= 8; i++) {
    const rev = i / 32; // eight samples per cycle at 4 ppr
    a.push(enc.channelA(rev));
    b.push(enc.channelB(rev));
  }
  check(a.some((v) => v) && a.some((v) => !v), 'channel A toggles as the shaft turns');
  check(b.some((v) => v) && b.some((v) => !v), 'channel B toggles too');
  check(
    a.join() !== b.join(),
    'and the two are out of phase rather than identical — which is what direction detection needs',
  );

  // A shaft that does not move produces no transitions at all.
  const still = enc.channelA(0.5);
  check(enc.channelA(0.5) === still, 'a stationary shaft holds its channel level');
  check(enc.edgeCount(0, 0) === 0, 'and produces no edges');
  check(enc.edgeCount(0, 1) === 8, `one revolution at 4 ppr is eight edges per channel (${enc.edgeCount(0, 1)})`);
}

// ============================================== 4. the stepper's coil sequence
section('4. a stepper goes where the coils put it');
{
  const s = new CoilStepper('s', 4096);
  const apply = (pattern: number, t: number) =>
    s.setCoils((pattern & 1) !== 0, (pattern & 2) !== 0, (pattern & 4) !== 0, (pattern & 8) !== 0, t);

  // Forward through the half-step ring.
  let t = 0;
  for (let i = 0; i < 8; i++) apply(HALF_STEP_SEQUENCE[i], t++);
  check(s.stepCount === 7, `eight patterns is seven transitions forward (${s.stepCount})`);
  check(s.missedTransitions === 0, 'and none were missed');

  // Backwards.
  for (let i = 6; i >= 0; i--) apply(HALF_STEP_SEQUENCE[i], t++);
  check(s.stepCount === 0, `walking the sequence back returns it to zero (${s.stepCount})`);

  // Skipping a phase does not move it — it is counted as a miss.
  const skipper = new CoilStepper('k', 4096);
  const applyK = (pattern: number, tt: number) =>
    skipper.setCoils((pattern & 1) !== 0, (pattern & 2) !== 0, (pattern & 4) !== 0, (pattern & 8) !== 0, tt);
  applyK(HALF_STEP_SEQUENCE[0], 0);
  applyK(HALF_STEP_SEQUENCE[4], 1); // four positions away — a real skip
  check(skipper.stepCount === 0, 'a skipped phase moves it nowhere');
  check(skipper.missedTransitions === 1, 'and is recorded as a missed transition');

  // De-energising means it holds nothing.
  const holder = new CoilStepper('h', 4096);
  const applyH = (pattern: number, tt: number) =>
    holder.setCoils((pattern & 1) !== 0, (pattern & 2) !== 0, (pattern & 4) !== 0, (pattern & 8) !== 0, tt);
  applyH(FULL_STEP_SEQUENCE[0], 0);
  check(holder.isHolding, 'an energised stepper holds position');
  applyH(0, 1);
  check(!holder.isHolding, 'and one with no coils energised does not');

  // Full-stepping works too, and moves twice as far per transition — which is
  // what it does on real hardware, and why the two styles are counted in the
  // same half-step unit rather than in "steps" that mean different distances.
  const full = new CoilStepper('f', 400);
  const applyF = (pattern: number, tt: number) =>
    full.setCoils((pattern & 1) !== 0, (pattern & 2) !== 0, (pattern & 4) !== 0, (pattern & 8) !== 0, tt);
  for (let i = 0; i < 4; i++) applyF(FULL_STEP_SEQUENCE[i], i);
  check(full.stepCount === 6, `four full-step patterns is three transitions of two half-steps (${full.stepCount})`);
  check(full.missedTransitions === 0, 'and none are misread as skipped phases');

  // Three positions at once is a genuinely skipped phase and does not move it.
  const jump = new CoilStepper('j', 400);
  const applyJ = (pattern: number, tt: number) =>
    jump.setCoils((pattern & 1) !== 0, (pattern & 2) !== 0, (pattern & 4) !== 0, (pattern & 8) !== 0, tt);
  applyJ(HALF_STEP_SEQUENCE[0], 0);
  applyJ(HALF_STEP_SEQUENCE[3], 1);
  check(jump.stepCount === 0 && jump.missedTransitions === 1, 'while three positions at once is still a miss');
}

// =============================================== 5. the A4988's step and enable
section('5. STEP, DIR and the enable pin nobody remembers');
{
  const d = new StepDirDriver('d', 200);
  d.setDirection(true);
  for (let i = 0; i < 10; i++) {
    d.setStep(true);
    d.setStep(false);
  }
  check(d.microstepCount === 10, `ten rising edges are ten microsteps (${d.microstepCount})`);

  d.setDirection(false);
  for (let i = 0; i < 4; i++) {
    d.setStep(true);
    d.setStep(false);
  }
  check(d.microstepCount === 6, `DIR low counts the other way (${d.microstepCount})`);

  // Held high, STEP does nothing more: it is the edge that matters, and only
  // the first of these three calls is one. DIR is low here, so the single step
  // counts backwards — which is itself worth asserting.
  const before = d.microstepCount;
  d.setStep(true);
  d.setStep(true);
  d.setStep(true);
  check(d.microstepCount === before - 1, `only the rising edge steps, not the level (${before} -> ${d.microstepCount})`);

  // The enable pin. This is the answer to "I sent ten thousand pulses and
  // nothing moved", so it is counted rather than silently dropped.
  const off = new StepDirDriver('o', 200);
  off.setEnable(false); // ENABLE is active low; false means driven high
  for (let i = 0; i < 100; i++) {
    off.setStep(true);
    off.setStep(false);
  }
  check(off.microstepCount === 0, 'a disabled driver moves nothing');
  check(off.ignoredPulses === 100, `and says how many pulses it ignored (${off.ignoredPulses})`);

  // Microstepping changes how far a pulse count travels.
  const micro = new StepDirDriver('m', 200);
  micro.setMicrostepping(true, true, true); // 1/16
  check(micro.microstepDivisorValue === 16, 'MS1-MS3 all high is sixteenth-stepping');
  for (let i = 0; i < 3200; i++) {
    micro.setStep(true);
    micro.setStep(false);
  }
  check(Math.abs(micro.revolutions - 1) < 0.001, `3200 sixteenth-steps is one revolution (${micro.revolutions.toFixed(3)})`);

  const fullStep = new StepDirDriver('fs', 200);
  fullStep.setMicrostepping(false, false, false);
  for (let i = 0; i < 200; i++) {
    fullStep.setStep(true);
    fullStep.setStep(false);
  }
  check(Math.abs(fullStep.revolutions - 1) < 0.001, 'and 200 full steps is the same revolution');
}

// ================================ 6. a real H-bridge driving a real motor =====
section('6. an executed sketch driving a motor through an L298N');
{
  const SOURCE = [
    'const int ENA = 9, IN1 = 7, IN2 = 8;',
    'void setup() {',
    '  pinMode(ENA, OUTPUT); pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);',
    '  digitalWrite(ENA, HIGH);',
    '  digitalWrite(IN1, HIGH); digitalWrite(IN2, LOW);',   // forward
    '}',
    'void loop() {',
    '  if (millis() > 200) { digitalWrite(IN1, LOW); digitalWrite(IN2, HIGH); }',  // reverse
    '  if (millis() > 400) { digitalWrite(ENA, LOW); }',                            // coast
    '}',
  ].join('\n');

  const p = emptyProject('hbridge');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.arduino-uno', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  const drv: ComponentInstance = {
    id: uid('d'), definitionId: 'comp.motor-driver', x: 200, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  const motor: ComponentInstance = {
    id: uid('m'), definitionId: 'comp.dc-motor', x: 400, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  p.boardInstances.push(board);
  p.componentInstances.push(drv, motor);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  const wire = (a: string, ap: string, b: string, bp: string) =>
    p.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#000', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  wire(board.id, '5V', drv.id, 'vcc');
  wire(board.id, 'GND_TOP', drv.id, 'gnd');
  wire(board.id, 'D9', drv.id, 'ena');
  wire(board.id, 'D7', drv.id, 'in1');
  wire(board.id, 'D8', drv.id, 'in2');
  wire(drv.id, 'out1', motor.id, 'm1');
  wire(drv.id, 'out2', motor.id, 'm2');

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the H-bridge test cannot run');
  } else {
    simulationController.pause();
    const readMotor = () => {
      simulationController.publishNow();
      const visuals = useSimulationStore.getState().visuals as Record<
        string,
        { motor?: { direction: string; magnitude: number; connected: boolean } }
      >;
      return visuals[motor.id]?.motor;
    };

    simulationController.advance(100);
    const fwd = readMotor();
    console.log(`   t=100ms  ${fwd?.direction} @ ${fwd?.magnitude.toFixed(2)}`);
    check(fwd?.direction === 'forward', `IN1 high, IN2 low runs it forward (${fwd?.direction})`);
    check((fwd?.magnitude ?? 0) > 0.5, 'at a real magnitude');

    simulationController.advance(200);
    const rev = readMotor();
    console.log(`   t=300ms  ${rev?.direction} @ ${rev?.magnitude.toFixed(2)}`);
    check(rev?.direction === 'reverse', `swapping the inputs reverses it (${rev?.direction})`);

    simulationController.advance(200);
    const coast = readMotor();
    console.log(`   t=500ms  ${coast?.direction}`);
    check(coast?.direction === 'stopped', 'and dropping the enable stops it, whatever the inputs say');
  }
  simulationController.stop();
}

// ================================ 7. the enable nobody wired ==================
section('7. an H-bridge whose enable is driven low never turns the motor');
{
  const SOURCE = [
    'const int ENA = 9, IN1 = 7, IN2 = 8;',
    'void setup() {',
    '  pinMode(ENA, OUTPUT); pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);',
    '  digitalWrite(ENA, LOW);',                            // the mistake
    '  digitalWrite(IN1, HIGH); digitalWrite(IN2, LOW);',
    '}',
    'void loop() {}',
  ].join('\n');

  const p = emptyProject('hbridge-noenable');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.arduino-uno', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  const drv: ComponentInstance = {
    id: uid('d'), definitionId: 'comp.motor-driver', x: 200, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  const motor: ComponentInstance = {
    id: uid('m'), definitionId: 'comp.dc-motor', x: 400, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  p.boardInstances.push(board);
  p.componentInstances.push(drv, motor);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  const wire = (a: string, ap: string, b: string, bp: string) =>
    p.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#000', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  wire(board.id, '5V', drv.id, 'vcc');
  wire(board.id, 'GND_TOP', drv.id, 'gnd');
  wire(board.id, 'D9', drv.id, 'ena');
  wire(board.id, 'D7', drv.id, 'in1');
  wire(board.id, 'D8', drv.id, 'in2');
  wire(drv.id, 'out1', motor.id, 'm1');
  wire(drv.id, 'out2', motor.id, 'm2');

  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the no-enable variant would not start');
  } else {
    simulationController.pause();
    simulationController.advance(150);
    simulationController.publishNow();
    const visuals = useSimulationStore.getState().visuals as Record<string, { motor?: { direction: string } }>;
    check(
      visuals[motor.id]?.motor?.direction === 'stopped',
      `the motor never turns (${visuals[motor.id]?.motor?.direction})`,
    );
  }
  simulationController.stop();
}

// ===================================== 8. a stepper stepped by real firmware ==
section('8. an executed sketch stepping a 28BYJ-48 through a ULN2003');
{
  const SOURCE = [
    'const uint8_t PINS[4] = {8, 9, 10, 11};',
    'const uint8_t SEQ[8] = {0b0001, 0b0011, 0b0010, 0b0110, 0b0100, 0b1100, 0b1000, 0b1001};',
    'uint8_t step = 0;',
    'void setup() { for (uint8_t i = 0; i < 4; i++) pinMode(PINS[i], OUTPUT); }',
    'void loop() {',
    '  if (millis() > 300) { for (uint8_t i = 0; i < 4; i++) digitalWrite(PINS[i], LOW); return; }',
    '  uint8_t p = SEQ[step & 7];',
    '  for (uint8_t i = 0; i < 4; i++) digitalWrite(PINS[i], (p >> i) & 1);',
    '  step++;',
    '  delay(2);',
    '}',
  ].join('\n');

  const p = emptyProject('stepper');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.arduino-uno', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  const st: ComponentInstance = {
    id: uid('s'), definitionId: 'comp.stepper-28byj', x: 300, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  p.boardInstances.push(board);
  p.componentInstances.push(st);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  ['in1', 'in2', 'in3', 'in4'].forEach((pinId, i) =>
    p.connections.push({
      id: uid('w'), sourceComponentId: board.id, sourcePinId: `D${i + 8}`,
      targetComponentId: st.id, targetPinId: pinId,
      netId: '', color: '#000', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]),
  );

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the stepper firmware test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(200);
    simulationController.publishNow();
    const visuals = useSimulationStore.getState().visuals as Record<
      string,
      { value?: number; motor?: { connected: boolean; angleDegrees: number } }
    >;
    const steps = visuals[st.id]?.value ?? 0;
    console.log(`   steps after 200 ms: ${steps}`);
    check(steps > 50, `firmware walking the half-step ring moved it (${steps} steps)`);
    check(steps > 0, 'forward, because the sequence ran forward');
    check(visuals[st.id]?.motor?.connected === true, 'and it is holding position while energised');

    // Firmware de-energises after 300 ms. It kept stepping until then, so the
    // count is higher — what matters is that releasing the coils does not
    // reset it, and that it stops moving once nothing is driving it.
    simulationController.advance(200);
    simulationController.publishNow();
    const after = useSimulationStore.getState().visuals as Record<string, { motor?: { connected: boolean }; value?: number }>;
    const settled = after[st.id]?.value ?? 0;
    check(after[st.id]?.motor?.connected === false, 'de-energising releases it');
    check(settled >= steps, `and the position it reached is kept, not reset (${steps} -> ${settled})`);

    simulationController.advance(300);
    simulationController.publishNow();
    const idle = useSimulationStore.getState().visuals as Record<string, { value?: number }>;
    check((idle[st.id]?.value ?? -1) === settled, 'a released stepper does not drift');
  }
  simulationController.stop();
}

// ==================================================== 9. the parts as shipped =
section('9. the parts in the library');
{
  const ids = [
    'comp.dc-motor', 'comp.gearmotor', 'comp.vibration-motor', 'comp.dc-motor-encoder',
    'comp.stepper', 'comp.stepper-28byj', 'comp.a4988', 'comp.uln2003',
    'comp.motor-driver', 'comp.solenoid',
  ];
  for (const id of ids) {
    const def = defOf(id);
    check(def !== undefined, `${id} is in the library`);
    if (!def) continue;
    // The rule the whole checkpoint rests on.
    check(
      !def.properties.some((pp) => /speed|rpm|position|angle|steps/i.test(pp.key)),
      `${id} has no speed or position property — the circuit decides`,
    );
    const cov = COMPONENT_COVERAGE.find((c) => c.id === id);
    check(cov !== undefined && cov.status !== 'missing' && cov.status !== 'wiring', `${id} is modelled, not just drawn`);
    check((cov?.tests ?? []).includes('tests/motors.drive.mts'), `${id} names this file as its proof`);
    if (cov?.status === 'behavioral') {
      check(Boolean(cov.note), `${id} documents what it simplifies`);
    }
  }

  const enc = defOf('comp.dc-motor-encoder');
  check(enc?.pins.some((pp) => pp.id === 'enca') && enc?.pins.some((pp) => pp.id === 'encb'),
    'the encoder motor brings out both channels');
  const a4988 = defOf('comp.a4988');
  for (const pinId of ['step', 'dir', 'en', 'ms1', 'ms2', 'ms3']) {
    check(a4988?.pins.some((pp) => pp.id === pinId), `the A4988 exposes ${pinId}`);
  }
}

console.log(
  failures === 0
    ? `\nMotor and driver checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
