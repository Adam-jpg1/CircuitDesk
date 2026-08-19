// The board CircuitDesk draws when nobody gave it a picture.
//
// This is the first thing a person sees after importing their own board, and
// it is drawn entirely from facts the board already carries: its outline, its
// colour, its pin labels, and the chip it named. What makes it hard is that
// those facts vary enormously — a 22 mm breakout with three pins a side and a
// 68 mm controller with eight are the same code path — and the failure mode is
// a silkscreen that reads as a mess: a package sitting on somebody's pin
// names, or a board title printed through its own labels.
//
// So the rule is that the LABELS win. They are what the maker printed and the
// whole reason the board looks like theirs. Every decoration gives way to
// them, and a decoration with no room is not drawn at all rather than drawn
// badly. These are the geometry checks for that.

import { generatedBoardLayout } from '../src/boards/artwork/CustomBoardArtwork';
import { resolveCustomBoard } from '../src/custom-boards/resolve';
import { CUSTOM_BOARD_SCHEMA_VERSION, type CustomBoardDefinition, type CustomBoardPin } from '../src/custom-boards/schema';
import { UNITS_PER_MM } from '../src/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

const pin = (
  id: string, label: string, pad: string | null, xMm: number, yMm: number,
  type: CustomBoardPin['type'] = 'digital',
): CustomBoardPin => ({ id, label, pad, xMm, yMm, type, capabilities: [] });

const board = (over: Partial<CustomBoardDefinition>): CustomBoardDefinition => ({
  schemaVersion: CUSTOM_BOARD_SCHEMA_VERSION,
  id: 'custom.shot',
  revision: 1,
  identity: { name: 'Board' },
  outline: { widthMm: 34, heightMm: 52 },
  pins: [pin('A', 'A', 'GP0', 3, 5)],
  processorProfileId: 'proc.rp2040',
  compileProfileId: 'compile.rp2040-arduino',
  runtimeProfileId: 'runtime.rp2040js',
  ...over,
});

const layoutOf = (d: CustomBoardDefinition) => generatedBoardLayout(resolveCustomBoard(d).board);

/** Where a pin's label starts and ends, in the units the layout works in. */
function labelSpan(d: CustomBoardDefinition, pinId: string) {
  const { board: resolved } = resolveCustomBoard(d);
  const layout = generatedBoardLayout(resolved);
  const p = resolved.pins.find((x) => x.id === pinId)!;
  const W = resolved.widthMm * UNITS_PER_MM;
  const onLeft = p.x < W / 2;
  const width = p.label.length * layout.LABEL_SIZE * 0.62;
  const start = p.x + (onLeft ? 3.4 * UNITS_PER_MM : -3.4 * UNITS_PER_MM);
  return onLeft ? { from: start, to: start + width, y: p.y } : { from: start - width, to: start, y: p.y };
}

// =========================== 1. a narrow board with long labels =============
section('1. a tall board whose labels leave no room in the middle');
{
  const tall = board({
    identity: { name: 'Orchard Node' },
    outline: { widthMm: 34, heightMm: 52 },
    pins: [
      pin('BATT', 'BATT', null, 3, 5, 'power-5v'),
      pin('GND', 'GND', null, 3, 10, 'ground'),
      pin('VALVE', 'VALVE', 'GP15', 3, 15),
      pin('AUX', 'AUX', 'GP17', 3, 20),
      pin('PROBE_SDA', 'PROBE_SDA', 'GP4', 31, 15),
      pin('MOISTURE', 'MOISTURE', 'GP26', 31, 20, 'analog'),
    ],
  });
  const layout = layoutOf(tall);
  check(layout.showChip, 'the chip is drawn');
  check(!layout.inMiddle, 'but not between the headers, because the labels are there');

  // The decisive check: no label may overlap the package.
  for (const id of ['PROBE_SDA', 'MOISTURE', 'VALVE', 'BATT']) {
    const span = labelSpan(tall, id);
    const overlapsX = span.to > layout.chipX && span.from < layout.chipX + layout.chipW;
    const overlapsY = span.y > layout.chipY - 5 && span.y < layout.chipY + layout.chipH + 5;
    check(!(overlapsX && overlapsY), `${id}'s label does not sit on the package`);
  }
  check(layout.showName, 'and there is room for the board name below everything');
}

