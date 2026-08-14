// Monochrome dot-matrix panels: the SH1107, and the orientation controls that
// decide which way up a picture comes out.
//
// The SH1107 is the part most likely to be mistaken for an SSD1306 — same two
// wires, same address, same module footprint — and a simulator that quietly
// accepted SSD1306 command bytes on one would be worse than useless: it would
// make a wiring mistake that costs a real afternoon disappear. So the first
// thing proved here is that the two decoders genuinely differ, in both
// directions.
//
// The second is orientation. Segment remap, COM scan direction and the display
// start line were previously accepted and discarded, which meant a driver that
// flipped the panel got an unflipped picture. They are now applied on read-out,
// so the RAM still holds what firmware wrote — a write and a read-back agree —
// while the glass shows what the silicon would show.

import { Sh1107Device, SH1107_ADDRESSES, SH1107_WIDTH, SH1107_HEIGHT } from '../src/simulation/devices/sh1107';
import { Ssd1306Device, SSD1306_ADDRESSES } from '../src/simulation/devices/ssd1306';
import { PagedMonoRam } from '../src/simulation/devices/pagedMono';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import { COMPONENT_COVERAGE } from '../src/components-library/componentCoverage';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

const defOf = (id: string) => COMPONENT_DEFINITIONS.find((d) => d.id === id);

/** Drives a device the way a library does: control byte, then payload. */
function driver(device: Sh1107Device | Ssd1306Device, address: number) {
  const send = (control: number, bytes: number[]) => {
    device.start(address, true);
    device.writeByte(control);
    for (const b of bytes) device.writeByte(b);
    device.stop();
  };
  return {
    cmd: (...bytes: number[]) => send(0x00, bytes),
    data: (...bytes: number[]) => send(0x40, bytes),
  };
}

// ============================================ 1. the shared paged RAM ========
section('1. the paged RAM walks the cursor the way the addressing mode says');
{
  const ram = new PagedMonoRam(128, 64);

  // Page mode: the cursor wraps within the row and never moves down. A model
  // that fell through to the next page here would show a frame drawn correctly
  // but laid out wrongly, which is the hardest kind of bug to see.
  ram.addressingMode = 'page';
  ram.colStart = 0;
  ram.colEnd = 3;
  ram.col = 0;
  ram.page = 2;
  for (let i = 0; i < 6; i++) ram.write(0xff);
  check(ram.page === 2, 'page mode never leaves the page it was given');
  check(ram.col === 2, `and wraps the column within the window (col ${ram.col})`);

  ram.reset();
  ram.addressingMode = 'horizontal';
  ram.colStart = 0;
  ram.colEnd = 1;
  ram.pageStart = 0;
  ram.pageEnd = 3;
  ram.col = 0;
  ram.page = 0;
  for (let i = 0; i < 3; i++) ram.write(0x01);
  check(ram.page === 1 && ram.col === 1, `horizontal mode steps to the next page at the window edge (p${ram.page} c${ram.col})`);

  ram.reset();
  ram.addressingMode = 'vertical';
  ram.colStart = 0;
  ram.colEnd = 3;
  ram.pageStart = 0;
  ram.pageEnd = 1;
  ram.col = 0;
  ram.page = 0;
  // Two writes fill the page window of column 0, and the cursor then steps
  // across rather than down — which is the whole difference from horizontal.
  ram.write(0x01);
  ram.write(0x02);
  check(ram.page === 0 && ram.col === 1, `vertical mode fills the column's pages, then moves across (p${ram.page} c${ram.col})`);
  check(ram.ram[0 * 128 + 0] === 0x01 && ram.ram[1 * 128 + 0] === 0x02, 'and the two bytes went down column 0, not across page 0');
}

