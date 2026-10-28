// EEPROM and external interrupts, on the boards that were missing them.
//
// A feature matrix over every Simulated board found:
//   * EEPROM hung every AVR board: avr8js's EEPROM peripheral was never
//     attached, so EEPROM.write() left EEPE set and the next access spun on it
//     for ever. On the RP2040 boards EEPROM.commit() stopped the sketch: the
//     boot ROM had no flash_range_erase or flash_range_program.
//   * attachInterrupt() never fired on the Mega or the Leonardo: avr8js ships
//     only the 328P's INT0/INT1 on PD2/PD3, and every AVR shared that wiring.
// EEPROM is non-volatile, so here a sketch counts its own boots in it and has
// to see the count go up across the reset button. Each interrupt pin is
// driven with real edges and the ISR's count read back over Serial, and a
// pin-change interrupt is checked on each pin-change group the Mega has.

import { compileProject } from '../server/compiler/compilerService';
import { getSimulatorAdapter } from '../src/simulation/adapters';
import { getBoardDefinition } from '../src/boards/definitions';
import { runnerPinIndex } from '../src/simulation/boardRunner';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const WAIT = 'Serial.begin(115200); unsigned long s0 = millis(); while (!Serial && millis() - s0 < 2000) delay(10);';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Runner = any;

async function boot(boardId: string, fqbn: string, sketch: string): Promise<{ r: Runner; out: () => string } | null> {
  const built = await compileProject({ fqbn, boardId, files: [{ name: 'sketch.ino', content: sketch }] }, false);
  if (!built.firmware) {
    console.log(`SKIP: ${boardId} did not build here (${built.errors?.[0]?.message ?? built.success})`);
    skipped++;
    return null;
  }
  const def = getBoardDefinition(boardId)!;
  const r: Runner = await getSimulatorAdapter(def)!.createRunner(built.firmware, def);
  let text = '';
  r.onSerialByte = (b: number) => (text += String.fromCharCode(b));
  r.onUsbSerialByte = (b: number) => (text += String.fromCharCode(b));
  return { r, out: () => text };
}

const run = (r: Runner, ms: number) => {
  for (let t = 0; t < ms; t += 10) r.runFor(10);
};
const last = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => m[1]).at(-1);

// ---------------------------------------------------------------- EEPROM
const EEPROM_BOARDS = [
  ['board.arduino-uno', 'arduino:avr:uno', true],
  ['board.arduino-mega2560', 'arduino:avr:mega', true],
  ['board.arduino-leonardo', 'arduino:avr:leonardo', true],
  ['board.raspberry-pi-pico', 'rp2040:rp2040:rpipico', false],
] as const;

for (const [boardId, fqbn, avr] of EEPROM_BOARDS) {
  console.log(`\n--- EEPROM on ${boardId}`);
  // Byte 0 counts boots; 0xFF is erased, which reads as the first boot.
  const sketch = `#include <EEPROM.h>
void setup() {
  ${WAIT}
  ${avr ? '' : 'EEPROM.begin(256);'}
  uint8_t n = EEPROM.read(0);
  if (n == 0xFF) n = 0;
  n++;
  EEPROM.write(0, n);
  EEPROM.write(200, 0xA5);
  ${avr ? '' : 'EEPROM.commit();'}
  Serial.print("boot "); Serial.println(n);
  Serial.print("far "); Serial.println(EEPROM.read(200));
}
void loop() {}
`;
  const b = await boot(boardId, fqbn, sketch);
  if (!b) continue;
  run(b.r, 1200);
  check(last(b.out(), /boot (\d+)/g) === '1', `the first boot finds the EEPROM erased and writes 1 (${last(b.out(), /boot (\d+)/g)})`);
  check(last(b.out(), /far (\d+)/g) === '165', 'a byte further in reads back what was written');
  b.r.reset();
  run(b.r, 1200);
  check(last(b.out(), /boot (\d+)/g) === '2', `after the reset button it reads 1 back and counts 2 (${last(b.out(), /boot (\d+)/g)})`);
  b.r.reset();
  run(b.r, 1200);
  check(last(b.out(), /boot (\d+)/g) === '3', 'and 3 after another');
  b.r.dispose?.();
}

// ------------------------------------------------------- external interrupts
// Every pin attachInterrupt() accepts on each board, with its digitalPinToInterrupt().
const INTERRUPT_BOARDS = [
  ['board.arduino-mega2560', 'arduino:avr:mega', ['D2', 'D3', 'D18', 'D19', 'D20', 'D21']],
  ['board.arduino-leonardo', 'arduino:avr:leonardo', ['D0', 'D1', 'D2', 'D3', 'D7']],
  ['board.arduino-uno', 'arduino:avr:uno', ['D2', 'D3']],
] as const;

