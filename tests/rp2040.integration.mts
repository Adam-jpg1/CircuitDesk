// Raspberry Pi Pico simulation, exercised through the production code paths.
//
// Nothing here reaches into a test harness. Firmware is compiled by the real
// backend, handed to the real adapter registry, executed by the production
// RP2040 runner, and observed through the real CircuitBinding and the real Pin
// States model — the same objects the application uses when a user presses
// Run. A circuit is built the way a user would build it: a board, some parts,
// and wires between named pins.
//
// The sketches are ordinary Arduino code. Nothing is patched, no startup
// function is skipped by address, the program counter is never forced into
// user code, and no Arduino function is intercepted. Every observation is
// taken at a pad, a peripheral register or a rendered component visual.

import { getSimulatorAdapter, runnableProcessorProfileIds, assertFirmwareMatchesBoard, firmwareFormatForBoard } from '../src/simulation/adapters';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { buildPinStatesModel, pinStateCell } from '../src/simulation/pinStatesModel';
import { runnerPinIndex, runnerAdcChannel, runnerPinCount, boardAdcReference } from '../src/simulation/boardRunner';
import type { BoardRunner } from '../src/simulation/boardRunner';
import { getBoardDefinition } from '../src/boards/definitions';
import { emptyProject } from '../src/project/templates';
import { FirmwareRejectedError } from '../src/simulation/rp2040/uf2';
import type { CircuitProject, ComponentInstance } from '../src/types';

const BASE = process.env.CIRCUITDESK_URL ?? 'http://localhost:3411';
const PICO = 'board.raspberry-pi-pico';
const PICO_W = 'board.raspberry-pi-pico-w';

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
function finish(): never {
  console.log(
    failures === 0
      ? `\nRP2040 integration checks passed (${skipped} skipped).`
      : `\n${failures} check(s) FAILED (${skipped} skipped)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------- compiling

interface Artifact {
  data: string;
  format: string;
}

const compiled = new Map<string, Artifact>();

async function compile(source: string, boardId = PICO, fqbn = 'rp2040:rp2040:rpipico'): Promise<Artifact | null> {
  const key = `${boardId}:${source}`;
  const cached = compiled.get(key);
  if (cached) return cached;
  try {
    const res = await fetch(`${BASE}/api/compiler/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boardId, fqbn, files: [{ name: 'sketch.ino', content: source }] }),
    });
    const json = (await res.json()) as { success: boolean; firmware?: Artifact };
    if (!json.success || !json.firmware) return null;
    compiled.set(key, json.firmware);
    return json.firmware;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ project building

let nextId = 0;
const id = (prefix: string) => `${prefix}${++nextId}`;

/** Builds a project the way the canvas would: parts placed, pins wired. */
function projectWith(
  boardId: string,
  parts: { defId: string; props?: Record<string, unknown> }[],
  wires: [string, string, string, string][],
): { project: CircuitProject; boardInstanceId: string; partIds: string[] } {
  const project = emptyProject('rp2040-integration');
  const boardInstanceId = id('b');
  project.boardInstances.push({
    id: boardInstanceId,
    definitionId: boardId,
    x: 100,
    y: 100,
    rotation: 0,
    properties: {},
    simulationState: {},
  } as ComponentInstance);
  const partIds: string[] = [];
  for (const part of parts) {
    const instId = id('c');
    partIds.push(instId);
    project.componentInstances.push({
      id: instId,
      definitionId: part.defId,
      x: 300,
      y: 100,
      rotation: 0,
      properties: part.props ?? {},
      simulationState: {},
    } as ComponentInstance);
  }
  for (const [srcId, srcPin, dstId, dstPin] of wires) {
    project.connections.push({
      id: id('w'),
      sourceComponentId: srcId,
      sourcePinId: srcPin,
      targetComponentId: dstId,
      targetPinId: dstPin,
      netId: '',
      color: '#e8590c',
      points: [],
      routing: 'smooth',
    });
  }
  return { project, boardInstanceId, partIds };
}

/**
 * Runs a bound circuit for a slice of simulated time, updating the binding as
 * the application's tick loop does, and collecting the visuals it produces.
 */
function advance(
  runner: BoardRunner,
  binding: CircuitBinding,
  controls: ReturnType<typeof emptyControls>,
  simMs: number,
  onFrame?: (visuals: Map<string, { ledOn?: boolean; brightness?: number; potPosition?: number }>) => void,
): void {
  const stepMs = 1;
  for (let done = 0; done < simMs; done += stepMs) {
    runner.runFor(stepMs);
    const { visuals } = binding.update(controls);
    onFrame?.(visuals as never);
  }
}

// ================================================================ 1. registry

