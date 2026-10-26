// Arduino Leonardo runtime suite — proves genuine ATmega32U4 simulation.
//
// Every execution check below compiles real firmware for arduino:avr:leonardo
// through the CircuitDesk backend and runs it instruction-by-instruction on the
// ATmega32U4 profile (2.5 KB SRAM, 32U4 vector table, ports B-F, USART1).
// Nothing is mocked, and nothing runs on the Uno or Mega profile.

import { AVRRunner, FirmwareRejectedError, F_CPU } from '../src/simulation/avrRunner';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { AVR_BOARD_PROFILES } from '../src/boards/pinMaps';
import { emptyProject } from '../src/project/templates';
import { uid, type CircuitProject } from '../src/types';

const BASE = process.env.CIRCUITDESK_URL ?? 'http://localhost:3411';
const LEO = AVR_BOARD_PROFILES['board.arduino-leonardo'];
const UNO = AVR_BOARD_PROFILES['board.arduino-uno'];
const MEGA = AVR_BOARD_PROFILES['board.arduino-mega2560'];

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
const compileLeo = (s: string) => compileFor('board.arduino-leonardo', 'arduino:avr:leonardo', s);
const compileUno = (s: string) => compileFor('board.arduino-uno', 'arduino:avr:uno', s);

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

// ---------- 1. Profile correctness: every pin, and no other board's layout ----------
{
  check(LEO.mcu === 'atmega32u4', `profile MCU is atmega32u4 (got ${LEO.mcu})`);
  check(LEO.ramEnd === 0x0aff, 'RAMEND is 0x0AFF (2.5 KB SRAM at 0x0100)');
  check(LEO.flashBytes === 32 * 1024, 'flash is 32 KB');
  check(LEO.analogPinBase === 18 && LEO.pinCount === 24, 'A0 = pin 18, 24 pins total (D0-D17 + A0-A5)');
  check(JSON.stringify(LEO.ports) === JSON.stringify(['B', 'C', 'D', 'E', 'F']), `ports B-F only (got ${LEO.ports.join('')})`);

  // Full pin table from the leonardo variant's pins_arduino.h.
  const expected: [number, string, number, number | undefined][] = [
    [0, 'D', 2, undefined], [1, 'D', 3, undefined], [2, 'D', 1, undefined], [3, 'D', 0, undefined],
    [4, 'D', 4, undefined], [5, 'C', 6, undefined], [6, 'D', 7, undefined], [7, 'E', 6, undefined],
    [8, 'B', 4, undefined], [9, 'B', 5, undefined], [10, 'B', 6, undefined], [11, 'B', 7, undefined],
    [12, 'D', 6, undefined], [13, 'C', 7, undefined],
    [14, 'B', 3, undefined], [15, 'B', 1, undefined], [16, 'B', 2, undefined], [17, 'B', 0, undefined],
    [18, 'F', 7, 7], [19, 'F', 6, 6], [20, 'F', 5, 5], [21, 'F', 4, 4], [22, 'F', 1, 1], [23, 'F', 0, 0],
  ];
  let allOk = true;
  for (const [pin, port, index, adc] of expected) {
    const ref = LEO.portMap[pin];
    if (!ref || ref.port !== port || ref.index !== index || ref.adcChannel !== adc) {
      allOk = false;
      console.log(`  pin ${pin}: expected P${port}${index}${adc !== undefined ? ` ADC${adc}` : ''}, got ${ref ? `P${ref.port}${ref.index}` : 'nothing'}`);
    }
  }
  check(allOk, 'all 24 Leonardo pins map to the correct ATmega32U4 port/bit (D0-D17, A0-A5)');
  check(Object.keys(LEO.portMap).length === 24, `no stray pins in the map (${Object.keys(LEO.portMap).length})`);

  // The classic wrong-profile bugs: D13 is PC7 here, PB5 on the Uno, PB7 on the Mega.
  check(LEO.portMap[13].port === 'C' && LEO.portMap[13].index === 7, 'pin 13 → PC7 (Uno would be PB5, Mega PB7)');
  check(UNO.portMap[13].port === 'B' && UNO.portMap[13].index === 5, 'Uno profile untouched: pin 13 → PB5');
  check(MEGA.portMap[13].port === 'B' && MEGA.portMap[13].index === 7, 'Mega profile untouched: pin 13 → PB7');
  check(LEO.portMap[0].port === 'D' && LEO.portMap[0].index === 2, 'pin 0 → PD2 (Uno would be PD0)');
  // A6-A11 are alternate functions, not addressable pins on this profile.
  check(LEO.portMap[24] === undefined, 'A6-A11 are not exposed as separate pins (unsupported ADC channels)');
  check(LEO.unsupported.some((u) => /native USB/i.test(u)), 'native USB declared unsupported in the profile');
  check(LEO.unsupported.some((u) => /Timer4/.test(u)), 'Timer4 (D6/D13 PWM) declared unsupported');
  check(LEO.unsupported.some((u) => /ADC channels 8-13/.test(u)), 'A6-A11 ADC channels declared unsupported');
}

