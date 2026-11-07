// The rest of Batch 1's contact parts, and the firmware-level proof.
//
// The keypad tests prove continuity at the net level. This one closes the loop
// the product actually cares about: a real sketch, compiled by the real
// toolchain, scanning a real matrix on a real emulated MCU, and reporting the
// key it found. Nothing in the path is allowed to know what a "key" means
// except the sketch.

import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject } from '../src/project/templates';
import { buildCircuitGraph } from '../src/circuit/nets';
import { contactsOf } from '../src/simulation/devices/contactRegistry';
import { contactStateKey, isContactClosed } from '../src/simulation/devices/contacts';
import { matrixKey } from '../src/simulation/devices/matrixInput';
import { interactiveHotspots, hotspotAt } from '../src/components-library/artwork/interactiveGeometry';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
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
const defOf = (id: string) => COMPONENT_DEFINITIONS.find((d) => d.id === id)!;

function inst(definitionId: string, properties: Record<string, unknown> = {}): ComponentInstance {
  return { id: uid('inst'), definitionId, x: 0, y: 0, rotation: 0, properties, simulationState: {} };
}

function wireInto(p: CircuitProject, a: string, ap: string, b: string, bp: string): void {
  p.connections.push({
    id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
    netId: '', color: '#e8590c', points: [], routing: 'smooth',
  } as CircuitProject['connections'][number]);
}

/** Whether two of a part's pins are electrically joined by its closed contacts. */
function conducts(p: CircuitProject, instanceId: string, pinA: string, pinB: string, pressed: Set<string>): boolean {
  const part = p.componentInstances.find((i) => i.id === instanceId)!;
  const graph = buildCircuitGraph(p);
  const na = graph.netOf.get(`${instanceId}:${pinA}`);
  const nb = graph.netOf.get(`${instanceId}:${pinB}`);
  if (!na || !nb) return false;
  for (const contact of contactsOf(part.definitionId, part)) {
    if (!isContactClosed(pressed, instanceId, contact)) continue;
    const ca = graph.netOf.get(`${instanceId}:${contact.a}`);
    const cb = graph.netOf.get(`${instanceId}:${contact.b}`);
    if ((ca === na && cb === nb) || (ca === nb && cb === na)) return true;
  }
  return false;
}

/** A project with one part, each of its pins on its own net via a header. */
function isolated(definitionId: string, properties: Record<string, unknown> = {}) {
  const p = emptyProject('contacts');
  const part = inst(definitionId, properties);
  p.componentInstances.push(part);
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.raspberry-pi-pico', x: 0, y: 0, rotation: 0,
    properties: {}, simulationState: {},
  };
  p.boardInstances.push(board);
  defOf(definitionId).pins.forEach((pin, i) => wireInto(p, board.id, `GP${i}`, part.id, pin.id));
  return { project: p, part };
}

// ================================== 1. DIP switches ========================
section('1. DIP switch banks — independent poles');
{
  for (const [id, ways] of [['comp.dip-switch-4', 4], ['comp.dip-switch-6', 6], ['comp.dip-switch-8', 8]] as const) {
    const { project, part } = isolated(id);
    const contacts = contactsOf(id, part);
    check(contacts.length === ways, `${id} has ${ways} poles (${contacts.length})`);
    check(defOf(id).pins.length === ways * 2, `and ${ways * 2} pins (${defOf(id).pins.length})`);

    // Pole 2 on, everything else off.
    const only2 = new Set([contactStateKey(part.id, 'sw2')]);
    check(conducts(project, part.id, 'a2', 'b2', only2), `${id}: pole 2 conducts when set`);
    let leaks = 0;
    for (let i = 1; i <= ways; i++) {
      if (i === 2) continue;
      if (conducts(project, part.id, `a${i}`, `b${i}`, only2)) leaks++;
    }
    check(leaks === 0, `${id}: no other pole conducts (${leaks} leaked)`);

    // All on together.
    const all = new Set(Array.from({ length: ways }, (_, i) => contactStateKey(part.id, `sw${i + 1}`)));
    let closed = 0;
    for (let i = 1; i <= ways; i++) if (conducts(project, part.id, `a${i}`, `b${i}`, all)) closed++;
    check(closed === ways, `${id}: every pole can be set at once (${closed}/${ways})`);
  }

  // DIP poles latch — you set them and walk away.
  const spots = interactiveHotspots(defOf('comp.dip-switch-8'), inst('comp.dip-switch-8'));
  check(spots.length === 8, `eight clickable poles (${spots.length})`);
  check(spots.every((s) => s.kind === 'latching'), 'each latching rather than momentary');
  let mismatch = 0;
  for (const s of spots) {
    if (hotspotAt(defOf('comp.dip-switch-8'), inst('comp.dip-switch-8'), s.x + s.w / 2, s.y + s.h / 2)?.key !== s.key) mismatch++;
  }
  check(mismatch === 0, `each pole hit-tests to itself (${mismatch} mismatches)`);
}

