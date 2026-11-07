// The coverage report, and the checks that keep it honest.
//
// Two jobs. It prints the engineering picture — how much of the target library
// exists, how much of it actually runs — and it fails the build if the matrix
// and the shipped library disagree, which is the only thing that stops the
// matrix from quietly becoming fiction.

import { COMPONENT_COVERAGE, coverageSummary, coverageByCategory, blockingDependencies } from '../src/components-library/componentCoverage';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const s = coverageSummary();

console.log('=========================== CircuitDesk component coverage ===========================');
console.log(`Total target parts        ${s.total}`);
console.log(`Implemented               ${s.implemented}`);
console.log(`Simulated                 ${s.simulated}`);
console.log(`Partial                   ${s.partial}   (behavioral / wiring / artwork)`);
console.log(`Missing                   ${s.missing}`);
console.log('');
console.log(`Wokwi parity              ${s.wokwiCovered}/${s.wokwiTargets}  (${s.wokwiParityPct}%)`);
console.log(`Tinkercad parity          ${s.tinkercadCovered}/${s.tinkercadTargets}  (${s.tinkercadParityPct}%)`);
console.log(`Beyond-parity targets     ${s.beyondParity}   (${s.beyondParityCovered} covered)`);
console.log('');

console.log('--- by category ---------------------------------------------------------------------');
for (const [cat, entries] of coverageByCategory()) {
  const sim = entries.filter((e) => e.status === 'simulated').length;
  const part = entries.filter((e) => e.status === 'behavioral' || e.status === 'wiring' || e.status === 'artwork').length;
  const miss = entries.filter((e) => e.status === 'missing').length;
  console.log(`${cat.padEnd(22)} ${String(entries.length).padStart(3)} target  ${String(sim).padStart(3)} simulated  ${String(part).padStart(3)} partial  ${String(miss).padStart(3)} missing`);
}

console.log('');
console.log('--- infrastructure blocking the most parts ------------------------------------------');
for (const { name, blocks } of blockingDependencies().slice(0, 12)) {
  console.log(`${name.padEnd(24)} blocks ${blocks}`);
}

console.log('');
console.log('--- consistency checks ---------------------------------------------------------------');

// The matrix must describe the library that actually ships.
const shipped = new Map(COMPONENT_DEFINITIONS.map((d) => [d.id, d]));
const matrix = new Map(COMPONENT_COVERAGE.map((e) => [e.id, e]));

check(matrix.size === COMPONENT_COVERAGE.length, `every coverage id is unique (${matrix.size}/${COMPONENT_COVERAGE.length})`);

const unlisted = [...shipped.keys()].filter((id) => !matrix.has(id));
check(unlisted.length === 0, `every shipped component appears in the matrix${unlisted.length ? `: missing ${unlisted.join(', ')}` : ''}`);

const claimedPresent = COMPONENT_COVERAGE.filter((e) => e.status !== 'missing').map((e) => e.id);
const notActuallyThere = claimedPresent.filter((id) => !shipped.has(id));
check(
  notActuallyThere.length === 0,
  `nothing is recorded as implemented unless it ships${notActuallyThere.length ? `: ${notActuallyThere.join(', ')}` : ''}`,
);

// The badge on the shelf and the status in the matrix have to agree, or the
// matrix is documenting a different product from the one users see.
//
// The two are not the same vocabulary and should not be forced to be. The
// badge is what a user is promised; the status is how it is built. What must
// never happen is a part that is only drawn or only wired wearing a Simulated
// badge, or a genuinely simulated part hiding behind a weaker one.
const badgeMismatch: string[] = [];
for (const e of COMPONENT_COVERAGE) {
  const def = shipped.get(e.id);
  if (!def) continue;
  const badge = def.supportLevel;
  if (e.status === 'simulated' && badge !== 'simulated') {
    badgeMismatch.push(`${e.id} is simulated but badged ${badge}`);
  }
  if ((e.status === 'wiring' || e.status === 'artwork') && badge === 'simulated') {
    badgeMismatch.push(`${e.id} is only ${e.status} but badged Simulated`);
  }
  // A behavioral part may carry the Simulated badge — it does genuinely do its
  // job — but only while it says out loud what it simplifies.
  if (e.status === 'behavioral' && badge === 'simulated' && !e.note) {
    badgeMismatch.push(`${e.id} is behavioral and badged Simulated with no documented limits`);
  }
}
check(badgeMismatch.length === 0, `badges are honest about the matrix${badgeMismatch.length ? `: ${badgeMismatch.join('; ')}` : ''}`);

// Anything not fully simulated owes the reader an explanation.
const undocumented = COMPONENT_COVERAGE.filter(
  (e) => (e.status === 'behavioral' || e.status === 'wiring' || e.status === 'artwork') && !e.note,
).map((e) => e.id);
check(undocumented.length === 0, `every partial part documents its limits${undocumented.length ? `: ${undocumented.join(', ')}` : ''}`);

// A simulated part with no tests is a claim with nothing behind it.
const untested = COMPONENT_COVERAGE.filter((e) => e.status === 'simulated' && e.tests.length === 0).map((e) => e.id);
check(untested.length === 0, `every simulated part names its tests${untested.length ? `: ${untested.join(', ')}` : ''}`);

