// Checkpoint A of the component art pass: the discrete and output parts.
//
// Same bargain as the display guardrails. The look is judged from rendered
// images; what is asserted here is everything that is not a matter of taste —
// above all that the artwork changed and the electrical model did not.
//
// The seven parts are the ones that were still drawn as a coloured rectangle
// with a caption in the middle: diode, transistor, MOSFET, speaker, relay,
// DC motor, stepper.

import { renderToStaticMarkup } from 'react-dom/server';
import React, { createElement } from 'react';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import type { ComponentDefinition, ComponentInstance } from '../src/types';

// The artwork module is TSX and this runner compiles JSX to the classic
// React.createElement form, so React has to be a global before it loads.
(globalThis as unknown as { React: typeof React }).React = React;
const { ComponentArtwork, BUILTIN_ARTWORK_IDS } = await import(
  '../src/components-library/artwork/componentArtwork'
);

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const defOf = (id: string): ComponentDefinition => COMPONENT_DEFINITIONS.find((d) => d.id === id)!;

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

// =========================== 1. the electrical model is exactly what it was ==
//
// Transcribed from the definitions as they stood at 09e209f, in canvas units
// (4 per millimetre) — the numbers saved projects hold and wires land on.
{
  const expected: Record<string, { size: [number, number]; pins: [string, number, number][] }> = {
    'comp.diode': { size: [10, 3.6], pins: [['anode', 1.6, 7.2], ['cathode', 38.4, 7.2]] },
    'comp.transistor-npn': {
      size: [6, 6],
      pins: [['emitter', 3.2, 22.4], ['base', 12, 22.4], ['collector', 20.8, 22.4]],
    },
    'comp.mosfet': { size: [10, 9], pins: [['gate', 6.8, 34.4], ['drain', 20, 34.4], ['source', 33.2, 34.4]] },
    'comp.speaker': { size: [20, 20], pins: [['plus', 28, 78.4], ['minus', 52, 78.4]] },
    'comp.relay': {
      size: [26, 34],
      pins: [
        ['vcc', 16, 134.4], ['gnd', 32, 134.4], ['in', 48, 134.4],
        ['com', 24, 2.4], ['no', 52, 2.4], ['nc', 80, 2.4],
      ],
    },
    'comp.dc-motor': { size: [25, 20], pins: [['m1', 2.4, 32], ['m2', 2.4, 48]] },
    'comp.stepper': {
      size: [30, 30],
      pins: [['in1', 2.4, 36], ['in2', 2.4, 52], ['in3', 2.4, 68], ['in4', 2.4, 84]],
    },
  };

  for (const [id, want] of Object.entries(expected)) {
    const def = defOf(id);
    check(def !== undefined, `${id} still exists`);
    if (!def) continue;
    check(def.isBoard !== true, `${id} is still a component, not a board`);
    check(
      def.widthMm === want.size[0] && def.heightMm === want.size[1],
      `${id} is still ${want.size[0]}×${want.size[1]} mm (${def.widthMm}×${def.heightMm})`,
    );
    check(def.pins.length === want.pins.length, `${id} still has ${want.pins.length} pins (${def.pins.length})`);
    for (const [pinId, x, y] of want.pins) {
      const pin = def.pins.find((p) => p.id === pinId);
      check(pin !== undefined, `${id}: ${pinId} still exists`);
      check(
        pin?.x === x && pin?.y === y,
        `${id}: ${pinId} anchor is still ${x},${y} (${pin?.x},${pin?.y})`,
      );
    }
  }

  // Polarity and pin ordering are electrical facts the artwork must agree with,
  // not follow from.
  const diode = defOf('comp.diode');
  check(diode.pins[0].type === 'anode' && diode.pins[1].type === 'cathode', 'the diode\'s anode is still first and cathode second');
  check(
    diode.pins[0].x < diode.pins[1].x,
    'and the cathode is still the right-hand pin, which is the end the band is drawn on',
  );
  const bjt = defOf('comp.transistor-npn');
  check(
    bjt.pins.map((p) => p.id).join(',') === 'emitter,base,collector',
    `the transistor's E/B/C order is unchanged (${bjt.pins.map((p) => p.id).join(',')})`,
  );
  const fet = defOf('comp.mosfet');
  check(
    fet.pins.map((p) => p.id).join(',') === 'gate,drain,source',
    `and the MOSFET's G/D/S order (${fet.pins.map((p) => p.id).join(',')})`,
  );
  const relay = defOf('comp.relay');
  check(relay.pins.find((p) => p.id === 'vcc')?.type === 'power-5v', 'the relay\'s VCC is still a 5 V supply pin');
  check(relay.pins.find((p) => p.id === 'gnd')?.type === 'ground', 'its GND is still ground');
  check(relay.pins.find((p) => p.id === 'in')?.capabilities.includes('digital-in'), 'and IN is still a digital input');
}

