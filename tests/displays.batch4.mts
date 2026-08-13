// Batch 4 displays: what is on the screen came off the bus.
//
// A display model earns its badge by being driven, not by being drawn. So both
// parts here are exercised through their real protocol — an HD44780's nibble
// dance behind a PCF8574, and a MAX7219's sixteen-bit words latched on CS —
// and the assertions are about what the panel then shows.

import { Lcd1602Device, LCD1602_ADDRESSES } from '../src/simulation/devices/lcd1602';
import { Max7219Device, MAX7219_REG } from '../src/simulation/devices/max7219';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

const defOf = (id: string) => COMPONENT_DEFINITIONS.find((d) => d.id === id);

// -------------------------------------------------- an HD44780 driver, here
//
// The same sequence a library sends: a nibble at a time through a PCF8574,
// with the enable pulse that latches each one.

function makeLcdDriver(device: Lcd1602Device) {
  const BACKLIGHT = 0x08;
  const EN = 0x04;
  const write = (value: number) => {
    device.start(LCD1602_ADDRESSES[0], true);
    device.writeByte(value | BACKLIGHT);
    device.stop();
  };
  const pulse = (data: number) => {
    write(data | EN);
    write(data & ~EN);
  };
  const send = (value: number, mode: number) => {
    pulse((value & 0xf0) | mode);
    pulse(((value << 4) & 0xf0) | mode);
  };
  return {
    command: (c: number) => send(c, 0),
    print: (text: string) => {
      for (const ch of text) send(ch.charCodeAt(0), 1);
    },
    init: () => {
      pulse(0x30);
      pulse(0x30);
      pulse(0x20);
      send(0x28, 0); // 4-bit, two-line mode
      send(0x08, 0); // display off
      send(0x01, 0); // clear
      send(0x06, 0); // entry mode
      send(0x0c, 0); // display on
    },
  };
}

// ================================================ 1. the 2004 is 20 by four ==
section('1. LCD2004');
{
  const device = new Lcd1602Device('lcd', LCD1602_ADDRESSES[0], { columns: 20, rows: 4 });
  check(device.columns === 20 && device.rows === 4, `geometry is 20×4 (${device.columns}×${device.rows})`);

  const lcd = makeLcdDriver(device);
  check(device.lines.every((l) => l.trim() === ''), 'it shows nothing before initialisation');

  lcd.init();
  check(device.isFourBitMode, 'the init sequence puts it into 4-bit mode');
  check(device.lines.length === 4, `it reports four rows (${device.lines.length})`);
  check(device.lines.every((l) => l.length === 20), 'each twenty columns wide');

  lcd.command(0x80); // row 0
  lcd.print('CIRCUITDESK 20x4 OK');
  check(device.row(0) === 'CIRCUITDESK 20x4 OK ', `row 0 shows what was written (${JSON.stringify(device.row(0))})`);

  lcd.command(0xc0); // row 1
  lcd.print('SECOND LINE');
  check(device.row(1).startsWith('SECOND LINE'), `row 1 too (${JSON.stringify(device.row(1).trim())})`);

  lcd.command(0x94); // row 2 lives at 0x14
  lcd.print('THIRD');
  check(device.row(2).startsWith('THIRD'), `row 2 is at DDRAM 0x14 (${JSON.stringify(device.row(2).trim())})`);

  lcd.command(0xd4); // row 3 at 0x54
  lcd.print('FOURTH');
  check(device.row(3).startsWith('FOURTH'), `row 3 is at DDRAM 0x54 (${JSON.stringify(device.row(3).trim())})`);

  // The controller quirk: rows one and three are one buffer, so text running
  // off the end of row one appears on row three.
  const wrap = new Lcd1602Device('wrap', LCD1602_ADDRESSES[0], { columns: 20, rows: 4 });
  const wrapDriver = makeLcdDriver(wrap);
  wrapDriver.init();
  wrapDriver.command(0x80);
  wrapDriver.print('12345678901234567890ABCDE');
  check(
    wrap.row(2).startsWith('ABCDE'),
    `text past column 20 continues on row 3, as the real controller does (${JSON.stringify(wrap.row(2).trim())})`,
  );

  // Clear really clears.
  wrapDriver.command(0x01);
  check(wrap.lines.every((l) => l.trim() === ''), 'the clear command empties every row');

  // A 1602 built the old way is unchanged.
  const small = new Lcd1602Device('small', LCD1602_ADDRESSES[0]);
  check(small.columns === 16 && small.rows === 2, 'a 1602 still defaults to 16×2');
}