// ================================================ 2. orientation on read-out =
section('2. remap, scan direction and start line move the picture, not the RAM');
{
  const ram = new PagedMonoRam(128, 64);
  ram.page = 0;
  ram.col = 0;
  ram.write(0x01); // one pixel at RAM (0,0)

  check(ram.pixel(0, 0), 'with no orientation set, the pixel is where it was written');

  ram.segmentRemap = true;
  check(!ram.pixel(0, 0) && ram.pixel(127, 0), 'segment remap moves it to the far column');
  check(ram.ram[0] === 0x01, 'and the RAM still holds what firmware wrote, unmoved');
  ram.segmentRemap = false;

  ram.comScanReverse = true;
  check(!ram.pixel(0, 0) && ram.pixel(0, 63), 'reversing the COM scan moves it to the bottom row');
  ram.comScanReverse = false;

  ram.startLine = 8;
  check(!ram.pixel(0, 0) && ram.pixel(0, 56), `the start line rotates the panel (row 56)`);
  ram.startLine = 0;

  // Both at once is the case a real driver produces: Adafruit's init sets
  // 0xA1 and 0xC8 together to get an upright picture on a common module.
  ram.segmentRemap = true;
  ram.comScanReverse = true;
  check(ram.pixel(127, 63), 'remap and reverse scan together put it in the opposite corner');
}

// =================================== 3. the SH1107 is not an SSD1306 =========
section('3. the two controllers decode differently, in both directions');
{
  // 0x21 means "set column address, two arguments follow" on an SSD1306 and
  // "vertical addressing mode" on an SH1107. Pointing one driver at the other
  // part is the mistake this catches.
  const sh = new Sh1107Device('sh', SH1107_ADDRESSES[0]);
  const d = driver(sh, SH1107_ADDRESSES[0]);
  d.cmd(0xaf); // display on
  d.cmd(0x21); // SH1107: vertical addressing. SSD1306: expects two arguments.
  d.cmd(0xb3); // SH1107: page 3. An SSD1306 decoder would eat this as an argument.
  d.data(0x01);
  check(sh.pixel(0, 24), 'the SH1107 reads 0x21 as a mode opcode, so the following page command lands (page 3, row 24)');

  const ssd = new Ssd1306Device('ssd', SSD1306_ADDRESSES[0]);
  const e = driver(ssd, SSD1306_ADDRESSES[0]);
  e.cmd(0xaf);
  e.cmd(0x21); // SSD1306: set column address, two arguments follow
  e.cmd(0x00, 0x7f);
  e.cmd(0xb3); // now this is a page command
  e.data(0x01);
  check(ssd.pixel(0, 24), 'and the SSD1306 reads the same byte as a two-argument command, as it should');

  // The page opcode range is the other half of the difference: 0xB8-0xBF is a
  // page on an SH1107 and not a page on an SSD1306.
  const sh2 = new Sh1107Device('sh2');
  const f = driver(sh2, SH1107_ADDRESSES[0]);
  f.cmd(0xaf);
  f.cmd(0xbf); // page 15 — the bottom eight rows of a 128-row panel
  f.data(0x80);
  check(sh2.pixel(0, 127), 'a four-bit page opcode reaches page 15, which only exists on the taller panel');

  const ssd2 = new Ssd1306Device('ssd2');
  const g = driver(ssd2, SSD1306_ADDRESSES[0]);
  g.cmd(0xaf);
  g.cmd(0xbf);
  check(
    ssd2.unhandledCommands.includes(0xbf),
    'while the SSD1306 records 0xBF as unhandled rather than pretending to have a sixteenth page',
  );
}

