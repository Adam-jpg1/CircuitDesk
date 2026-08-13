// Keypads and the mini keyboard, at the level that matters: contacts.
//
// The thing being proved is that pressing a key is an electrical event and
// nothing else. Firmware drives a row low, reads a column, and finds a key —
// the same code that would run on the bench. If any of this passed because a
// character was injected somewhere, none of these assertions would hold.

import { emptyProject } from '../src/project/templates';
import { buildCircuitGraph } from '../src/circuit/nets';
import { CircuitBinding, emptyControls } from '../src/simulation/circuitSim';
import { contactsOf, contactLayoutOf } from '../src/simulation/devices/contactRegistry';
import { contactStateKey, isContactClosed } from '../src/simulation/devices/contacts';
import { matrixKey, KEYPAD_4X4_CAPS, KEYPAD_3X4_CAPS } from '../src/simulation/devices/matrixInput';
import { interactiveHotspots, hotspotAt } from '../src/components-library/artwork/interactiveGeometry';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import type { CircuitProject, ComponentInstance } from '../src/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

let seq = 0;
const uid = (p: string) => `${p}${++seq}`;
const defOf = (id: string) => COMPONENT_DEFINITIONS.find((d) => d.id === id)!;

function instanceOf(definitionId: string, properties: Record<string, unknown> = {}): ComponentInstance {
  return { id: uid('inst'), definitionId, x: 0, y: 0, rotation: 0, properties, simulationState: {} };
}

/** A project with one keypad wired to a Pico's GPIOs, rows then columns. */
function keypadProject(
  definitionId: string,
  rows: number,
  cols: number,
  properties: Record<string, unknown> = {},
): { project: CircuitProject; keypad: ComponentInstance; board: ComponentInstance } {
  const p = emptyProject('keypad');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.raspberry-pi-pico', x: 0, y: 0, rotation: 0,
    properties: {}, simulationState: {},
  };
  const keypad = instanceOf(definitionId, properties);
  p.boardInstances.push(board);
  p.componentInstances.push(keypad);
  const wire = (a: string, ap: string, b: string, bp: string) =>
    p.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#e8590c', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  for (let r = 0; r < rows; r++) wire(board.id, `GP${r}`, keypad.id, `row${r + 1}`);
  for (let c = 0; c < cols; c++) wire(board.id, `GP${8 + c}`, keypad.id, `col${c + 1}`);
  return { project: p, keypad, board };
}

/**
 * Which nets a keypad's row and column pins land on.
 *
 * Continuity is checked at the net level rather than by asking the component
 * — the question is whether two board pins became electrically joined, which
 * is the only thing firmware can observe.
 */
function netsOf(project: CircuitProject, instanceId: string, pinIds: string[]): (string | undefined)[] {
  const graph = buildCircuitGraph(project);
  return pinIds.map((pinId) => graph.netOf.get(`${instanceId}:${pinId}`));
}

/** True when a closed contact path joins these two nets, given pressed keys. */
function joined(
  project: CircuitProject,
  keypadId: string,
  pressed: Set<string>,
  netA: string | undefined,
  netB: string | undefined,
): boolean {
  if (!netA || !netB) return false;
  const keypad = project.componentInstances.find((i) => i.id === keypadId)!;
  const graph = buildCircuitGraph(project);
  // Union-find over closed contacts only.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  for (const contact of contactsOf(keypad.definitionId, keypad)) {
    if (!isContactClosed(pressed, keypadId, contact)) continue;
    const na = graph.netOf.get(`${keypadId}:${contact.a}`);
    const nb = graph.netOf.get(`${keypadId}:${contact.b}`);
    if (na && nb) union(na, nb);
  }
  return find(netA) === find(netB);
}