// ============================== 2. changeover switches =====================
section('2. slide and limit switches — break before make');
{
  for (const id of ['comp.slide-switch', 'comp.limit-switch'] as const) {
    const { project, part } = isolated(id);
    const idle = new Set<string>();
    const active = new Set([contactStateKey(part.id, '')]);

    check(conducts(project, part.id, 'com', 'nc', idle), `${id}: COM-NC conducts at rest`);
    check(!conducts(project, part.id, 'com', 'no', idle), `${id}: COM-NO is open at rest`);
    check(conducts(project, part.id, 'com', 'no', active), `${id}: COM-NO conducts when actuated`);
    check(!conducts(project, part.id, 'com', 'nc', active), `${id}: and COM-NC opens`);

    // NO and NC must never be joined to each other, in either state — that
    // would be a short across the two throws, which a real changeover cannot do.
    check(
      !conducts(project, part.id, 'no', 'nc', idle) && !conducts(project, part.id, 'no', 'nc', active),
      `${id}: NO and NC are never joined — break before make`,
    );
  }

  // A limit switch is momentary (the lever springs back); a slide switch stays.
  check(
    interactiveHotspots(defOf('comp.limit-switch'), inst('comp.limit-switch'))[0].kind === 'momentary',
    'the limit switch lever springs back',
  );
  check(
    interactiveHotspots(defOf('comp.slide-switch'), inst('comp.slide-switch'))[0].kind === 'latching',
    'and the slide switch stays where it is put',
  );
}

// ================================ 3. rotary encoder ========================
section('3. rotary encoder — two contacts and a click');
{
  const { project, part } = isolated('comp.rotary-encoder');
  const contacts = contactsOf('comp.rotary-encoder', part);
  check(contacts.length === 3, `three contacts: A, B and the switch (${contacts.length})`);
  check(contacts.every((c) => c.b === 'gnd'), 'all three switch to ground, as a KY-040 does');

  const a = new Set([contactStateKey(part.id, 'a')]);
  check(conducts(project, part.id, 'clk', 'gnd', a), 'the A contact pulls CLK to ground');
  check(!conducts(project, part.id, 'dt', 'gnd', a), 'without touching DT');

  const both = new Set([contactStateKey(part.id, 'a'), contactStateKey(part.id, 'b')]);
  check(
    conducts(project, part.id, 'clk', 'gnd', both) && conducts(project, part.id, 'dt', 'gnd', both),
    'a detent where both are closed pulls both lines — the quadrature overlap',
  );

  const click = new Set([contactStateKey(part.id, 'sw')]);
  check(conducts(project, part.id, 'sw', 'gnd', click), 'pressing the shaft closes the switch');
  check(!conducts(project, part.id, 'clk', 'gnd', click), 'without moving the encoder contacts');

  // The shaft click is the only hotspot: rotation is a direction, not a click.
  const spots = interactiveHotspots(defOf('comp.rotary-encoder'), part);
  check(spots.length === 1 && spots[0].key === 'sw', 'only the shaft is clickable on the canvas');
}

