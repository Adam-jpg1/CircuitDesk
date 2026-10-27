// An LED dimmed with analogWrite() looks dimmed on the canvas, on every board
// whose analogWrite() runs here.
//
// The world settles the nets at every slice, and each settle took a pin
// snapshot, so the duty a frame saw covered a sliver of time: a 25 % pin read
// as fully lit or dark depending on where the frame landed, and the classic
// Fade sketch showed a dark LED. The binding now averages each pin's duty over
// time for the loads it drives, and only for pins switching like PWM, so a
// blink still blinks.
//
// Each board runs real compiled firmware; a board whose toolchain is missing
// here is skipped, not passed.

import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject, inst, wire, code } from '../src/project/templates';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const cases = [
  { board: 'board.arduino-uno', pin: 'D9', n: '9', gnd: 'GND_TOP' },
  // Not the Pico: Arduino-Pico's analogWrite() computes its divisor through the
  // boot ROM's floating-point routines, which CircuitDesk cannot ship, and the
  // simulation stops with that explanation (tests/rp2040.integration.mts).
  { board: 'board.arduino-leonardo', pin: 'D9', n: '9', gnd: 'GND1' },
  { board: 'board.adafruit-feather', pin: 'D10', n: '10', gnd: 'GND1' },
] as const;

for (const c of cases) {
  console.log(`\n--- ${c.board}`);
  // Three levels, each held for 600 ms, then a 100 ms blink.
  const sketch = `const int P = ${c.n};
void setup() {}
void loop() {
  unsigned long t = millis();
  if (t < 1000) analogWrite(P, 64);
  else if (t < 2000) analogWrite(P, 128);
  else if (t < 3000) analogWrite(P, 230);
  else { pinMode(P, OUTPUT); digitalWrite(P, (t / 100) % 2); }
}
`;
  const p = emptyProject(`pwm ${c.board}`);
  const b = inst(c.board, 0, 0);
  const r = inst('comp.resistor', 400, 40, { resistance: 220 });
  const led = inst('comp.led', 460, 40, { color: 'red' });
  p.boardInstances = [b];
  p.componentInstances = [r, led];
  p.connections = [wire(b, c.pin, r, 'p1'), wire(r, 'p2', led, 'anode'), wire(led, 'cathode', b, c.gnd)];
  p.codeFiles = [code('sketch.ino', sketch)];
  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    console.log(`SKIP: ${c.board} did not build or start here`);
    skipped++;
    continue;
  }
  simulationController.pause();
  const frames = (fromMs: number, toMs: number) => {
    simulationController.advance(fromMs - useSimulationStore.getState().simTimeMs);
    const seen: { on: boolean; brightness: number }[] = [];
    while (useSimulationStore.getState().simTimeMs < toMs) {
      if (!simulationController.advance(33)) {
        check(false, `the simulation keeps running (${useSimulationStore.getState().error})`);
        break;
      }
      simulationController.publishNow();
      const v = useSimulationStore.getState().visuals[led.id];
      seen.push({ on: v?.ledOn === true, brightness: v?.brightness ?? 0 });
    }
    return seen;
  };
  simulationController.publishNow();
  for (const [from, to, want] of [[400, 950, 64 / 255], [1400, 1950, 128 / 255], [2400, 2950, 230 / 255]] as const) {
    const seen = frames(from, to);
    const lit = seen.filter((f) => f.on).length;
    const worst = Math.max(...seen.map((f) => Math.abs(f.brightness - want)));
    check(lit === seen.length, `${c.pin} at duty ${want.toFixed(2)}: lit in every frame (${lit}/${seen.length})`);
    check(worst < 0.06, `   at that brightness in every frame (worst off by ${worst.toFixed(3)})`);
  }
  const blink = frames(3200, 4400);
  const on = blink.filter((f) => f.on).length;
  check(on > blink.length * 0.3 && on < blink.length * 0.7, `a 100 ms blink still blinks (${on}/${blink.length} frames lit)`);
  check(blink.filter((f) => f.on).every((f) => f.brightness > 0.9), '   at full brightness when on, not averaged');
  simulationController.stop();
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
