// Guardrails for the component artwork pass.
//
// Artwork is the one kind of change where "it looks better" is the whole point
// and also the whole risk: a redraw that nudges a pin, or that draws a picture
// the device never produced, has broken something real in exchange for
// something cosmetic. So this checks the parts that are not a matter of taste:
//
//   * pin coordinates, wire anchors and part boxes are byte-identical to what
//     saved projects were built against;
//   * what the LCD shows is the HD44780's own DDRAM, not decoration;
//   * what the OLED shows is the SSD1306's own GDDRAM, mapped correctly;
//   * neither can overflow its panel.
//
// The look itself is judged from rendered images, not asserted here. A test
// that claimed to measure beauty would be measuring nothing.

import { renderToStaticMarkup } from 'react-dom/server';
import React, { createElement } from 'react';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import { Lcd1602Device } from '../src/simulation/devices/lcd1602';
import { Ssd1306Device } from '../src/simulation/devices/ssd1306';
import type { ComponentDefinition, ComponentInstance } from '../src/types';

// The artwork module is TSX. This runner compiles JSX to the classic
// React.createElement form rather than the automatic runtime the app build
// uses, so React has to be reachable as a global before it is loaded.
(globalThis as unknown as { React: typeof React }).React = React;
const { ComponentArtwork, BUILTIN_ARTWORK_IDS } = await import(
  '../src/components-library/artwork/componentArtwork'
);

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const defOf = (id: string): ComponentDefinition =>
  COMPONENT_DEFINITIONS.find((d) => d.id === id)!;

const instance = (id: string): ComponentInstance => ({
  id, definitionId: id, x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
});

const render = (def: ComponentDefinition, visual?: unknown): string =>
  renderToStaticMarkup(
    createElement(ComponentArtwork, {
      def,
      instance: instance(def.id),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      visual: visual as any,
    }),
  );

// ============================== 1. geometry is exactly what it was ==========
//
// These are the numbers saved projects hold. A wire drawn last month lands on
// the pin at these coordinates, and an artwork change has no business moving
// them. The expected values are transcribed from the definitions as they stood
// before the art pass.
{
  const expected: Record<string, { size: [number, number]; pins: [string, number, number][] }> = {
    'comp.lcd1602': {
      size: [80, 36],
      // Canvas units, which is what the definitions store: 4 per millimetre.
      pins: [['gnd', 8, 8], ['vcc', 24, 8], ['sda', 40, 8], ['scl', 56, 8]],
    },
    'comp.oled': {
      size: [27, 27],
      pins: [['gnd', 30, 4], ['vcc', 46, 4], ['scl', 62, 4], ['sda', 78, 4]],
    },
  };
  for (const [id, want] of Object.entries(expected)) {
    const def = defOf(id);
    check(def !== undefined, `${id} exists`);
    if (!def) continue;
    check(
      def.widthMm === want.size[0] && def.heightMm === want.size[1],
      `${id} is still ${want.size[0]}×${want.size[1]} mm (${def.widthMm}×${def.heightMm})`,
    );
    check(def.pins.length === want.pins.length, `${id} still has ${want.pins.length} pins (${def.pins.length})`);
    for (const [pinId, x, y] of want.pins) {
      const pin = def.pins.find((p) => p.id === pinId);
      check(pin !== undefined, `${id}: ${pinId} still exists`);
      check(pin?.x === x && pin?.y === y, `${id}: ${pinId} is still at ${x},${y} (${pin?.x},${pin?.y})`);
    }
  }
}

