// The Nokia 5110 (PCD8544), and the H bit that catches everybody.
//
// This part has one behaviour that decides whether a driver works at all: the
// function-set byte carries an H flag, and half the command set only exists
// while H is 1. Send the contrast command with H still 0 and the controller
// reads the same byte as something else entirely — which is why a 5110 driver
// that gets the order wrong comes up blank or completely black rather than
// slightly wrong. A model that accepted every command in every mode would make
// that bug invisible, so it is modelled and it is the first thing tested here.

import { Pcd8544Device, PCD8544_WIDTH, PCD8544_HEIGHT } from '../src/simulation/devices/pcd8544';
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

function driver(device: Pcd8544Device) {
  let dc = false;
  device.attachControls((pin) => (pin === 'dc' ? dc : undefined));
  device.select(true);
  return {
    cmd(...bytes: number[]) {
      dc = false;
      for (const b of bytes) device.transfer(b);
    },
    data(...bytes: number[]) {
      dc = true;
      for (const b of bytes) device.transfer(b);
    },
  };
}

// ==================================== 1. the H bit gates half the command set
section('1. the extended instruction set only exists while H is 1');
{
  const dev = new Pcd8544Device('n', 'cs');
  const d = driver(dev);

  // The mistake: setting contrast without selecting the extended set first.
  // 0xBF is a contrast command in the extended set and a column address in the
  // basic one, so the controller does something — just not what was meant.
  d.cmd(0x21 & ~0x01); // function set, H = 0
  d.cmd(0xbf);
  check(!dev.isExtendedSet, 'the part is in the basic instruction set');
  check(dev.contrast === 0, 'so the contrast command did not set contrast');
  check(dev.unhandledCommands.length === 0, 'it was read as a column address instead, which is a real command');

  // Done properly.
  const ok = new Pcd8544Device('n2', 'cs');
  const e = driver(ok);
  e.cmd(0x21); // function set, H = 1
  check(ok.isExtendedSet, 'the H bit selects the extended set');
  e.cmd(0xbf);
  check(ok.contrast === 0x3f, `and now the same byte sets contrast (${ok.contrast})`);
  e.cmd(0x14); // bias 4
  check(ok.biasSystem === 4, 'bias is accepted in the extended set');
  e.cmd(0x04); // temperature coefficient 0
  check(ok.temperatureCoefficient === 0, 'and so is the temperature coefficient');

  // Back to basic, and the extended commands stop existing again.
  e.cmd(0x20);
  check(!ok.isExtendedSet, 'clearing H returns to the basic set');
}