// ================================= 2. each part now has a renderer of its own =
{
  const ids = ['diode', 'transistor', 'mosfet', 'speaker', 'relay', 'dc-motor', 'stepper'];
  for (const id of ids) {
    check(BUILTIN_ARTWORK_IDS.includes(id), `"${id}" has a dedicated renderer`);
  }
  // And the parts that already had one still do.
  for (const id of ['lcd1602', 'oled', 'led', 'resistor']) {
    check(BUILTIN_ARTWORK_IDS.includes(id), `"${id}" still has its own renderer`);
  }
}

// ======================= 3. the drawing stays inside the part's own box ======
//
// Artwork adapts to the geometry, not the other way round. Anything drawn past
// the box would overlap a neighbouring part on the canvas and would mean the
// hitbox and the picture had diverged.
{
  for (const id of ['comp.diode', 'comp.transistor-npn', 'comp.mosfet', 'comp.speaker', 'comp.relay', 'comp.dc-motor', 'comp.stepper']) {
    const def = defOf(id);
    const w = def.widthMm * 4;
    const h = def.heightMm * 4;
    const svg = render(def, { coilOn: true });
    const coords = [
      ...[...svg.matchAll(/ (?:x|cx|x1|x2)="([-\d.]+)"/g)].map((m) => ({ v: Number(m[1]), axis: 'x' as const })),
      ...[...svg.matchAll(/ (?:y|cy|y1|y2)="([-\d.]+)"/g)].map((m) => ({ v: Number(m[1]), axis: 'y' as const })),
    ];
    const outX = coords.filter((c) => c.axis === 'x' && (c.v < -2 || c.v > w + 2));
    const outY = coords.filter((c) => c.axis === 'y' && (c.v < -2 || c.v > h + 2));
    check(outX.length === 0, `${id}: nothing is drawn outside its width (${outX.map((c) => c.v).join(', ') || 'clean'})`);
    check(outY.length === 0, `${id}: nor outside its height (${outY.map((c) => c.v).join(', ') || 'clean'})`);
    check(svg.length > 200, `${id}: produced real artwork rather than an empty group (${svg.length} chars)`);
    check(!/NaN|Infinity|undefined/.test(svg), `${id}: no NaN, Infinity or undefined reached the SVG`);
  }
}

// ============================ 4. stateful visuals, and only where state is ===
//
// The relay is the one part here the simulation actually reports state for:
// `coilOn` comes from the voltage the circuit binding computes on the IN net.
// Everything else in this group is validation-level, so nothing about it is
// animated — a moving shaft on a motor whose speed is not simulated would be a
// picture of something that is not happening.
{
  const relay = defOf('comp.relay');
  const off = render(relay, { coilOn: false });
  const on = render(relay, { coilOn: true });
  check(off !== on, 'the relay draws differently when its coil is energised');
  check(/COM–NC/.test(off), 'a de-energised relay shows the COM–NC path');
  check(/COM–NO/.test(on), 'and an energised one shows COM–NO');
  check(!/COM–NO/.test(off) && !/COM–NC/.test(on), 'never both at once');
  check(/#ff5f52/.test(on) && !/#ff5f52/.test(off), 'and its coil indicator only lights when the coil is on');

  // Undefined state is not "on". A relay nobody has driven must look idle.
  const unknown = render(relay, {});
  check(unknown === off, 'a relay with no reported state draws as de-energised');

  // The parts with no simulated state must be identical whatever they are told,
  // which is the mechanical guarantee that nothing here is faking activity.
  for (const id of ['comp.dc-motor', 'comp.stepper', 'comp.speaker', 'comp.diode', 'comp.transistor-npn', 'comp.mosfet']) {
    const def = defOf(id);
    const idle = render(def, {});
    const busy = render(def, { coilOn: true, ledOn: true, buzzerOn: true, value: 1, brightness: 1 });
    check(idle === busy, `${id} draws the same whatever state it is handed, because none is simulated for it`);
  }
}

// ================================== 5. the parts are visually distinguishable =
//
// Two motors that render alike would defeat the point of the pass.
{
  const dc = render(defOf('comp.dc-motor'), {});
  const stepper = render(defOf('comp.stepper'), {});
  check(dc !== stepper, 'the DC motor and the stepper are different drawings');
  // The stepper's four winding leads are colour-coded; the DC motor has two
  // plain terminals. That difference is the quickest way to tell them apart.
  const leadColours = ['#c04a4a', '#c9a227', '#d0812c', '#4a7fc0'];
  check(leadColours.every((c) => stepper.includes(c)), 'the stepper shows four distinct winding leads');
  check(!leadColours.some((c) => dc.includes(c)), 'and the DC motor does not');

  const bjt = render(defOf('comp.transistor-npn'), {});
  const fet = render(defOf('comp.mosfet'), {});
  check(bjt !== fet, 'the transistor and the MOSFET are different drawings');
  check(/<path/.test(bjt), 'the transistor is drawn as a rounded TO-92 body');
  check(/>G</.test(fet) && />D</.test(fet) && />S</.test(fet), 'the MOSFET carries G/D/S on its package');
  check(!/>E</.test(bjt), 'the 6 mm transistor does not repeat pin names the canvas already draws');
}

console.log(failures === 0 ? '\nDiscrete-part artwork checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