{
  const pico = getBoardDefinition(PICO)!;
  const picoW = getBoardDefinition(PICO_W)!;

  const adapter = getSimulatorAdapter(pico);
  check(adapter?.engine === 'rp2040js', `the Pico resolves to the RP2040 adapter (${adapter?.engine})`);
  check(getSimulatorAdapter(picoW)?.engine === 'rp2040js', 'the Pico W resolves to the RP2040 adapter');
  check(adapter?.firmwareFormat === 'uf2', 'the RP2040 adapter executes UF2 artifacts');
  check(firmwareFormatForBoard(pico) === 'uf2', 'the compile pipeline asks for UF2 for a Pico');
  check(firmwareFormatForBoard(getBoardDefinition('board.arduino-uno')) === 'intel-hex', 'an Uno still asks for Intel HEX');

  // The Pico must never resolve to the AVR engine, on any code path.
  check(adapter?.engine !== 'avr8js', 'the Pico never resolves to avr8js');
  const avrAdapter = getSimulatorAdapter(getBoardDefinition('board.arduino-uno'));
  // The AVR adapter must not claim the RP2040 — stated against the processor,
  // which is what the registry now keys on, rather than against a board id.
  check(!avrAdapter?.processorProfileIds.includes('proc.rp2040'), 'the AVR adapter does not run an RP2040');
  check(runnableProcessorProfileIds().includes('proc.rp2040'), 'the RP2040 is a processor some adapter runs');
  check(getSimulatorAdapter(pico)?.engine === 'rp2040js', 'and the Pico resolves to the RP2040 engine');
  check(
    getSimulatorAdapter(getBoardDefinition(PICO_W))?.engine === 'rp2040js',
    'as does the Pico W, through the same processor profile',
  );

  // Pin resolution goes through the RP2040 map, never the Arduino one.
  check(runnerPinIndex(pico, 'GP15') === 15, 'GP15 resolves to runner index 15');
  check(runnerPinIndex(pico, 'GP0') === 0, 'GP0 resolves to runner index 0');
  check(runnerPinIndex(pico, 'GND1') === undefined, 'a ground pin has no runner index');
  check(runnerPinIndex(pico, '3V3') === undefined, 'a power pin has no runner index');
  check(runnerPinIndex(pico, 'D13') === undefined, 'a Pico has no D13 to resolve');
  check(runnerAdcChannel(pico, 'GP26') === 0, 'GP26 is ADC channel 0');
  check(runnerAdcChannel(pico, 'GP27') === 1, 'GP27 is ADC channel 1');
  check(runnerAdcChannel(pico, 'GP28') === 2, 'GP28 is ADC channel 2');
  check(runnerAdcChannel(pico, 'GP15') === undefined, 'GP15 has no ADC channel');
  check(runnerPinCount(pico) === 30, 'the Pico exposes 30 runner pin indices');
  check(boardAdcReference(pico) === 3.3, 'the Pico ADC is 3.3 V full scale');
  check(boardAdcReference(getBoardDefinition('board.arduino-uno')!) === 5, 'an AVR board is still 5 V full scale');
}

// ================================================== 2. firmware rejection paths
//
// Every one of these must be refused before an engine is ever created.

{
  const pico = getBoardDefinition(PICO)!;
  const adapter = getSimulatorAdapter(pico)!;

  const rejects = async (firmware: Artifact, what: string) => {
    try {
      await adapter.createRunner(firmware, pico);
      check(false, `${what} is rejected`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      check(true, `${what} is rejected — ${message.slice(0, 90)}`);
    }
  };

  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
  const uf2Block = (over: Partial<{ magic0: number; final: number; addr: number; len: number; family: number }> = {}) => {
    const b = new Uint8Array(512);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, over.magic0 ?? 0x0a324655, true);
    dv.setUint32(4, 0x9e5d5157, true);
    dv.setUint32(8, 0x2000, true);
    dv.setUint32(12, over.addr ?? 0x10000000, true);
    dv.setUint32(16, over.len ?? 256, true);
    dv.setUint32(28, over.family ?? 0xe48bff56, true);
    dv.setUint32(508, over.final ?? 0x0ab16f30, true);
    return b;
  };

  await rejects({ data: ':100000000C9434000C943E00FF', format: 'intel-hex' }, 'AVR Intel HEX');
  await rejects({ data: b64(uf2Block({ magic0: 0 })), format: 'uf2' }, 'a UF2 with a bad magic');
  await rejects({ data: b64(uf2Block({ final: 0 })), format: 'uf2' }, 'a UF2 with a corrupt trailer');
  await rejects({ data: b64(uf2Block({ family: 0x1c5f21b0 })), format: 'uf2' }, "another chip's UF2 family");
  await rejects({ data: b64(uf2Block({ addr: 0x20000000 })), format: 'uf2' }, 'a block outside the flash window');
  await rejects({ data: b64(uf2Block({ len: 500 })), format: 'uf2' }, 'an oversized UF2 payload');
  await rejects({ data: b64(new Uint8Array(300)), format: 'uf2' }, 'a truncated UF2');
  await rejects({ data: '', format: 'uf2' }, 'an empty artifact');

  // Board mismatch is refused by the controller's own guard.
  let mismatchRefused = false;
  try {
    assertFirmwareMatchesBoard('board.arduino-uno', pico);
  } catch {
    mismatchRefused = true;
  }
  check(mismatchRefused, 'firmware compiled for another board is refused');

  // An AVR board handed a UF2 must refuse it just as firmly.
  const uno = getBoardDefinition('board.arduino-uno')!;
  let avrRefusedUf2 = false;
  try {
    await getSimulatorAdapter(uno)!.createRunner({ data: b64(uf2Block()), format: 'uf2' }, uno);
  } catch (err) {
    avrRefusedUf2 = err instanceof FirmwareRejectedError;
  }
  check(avrRefusedUf2, 'an AVR board refuses a UF2 rather than trying to run it');
}