// ============================ 2. a wide board with room to spare ============
section('2. a wide board puts the package where a real board would');
{
  const wide = board({
    identity: { name: 'Gantry Controller' },
    outline: { widthMm: 68, heightMm: 52 },
    pins: [
      pin('V5', '5V', null, 3, 6, 'power-5v'),
      pin('STEP_X', 'STEP_X', 'GP2', 3, 12),
      pin('STEP_Y', 'STEP_Y', 'GP3', 3, 18),
      pin('DIR_X', 'DIR_X', 'GP4', 65, 6),
      pin('PROBE', 'PROBE', 'GP26', 65, 12, 'analog'),
      pin('LIMIT', 'LIMIT', 'GP6', 65, 18),
    ],
  });
  const layout = layoutOf(wide);
  check(layout.inMiddle, 'the package sits between the two headers');
  check(layout.showChip, 'and is big enough to be worth drawing');
  check(layout.chipX >= layout.labelRight, 'starting clear of the left labels');
  check(layout.chipX + layout.chipW <= layout.labelLeft, 'and ending clear of the right ones');
  for (const id of ['STEP_X', 'PROBE', 'LIMIT']) {
    const span = labelSpan(wide, id);
    check(
      !(span.to > layout.chipX && span.from < layout.chipX + layout.chipW),
      `${id}'s label does not reach the package`,
    );
  }
}

// =========================== 3. a board too small for decoration ============
section('3. a small board draws its pins and nothing it has no room for');
{
  const tiny = board({
    identity: { name: 'Thermocouple Breakout' },
    outline: { widthMm: 22, heightMm: 18 },
    pins: [
      pin('V3', '3V3', null, 3, 4, 'power-3v3'),
      pin('GND', 'GND', null, 3, 9, 'ground'),
      pin('SO', 'SO', null, 3, 14),
      pin('CS', 'CS', null, 19, 4),
      pin('SCK', 'SCK', null, 19, 9),
    ],
    processorProfileId: null,
    compileProfileId: 'compile.none',
    runtimeProfileId: 'runtime.none',
  });
  const layout = layoutOf(tiny);
  check(!layout.showChip, 'a board with no chip shows no package — drawing one would be a claim');
  check(
    !layout.showName,
    'and its name is not printed through its own pin labels, because there is nowhere to put it',
  );
  check(!layout.showWiringOnly, 'nor is "wiring only" stamped across them');
}

// ================== 4. a board with no chip, and room to say so =============
section('4. a bigger board with no chip says so where it can be read');
{
  const roomy = board({
    identity: { name: 'Prototyping Header' },
    outline: { widthMm: 60, heightMm: 46 },
    pins: [
      pin('V5', '5V', null, 3, 6, 'power-5v'),
      pin('GND', 'GND', null, 3, 12, 'ground'),
      pin('P1', 'P1', null, 57, 6),
      pin('P2', 'P2', null, 57, 12),
    ],
    processorProfileId: null,
    compileProfileId: 'compile.none',
    runtimeProfileId: 'runtime.none',
  });
  const layout = layoutOf(roomy);
  check(!layout.showChip, 'still no package, because there is still no chip');
  check(layout.showWiringOnly, 'but it says "wiring only" now that there is space for it');
  check(layout.showName, 'and prints its name');
}

// ====================== 5. artwork replaces all of it =======================
section('5. a board that brought its own picture gets its own picture');
{
  const withArt = board({
    outline: {
      widthMm: 34,
      heightMm: 52,
      artworkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 52"><rect width="34" height="52"/></svg>',
    },
  });
  const { board: resolved } = resolveCustomBoard(withArt);
  check(resolved.artwork.kind === 'svg', 'the artwork is the board\'s own');
  // The generated layout is simply not used in that case — asserted here so a
  // refactor cannot start drawing a chip package on top of somebody's PCB
  // photograph.
  const source = await import('node:fs').then((fs) => fs.readFileSync('src/boards/artwork/CustomBoardArtwork.tsx', 'utf8'));
  const artworkBranch = source.slice(source.indexOf('if (svg)'), source.indexOf('// No artwork'));
  check(!/generatedBoardLayout|chipX|showName/.test(artworkBranch), 'and nothing generated is drawn over it');
}

console.log(failures === 0 ? '\nGenerated board artwork checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