// ========================================= 4. the SH1107's own command set ===
section('4. the SH1107 does what its datasheet says');
{
  const sh = new Sh1107Device('sh');
  const d = driver(sh, SH1107_ADDRESSES[0]);

  check(!sh.isOn, 'it powers up with the display off');
  d.data(0xff);
  check(sh.litPixels === 0, 'and shows nothing while off, however much data arrives');

  d.cmd(0xaf);
  check(sh.isOn && sh.litPixels === 8, `display on reveals the eight pixels already in RAM (${sh.litPixels})`);

  // Column address: low nibble then high, seven bits in total.
  const sh2 = new Sh1107Device('sh2');
  const e = driver(sh2, SH1107_ADDRESSES[0]);
  e.cmd(0xaf);
  e.cmd(0xb0); // page 0
  e.cmd(0x05); // column low nibble = 5
  e.cmd(0x14); // column high nibble = 4 -> column 0x45 = 69
  e.data(0x01);
  check(sh2.pixel(69, 0), 'the split column address addresses column 69');

  // Start line is a two-byte command here, not 0x40 | line.
  const sh3 = new Sh1107Device('sh3');
  const f = driver(sh3, SH1107_ADDRESSES[0]);
  f.cmd(0xaf);
  f.cmd(0xb0);
  f.data(0x01); // pixel at RAM row 0
  f.cmd(0xdc, 0x08); // start line 8
  check(sh3.pixel(0, 120), `0xDC sets the start line, moving the pixel to row 120`);

  // Inverse and all-on are display-wide and must not touch RAM.
  const sh4 = new Sh1107Device('sh4');
  const g = driver(sh4, SH1107_ADDRESSES[0]);
  g.cmd(0xaf);
  g.data(0x01);
  g.cmd(0xa7);
  check(
    sh4.litPixels === SH1107_WIDTH * SH1107_HEIGHT - 1,
    `inverse lights everything except the one written pixel (${sh4.litPixels})`,
  );
  g.cmd(0xa6);
  g.cmd(0xa5);
  check(sh4.litPixels === SH1107_WIDTH * SH1107_HEIGHT, 'entire-display-on lights the panel');
  g.cmd(0xa4);
  check(sh4.litPixels === 1, 'and resuming from RAM gives the one pixel back — RAM was never touched');

  // An unknown opcode is recorded, never swallowed.
  const sh5 = new Sh1107Device('sh5');
  driver(sh5, SH1107_ADDRESSES[0]).cmd(0xe0);
  check(sh5.unhandledCommands.includes(0xe0), 'read-modify-write is reported as unhandled rather than half-implemented');
}

// ============================================ 5. addressing and the frame ====
section('5. a real frame, drawn the way a driver draws one');
{
  const sh = new Sh1107Device('sh');
  const d = driver(sh, SH1107_ADDRESSES[0]);
  d.cmd(0xaf);
  d.cmd(0x20); // page addressing
  // Sixteen pages, sixteen columns of each: a 16×128 vertical stripe.
  for (let page = 0; page < 16; page++) {
    d.cmd(0xb0 | page);
    d.cmd(0x00);
    d.cmd(0x10);
    d.data(...new Array(16).fill(0xff));
  }
  check(sh.litPixels === 16 * 128, `the stripe is exactly 16×128 pixels (${sh.litPixels})`);
  check(sh.pixel(0, 0) && sh.pixel(15, 127), 'and reaches both corners of the stripe');
  check(!sh.pixel(16, 0), 'with nothing beyond it — no invented content');

  const frame = sh.frame();
  check(frame !== null && frame.length === (128 * 128) / 8, `the canvas frame is ${(128 * 128) / 8} bytes (${frame?.length})`);

  const off = new Sh1107Device('off');
  check(off.frame() === null, 'and a panel that was never turned on hands the canvas nothing to draw');
}

// ======================================== 6. wrong address, no response ======
section('6. it answers for its own address only');
{
  const sh = new Sh1107Device('sh', SH1107_ADDRESSES[0]);
  check(sh.matchesAddress(0x3c), 'it claims 0x3C');
  check(!sh.matchesAddress(0x3d), 'and not 0x3D when strapped to 0x3C');
  const alt = new Sh1107Device('alt', SH1107_ADDRESSES[1]);
  check(alt.matchesAddress(0x3d) && !alt.matchesAddress(0x3c), 'the strap option is a real alternative address');
}

// ================================================= 7. the part in the library
section('7. the part as it ships');
{
  const def = defOf('comp.sh1107');
  check(def !== undefined, 'the SH1107 module is in the library');
  if (def) {
    check(def.supportLevel === 'simulated', 'badged Simulated');
    check(def.simulationAdapterId === 'sim.sh1107', 'and wired to its own adapter, not the SSD1306 one');
    for (const pinId of ['sda', 'scl', 'vcc', 'gnd']) {
      check(def.pins.some((p) => p.id === pinId), `it has a ${pinId} pin`);
    }
    check(def.validationRules.includes('i2c-pins'), 'and is checked for being on a real I2C pair');
  }

  const cov = COMPONENT_COVERAGE.find((c) => c.id === 'comp.sh1107');
  check(cov?.status === 'simulated', 'the coverage matrix agrees it is simulated');
  check((cov?.tests ?? []).includes('tests/displays.mono.mts'), 'and names this file as what proves it');
}

console.log(failures === 0 ? '\nMonochrome display checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