// ---------- 2. GPIO output + timing + Serial1 (the core execution proof) ----------
{
  const hex = await compileLeo(`void setup(){ pinMode(13, OUTPUT); Serial1.begin(9600); }
void loop(){ digitalWrite(13, HIGH); Serial1.println("LEO-ON"); delay(120);
             digitalWrite(13, LOW);  Serial1.println("LEO-OFF"); delay(120); }`);
  const runner = new AVRRunner(hex, LEO);
  let serial = '';
  runner.onSerialByte = (b) => (serial += String.fromCharCode(b));
  const edges: { ms: number; high: boolean }[] = [];
  runner.onPinChange = (pin, high) => { if (pin === 13) edges.push({ ms: runner.timeMs, high }); };
  runner.runToCycles(F_CPU); // 1 s

  check(edges.length >= 6, `GPIO output: pin 13 (PC7) toggled ${edges.length} times in 1 s`);
  const gaps = edges.slice(1, 5).map((e, i) => e.ms - edges[i].ms);
  check(gaps.every((g) => Math.abs(g - 120) < 10), `timing: delay(120) produces ~120 ms gaps (${gaps.map((g) => g.toFixed(0)).join(',')})`);
  check(serial.includes('LEO-ON') && serial.includes('LEO-OFF'), 'Serial1: USART1 output received from executed firmware');
  check(runner.snapshot().states.length === 24, 'pin snapshot covers all 24 Leonardo pins');
}

// ---------- 3. millis() advances at the right rate (Timer0) ----------
{
  const hex = await compileLeo(`void setup(){ Serial1.begin(9600); }
void loop(){ Serial1.print("t="); Serial1.println(millis()); delay(100); }`);
  const runner = new AVRRunner(hex, LEO);
  let serial = '';
  runner.onSerialByte = (b) => (serial += String.fromCharCode(b));
  runner.runToCycles(F_CPU * 0.6);
  const stamps = [...serial.matchAll(/t=(\d+)/g)].map((m) => Number(m[1]));
  check(stamps.length >= 4, `millis(): ${stamps.length} readings emitted`);
  const deltas = stamps.slice(1).map((t, i) => t - stamps[i]);
  check(deltas.every((d) => Math.abs(d - 100) <= 2), `millis() advances ~100 ms per loop (${deltas.join(',')})`);
}

// ---------- 4. Digital input → LED through the circuit graph (ports E and C) ----------
{
  const hex = await compileLeo(`void setup(){ pinMode(7, INPUT_PULLUP); pinMode(13, OUTPUT); }
void loop(){ digitalWrite(13, digitalRead(7) == LOW ? HIGH : LOW); }`);
  const leo = inst('board.arduino-leonardo');
  const button = inst('comp.push-button');
  const resistor = inst('comp.resistor', { resistance: 220 });
  const led = inst('comp.led', { color: 'red' });
  const project: CircuitProject = {
    ...emptyProject('leo-button'),
    boardInstances: [leo],
    componentInstances: [button, resistor, led],
    connections: [
      wire(leo, 'D7', button, '1a'),
      wire(button, '2a', leo, 'GND1'),
      wire(leo, 'D13', resistor, 'p1'),
      wire(resistor, 'p2', led, 'anode'),
      wire(led, 'cathode', leo, 'GND2'),
    ],
  };
  const runner = new AVRRunner(hex, LEO);
  const binding = new CircuitBinding(project, runner);
  check(binding.boardDef?.id === 'board.arduino-leonardo', 'circuit binding selected the Leonardo definition');

  const controls = emptyControls();
  run(runner, binding, controls, 120);
  check(runner.digitalPinLevel(13) === 'low', 'button released → firmware holds pin 13 LOW');
  check(!binding.update(controls).visuals.get(led.id)?.ledOn, 'button released → LED off');

  controls.pressedButtons.add(button.id);
  run(runner, binding, controls, 120);
  check(runner.digitalPinLevel(13) === 'high', 'button pressed → firmware drives pin 13 HIGH (PE6 input works)');
  check(Boolean(binding.update(controls).visuals.get(led.id)?.ledOn), 'button pressed → LED lit by executed firmware');
}

