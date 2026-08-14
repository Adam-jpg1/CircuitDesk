// Review sheets: the whole library, drawn at the zoom people actually work at.
//
// Every automated artwork test in this repo answers "did it render". None of
// them answers "can you tell what it is", and that question only has a meaning
// at a particular size. The canvas opens at zoom 1, one world unit to one CSS
// pixel, so that is exactly what this page uses — no scaling anywhere, so a
// screenshot of it is pixel-for-pixel what the editor shows.
//
// It renders the real `ComponentArtwork` and the real board artwork over the
// real canvas grid, with the real pin markers on top, because a part that looks
// fine on white and disappears against the grid is not fine.
//
// Not part of the app: nothing in src/ imports this, and the production build
// has one entry (index.html), so this never ships. It is a bench instrument.

import { createRoot } from 'react-dom/client';
import { COMPONENT_DEFINITIONS } from '../../src/components-library/definitions';
import { BOARD_DEFINITIONS } from '../../src/boards/definitions';
import { ComponentArtwork } from '../../src/components-library/artwork/componentArtwork';
import { UnoArtwork } from '../../src/boards/artwork/UnoArtwork';
import { MegaArtwork } from '../../src/boards/artwork/MegaArtwork';
import { LeonardoArtwork } from '../../src/boards/artwork/LeonardoArtwork';
import { GenericModuleArtwork } from '../../src/boards/artwork/GenericModuleArtwork';
import { activeState } from './states';
import type { ComponentDefinition, ComponentInstance, PartDefinition } from '../../src/types';

// Copied deliberately rather than exported from the canvas: this file must not
// be able to change how the editor draws pins in order to make a sheet look
// better. If these drift, the sheet stops matching and that is the signal.
const PIN_FILL: Record<string, string> = {
  'power-5v': '#f85149',
  'power-vin': '#f85149',
  'power-3v3': '#d29922',
  ground: '#6b7885',
  analog: '#3fb950',
  digital: '#3d9df2',
  reset: '#a8b3bf',
  aref: '#a8b3bf',
};
const PIN_FILL_DEFAULT = '#8b98a5';

const defOf = (id: string) => COMPONENT_DEFINITIONS.find((d) => d.id === id);
const boardOf = (id: string) => BOARD_DEFINITIONS.find((d) => d.id === id);

let n = 0;
function instanceOf(def: PartDefinition, properties: Record<string, unknown> = {}): ComponentInstance {
  return {
    id: `rev${++n}`,
    definitionId: def.id,
    x: 0,
    y: 0,
    rotation: 0,
    properties: Object.fromEntries([
      ...(def.properties ?? []).map((p) => [p.key, p.default]),
      ...Object.entries(properties),
    ]),
    simulationState: {},
  };
}

function BoardArt({ def }: { def: PartDefinition }) {
  switch (def.artwork.builtinId) {
    case 'arduino-uno':
      return <UnoArtwork def={def} />;
    case 'arduino-mega':
      return <MegaArtwork def={def} />;
    case 'arduino-leonardo':
      return <LeonardoArtwork def={def} />;
    default:
      return <GenericModuleArtwork def={def} />;
  }
}

/** One part, drawn exactly as the canvas draws it at zoom 1. */
function Part({
  def,
  properties,
  live,
  x,
  y,
}: {
  def: PartDefinition;
  properties?: Record<string, unknown>;
  live: boolean;
  x: number;
  y: number;
}) {
  const inst = instanceOf(def, properties);
  const visual = live ? activeState(def.id) : undefined;
  const pinRadius = def.isBoard ? 3.6 : 3.1;
  return (
    <g transform={`translate(${x} ${y})`}>
      {def.isBoard ? (
        <BoardArt def={def} />
      ) : (
        <ComponentArtwork def={def as ComponentDefinition} instance={inst} visual={visual} />
      )}
      {def.pins.map((pin) => (
        <g key={pin.id}>
          <circle cx={pin.x} cy={pin.y} r={pinRadius} fill="rgba(0,0,0,0.5)" />
          <circle
            cx={pin.x}
            cy={pin.y}
            r={pinRadius - 0.9}
            fill={PIN_FILL[pin.type] ?? PIN_FILL_DEFAULT}
            stroke="#e6ebf1"
            strokeWidth={0.7}
          />
        </g>
      ))}
    </g>
  );
}