// =================================================== 2. a full initialisation
section('2. the sequence a driver actually sends');
{
  const dev = new Pcd8544Device('n', 'cs');
  const d = driver(dev);
  check(!dev.isOn, 'the panel starts blank');

  d.cmd(0x21, 0xb1, 0x04, 0x14); // extended: contrast, temp coefficient, bias
  d.cmd(0x20, 0x0c); // basic, display normal
  check(dev.isOn, 'after the standard init the panel is on');
  check(dev.displayMode === 'normal', `and in normal mode (${dev.displayMode})`);
  check(dev.litPixels === 0, 'showing nothing, because nothing has been written');

  // Eight columns of a bank.
  d.cmd(0x40, 0x80); // bank 0, column 0
  d.data(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
  check(dev.litPixels === 64, `eight full columns light sixty-four pixels (${dev.litPixels})`);
  check(dev.pixel(0, 0) && dev.pixel(7, 7), 'the first eight columns of bank 0 are lit');
  check(!dev.pixel(8, 0), 'and the ninth is not');

  // Bank addressing: bank 2 is rows 16-23.
  d.cmd(0x42, 0x80);
  d.data(0x01);
  check(dev.pixel(0, 16), 'bank 2 starts at row 16');
  check(!dev.pixel(0, 15) && !dev.pixel(0, 17), 'and only the bit that was set is lit');
}

// ========================================== 3. display modes are display-wide
section('3. blank, all-on and inverse do not touch RAM');
{
  const dev = new Pcd8544Device('n', 'cs');
  const d = driver(dev);
  d.cmd(0x20, 0x0c, 0x40, 0x80);
  d.data(0x01);
  check(dev.litPixels === 1, 'one pixel written');

  d.cmd(0x0d); // inverse
  check(
    dev.litPixels === PCD8544_WIDTH * PCD8544_HEIGHT - 1,
    `inverse lights everything but that pixel (${dev.litPixels})`,
  );
  d.cmd(0x09); // all on
  check(dev.litPixels === PCD8544_WIDTH * PCD8544_HEIGHT, 'all-on lights the panel');
  d.cmd(0x08); // blank
  check(dev.litPixels === 0 && !dev.isOn, 'blank shows nothing');
  d.cmd(0x0c);
  check(dev.litPixels === 1, 'and normal mode gives the single pixel back — RAM was never touched');

  // Power-down blanks it regardless of the display control.
  d.cmd(0x24); // function set with PD set
  check(!dev.isOn && dev.frame() === null, 'power-down blanks the panel and hands the canvas nothing');
}

// ============================================== 4. addressing mode is honoured
section('4. horizontal and vertical addressing walk differently');
{
  const h = new Pcd8544Device('h', 'cs');
  const dh = driver(h);
  dh.cmd(0x20, 0x0c, 0x40, 0x80);
  dh.data(...new Array(84).fill(0x01), 0x02);
  check(h.pixel(83, 0), 'horizontal addressing fills the first bank across');
  check(h.pixel(0, 9), 'and wraps to the next bank, not back to the start');

  const v = new Pcd8544Device('v', 'cs');
  const dv = driver(v);
  dv.cmd(0x22); // function set with V set
  dv.cmd(0x20 | 0x02); // stay vertical, basic set
  dv.cmd(0x0c, 0x40, 0x80);
  dv.data(0x01, 0x01);
  check(v.pixel(0, 0) && v.pixel(0, 8), 'vertical addressing walks down the banks of one column');
  check(!v.pixel(1, 0), 'without moving across');
}

// ================================= 5. through real firmware and real wiring ==
section('5. an executed sketch driving a wired 5110');
{
  const SOURCE = [
    '#include <SPI.h>',
    'const int CS = 10, DC = 9, RST = 8;',
    'void cmd(uint8_t c) { digitalWrite(DC, LOW); SPI.transfer(c); }',
    'void dat(uint8_t v) { digitalWrite(DC, HIGH); SPI.transfer(v); }',
    'void setup() {',
    '  pinMode(CS, OUTPUT); pinMode(DC, OUTPUT); pinMode(RST, OUTPUT);',
    '  digitalWrite(RST, HIGH); digitalWrite(CS, HIGH);',
    '  SPI.begin();',
    '  SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));',
    '  digitalWrite(CS, LOW);',
    '  cmd(0x21); cmd(0xB1); cmd(0x04); cmd(0x14);',
    '  cmd(0x20); cmd(0x0C);',
    '  cmd(0x40); cmd(0x80);',
    '  for (uint8_t i = 0; i < 20; i++) dat(0xFF);',
    '  digitalWrite(CS, HIGH);',
    '  SPI.endTransaction();',
    '}',
    'void loop() {}',
  ].join('\n');

  const p = emptyProject('nokia');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.arduino-uno', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  const lcd: ComponentInstance = {
    id: uid('n'), definitionId: 'comp.nokia5110', x: 300, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  p.boardInstances.push(board);
  p.componentInstances.push(lcd);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  const wire = (a: string, ap: string, b: string, bp: string) =>
    p.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#000', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  wire(board.id, '3V3', lcd.id, 'vcc');
  wire(board.id, 'GND_TOP', lcd.id, 'gnd');
  wire(board.id, 'D13', lcd.id, 'sck');
  wire(board.id, 'D11', lcd.id, 'mosi');
  wire(board.id, 'D10', lcd.id, 'cs');
  wire(board.id, 'D9', lcd.id, 'dc');
  wire(board.id, 'D8', lcd.id, 'rst');

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the wired 5110 test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(200);
    simulationController.publishNow();
    const visuals = useSimulationStore.getState().visuals as Record<
      string,
      { display?: { pixels: Uint8Array | null; on: boolean }; value?: number }
    >;
    const vis = visuals[lcd.id];
    console.log(`   lit: ${vis?.value}`);
    check(vis?.display?.on === true, 'the panel is on after the sketch initialised it');
    check(vis?.value === 160, `twenty full columns light 160 pixels (${vis?.value})`);
    check(vis?.display?.pixels?.length === (84 * 48) / 8, `the frame is ${(84 * 48) / 8} bytes`);
  }
  simulationController.stop();
}

// ==================================================== 6. the part as shipped =
section('6. the part in the library');
{
  const def = defOf('comp.nokia5110');
  check(def !== undefined, 'the 5110 is in the library');
  if (def) {
    check(def.supportLevel === 'simulated', 'badged Simulated');
    check(def.simulationAdapterId === 'sim.pcd8544', 'wired to the PCD8544 adapter');
    for (const pinId of ['sck', 'mosi', 'cs', 'dc', 'rst', 'vcc', 'gnd']) {
      check(def.pins.some((pp) => pp.id === pinId), `it exposes ${pinId}`);
    }
    check(/H bit/.test(def.description ?? ''), 'and the description names the trap it reproduces');
  }
  const cov = COMPONENT_COVERAGE.find((c) => c.id === 'comp.nokia5110');
  check(cov?.status === 'simulated', 'recorded as simulated');
  check((cov?.tests ?? []).includes('tests/displays.spi.mts'), 'and names this file as its proof');
}

console.log(
  failures === 0
    ? `\nPCD8544 checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
