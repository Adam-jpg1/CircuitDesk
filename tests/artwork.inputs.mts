// What the new parts look like, and whether they are recognisable.
//
// Renders each Batch 1 part at normal workspace scale and writes an SVG sheet
// that a person can look at. The automated half checks the things a person
// would not notice reliably: that a part is not a captioned rectangle, that
// its interactive state is actually visible, and that nothing spills outside
// its own outline onto whatever is next to it on the canvas.

import { writeFileSync, mkdirSync } from 'node:fs';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import { interactiveHotspots } from '../src/components-library/artwork/interactiveGeometry';
import { contactsOf } from '../src/simulation/devices/contactRegistry';
import type { ComponentInstance } from '../src/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const MM = 4;
const OUT_DIR = 'artwork-review';

const BATCH1 = [
  'comp.push-button-6mm', 'comp.slide-switch', 'comp.limit-switch',
  'comp.dip-switch-4', 'comp.dip-switch-8',
  'comp.rotary-encoder', 'comp.joystick',
  'comp.keypad-3x4', 'comp.keypad-4x4', 'comp.mini-keyboard',
];

const defOf = (id: string) => COMPONENT_DEFINITIONS.find((d) => d.id === id)!;
const inst = (definitionId: string, properties: Record<string, unknown> = {}): ComponentInstance => ({
  id: `i-${definitionId}`, definitionId, x: 0, y: 0, rotation: 0, properties, simulationState: {},
});

// tsx compiles JSX in classic mode, so the artwork module is loaded after a
// global React is in place and rendered through renderToStaticMarkup.
const React = (await import('react')).default;
(globalThis as unknown as { React: unknown }).React = React;
const { renderToStaticMarkup } = await import('react-dom/server');
const { ComponentArtwork } = await import('../src/components-library/artwork/componentArtwork');

/** One part rendered to SVG markup, with the given contacts engaged. */
function render(id: string, engaged: string[] = [], properties: Record<string, unknown> = {}): string {
  const def = defOf(id);
  const instance = inst(id, properties);
  const contacts: Record<string, boolean> = {};
  for (const c of contactsOf(id, instance)) contacts[c.key] = engaged.includes(c.key);
  return renderToStaticMarkup(
    React.createElement(ComponentArtwork, { def, instance, visual: { contacts } }),
  );
}

console.log('--- structural checks ----------------------------------------------------------');

for (const id of BATCH1) {
  const def = defOf(id);
  const markup = render(id);

  // A part that is only a rectangle and a caption is the placeholder the
  // artwork work exists to replace.
  const shapes = (markup.match(/<(rect|circle|path|ellipse|line|polygon)/g) ?? []).length;
  const texts = (markup.match(/<text/g) ?? []).length;
  check(shapes >= 6, `${id}: drawn from real shapes, not a box (${shapes} shapes, ${texts} labels)`);

  // Recognisable at normal scale means the part is not a few pixels across.
  const w = def.widthMm * MM;
  const h = def.heightMm * MM;
  check(w >= 20 && h >= 20, `${id}: has real size on the canvas (${Math.round(w)}×${Math.round(h)} units)`);

  // Nothing may be drawn outside the part's own outline — a component that
  // paints over its neighbour looks like a rendering bug to a user.
  const coords = [...markup.matchAll(/(?:x|cx|x1|x2)="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
  const ys = [...markup.matchAll(/(?:y|cy|y1|y2)="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
  const overhangX = coords.filter((v) => v < -2 || v > w + 2).length;
  const overhangY = ys.filter((v) => v < -2 || v > h + 2).length;
  check(overhangX === 0 && overhangY === 0, `${id}: stays inside its own outline (${overhangX}+${overhangY} strays)`);
}

console.log('\n--- interaction is visible -----------------------------------------------------');

// The state a user sets must actually change the picture, or the part is
// lying about being interactive.
for (const [id, key] of [
  ['comp.push-button-6mm', ''],
  ['comp.slide-switch', ''],
  ['comp.limit-switch', ''],
  ['comp.dip-switch-8', 'sw3'],
  ['comp.rotary-encoder', 'sw'],
  ['comp.joystick', 'sw'],
  ['comp.keypad-4x4', 'r1c2'],
  ['comp.mini-keyboard', 'r2c4'],
] as const) {
  const idle = render(id);
  const active = render(id, [key]);
  check(idle !== active, `${id}: engaging ${key === '' ? 'the control' : key} changes what is drawn`);
}

// And engaging one key must not redraw the others.
{
  const one = render('comp.keypad-4x4', ['r0c0']);
  const other = render('comp.keypad-4x4', ['r3c3']);
  check(one !== other, 'two different keypad keys produce two different pictures');
  const both = render('comp.keypad-4x4', ['r0c0', 'r3c3']);
  check(both !== one && both !== other, 'and holding both is different again');
}

console.log('\n--- hotspots line up with the drawing ------------------------------------------');

for (const id of BATCH1) {
  const def = defOf(id);
  const spots = interactiveHotspots(def, inst(id));
  if (spots.length === 0) continue;
  const w = def.widthMm * MM;
  const h = def.heightMm * MM;
  const outside = spots.filter((s) => s.x < -1 || s.y < -1 || s.x + s.w > w + 1 || s.y + s.h > h + 1);
  check(outside.length === 0, `${id}: all ${spots.length} control(s) are within the part`);
  const tiny = spots.filter((s) => s.w < 8 || s.h < 8);
  check(tiny.length === 0, `${id}: every control is big enough to hit (${tiny.length} too small)`);
}

// ------------------------------------------------------------------ the sheet

mkdirSync(OUT_DIR, { recursive: true });

/** A review sheet: each part idle on the left, engaged on the right. */
function sheet(): string {
  const rows: string[] = [];
  let y = 40;
  let maxW = 400;
  for (const id of BATCH1) {
    const def = defOf(id);
    const w = def.widthMm * MM;
    const h = def.heightMm * MM;
    const instance = inst(id);
    const keys = contactsOf(id, instance).map((c) => c.key);
    // Engage the contact a person would actually operate. On an encoder that
    // is the shaft click, not the quadrature contact the shaft moves for you.
    const engaged = id.includes('keypad') || id.includes('keyboard')
      ? [keys[0], keys[Math.floor(keys.length / 2)], keys[keys.length - 1]]
      : keys.includes('sw')
        ? ['sw']
        : [keys[0] ?? ''];

    rows.push(
      `<text x="10" y="${y - 8}" fill="#8b949e" font-family="sans-serif" font-size="11">${def.name} — ${def.widthMm}×${def.heightMm} mm</text>`,
      `<g transform="translate(10 ${y})">${render(id)}</g>`,
      `<g transform="translate(${w + 50} ${y})">${render(id, engaged)}</g>`,
    );
    maxW = Math.max(maxW, w * 2 + 70);
    y += h + 34;
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${maxW}" height="${y}" viewBox="0 0 ${maxW} ${y}">`,
    `<rect width="${maxW}" height="${y}" fill="#0d1117"/>`,
    `<text x="10" y="22" fill="#e6ebf1" font-family="sans-serif" font-size="14">CircuitDesk Batch 1 — inputs at 1:1 workspace scale (idle · engaged)</text>`,
    ...rows,
    '</svg>',
  ].join('\n');
}

const path = `${OUT_DIR}/batch1-inputs.svg`;
writeFileSync(path, sheet());
console.log(`\nReview sheet written to ${path}`);

console.log(failures === 0 ? '\nInput artwork checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