// A part cannot be both a parity target and a beyond-parity one.
const contradictory = COMPONENT_COVERAGE.filter(
  (e) => e.sourceParity.circuitdeskExtra && (e.sourceParity.wokwi || e.sourceParity.tinkercad),
).map((e) => e.id);
check(contradictory.length === 0, `no entry is both parity and beyond-parity${contradictory.length ? `: ${contradictory.join(', ')}` : ''}`);

// ---------------------------------------------------------------------------
// Every gap names the primitive that would close it.
//
// This is the check that keeps the matrix a plan rather than a wish list. A
// part that is not fully simulated must say WHAT CAPABILITY IS MISSING — not
// that it is unfinished, which is already obvious from its status. The
// difference matters: "analog-solver" tells the next person what to build and
// which other parts they would unblock at the same time; "TODO" tells them
// nothing and quietly accumulates.
/**
 * Simulation primitives that now exist, derived from the matrix itself.
 *
 * A primitive counts as built when some FINISHED part is built on it. Deriving
 * it rather than keeping a hand-written list is the point: the list would rot
 * exactly like the entries it is meant to police, and would need updating by
 * the same person who forgot to update them.
 */
const IMPLEMENTED_PRIMITIVES = new Set(
  COMPONENT_COVERAGE.filter((e) => e.status === 'simulated').flatMap((e) => e.dependencies),
);

const VAGUE_BLOCKERS = [
  'todo', 'later', 'future', 'future-work', 'unfinished', 'not-done', 'notdone',
  'unsupported', 'not-supported', 'needs-simulation', 'needs-work', 'tbd', 'wip',
  'none', 'n/a', 'pending',
];
{
  const gaps = COMPONENT_COVERAGE.filter((e) => e.status !== 'simulated');
  const blockerless = gaps.filter((e) => e.dependencies.length === 0).map((e) => e.id);
  check(
    blockerless.length === 0,
    `every gap names the primitive that would close it${blockerless.length ? `: ${blockerless.join(', ')}` : ` (${gaps.length} gaps, all accounted for)`}`,
  );

  const vague = gaps
    .filter((e) => e.dependencies.some((d) => VAGUE_BLOCKERS.includes(d.toLowerCase())))
    .map((e) => `${e.id} (${e.dependencies.join(', ')})`);
  check(vague.length === 0, `and none of them is a placeholder${vague.length ? `: ${vague.join('; ')}` : ''}`);

  // A gap whose every dependency already exists is STALE, not blocked.
  //
  // `dependencies` means "primitives this part is built on". On a finished
  // part that is documentation — a 74HC138 depends on the logic-IC engine, and
  // saying so is how the next combinational part gets estimated. On a gap it
  // is the work plan, and it only stays a work plan while at least one of
  // those primitives is still missing. Infrastructure landed steadily through
  // this project; without this check, entries quietly go on citing engines
  // that were finished months ago and finished work stays invisible.
  const stale = COMPONENT_COVERAGE.filter(
    (e) => e.status !== 'simulated' && e.dependencies.every((d) => IMPLEMENTED_PRIMITIVES.has(d)),
  ).map((e) => `${e.id} (${e.dependencies.join(', ')})`);
  check(
    stale.length === 0,
    `no gap is waiting on something that already exists${stale.length ? `: ${stale.join('; ')}` : ''}`,
  );

  // One id per part. A duplicate row means two people's opinions about the
  // same component, and the matrix stops being an answer.
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const e of COMPONENT_COVERAGE) {
    if (seen.has(e.id)) duplicates.push(e.id);
    seen.add(e.id);
  }
  check(duplicates.length === 0, `no target is listed twice${duplicates.length ? `: ${duplicates.join(', ')}` : ''}`);

  // A part recorded as Missing that actually ships is the worst kind of stale
  // entry: it hides finished work and invites someone to build it again.
  const missingButShipped = COMPONENT_COVERAGE.filter((e) => e.status === 'missing' && shipped.has(e.id)).map((e) => e.id);
  check(
    missingButShipped.length === 0,
    `nothing recorded as missing actually ships${missingButShipped.length ? `: ${missingButShipped.join(', ')}` : ''}`,
  );
}

// The blockers themselves, as a work plan: which primitive unblocks the most.
//
// Only the primitives that do NOT yet exist are counted. A gap also lists what
// it is already built on — an HC-05 sits on the UART endpoint and waits for a
// Bluetooth channel — and counting the finished half would make the plan look
// like there is work where there is none.
{
  const byBlocker = new Map<string, string[]>();
  for (const e of COMPONENT_COVERAGE) {
    if (e.status === 'simulated') continue;
    for (const d of e.dependencies) {
      if (IMPLEMENTED_PRIMITIVES.has(d)) continue;
      byBlocker.set(d, [...(byBlocker.get(d) ?? []), e.id]);
    }
  }
  const ranked = [...byBlocker.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log(`\n   ${ranked.length} distinct blocker(s), most valuable first:`);
  for (const [blocker, ids] of ranked) {
    console.log(`     ${String(ids.length).padStart(3)}  ${blocker}`);
  }
}

console.log(
  failures === 0
    ? '\nCoverage matrix is consistent with the shipped library.'
    : `\n${failures} consistency check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
