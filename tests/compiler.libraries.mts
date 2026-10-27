// Pinned Arduino libraries: what installs, what compiles, and what actually
// moves a pin.
//
// Three questions, deliberately kept apart, because conflating any two of them
// is how a simulator ends up lying:
//
//   1. Is the library installed at the version this service is validated
//      against? (fast, a version check)
//   2. Does the header compile for a given board? (a real build)
//   3. Does the firmware built from it do anything to the wire? (a real run)
//
// The third is the one nothing else checks. `#include <Servo.h>` compiles for a
// Raspberry Pi Pico, links, flashes, and leaves the shaft where it was, because
// Arduino-Pico emits the pulse from a PIO program and CircuitDesk's RP2040
// runtime does not advance PIO on the simulated clock. A build report that said
// "build succeeded" and stopped there would be technically true and useless.
// So every `works` claim in libraries.json is proved here by watching the servo
// angle change, and every `compiles-only` claim is proved by watching it not.
//
// Set CD_SKIP_PROBE=1 to skip section 3's cross-target compiles (the ESP builds
// are slow); the behaviour sections still run.

import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { emptyProject } from '../src/project/templates';
import {
  PINNED_LIBRARIES,
  HEADER_CLAIMS,
  resolveHeader,
  headersForTarget,
  includedHeaders,
  unsupportedIncludes,
  includeWarnings,
} from '../server/compiler/libraries';
import { PINNED_CORES } from '../server/compiler/cores';
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

// ============================================== 1. the manifest is coherent ==
section('1. the manifest says one thing, not several');
{
  const libIds = new Set(PINNED_LIBRARIES.map((l) => l.id));
  check(libIds.size === PINNED_LIBRARIES.length, 'every pinned library is listed once');

  check(
    PINNED_LIBRARIES.every((l) => /^\d+\.\d+\.\d+$/.test(l.version)),
    'every library is pinned to an exact version, never a range',
  );

  // Every header a library claims to provide has to be a header somebody can
  // ask about, or the provides list is decoration.
  const claimed = new Set(HEADER_CLAIMS.map((h) => h.header));
  for (const lib of PINNED_LIBRARIES) {
    const primary = lib.provides[0];
    check(claimed.has(primary), `${lib.id}'s main header (${primary}) has a recorded claim`);
  }

  // Sources have to name something that exists.
  const coreIds = new Set(PINNED_CORES.map((c) => c.id));
  for (const claim of HEADER_CLAIMS) {
    for (const via of claim.via) {
      if (via.source.startsWith('library:')) {
        const id = via.source.slice('library:'.length);
        check(libIds.has(id), `${claim.header} comes from library ${id}, which is pinned`);
      } else if (via.source.startsWith('core:')) {
        const id = via.source.slice('core:'.length);
        check(coreIds.has(id), `${claim.header} comes from core ${id}, which is pinned`);
      } else {
        check(false, `${claim.header} has an unrecognised source "${via.source}"`);
      }
    }
  }

  // A target cannot be both supported and not.
  for (const claim of HEADER_CLAIMS) {
    const available = new Set(claim.via.flatMap((v) => v.targets));
    const missing = claim.unavailable.flatMap((u) => u.targets);
    const both = missing.filter((t) => available.has(t));
    check(both.length === 0, `${claim.header} is not recorded as both building and not building${both.length ? ` (${both.join(', ')})` : ''}`);
  }

  // Every recorded target has to be a target this service actually offers.
  const known = new Set(PINNED_CORES.flatMap((c) => c.targets));
  for (const claim of HEADER_CLAIMS) {
    const all = [...claim.via.flatMap((v) => v.targets), ...claim.unavailable.flatMap((u) => u.targets)];
    const strays = all.filter((t) => !known.has(t));
    check(strays.length === 0, `${claim.header} only names targets this service compiles for${strays.length ? ` (stray: ${strays.join(', ')})` : ''}`);
  }

  // The honesty rule, as a check: nothing may be recorded as having no effect
  // without saying why.
  for (const claim of HEADER_CLAIMS) {
    for (const via of claim.via) {
      if (via.effect === 'compiles-only') {
        check(
          Boolean(via.effectReason && via.effectReason.length > 40),
          `${claim.header} on ${via.source} explains why it has no effect`,
        );
      }
    }
  }
  for (const claim of HEADER_CLAIMS) {
    for (const gap of claim.unavailable) {
      check(Boolean(gap.reason && gap.reason.length > 20), `${claim.header} explains why it does not build for ${gap.targets[0]}`);
    }
  }
}

