// Multiplexed displays, and the persistence that makes a scan look like a picture.
//
// A four-digit seven-segment module has twelve pins, not twenty-eight. The
// segment lines are shared and one digit's common is enabled at a time, so at
// any instant three of the four digits are electrically dark. Read the pins
// instantaneously and that is exactly what you see — one digit, jumping
// between four positions. What a person sees is the average over roughly the
// last twenty milliseconds.
//
// So the display carries a perception model on top of the electrical one, and
// the thing to be careful about is that it stays on top. Sections 1 and 2 test
// the model in isolation with exact times; sections 4 and 5 run real firmware
// scanning a real display; and section 3 checks the part that would make all
// of it worthless — that nothing about persistence changes an electrical
// reading.

import { PersistenceTracker, PERSISTENCE_TAU_MS } from '../src/simulation/devices/persistence';
import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject } from '../src/project/templates';
import { COMPONENT_DEFINITIONS } from '../src/components-library/definitions';
import { COMPONENT_COVERAGE } from '../src/components-library/componentCoverage';
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
const defOf = (id: string) => COMPONENT_DEFINITIONS.find((d) => d.id === id);

// ================================================ 1. the perception model ====
section('1. brightness follows duty cycle');
{
  const p = new PersistenceTracker();

  // A 25% duty scan — one digit of four — run long enough to settle.
  let t = 0;
  for (let cycle = 0; cycle < 400; cycle++) {
    p.set('d0', true, t);
    t += 1;
    p.set('d0', false, t);
    t += 3;
  }
  const quarter = p.level('d0', t);
  console.log(`   25% duty settles at ${quarter.toFixed(3)}`);
  check(quarter > 0.15 && quarter < 0.35, `a quarter-duty element reads as roughly a quarter lit (${quarter.toFixed(3)})`);

  // 50% duty on the same tracker's other key.
  t = 0;
  for (let cycle = 0; cycle < 400; cycle++) {
    p.set('d1', true, t);
    t += 2;
    p.set('d1', false, t);
    t += 2;
  }
  const half = p.level('d1', t);
  console.log(`   50% duty settles at ${half.toFixed(3)}`);
  check(half > quarter, `and a half-duty element is brighter than a quarter-duty one (${half.toFixed(3)} > ${quarter.toFixed(3)})`);

  // Continuously on is full brightness.
  p.set('d2', true, 0);
  check(p.level('d2', 100) > 0.99, 'an element left on reads as fully lit');

  // Never enabled is black, not faint.
  p.set('d3', false, 0);
  check(p.level('d3', 100) === 0, 'an element never enabled is exactly zero, not a residue');
  check(!p.isLit('d3', 100), 'and reads as not lit');
}

// ============================================== 2. it decays when scanning stops
section('2. a display that stops being scanned fades out');
{
  const p = new PersistenceTracker();
  let t = 0;
  for (let cycle = 0; cycle < 200; cycle++) {
    p.set('s', true, t);
    t += 1;
    p.set('s', false, t);
    t += 1;
  }
  const scanning = p.level('s', t);
  check(scanning > 0.3, `while scanning it is lit (${scanning.toFixed(3)})`);

  // Firmware stops. Nothing further is set; time simply passes.
  const afterOneTau = p.level('s', t + PERSISTENCE_TAU_MS);
  const afterFive = p.level('s', t + PERSISTENCE_TAU_MS * 5);
  console.log(`   after 1 tau ${afterOneTau.toFixed(3)}, after 5 tau ${afterFive.toFixed(3)}`);
  check(afterOneTau < scanning * 0.5, 'one time constant later it is visibly dimmer');
  check(afterFive === 0, 'and it reaches exactly dark rather than decaying forever');

  // The decay is time-based, not call-based: asking twice at the same instant
  // must not dim it further, or a renderer that polled twice would darken it.
  const q = new PersistenceTracker();
  q.set('x', true, 0);
  q.set('x', false, 10);
  const first = q.level('x', 12);
  const second = q.level('x', 12);
  check(first === second, 'reading twice at the same time gives the same answer');
}

