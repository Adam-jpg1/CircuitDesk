// A project saved against the old CD4026, loaded against the corrected one.
//
// The CD4026's pinout was wrong at nearly every position and named VCC twice,
// which made pin 16 unreachable — a wire to "vcc" always resolved to the first
// one. Correcting it is safe for wires, because a wire is stored as a pin ID
// and resolves to whatever coordinate that pin now has; what is NOT safe is a
// pin whose NAME changed, because `normalizeProject` drops connections whose
// pin no longer exists and a rename is indistinguishable from a deletion.
//
// Exactly one pin had to be renamed. The old part had a single display-enable
// pin called `deo` which the model read as an INPUT and used to blank the
// segments — that is DISPLAY ENABLE IN, so it is `dei` now, and the buffered
// output the datasheet calls DEO is a new pin nothing can have been wired to.
//
// So the fixture below is a project built the old way: a CD4026 wired to a
// seven-segment display, clocked from a board, with the display-enable wire on
// the old name. It has to come back with every connection it had, on the same
// electrical nodes, and save with the corrected ids.

import { normalizeProject } from '../src/project/projectService';
import { PIN_RENAMES, migratePinIds } from '../src/project/pinMigrations';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import { buildCircuitGraph, nodeKey } from '../src/circuit/nets';
import { PROJECT_SCHEMA_VERSION, type CircuitProject } from '../src/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

const defOf = (id: string) => COMPONENT_DEFINITIONS.find((d) => d.id === id);

/**
 * A project exactly as an older build would have written it.
 *
 * Deliberately literal rather than constructed through the app's helpers: the
 * point is that this is what is sitting in somebody's IndexedDB, so it has to
 * be the bytes, not a rebuild of them.
 */
function legacyProject(): CircuitProject {
  return {
    id: 'legacy-cd4026',
    name: 'Counter digit',
    version: '1.0.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    boardInstances: [
      { id: 'board1', definitionId: 'board.arduino-uno', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {} },
    ],
    componentInstances: [
      { id: 'ctr1', definitionId: 'comp.cd4026', x: 400, y: 100, rotation: 0, properties: {}, simulationState: {} },
      { id: 'seg1', definitionId: 'comp.seven-segment', x: 700, y: 100, rotation: 0, properties: {}, simulationState: {} },
    ],
    connections: [
      // Power and ground, including the wire to the pin that used to be
      // declared twice.
      wire('w1', 'board1', '5V', 'ctr1', 'vcc'),
      wire('w2', 'board1', 'GND_TOP', 'ctr1', 'gnd'),
      // The clock and the two control inputs.
      wire('w3', 'board1', 'D2', 'ctr1', 'clk'),
      wire('w4', 'board1', 'GND_PWR1', 'ctr1', 'inh'),
      wire('w5', 'board1', 'GND_PWR2', 'ctr1', 'rst'),
      // The display-enable wire, on the name the old part used.
      wire('w6', 'board1', '5V', 'ctr1', 'deo'),
      // Every segment out to the display.
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((s, i) => wire(`ws${i}`, 'ctr1', s, 'seg1', s)),
      wire('w7', 'board1', 'GND_TOP', 'seg1', 'com1'),
    ],
    codeFiles: [{ id: 'f1', name: 'sketch.ino', content: 'void setup(){pinMode(2,OUTPUT);}\nvoid loop(){}', language: 'cpp' }],
    tests: [],
    customDefinitions: [],
    settings: {},
  };
}

function wire(id: string, a: string, ap: string, b: string, bp: string): CircuitProject['connections'][number] {
  return {
    id, sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
    netId: '', color: '#000', points: [], routing: 'smooth',
  } as CircuitProject['connections'][number];
}

// ============================================= 1. the defect is gone ========
section('1. the corrected pinout');
{
  const def = defOf('comp.cd4026');
  check(def !== undefined, 'the CD4026 is in the library');
  if (def) {
    const ids = def.pins.map((p) => p.id);
    const duplicates = ids.filter((x, i) => ids.indexOf(x) !== i);
    check(duplicates.length === 0, `no pin id is declared twice${duplicates.length ? `: ${duplicates.join(', ')}` : ''}`);
    check(ids.length === 16, `it is a 16-pin package (${ids.length})`);

    // The datasheet order, which is what a person reads off the chip.
    const datasheet = ['clk', 'inh', 'dei', 'deo', 'co', 'f', 'g', 'gnd', 'd', 'a', 'e', 'b', 'c', 'ung', 'rst', 'vcc'];
    check(
      ids.every((id, i) => id === datasheet[i]),
      `the pins are in the datasheet's own order (${ids.join(' ')})`,
    );
    check(def.pins[7].type === 'ground', 'pin 8 is VSS');
    check(def.pins[15].type.startsWith('power'), 'pin 16 is VDD');
  }
}