// ================================================ 2. the resolver's answers ==
section('2. resolving a header against a board');
{
  const uno = resolveHeader('Servo.h', 'arduino:avr:uno');
  check(uno.available === true, 'Servo.h is available for an Uno');
  check(uno.available === true && uno.effect === 'works', 'and it is recorded as actually working there');

  // The Pico's Servo is a PIO program, and PIO runs on the simulated clock
  // (tests/rp2040.pio.mts measures the pulse), so it works.
  const pico = resolveHeader('Servo.h', 'rp2040:rp2040:rpipico');
  check(pico.available === true && pico.effect === 'works', 'Servo.h is available for a Pico, and works there');

  // A Feather M0's Servo drives the pin from a TC interrupt the SAMD21 model
  // does not run: it compiles, and is recorded as doing nothing.
  const feather = resolveHeader('Servo.h', 'adafruit:samd:adafruit_feather_m0');
  check(feather.available === true, 'Servo.h is available for a Feather M0 — it does compile');
  check(
    feather.available === true && feather.effect === 'compiles-only',
    'but it is recorded as having no effect, which is the whole point of the distinction',
  );
  check(
    feather.available === true && Boolean(feather.workaround),
    'and it offers something the user can do instead',
  );

  const c3 = resolveHeader('Servo.h', 'esp32:esp32:esp32c3');
  check(c3.available === false, 'Servo.h is not available for an ESP32-C3');
  check(
    c3.available === false && c3.alternative === 'ESP32Servo.h',
    'and the user is pointed at ESP32Servo.h rather than at a macro error',
  );

  // The manifest is a record of what was measured, not a whitelist. A header
  // nobody has checked must not be reported as broken.
  const unknown = resolveHeader('EEPROM.h', 'arduino:avr:uno');
  check(
    unknown.available === false && 'unknown' in unknown,
    'an unrecorded header is unknown, not unavailable — the compiler decides',
  );

  const forUno = headersForTarget('arduino:avr:uno').map((h) => h.header);
  check(forUno.includes('Servo.h') && forUno.includes('Wire.h'), 'the per-target header list is populated');
  check(!forUno.includes('ESP32Servo.h'), 'and does not offer an ESP-only header on an Uno');
}

// =============================================== 2b. reading a real sketch ===
section('2b. finding the includes in a sketch');
{
  const src = [
    '// #include <NotReal.h>',
    '/* #include <AlsoNotReal.h> */',
    '#include <Servo.h>',
    '  #include "local.h"',
    '#include <Wire.h>',
    'void setup() {}',
  ].join('\n');
  const found = includedHeaders(src);
  check(found.includes('Servo.h'), 'a plain include is found');
  check(found.includes('local.h'), 'a quoted include is found');
  check(!found.includes('NotReal.h'), 'a line-commented include is ignored');
  check(!found.includes('AlsoNotReal.h'), 'a block-commented include is ignored');
  check(found.length === 3, `exactly the three real includes are found (got ${found.length})`);

  const warnUno = includeWarnings(src, 'arduino:avr:uno');
  check(warnUno.length === 0, 'an Uno sketch using Servo.h and Wire.h draws no warnings');

  const warnPico = includeWarnings(src, 'rp2040:rp2040:rpipico');
  check(warnPico.length === 0, 'nor does it on a Pico, where Servo runs on PIO');

  const warnFeather = includeWarnings(src, 'adafruit:samd:adafruit_feather_m0');
  check(warnFeather.length === 1 && warnFeather[0].kind === 'no-effect', 'the same sketch on a Feather M0 is warned that Servo.h does nothing');
  check(
    /\bTC\b/.test(warnFeather[0]?.reason ?? ''),
    'and the reason names the peripheral rather than shrugging',
  );

  const warnC3 = includeWarnings(src, 'esp32:esp32:esp32c3');
  check(warnC3.length === 1 && warnC3[0].kind === 'unsupported', 'and on a C3 it is reported as not building at all');

  check(
    unsupportedIncludes(src, 'rp2040:rp2040:rpipico').length === 0,
    'unsupportedIncludes stays about compiling only — a working build is not an unsupported one',
  );
}

// ======================================= 3. the claims match the compiler ====
section('3. every recorded claim, compiled');
if (process.env.CD_SKIP_PROBE) {
  skip('CD_SKIP_PROBE is set — the cross-target probe compiles were not run');
} else {
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync('node', ['server/compiler/installLibraries.mjs', '--probe'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 40 * 60_000,
  });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  for (const line of out.split('\n').filter((l) => /^(BROKEN|STALE)/.test(l))) console.log(`   ${line}`);
  const matched = /All (\d+) recorded claim/.exec(out);
  if (run.status === null) {
    skip('the probe run did not complete (no toolchain, or it timed out)');
  } else {
    check(run.status === 0, `every header claim in the manifest compiles as recorded${matched ? ` (${matched[1]} claims)` : ''}`);
  }
}