// ================================================ 3. real firmware, real paths

const blink15 = await compile(
  'void setup() { pinMode(15, OUTPUT); }\nvoid loop() { digitalWrite(15, HIGH); delay(100); digitalWrite(15, LOW); delay(100); }',
);
if (!blink15) {
  skip('the Pico toolchain is unavailable — no firmware sections can run');
  finish();
}

const pico = getBoardDefinition(PICO)!;
const adapter = getSimulatorAdapter(pico)!;

check(blink15.format === 'uf2', `the Pico target produces a UF2 artifact (${blink15.format})`);

// ---------- 3a. Pico + resistor + LED, driven by GP15 ----------
{
  const { project, boardInstanceId, partIds } = projectWith(
    PICO,
    [{ defId: 'comp.resistor', props: { resistance: 220 } }, { defId: 'comp.led', props: { color: 'red' } }],
    [],
  );
  // Wired the way a user would draw it:
  //   GP15 -> resistor -> LED anode, LED cathode -> GND.
  const [resistorId, ledId] = partIds;
  project.connections = [
    wire(boardInstanceId, 'GP15', resistorId, 'p1'),
    wire(resistorId, 'p2', ledId, 'anode'),
    wire(ledId, 'cathode', boardInstanceId, 'GND1'),
  ];

  const runner = await adapter.createRunner(blink15, pico);
  const binding = new CircuitBinding(project, runner);
  const controls = emptyControls();

  check(binding.boardDef?.id === PICO, 'the binding attached to the Pico on the canvas');

  const ledSamples: boolean[] = [];
  advance(runner, binding, controls, 450, (visuals) => {
    const led = visuals.get(ledId);
    if (led) ledSamples.push(led.ledOn === true);
  });

  const litFrames = ledSamples.filter(Boolean).length;
  check(litFrames > 0, `the LED lights from real GPIO output (${litFrames} lit frames)`);
  check(litFrames < ledSamples.length, `the LED also goes out (${ledSamples.length - litFrames} dark frames)`);
  // A 100 ms half-period over 450 ms means roughly half the frames are lit.
  const ratio = litFrames / ledSamples.length;
  check(ratio > 0.3 && ratio < 0.7, `the LED is lit about half the time, as delay(100) implies (${(ratio * 100).toFixed(0)}%)`);

  const snapshot = runner.snapshot();
  check(snapshot.toggles[15] > 2, `GP15 really toggled (${snapshot.toggles[15]} transitions)`);
  check(snapshot.toggles[2] === 0, 'GP2 never moved for a sketch that does not mention it');
  check(snapshot.states.length === 30, `the snapshot covers the whole GPIO bank (${snapshot.states.length})`);

  // Pin States: the panel model must show GP names driven by live state.
  const model = buildPinStatesModel(pico);
  check(model.kind === 'pins', 'the Pin States panel has live rows for a Pico');
  if (model.kind === 'pins') {
    const labels = model.rows.map((r) => r.label);
    check(labels.includes('GP0') && labels.includes('GP15') && labels.includes('GP28'), 'the panel lists GP0, GP15 and GP28');
    check(!labels.some((l) => /^D\d+$/.test(l)), `the panel shows no D0-D13 rows (${labels.filter((l) => /^D\d+$/.test(l)).join(',') || 'none'})`);
    check(!labels.some((l) => /^A\d+$/.test(l)), `the panel shows no A0-A5 rows (${labels.filter((l) => /^A\d+$/.test(l)).join(',') || 'none'})`);
    const gpRows = model.rows.filter((r) => /^GP\d+$/.test(r.label));
    check(gpRows.length === 26, `every GP pin the Pico brings out has a row (${gpRows.length})`);
    check(gpRows.every((r) => r.pin !== undefined), 'every GP row is live-capable');
    const gp15 = model.rows.find((r) => r.label === 'GP15')!;
    const cell = pinStateCell(gp15, snapshot);
    check(cell.level === 'high' || cell.level === 'low', `GP15 reports a driven level (${cell.level})`);
    const gp2 = pinStateCell(model.rows.find((r) => r.label === 'GP2')!, snapshot);
    check(gp2.level === 'input', `an untouched pin reports its power-on input state (${gp2.level})`);
  }
  runner.dispose?.();
}