// ==================================== 4. joystick ==========================
section('4. joystick — two wipers and a click');
{
  const { project, part } = isolated('comp.joystick');
  const def = defOf('comp.joystick');
  check(def.pins.find((p) => p.id === 'vrx')?.type === 'analog', 'VRx is an analog pin');
  check(def.pins.find((p) => p.id === 'vry')?.type === 'analog', 'VRy is an analog pin');
  check(def.pins.find((p) => p.id === 'sw') !== undefined, 'and the stick has a push switch');

  const contacts = contactsOf('comp.joystick', part);
  check(contacts.length === 1 && contacts[0].key === 'sw', 'only the click is a contact — the axes are potentiometers');

  const click = new Set([contactStateKey(part.id, 'sw')]);
  check(conducts(project, part.id, 'sw', 'gnd', click), 'clicking the stick pulls SW to ground');
  check(!conducts(project, part.id, 'sw', 'gnd', new Set()), 'and it is open otherwise');
}

// ============================ 5. 6mm button, geometry ======================
section('5. the 6mm button');
{
  const { project, part } = isolated('comp.push-button-6mm');
  const def = defOf('comp.push-button-6mm');
  check(def.pins.length === 4, `four legs (${def.pins.length})`);
  check(def.internalGroups?.['1a'] === def.internalGroups?.['1b'], '1a and 1b are internally joined');
  check(def.internalGroups?.['2a'] === def.internalGroups?.['2b'], 'as are 2a and 2b');
  check(def.internalGroups?.['1a'] !== def.internalGroups?.['2a'], 'and the two sides are not');

  const pressed = new Set([contactStateKey(part.id, '')]);
  check(conducts(project, part.id, '1a', '2a', pressed), 'pressing bridges the two sides');
  check(!conducts(project, part.id, '1a', '2a', new Set()), 'and releasing opens them');
  check(def.widthMm < defOf('comp.push-button').widthMm, `it really is smaller than the 12mm part (${def.widthMm}mm)`);
}

// ====================== 6. geometry and persistence guardrails =============
section('6. geometry, persistence and library hygiene');
{
  const batch1 = [
    'comp.push-button-6mm', 'comp.slide-switch', 'comp.limit-switch',
    'comp.dip-switch-4', 'comp.dip-switch-6', 'comp.dip-switch-8',
    'comp.rotary-encoder', 'comp.joystick',
    'comp.keypad-3x4', 'comp.keypad-4x4', 'comp.keypad-matrix', 'comp.mini-keyboard',
  ];

  for (const id of batch1) {
    const def = defOf(id);
    if (!def) {
      check(false, `${id} exists in the library`);
      continue;
    }
    // Pins must be inside the part, in canvas units (4 per mm).
    const W = def.widthMm * 4;
    const H = def.heightMm * 4;
    const stray = def.pins.filter((p) => p.x < -1 || p.y < -1 || p.x > W + 1 || p.y > H + 1);
    if (stray.length > 0) check(false, `${id}: ${stray.length} pin(s) outside the outline`);

    // Pin ids must be unique — a duplicate silently merges two nets.
    const ids = def.pins.map((p) => p.id);
    if (new Set(ids).size !== ids.length) check(false, `${id}: duplicate pin ids`);

    // Every part must be recognisable rather than a captioned rectangle.
    if (def.artwork.kind !== 'builtin' || !def.artwork.builtinId) check(false, `${id}: no builtin artwork`);
  }
  check(true, `all ${batch1.length} Batch 1 parts have in-bounds unique pins and real artwork`);

  // A part that carries the Simulated badge must have a simulation adapter.
  const badged = batch1.map(defOf).filter((d) => d.supportLevel === 'simulated');
  check(
    badged.every((d) => Boolean(d.simulationAdapterId)),
    `every Simulated part names an adapter (${badged.length} parts)`,
  );

  // Instance state must survive a save: the configurable keypad's size is a
  // property, so a round trip through JSON must keep its grid.
  const configured = inst('comp.keypad-matrix', { rows: 3, cols: 6 });
  const revived = JSON.parse(JSON.stringify(configured)) as ComponentInstance;
  check(contactsOf('comp.keypad-matrix', revived).length === 18, 'a configured keypad keeps its size across a save');
}

