// The TM1637: two wires that look like I2C and are not.
//
// Everything about this part invites a wrong shortcut. It has a clock and a
// data line, it makes start and stop conditions exactly the way I2C does, and
// putting it on the I2C bus with a made-up address would make a demo work. It
// would also make an ordinary TM1637 sketch fail, and make an I2C scan report a
// device that is not there.
//
// The differences that matter are tested here: there is no address, and bits go
// out least significant first. The second is the one that bites — decode a
// TM1637 as if it were I2C and every digit shows the right number of segments
// in the wrong places, which looks like a font bug rather than a bus bug.

import { Tm1637Device } from '../src/simulation/devices/tm1637';
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

/**
 * Bit-bangs the two wires exactly as the library does.
 *
 * Written out rather than abstracted because the ordering IS the protocol: the
 * data line moves while the clock is low, the chip samples on the rising edge,
 * and a data transition while the clock is high is a start or a stop.
 */
function wires(dev: Tm1637Device) {
  const clk = (high: boolean) => dev.onPinLevel('clk', high);
  const dio = (high: boolean) => dev.onPinLevel('dio', high);
  // Idle: both high.
  clk(true);
  dio(true);
  return {
    start() {
      dio(true);
      clk(true);
      dio(false); // DIO falls while CLK is high
      clk(false);
    },
    stop() {
      clk(false);
      dio(false);
      clk(true);
      dio(true); // DIO rises while CLK is high
    },
    /** One byte, least significant bit first, plus the ACK clock. */
    byte(value: number) {
      for (let i = 0; i < 8; i++) {
        clk(false);
        dio(((value >> i) & 1) === 1);
        clk(true);
      }
      // Ninth clock: the chip acknowledges.
      clk(false);
      dio(true);
      clk(true);
      clk(false);
    },
  };
}

/** Segment masks for 0-9, bit 0 = A. The font is the sketch's, not the model's. */
const FONT = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];

// ============================================= 1. a full write, as a library does
section('1. the sequence a TM1637 library sends');
{
  const dev = new Tm1637Device('t');
  const w = wires(dev);

  check(!dev.isOn, 'the display starts off');

  // Data command: auto-increment.
  w.start();
  w.byte(0x40);
  w.stop();
  check(dev.isAutoIncrement, 'the data command selects auto-increment addressing');

  // Address command, then four digits.
  w.start();
  w.byte(0xc0);
  for (const d of [1, 2, 3, 4]) w.byte(FONT[d]);
  w.stop();

  // Display on, brightness 7.
  w.start();
  w.byte(0x88 | 0x07);
  w.stop();

  check(dev.isOn, 'the display control command turns it on');
  check(dev.brightnessLevel === 7, `at brightness 7 (${dev.brightnessLevel})`);
  console.log(`   digits: ${[0, 1, 2, 3].map((i) => dev.segments(i)).join(' | ')}`);
  check(dev.segments(0) === 'bc', `digit 0 shows the segments for "1" (${dev.segments(0)})`);
  check(dev.segments(1) === 'abdeg', `digit 1 shows the segments for "2" (${dev.segments(1)})`);
  check(dev.segments(2) === 'abcdg', `digit 2 shows the segments for "3" (${dev.segments(2)})`);
  check(dev.segments(3) === 'bcfg', `digit 3 shows the segments for "4" (${dev.segments(3)})`);
}

// ================================== 2. bit order is the thing that would break
section('2. bits are least significant first, unlike I2C');
{
  const dev = new Tm1637Device('t');
  const w = wires(dev);
  w.start();
  w.byte(0x40);
  w.stop();
  w.start();
  w.byte(0xc0);
  // 0x06 is segments B and C — the digit "1". Sent MSB first it would arrive
  // as 0x60, which is segments F and G: the right count, the wrong places.
  w.byte(0x06);
  w.stop();
  w.start();
  w.byte(0x8f);
  w.stop();

  check(dev.segments(0) === 'bc', `the byte 0x06 decodes to segments B and C (${dev.segments(0)})`);
  check(dev.segments(0) !== 'fg', 'and not to F and G, which is what MSB-first decoding would give');
}