// ---------- 5. ADC on A0 and A5 (port F, channels 7 and 0) ----------
{
  const hex = await compileLeo(`void setup(){ Serial1.begin(9600); }
void loop(){ Serial1.print("A0="); Serial1.print(analogRead(A0));
             Serial1.print(" A5="); Serial1.println(analogRead(A5)); delay(50); }`);
  const leo = inst('board.arduino-leonardo');
  const potA = inst('comp.potentiometer', { resistance: 10000 });
  const potB = inst('comp.potentiometer', { resistance: 10000 });
  const project: CircuitProject = {
    ...emptyProject('leo-adc'),
    boardInstances: [leo],
    componentInstances: [potA, potB],
    connections: [
      wire(potA, 't1', leo, 'GND1'), wire(potA, 't2', leo, '5V'), wire(potA, 'wiper', leo, 'A0'),
      wire(potB, 't1', leo, 'GND2'), wire(potB, 't2', leo, '5V'), wire(potB, 'wiper', leo, 'A5'),
    ],
  };
  const runner = new AVRRunner(hex, LEO);
  let serial = '';
  runner.onSerialByte = (b) => (serial += String.fromCharCode(b));
  const binding = new CircuitBinding(project, runner);
  const controls = emptyControls();
  controls.potPositions.set(potA.id, 0.5);
  controls.potPositions.set(potB.id, 1.0);
  run(runner, binding, controls, 400);

  const a0 = [...serial.matchAll(/A0=(\d+)/g)].map((m) => Number(m[1])).at(-1);
  const a5 = [...serial.matchAll(/A5=(\d+)/g)].map((m) => Number(m[1])).at(-1);
  check(a0 !== undefined && Math.abs(a0 - 512) < 40, `ADC channel 7 (A0/PF7): pot at 50% reads ≈512 (got ${a0})`);
  check(a5 !== undefined && a5 > 950, `ADC channel 0 (A5/PF0): pot at 100% reads ≈1023 (got ${a5})`);
}

// ---------- 6. PWM across every implemented timer family ----------
{
  const hex = await compileLeo(`void setup(){
  pinMode(11, OUTPUT); pinMode(3, OUTPUT); pinMode(9, OUTPUT); pinMode(10, OUTPUT); pinMode(5, OUTPUT);
  analogWrite(11, 64);   // Timer0 OC0A → PB7
  analogWrite(3, 191);   // Timer0 OC0B → PD0
  analogWrite(9, 128);   // Timer1 OC1A → PB5
  analogWrite(10, 64);   // Timer1 OC1B → PB6
  analogWrite(5, 191);   // Timer3 OC3A → PC6
}
void loop(){}`);
  const runner = new AVRRunner(hex, LEO);
  runner.runToCycles(0.3 * F_CPU);
  const snap = runner.snapshot();
  check(Math.abs(snap.duty[11] - 0.25) < 0.08, `PWM Timer0 pin 11 (OC0A/PB7): analogWrite(64) → ${(snap.duty[11] * 100).toFixed(1)}%`);
  check(Math.abs(snap.duty[3] - 0.75) < 0.08, `PWM Timer0 pin 3 (OC0B/PD0): analogWrite(191) → ${(snap.duty[3] * 100).toFixed(1)}%`);
  check(Math.abs(snap.duty[9] - 0.5) < 0.08, `PWM Timer1 pin 9 (OC1A/PB5): analogWrite(128) → ${(snap.duty[9] * 100).toFixed(1)}%`);
  check(Math.abs(snap.duty[10] - 0.25) < 0.08, `PWM Timer1 pin 10 (OC1B/PB6): analogWrite(64) → ${(snap.duty[10] * 100).toFixed(1)}%`);
  check(Math.abs(snap.duty[5] - 0.75) < 0.08, `PWM Timer3 pin 5 (OC3A/PC6): analogWrite(191) → ${(snap.duty[5] * 100).toFixed(1)}%`);
}