interface Cell {
  def: PartDefinition;
  properties?: Record<string, unknown>;
  label: string;
  /** Draw the part twice, idle then live, when it has a state worth seeing. */
  pair: boolean;
}

const CAPTION_H = 18;
const GAP = 26;
const PAIR_GAP = 14;

/** Shelf packing, biggest-first inside a row, at true size. */
function Sheet({ title, cells, width }: { title: string; cells: Cell[]; width: number }) {
  const placed: { cell: Cell; x: number; y: number; w: number; h: number }[] = [];
  let cursorX = GAP;
  let cursorY = 54;
  let shelfH = 0;
  for (const cell of cells) {
    const one = cell.def.widthMm * 4;
    const art = cell.pair ? one * 2 + PAIR_GAP : one;
    // Small parts have captions wider than they are, and captions that run into
    // each other make the sheet unreadable for the one job it has.
    const caption = (cell.label.length + (cell.pair ? 14 : 0)) * 5.6;
    const w = Math.max(art, caption);
    const h = cell.def.heightMm * 4 + CAPTION_H;
    if (cursorX + w > width - GAP && cursorX > GAP) {
      cursorX = GAP;
      cursorY += shelfH + GAP;
      shelfH = 0;
    }
    placed.push({ cell, x: cursorX, y: cursorY, w, h });
    cursorX += w + GAP;
    shelfH = Math.max(shelfH, h);
  }
  const height = cursorY + shelfH + GAP;

  return (
    <svg width={width} height={height} style={{ display: 'block', background: '#0d1117' }}>
      <defs>
        <pattern id="grid" width="25" height="25" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="#232d3a" />
        </pattern>
        <pattern id="grid-major" width="125" height="125" patternUnits="userSpaceOnUse">
          <rect width="125" height="125" fill="url(#grid)" />
          <circle cx="1" cy="1" r="1.6" fill="#2e3b4b" />
        </pattern>
      </defs>
      <rect width={width} height={height} fill="url(#grid-major)" />
      <text x={GAP} y={34} fontSize="20" fill="#e6ebf1" fontFamily="sans-serif" fontWeight="600">
        {title}
        <tspan fill="#6b7885" fontWeight="400" fontSize="14">
          {'   '}zoom 1.0 — actual size
        </tspan>
      </text>
      {placed.map(({ cell, x, y }, i) => {
        const one = cell.def.widthMm * 4;
        return (
          <g key={i}>
            <Part def={cell.def} properties={cell.properties} live={!cell.pair} x={x} y={y} />
            {cell.pair && <Part def={cell.def} properties={cell.properties} live x={x + one + PAIR_GAP} y={y} />}
            <text
              x={x}
              y={y + cell.def.heightMm * 4 + 13}
              fontSize="11"
              fill="#8b98a5"
              fontFamily="sans-serif"
            >
              {cell.label}
              {cell.pair ? '  ·  idle | live' : ''}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const cellsFor = (ids: string[]): Cell[] =>
  ids
    .map((id) => defOf(id))
    .filter((d): d is ComponentDefinition => Boolean(d))
    .map((def) => ({ def, label: def.name, pair: activeState(def.id) !== undefined }));

const inCategory = (...cats: string[]) =>
  COMPONENT_DEFINITIONS.filter((d) => cats.includes(d.category)).map((d) => d.id);

const SHEETS: Record<string, { title: string; cells: Cell[]; width: number }> = {
  inputs: {
    title: '1 · Inputs',
    width: 1500,
    cells: [
      ...cellsFor(inCategory('Input', 'Inputs')),
      ...cellsFor(['comp.keypad-3x4', 'comp.keypad-4x4']),
      // The configurable keypad at a size that is not one of the fixed two, so
      // the layout code is actually exercised rather than coincidentally right.
      ...cellsFor(['comp.keypad-matrix']).map((c) => ({ ...c, properties: { rows: 5, cols: 3 }, label: `${c.label} (5×3)` })),
      ...cellsFor(['comp.mini-keyboard']),
    ],
  },
  sensors: { title: '2 · Sensors', width: 1500, cells: cellsFor(inCategory('Sensors')) },
  displays: {
    title: '3 · Displays + LEDs',
    width: 1700,
    cells: cellsFor([...inCategory('Displays'), ...inCategory('LEDs'), 'comp.led', 'comp.rgb-led']),
  },
  motors: {
    title: '4 · Motors + actuators',
    width: 1500,
    cells: cellsFor([...inCategory('Motors'), 'comp.buzzer', 'comp.speaker']),
  },
  communication: {
    title: '5 · Communication',
    width: 1500,
    cells: cellsFor([
      'comp.gps', 'comp.hc05', 'comp.esp01', 'comp.dfplayer', 'comp.ir-receiver', 'comp.ir-led',
      'comp.ir-remote', 'comp.nrf24l01', 'comp.lora-sx1278', 'comp.rf433-tx', 'comp.rf433-rx',
      'comp.max485', 'comp.mcp2515', 'comp.sd-card', 'comp.ds3231',
    ]),
  },
  logic: {
    title: '6 · Logic + storage',
    width: 1500,
    cells: cellsFor([...inCategory('Logic'), ...inCategory('ICs'), ...inCategory('Memory')]),
  },
  power: {
    title: '7 · Power + basics',
    width: 1500,
    cells: cellsFor([...inCategory('Power'), ...inCategory('Basic'), ...inCategory('Connectors'), ...inCategory('Breadboards')]),
  },
};

/**
 * The showcase: a plausible bench, not a catalogue.
 *
 * Placed by hand rather than packed, because the question it answers is whether
 * a workspace full of these parts looks like a polished tool — and a grid of
 * evenly spaced rectangles would answer a different, easier question.
 */
function Showcase() {
  const W = 2200;
  const H = 1500;
  type Item = { id: string; x: number; y: number; board?: boolean; props?: Record<string, unknown> };
  const items: Item[] = [
    // boards along the spine
    { id: 'board.arduino-uno', x: 60, y: 120, board: true },
    { id: 'board.raspberry-pi-pico', x: 430, y: 130, board: true },
    { id: 'board.esp32-c6-devkitc-1', x: 560, y: 130, board: true },
    // input cluster, top left
    { id: 'comp.mini-keyboard', x: 60, y: 400 },
    { id: 'comp.keypad-4x4', x: 60, y: 660 },
    { id: 'comp.joystick', x: 290, y: 660 },
    { id: 'comp.rotary-encoder', x: 430, y: 660 },
    { id: 'comp.push-button-6mm', x: 560, y: 660 },
    { id: 'comp.dip-switch-8', x: 560, y: 730 },
    // displays down the middle
    { id: 'comp.lcd1602', x: 740, y: 120 },
    { id: 'comp.oled', x: 1090, y: 120 },
    { id: 'comp.ili9341', x: 1260, y: 120 },
    { id: 'comp.gc9a01', x: 1490, y: 120 },
    { id: 'comp.epaper29', x: 1710, y: 120 },
    { id: 'comp.st7789', x: 1940, y: 120 },
    { id: 'comp.seven-segment-4', x: 740, y: 300 },
    { id: 'comp.neopixel-ring', x: 920, y: 300 },
    { id: 'comp.led-matrix', x: 1130, y: 300 },
    { id: 'comp.neopixel-strip', x: 1290, y: 300 },
    // sensors
    { id: 'comp.ultrasonic', x: 740, y: 500 },
    { id: 'comp.bme280', x: 950, y: 500 },
    { id: 'comp.mpu6050', x: 1080, y: 500 },
    { id: 'comp.ldr', x: 1210, y: 500 },
    // radios and buses
    { id: 'comp.gps', x: 740, y: 650 },
    { id: 'comp.nrf24l01', x: 900, y: 650 },
    { id: 'comp.lora-sx1278', x: 1040, y: 650 },
    { id: 'comp.max485', x: 1200, y: 650 },
    { id: 'comp.mcp2515', x: 1330, y: 650 },
    { id: 'comp.sd-card', x: 1520, y: 650 },
    { id: 'comp.hc05', x: 1680, y: 650 },
    // motion, bottom
    { id: 'comp.servo', x: 740, y: 830 },
    { id: 'comp.dc-motor', x: 900, y: 830 },
    { id: 'comp.stepper', x: 1060, y: 830 },
    { id: 'comp.a4988', x: 1250, y: 830 },
    { id: 'comp.relay', x: 1400, y: 830 },
    { id: 'comp.solenoid', x: 1560, y: 830 },
    // logic + power, bottom band
    { id: 'comp.hc595', x: 740, y: 1030 },
    { id: 'comp.gate-nand', x: 880, y: 1030 },
    { id: 'comp.74hc138', x: 1010, y: 1030 },
    { id: 'comp.dc-supply', x: 1180, y: 1030 },
    { id: 'comp.battery-aa', x: 1360, y: 1030 },
    { id: 'comp.buck-converter', x: 1520, y: 1030 },
    { id: 'comp.regulator-5', x: 1680, y: 1030 },
    { id: 'comp.breadboard-half', x: 60, y: 900 },
    { id: 'comp.resistor', x: 60, y: 1180 },
    { id: 'comp.led', x: 160, y: 1180 },
    { id: 'comp.capacitor', x: 230, y: 1180 },
    { id: 'comp.buzzer', x: 310, y: 1180 },
  ];

  return (
    <svg width={W} height={H} style={{ display: 'block', background: '#0d1117' }}>
      <defs>
        <pattern id="grid" width="25" height="25" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="#232d3a" />
        </pattern>
        <pattern id="grid-major" width="125" height="125" patternUnits="userSpaceOnUse">
          <rect width="125" height="125" fill="url(#grid)" />
          <circle cx="1" cy="1" r="1.6" fill="#2e3b4b" />
        </pattern>
      </defs>
      <rect width={W} height={H} fill="url(#grid-major)" />
      <text x={40} y={44} fontSize="22" fill="#e6ebf1" fontFamily="sans-serif" fontWeight="600">
        Showcase workspace
        <tspan fill="#6b7885" fontWeight="400" fontSize="14">
          {'   '}zoom 1.0 — actual size, simulation running
        </tspan>
      </text>
      {items.map((it, i) => {
        const def = it.board ? boardOf(it.id) : defOf(it.id);
        if (!def) return <text key={i} x={it.x} y={it.y} fill="#f85149" fontSize="12">missing {it.id}</text>;
        return <Part key={i} def={def} properties={it.props} live x={it.x} y={it.y} />;
      })}
    </svg>
  );
}

const params = new URLSearchParams(location.search);
const which = params.get('sheet') ?? 'inputs';
const root = createRoot(document.getElementById('sheet')!);
const only = params.get('parts');
if (only) {
  // A close look at a handful of parts, still at 1:1 — fewer pixels in frame,
  // not bigger ones, so what is judged here is what the editor draws.
  root.render(
    <Sheet
      title={params.get('title') ?? 'Detail'}
      width={Number(params.get('width') ?? 760)}
      cells={cellsFor(only.split(','))}
    />,
  );
} else if (which === 'showcase') {
  root.render(<Showcase />);
} else {
  const sheet = SHEETS[which];
  root.render(sheet ? <Sheet {...sheet} /> : <div style={{ color: '#f85149' }}>no sheet {which}</div>);
}
