// Simulator behavior QA (Node, headless): verifies digital input (button),
// analog input (potentiometer → real ADC), PWM duty measurement, and
// servo pulse-width measurement — all through compiled firmware executing
// on the real emulator plus the real circuit binding.

import { AVRRunner, F_CPU } from '../src/simulation/avrRunner';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { PROJECT_TEMPLATES } from '../src/project/templates';
import type { CircuitProject } from '../src/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

async function compileFiles(files: { name: string; content: string }[]): Promise<string> {
  const res = await fetch('http://localhost:3411/api/compiler/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fqbn: 'arduino:avr:uno', files }),
  });
  const json = (await res.json()) as { success: boolean; firmware?: { data: string }; error?: string };
  if (!json.success || !json.firmware) throw new Error('compile failed: ' + json.error);
  return json.firmware.data;
}

function template(id: string): CircuitProject {
  const t = PROJECT_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error('missing template ' + id);
  return t.build();
}

interface RunResult {
  runner: AVRRunner;
  binding: CircuitBinding;
  serial: string;
  ledStates: boolean[];
}

async function runProject(
  project: CircuitProject,
  hex: string,
  phases: { ms: number; setup?: (c: ReturnType<typeof emptyControls>) => void }[],
): Promise<RunResult> {
  const runner = new AVRRunner(hex);
  let serial = '';
  const decoder = new TextDecoder();
  runner.onSerialByte = (b) => (serial += decoder.decode(new Uint8Array([b]), { stream: true }));
  const binding = new CircuitBinding(project, runner);
  const controls = emptyControls();
  const ledStates: boolean[] = [];
  const led = project.componentInstances.find((i) => i.definitionId === 'comp.led');

  for (const phase of phases) {
    phase.setup?.(controls);
    const target = runner.cpu.cycles + (phase.ms / 1000) * F_CPU;
    while (runner.cpu.cycles < target) {
      runner.runToCycles(runner.cpu.cycles + F_CPU / 1000); // 1ms slices
      const { visuals } = binding.update(controls);
      if (led) ledStates.push(Boolean(visuals.get(led.id)?.ledOn));
    }
  }
  return { runner, binding, serial, ledStates };
}

// ---- 1. Button → digital input → LED (visual driven by firmware) ----
{
  const project = template('tpl.button-led');
  const hex = await compileFiles(project.codeFiles.map((f) => ({ name: f.name, content: f.content })));
  const button = project.componentInstances.find((i) => i.definitionId === 'comp.push-button')!;

  const released = await runProject(project, hex, [{ ms: 300 }]);
  const d13Released = released.runner.snapshot().states[13];
  check(d13Released === 'low', `button released → D13 stays LOW (got ${d13Released})`);
  check(!released.ledStates[released.ledStates.length - 1], 'button released → LED visual off');

  const pressed = await runProject(project, hex, [
    { ms: 200 },
    { ms: 300, setup: (c) => c.pressedButtons.add(button.id) },
  ]);
  const d13Pressed = pressed.runner.snapshot().states[13];
  check(d13Pressed === 'high', `button pressed → firmware drives D13 HIGH (got ${d13Pressed})`);
  check(pressed.ledStates[pressed.ledStates.length - 1], 'button pressed → LED visual on');
  check(pressed.serial.includes('Button pressed'), 'button press reported over emulated serial');
}

// ---- 2. Potentiometer → real ADC → analogRead over serial ----
{
  const project = template('tpl.potentiometer');
  const hex = await compileFiles(project.codeFiles.map((f) => ({ name: f.name, content: f.content })));
  const pot = project.componentInstances.find((i) => i.definitionId === 'comp.potentiometer')!;

  const high = await runProject(project, hex, [{ ms: 600, setup: (c) => c.potPositions.set(pot.id, 1.0) }]);
  const highVals = [...high.serial.matchAll(/A0 = (\d+)/g)].map((m) => Number(m[1]));
  check(highVals.length > 0 && highVals[highVals.length - 1] > 950, `pot at 100% → analogRead ≈1023 (got ${highVals.at(-1)})`);

  const low = await runProject(project, hex, [{ ms: 600, setup: (c) => c.potPositions.set(pot.id, 0.0) }]);
  const lowVals = [...low.serial.matchAll(/A0 = (\d+)/g)].map((m) => Number(m[1]));
  check(lowVals.length > 0 && lowVals[lowVals.length - 1] < 60, `pot at 0% → analogRead ≈0 (got ${lowVals.at(-1)})`);
}

// ---- 3. PWM duty cycle measured from timer-driven pin ----
{
  const hex = await compileFiles([{
    name: 'sketch.ino',
    content: 'void setup() { pinMode(9, OUTPUT); analogWrite(9, 64); }\nvoid loop() {}\n',
  }]);
  const runner = new AVRRunner(hex);
  runner.runToCycles(0.3 * F_CPU);
  const duty = runner.snapshot().duty[9];
  check(Math.abs(duty - 0.25) < 0.08, `analogWrite(9, 64) → measured duty ≈25% (got ${(duty * 100).toFixed(1)}%)`);
}

// ---- 4. Servo pulse width → angle ----
{
  const project = template('tpl.servo-sweep');
  const hex = await compileFiles(project.codeFiles.map((f) => ({ name: f.name, content: f.content })));
  const servo = project.componentInstances.find((i) => i.definitionId === 'comp.servo')!;
  const result = await runProject(project, hex, [{ ms: 400 }]);
  const width = result.runner.snapshot().pulseWidthUs[9];
  check(width >= 900 && width <= 2100, `servo signal pulse width in 1000-2000µs band (got ${width.toFixed(0)}µs)`);
  const { visuals } = result.binding.update(emptyControls());
  const angle = visuals.get(servo.id)?.servoAngle;
  check(angle !== undefined && angle >= 0 && angle <= 180, `servo angle derived from pulse (got ${angle?.toFixed(1)}°)`);
}