// ==================================== 2. the rename is a rename, not a guess =
section('2. the one renamed pin, and why it is unambiguous');
{
  const rules = PIN_RENAMES.filter((r) => r.definitionId === 'comp.cd4026');
  check(rules.length === 1, `exactly one CD4026 pin was renamed (${rules.length})`);
  const rule = rules[0];
  check(rule?.from === 'deo' && rule?.to === 'dei', `and it is deo → dei (${rule?.from} → ${rule?.to})`);
  check((rule?.reason ?? '').length > 80, 'with the reason recorded next to it');

  // The new pin the rename freed up must not be reachable by an old project.
  const def = defOf('comp.cd4026');
  const deo = def?.pins.find((p) => p.id === 'deo');
  check(deo !== undefined, 'DEO exists as its own pin now');
  check(
    def?.pins.find((p) => p.id === 'dei') !== undefined,
    'and DEI is the input the old name was actually describing',
  );
}

// =============================================== 3. the old project loads ===
section('3. an old project keeps every wire it had');
{
  const before = legacyProject();
  const wireCount = before.connections.length;
  const loaded = normalizeProject(structuredClone(before) as unknown);

  check(loaded.connections.length === wireCount, `every connection survives the load (${loaded.connections.length} of ${wireCount})`);

  const migrated = loaded.connections.find((c) => c.id === 'w6');
  check(migrated?.targetPinId === 'dei', `the display-enable wire moved to the corrected id (${migrated?.targetPinId})`);
  check(
    loaded.connections.every((c) => c.targetPinId !== 'deo' && c.sourcePinId !== 'deo'),
    'and nothing is left on the old one',
  );

  // Everything else is untouched, which is the other half of the claim.
  for (const id of ['w1', 'w2', 'w3', 'w4', 'w5', 'w7']) {
    const a = before.connections.find((c) => c.id === id)!;
    const b = loaded.connections.find((c) => c.id === id);
    check(
      b?.sourcePinId === a.sourcePinId && b?.targetPinId === a.targetPinId,
      `${id} is unchanged (${b?.sourcePinId} → ${b?.targetPinId})`,
    );
  }

  check(loaded.version === PROJECT_SCHEMA_VERSION, `and the project is saved at the current schema (${loaded.version})`);
}

// ================================== 4. the same electrical circuit ==========
section('4. the same nets, before and after');
{
  // The real question is not whether the wires are still there but whether they
  // still join the same things. Built from the loaded project and compared
  // against what the old wiring meant.
  const loaded = normalizeProject(legacyProject() as unknown);
  const graph = buildCircuitGraph(loaded);

  const netFor = (instanceId: string, pinId: string) =>
    graph.nets.find((n) => n.nodes.includes(nodeKey(instanceId, pinId)));

  const supply = netFor('ctr1', 'vcc');
  check(supply !== undefined, 'the counter still has a supply net');
  check(
    Boolean(supply?.nodes.includes(nodeKey('board1', '5V'))),
    'and it still reaches the board 5V pin',
  );

  // The display-enable wire went to 5V; after the rename it must be the same
  // node, reached through the new name.
  const enable = netFor('ctr1', 'dei');
  check(enable !== undefined, 'the display-enable input is on a net');
  check(
    Boolean(enable?.nodes.includes(nodeKey('board1', '5V'))),
    'and it is still the 5V node the old wire went to',
  );
  check(enable?.id === supply?.id, 'which is the same node as the supply, exactly as it was wired');

  // Every segment still lands on its own segment.
  for (const s of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
    const net = netFor('ctr1', s);
    check(
      Boolean(net?.nodes.includes(nodeKey('seg1', s))),
      `segment ${s} still reaches the display's ${s}`,
    );
  }
}

// ============================================= 5. it does not fire twice ====
section('5. a current project is left alone');
{
  // A project already saved at the corrected schema may legitimately use `deo`
  // — it is a real pin now — so the rule must not touch it.
  const current = legacyProject();
  current.version = PROJECT_SCHEMA_VERSION;
  current.connections = [wire('w1', 'board1', '5V', 'ctr1', 'deo')];
  const report = migratePinIds(current);
  check(report.moved.length === 0, `nothing is migrated in a current project (${report.moved.length})`);
  check(current.connections[0].targetPinId === 'deo', 'and a wire to the real DEO output stays there');

  // And running it twice on an old project is the same as running it once.
  const old = legacyProject();
  const first = migratePinIds(old);
  old.version = PROJECT_SCHEMA_VERSION;
  const second = migratePinIds(old);
  check(first.moved.length === 1 && second.moved.length === 0, 'the migration is idempotent');
}

console.log(
  failures === 0
    ? '\nCD4026 migration checks passed.'
    : `\n${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