// ---------- 7. Honesty: unemulated hardware stays silent, it is not faked ----------
{
  // (a) Timer4 PWM (D13/D6) is declared unsupported — it must not appear to work.
  const hex = await compileLeo(`void setup(){ pinMode(13, OUTPUT); pinMode(6, OUTPUT);
  analogWrite(13, 128); analogWrite(6, 128); }
void loop(){}`);
  const runner = new AVRRunner(hex, LEO);
  runner.runToCycles(0.2 * F_CPU);
  const snap = runner.snapshot();
  const flat = (d: number) => d < 0.02 || d > 0.98;
  check(flat(snap.duty[13]) && flat(snap.duty[6]), `Timer4 PWM on D13/D6 produces no modulation, as declared (duty ${snap.duty[13].toFixed(2)}/${snap.duty[6].toFixed(2)})`);

  // (b) The native-USB "Serial" object must produce nothing — the alternative
  //     would be silently routing USB CDC onto USART1 and calling it Serial.
  const usbHex = await compileLeo(`void setup(){ Serial.begin(9600); Serial1.begin(9600); }
void loop(){ Serial.println("USB-CDC"); Serial1.println("UART1"); delay(50); }`);
  const usbRunner = new AVRRunner(usbHex, LEO);
  let out = '';
  usbRunner.onSerialByte = (b) => (out += String.fromCharCode(b));
  usbRunner.runToCycles(0.4 * F_CPU);
  check(out.includes('UART1'), 'Serial1 output is emitted from the emulated USART1');
  check(!out.includes('USB-CDC'), 'native USB Serial is NOT mapped onto USART1 — it produces no output, as declared');
}

// ---------- 8. Serial1 receive path ----------
{
  const hex = await compileLeo(`void setup(){ Serial1.begin(9600); pinMode(13, OUTPUT); }
void loop(){ if (Serial1.available()) { char c = Serial1.read(); Serial1.print("got:"); Serial1.println(c);
  if (c == 'X') digitalWrite(13, HIGH); } }`);
  const runner = new AVRRunner(hex, LEO);
  let serial = '';
  runner.onSerialByte = (b) => (serial += String.fromCharCode(b));
  runner.runToCycles(0.05 * F_CPU);
  runner.queueSerialInput('X');
  runner.runToCycles(0.3 * F_CPU);
  check(serial.includes('got:X'), `Serial1 RX: firmware echoed the byte sent to it (${JSON.stringify(serial.slice(-12))})`);
  check(runner.digitalPinLevel(13) === 'high', 'Serial1 RX drove a real GPIO change');
}

// ---------- 9. Wrong-board firmware is rejected in both directions ----------
{
  const { assertFirmwareMatchesBoard } = await import('../src/simulation/adapters');
  const { getBoardDefinition } = await import('../src/boards/definitions');
  const leoDef = getBoardDefinition('board.arduino-leonardo')!;
  const unoDef = getBoardDefinition('board.arduino-uno')!;

  let leoOnUno = false;
  try { assertFirmwareMatchesBoard('board.arduino-leonardo', unoDef); } catch { leoOnUno = true; }
  check(leoOnUno, 'Leonardo firmware is refused on an Uno board');
  let unoOnLeo = false;
  try { assertFirmwareMatchesBoard('board.arduino-uno', leoDef); } catch { unoOnLeo = true; }
  check(unoOnLeo, 'Uno firmware is refused on a Leonardo board');

  // Firmware too large for the 32U4's 32 KB flash is refused outright.
  const beyond32u4 = ':01900000FF70\n:00000001FF\n'; // addresses 0x9000 = 36 KB
  let sizeRejected = false;
  try { new AVRRunner(beyond32u4, LEO); } catch (err) { sizeRejected = err instanceof FirmwareRejectedError; }
  check(sizeRejected, 'firmware beyond 32 KB is refused by the ATmega32U4 profile');
  let emptyRejected = false;
  try { new AVRRunner(':00000001FF\n', LEO); } catch (err) { emptyRejected = err instanceof FirmwareRejectedError; }
  check(emptyRejected, 'empty firmware image refused');

  // The test bench applies the same guard.
  const { runTest } = await import('../src/testing/testRunner');
  const unoHex = await compileUno('void setup(){ pinMode(13, OUTPUT); } void loop(){ digitalWrite(13, HIGH); }');
  const leoHex = await compileLeo('void setup(){ pinMode(13, OUTPUT); } void loop(){ digitalWrite(13, HIGH); }');
  const leoProject: CircuitProject = { ...emptyProject('bench'), boardInstances: [inst('board.arduino-leonardo')] };
  const unoProject: CircuitProject = { ...emptyProject('bench'), boardInstances: [inst('board.arduino-uno')] };
  const test = {
    id: 't1', name: 'pin 13 goes high', events: [],
    assertions: [{ id: 'a1', kind: 'pin-becomes-high' as const, pin: 13, withinMs: 200 }],
    timeoutMs: 300,
  };
  const wrongA = await runTest(leoProject, { data: unoHex, boardId: 'board.arduino-uno' }, test);
  check(wrongA.status === 'error', `test bench refuses Uno firmware on a Leonardo project (${wrongA.status})`);
  const wrongB = await runTest(unoProject, { data: leoHex, boardId: 'board.arduino-leonardo' }, test);
  check(wrongB.status === 'error', `test bench refuses Leonardo firmware on an Uno project (${wrongB.status})`);
  const right = await runTest(leoProject, { data: leoHex, boardId: 'board.arduino-leonardo' }, test);
  check(right.status === 'passed', `matching Leonardo firmware runs in the test bench (${right.status})`);
}

