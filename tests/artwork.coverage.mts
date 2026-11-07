// Every shipped part, classified — and nothing silently unclassified.
//
// The generic box is a legitimate placeholder and that is exactly what makes
// it dangerous: a part that falls through to it still renders, still wires up
// and still simulates, so nothing ever fails and nobody notices that it looks
// like a labelled rectangle. That is how ten pieces of finished artwork went
// missing across a branch move without a single test going red.
//
// So this file draws the distinction the audit needs: a part on a SHARED
// renderer because it genuinely shares a package is finished work, and a part
// on the fallback because nobody drew it is not. Those two look identical from
// the outside and have to be told apart deliberately.

import React from 'react';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';

// The artwork module is TSX and this runner uses the classic createElement
// form, so React has to be reachable as a global before it loads.
(globalThis as unknown as { React: typeof React }).React = React;
const { BUILTIN_ARTWORK_IDS } = await import('../src/components-library/artwork/componentArtwork');

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}
function section(t: string) {
  console.log(`\n--- ${t}`);
}

/**
 * Renderers deliberately shared by more than one part.
 *
 * A 74HC595 and a 24C256 are the same DIP package with a different number on
 * it, and drawing each by hand would give two subtly different packages for no
 * reason. Sharing is the right answer there. It is NOT the right answer when
 * the parts differ physically, so the list is explicit rather than inferred
 * from "more than one part uses this".
 */
const DELIBERATELY_SHARED = new Set([
  // Same package, different marking.
  'dip-ic', // through-hole logic, shift registers, EEPROM, flash, blank DIP
  'logic-block', // the larger MSI blocks
  // Same hardware, different size or pinout — a 16x2 and a 20x4 character LCD
  // are the same module with more of it, and a DIP switch is the same switch
  // four, six or eight times.
  'lcd-parallel',
  'dip-switch',
  'keypad',
  'seven-segment',
  'seven-segment-multi',
  'battery-aa',
  // Same family, distinguished inside the renderer rather than by having two
  // drawings: the TFT panels differ by resolution and the converter by
  // topology, and both branch on the part they were handed.
  'tft',
  'converter',
  'regulator',
  // Motors and relays: a geared motor, an encoder motor and a vibration motor
  // are all a can motor with something added, and the renderer adds it.
  'dc-motor',
  'stepper',
  'relay',
]);

interface Row {
  id: string;
  name: string;
  category: string;
  artworkId: string;
  state: 'own renderer' | 'shared package' | 'FALLBACK' | 'no builtin art';
}

const rows: Row[] = [];
for (const def of COMPONENT_DEFINITIONS) {
  if (def.artwork.kind !== 'builtin' || !def.artwork.builtinId) {
    rows.push({ id: def.id, name: def.name, category: def.category, artworkId: '—', state: 'no builtin art' });
    continue;
  }
  const artworkId = def.artwork.builtinId;
  const drawn = BUILTIN_ARTWORK_IDS.includes(artworkId);
  rows.push({
    id: def.id,
    name: def.name,
    category: def.category,
    artworkId,
    state: !drawn ? 'FALLBACK' : DELIBERATELY_SHARED.has(artworkId) ? 'shared package' : 'own renderer',
  });
}

// ================================================== 1. the matrix ===========
section('1. the visual coverage matrix');
{
  const byState = new Map<string, Row[]>();
  for (const r of rows) byState.set(r.state, [...(byState.get(r.state) ?? []), r]);

  console.log(`   ${rows.length} shipped components`);
  for (const state of ['own renderer', 'shared package', 'FALLBACK', 'no builtin art'] as const) {
    const list = byState.get(state) ?? [];
    console.log(`     ${String(list.length).padStart(4)}  ${state}`);
  }

  console.log('\n   by category:');
  const cats = [...new Set(rows.map((r) => r.category))].sort();
  for (const cat of cats) {
    const list = rows.filter((r) => r.category === cat);
    const fallback = list.filter((r) => r.state === 'FALLBACK').length;
    const shared = list.filter((r) => r.state === 'shared package').length;
    console.log(
      `     ${cat.padEnd(22)} ${String(list.length).padStart(3)} parts, ` +
      `${String(list.length - fallback - shared).padStart(3)} own, ${String(shared).padStart(2)} shared` +
      (fallback ? `, ${fallback} FALLBACK` : ''),
    );
  }

  // Nothing may sit outside the four buckets.
  const unclassified = rows.filter((r) => !['own renderer', 'shared package', 'FALLBACK', 'no builtin art'].includes(r.state));
  check(unclassified.length === 0, 'every shipped component is classified');
}