// ---------- 3b. an independently compiled sketch on a different pin ----------
{
  const blink2 = await compile(
    'void setup() { pinMode(2, OUTPUT); }\nvoid loop() { digitalWrite(2, HIGH); delay(50); digitalWrite(2, LOW); delay(50); }',
  );
  if (!blink2) {
    skip('the second blink sketch did not compile');
  } else {
    const { project, boardInstanceId, partIds } = projectWith(
      PICO,
      [{ defId: 'comp.resistor', props: { resistance: 220 } }, { defId: 'comp.led', props: { color: 'green' } }],
      [],
    );
    const [resistorId, ledId] = partIds;
    project.connections = [
      wire(boardInstanceId, 'GP2', resistorId, 'p1'),
      wire(resistorId, 'p2', ledId, 'anode'),
      wire(ledId, 'cathode', boardInstanceId, 'GND1'),
    ];

    const runner = await adapter.createRunner(blink2, pico);
    const binding = new CircuitBinding(project, runner);
    const edges: number[] = [];
    runner.addPinListener((pin) => {
      if (pin === 2) edges.push(runner.timeMs);
    });
    advance(runner, binding, emptyControls(), 400);

    const snapshot = runner.snapshot();
    check(edges.length >= 6, `GP2 toggles on its own sketch (${edges.length} edges)`);
    check(snapshot.toggles[15] === 0, 'GP15 stays idle for a sketch that only drives GP2');
    const steady = edges.slice(-5);
    const gaps = steady.slice(1).map((t, i) => t - steady[i]);
    check(
      gaps.length >= 3 && gaps.every((g) => Math.abs(g - 50) < 5),
      `the interval is the programmed delay(50) (${gaps.map((g) => g.toFixed(1)).join(', ')} ms)`,
    );
    runner.dispose?.();
  }
}

// ---------- 3c. a button on GP16 with the internal pull-up ----------
{
  const source =
    'void setup() { pinMode(16, INPUT_PULLUP); pinMode(15, OUTPUT); }\n' +
    'void loop() { digitalWrite(15, digitalRead(16) == LOW ? HIGH : LOW); }';
  const firmware = await compile(source);
  if (!firmware) {
    skip('the button sketch did not compile');
  } else {
    // GP16 -> button -> GND, and GP15 -> resistor -> LED -> GND.
    const { project, boardInstanceId, partIds } = projectWith(
      PICO,
      [
        { defId: 'comp.push-button' },
        { defId: 'comp.resistor', props: { resistance: 220 } },
        { defId: 'comp.led', props: { color: 'red' } },
      ],
      [],
    );
    const [buttonId, resistorId, ledId] = partIds;
    project.connections = [
      wire(boardInstanceId, 'GP16', buttonId, '1a'),
      wire(buttonId, '2a', boardInstanceId, 'GND1'),
      wire(boardInstanceId, 'GP15', resistorId, 'p1'),
      wire(resistorId, 'p2', ledId, 'anode'),
      wire(ledId, 'cathode', boardInstanceId, 'GND2'),
    ];

    const runner = await adapter.createRunner(firmware, pico);
    const binding = new CircuitBinding(project, runner);
    const controls = emptyControls();

    let lastLed = false;
    const frame = (visuals: Map<string, { ledOn?: boolean }>) => {
      const led = visuals.get(ledId);
      if (led) lastLed = led.ledOn === true;
    };

    // Released: the button is an open switch, so the pad's own pull-up holds
    // GP16 high and the firmware drives GP15 low.
    advance(runner, binding, controls, 60, frame);
    check(runner.digitalPinLevel(16) === 'input-pullup', `pinMode(INPUT_PULLUP) reached the pad (${runner.digitalPinLevel(16)})`);
    check(!lastLed, 'the LED is dark while the button is released');
    check(runner.digitalPinLevel(15) === 'low', 'the firmware drives GP15 low while released');

    // Pressed: the canvas button shorts GP16 to ground.
    controls.pressedButtons.add(buttonId);
    advance(runner, binding, controls, 60, frame);
    check(runner.digitalPinLevel(15) === 'high', 'pressing the button makes the firmware drive GP15 high');
    check(lastLed, 'the LED lights in response to the real firmware reading a real input');

    // Released again, to prove it is the input and not a one-way latch.
    controls.pressedButtons.delete(buttonId);
    advance(runner, binding, controls, 60, frame);
    check(runner.digitalPinLevel(15) === 'low', 'releasing returns GP15 low');
    check(!lastLed, 'the LED goes out again');
    runner.dispose?.();
  }
}

