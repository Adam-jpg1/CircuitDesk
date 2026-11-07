// The character LCD that is not on a bus.
//
// `LiquidCrystal lcd(rs, en, d4, d5, d6, d7)` is the first display most people
// wire, and it is the one a simulator is most tempted to fake, because there is
// no protocol to point at — just six wires and an API. The temptation is to
// notice `lcd.print("Hello")` and put "Hello" on the glass.
//
// So nothing here calls that API. Every case drives RS, E and the data lines by
// hand, exactly as the library does on the wire, and the assertions are about
// what the panel then shows. Two things follow that could not follow from an
// API shim, and both are tested: a sketch that never pulses E gets a blank
// panel however much it prints, and the four-bit initialisation dance is real —
// skip it and the controller is still in its power-on eight-bit state and your
// characters go nowhere.
//
// Section 6 then does the whole thing again through executed AVR firmware and
// the real circuit binding, so the edge subscriptions that carry a
// microsecond-long E pulse are proved too.

import { Hd44780ParallelDevice } from '../src/simulation/devices/lcdParallel';
import { Hd44780Controller } from '../src/simulation/devices/hd44780';
import { Lcd1602Device, LCD1602_ADDRESSES } from '../src/simulation/devices/lcd1602';
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
 * Drives a directly-wired panel the way LiquidCrystal drives one: set RS and
 * the data lines, raise E, drop E. The drop is what the controller reacts to.
 */
function wiring(device: Hd44780ParallelDevice) {
  const setNibble = (value: number) => {
    device.onPinLevel('d4', (value & 0x10) !== 0);
    device.onPinLevel('d5', (value & 0x20) !== 0);
    device.onPinLevel('d6', (value & 0x40) !== 0);
    device.onPinLevel('d7', (value & 0x80) !== 0);
  };
  const pulse = (rs: boolean, highNibbleBits: number) => {
    device.onPinLevel('rs', rs);
    setNibble(highNibbleBits);
    device.onPinLevel('e', true);
    device.onPinLevel('e', false);
  };
  const send = (value: number, rs: boolean) => {
    pulse(rs, value & 0xf0);
    pulse(rs, (value << 4) & 0xf0);
  };
  return {
    pulse,
    command: (c: number) => send(c, false),
    print: (text: string) => {
      for (const ch of text) send(ch.charCodeAt(0), true);
    },
    /** Exactly what LiquidCrystal::begin() puts on the wire. */
    init: () => {
      pulse(false, 0x30);
      pulse(false, 0x30);
      pulse(false, 0x30);
      pulse(false, 0x20); // select the four-bit interface
      send(0x28, false); // function set: 4-bit, two lines
      send(0x08, false); // display off
      send(0x01, false); // clear
      send(0x06, false); // entry mode: increment
      send(0x0c, false); // display on
    },
  };
}

// ================================== 1. nothing happens without an E pulse ====
section('1. no enable pulse, no display');
{
  const lcd = new Hd44780ParallelDevice('lcd');
  // Set RS and every data line, repeatedly, and never touch E. On a breadboard
  // this is a panel that does nothing, because the controller is not listening.
  for (const value of [0x30, 0x28, 0x0c, 0x48, 0x49]) {
    lcd.onPinLevel('rs', true);
    lcd.onPinLevel('d4', (value & 0x10) !== 0);
    lcd.onPinLevel('d5', (value & 0x20) !== 0);
    lcd.onPinLevel('d6', (value & 0x40) !== 0);
    lcd.onPinLevel('d7', (value & 0x80) !== 0);
  }
  check(lcd.enablePulses === 0, 'no E pulse was seen');
  check(!lcd.isInitialised, 'the controller never initialised');
  check(lcd.lines.every((l) => l.trim() === ''), 'and the panel is blank');
}

// ====================== 2. skipping the init dance leaves it in 8-bit mode ===
section('2. the four-bit dance is not optional');
{
  const lcd = new Hd44780ParallelDevice('lcd');
  const w = wiring(lcd);
  // Straight to business, as though the controller were already in 4-bit mode.
  w.command(0x0c); // display on
  w.print('HELLO');
  check(!lcd.lcd.isFourBitMode, 'without the 0x20 function set it is still in its power-on eight-bit state');
  check(lcd.lines[0].trim() === '', `so nothing reached the glass ("${lcd.lines[0].trim()}")`);
  check(lcd.enablePulses > 0, `even though E was genuinely pulsed ${lcd.enablePulses} times`);
}

