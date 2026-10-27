// Colour TFTs: pixels in the framebuffer, or the test does not pass.
//
// The temptation with a graphics display is to assert that bytes arrived. That
// proves nothing a loopback could not — the question is whether the right
// pixels ended up in the right places, which is what a user sees and what a
// window-addressing bug destroys. So every assertion here reads the
// framebuffer.
//
// The other half is negative. Four of these controllers share one device class,
// and the risk of sharing is that they start accepting each other's commands —
// at which point a simulator will happily drive a GC9A01 with an ST7789
// sequence that produces a blank screen on a bench. The command tables are
// per-controller for exactly that reason, and section 5 proves it in both
// directions.

import { TftDisplayDevice } from '../src/simulation/devices/tftController';
import { ILI9341_SPEC, ST7735_SPEC, ST7789_SPEC, GC9A01_SPEC } from '../src/simulation/devices/tftSpecs';
import { Ssd1331Device } from '../src/simulation/devices/ssd1331';
import { rgb565, unpack565 } from '../src/simulation/devices/framebuffer';
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
 * Drives a controller the way a library does: D/C low for the command byte,
 * D/C high for its parameters and its pixels.
 */
function driver(device: TftDisplayDevice) {
  let dc = false;
  let rst = true;
  device.attachControls((pin) => (pin === 'dc' ? dc : pin === 'rst' ? rst : undefined));
  device.select(true);
  return {
    cmd(opcode: number, ...args: number[]) {
      dc = false;
      device.transfer(opcode);
      dc = true;
      for (const a of args) device.transfer(a);
    },
    /** Pixel data after a RAMWR, high byte first. */
    pixels(...words: number[]) {
      dc = true;
      for (const w of words) {
        device.transfer((w >> 8) & 0xff);
        device.transfer(w & 0xff);
      }
    },
    resetPulse() {
      rst = true;
      device.settle();
      rst = false;
      device.settle();
      rst = true;
      device.settle();
    },
    deselect() {
      device.select(false);
    },
  };
}

/** The initialisation every library sends before it draws anything. */
function bringUp(d: ReturnType<typeof driver>) {
  d.cmd(0x01); // software reset
  d.cmd(0x11); // sleep out
  d.cmd(0x3a, 0x55); // 16-bit colour
  d.cmd(0x36, 0x00); // MADCTL: no rotation
  d.cmd(0x29); // display on
}

const RED = rgb565(255, 0, 0);
const GREEN = rgb565(0, 255, 0);
const BLUE = rgb565(0, 0, 255);
const WHITE = rgb565(255, 255, 255);

// ============================================ 1. an addressed window is filled
section('1. a window is set and filled, and the pixels land inside it');
{
  const dev = new TftDisplayDevice('t', 'cs', ILI9341_SPEC);
  const d = driver(dev);
  bringUp(d);

  check(dev.isVisible, 'the panel is on after sleep-out and display-on');
  check(dev.fb.width === 240 && dev.fb.height === 320, `the ILI9341 is 240x320 (${dev.fb.width}x${dev.fb.height})`);

  // A 4x3 rectangle at (10, 20).
  d.cmd(0x2a, 0x00, 10, 0x00, 13); // CASET 10..13
  d.cmd(0x2b, 0x00, 20, 0x00, 22); // RASET 20..22
  d.cmd(0x2c); // RAMWR
  d.pixels(...new Array(12).fill(RED));

  check(dev.fb.raw(10, 20) === RED, 'the top-left of the window is red');
  check(dev.fb.raw(13, 22) === RED, 'and so is the bottom-right');
  check(dev.fb.raw(9, 20) === 0, 'the column before the window is untouched');
  check(dev.fb.raw(14, 20) === 0, 'and so is the column after it');
  check(dev.fb.raw(10, 23) === 0, 'and the row below it');
  check(dev.fb.nonBlackCount === 12, `exactly twelve pixels were written (${dev.fb.nonBlackCount})`);

  // More pixels than the window holds are discarded, not wrapped. Wrapping
  // would quietly overwrite the top of what was just drawn.
  d.pixels(...new Array(20).fill(GREEN));
  check(dev.fb.nonBlackCount === 12, `overflow past the window is discarded (${dev.fb.nonBlackCount} lit)`);
}

