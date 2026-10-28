// Servo, tone() and attachInterrupt() on the SAMD21 boards.
//
// All three need more from the chip than analogWrite() did. Servo runs a TC in
// normal PWM with its MC0 interrupt, reads COUNT in the handler and sets CC0 a
// pulse width ahead; tone() runs TC5 in match-frequency mode and toggles the
// pin from its MC0 interrupt; attachInterrupt() muxes the pad to the EIC and
// waits for its EXTINT line. The timers used to be PWM generators with no
// counter and no interrupts, and the EIC a block of plain registers, so the
// servo pin never pulsed, tone() never toggled and no interrupt handler ran.
//
// Measured at the pads, on compiled firmware, on each SAMD21 board:
//   * Servo.write(0 / 90 / 180) gives 544 / 1472 / 2400 µs pulses every 20 ms,
//     and a write() while running moves the pulse;
//   * tone(440) and tone(1000) toggle at those frequencies, a tone with a
//     duration stops by itself, and noTone() stops one;
//   * RISING, FALLING and CHANGE interrupts count exactly the edges they
//     should, each on its own pin's EXTINT line;
//   * millis() keeps time while a servo's interrupt fires every few ms.

import { compileProject } from '../server/compiler/compilerService';
import { detectArduinoCli } from '../server/compiler/arduinoCli';
import { getSimulatorAdapter } from '../src/simulation/adapters';
import { getBoardDefinition } from '../src/boards/definitions';
import { runnerPinIndex } from '../src/simulation/boardRunner';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const cli = await detectArduinoCli();
if (!cli.available) {
  console.log('SKIP: arduino-cli is not available here');
  process.exit(0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Runner = any;

const BOARDS = [
  // id, fqbn, an output pin, two input pins
  ['board.adafruit-feather', 'adafruit:samd:adafruit_feather_m0', 'D10', 'D12', 'D11'],
  ['board.adafruit-qtpy', 'adafruit:samd:adafruit_qtpy_m0', 'A2', 'A3', 'A1'],
  ['board.seeed-xiao', 'Seeeduino:samd:seeed_XIAO_m0', 'A1', 'A2', 'A3'],
] as const;

const WAIT = 'Serial.begin(115200); unsigned long s0 = millis(); while (!Serial && millis() - s0 < 2000) delay(10);';
const num = (label: string) => label.replace(/^D/, '');

async function boot(boardId: string, fqbn: string, sketch: string) {
  const built = await compileProject({ fqbn, boardId, files: [{ name: 'sketch.ino', content: sketch }] }, false);
  if (!built.firmware) {
    console.log(`SKIP: ${boardId} did not build here`);
    skipped++;
    return null;
  }
  const def = getBoardDefinition(boardId)!;
  const r: Runner = await getSimulatorAdapter(def)!.createRunner(built.firmware, def);
  let text = '';
  /** Each line, with the simulation time it finished arriving. */
  const lines: { at: number; line: string }[] = [];
  let line = '';
  const take = (b: number) => {
    const ch = String.fromCharCode(b);
    text += ch;
    if (ch === '\n') {
      lines.push({ at: r.timeMs, line: line.trim() });
      line = '';
    } else line += ch;
  };
  r.onSerialByte = take;
  r.onUsbSerialByte = take;
  return { r, def, out: () => text, lines };
}

const run = (r: Runner, ms: number) => {
  for (let t = 0; t < ms; t += 5) r.runFor(5);
};

/** Rising and falling edge times on a pad, in ms. */
function edges(r: Runner, pad: number) {
  const rises: number[] = [];
  const falls: number[] = [];
  r.addPinListener((p: number, high: boolean) => {
    if (p === pad) (high ? rises : falls).push(r.timeMs);
  });
  return { rises, falls };
}

/** Width of each complete high pulse after `from`, in µs. */
function pulses(e: { rises: number[]; falls: number[] }, from: number): number[] {
  const out: number[] = [];
  for (const rise of e.rises) {
    if (rise < from) continue;
    const fall = e.falls.find((f) => f > rise);
    if (fall !== undefined) out.push((fall - rise) * 1000);
  }
  return out;
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);

for (const [boardId, fqbn, outLabel, inA, inB] of BOARDS) {
  console.log(`\n=== ${boardId}`);

  // ------------------------------------------------------------------ Servo
  {
    const sketch = `#include <Servo.h>
Servo s;
void setup() { ${WAIT} s.attach(${num(outLabel)}); s.write(0); }
void loop() {
  if (Serial.available()) {
    int a = Serial.parseInt();
    // parseInt() leaves the newline; left there, the next parseInt() waits a second for digits.
    while (Serial.available()) Serial.read();
    s.write(a); Serial.print("angle "); Serial.println(a);
  }
  Serial.print("ms "); Serial.println(millis());
  delay(100);
}`;
    const b = await boot(boardId, fqbn, sketch);
    if (b) {
      const pad = runnerPinIndex(b.def, outLabel)!;
      const e = edges(b.r, pad);
      run(b.r, 700);
      const at0 = median(pulses(e, b.r.timeMs - 200));
      check(Math.abs(at0 - 544) < 12, `Servo.write(0) pulses ${at0.toFixed(0)} µs (544 expected)`);
      const recent = e.rises.filter((t) => t > b.r.timeMs - 200);
      const period = (recent.at(-1)! - recent[0]) / (recent.length - 1);
      check(Math.abs(period - 20) < 0.5, `every ${period.toFixed(2)} ms (the library's 20 ms refresh)`);
      for (const [angle, us] of [[90, 1472], [180, 2400]] as const) {
        b.r.queueSerialInput?.(`${angle}\n`) ?? b.r.queueUsbSerialInput?.(`${angle}\n`);
        run(b.r, 400);
        const w = median(pulses(e, b.r.timeMs - 150));
        check(Math.abs(w - us) < 12, `write(${angle}) while running moves it to ${w.toFixed(0)} µs (${us})`);
      }
      // millis() against the simulation clock when each line was printed, with
      // the servo interrupt firing throughout.
      const stamped = b.lines.filter((l) => l.line.startsWith('ms ')).map((l) => [Number(l.line.slice(3)), l.at] as const);
      const worst = Math.max(...stamped.map(([ms, at]) => Math.abs(ms - at)));
      check(stamped.length > 5 && worst < 3, `millis() keeps time beside the servo (worst ${worst.toFixed(2)} ms off over ${stamped.length} readings)`);
      b.r.dispose?.();
    }
  }

  // ------------------------------------------------------------------- tone
  {
    const sketch = `void setup() { ${WAIT} }
void loop() {
  if (!Serial.available()) return;
  int c = Serial.read();
  if (c == 'a') tone(${num(outLabel)}, 440);
  if (c == 'b') tone(${num(outLabel)}, 1000);
  if (c == 'c') tone(${num(outLabel)}, 2000, 60);
  if (c == 'x') noTone(${num(outLabel)});
}`;
    const b = await boot(boardId, fqbn, sketch);
    if (b) {
      const pad = runnerPinIndex(b.def, outLabel)!;
      const e = edges(b.r, pad);
      const send = (s: string) => b.r.queueSerialInput?.(s) ?? b.r.queueUsbSerialInput?.(s);
      run(b.r, 600);
      check(e.rises.length === 0, 'the pin is quiet before tone()');
      for (const [key, hz] of [['a', 440], ['b', 1000]] as const) {
        send(key);
        run(b.r, 200);
        const recent = e.rises.filter((t) => t > b.r.timeMs - 100);
        const f = 1000 / ((recent.at(-1)! - recent[0]) / (recent.length - 1));
        check(Math.abs(f - hz) / hz < 0.01, `tone(${hz}) toggles at ${f.toFixed(1)} Hz`);
      }
      send('x');
      run(b.r, 50);
      const stoppedAt = e.rises.length;
      run(b.r, 100);
      check(e.rises.length === stoppedAt, 'noTone() stops it');
      send('c');
      run(b.r, 300);
      const burst = e.rises.length - stoppedAt;
      check(Math.abs(burst - 120) <= 2, `tone(2000, 60) gives 60 ms of 2 kHz and stops by itself (${burst} cycles)`);
      b.r.dispose?.();
    }
  }

  // -------------------------------------------------------- attachInterrupt
  {
    const sketch = `volatile int rises = 0, falls = 0, changes = 0;
void onRise() { rises++; }
void onChange() { changes++; }
void setup() {
  ${WAIT}
  pinMode(${num(inA)}, INPUT_PULLUP);
  pinMode(${num(inB)}, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(${num(inA)}), onRise, RISING);
  attachInterrupt(digitalPinToInterrupt(${num(inB)}), onChange, CHANGE);
}
void loop() { Serial.print("n "); Serial.print(rises); Serial.print(' '); Serial.println(changes); delay(20); }`;
    const b = await boot(boardId, fqbn, sketch);
    if (b) {
      const a = runnerPinIndex(b.def, inA)!;
      const c = runnerPinIndex(b.def, inB)!;
      b.r.setDigitalInput(a, true);
      b.r.setDigitalInput(c, true);
      run(b.r, 700);
      for (let k = 0; k < 4; k++) {
        b.r.setDigitalInput(a, false);
        run(b.r, 2);
        b.r.setDigitalInput(a, true);
        run(b.r, 2);
      }
      for (let k = 0; k < 3; k++) {
        b.r.setDigitalInput(c, false);
        run(b.r, 2);
        b.r.setDigitalInput(c, true);
        run(b.r, 2);
      }
      run(b.r, 100);
      const n = [...b.out().matchAll(/n (\d+) (\d+)/g)].at(-1);
      check(n?.[1] === '4', `RISING on ${inA} counts its 4 rising edges and not the falls (${n?.[1]})`);
      check(n?.[2] === '6', `CHANGE on ${inB} counts both edges of 3 presses (${n?.[2]})`);
      b.r.dispose?.();
    }
  }
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