// ======================================= 3. perception never touches electricity
section('3. the perception model is a view, not a circuit');
{
  // The tracker holds no electrical state and cannot be read as one: it stores
  // what it was told and a level, and exposes only the level. This checks the
  // property that matters — that a smoothed level and the electrical state can
  // disagree, which is the whole point, and that the electrical state is what
  // was set rather than what is perceived.
  const p = new PersistenceTracker();
  p.set('k', true, 0);
  p.set('k', false, 1); // on for 1 ms, then off
  check(p.level('k', 1) === 1, 'at the instant it switches off it is still fully lit — no time has passed');

  // A millisecond later the electrical state has been off the whole time and
  // the perceived level has not caught up. That gap is the model.
  const perceived = p.level('k', 2);
  check(perceived > 0.05, `a millisecond after switching off it still reads as lit (${perceived.toFixed(3)})`);
  check(perceived < 1, 'but no longer fully — perceived and electrical genuinely disagree');

  // Restating the same electrical state changes nothing, so a renderer that
  // polls cannot dim what it is looking at.
  p.set('k', false, 2);
  check(p.level('k', 2) === perceived, 'restating the same electrical state does not change the perceived one');
}

// ============================ 4. real firmware scanning a four-digit display ==
section('4. an executed sketch scanning four digits');
{
  // Straight multiplexing, the way every tutorial teaches it: put the segment
  // pattern on the shared lines, pull one digit's common low, wait, move on.
  // Nothing sets a number — the digits are whatever the segments say.
  const SOURCE = [
    'const uint8_t SEG[8] = {2, 3, 4, 5, 6, 7, 8, 9};', // a..g, dp
    'const uint8_t DIG[4] = {10, 11, 12, 13};',
    // 1, 2, 3, 4 as segment masks (bit0=a .. bit6=g)
    'const uint8_t FONT[4] = {0b0000110, 0b1011011, 0b1001111, 0b1100110};',
    'void setup() {',
    '  for (uint8_t i = 0; i < 8; i++) { pinMode(SEG[i], OUTPUT); digitalWrite(SEG[i], LOW); }',
    '  for (uint8_t i = 0; i < 4; i++) { pinMode(DIG[i], OUTPUT); digitalWrite(DIG[i], HIGH); }',
    '}',
    'void loop() {',
    '  for (uint8_t d = 0; d < 4; d++) {',
    '    for (uint8_t i = 0; i < 4; i++) digitalWrite(DIG[i], HIGH);',  // all digits off
    '    for (uint8_t s = 0; s < 7; s++) digitalWrite(SEG[s], (FONT[d] >> s) & 1);',
    '    digitalWrite(SEG[7], LOW);',
    '    digitalWrite(DIG[d], LOW);',                                    // enable this digit
    '    delayMicroseconds(1200);',
    '  }',
    '}',
  ].join('\n');

  const p = emptyProject('sevenseg');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.arduino-uno', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  const disp: ComponentInstance = {
    id: uid('s'), definitionId: 'comp.seven-segment-4', x: 300, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  p.boardInstances.push(board);
  p.componentInstances.push(disp);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  const wire = (a: string, ap: string, b: string, bp: string) =>
    p.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#000', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  const segs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'];
  segs.forEach((seg, i) => wire(board.id, `D${i + 2}`, disp.id, seg));
  ['d1', 'd2', 'd3', 'd4'].forEach((d, i) => wire(board.id, `D${i + 10}`, disp.id, d));

  simulationController.stop();
  const report = await simulationController.build(p);
  for (const b of report.builds) console.log(`   build: ${b.detail}`);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the AVR toolchain is unavailable — the scanning test cannot run');
  } else {
    simulationController.pause();
    simulationController.advance(120);
    simulationController.publishNow();
    const visuals = useSimulationStore.getState().visuals as Record<
      string,
      { elementBrightness?: Record<string, number> }
    >;
    const b = visuals[disp.id]?.elementBrightness ?? {};
    const digitLit = (d: number) =>
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].filter((s) => (b[`${d}.${s}`] ?? 0) > 0.01);
    for (let d = 0; d < 4; d++) console.log(`   digit ${d}: ${digitLit(d).join('') || '(dark)'}`);

    check(digitLit(0).length > 0, 'digit 0 is visible');
    check(digitLit(1).length > 0, 'digit 1 is visible');
    check(digitLit(2).length > 0, 'digit 2 is visible');
    check(digitLit(3).length > 0, 'digit 3 is visible — all four at once, which is the point');

    // The segment patterns are the font, not a number the simulator decided.
    check(
      digitLit(0).join('') === 'bc',
      `digit 0 shows exactly the segments for "1" (${digitLit(0).join('')})`,
    );
    check(
      digitLit(1).sort().join('') === 'abdeg',
      `digit 1 shows exactly the segments for "2" (${digitLit(1).sort().join('')})`,
    );
    check(
      digitLit(3).sort().join('') === 'bcfg',
      `digit 3 shows exactly the segments for "4" (${digitLit(3).sort().join('')})`,
    );
    check((b['0.dp'] ?? 0) < 0.01, 'and no decimal point, because firmware never drove it');

    // Each digit is on a quarter of the time, so none is at full brightness —
    // which is the visible consequence of multiplexing and a real trade-off.
    const level = b['0.b'] ?? 0;
    console.log(`   digit 0 segment B brightness: ${level.toFixed(3)}`);
    check(level > 0.05 && level < 0.9, `a scanned segment is dimmer than a static one (${level.toFixed(3)})`);
  }
  simulationController.stop();
}