// =============================================== 3. addressing modes are real
section('3. auto-increment and fixed address');
{
  const dev = new Tm1637Device('t');
  const w = wires(dev);
  // Fixed address: 0x44. Every data byte goes to the same digit.
  w.start();
  w.byte(0x44);
  w.stop();
  check(!dev.isAutoIncrement, 'the fixed-address data command is recognised');

  w.start();
  w.byte(0xc2); // address digit 2
  w.byte(FONT[7]);
  w.stop();
  w.start();
  w.byte(0x8f);
  w.stop();
  check(dev.segments(2) === 'abc', `digit 2 was addressed directly (${dev.segments(2)})`);
  check(dev.segments(0) === '' && dev.segments(1) === '', 'and the others were left alone');

  // Back to auto-increment: one address, four digits.
  const inc = new Tm1637Device('i');
  const v = wires(inc);
  v.start();
  v.byte(0x40);
  v.stop();
  v.start();
  v.byte(0xc0);
  v.byte(FONT[8]);
  v.byte(FONT[8]);
  v.stop();
  v.start();
  v.byte(0x8f);
  v.stop();
  check(inc.segments(0) === 'abcdefg' && inc.segments(1) === 'abcdefg', 'auto-increment walked to the next digit');
  check(inc.segments(2) === '', 'and stopped where the data did');
}

// ================================== 4. the stop condition bounds the data run
section('4. a stop ends the run, so the next byte is a command again');
{
  const dev = new Tm1637Device('t');
  const w = wires(dev);
  w.start();
  w.byte(0x40);
  w.stop();
  w.start();
  w.byte(0xc0);
  w.byte(FONT[5]);
  w.stop();
  // Brightness after the stop. Without the boundary this byte would land in
  // digit 1 and the display would never come on.
  w.start();
  w.byte(0x8a);
  w.stop();
  check(dev.isOn && dev.brightnessLevel === 2, `the byte after the stop was read as a command (brightness ${dev.brightnessLevel})`);
  check(dev.segments(1) === '', 'and did not land in digit 1');
}

// =================================================== 5. off means off, not lost
section('5. turning the display off hides the digits without losing them');
{
  const dev = new Tm1637Device('t');
  const w = wires(dev);
  w.start();
  w.byte(0x40);
  w.stop();
  w.start();
  w.byte(0xc0);
  w.byte(FONT[9]);
  w.stop();
  w.start();
  w.byte(0x8f);
  w.stop();
  check(dev.segments(0) === 'abcdfg', 'a digit is shown');

  w.start();
  w.byte(0x80); // display off
  w.stop();
  check(!dev.isOn && dev.segments(0) === '', 'display off blanks it');
  check(dev.digits[0] === FONT[9], 'but the segment memory still holds what was written');

  w.start();
  w.byte(0x8f);
  w.stop();
  check(dev.segments(0) === 'abcdfg', 'and turning it back on shows the same digit');
}