// ---- 5. Ultrasonic echo protocol ----
{
  const project = template('tpl.ultrasonic');
  const hex = await compileFiles(project.codeFiles.map((f) => ({ name: f.name, content: f.content })));
  const sonar = project.componentInstances.find((i) => i.definitionId === 'comp.ultrasonic')!;
  const near = await runProject(project, hex, [{ ms: 900, setup: (c) => c.sensorValues.set(sonar.id, 10) }]);
  const nearVals = [...near.serial.matchAll(/(\d+) cm/g)].map((m) => Number(m[1]));
  check(
    nearVals.some((v) => v >= 8 && v <= 12),
    `ultrasonic at 10cm → firmware measures ≈10cm via echo pulse (got ${nearVals.slice(-3).join(',')})`,
  );
}

// ---- 6. Arduino Nano: genuine simulation on its OWN board profile ----
{
  const { AVR_BOARD_PROFILES } = await import('../src/boards/pinMaps');
  const nanoProfile = AVR_BOARD_PROFILES['board.arduino-nano'];
  const mkInst = (definitionId: string, extra: Record<string, unknown> = {}) => ({
    id: 'i_' + definitionId.replace(/\W/g, '') + Math.random().toString(36).slice(2, 6),
    definitionId, x: 0, y: 0, rotation: 0, properties: extra, simulationState: {},
  });
  const mkWire = (a: { id: string }, ap: string, b: { id: string }, bp: string) => ({
    id: 'w' + Math.random().toString(36).slice(2, 8),
    sourceComponentId: a.id, sourcePinId: ap, targetComponentId: b.id, targetPinId: bp,
    netId: '', color: '#000', points: [], routing: 'smooth' as const,
  });

  const nano = mkInst('board.arduino-nano');
  const resistor = mkInst('comp.resistor', { resistance: 220 });
  const led = mkInst('comp.led', { color: 'red' });
  const button = mkInst('comp.push-button');
  const pot = mkInst('comp.potentiometer', { resistance: 10000 });
  const base = template('tpl.blink'); // reuse structure, replace circuit entirely
  const nanoProject: CircuitProject = {
    ...base,
    boardInstances: [nano],
    componentInstances: [resistor, led, button, pot],
    connections: [
      mkWire(nano, 'D13', resistor, 'p1'),
      mkWire(resistor, 'p2', led, 'anode'),
      mkWire(led, 'cathode', nano, 'GND1'),
      mkWire(nano, 'D2', button, '1a'),
      mkWire(button, '2a', nano, 'GND2'),
      mkWire(pot, 't1', nano, 'GND1'),
      mkWire(pot, 't2', nano, '5V'),
      mkWire(pot, 'wiper', nano, 'A6'),
    ],
  };
  const nanoCode = `void setup() { pinMode(13, OUTPUT); pinMode(2, INPUT_PULLUP); Serial.begin(9600); }
void loop() {
  digitalWrite(13, digitalRead(2) == LOW ? HIGH : LOW);
  Serial.print("A6="); Serial.println(analogRead(A6));
  delay(100);
}`;
  const res = await fetch('http://localhost:3411/api/compiler/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ boardId: 'board.arduino-nano', fqbn: 'arduino:avr:nano', files: [{ name: 'sketch.ino', content: nanoCode }] }),
  });
  const json = (await res.json()) as { success: boolean; firmware?: { data: string }; error?: string; toolchain?: string };
  check(json.success === true, `Nano sketch compiles as arduino:avr:nano (eightanaloginputs variant, ${json.toolchain})`);
  if (json.success && json.firmware) {
    // digital input released → D13 LOW
    const runner1 = new AVRRunner(json.firmware.data, nanoProfile);
    let serial1 = '';
    runner1.onSerialByte = (b) => (serial1 += String.fromCharCode(b));
    const binding1 = new CircuitBinding(nanoProject, runner1);
    check(binding1.boardDef?.id === 'board.arduino-nano', 'Nano binding uses the Nano definition (not the Uno)');
    const controls1 = emptyControls();
    controls1.potPositions.set(pot.id, 0.75);
    for (let i = 0; i < 400; i++) {
      runner1.runToCycles(runner1.cpu.cycles + F_CPU / 1000);
      binding1.update(controls1);
    }
    check(runner1.snapshot().states[13] === 'low', 'Nano GPIO output: D13 LOW while button released');
    const a6vals = [...serial1.matchAll(/A6=(\d+)/g)].map((m) => Number(m[1]));
    check(a6vals.length > 0 && Math.abs((a6vals.at(-1) ?? 0) - 767) < 40,
      `Nano ADC-only A6 (channel 6) reads pot at 75% ≈767 (got ${a6vals.at(-1)})`);

    // press button → firmware drives D13 HIGH → LED visual on
    controls1.pressedButtons.add(button.id);
    for (let i = 0; i < 300; i++) {
      runner1.runToCycles(runner1.cpu.cycles + F_CPU / 1000);
      binding1.update(controls1);
    }
    check(runner1.snapshot().states[13] === 'high', 'Nano GPIO input: button press → firmware drives D13 HIGH');
    const { visuals } = binding1.update(controls1);
    check(Boolean(visuals.get(led.id)?.ledOn), 'Nano LED visual driven by executed firmware');
    check(serial1.includes('A6='), 'Nano serial output works on emulated USART');
  }
}

console.log(failures === 0 ? '\nAll simulator behavior checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
