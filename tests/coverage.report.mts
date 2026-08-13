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

console.log(
  failures === 0
    ? '\nCoverage matrix is consistent with the shipped library.'
    : `\n${failures} consistency check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