for (const [boardId, fqbn, pins] of INTERRUPT_BOARDS) {
  console.log(`\n--- attachInterrupt on ${boardId}`);
  const def = getBoardDefinition(boardId)!;
  const numbers = pins.map((p) => Number(p.slice(1)));
  // One counter per pin, so an edge counted on the wrong vector shows.
  const sketch = `volatile int c[${pins.length}];
${numbers.map((_, i) => `void isr${i}() { c[${i}]++; }`).join('\n')}
void setup() {
  ${WAIT}
  ${numbers.map((n, i) => `pinMode(${n}, INPUT_PULLUP); attachInterrupt(digitalPinToInterrupt(${n}), isr${i}, FALLING);`).join('\n  ')}
}
void loop() {
  Serial.print("c");
  for (int i = 0; i < ${pins.length}; i++) { Serial.print(' '); Serial.print(c[i]); }
  Serial.println();
  delay(20);
}
`;
  const b = await boot(boardId, fqbn, sketch);
  if (!b) continue;
  for (const pin of pins) b.r.setDigitalInput(runnerPinIndex(def, pin)!, true);
  run(b.r, 800);
  // Pin k gets k + 1 falling edges.
  pins.forEach((pin, k) => {
    const pad = runnerPinIndex(def, pin)!;
    for (let e = 0; e <= k; e++) {
      b.r.setDigitalInput(pad, false);
      run(b.r, 2);
      b.r.setDigitalInput(pad, true);
      run(b.r, 2);
    }
  });
  run(b.r, 100);
  const counts = last(b.out(), /c((?: \d+)+)\r?\n/g)?.trim().split(' ').map(Number) ?? [];
  pins.forEach((pin, k) =>
    check(counts[k] === k + 1, `${pin}: ${k + 1} falling edge(s) counted on its own interrupt (${counts[k]})`),
  );
  b.r.dispose?.();
}

// ------------------------------------------------- Mega pin-change interrupts
// PCINT0 is port B (D53, D10-13), PCINT1 is PE0 (D0) and PJ0-1 (D15, D14),
// PCINT2 is port K (A8-A15) — SoftwareSerial's receive pins. Each group
// has its own vector, which on the Mega is not where the 328P's are.
{
  console.log('\n--- pin-change interrupts on board.arduino-mega2560');
  const def = getBoardDefinition('board.arduino-mega2560')!;
  const sketch = `volatile int g0 = 0, g1 = 0, g2 = 0;
ISR(PCINT0_vect) { g0++; }
ISR(PCINT1_vect) { g1++; }
ISR(PCINT2_vect) { g2++; }
void setup() {
  ${WAIT}
  pinMode(10, INPUT_PULLUP); pinMode(15, INPUT_PULLUP); pinMode(A8, INPUT_PULLUP);
  PCMSK0 = _BV(PCINT4);   // D10 = PB4
  PCMSK1 = _BV(PCINT9);   // D15 = PJ0
  PCMSK2 = _BV(PCINT16);  // A8 = PK0
  PCIFR = 7;
  PCICR = 7;
}
void loop() { Serial.print("g "); Serial.print(g0); Serial.print(' '); Serial.print(g1); Serial.print(' '); Serial.println(g2); delay(20); }
`;
  const b = await boot('board.arduino-mega2560', 'arduino:avr:mega', sketch);
  if (b) {
    const pads = ['D10', 'D15', 'A8'].map((p) => runnerPinIndex(def, p)!);
    for (const pad of pads) b.r.setDigitalInput(pad, true);
    run(b.r, 800);
    // A change interrupt fires on both edges: group k sees 2 * (k + 1) changes.
    pads.forEach((pad, k) => {
      for (let e = 0; e <= k; e++) {
        b.r.setDigitalInput(pad, false);
        run(b.r, 2);
        b.r.setDigitalInput(pad, true);
        run(b.r, 2);
      }
    });
    run(b.r, 100);
    const g = last(b.out(), /g (\d+ \d+ \d+)/g)?.split(' ').map(Number) ?? [];
    check(g[0] === 2, `port B changes reach PCINT0_vect (${g[0]})`);
    check(g[1] === 4, `port J changes reach PCINT1_vect (${g[1]})`);
    check(g[2] === 6, `port K changes reach PCINT2_vect (${g[2]})`);
    b.r.dispose?.();
  }
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