// ---------- 3d. the ADC, fed by a real potentiometer on the canvas ----------
{
  const source =
    'void setup() { Serial1.begin(115200); analogReadResolution(12); }\n' +
    'void loop() { Serial1.println(analogRead(26)); delay(20); }';
  const firmware = await compile(source);
  if (!firmware) {
    skip('the ADC sketch did not compile');
  } else {
    // 3V3 -> pot -> GND, wiper -> GP26 (ADC0).
    const { project, boardInstanceId, partIds } = projectWith(PICO, [{ defId: 'comp.potentiometer' }], []);
    const [potId] = partIds;
    project.connections = [
      wire(boardInstanceId, '3V3', potId, 't1'),
      wire(potId, 't2', boardInstanceId, 'GND1'),
      wire(potId, 'wiper', boardInstanceId, 'GP26'),
    ];

    const runner = await adapter.createRunner(firmware, pico);
    const binding = new CircuitBinding(project, runner);
    const controls = emptyControls();

    const readingsAt = (position: number): number[] => {
      controls.potPositions.set(potId, position);
      let text = '';
      runner.onSerialByte = (b) => {
        text += String.fromCharCode(b);
      };
      advance(runner, binding, controls, 220);
      // Note the empty-string guard: Number('') is 0, so a trailing newline
      // would otherwise look like a genuine zero reading.
      return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^\d+$/.test(line))
        .map(Number);
    };

    // t1 is wired to 3V3 and t2 to ground, so position 0 puts the wiper at
    // the supply and position 1 puts it at ground.
    const atSupply = readingsAt(0).at(-1);
    const atMiddle = readingsAt(0.5).at(-1);
    const atGround = readingsAt(1).at(-1);

    check(
      atSupply !== undefined && atMiddle !== undefined && atGround !== undefined,
      `the firmware reports ADC readings (${atSupply}, ${atMiddle}, ${atGround})`,
    );
    console.log(`      analogRead(26): ${atSupply} at the supply, ${atMiddle} at mid-travel, ${atGround} at ground`);

    check(atGround! < 100, `a wiper at ground reads near zero (${atGround})`);
    check(atSupply! > 3900, `a wiper at 3V3 reads near full scale (${atSupply})`);
    check(atMiddle! > 1800 && atMiddle! < 2300, `a centred wiper reads about half scale (${atMiddle})`);
    check(atSupply! <= 4095, `the reading never exceeds the RP2040's 12-bit range (${atSupply})`);
    check(atGround! < atMiddle! && atMiddle! < atSupply!, 'the reading tracks the wiper monotonically');
    // The conversion is a real voltage-to-code mapping, not a pass-through.
    const expectedMid = Math.round((1.65 / 3.3) * 4095);
    check(Math.abs(atMiddle! - expectedMid) < 120, `1.65 V converts to about ${expectedMid} (got ${atMiddle})`);

    // A second channel, to show the mapping is not hard-wired to ADC0.
    check(runner.adcChannelForPin(27) === 1, 'GP27 maps to ADC channel 1');
    check(runner.adcChannelForPin(28) === 2, 'GP28 maps to ADC channel 2');
    check(runner.adcChannelForPin(15) === undefined, 'GP15 has no ADC channel');
    runner.dispose?.();
  }
}