// ================================== 2. no part is a rectangle by default ====
section('2. the fallback renderer is empty');
{
  const fallbacks = rows.filter((r) => r.state === 'FALLBACK');
  console.log(fallbacks.length ? `   still falling back: ${fallbacks.map((r) => r.id).join(', ')}` : '   none');
  check(
    fallbacks.length === 0,
    `no shipped component falls through to the generic box${fallbacks.length ? ` (${fallbacks.length})` : ''}`,
  );

  const missing = rows.filter((r) => r.state === 'no builtin art');
  check(missing.length === 0, `and every one names a builtin renderer${missing.length ? `: ${missing.map((r) => r.id).join(', ')}` : ''}`);
}

// ============================= 3. sharing is a decision, not an accident ====
section('3. shared renderers are the ones we chose to share');
{
  const usage = new Map<string, string[]>();
  for (const r of rows) {
    if (r.artworkId === '—') continue;
    usage.set(r.artworkId, [...(usage.get(r.artworkId) ?? []), r.id]);
  }
  const sharedInPractice = [...usage.entries()].filter(([, ids]) => ids.length > 1);

  // A renderer used by several parts that is NOT on the deliberate list is a
  // part quietly borrowing another's drawing, which is how a library ends up
  // with five things that look like the same board.
  const accidental = sharedInPractice
    .filter(([id]) => !DELIBERATELY_SHARED.has(id))
    .map(([id, ids]) => `${id} (${ids.length}: ${ids.slice(0, 4).join(', ')}${ids.length > 4 ? '…' : ''})`);
  console.log(`   ${sharedInPractice.length} renderer(s) used by more than one part`);
  for (const [id, ids] of sharedInPractice) {
    console.log(`     ${DELIBERATELY_SHARED.has(id) ? 'chosen  ' : 'ACCIDENT'} ${id.padEnd(16)} ${ids.length} parts`);
  }
  check(accidental.length === 0, `no part borrows another's drawing by accident${accidental.length ? `: ${accidental.join('; ')}` : ''}`);

  // And nothing is on the deliberate list without actually being shared,
  // which would mean the list had gone stale.
  const notActuallyShared = [...DELIBERATELY_SHARED].filter((id) => (usage.get(id) ?? []).length <= 1 && usage.has(id));
  check(
    notActuallyShared.length === 0,
    `and the shared list has no stale entries${notActuallyShared.length ? `: ${notActuallyShared.join(', ')}` : ''}`,
  );
}

// ========================================= 4. the art that reads real state =
section('4. artwork driven by the simulation');
{
  // Read off the source rather than asserted from memory: a renderer that
  // takes `visual` is one that can respond to what the simulation is doing,
  // and one that does not cannot possibly be faking anything.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile('src/components-library/artwork/componentArtwork.tsx', 'utf8');
  const stateful = [...source.matchAll(/function (\w+Art)\(\{[^}]*\bvisual\b/g)].map((m) => m[1]);
  const total = [...source.matchAll(/function (\w+Art)\(/g)].map((m) => m[1]);
  console.log(`   ${stateful.length} of ${total.length} renderers read simulation state:`);
  console.log(`     ${stateful.join(', ')}`);
  check(stateful.length > 0, 'renderers do read simulation state');

  // The specific ones this milestone wired up, named so a regression is loud.
  for (const name of ['DcMotorArt', 'StepperArt', 'RelayArt', 'SolenoidArt']) {
    check(stateful.includes(name), `${name} is driven by real state`);
  }
  // And the supply reads its configured value from the instance, not a guess.
  check(/function DcSupplyArt\(\{[^}]*\binstance\b/.test(source), 'DcSupplyArt reads its configured voltage from the instance');
}

console.log(
  failures === 0
    ? '\nVisual coverage is complete and classified.'
    : `\n${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