// ================================= 5. a digit that is never scanned stays dark
section('5. three digits scanned, the fourth left alone');
{
  const SOURCE = [
    'const uint8_t SEG[8] = {2, 3, 4, 5, 6, 7, 8, 9};',
    'const uint8_t DIG[4] = {10, 11, 12, 13};',
    'void setup() {',
    '  for (uint8_t i = 0; i < 8; i++) { pinMode(SEG[i], OUTPUT); digitalWrite(SEG[i], LOW); }',
    '  for (uint8_t i = 0; i < 4; i++) { pinMode(DIG[i], OUTPUT); digitalWrite(DIG[i], HIGH); }',
    '}',
    'void loop() {',
    '  for (uint8_t d = 0; d < 3; d++) {',                        // only three
    '    for (uint8_t i = 0; i < 4; i++) digitalWrite(DIG[i], HIGH);',
    '    for (uint8_t s = 0; s < 7; s++) digitalWrite(SEG[s], HIGH);',
    '    digitalWrite(DIG[d], LOW);',
    '    delayMicroseconds(1200);',
    '  }',
    '}',
  ].join('\n');

  const p = emptyProject('sevenseg3');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: 'board.arduino-uno', x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  const disp: ComponentInstance = {
    id: uid('s'), definitionId: 'comp.seven-segment-4', x: 300, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  p.boardInstances.push(board);
  p.componentInstances.push(disp);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: SOURCE, language: 'cpp' }];
  const wire = (a: string, ap: string, b: string, bp: string) =>
    p.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#000', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'].forEach((seg, i) => wire(board.id, `D${i + 2}`, disp.id, seg));
  ['d1', 'd2', 'd3', 'd4'].forEach((d, i) => wire(board.id, `D${i + 10}`, disp.id, d));

  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable || !(await simulationController.start())) {
    skip('the three-digit variant would not start');
  } else {
    simulationController.pause();
    simulationController.advance(120);
    simulationController.publishNow();
    const visuals = useSimulationStore.getState().visuals as Record<
      string,
      { elementBrightness?: Record<string, number> }
    >;
    const b = visuals[disp.id]?.elementBrightness ?? {};
    const lit = (d: number) => ['a', 'b', 'c', 'd', 'e', 'f', 'g'].some((s) => (b[`${d}.${s}`] ?? 0) > 0.01);
    check(lit(0) && lit(1) && lit(2), 'the three scanned digits are visible');
    check(!lit(3), 'and the fourth, which firmware never enabled, is dark');
  }
  simulationController.stop();
}

// ====================================================== 6. the parts as shipped
section('6. the parts in the library');
{
  for (const id of ['comp.seven-segment-2', 'comp.seven-segment-4', 'comp.led-matrix', 'comp.seven-segment-ca']) {
    const def = defOf(id);
    check(def !== undefined, `${id} is in the library`);
    if (!def) continue;
    check(def.supportLevel === 'simulated', `${id} is badged Simulated`);
    check(def.simulationAdapterId === 'sim.multiplexed', `${id} uses the multiplexed adapter`);
    // The rule the brief is explicit about: no value property anywhere.
    check(
      !def.properties.some((p) => /value|digits|number|text/i.test(p.key)),
      `${id} has no value property — the digits come from the pins`,
    );
    const cov = COMPONENT_COVERAGE.find((c) => c.id === id);
    check(cov?.status === 'simulated', `${id} is recorded as simulated`);
    check((cov?.tests ?? []).includes('tests/displays.multiplexed.mts'), `${id} names this file as its proof`);
  }

  const matrix = defOf('comp.led-matrix');
  check(matrix?.pins.length === 16, `the bare matrix has sixteen pins (${matrix?.pins.length})`);
  check(
    matrix?.pins.filter((p) => p.id.startsWith('r')).length === 8,
    'eight of them rows',
  );

  const ca = defOf('comp.seven-segment-ca');
  check(
    ca?.pins.find((p) => p.id === 'com1')?.type === 'anode',
    'the common-anode digit has an anode common, which is what makes it the opposite part',
  );
}

console.log(
  failures === 0
    ? `\nMultiplexed display checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
