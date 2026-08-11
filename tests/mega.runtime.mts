// Arduino Mega 2560 runtime suite — proves genuine simulation.
//
// Every check below compiles real firmware for arduino:avr:mega through the
// CircuitDesk backend and executes it instruction-by-instruction on the
// ATmega2560 profile (8 KB SRAM at 0x200, Mega vector table, ports A-L).
// Nothing is mocked, and nothing runs on the Uno profile.

import { AVRRunner, FirmwareRejectedError, F_CPU } from '../src/simulation/avrRunner';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { AVR_BOARD_PROFILES } from '../src/boards/pinMaps';
import { emptyProject } from '../src/project/templates';
import { uid, type CircuitProject } from '../src/types';

const BASE = process.env.CIRCUITDESK_URL ?? 'http://localhost:3411';
const MEGA = AVR_BOARD_PROFILES['board.arduino-mega2560'];
const UNO = AVR_BOARD_PROFILES['board.arduino-uno'];

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

async function compileFor(boardId: string, fqbn: string, source: string): Promise<string> {
  const res = await fetch(`${BASE}/api/compiler/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ boardId, fqbn, files: [{ name: 'sketch.ino', content: source }] }),
  });
  const j = (await res.json()) as { success: boolean; firmware?: { data: string }; error?: string };
  if (!j.success || !j.firmware) throw new Error(`compile failed for ${fqbn}: ` + j.error);
  return j.firmware.data;
}

const compileMega = (source: string) => compileFor('board.arduino-mega2560', 'arduino:avr:mega', source);
const compileUno = (source: string) => compileFor('board.arduino-uno', 'arduino:avr:uno', source);

const inst = (definitionId: string, properties: Record<string, unknown> = {}) => ({
  id: uid('i'), definitionId, x: 0, y: 0, rotation: 0, properties, simulationState: {},
});
const wire = (a: { id: string }, ap: string, b: { id: string }, bp: string) => ({
  id: uid('w'), sourceComponentId: a.id, sourcePinId: ap, targetComponentId: b.id, targetPinId: bp,
  netId: '', color: '#000', points: [], routing: 'smooth' as const,
});

function run(runner: AVRRunner, binding: CircuitBinding, controls: ReturnType<typeof emptyControls>, ms: number) {
  const target = runner.cpu.cycles + (ms / 1000) * F_CPU;
  while (runner.cpu.cycles < target) {
    runner.runToCycles(Math.min(target, runner.cpu.cycles + F_CPU / 1000));
    binding.update(controls);
  }
}

// ---------- 1. Profile correctness (Mega must not look like an Uno) ----------
{
  check(MEGA.mcu === 'atmega2560', `profile MCU is atmega2560 (got ${MEGA.mcu})`);
  check(MEGA.ramEnd === 0x21ff, 'RAMEND is 0x21FF (8 KB SRAM above the extended I/O at 0x200)');
  check(MEGA.flashBytes === 256 * 1024, 'flash is 256 KB');
  check(MEGA.analogPinBase === 54 && MEGA.pinCount === 70, 'A0 = pin 54, 70 pins total (D0-D53 + A0-A15)');
  check(MEGA.ports.length === 11, `all 11 ports A-L present (got ${MEGA.ports.length})`);
  // Mega pin 13 is PB7 — on the Uno it is PB5. This is the classic wrong-profile bug.
  check(MEGA.portMap[13].port === 'B' && MEGA.portMap[13].index === 7, 'pin 13 → PB7 (Uno would be PB5)');
  check(UNO.portMap[13].index === 5, 'Uno profile untouched: pin 13 → PB5');
  check(MEGA.portMap[0].port === 'E' && MEGA.portMap[0].index === 0, 'pin 0 → PE0 (Uno would be PD0)');
  check(MEGA.portMap[22].port === 'A' && MEGA.portMap[22].index === 0, 'pin 22 → PA0 (Mega-only port)');
  check(MEGA.portMap[46].port === 'L' && MEGA.portMap[46].index === 3, 'pin 46 → PL3 (Mega-only port)');
  check(MEGA.portMap[54].adcChannel === 0 && MEGA.portMap[69].adcChannel === 15, 'A0 → ADC0 (PF0), A15 → ADC15 (PK7)');
  check(MEGA.unsupported.some((u) => /Serial1/.test(u)), 'Serial1-3 declared unsupported in the profile');
}

// ---------- 2. GPIO output + timing + serial (the core execution proof) ----------
{
  const hex = await compileMega(`void setup(){ pinMode(13, OUTPUT); Serial.begin(9600); }
void loop(){ digitalWrite(13, HIGH); Serial.println("MEGA-ON"); delay(150);
             digitalWrite(13, LOW);  Serial.println("MEGA-OFF"); delay(150); }`);
  const runner = new AVRRunner(hex, MEGA);
  let serial = '';
  runner.onSerialByte = (b) => (serial += String.fromCharCode(b));
  const edges: { ms: number; high: boolean }[] = [];
  runner.onPinChange = (pin, high) => { if (pin === 13) edges.push({ ms: runner.timeMs, high }); };
  runner.runToCycles(F_CPU); // 1 s

  check(edges.length >= 5, `GPIO output: pin 13 (PB7) toggled ${edges.length} times in 1 s`);
  const gaps = edges.slice(1, 5).map((e, i) => e.ms - edges[i].ms);
  check(gaps.every((g) => Math.abs(g - 150) < 10), `timing: delay(150) produces ~150 ms gaps (${gaps.map((g) => g.toFixed(0)).join(',')})`);
  check(serial.includes('MEGA-ON') && serial.includes('MEGA-OFF'), 'serial: USART0 output received from executed firmware');
  check(runner.snapshot().states.length === 70, 'pin snapshot covers all 70 Mega pins');
}

// ---------- 3. Button (digital input) → LED, through the circuit graph ----------
{
  const hex = await compileMega(`void setup(){ pinMode(2, INPUT_PULLUP); pinMode(13, OUTPUT); }
void loop(){ digitalWrite(13, digitalRead(2) == LOW ? HIGH : LOW); }`);
  const mega = inst('board.arduino-mega2560');
  const button = inst('comp.push-button');
  const resistor = inst('comp.resistor', { resistance: 220 });
  const led = inst('comp.led', { color: 'red' });
  const project: CircuitProject = {
    ...emptyProject('mega-button'),
    boardInstances: [mega],
    componentInstances: [button, resistor, led],
    connections: [
      wire(mega, 'D2', button, '1a'),
      wire(button, '2a', mega, 'GNDL'),
      wire(mega, 'D13', resistor, 'p1'),
      wire(resistor, 'p2', led, 'anode'),
      wire(led, 'cathode', mega, 'GNDR'),
    ],
  };
  const runner = new AVRRunner(hex, MEGA);
  const binding = new CircuitBinding(project, runner);
  check(binding.boardDef?.id === 'board.arduino-mega2560', 'circuit binding selected the Mega definition');

  const controls = emptyControls();
  run(runner, binding, controls, 120);
  check(runner.digitalPinLevel(13) === 'low', 'button released → firmware holds pin 13 LOW');
  check(!binding.update(controls).visuals.get(led.id)?.ledOn, 'button released → LED off');

  controls.pressedButtons.add(button.id);
  run(runner, binding, controls, 120);
  check(runner.digitalPinLevel(13) === 'high', 'button pressed → firmware drives pin 13 HIGH (digital input works)');
  check(Boolean(binding.update(controls).visuals.get(led.id)?.ledOn), 'button pressed → LED lit by executed firmware');
}

// ---------- 4. ADC, including the Mega-only A8-A15 range (MUX5) ----------
{
  const hex = await compileMega(`void setup(){ Serial.begin(9600); }
void loop(){ Serial.print("A0="); Serial.print(analogRead(A0));
             Serial.print(" A8="); Serial.println(analogRead(A8)); delay(50); }`);
  const mega = inst('board.arduino-mega2560');
  const potLow = inst('comp.potentiometer', { resistance: 10000 });
  const potHigh = inst('comp.potentiometer', { resistance: 10000 });
  const project: CircuitProject = {
    ...emptyProject('mega-adc'),
    boardInstances: [mega],
    componentInstances: [potLow, potHigh],
    connections: [
      wire(potLow, 't1', mega, 'GNDL'), wire(potLow, 't2', mega, '5VL'), wire(potLow, 'wiper', mega, 'A0'),
      wire(potHigh, 't1', mega, 'GNDR'), wire(potHigh, 't2', mega, '5VL'), wire(potHigh, 'wiper', mega, 'A8'),
    ],
  };
  const runner = new AVRRunner(hex, MEGA);
  let serial = '';
  runner.onSerialByte = (b) => (serial += String.fromCharCode(b));
  const binding = new CircuitBinding(project, runner);
  const controls = emptyControls();
  controls.potPositions.set(potLow.id, 0.25);
  controls.potPositions.set(potHigh.id, 1.0);
  run(runner, binding, controls, 400);

  const a0 = [...serial.matchAll(/A0=(\d+)/g)].map((m) => Number(m[1])).at(-1);
  const a8 = [...serial.matchAll(/A8=(\d+)/g)].map((m) => Number(m[1])).at(-1);
  check(a0 !== undefined && Math.abs(a0 - 256) < 40, `ADC channel 0 (A0/PF0): pot at 25% reads ≈256 (got ${a0})`);
  check(a8 !== undefined && a8 > 950, `ADC channel 8 (A8/PK0 via MUX5): pot at 100% reads ≈1023 (got ${a8})`);
}

// ---------- 5. PWM on a Mega-only timer (pin 46 = OC5A on Timer5) ----------
{
  const hex = await compileMega(`void setup(){ pinMode(11, OUTPUT); pinMode(46, OUTPUT);
  analogWrite(11, 64); analogWrite(46, 191); }
void loop(){}`);
  const runner = new AVRRunner(hex, MEGA);
  runner.runToCycles(0.3 * F_CPU);
  const snap = runner.snapshot();
  check(Math.abs(snap.duty[11] - 0.25) < 0.08, `PWM Timer1 pin 11 (OC1A/PB5): analogWrite(64) → ${(snap.duty[11] * 100).toFixed(1)}% duty`);
  check(Math.abs(snap.duty[46] - 0.75) < 0.08, `PWM Timer5 pin 46 (OC5A/PL3): analogWrite(191) → ${(snap.duty[46] * 100).toFixed(1)}% duty`);
}

// ---------- 6. Wrong-MCU firmware is rejected, not executed ----------
{
  // Firmware addressing flash at 0x9000 (36 KB): valid on the Mega's 256 KB,
  // impossible on the 328P's 32 KB. Synthetic so the check is deterministic.
  const beyond328p = ':01900000FF70\n:00000001FF\n';
  let rejected = false;
  let message = '';
  try {
    new AVRRunner(beyond328p, UNO);
  } catch (err) {
    rejected = err instanceof FirmwareRejectedError;
    message = err instanceof Error ? err.message : '';
  }
  check(rejected, `firmware beyond 32 KB refused by the 328P profile (${message.slice(0, 80)}…)`);
  let megaAccepts = false;
  try {
    new AVRRunner(beyond328p, MEGA);
    megaAccepts = true;
  } catch {
    megaAccepts = false;
  }
  check(megaAccepts, 'the same image is accepted by the ATmega2560 profile (256 KB flash)');

  let emptyRejected = false;
  try {
    new AVRRunner(':00000001FF\n', MEGA);
  } catch (err) {
    emptyRejected = err instanceof FirmwareRejectedError;
  }
  check(emptyRejected, 'empty firmware image refused');

  const { assertFirmwareMatchesBoard } = await import('../src/simulation/adapters');
  const { getBoardDefinition } = await import('../src/boards/definitions');
  let mismatchRejected = false;
  try {
    assertFirmwareMatchesBoard('board.arduino-uno', getBoardDefinition('board.arduino-mega2560')!);
  } catch {
    mismatchRejected = true;
  }
  check(mismatchRejected, 'firmware compiled for another board is refused before execution');
}

// ---------- 7. Runaway protection ----------
{
  const hex = await compileMega('void setup(){} void loop(){}');
  const runner = new AVRRunner(hex, MEGA);
  const started = Date.now();
  runner.runToCycles(F_CPU / 10); // 100 ms of simulated time must terminate quickly
  check(Date.now() - started < 10_000, 'bounded execution returns promptly (instruction budget guards runaway sketches)');
}

// ---------- 8. ADC interrupt mode uses the ATmega2560 ADC vector (0x3A) ----------
{
  // analogRead() polls ADSC and never enables ADIE, so polling alone cannot
  // detect a wrong vector. This sketch runs the ADC in interrupt mode: the
  // ISR only executes if the completion is dispatched to vector 30 (0x3A).
  // With 0x38 (ANALOG_COMP) the handler never runs and nothing is printed.
  const hex = await compileMega(`volatile int adcValue = -1;
ISR(ADC_vect) { adcValue = ADC; }
void setup(){
  Serial.begin(9600);
  ADMUX  = (1 << REFS0);                                       // AVCC reference, channel 0
  ADCSRA = (1 << ADEN) | (1 << ADIE) | (1 << ADPS2) | (1 << ADPS1) | (1 << ADPS0);
  sei();
  ADCSRA |= (1 << ADSC);
}
void loop(){
  if (adcValue >= 0) {
    Serial.print("ADC-ISR="); Serial.println(adcValue);
    adcValue = -1; delay(20); ADCSRA |= (1 << ADSC);
  }
}`);
  const { MCU_CONFIGS } = await import('../src/simulation/avr/mcuConfig');
  check(
    MCU_CONFIGS.atmega2560.adc.adcInterrupt === 0x3a,
    `ADC vector is 0x3A (vector 30), not the analog-comparator 0x38 (got 0x${MCU_CONFIGS.atmega2560.adc.adcInterrupt.toString(16)})`,
  );

  const runner = new AVRRunner(hex, MEGA);
  let serial = '';
  runner.onSerialByte = (b) => (serial += String.fromCharCode(b));
  runner.setAnalogVolts(0, 2.5); // ≈512 of 1023
  runner.runToCycles(0.3 * F_CPU);
  const readings = [...serial.matchAll(/ADC-ISR=(\d+)/g)].map((m) => Number(m[1]));
  check(readings.length > 0, `ADC interrupt mode: ISR(ADC_vect) executed (${readings.length} completions dispatched)`);
  check(
    readings.length > 0 && Math.abs(readings[0] - 512) < 30,
    `ADC interrupt mode: ISR read ≈512 at 2.5 V (got ${readings[0]})`,
  );
}

// ---------- 9. Board swap while running stops the sim (no stale pin states) ----------
{
  const { simulationController } = await import('../src/simulation/simulationController');
  const { useSimulationStore } = await import('../src/simulation/simulationStore');
  const { buildPinStatesModel, pinStateCell } = await import('../src/simulation/pinStatesModel');
  const { getBoardDefinition } = await import('../src/boards/definitions');

  const unoHex = await compileUno('void setup(){ pinMode(13, OUTPUT); } void loop(){ digitalWrite(13, HIGH); }');
  const unoProject: CircuitProject = { ...emptyProject('swap'), boardInstances: [inst('board.arduino-uno')] };
  const megaProject: CircuitProject = { ...emptyProject('swap'), boardInstances: [inst('board.arduino-mega2560')] };

  // The controller builds every board on the canvas through its own path. The
  // sketch is already compiled here, so the compiler is replaced with one that
  // hands back the artifact — everything downstream is the production code.
  simulationController.setCompiler(async () => ({
    success: true, toolchain: 'avr-gcc', toolchainVersion: '', stdout: '', stderr: '',
    diagnostics: [], durationMs: 0, firmware: { data: unoHex, format: 'intel-hex' },
    boardId: 'board.arduino-uno', fqbn: 'arduino:avr:uno',
  }));
  await simulationController.build(unoProject);
  await simulationController.start();
  check(useSimulationStore.getState().status === 'running', 'Uno simulation started');
  await new Promise((r) => setTimeout(r, 120));
  const unoSnapshot = useSimulationStore.getState().pinSnapshot;
  check(unoSnapshot !== null && unoSnapshot.states.length === 20, `Uno snapshot has 20 pin states (got ${unoSnapshot?.states.length})`);

  // Swap the canvas board to a Mega without recompiling.
  simulationController.refreshCircuit(megaProject);
  const after = useSimulationStore.getState();
  check(after.status === 'error', `board swap stops the simulation instead of running on (status: ${after.status})`);
  check(
    /Arduino Mega 2560/.test(after.error ?? '') && /recompile/i.test(after.error ?? ''),
    `board swap names the board that has no firmware and asks for a recompile (${after.error})`,
  );
  check(
    (after.pinSnapshot?.states.length ?? -1) === 0,
    `stale Uno pin states are cleared, not relabelled as Mega pins (${after.pinSnapshot?.states.length} states left)`,
  );

  // The panel model must render every Mega row without throwing on the
  // cleared snapshot, showing "—" rather than another board's state.
  const megaModel = buildPinStatesModel(getBoardDefinition('board.arduino-mega2560'));
  let renderThrew = false;
  let cells: ReturnType<typeof pinStateCell>[] = [];
  try {
    cells = megaModel.kind === 'pins' ? megaModel.rows.map((row) => pinStateCell(row, after.pinSnapshot)) : [];
  } catch {
    renderThrew = true;
  }
  check(!renderThrew && cells.length === 70, `Pin States renders all 70 Mega rows after the swap without throwing (${cells.length} cells)`);
  check(cells.every((c) => c.level === 'unavailable' && c.text === '—'), 'every Mega row reports "—" instead of a borrowed Uno state');

  // Defense in depth: even if a stale 20-entry snapshot reached the panel,
  // the out-of-range rows must not crash or invent a state.
  const staleCells = megaModel.kind === 'pins' ? megaModel.rows.map((row) => pinStateCell(row, unoSnapshot)) : [];
  check(
    staleCells.slice(20).every((c) => c.level === 'unavailable' && c.text === '—'),
    'rows beyond a stale snapshot report "—" (no undefined.toUpperCase crash)',
  );

  simulationController.stop();
}

// ---------- 10. Test bench refuses firmware built for another board ----------
{
  const { runTest } = await import('../src/testing/testRunner');
  const megaHex = await compileMega('void setup(){ pinMode(13, OUTPUT); } void loop(){ digitalWrite(13, HIGH); }');
  const unoHex = await compileUno('void setup(){ pinMode(13, OUTPUT); } void loop(){ digitalWrite(13, HIGH); }');
  const megaProject: CircuitProject = { ...emptyProject('bench'), boardInstances: [inst('board.arduino-mega2560')] };
  const unoProject: CircuitProject = { ...emptyProject('bench'), boardInstances: [inst('board.arduino-uno')] };
  const test = {
    id: 't1',
    name: 'pin 13 goes high',
    events: [],
    assertions: [{ id: 'a1', kind: 'pin-becomes-high' as const, pin: 13, withinMs: 200 }],
    timeoutMs: 300,
  };

  const unoOnMega = await runTest(megaProject, { hex: unoHex, boardId: 'board.arduino-uno' }, test);
  check(
    unoOnMega.status === 'error' && /compiled for "board.arduino-uno"/.test(unoOnMega.message ?? ''),
    `cached Uno firmware never executes on a Mega project (${unoOnMega.status}: ${(unoOnMega.message ?? '').slice(0, 60)}…)`,
  );

  const megaOnUno = await runTest(unoProject, { hex: megaHex, boardId: 'board.arduino-mega2560' }, test);
  check(
    megaOnUno.status === 'error' && /compiled for "board.arduino-mega2560"/.test(megaOnUno.message ?? ''),
    `cached Mega firmware never executes on an Uno project (${megaOnUno.status}: ${(megaOnUno.message ?? '').slice(0, 60)}…)`,
  );

  const matching = await runTest(megaProject, { hex: megaHex, boardId: 'board.arduino-mega2560' }, test);
  check(matching.status === 'passed', `matching cached firmware still runs normally (${matching.status})`);
  const matchingUno = await runTest(unoProject, { hex: unoHex, boardId: 'board.arduino-uno' }, test);
  check(matchingUno.status === 'passed', `Uno test bench is unaffected (${matchingUno.status})`);
}

console.log(failures === 0 ? '\nAll Mega 2560 runtime checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