// ============================================ 1. every key, 4×4 =============
section('1. every key on a 4×4 keypad closes its own row and column');
{
  const { project, keypad } = keypadProject('comp.keypad-4x4', 4, 4);
  const rowNets = netsOf(project, keypad.id, ['row1', 'row2', 'row3', 'row4']);
  const colNets = netsOf(project, keypad.id, ['col1', 'col2', 'col3', 'col4']);

  const contacts = contactsOf('comp.keypad-4x4', keypad);
  check(contacts.length === 16, `a 4×4 keypad has sixteen contacts (${contacts.length})`);
  check(new Set(contacts.map((c) => c.key)).size === 16, 'each with a distinct key');

  let wrongPairs = 0;
  let correctPairs = 0;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const pressed = new Set([contactStateKey(keypad.id, matrixKey(r, c))]);
      // The intended crossing must conduct...
      if (joined(project, keypad.id, pressed, rowNets[r], colNets[c])) correctPairs++;
      // ...and nothing else may.
      for (let r2 = 0; r2 < 4; r2++) {
        for (let c2 = 0; c2 < 4; c2++) {
          if (r2 === r && c2 === c) continue;
          if (joined(project, keypad.id, pressed, rowNets[r2], colNets[c2])) wrongPairs++;
        }
      }
    }
  }
  check(correctPairs === 16, `all sixteen keys close their own crossing (${correctPairs}/16)`);
  check(wrongPairs === 0, `and no key closes another key's crossing (${wrongPairs} wrong)`);

  // Releasing really releases.
  check(!joined(project, keypad.id, new Set(), rowNets[0], colNets[0]), 'with nothing pressed, nothing conducts');

  // The legends are the ones printed on a real keypad.
  const layout = contactLayoutOf('comp.keypad-4x4', keypad)!;
  check(layout.keys.map((k) => k.cap).join('') === KEYPAD_4X4_CAPS.join(''), 'the legend matches a standard 4×4 keypad');
}

// ============================================ 2. 3×4 keypad ================
section('2. the 3×4 keypad is three columns, not four');
{
  const { project, keypad } = keypadProject('comp.keypad-3x4', 4, 3);
  const contacts = contactsOf('comp.keypad-3x4', keypad);
  check(contacts.length === 12, `twelve contacts (${contacts.length})`);
  const layout = contactLayoutOf('comp.keypad-3x4', keypad)!;
  check(layout.rows === 4 && layout.cols === 3, `four rows by three columns (${layout.rows}×${layout.cols})`);
  check(layout.keys.map((k) => k.cap).join('') === KEYPAD_3X4_CAPS.join(''), 'with the 1-9 * 0 # legend');

  const rowNets = netsOf(project, keypad.id, ['row1', 'row2', 'row3', 'row4']);
  const colNets = netsOf(project, keypad.id, ['col1', 'col2', 'col3']);
  // '5' is row 1, column 1 on this layout.
  const five = new Set([contactStateKey(keypad.id, matrixKey(1, 1))]);
  check(joined(project, keypad.id, five, rowNets[1], colNets[1]), "pressing '5' joins row 2 to column 2");
  check(!joined(project, keypad.id, five, rowNets[0], colNets[1]), 'and leaves row 1 alone');
  check(!joined(project, keypad.id, five, rowNets[1], colNets[0]), 'and column 1 alone');
  check(defOf('comp.keypad-3x4').pins.length === 7, `seven pins — four rows and three columns (${defOf('comp.keypad-3x4').pins.length})`);
}

// ================================== 3. several keys at once ================
section('3. multiple keys held together');
{
  const { project, keypad } = keypadProject('comp.keypad-4x4', 4, 4);
  const rowNets = netsOf(project, keypad.id, ['row1', 'row2', 'row3', 'row4']);
  const colNets = netsOf(project, keypad.id, ['col1', 'col2', 'col3', 'col4']);

  // Two keys on different rows and columns: both conduct, independently.
  const two = new Set([
    contactStateKey(keypad.id, matrixKey(0, 0)),
    contactStateKey(keypad.id, matrixKey(2, 3)),
  ]);
  check(joined(project, keypad.id, two, rowNets[0], colNets[0]), 'the first of two held keys conducts');
  check(joined(project, keypad.id, two, rowNets[2], colNets[3]), 'and so does the second');
  check(!joined(project, keypad.id, two, rowNets[0], colNets[3]), 'without joining the two crossings');

  // Releasing one leaves the other held.
  const one = new Set([contactStateKey(keypad.id, matrixKey(2, 3))]);
  check(!joined(project, keypad.id, one, rowNets[0], colNets[0]), 'releasing one key opens that contact');
  check(joined(project, keypad.id, one, rowNets[2], colNets[3]), 'and leaves the other still closed');

  // Three keys in an L really do produce a phantom fourth. This is what a
  // matrix without diodes does, and firmware has to cope with it — so the
  // model must reproduce it rather than quietly preventing it.
  const ghost = new Set([
    contactStateKey(keypad.id, matrixKey(0, 0)),
    contactStateKey(keypad.id, matrixKey(0, 1)),
    contactStateKey(keypad.id, matrixKey(1, 0)),
  ]);
  check(
    joined(project, keypad.id, ghost, rowNets[1], colNets[1]),
    'three keys in an L short a fourth crossing, exactly as real hardware ghosts',
  );
}