// ================================================ 2. several colours, in order
section('2. colour and pixel order come off the wire');
{
  const dev = new TftDisplayDevice('t', 'cs', ILI9341_SPEC);
  const d = driver(dev);
  bringUp(d);
  d.cmd(0x2a, 0x00, 0, 0x00, 3);
  d.cmd(0x2b, 0x00, 0, 0x00, 0);
  d.cmd(0x2c);
  d.pixels(RED, GREEN, BLUE, WHITE);

  const at = (x: number) => unpack565(dev.fb.raw(x, 0));
  check(at(0).r === 255 && at(0).g === 0, `pixel 0 is red (${JSON.stringify(at(0))})`);
  check(at(1).g === 255 && at(1).r === 0, `pixel 1 is green (${JSON.stringify(at(1))})`);
  check(at(2).b === 255 && at(2).r === 0, `pixel 2 is blue (${JSON.stringify(at(2))})`);
  check(
    at(3).r === 255 && at(3).g === 255 && at(3).b === 255,
    `pixel 3 is white — full scale survives the round trip (${JSON.stringify(at(3))})`,
  );

  // BGR order is a MADCTL bit, and getting it wrong is why a display shows
  // red where the sketch asked for blue.
  const bgr = new TftDisplayDevice('t2', 'cs', ILI9341_SPEC);
  const e = driver(bgr);
  bringUp(e);
  e.cmd(0x36, 0x08); // MADCTL with the BGR bit set
  e.cmd(0x2a, 0x00, 0, 0x00, 0);
  e.cmd(0x2b, 0x00, 0, 0x00, 0);
  e.cmd(0x2c);
  e.pixels(RED);
  const swapped = unpack565(bgr.fb.raw(0, 0));
  check(swapped.b === 255 && swapped.r === 0, `the BGR bit swaps red and blue (${JSON.stringify(swapped)})`);
}

// ================================================= 3. orientation is applied ==
section('3. MADCTL rotates and mirrors, and the buffer holds the panel');
{
  const dev = new TftDisplayDevice('t', 'cs', ILI9341_SPEC);
  const d = driver(dev);
  bringUp(d);
  d.cmd(0x36, 0x20); // MV: exchange rows and columns
  d.cmd(0x2a, 0x00, 5, 0x00, 5);
  d.cmd(0x2b, 0x00, 7, 0x00, 7);
  d.cmd(0x2c);
  d.pixels(RED);
  check(dev.fb.raw(7, 5) === RED, 'with MV set, the addressed column becomes the panel row');
  check(dev.fb.raw(5, 7) === 0, 'and the unrotated position is empty');

  const mirrored = new TftDisplayDevice('t2', 'cs', ILI9341_SPEC);
  const e = driver(mirrored);
  bringUp(e);
  e.cmd(0x36, 0x40); // MX: mirror the columns
  e.cmd(0x2a, 0x00, 0, 0x00, 0);
  e.cmd(0x2b, 0x00, 0, 0x00, 0);
  e.cmd(0x2c);
  e.pixels(RED);
  check(mirrored.fb.raw(239, 0) === RED, 'MX puts column 0 at the far edge');
}