// ==================================================== 2. MAX7219 over SPI ====
section('2. MAX7219');
{
  const device = new Max7219Device('mx', 'cs');

  /** One sixteen-bit word, framed by chip select as the part requires. */
  const word = (address: number, data: number) => {
    device.select(true);
    device.transfer(address);
    device.transfer(data);
    device.select(false);
  };

  check(!device.isAwake, 'it powers up in shutdown, as the datasheet says');
  check(device.litCount === 0, 'and shows nothing');

  word(MAX7219_REG.SHUTDOWN, 0x01);
  check(device.isAwake, 'writing the shutdown register wakes it');

  word(MAX7219_REG.SCAN_LIMIT, 0x07);
  word(MAX7219_REG.DECODE_MODE, 0x00);
  word(MAX7219_REG.INTENSITY, 0x08);
  check(device.intensityLevel === 8, `intensity is stored (${device.intensityLevel})`);
  check(device.decodeModeValue === 0, 'and decode mode');

  // A diagonal, one row at a time.
  for (let row = 0; row < 8; row++) word(MAX7219_REG.DIGIT0 + row, 1 << (7 - row));
  const pixels = device.pixels;
  let diagonal = 0;
  for (let row = 0; row < 8; row++) if (((pixels[row] >> (7 - row)) & 1) === 1) diagonal++;
  check(diagonal === 8, `every row lit exactly the pixel firmware wrote (${diagonal}/8)`);
  check(device.litCount === 8, `and nothing else (${device.litCount} lit)`);

  // Shutdown blanks without losing the pattern.
  word(MAX7219_REG.SHUTDOWN, 0x00);
  check(device.litCount === 0, 'shutdown blanks the panel');
  word(MAX7219_REG.SHUTDOWN, 0x01);
  check(device.litCount === 8, 'and waking restores the pattern — the registers were kept');

  // Display test lights everything regardless.
  word(MAX7219_REG.DISPLAY_TEST, 0x01);
  check(device.litCount === 64, `display test lights all sixty-four (${device.litCount})`);
  word(MAX7219_REG.DISPLAY_TEST, 0x00);
  check(device.litCount === 8, 'and turning it off restores the pattern');

  // Scan limit really limits which rows are shown.
  word(MAX7219_REG.SCAN_LIMIT, 0x03);
  check(device.litCount === 4, `a scan limit of 3 shows four rows (${device.litCount})`);
  word(MAX7219_REG.SCAN_LIMIT, 0x07);

  // An unknown register is recorded rather than acted on.
  word(0x0e, 0xff);
  check(/unknown register/.test(device.snapshot().log.join(' ')), 'an unknown register is recorded as unhandled');
}

// ===================================================== 3. chained panels =====
section('3. two MAX7219s in a chain');
{
  // A real chain: the controller sends two words with CS low, and the first
  // word ends up in the *second* device. Modelled by passing displaced bytes
  // along, so the classic wrong-panel mistake is reproducible.
  const first = new Max7219Device('a', 'cs');
  const second = new Max7219Device('b', 'cs');

  const chainWord = (words: [number, number][]) => {
    first.select(true);
    second.select(true);
    for (const [address, data] of words) {
      const outA = first.transfer(address) ?? 0;
      second.transfer(outA);
      const outB = first.transfer(data) ?? 0;
      second.transfer(outB);
    }
    first.select(false);
    second.select(false);
  };

  // Wake both, then send two different rows in one frame.
  chainWord([[MAX7219_REG.SHUTDOWN, 0x01], [MAX7219_REG.SHUTDOWN, 0x01]]);
  check(first.isAwake && second.isAwake, 'both devices in the chain wake');

  chainWord([[MAX7219_REG.DIGIT0, 0xff], [MAX7219_REG.DIGIT0, 0x0f]]);
  check(first.litCount !== second.litCount, `the two panels received different data (${first.litCount} vs ${second.litCount})`);
  check(first.litCount > 0 && second.litCount > 0, 'and both received something');
}

// ================================================ 4. library and definitions ==
section('4. the parts are in the library');
{
  for (const id of ['comp.lcd2004', 'comp.max7219']) {
    const def = defOf(id);
    check(def !== undefined, `${id} is in the library`);
    if (!def) continue;
    check(def.supportLevel === 'simulated', `${id} is badged Simulated`);
    check(def.artwork.kind === 'builtin' && Boolean(def.artwork.builtinId), `${id} has real artwork`);
    const W = def.widthMm * 4;
    const H = def.heightMm * 4;
    check(
      def.pins.every((p) => p.x >= -1 && p.y >= -1 && p.x <= W + 1 && p.y <= H + 1),
      `${id}: every pin is inside the outline`,
    );
    check((def.description ?? '').length > 60, `${id} documents what it does and does not model`);
  }
  const matrix = defOf('comp.max7219')!;
  check(matrix.pins.some((p) => p.id === 'dout'), 'the matrix exposes DOUT so panels can be chained');
}

console.log(failures === 0 ? '\nBatch 4 display checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