// ---------- 10. Board swap while running, and the full pin-state panel ----------
{
  const { simulationController } = await import('../src/simulation/simulationController');
  const { useSimulationStore } = await import('../src/simulation/simulationStore');
  const { buildPinStatesModel, pinStateCell } = await import('../src/simulation/pinStatesModel');
  const { getBoardDefinition } = await import('../src/boards/definitions');

  const leoHex = await compileLeo('void setup(){ pinMode(13, OUTPUT); } void loop(){ digitalWrite(13, HIGH); delay(50); digitalWrite(13, LOW); delay(50); }');
  const leoProject: CircuitProject = { ...emptyProject('swap'), boardInstances: [inst('board.arduino-leonardo')] };
  const unoProject: CircuitProject = { ...emptyProject('swap'), boardInstances: [inst('board.arduino-uno')] };

  simulationController.setCompiler(async () => ({
    success: true, toolchain: 'avr-gcc', toolchainVersion: '', stdout: '', stderr: '',
    diagnostics: [], durationMs: 0, firmware: { data: leoHex, format: 'intel-hex' },
    boardId: 'board.arduino-leonardo', fqbn: 'arduino:avr:leonardo',
  }));
  await simulationController.build(leoProject);
  await simulationController.start();
  check(useSimulationStore.getState().status === 'running', 'Leonardo simulation starts through the controller');
  await new Promise((r) => setTimeout(r, 150));
  const live = useSimulationStore.getState().pinSnapshot;
  check(live !== null && live.states.length === 24, `live snapshot carries 24 Leonardo pins (got ${live?.states.length})`);

  simulationController.refreshCircuit(unoProject);
  const after = useSimulationStore.getState();
  check(after.status === 'error', `swapping Leonardo → Uno stops the simulation (status: ${after.status})`);
  check((after.pinSnapshot?.states.length ?? -1) === 0, 'stale Leonardo pin states are cleared on the swap');
  simulationController.stop();

  // Pin States panel model for the Leonardo.
  const model = buildPinStatesModel(getBoardDefinition('board.arduino-leonardo'));
  const rows = model.kind === 'pins' ? model.rows : [];
  // 23 rows, not 24: D17 (PB0/SS) drives the RX LED and is not broken out on
  // the header, so it exists in the profile but has no connectable pin.
  check(rows.length === 23, `Pin States lists every header pin: D0-D16 + A0-A5 (got ${rows.length})`);
  const labels = rows.map((r) => r.label);
  check(
    labels.includes('D0') && labels.includes('D13') && labels.includes('D16') && labels.includes('A0') && labels.includes('A5'),
    'Pin States covers D0-D16 (incl. the ICSP SPI pins) and A0-A5',
  );
  check(
    !labels.includes('D17') && LEO.portMap[17] !== undefined,
    'D17 (SS/RX LED) is driveable by firmware but is not a header pin, so it has no row',
  );
  check(!labels.some((l) => /^A(6|7|8|9|10|11)$/.test(l)), 'Pin States does not offer A6-A11 (unsupported ADC channels)');
  let threw = false;
  try {
    rows.map((r) => pinStateCell(r, after.pinSnapshot));
  } catch {
    threw = true;
  }
  check(!threw, 'Pin States renders the Leonardo rows safely after a board swap');
}

console.log(failures === 0 ? '\nAll Leonardo runtime checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