// ================================================= 4. off, asleep, and unwired
section('4. a panel that is not showing anything shows nothing');
{
  const dev = new TftDisplayDevice('t', 'cs', ILI9341_SPEC);
  const d = driver(dev);
  // Draw before turning the display on: the RAM takes it, the glass does not.
  d.cmd(0x11);
  d.cmd(0x2a, 0x00, 0, 0x00, 0);
  d.cmd(0x2b, 0x00, 0, 0x00, 0);
  d.cmd(0x2c);
  d.pixels(RED);
  check(dev.fb.raw(0, 0) === RED, 'the framebuffer holds what was written');
  check(!dev.isVisible, 'but the panel is not visible without a display-on');
  check(dev.pixel(0, 0).r === 0, 'so the glass is black');

  d.cmd(0x29);
  check(dev.pixel(0, 0).r === 255, 'display-on reveals it');

  d.cmd(0x10); // sleep in
  check(!dev.isVisible && dev.pixel(0, 0).r === 0, 'and sleeping hides it again without losing the RAM');
  check(dev.fb.raw(0, 0) === RED, 'the RAM is still intact');

  // A hardware reset clears everything, which is why a sketch that resets and
  // then draws without re-initialising gets nothing.
  d.cmd(0x11);
  d.cmd(0x29);
  d.resetPulse();
  check(dev.fb.raw(0, 0) === 0, 'a reset pulse clears the framebuffer');
  check(!dev.isVisible, 'and leaves the part in its power-on state, display off');

  // D/C that reaches nothing means every byte is read as a command, so no
  // pixel ever lands. That is the honest reading of a floating line.
  const unwired = new TftDisplayDevice('u', 'cs', ILI9341_SPEC);
  unwired.attachControls(() => undefined);
  unwired.select(true);
  for (const b of [0x01, 0x11, 0x29, 0x2c, 0xff, 0xff]) unwired.transfer(b);
  check(unwired.fb.nonBlackCount === 0, 'a display with no D/C wired never writes a pixel');
}

// ======================== 5. the controllers do not accept each other's commands
section("5. one controller's sequence does not drive another");
{
  // 0xBB is the ST7789's VCOM setting and 0xC6 its normal-mode frame rate.
  // Neither exists on an ILI9341, whose power and VCOM registers are at other
  // addresses entirely — so an ST7789 initialisation run against an ILI9341
  // leaves it unconfigured, which is the blank screen people get on a bench.
  const st = new TftDisplayDevice('st', 'cs', ST7789_SPEC);
  const s = driver(st);
  s.cmd(0xbb, 0x19);
  s.cmd(0xc6, 0x0f);
  check(st.unknownCommands.length === 0, 'the ST7789 knows its own VCOM and frame-rate registers');

  const ili = new TftDisplayDevice('ili', 'cs', ILI9341_SPEC);
  const i = driver(ili);
  i.cmd(0xbb, 0x19);
  i.cmd(0xc6, 0x0f);
  check(
    ili.unknownCommands.includes(0xbb) && ili.unknownCommands.includes(0xc6),
    `and an ILI9341 records both as unknown rather than accepting them (${ili.unknownCommands.map((c) => '0x' + c.toString(16)).join(', ')})`,
  );

  // The reverse direction too: the ILI9341's power-control A is not an ST7789
  // command, so neither part is simply more permissive than the other.
  const ili2 = new TftDisplayDevice('ili2', 'cs', ILI9341_SPEC);
  driver(ili2).cmd(0xcb, 0x39, 0x2c, 0x00, 0x34, 0x02);
  check(ili2.unknownCommands.length === 0, 'the ILI9341 knows its own power-control A');
  const st4 = new TftDisplayDevice('st4', 'cs', ST7789_SPEC);
  driver(st4).cmd(0xcb, 0x39, 0x2c, 0x00, 0x34, 0x02);
  check(st4.unknownCommands.includes(0xcb), 'and the ST7789 does not have it');

  // The GC9A01's unlock pair does not exist on an ST7789.
  const gc = new TftDisplayDevice('gc', 'cs', GC9A01_SPEC);
  driver(gc).cmd(0xfe);
  check(gc.unknownCommands.length === 0, 'the GC9A01 has its inter-register enable');

  const st2 = new TftDisplayDevice('st2', 'cs', ST7789_SPEC);
  driver(st2).cmd(0xfe);
  check(st2.unknownCommands.includes(0xfe), 'and an ST7789 records it as unknown rather than swallowing it');

  // A pixel format the silicon does not have is refused, not corrected.
  const fmt = new TftDisplayDevice('f', 'cs', ILI9341_SPEC);
  const g = driver(fmt);
  bringUp(g);
  g.cmd(0x3a, 0x53); // 12-bit, which the ILI9341 does not offer
  check(fmt.refusedPixelFormats.includes(0x53), 'the ILI9341 refuses a 12-bit pixel format');
  check(fmt.currentPixelFormat === 0x55, 'and stays on the format it was already using');

  const st3 = new TftDisplayDevice('st3', 'cs', ST7735_SPEC);
  const h = driver(st3);
  bringUp(h);
  h.cmd(0x3a, 0x53);
  check(st3.refusedPixelFormats.length === 0, 'while an ST7735, which does have 12-bit, accepts it');

  // The ST7735 decodes only COLMOD's low three bits. Adafruit's driver sends
  // 0x05 for 16-bit colour, and a real panel shows it.
  const adafruitStyle = new TftDisplayDevice('st-ada', 'cs', ST7735_SPEC);
  const ada = driver(adafruitStyle);
  bringUp(ada);
  ada.cmd(0x3a, 0x03);
  ada.cmd(0x3a, 0x05);
  check(
    adafruitStyle.refusedPixelFormats.length === 0 && adafruitStyle.currentPixelFormat === 0x55,
    `an ST7735 takes 0x05 as 16-bit colour, as the Adafruit driver sends it (0x${adafruitStyle.currentPixelFormat.toString(16)})`,
  );
  const wholeByte = new TftDisplayDevice('ili-whole', 'cs', ILI9341_SPEC);
  const wb = driver(wholeByte);
  bringUp(wb);
  wb.cmd(0x3a, 0x05);
  check(wholeByte.refusedPixelFormats.includes(0x05), 'while an ILI9341, which decodes the whole byte, still refuses it');
}