// ================================= 4. configurable matrix ==================
section('4. the configurable keypad honours its size');
{
  const { project, keypad } = keypadProject('comp.keypad-matrix', 2, 5, { rows: 2, cols: 5 });
  const contacts = contactsOf('comp.keypad-matrix', keypad);
  check(contacts.length === 10, `a 2×5 configuration has ten contacts (${contacts.length})`);
  const layout = contactLayoutOf('comp.keypad-matrix', keypad)!;
  check(layout.rows === 2 && layout.cols === 5, `laid out 2×5 (${layout.rows}×${layout.cols})`);

  const rowNets = netsOf(project, keypad.id, ['row1', 'row2']);
  const colNets = netsOf(project, keypad.id, ['col1', 'col2', 'col3', 'col4', 'col5']);
  const last = new Set([contactStateKey(keypad.id, matrixKey(1, 4))]);
  check(joined(project, keypad.id, last, rowNets[1], colNets[4]), 'the far corner key conducts');
  check(!joined(project, keypad.id, last, rowNets[0], colNets[4]), 'and only that one');

  // Nonsense sizes are clamped rather than producing a broken part.
  const wild = instanceOf('comp.keypad-matrix', { rows: 99, cols: -3 });
  const wildLayout = contactLayoutOf('comp.keypad-matrix', wild)!;
  check(wildLayout.rows <= 8 && wildLayout.cols >= 1, `absurd sizes are clamped (${wildLayout.rows}×${wildLayout.cols})`);
}

// ================================== 5. the mini keyboard ===================
section('5. the mini keyboard is a real 5×10 matrix');
{
  const { project, keypad } = keypadProject('comp.mini-keyboard', 5, 10);
  const contacts = contactsOf('comp.mini-keyboard', keypad);
  check(contacts.length === 50, `fifty keys (${contacts.length})`);
  const def = defOf('comp.mini-keyboard');
  check(def.pins.length === 15, `fifteen pins — five rows and ten columns (${def.pins.length})`);
  check(def.pins.filter((p) => p.id.startsWith('row')).length === 5, 'five row pins');
  check(def.pins.filter((p) => p.id.startsWith('col')).length === 10, 'ten column pins');

  const rowNets = netsOf(project, keypad.id, ['row1', 'row2', 'row3', 'row4', 'row5']);
  const colNets = netsOf(project, keypad.id, Array.from({ length: 10 }, (_, i) => `col${i + 1}`));

  // 'Q' is the first key of the second row.
  const q = new Set([contactStateKey(keypad.id, matrixKey(1, 0))]);
  check(joined(project, keypad.id, q, rowNets[1], colNets[0]), "pressing 'Q' joins row 2 to column 1");
  check(!joined(project, keypad.id, q, rowNets[0], colNets[0]), 'and not row 1');

  // Typing two letters together — shift plus a key — is two closed contacts.
  const shifted = new Set([
    contactStateKey(keypad.id, matrixKey(4, 0)), // shift
    contactStateKey(keypad.id, matrixKey(1, 0)), // Q
  ]);
  check(
    joined(project, keypad.id, shifted, rowNets[4], colNets[0]) &&
      joined(project, keypad.id, shifted, rowNets[1], colNets[0]),
    'a modifier and a letter are two independent closures',
  );

  // No part of this device produces characters. That is the whole point, and
  // the part says so rather than leaving a user to discover it.
  const src = def.description ?? '';
  check(/matrix/i.test(src), 'the part describes itself as a matrix');
  check(/no controller, no USB/i.test(src), 'and states plainly that it is not a USB keyboard');
  check(
    contactsOf('comp.mini-keyboard', keypad).every((c) => c.a.startsWith('row') && c.b.startsWith('col')),
    'every contact is a row-to-column crossing and nothing else',
  );
}

