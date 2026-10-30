// Every board badged Simulated does the two things everybody tries first.
//
// A user who picks a board and finds that a blinking LED does not blink, or
// that Serial.println prints nothing, concludes the board is broken — and is
// right. So every board whose badge says Simulated is put through exactly
// that, end to end and the way the app does it: an LED and a resistor wired to
// a real pin on the canvas, a sketch that blinks it and prints on Serial, the
// real compiler, the live simulation, and then the canvas and the monitor.
//
// Board-specific knowledge is limited to what a user would also need: which
// pin to use (the first digital output the board brings out that is not a
// UART or USB line), and the number the sketch uses for it (the pad's own
// number, which is what digitalWrite() addresses on every core here).
//
// Skips cleanly when the compiler service is unavailable.

import { BOARD_DEFINITIONS } from '../src/boards/definitions';
import { runnerPinIndex } from '../src/simulation/boardRunner';
import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject, inst, wire, code } from '../src/project/templates';
import type { BoardDefinition, PinDefinition } from '../src/types';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const simulated = BOARD_DEFINITIONS.filter((b) => b.supportLevel === 'simulated' && b.simulation?.supported);
check(simulated.length >= 10, `boards badged Simulated (${simulated.length})`);

/** A pin a user would put an LED on: a plain GPIO, not a bus, UART or USB line. */
function ledPin(board: BoardDefinition): PinDefinition | undefined {
  const avoid = /uart|usb|i2c|spi|analog-only/;
  const candidates = board.pins.filter(
    (p) =>
      p.capabilities.includes('digital-out') &&
      !p.capabilities.some((c) => avoid.test(c)) &&
      runnerPinIndex(board, p.id) !== undefined &&
      // GPIO0/IO9 on the ESP parts are strapping pins; a user would not pick them.
      !/^(IO0|IO9|GPIO0|IO2|IO8)$/.test(p.id),
  );
  return candidates.find((p) => /13$/.test(p.id)) ?? candidates[Math.floor(candidates.length / 2)];
}

/**
 * What a user writes in pinMode() for the pin labelled `pin`. On AVR, RP2040
 * and ESP boards the Arduino number is the runner's pad index. A SAMD21's pads
 * (PA17 = 17) are not, nor are the Due's: their variants number the pins by their labels, D13 as 13
 * and A2 as the constant A2.
 */
function sketchPin(board: BoardDefinition, pin: PinDefinition, pad: number): string {
  // STM32duino names every pad as a constant (PC7), which is what these pins' ids are.
  if (board.architecture === 'stm32') return pin.id;
  // The micro:bit numbers its pins by the edge connector: P13 is 13.
  if (board.architecture === 'nrf52' && /^P\d+$/.test(pin.id)) return pin.id.slice(1);
  if (board.architecture === 'samd' || board.architecture === 'sam' || board.architecture === 'renesas' || board.architecture === 'nrf52' || board.architecture === 'imxrt') {
    if (/^A\d+$/.test(pin.id)) return pin.id;
    const d = /^D(\d+)$/.exec(pin.id);
    if (d) return d[1];
  }
  return String(pad);
}

for (const board of simulated) {
  console.log(`\n--- ${board.name} (${board.id})`);
  const pin = ledPin(board);
  const ground = board.pins.find((p) => p.type === 'ground');
  if (!pin || !ground) {
    check(false, `${board.id} has a GPIO and a ground to wire an LED to`);
    continue;
  }
  const pad = runnerPinIndex(board, pin.id)!;
  const arduinoPin = sketchPin(board, pin, pad);
  const sketch = `void setup() {
  pinMode(${arduinoPin}, OUTPUT);
  Serial.begin(115200);
  // Boards whose Serial is USB need a moment for the host; this returns at
  // once on a UART and gives up after two seconds rather than hanging.
  unsigned long start = millis();
  while (!Serial && millis() - start < 2000) delay(10);
}
unsigned long n = 0;
void loop() {
  digitalWrite(${arduinoPin}, HIGH);
  delay(100);
  digitalWrite(${arduinoPin}, LOW);
  delay(100);
  Serial.print("tick ");
  Serial.println(n++);
}
`;
  const p = emptyProject(`conformance ${board.id}`);
  const b = inst(board.id, 0, 0);
  const r = inst('comp.resistor', 400, 40, { resistance: 220 });
  const led = inst('comp.led', 460, 40, { color: 'red' });
  p.boardInstances = [b];
  p.componentInstances = [r, led];
  p.connections = [wire(b, pin.id, r, 'p1'), wire(r, 'p2', led, 'anode'), wire(led, 'cathode', b, ground.id)];
  p.codeFiles = [code('sketch.ino', sketch)];

  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable) {
    console.log(`SKIP: no toolchain for ${board.id} here`);
    skipped++;
    continue;
  }
  const build = report.builds[0];
  check(build?.status === 'built', `${board.id} compiles (${build?.detail ?? 'no build'})`);
  if (build?.status !== 'built') continue;
  const started = await simulationController.start();
  check(started, 'and starts');
  if (!started) continue;
  simulationController.pause();
  const seen = new Set<boolean>();
  for (let t = 0; t < 1500; t += 50) {
    simulationController.advance(50);
    simulationController.publishNow();
    seen.add(useSimulationStore.getState().visuals[led.id]?.ledOn === true);
  }
  check(seen.has(true) && seen.has(false), `the LED on ${pin.id} (pad ${pad}) blinks on the canvas`);
  const text = useSimulationStore.getState().serialText;
  check(/tick \d+/.test(text), `Serial reaches the monitor (${JSON.stringify(text.slice(-24))})`);
  simulationController.stop();
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