// ============================ 6. through real firmware and the real binding ===
section('6. an executed sketch driving a wired module');
{
  // No library — the sketch bit-bangs the two pins, which is what a TM1637
  // library does and what proves the binding delivers the edges.
  const SOURCE = [
    'const int CLK = 2, DIO = 3;',
    'void bstart() { digitalWrite(DIO, HIGH); digitalWrite(CLK, HIGH); digitalWrite(DIO, LOW); digitalWrite(CLK, LOW); }',
    'void bstop() { digitalWrite(CLK, LOW); digitalWrite(DIO, LOW); digitalWrite(CLK, HIGH); digitalWrite(DIO, HIGH); }',
    'void bbyte(uint8_t v) {',
    '  for (uint8_t i = 0; i < 8; i++) {',
    '    digitalWrite(CLK, LOW);',
    '    digitalWrite(DIO, (v >> i) & 1);',
    '    digitalWrite(CLK, HIGH);',
    '  }',
    '  digitalWrite(CLK, LOW); digitalWrite(DIO, HIGH); digitalWrite(CLK, HIGH); digitalWrite(CLK, LOW);',
    '}',
    'void setup() {',
    '  pinMode(CLK, OUTPUT); pinMode(DIO, OUTPUT);',
    '  digitalWrite(CLK, HIGH); digitalWrite(DIO, HIGH);',
    '  bstart(); bbyte(0x40); bstop();',
    '  bstart(); bbyte(0xC0);',
    '  bbyte(0x3F); bbyte(0x06); bbyte(0x5B); bbyte(0x4F);', // 0 1 2 3
    '  bstop();',
    '  bstart(); bbyte(0x8F); bstop();',
    '}',
    'void loop() {}',
  ].join('\n');

  const p = emptyProject('tm1637');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.arduino-uno', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  const disp: ComponentInstance = {
    id: uid('t'), definitionId: 'comp.tm1637', x: 300, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  p.boardInstances.push(board);
  p.componentInstances.push(disp);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  const wire = (a: string, ap: string, b: string, bp: string) =>
    p.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#000', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  wire(board.id, '5V', disp.id, 'vcc');
  wire(board.id, 'GND_TOP', disp.id, 'gnd');
  wire(board.id, 'D2', disp.id, 'clk');
  wire(board.id, 'D3', disp.id, 'dio');

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the wired TM1637 test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(100);
    simulationController.publishNow();
    const visuals = useSimulationStore.getState().visuals as Record<
      string,
      { elementBrightness?: Record<string, number>; value?: number }
    >;
    const b = visuals[disp.id]?.elementBrightness ?? {};
    const lit = (d: number) => ['a', 'b', 'c', 'd', 'e', 'f', 'g'].filter((s) => (b[`${d}.${s}`] ?? 0) > 0.5).join('');
    console.log(`   digits: ${[0, 1, 2, 3].map(lit).join(' | ')}`);
    check(lit(0) === 'abcdef', `digit 0 shows "0" (${lit(0)})`);
    check(lit(1) === 'bc', `digit 1 shows "1" (${lit(1)})`);
    check(lit(2) === 'abdeg', `digit 2 shows "2" (${lit(2)})`);
    check(lit(3) === 'abcdg', `digit 3 shows "3" (${lit(3)})`);
    check(visuals[disp.id]?.value === 7, `and the brightness the sketch asked for (${visuals[disp.id]?.value})`);
  }
  simulationController.stop();
}

// ====================================================== 7. the part as shipped
section('7. the part in the library');
{
  const def = defOf('comp.tm1637');
  check(def !== undefined, 'the TM1637 is in the library');
  if (def) {
    check(def.supportLevel === 'simulated', 'badged Simulated');
    check(def.simulationAdapterId === 'sim.tm1637', 'on its own adapter, not an I2C one');
    for (const pinId of ['clk', 'dio', 'vcc', 'gnd']) {
      check(def.pins.some((pp) => pp.id === pinId), `it exposes ${pinId}`);
    }
    // The mistake this part exists to avoid.
    check(
      !def.pins.some((pp) => pp.id === 'sda' || pp.id === 'scl'),
      'and has no SDA/SCL, because it is not an I2C device',
    );
    check(!def.validationRules.includes('i2c-pins'), 'so it is not checked against the I2C pair either');
    check(/not/i.test(def.description ?? '') && /I2C/.test(def.description ?? ''), 'the description says outright that it is not I2C');
  }
  const cov = COMPONENT_COVERAGE.find((c) => c.id === 'comp.tm1637');
  check(cov?.status === 'simulated', 'recorded as simulated');
  check((cov?.tests ?? []).includes('tests/displays.tm1637.mts'), 'and names this file as its proof');
}

console.log(
  failures === 0
    ? `\nTM1637 checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