// ============================= 6. the solver sees the contacts =============
section('6. contacts reach the circuit solver as real edges');
{
  const { project, keypad } = keypadProject('comp.keypad-4x4', 4, 4);
  const binding = new CircuitBinding(project, null);
  const controls = emptyControls();

  // Nothing pressed: no continuity anywhere.
  const before = binding.update(controls);
  check(before.netLevels instanceof Map, 'the binding evaluates with a keypad present');

  // The binding must have built one switch edge per key.
  const edges = (binding as unknown as { edges: { kind: string }[] }).edges;
  const switches = edges.filter((e) => e.kind === 'switch');
  check(switches.length === 16, `sixteen switch edges reached the solver (${switches.length})`);
}

// ============================ 7. hit-testing matches the artwork ===========
section('7. the key you click is the key that closes');
{
  const keypad = instanceOf('comp.keypad-4x4');
  const def = defOf('comp.keypad-4x4');
  const spots = interactiveHotspots(def, keypad);
  check(spots.length === 16, `sixteen clickable keys (${spots.length})`);
  check(spots.every((s) => s.kind === 'momentary'), 'all momentary — a membrane key springs back');

  // Every hotspot's own centre must resolve to itself.
  let mismatches = 0;
  for (const s of spots) {
    const hit = hotspotAt(def, keypad, s.x + s.w / 2, s.y + s.h / 2);
    if (hit?.key !== s.key) mismatches++;
  }
  check(mismatches === 0, `every key's centre hit-tests to itself (${mismatches} mismatches)`);

  // Keys must not overlap, or a click would be ambiguous.
  let overlaps = 0;
  for (let i = 0; i < spots.length; i++) {
    for (let j = i + 1; j < spots.length; j++) {
      const a = spots[i];
      const b = spots[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps++;
    }
  }
  check(overlaps === 0, `no two keys overlap (${overlaps})`);

  // Every key must be inside the part, above the pin header.
  const W = def.widthMm * 4;
  const H = def.heightMm * 4;
  const outside = spots.filter((s) => s.x < 0 || s.y < 0 || s.x + s.w > W || s.y + s.h > H);
  check(outside.length === 0, `every key is within the part's outline (${outside.length} outside)`);

  // And a click on the bezel is not a key.
  check(hotspotAt(def, keypad, 1, 1) === null, 'clicking the bezel presses nothing');
}

// ============================ 8. two keypads stay independent ==============
section('8. two keypads on one canvas are independent');
{
  const p = emptyProject('two-keypads');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.raspberry-pi-pico', x: 0, y: 0, rotation: 0,
    properties: {}, simulationState: {},
  };
  const k1 = instanceOf('comp.keypad-4x4');
  const k2 = instanceOf('comp.keypad-4x4');
  p.boardInstances.push(board);
  p.componentInstances.push(k1, k2);
  const wire = (a: string, ap: string, b: string, bp: string) =>
    p.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#e8590c', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  for (let r = 0; r < 4; r++) {
    wire(board.id, `GP${r}`, k1.id, `row${r + 1}`);
    wire(board.id, `GP${10 + r}`, k2.id, `row${r + 1}`);
  }
  for (let c = 0; c < 4; c++) {
    wire(board.id, `GP${4 + c}`, k1.id, `col${c + 1}`);
    wire(board.id, `GP${16 + c}`, k2.id, `col${c + 1}`);
  }

  const rows1 = netsOf(p, k1.id, ['row1']);
  const cols1 = netsOf(p, k1.id, ['col1']);
  const rows2 = netsOf(p, k2.id, ['row1']);
  const cols2 = netsOf(p, k2.id, ['col1']);

  // Pressing the same position on the first keypad must not close it on the
  // second — the contact key is scoped by instance, not by grid position.
  const pressFirst = new Set([contactStateKey(k1.id, matrixKey(0, 0))]);
  check(joined(p, k1.id, pressFirst, rows1[0], cols1[0]), "the first keypad's key closes");
  check(!joined(p, k2.id, pressFirst, rows2[0], cols2[0]), 'and the identical key on the second does not');

  const pressSecond = new Set([contactStateKey(k2.id, matrixKey(0, 0))]);
  check(joined(p, k2.id, pressSecond, rows2[0], cols2[0]), 'pressing the second keypad closes its own key');
  check(!joined(p, k1.id, pressSecond, rows1[0], cols1[0]), 'and leaves the first alone');
}

console.log(failures === 0 ? '\nKeypad checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