// ============================================== 3. the real sequence works ===
section('3. wired and initialised properly, the characters appear');
{
  const lcd = new Hd44780ParallelDevice('lcd');
  const w = wiring(lcd);
  w.init();
  check(lcd.lcd.isFourBitMode, 'the init dance put it into four-bit mode');
  check(lcd.isDisplayOn, 'and turned the display on');

  w.print('HELLO');
  check(lcd.row(0).startsWith('HELLO'), `row 0 reads "${lcd.row(0).trim()}"`);
  check(lcd.row(1).trim() === '', 'and row 1 is untouched');

  // Line 2 starts at DDRAM 0x40, which is the detail every driver has to know.
  w.command(0x80 | 0x40);
  w.print('WORLD');
  check(lcd.row(1).startsWith('WORLD'), `row 1 reads "${lcd.row(1).trim()}" after addressing 0x40`);
  check(lcd.row(0).startsWith('HELLO'), 'without disturbing row 0');

  w.command(0x01); // clear
  check(lcd.lines.every((l) => l.trim() === ''), 'clear empties both rows');
}

// =============================== 4. it is the same controller as the backpack =
section('4. the parallel panel and the I2C backpack agree, because they are one chip');
{
  // The same instruction stream, delivered two completely different ways. If
  // these ever disagreed, one of the two front-ends would be lying.
  const parallel = new Hd44780ParallelDevice('p');
  const w = wiring(parallel);
  w.init();
  w.print('SAME');

  const backpack = new Lcd1602Device('i', LCD1602_ADDRESSES[0]);
  const BACKLIGHT = 0x08;
  const EN = 0x04;
  const port = (value: number) => {
    backpack.start(LCD1602_ADDRESSES[0], true);
    backpack.writeByte(value | BACKLIGHT);
    backpack.stop();
  };
  const bpPulse = (data: number) => {
    port(data | EN);
    port(data & ~EN);
  };
  const bpSend = (value: number, mode: number) => {
    bpPulse((value & 0xf0) | mode);
    bpPulse(((value << 4) & 0xf0) | mode);
  };
  bpPulse(0x30);
  bpPulse(0x30);
  bpPulse(0x30);
  bpPulse(0x20);
  bpSend(0x28, 0);
  bpSend(0x08, 0);
  bpSend(0x01, 0);
  bpSend(0x06, 0);
  bpSend(0x0c, 0);
  for (const ch of 'SAME') bpSend(ch.charCodeAt(0), 1);

  check(
    parallel.row(0) === backpack.row(0),
    `both panels read "${parallel.row(0).trim()}" — one controller, two front-ends`,
  );
}

// ====================================================== 5. eight-bit wiring ==
section('5. all eight data lines, one byte per pulse');
{
  const lcd = new Hd44780ParallelDevice('lcd8');
  lcd.setBusWidth(true);
  check(lcd.isEightBit, 'the part reports an eight-wire build');

  const byte = (value: number, rs: boolean) => {
    lcd.onPinLevel('rs', rs);
    for (let i = 0; i < 8; i++) lcd.onPinLevel(`d${i}`, ((value >> i) & 1) === 1);
    lcd.onPinLevel('e', true);
    lcd.onPinLevel('e', false);
  };
  byte(0x38, false); // function set, 8-bit, two lines
  byte(0x0c, false); // display on
  byte(0x01, false); // clear
  byte(0x06, false); // entry mode
  for (const ch of 'EIGHT') byte(ch.charCodeAt(0), true);

  check(lcd.row(0).startsWith('EIGHT'), `an eight-bit panel prints in one pulse per byte ("${lcd.row(0).trim()}")`);
  check(lcd.enablePulses === 9, `nine bytes, nine pulses (${lcd.enablePulses}) — not eighteen`);
}