// ==================================== 6. the ST7735's memory offset is applied
section("6. the ST7735 panel is a corner of the controller's memory");
{
  const dev = new TftDisplayDevice('t', 'cs', ST7735_SPEC);
  const d = driver(dev);
  bringUp(d);
  // A driver that knows about the offset addresses column 2, row 1 for the
  // top-left pixel of a 128x160 panel.
  d.cmd(0x2a, 0x00, 2, 0x00, 2);
  d.cmd(0x2b, 0x00, 1, 0x00, 1);
  d.cmd(0x2c);
  d.pixels(RED);
  check(dev.fb.raw(0, 0) === RED, 'addressing column 2 row 1 lands on the panel origin');
  check(dev.fb.width === 128 && dev.fb.height === 160, `the visible panel is 128x160 (${dev.fb.width}x${dev.fb.height})`);
}

// ============================================ 7. the SSD1331 draws in hardware
section('7. the SSD1331 has its own command set and its own drawing engine');
{
  const dev = new Ssd1331Device('s', 'cs');
  let dc = false;
  dev.attachControls((pin) => (pin === 'dc' ? dc : undefined));
  dev.select(true);
  const cmd = (...bytes: number[]) => {
    dc = false;
    for (const b of bytes) dev.transfer(b);
  };
  const data = (...words: number[]) => {
    dc = true;
    for (const w of words) {
      dev.transfer((w >> 8) & 0xff);
      dev.transfer(w & 0xff);
    }
  };

  cmd(0xaf); // display on
  // 0x72 is the remap value every driver for this part ships with, and it does
  // more than select 65k colour: bit 1 remaps the columns and bit 4 reverses
  // the COM scan, so RAM (0,0) drives the opposite corner of the glass.
  // Asserting the mirrored position is the point — a model that ignored the
  // remap would put the picture in the wrong corner and look fine in isolation.
  cmd(0xa0, 0x72);
  check(dev.isVisible, 'the panel is on');

  // There is no RAMWR: a window, then data.
  cmd(0x15, 0, 3);
  cmd(0x75, 0, 0);
  data(RED, GREEN, BLUE, WHITE);
  check(dev.fb.raw(95, 63) === RED, 'pixel data follows the window with no memory-write command');
  check(
    unpack565(dev.fb.raw(92, 63)).r === 255 && unpack565(dev.fb.raw(92, 63)).b === 255,
    'and four pixels landed in a row, at the corner the standard remap sends them to',
  );
  check(dev.fb.raw(0, 0) === 0, 'with nothing at the unmirrored origin');

  // The same value with bit 2 set selects BGR, which is the other remap byte
  // drivers offer — and the difference between red and blue on the glass.
  const bgr = new Ssd1331Device('sb', 'cs');
  let bdc = false;
  bgr.attachControls((pin) => (pin === 'dc' ? bdc : undefined));
  bgr.select(true);
  const bcmd = (...bytes: number[]) => {
    bdc = false;
    for (const b of bytes) bgr.transfer(b);
  };
  bcmd(0xaf);
  bcmd(0xa0, 0x76);
  bcmd(0x15, 0, 0);
  bcmd(0x75, 0, 0);
  bdc = true;
  bgr.transfer(RED >> 8);
  bgr.transfer(RED & 0xff);
  check(unpack565(bgr.fb.raw(95, 63)).b === 255, 'remap 0x76 selects BGR and turns the red word blue');

  // A remap that selects the 256-colour mode is refused rather than decoded
  // into the wrong colours.
  const eight = new Ssd1331Device('s8', 'cs');
  eight.attachControls(() => false);
  eight.select(true);
  for (const b of [0xa0, 0x32]) eight.transfer(b);
  check(eight.refusedRemapValues.includes(0x32), 'a 256-colour remap is recorded as refused');

  // The drawing engine: a filled rectangle sent as ten argument bytes.
  const fresh = new Ssd1331Device('s2', 'cs');
  let dc2 = false;
  fresh.attachControls((pin) => (pin === 'dc' ? dc2 : undefined));
  fresh.select(true);
  const cmd2 = (...bytes: number[]) => {
    dc2 = false;
    for (const b of bytes) fresh.transfer(b);
  };
  cmd2(0xaf);
  cmd2(0xa0, 0x72);
  cmd2(0x26, 0x01); // enable fill
  cmd2(0x22, 2, 2, 5, 6, 0, 63, 0, 0, 63, 0); // rectangle, green outline and fill
  check(fresh.fillEnabled, 'fill mode is on');
  // Mirrored by the same remap: columns 2..5 land at 93..90 and rows 2..6 at
  // 61..57, because the drawing engine addresses RAM exactly as a pixel write
  // does. A hardware-drawn rectangle and a streamed one must land together.
  check(unpack565(fresh.fb.raw(92, 59)).g > 200, 'the controller filled the rectangle itself, with no pixel data sent');
  check(fresh.fb.raw(1, 1) === 0, 'and nothing outside it');
  check(fresh.fb.raw(3, 4) === 0, 'and the engine honours the same remap the pixel path does');

  // An ILI9341 command is not an SSD1331 command.
  const foreign = new Ssd1331Device('s3', 'cs');
  foreign.attachControls(() => false);
  foreign.select(true);
  foreign.transfer(0x2c); // RAMWR — meaningless here
  check(foreign.unknownCommands.includes(0x2c), 'RAMWR is recorded as unknown on an SSD1331');
}