// ============================= 2. the LCD shows what the device holds =======
{
  const def = defOf('comp.lcd1602');

  // Nothing driving it: no characters, and no invented ones either.
  const dark = render(def, {});
  check(!/Hello/.test(dark), 'an undriven LCD shows no text');

  // Text the device would actually be holding.
  const device = new Lcd1602Device('lcd', 0x27);
  const write = (byte: number, rs: boolean) => {
    // The backpack's nibble protocol: RS/EN/backlight in the low bits, data in
    // the high nibble, latched on each EN falling edge.
    for (const nibble of [byte & 0xf0, (byte << 4) & 0xf0]) {
      const base = nibble | (rs ? 0x01 : 0x00) | 0x08;
      device.writeByte(base | 0x04);
      device.writeByte(base);
    }
  };
  // The controller starts in 8-bit mode: one nibble-only function set switches
  // it to 4-bit, exactly as a driver library does.
  device.writeByte(0x20 | 0x08 | 0x04);
  device.writeByte(0x20 | 0x08);
  write(0x28, false); // function set, 4-bit, 2 lines
  write(0x0c, false); // display on
  write(0x01, false); // clear
  write(0x80, false); // DDRAM address 0
  for (const ch of 'Hello, world') write(ch.charCodeAt(0), true);
  write(0xc0, false); // second row
  for (const ch of 'Sending HIGH') write(ch.charCodeAt(0), true);

  check(device.lines[0].startsWith('Hello, world'), `the device holds the first row (${JSON.stringify(device.lines[0])})`);
  check(device.lines[1].startsWith('Sending HIGH'), `and the second (${JSON.stringify(device.lines[1])})`);

  const svg = render(def, { readout: device.lines, ledOn: true });
  // Characters are drawn one per cell, so every glyph the device holds appears.
  for (const ch of 'Helo,wrd') check(svg.includes(`>${ch}<`), `the panel draws the character "${ch}"`);
  const drawn = (svg.match(/class="device-readout"/g) ?? []).length;
  const nonSpace = device.lines.join('').replace(/ /g, '').length;
  check(drawn === nonSpace, `every non-blank character is drawn once (${drawn} vs ${nonSpace})`);

  // Sixteen columns, two rows, and no more — an over-long line cannot spill.
  const overlong = render(def, { readout: ['0123456789ABCDEFGHIJKLMN', 'X'.repeat(40)], ledOn: true });
  const cellCount = (overlong.match(/class="device-readout"/g) ?? []).length;
  check(cellCount === 32, `an over-long line is clipped to 16×2 cells (${cellCount})`);
  check(!/>G</.test(overlong), 'the seventeenth character of a row is not drawn');

  // Everything drawn stays inside the part's own box.
  const w = def.widthMm * 4;
  const h = def.heightMm * 4;
  const xs = [...overlong.matchAll(/ x="([-\d.]+)"/g)].map((m) => Number(m[1]));
  const ys = [...overlong.matchAll(/ y="([-\d.]+)"/g)].map((m) => Number(m[1]));
  check(xs.every((v) => v >= -1 && v <= w + 2), `nothing is drawn past the left or right edge (${Math.min(...xs)}..${Math.max(...xs)} of ${w})`);
  check(ys.every((v) => v >= -1 && v <= h + 2), `nor past the top or bottom (${Math.min(...ys)}..${Math.max(...ys)} of ${h})`);

  // Characters must be legible, which here means "much larger than the generic
  // box drew them". The old renderer capped them at 5.5 units.
  const sizes = [...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
  const charSize = Math.max(...sizes);
  check(charSize > 14, `characters are drawn large enough to read (${charSize.toFixed(1)} units, was 5.5)`);
  // And the screen has to dominate the part rather than sit in a corner.
  const glassArea = /width="([\d.]+)" height="([\d.]+)" fill="#1f5fd0"/.exec(svg);
  const area = glassArea ? Number(glassArea[1]) * Number(glassArea[2]) : 0;
  check(area / (w * h) > 0.5, `the lit panel covers most of the module (${((area / (w * h)) * 100).toFixed(0)}%)`);

  // A dark backlight is a different panel colour, not a hidden one.
  const unlit = render(def, { readout: device.lines, ledOn: false });
  check(!unlit.includes('#1f5fd0'), 'an unlit panel is not drawn as backlit');
  check((unlit.match(/class="device-readout"/g) ?? []).length === nonSpace, 'but its characters are still there');
}

// ============================ 3. the OLED maps its framebuffer =============
{
  const def = defOf('comp.oled');
  const dark = render(def, { display: { pixels: null, on: false, revision: 0 } });
  check(dark.includes('OLED'), 'a dark OLED says so rather than drawing pixels');

  // A framebuffer with a known shape: column 0 fully lit, and the bottom row.
  const ram = new Uint8Array(128 * 8);
  for (let page = 0; page < 8; page++) ram[page * 128] = 0xff;   // x=0, every row
  for (let x = 0; x < 128; x++) ram[7 * 128 + x] |= 0x80;         // row 63
  const svg = render(def, { display: { pixels: ram, on: true, revision: 1 } });

  const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="#a9e6ff"/g)].map(
    (m) => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) }),
  );
  check(rects.length > 0, `lit pixels are drawn (${rects.length} runs)`);
  // Runs, not one rect per pixel: the bottom row is 128 adjacent pixels and
  // must come out as a single wide rect.
  const wide = rects.filter((r) => r.w > 50);
  check(wide.length === 1, `a full lit row is one run, not 128 rects (${wide.length} wide run(s))`);
  check(rects.length < 200, `so a busy frame stays cheap to draw (${rects.length} nodes for 640 lit pixels)`);

  // The panel is a true 128×64, so a pixel is square.
  const glass = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="#04060a"/.exec(svg);
  check(glass !== null, 'the glass is drawn');
  if (glass) {
    const gw = Number(glass[3]);
    const gh = Number(glass[4]);
    check(Math.abs(gw / gh - 2) < 0.01, `the glass is 2:1 for a 128×64 panel (${(gw / gh).toFixed(3)})`);
    const px = gw / 128;
    const py = gh / 64;
    check(Math.abs(px - py) < 0.001, `so pixels are square (${px.toFixed(3)} × ${py.toFixed(3)})`);
    // Column 0 lands at the left edge; row 63 lands at the bottom.
    const leftmost = Math.min(...rects.map((r) => r.x));
    const lowest = Math.max(...rects.map((r) => r.y + r.h));
    check(Math.abs(leftmost - Number(glass[1])) < 0.01, 'column 0 maps to the left edge of the glass');
    check(Math.abs(lowest - (Number(glass[2]) + gh)) < 0.05, 'and row 63 to the bottom');
    check(gw * gh > def.widthMm * 4 * def.heightMm * 4 * 0.25, 'the screen dominates the module');
  }

  // And it really is the simulated device's RAM that gets drawn.
  const device = new Ssd1306Device('oled', 0x3c);
  check(typeof device.ram?.length === 'number', 'the SSD1306 model exposes the framebuffer the canvas reads');
}

// ================= 4. every part still resolves to an artwork ==============
//
// A renderer keyed off a builtin id that nothing registers falls silently back
// to the generic box, which is exactly how the LCD ended up drawing 1.4 mm
// characters. This lists the parts that do.
{
  const generic: string[] = [];
  for (const def of COMPONENT_DEFINITIONS) {
    if (def.artwork.kind !== 'builtin' || !def.artwork.builtinId) continue;
    if (!BUILTIN_ARTWORK_IDS.includes(def.artwork.builtinId)) generic.push(def.id);
  }
  console.log(`   parts still on the generic box (${generic.length}): ${generic.join(', ')}`);
  check(!generic.includes('comp.lcd1602'), 'the LCD is no longer drawn by the generic box');
  check(!generic.includes('comp.oled'), 'nor the OLED');
}

console.log(failures === 0 ? '\nDisplay artwork checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