// ================================ 6. through real firmware and real wiring ===
section('6. an executed sketch, driving the pins itself');
{
  // No LiquidCrystal library: the sketch bit-bangs the same sequence. That
  // keeps this test about the wiring and the edge subscriptions rather than
  // about a library, and it works on the pinned toolchain today.
  const SOURCE = [
    'const int RS = 8, EN = 9, D4 = 4, D5 = 5, D6 = 6, D7 = 7;',
    'void nibble(uint8_t v) {',
    '  digitalWrite(D4, (v >> 4) & 1); digitalWrite(D5, (v >> 5) & 1);',
    '  digitalWrite(D6, (v >> 6) & 1); digitalWrite(D7, (v >> 7) & 1);',
    '  digitalWrite(EN, HIGH); delayMicroseconds(2); digitalWrite(EN, LOW); delayMicroseconds(60);',
    '}',
    'void send(uint8_t v, uint8_t rs) {',
    '  digitalWrite(RS, rs); nibble(v & 0xF0); nibble((v << 4) & 0xF0);',
    '}',
    'void setup() {',
    '  pinMode(RS, OUTPUT); pinMode(EN, OUTPUT);',
    '  pinMode(D4, OUTPUT); pinMode(D5, OUTPUT); pinMode(D6, OUTPUT); pinMode(D7, OUTPUT);',
    '  delay(50);',
    '  digitalWrite(RS, LOW);',
    '  nibble(0x30); delay(5); nibble(0x30); delay(5); nibble(0x30); delay(5);',
    '  nibble(0x20); delay(5);',
    '  send(0x28, 0); send(0x08, 0); send(0x01, 0); delay(2); send(0x06, 0); send(0x0C, 0);',
    '  const char *msg = "WIRED";',
    '  for (const char *p = msg; *p; p++) send(*p, 1);',
    '}',
    'void loop() {}',
  ].join('\n');

  const p = emptyProject('parallel-lcd');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.arduino-uno', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  const lcd: ComponentInstance = {
    id: uid('l'), definitionId: 'comp.lcd1602-parallel', x: 300, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  p.boardInstances.push(board);
  p.componentInstances.push(lcd);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  const wire = (a: string, ap: string, b: string, bp: string) =>
    p.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#000', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  wire(board.id, '5V', lcd.id, 'vdd');
  wire(board.id, 'GND_TOP', lcd.id, 'vss');
  wire(board.id, 'D8', lcd.id, 'rs');
  wire(board.id, 'D9', lcd.id, 'e');
  wire(board.id, 'D4', lcd.id, 'd4');
  wire(board.id, 'D5', lcd.id, 'd5');
  wire(board.id, 'D6', lcd.id, 'd6');
  wire(board.id, 'D7', lcd.id, 'd7');

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the wired-panel test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(400);
    simulationController.publishNow();
    const visuals = useSimulationStore.getState().visuals as Record<string, { readout?: string[] }>;
    const rows = visuals[lcd.id]?.readout ?? [];
    console.log(`   panel: ${JSON.stringify(rows)}`);
    check(rows.length === 2, `the canvas is handed two rows (${rows.length})`);
    check((rows[0] ?? '').startsWith('WIRED'), `executed firmware put "WIRED" on the glass ("${(rows[0] ?? '').trim()}")`);
    check((rows[1] ?? '').trim() === '', 'and nothing on row 1 that firmware did not write');
  }
  simulationController.stop();
}

// ============================================ 7. an unwired panel does nothing
section('7. a panel whose enable line goes nowhere');
{
  const SOURCE = [
    'void setup() { pinMode(9, OUTPUT); }',
    'void loop() { digitalWrite(9, HIGH); delay(1); digitalWrite(9, LOW); delay(1); }',
  ].join('\n');

  const p = emptyProject('unwired-lcd');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.arduino-uno', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  const lcd: ComponentInstance = {
    id: uid('l'), definitionId: 'comp.lcd1602-parallel', x: 300, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  p.boardInstances.push(board);
  p.componentInstances.push(lcd);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  // Power only. The signal pins reach nothing.
  p.connections.push({
    id: uid('w'), sourceComponentId: board.id, sourcePinId: '5V', targetComponentId: lcd.id, targetPinId: 'vdd',
    netId: '', color: '#000', points: [], routing: 'smooth',
  } as CircuitProject['connections'][number]);

  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the unwired variant would not start');
  } else {
    simulationController.pause();
    simulationController.advance(200);
    simulationController.publishNow();
    const visuals = useSimulationStore.getState().visuals as Record<string, { readout?: string[] }>;
    const rows = visuals[lcd.id]?.readout ?? [];
    check(
      rows.length === 0 || rows.every((r) => r.trim() === '' || /not initialised/.test(r)),
      `a panel with no enable line shows nothing (${JSON.stringify(rows)})`,
    );
  }
  simulationController.stop();
}

// ===================================================== 8. the parts as shipped
section('8. the parts in the library');
{
  for (const id of ['comp.lcd1602-parallel', 'comp.lcd2004-parallel']) {
    const def = defOf(id);
    check(def !== undefined, `${id} is in the library`);
    if (!def) continue;
    check(def.supportLevel === 'simulated', `${id} is badged Simulated`);
    check(def.simulationAdapterId === 'sim.lcd-parallel', `${id} uses the parallel adapter`);
    // The real 16-pin header, so a wiring diagram from a datasheet transfers.
    for (const pinId of ['vss', 'vdd', 'v0', 'rs', 'rw', 'e', 'd0', 'd7', 'a', 'k']) {
      check(def.pins.some((pp) => pp.id === pinId), `${id} exposes ${pinId}`);
    }
    check(def.pins.length === 16, `${id} has all sixteen pins (${def.pins.length})`);
    check(
      /busy-flag read path is not modelled/.test(def.description ?? ''),
      `${id} says what it does not model`,
    );

    const cov = COMPONENT_COVERAGE.find((c) => c.id === id);
    check(cov?.status === 'simulated', `${id} is recorded as simulated`);
    check((cov?.tests ?? []).includes('tests/displays.parallel.mts'), `${id} names this file as its proof`);
  }

  // The shared controller is the point of the refactor: one chip, two wirings.
  const c = new Hd44780Controller({ columns: 20, rows: 4 });
  check(c.rows === 4 && c.columns === 20, 'the controller takes its geometry from the panel in front of it');
  check(c.lines.length === 4, 'and reports one string per row');
}

console.log(
  failures === 0
    ? `\nParallel LCD checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