// ---------- 3e. floating point, and analogWrite ----------
//
// The Arduino-Pico core does every float and double operation through tables
// in the boot ROM. Raspberry Pi's routines behind them cannot be shipped, so
// the simulator's ROM provides the tables itself: each slot traps into an
// independent implementation of its documented contract (romFloat.ts). What
// a sketch computes has to be right, not merely not crash, so each result is
// compared with the value the chip produces.
//
// analogWrite() is the case users hit first: it computes its PWM divisor in
// floating point, and used to stop the sketch.
{
  const source = `volatile float fa = 3.0f, fb = 7.0f;
volatile double da = 2.0, db = 10.0;
void setup() {
  Serial1.begin(115200);
  Serial1.print("F "); Serial1.println(fa / fb, 6);
  Serial1.print("S "); Serial1.println(sqrtf(fb), 6);
  Serial1.print("T "); Serial1.println(sinf(fa) + cosf(fa), 6);
  Serial1.print("L "); Serial1.println(logf(fb), 6);
  Serial1.print("I "); Serial1.println((int)(-fb / fa));
  Serial1.print("D "); Serial1.println(da / db * 3.0, 10);
  Serial1.print("DC "); Serial1.println(cos(db * 200.0), 10);
  analogWrite(15, 64);
  Serial1.println("done");
}
void loop() {}`;
  const firmware = await compile(source);
  if (!firmware) {
    skip('the floating-point sketch did not compile');
  } else {
    const runner = await adapter.createRunner(firmware, pico);
    let text = '';
    runner.onSerialByte = (b) => {
      text += String.fromCharCode(b);
    };
    let message = '';
    try {
      for (let i = 0; i < 24; i++) runner.runFor(25);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    check(message === '', `a sketch doing float and double arithmetic runs (${message || 'no error'})`);
    const value = (tag: string) => new RegExp(`^${tag} (\\S+)`, 'm').exec(text)?.[1];
    check(value('F') === '0.428571', `3.0f / 7.0f is 0.428571 (${value('F')})`);
    check(value('S') === '2.645751', `sqrtf(7) is 2.645751 (${value('S')})`);
    check(value('T') === '-0.848872', `sinf(3) + cosf(3) is -0.848872 (${value('T')})`);
    check(value('L') === '1.945910', `logf(7) is 1.945910 (${value('L')})`);
    check(value('I') === '-2', `(int)(-7.0f / 3.0f) truncates to -2 (${value('I')})`);
    check(value('D') === '0.6000000000', `2.0 / 10.0 * 3.0 in double is 0.6 (${value('D')})`);
    check(value('DC') === '-0.3674595491', `cos(2000) in double, range-reduced by the SDK (${value('DC')})`);
    check(/^done/m.test(text), 'and analogWrite() returns');
    runner.snapshot();
    for (let i = 0; i < 8; i++) runner.runFor(25);
    const duty = runner.snapshot().duty[15];
    check(Math.abs(duty - 0.25) < 0.01, `analogWrite(15, 64) drives GP15 at a quarter duty (${duty.toFixed(3)})`);
    // At the core's default 1 kHz, which needs PWM to count the 200 MHz clk_sys
    // the core sets rather than the 125 MHz the emulator starts with.
    let rises = 0;
    const stop = runner.addPinListener?.((pin, high) => {
      if (pin === 15 && high) rises++;
    });
    for (let i = 0; i < 4; i++) runner.runFor(25);
    stop?.();
    check(rises >= 98 && rises <= 102, `at analogWrite's default 1 kHz (${rises} periods in 100 ms)`);
    runner.dispose?.();
  }

  // A float-free sketch is unaffected.
  const integerOnly = await compile(
    'void setup() { Serial1.begin(115200); }\nvoid loop() { static int n = 0; Serial1.println(n++ * 3); delay(10); }',
  );
  if (integerOnly) {
    const runner = await adapter.createRunner(integerOnly, pico);
    let text = '';
    runner.onSerialByte = (b) => {
      text += String.fromCharCode(b);
    };
    let threw = false;
    try {
      for (let i = 0; i < 20 && text.length < 12; i++) runner.runFor(25);
    } catch {
      threw = true;
    }
    check(!threw, 'integer arithmetic runs');
    const numbers = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .map(Number);
    check(numbers.length >= 3, `the integer sketch keeps producing output (${numbers.length} values)`);
    check(numbers[1] - numbers[0] === 3, `the arithmetic is correct (${numbers.slice(0, 4).join(', ')})`);
    runner.dispose?.();
  }

  // And the capability text claims what has just been shown to work.
  check(
    pico.simulation?.supportedApis.some((api) => /analogWrite/i.test(api)) === true,
    'the Pico claims analogWrite among its supported APIs',
  );
  check(
    !/floating-point arithmetic.*cannot|not available in simulation/i.test(String(pico.metadata.limitation ?? '')),
    'the Pico limitation text no longer says floating point cannot run',
  );
}

// ---------- 3f. UART, at three rates ----------
{
  for (const baud of [9600, 57600, 115200]) {
    const firmware = await compile(
      `void setup() { Serial1.begin(${baud}); }\nvoid loop() { Serial1.println("CD-OK"); delay(10); }`,
    );
    if (!firmware) {
      skip(`the ${baud} baud sketch did not compile`);
      continue;
    }
    const runner = await adapter.createRunner(firmware, pico);
    let text = '';
    runner.onSerialByte = (b) => {
      text += String.fromCharCode(b);
    };
    for (let i = 0; i < 40 && text.length < 21; i++) runner.runFor(25);

    const reported = (runner as unknown as { uartBaudRate: number }).uartBaudRate;
    const errorPercent = (Math.abs(reported - baud) / baud) * 100;
    console.log(`      Serial1.begin(${baud}) -> ${reported} baud (${errorPercent.toFixed(3)}% error)`);
    check(text.startsWith('CD-OK\r\n'), `the ${baud} baud sketch transmits its own text (${JSON.stringify(text.slice(0, 9))})`);
    check(text.split('CD-OK').length - 1 >= 2, `loop() keeps printing at ${baud} baud`);
    // Real UART divisors are integers plus a 6-bit fraction, so a small error
    // is the hardware's, not the simulator's.
    check(errorPercent < 0.5, `the reported rate matches the requested ${baud} baud (${reported})`);
    runner.dispose?.();
  }

  // The peripheral clock is the thing that was wrong, so assert it directly.
  const runner = await adapter.createRunner(blink15, pico);
  runner.runFor(200);
  const clocks = runner as unknown as { peripheralClockHz: number; systemClockHz: number };
  console.log(`      clk_peri ${(clocks.peripheralClockHz / 1e6).toFixed(3)} MHz, clk_sys ${(clocks.systemClockHz / 1e6).toFixed(3)} MHz`);
  check(
    Math.abs(clocks.peripheralClockHz - 48e6) < 1e6,
    `clk_peri follows the firmware's own clock configuration (${(clocks.peripheralClockHz / 1e6).toFixed(1)} MHz, not the 125 MHz default)`,
  );
  check(clocks.systemClockHz > 100e6, `clk_sys is resolved from the PLL registers (${(clocks.systemClockHz / 1e6).toFixed(1)} MHz)`);
  runner.dispose?.();
}

// ---------- 3g. lifecycle: run, pause, resume, reset, stop ----------
{
  const runner = await adapter.createRunner(blink15, pico);
  const { project, boardInstanceId, partIds } = projectWith(
    PICO,
    [{ defId: 'comp.resistor', props: { resistance: 220 } }, { defId: 'comp.led', props: { color: 'red' } }],
    [],
  );
  const [resistorId, ledId] = partIds;
  project.connections = [
    wire(boardInstanceId, 'GP15', resistorId, 'p1'),
    wire(resistorId, 'p2', ledId, 'anode'),
    wire(ledId, 'cathode', boardInstanceId, 'GND1'),
  ];
  const binding = new CircuitBinding(project, runner);
  const controls = emptyControls();

  advance(runner, binding, controls, 250);
  const runningTime = runner.timeMs;
  const runningToggles = runner.snapshot().toggles[15];
  check(runningTime > 200, `the simulation advances while running (${runningTime.toFixed(0)} ms)`);
  check(runningToggles > 0, `GP15 toggled before the pause (${runningToggles})`);

  // Pause is simply not calling runFor: nothing may advance on its own.
  const pausedTime = runner.timeMs;
  binding.update(controls);
  binding.update(controls);
  check(runner.timeMs === pausedTime, 'nothing advances while paused');

  // Resume continues from where it stopped, not from zero.
  advance(runner, binding, controls, 100);
  check(runner.timeMs > pausedTime + 90, `resuming continues from the paused time (${runner.timeMs.toFixed(0)} ms)`);

  // Reset restores the power-on state and re-runs the same image.
  runner.reset!();
  check(runner.timeMs < 5, `reset restarts the clock (${runner.timeMs.toFixed(2)} ms)`);
  check(runner.digitalPinLevel(15) === 'input', `reset returns GP15 to its power-on input state (${runner.digitalPinLevel(15)})`);
  check(runner.snapshot().toggles[15] === 0, 'reset clears the transition counters');

  const afterReset: number[] = [];
  runner.addPinListener((pin) => {
    if (pin === 15) afterReset.push(runner.timeMs);
  });
  advance(runner, binding, controls, 700);
  check(afterReset.length >= 6, `the same firmware blinks again after a reset (${afterReset.length} edges)`);
  const gaps = afterReset.slice(-5).slice(1).map((t, i) => t - afterReset.slice(-5)[i]);
  check(
    gaps.length >= 3 && gaps.every((g) => Math.abs(g - 100) < 5),
    `timing after a reset matches the first run (${gaps.map((g) => g.toFixed(1)).join(', ')} ms)`,
  );

  // Stop releases the machine, and a stopped runner refuses to run again
  // rather than quietly leaking state into the next project.
  runner.dispose!();
  let refusedAfterStop = false;
  try {
    runner.runFor(10);
  } catch {
    refusedAfterStop = true;
  }
  check(refusedAfterStop, 'a stopped simulation refuses to keep running');

  // A fresh runner on the same firmware starts from a clean machine.
  const second = await adapter.createRunner(blink15, pico);
  check(second.timeMs < 5, 'a new simulation starts at time zero');
  check(second.snapshot().toggles[15] === 0, 'no GPIO state leaks from the previous project');
  check(second.digitalPinLevel(15) === 'input', 'the new machine starts with GP15 as an input');
  second.dispose?.();
}

// ---------- 3h. execution stays bounded ----------
{
  // A sketch whose loop never yields must not be able to hold the thread.
  const firmware = await compile('void setup() {}\nvoid loop() { while (true) { __asm__("nop"); } }');
  if (!firmware) {
    skip('the runaway sketch did not compile');
  } else {
    const runner = await adapter.createRunner(firmware, pico);
    const started = Date.now();
    runner.runFor(20);
    const elapsed = Date.now() - started;
    check(elapsed < 10_000, `a tight infinite loop still returns from runFor (${elapsed} ms)`);
    check(runner.timeMs >= 20, `simulated time advanced through the loop (${runner.timeMs.toFixed(1)} ms)`);
    runner.dispose?.();
  }
}

// ---------- 3i. the Pico W runs the same engine ----------
{
  const firmware = await compile(
    'void setup() { pinMode(15, OUTPUT); }\nvoid loop() { digitalWrite(15, HIGH); delay(100); digitalWrite(15, LOW); delay(100); }',
    PICO_W,
    'rp2040:rp2040:rpipicow',
  );
  if (!firmware) {
    skip('the Pico W sketch did not compile');
  } else {
    const picoW = getBoardDefinition(PICO_W)!;
    const runner = await getSimulatorAdapter(picoW)!.createRunner(firmware, picoW);
    runner.runFor(400);
    check(runner.snapshot().toggles[15] > 2, `the Pico W blinks on the same RP2040 engine (${runner.snapshot().toggles[15]} transitions)`);
    check(runner.engine === 'rp2040js', 'the Pico W runs on rp2040js');
    const picoWLimitation = String(picoW.metadata.limitation ?? '');
    check(/Wi-Fi/i.test(picoWLimitation), 'the Pico W limitation text mentions Wi-Fi');
    // Wi-Fi is simulated now (the CYW43439 model, tests/wifi.esp32.mts); the text says how far.
    check(/station/i.test(picoWLimitation) && /no internet/i.test(picoWLimitation), 'the Pico W says Wi-Fi works as a station, with no internet');
    check(/Bluetooth/.test(picoWLimitation), 'and that Bluetooth is not simulated');
    check(
      picoW.simulation?.supported === true && picoW.simulation.engine === 'rp2040js',
      'the Pico W badge reflects genuine RP2040 simulation',
    );
    check(
      picoW.simulation?.supportedApis.some((a) => /^WiFi \(station/.test(a)) === true,
      'the Pico W claims WiFi as a station, which tests/wifi.esp32.mts connects',
    );
    runner.dispose?.();
  }
}

// ---------- 3j. AVR boards are untouched ----------
{
  const unoHex = await compile(
    'void setup() { pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); delay(100); digitalWrite(13, LOW); delay(100); }',
    'board.arduino-uno',
    'arduino:avr:uno',
  );
  if (!unoHex) {
    skip('the Uno sketch did not compile');
  } else {
    const uno = getBoardDefinition('board.arduino-uno')!;
    const unoAdapter = getSimulatorAdapter(uno)!;
    check(unoHex.format === 'intel-hex', `an Uno still produces Intel HEX (${unoHex.format})`);
    const runner = await unoAdapter.createRunner(unoHex, uno);
    check(runner.engine === 'avr8js', 'the Uno still runs on avr8js');
    runner.runFor(400);
    check(runner.snapshot().toggles[13] > 2, `the Uno still blinks on D13 (${runner.snapshot().toggles[13]} transitions)`);
    const model = buildPinStatesModel(uno);
    if (model.kind === 'pins') {
      check(model.rows.some((r) => r.label === 'D13'), 'the Uno panel still shows D13');
      check(!model.rows.some((r) => /^GP\d+$/.test(r.label)), 'the Uno panel shows no GP rows');
    }
    runner.dispose?.();
  }
}

finish();

// ------------------------------------------------------------------ helpers

function wire(a: string, aPin: string, b: string, bPin: string) {
  return {
    id: id('w'),
    sourceComponentId: a,
    sourcePinId: aPin,
    targetComponentId: b,
    targetPinId: bPin,
    netId: '',
    color: '#e8590c',
    points: [],
    routing: 'smooth' as const,
  };
}