// ================================= 4. the library actually moves the servo ===
section('4. Servo.h on an Uno drives the modelled shaft');

function servoProject(
  boardDef: string,
  pins: { sig: string; gnd: string; vcc: string },
  source: string,
): { project: CircuitProject; servo: ComponentInstance } {
  const p = emptyProject('servo-library');
  const board: ComponentInstance = {
    id: uid('b'), definitionId: boardDef, x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  const servo: ComponentInstance = {
    id: uid('s'), definitionId: 'comp.servo', x: 300, y: 0, rotation: 0, properties: {}, simulationState: {},
  };
  p.boardInstances.push(board);
  p.componentInstances.push(servo);
  p.codeFiles = [{ id: 'c', name: 'sketch.ino', content: source, language: 'cpp' }];
  const wire = (a: string, ap: string, b: string, bp: string) =>
    p.connections.push({
      id: uid('w'), sourceComponentId: a, sourcePinId: ap, targetComponentId: b, targetPinId: bp,
      netId: '', color: '#000', points: [], routing: 'smooth',
    } as CircuitProject['connections'][number]);
  wire(board.id, pins.vcc, servo.id, 'vcc');
  wire(board.id, pins.gnd, servo.id, 'gnd');
  wire(board.id, pins.sig, servo.id, 'sig');
  return { project: p, servo };
}

function servoAngle(instanceId: string): number | undefined {
  simulationController.publishNow();
  const visuals = useSimulationStore.getState().visuals as Record<string, { servoAngle?: number }>;
  return visuals[instanceId]?.servoAngle;
}

/** Runs a sketch that sweeps 0 → 90 → 180 and reports the three angles. */
async function sweep(
  boardDef: string,
  pins: { sig: string; gnd: string; vcc: string },
  source: string,
): Promise<{ ran: boolean; angles: (number | undefined)[]; notes: string[] }> {
  const { project, servo } = servoProject(boardDef, pins, source);
  simulationController.stop();
  const report = await simulationController.build(project);
  const notes: string[] = [];
  for (const b of report.builds) {
    console.log(`   build: ${b.detail}`);
    for (const n of b.notes ?? []) notes.push(`${n.kind}:${n.header}`);
  }
  if (!report.anyRunnable || !(await simulationController.start())) {
    simulationController.stop();
    return { ran: false, angles: [], notes };
  }
  simulationController.pause();
  const angles: (number | undefined)[] = [];
  for (const ms of [1200, 1800, 1800]) {
    simulationController.advance(ms);
    angles.push(servoAngle(servo.id));
  }
  simulationController.stop();
  return { ran: true, angles, notes };
}

const AVR_SWEEP = [
  '#include <Servo.h>',
  'Servo sv;',
  'void setup() { sv.attach(9); sv.write(0); }',
  'void loop() {',
  '  if (millis() > 3000) sv.write(180);',
  '  else if (millis() > 1500) sv.write(90);',
  '}',
].join('\n');

{
  const { ran, angles, notes } = await sweep(
    'board.arduino-uno',
    { sig: 'D9', gnd: 'GND_TOP', vcc: '5V' },
    AVR_SWEEP,
  );
  if (!ran) {
    skip('the AVR toolchain is unavailable — the Servo library test cannot run');
  } else {
    const [a0, a90, a180] = angles;
    console.log(`   write(0) → ${a0?.toFixed(1)}°   write(90) → ${a90?.toFixed(1)}°   write(180) → ${a180?.toFixed(1)}°`);
    check(a0 !== undefined && a0 < 15, `Servo.write(0) puts the shaft at one extreme (${a0?.toFixed(1)}°)`);
    check(a90 !== undefined && Math.abs(a90 - 90) < 15, `Servo.write(90) centres it (${a90?.toFixed(1)}°)`);
    check(a180 !== undefined && a180 > 165, `Servo.write(180) drives it to the other extreme (${a180?.toFixed(1)}°)`);
    check(
      a0 !== undefined && a90 !== undefined && a180 !== undefined && a0 < a90 && a90 < a180,
      'and the three are ordered, so the angle is following the pulse the library generated',
    );
    // The angle is derived from the wire, not from intercepting write(). The
    // hand-written pulse test (motors.batch5.mts) proves the same model from
    // the other direction; together they rule out an API shim.
    check(notes.length === 0, 'an Uno build reports no simulation caveats');
  }
}

// ============================== 5. and reports honestly where it does not ====
//
// The Pico used to be the example here: its Servo is a PIO program, and PIO
// ran on the wall clock. It now runs on the simulated clock, so the Pico's
// shaft follows the sweep like the Uno's. The Feather M0's Servo drives the pin
// from a TC interrupt the SAMD21 model does not run — that is the case a user
// must be told about.
section('5. the Pico now moves the shaft; the Feather M0 says it cannot');
{
  const SWEEP = (pin: string) => [
    '#include <Servo.h>',
    'Servo sv;',
    `void setup() { sv.attach(${pin}); sv.write(0); }`,
    'void loop() {',
    '  if (millis() > 3000) sv.write(180);',
    '  else if (millis() > 1500) sv.write(90);',
    '}',
  ].join('\n');

  const pico = await sweep('board.raspberry-pi-pico', { sig: 'GP15', gnd: 'GND3', vcc: '3V3' }, SWEEP('15'));
  if (!pico.ran) {
    skip('the RP2040 toolchain is unavailable');
  } else {
    const [a0, a90, a180] = pico.angles;
    console.log(`   Pico: ${pico.angles.map((a) => a?.toFixed(1) ?? '—').join(', ')}`);
    check(
      a0 !== undefined && a90 !== undefined && a180 !== undefined && a0 < 15 && Math.abs(a90 - 90) < 15 && a180 > 165,
      'on a Pico the shaft follows write(0), write(90) and write(180)',
    );
    check(!pico.notes.includes('no-effect:Servo.h'), 'and the build report has no caveat to give');
  }

  const feather = await sweep('board.adafruit-feather', { sig: 'D10', gnd: 'GND1', vcc: '3V3' }, SWEEP('10'));
  if (!feather.ran) {
    skip('the SAMD toolchain is unavailable');
  } else {
    console.log(`   Feather M0: ${feather.angles.map((a) => a?.toFixed(1) ?? '—').join(', ')}`);
    check(
      feather.angles.every((a) => a !== undefined && Math.abs(a - 90) < 1),
      'on a Feather M0 the shaft never moves, because the TC interrupt that makes the pulse is not modelled',
    );
    check(
      feather.notes.includes('no-effect:Servo.h'),
      'and the build report says so rather than reporting an unqualified success',
    );
  }
}

// ================================= 6. the same, one architecture further on ==
section('6. ESP32Servo compiles for a C3 and is reported as inert');
{
  const ESP_SWEEP = [
    '#include <ESP32Servo.h>',
    'Servo sv;',
    'void setup() { sv.attach(4); sv.write(0); }',
    'void loop() {',
    '  if (millis() > 3000) sv.write(180);',
    '  else if (millis() > 1500) sv.write(90);',
    '}',
  ].join('\n');

  const { ran, angles, notes } = await sweep(
    'board.esp32-c3',
    { sig: 'IO4', gnd: 'GND1', vcc: '3V3_1' },
    ESP_SWEEP,
  );
  if (!ran) {
    skip('the ESP32 toolchain is unavailable');
  } else {
    console.log(`   angles: ${angles.map((a) => a?.toFixed(1) ?? '—').join(', ')}`);
    check(
      angles.every((a) => a !== undefined && Math.abs(a - 90) < 1),
      'the shaft never moves — LEDC is not in the C3 peripheral map',
    );
    check(notes.includes('no-effect:ESP32Servo.h'), 'and the build report says so');
  }
}

// ============ 7. the workaround the manifest offers is one that actually works =
section('7. the suggested workaround is not a suggestion, it is tested');
{
  // libraries.json tells a Pico user to write the pulse directly. That advice
  // is worth exactly as much as a test of it, so here it is: the same board,
  // the same servo, no library.
  const MANUAL = [
    'int w = 1000;',
    'void setup() { pinMode(15, OUTPUT); }',
    'void loop() {',
    '  digitalWrite(15, HIGH); delayMicroseconds(w); digitalWrite(15, LOW); delay(20);',
    '  if (millis() > 3000) w = 2000; else if (millis() > 1500) w = 1500;',
    '}',
  ].join('\n');

  const { ran, angles } = await sweep(
    'board.raspberry-pi-pico',
    { sig: 'GP15', gnd: 'GND3', vcc: '3V3' },
    MANUAL,
  );
  if (!ran) {
    skip('the RP2040 toolchain is unavailable');
  } else {
    const [a0, a90, a180] = angles;
    console.log(`   1.0 ms → ${a0?.toFixed(1)}°   1.5 ms → ${a90?.toFixed(1)}°   2.0 ms → ${a180?.toFixed(1)}°`);
    check(a0 !== undefined && a0 < 15, `a hand-written 1 ms pulse works on a Pico (${a0?.toFixed(1)}°)`);
    check(a180 !== undefined && a180 > 165, `and 2 ms reaches the other end (${a180?.toFixed(1)}°)`);
    check(
      a0 !== undefined && a90 !== undefined && a180 !== undefined && a0 < a90 && a90 < a180,
      'so the gap is the library, not the board — which is what the manifest claims',
    );
  }
}

console.log(
  failures === 0
    ? `\nPinned library checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