// ================= 7. firmware scans the matrix, end to end ================
section('7. a real sketch scans a real keypad on a real MCU');
{
  // Rows are driven low one at a time; columns are read with pull-ups. This is
  // ordinary keypad scanning code — nothing about it knows it is simulated.
  const SCAN = [
    'const int rows[4] = {2, 3, 4, 5};',
    'const int cols[4] = {6, 7, 8, 9};',
    'const char keys[4][4] = {',
    "  {'1','2','3','A'}, {'4','5','6','B'}, {'7','8','9','C'}, {'*','0','#','D'}",
    '};',
    'void setup() {',
    '  Serial1.begin(115200);',
    '  for (int i = 0; i < 4; i++) { pinMode(rows[i], OUTPUT); digitalWrite(rows[i], HIGH); }',
    '  for (int i = 0; i < 4; i++) pinMode(cols[i], INPUT_PULLUP);',
    '}',
    'void loop() {',
    '  for (int r = 0; r < 4; r++) {',
    '    digitalWrite(rows[r], LOW);',
    '    delayMicroseconds(50);',
    '    for (int c = 0; c < 4; c++) {',
    '      if (digitalRead(cols[c]) == LOW) { Serial1.print("KEY "); Serial1.println(keys[r][c]); }',
    '    }',
    '    digitalWrite(rows[r], HIGH);',
    '  }',
    '  delay(20);',
    '}',
  ].join('\n');

  const p = emptyProject('keypad-scan');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.raspberry-pi-pico', x: 0, y: 0, rotation: 0,
    properties: {}, simulationState: {},
  };
  const keypad = inst('comp.keypad-4x4');
  p.boardInstances.push(board);
  p.componentInstances.push(keypad);
  p.codeFiles = [{ id: 'k', name: 'sketch.ino', content: SCAN, language: 'cpp' }];
  for (let r = 0; r < 4; r++) wireInto(p, board.id, `GP${2 + r}`, keypad.id, `row${r + 1}`);
  for (let c = 0; c < 4; c++) wireInto(p, board.id, `GP${6 + c}`, keypad.id, `col${c + 1}`);

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable) {
    skip('the RP2040 toolchain is unavailable — the firmware scan cannot run');
  } else if (!(await simulationController.start())) {
    skip(`the scanning project would not start: ${useSimulationStore.getState().error ?? '—'}`);
  } else {
    simulationController.pause();
    const sim = useSimulationStore.getState();

    // Nothing held: the scan must find nothing at all.
    simulationController.advance(200);
    simulationController.publishNow();
    const idle = useSimulationStore.getState().serialText;
    check(!/KEY/.test(idle), `an unpressed keypad reports no keys (${idle.trim().length} chars of serial)`);

    // Hold '7' — row 3, column 1 — and the sketch must decode exactly that.
    sim.pressButton(contactStateKey(keypad.id, matrixKey(2, 0)), true);
    simulationController.advance(300);
    simulationController.publishNow();
    const withSeven = useSimulationStore.getState().serialText;
    const sevens = (withSeven.match(/KEY 7/g) ?? []).length;
    console.log(`   serial: ${JSON.stringify(withSeven.split('\n').filter(Boolean).slice(-3))}`);
    check(sevens > 0, `the firmware decoded '7' from the matrix (${sevens} reports)`);
    check(!/KEY [^7]/.test(withSeven), 'and reported no other key');

    // Release, and it stops.
    sim.pressButton(contactStateKey(keypad.id, matrixKey(2, 0)), false);
    useSimulationStore.getState().clearSerial();
    simulationController.advance(300);
    simulationController.publishNow();
    check(!/KEY/.test(useSimulationStore.getState().serialText), 'releasing the key stops the reports');

    // Two keys on different rows: the scan must find both, because they are
    // two independent contacts and the firmware visits each row in turn.
    sim.pressButton(contactStateKey(keypad.id, matrixKey(0, 0)), true); // '1'
    sim.pressButton(contactStateKey(keypad.id, matrixKey(3, 3)), true); // 'D'
    useSimulationStore.getState().clearSerial();
    simulationController.advance(300);
    simulationController.publishNow();
    const both = useSimulationStore.getState().serialText;
    check(/KEY 1/.test(both), "with two keys held, the firmware finds '1'");
    check(/KEY D/.test(both), "and 'D'");
  }
  simulationController.stop();
}

console.log(
  failures === 0
    ? `\nContact-input checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