// ============================== 8. through real firmware and the real binding =
section('8. an executed sketch drawing on a wired ILI9341');
{
  // No graphics library: the sketch drives SPI and the D/C line itself, which
  // is the only way to prove the binding delivers the control pin alongside
  // the bytes.
  const SOURCE = [
    '#include <SPI.h>',
    'const int CS = 10, DC = 9, RST = 8;',
    'void cmd(uint8_t c) { digitalWrite(DC, LOW); SPI.transfer(c); digitalWrite(DC, HIGH); }',
    'void d8(uint8_t v) { SPI.transfer(v); }',
    'void px(uint16_t c) { SPI.transfer(c >> 8); SPI.transfer(c & 0xFF); }',
    'void setup() {',
    '  pinMode(CS, OUTPUT); pinMode(DC, OUTPUT); pinMode(RST, OUTPUT);',
    '  digitalWrite(RST, HIGH); digitalWrite(CS, HIGH);',
    '  SPI.begin();',
    '  SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));',
    '  digitalWrite(CS, LOW);',
    '  cmd(0x01);',            // software reset
    '  cmd(0x11);',            // sleep out
    '  cmd(0x3A); d8(0x55);',  // 16-bit colour
    '  cmd(0x36); d8(0x00);',  // MADCTL
    '  cmd(0x29);',            // display on
    '  cmd(0x2A); d8(0); d8(0); d8(0); d8(9);',   // columns 0..9
    '  cmd(0x2B); d8(0); d8(0); d8(0); d8(4);',   // rows 0..4
    '  cmd(0x2C);',
    '  for (uint8_t i = 0; i < 50; i++) px(0xF800);', // 50 red pixels
    '  cmd(0x2A); d8(0); d8(20); d8(0); d8(23);',
    '  cmd(0x2B); d8(0); d8(30); d8(0); d8(31);',
    '  cmd(0x2C);',
    '  for (uint8_t i = 0; i < 8; i++) px(0x001F);', // 8 blue pixels
    '  digitalWrite(CS, HIGH);',
    '  SPI.endTransaction();',
    '}',
    'void loop() {}',
  ].join('\n');

  const p = emptyProject('tft');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.arduino-uno', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  const tft: ComponentInstance = {
    id: uid('t'), definitionId: 'comp.ili9341', x: 300, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  p.boardInstances.push(board);
  p.componentInstances.push(tft);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  const wire = (a: string, ap: string, b: string, bp: string) =>
    p.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#000', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  wire(board.id, '3V3', tft.id, 'vcc');
  wire(board.id, 'GND_TOP', tft.id, 'gnd');
  wire(board.id, 'D13', tft.id, 'sck');
  wire(board.id, 'D11', tft.id, 'mosi');
  wire(board.id, 'D10', tft.id, 'cs');
  wire(board.id, 'D9', tft.id, 'dc');
  wire(board.id, 'D8', tft.id, 'rst');

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the wired TFT test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(200);
    simulationController.publishNow();
    const visuals = useSimulationStore.getState().visuals as Record<
      string,
      { raster?: { width: number; height: number; pixels: Uint16Array; revision: number } | null }
    >;
    const raster = visuals[tft.id]?.raster ?? null;
    check(raster !== null, 'the panel is visible and hands the canvas a framebuffer');
    if (raster) {
      const at = (x: number, y: number) => raster.pixels[y * raster.width + x];
      console.log(`   (0,0)=0x${at(0, 0).toString(16)}  (20,30)=0x${at(20, 30).toString(16)}`);
      check(raster.width === 240 && raster.height === 320, `it is 240x320 (${raster.width}x${raster.height})`);
      check(at(0, 0) === 0xf800, 'firmware drew red into the first window');
      check(at(9, 4) === 0xf800, 'across its full ten-by-five extent');
      check(at(10, 0) === 0, 'and not past its edge');
      check(at(20, 30) === 0x001f, 'the second window is blue, at the address firmware chose');
      check(at(19, 30) === 0, 'with nothing beside it');
      let lit = 0;
      for (let i = 0; i < raster.pixels.length; i++) if (raster.pixels[i] !== 0) lit++;
      check(lit === 58, `exactly the fifty-eight pixels firmware sent are set (${lit})`);
    }
  }
  simulationController.stop();
}

// ==================================================== 9. the parts as shipped =
section('9. the parts in the library');
{
  const ids = ['comp.ili9341', 'comp.st7735', 'comp.st7789', 'comp.gc9a01', 'comp.ssd1331'];
  for (const id of ids) {
    const def = defOf(id);
    check(def !== undefined, `${id} is in the library`);
    if (!def) continue;
    check(def.supportLevel === 'simulated', `${id} is badged Simulated`);
    for (const pinId of ['sck', 'mosi', 'cs', 'dc', 'rst', 'vcc', 'gnd']) {
      check(def.pins.some((pp) => pp.id === pinId), `${id} exposes ${pinId}`);
    }
    const cov = COMPONENT_COVERAGE.find((c) => c.id === id);
    check(cov?.status === 'simulated', `${id} is recorded as simulated`);
    check((cov?.tests ?? []).includes('tests/displays.tft.mts'), `${id} names this file as its proof`);
  }
}

console.log(
  failures === 0
    ? `\nTFT checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
