// What the starter templates actually do, measured rather than assumed.
//
// A starter is the first thing a new user opens, and a bad one teaches them
// something false on their first try: a part that never reacts, a wire to a pin
// that does not exist, a validation warning on a circuit we shipped. None of
// that is visible from reading the template source, because the template source
// is a list of instances and wires and the failure is in what they add up to.
//
// So this builds every template the way the dashboard does and asks the same
// questions the app would:
//
//   * does every part and pin it names actually exist;
//   * does it survive a save and reopen with every wire intact;
//   * what does the validator say about it — any error is a bug we shipped;
//   * is every part in it one that reacts to firmware, or is there something
//     on the canvas that will sit there doing nothing;
//   * does it compile, and does firmware actually drive what it claims to.
//
// Run: npx tsx tools/audit/templateAudit.mts [--no-build]
// The last two need the compiler service; without it they are reported as
// unknown rather than as passes.

import { PROJECT_TEMPLATES } from '../../src/project/templates';
import { normalizeProject } from '../../src/project/projectService';
import { resolveDefinition } from '../../src/project/partsRegistry';
import { validateProject } from '../../src/validation/validator';
import { resolveWorkspaceTargets } from '../../src/compiler/targets';
import { simulationController } from '../../src/simulation/simulationController';
import { runnerPinIndex, runnerPinCount } from '../../src/simulation/boardRunner';
import { runTest } from '../../src/testing/testRunner';
import type { CircuitProject } from '../../src/types';

const BUILD = !process.argv.includes('--no-build');

interface Finding {
  template: string;
  severity: 'error' | 'warning' | 'note';
  text: string;
}

const findings: Finding[] = [];
const add = (template: string, severity: Finding['severity'], text: string) =>
  findings.push({ template, severity, text });

/** Every pin a project's wires touch, checked against the definitions. */
function checkReferences(name: string, p: CircuitProject) {
  const instances = [...p.boardInstances, ...p.componentInstances];
  for (const inst of instances) {
    if (!resolveDefinition(inst.definitionId, p)) {
      add(name, 'error', `instance references a part that does not exist: ${inst.definitionId}`);
    }
  }
  const byId = new Map(instances.map((i) => [i.id, i]));
  for (const c of p.connections) {
    for (const [instId, pinId, side] of [
      [c.sourceComponentId, c.sourcePinId, 'source'],
      [c.targetComponentId, c.targetPinId, 'target'],
    ] as const) {
      const inst = byId.get(instId);
      if (!inst) {
        add(name, 'error', `wire ${side} points at an instance that is not in the project`);
        continue;
      }
      const def = resolveDefinition(inst.definitionId, p);
      const pin = def?.pins.find((x) => x.id === pinId || (x.aliases ?? []).includes(pinId));
      if (!pin) add(name, 'error', `wire ${side} names pin "${pinId}", which ${def?.name ?? '?'} does not have`);
    }
  }
}

/** A template must survive the save/open path the dashboard puts it through. */
function checkRoundTrip(name: string, p: CircuitProject) {
  const before = p.connections.length;
  const reopened = normalizeProject(JSON.parse(JSON.stringify(p)));
  if (reopened.connections.length !== before) {
    add(
      name,
      'error',
      `opening it drops ${before - reopened.connections.length} of ${before} wires — they point at pins that do not resolve`,
    );
  }
}

/** Anything the validator says about a circuit we shipped is our problem. */
function checkValidation(name: string, p: CircuitProject) {
  const issues = validateProject(p);
  for (const i of issues.filter((x) => x.severity === 'error')) {
    add(name, 'error', `validator: ${i.title}`);
  }
  for (const i of issues.filter((x) => x.severity === 'warning')) {
    add(name, 'warning', `validator: ${i.title}`);
  }
  const infos = issues.filter((i) => i.severity === 'info');
  if (infos.length > 0) add(name, 'note', `${infos.length} info notice(s): ${infos.map((i) => i.ruleId).join(', ')}`);
}

/** A part on a starter's canvas that cannot react is a part that teaches nothing. */
function checkHonesty(name: string, p: CircuitProject) {
  for (const inst of p.componentInstances) {
    const def = resolveDefinition(inst.definitionId, p);
    if (!def) continue;
    if (def.category === 'Breadboards') continue;
    if (def.supportLevel !== 'simulated') {
      add(name, 'warning', `${def.name} is ${def.supportLevel}, so it will sit on the canvas doing nothing`);
    }
  }
  for (const inst of p.boardInstances) {
    const def = resolveDefinition(inst.definitionId, p);
    if (def && def.supportLevel !== 'simulated') {
      add(name, 'error', `the board (${def.name}) is ${def.supportLevel} — this starter cannot run at all`);
    }
  }
}

/** Does the sketch drive anything the canvas is wired to? */
function checkWiredPinsUsed(name: string, p: CircuitProject) {
  const board = p.boardInstances[0];
  const def = board ? resolveDefinition(board.definitionId, p) : undefined;
  if (!board || !def) {
    add(name, 'error', 'no board in the project');
    return;
  }
  const source = p.codeFiles.map((f) => f.content).join('\n');
  const wiredPins = new Set<string>();
  for (const c of p.connections) {
    if (c.sourceComponentId === board.id) wiredPins.add(c.sourcePinId);
    if (c.targetComponentId === board.id) wiredPins.add(c.targetPinId);
  }
  for (const pinId of wiredPins) {
    const index = runnerPinIndex(def, pinId);
    if (index === undefined) continue; // power, ground, reset: not driven by code
    const mentioned =
      new RegExp(`\\b${index}\\b`).test(source) ||
      new RegExp(`\\bA${index - 14}\\b`).test(source) ||
      new RegExp(`\\b${pinId}\\b`).test(source);
    if (!mentioned) {
      // A note rather than a warning: a sketch may drive a pin it never names,
      // by computing the number in a loop (`digitalWrite(2 + s, ...)`). Worth
      // looking at, not worth calling a defect.
      add(name, 'note', `${pinId} is wired but its number never appears literally in the sketch`);
    }
  }
  if (runnerPinCount(def) === 0) add(name, 'error', `${def.name} has no runner pin map`);
}

// ------------------------------------------------------------------- run

console.log(`Auditing ${PROJECT_TEMPLATES.length} starter templates\n`);

const built: { name: string; project: CircuitProject }[] = [];
for (const template of PROJECT_TEMPLATES) {
  let project: CircuitProject;
  try {
    project = template.build();
  } catch (err) {
    add(template.name, 'error', `build() threw: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  built.push({ name: template.name, project });
  checkReferences(template.name, project);
  checkRoundTrip(template.name, project);
  checkValidation(template.name, project);
  checkHonesty(template.name, project);
  checkWiredPinsUsed(template.name, project);

  if (!template.description || template.description.length < 20) {
    add(template.name, 'warning', 'the description is too short to tell a new user what they are opening');
  }
}

if (BUILD) {
  for (const { name, project } of built) {
    const { targets, unbuildable } = resolveWorkspaceTargets(project);
    if (unbuildable.length > 0) {
      add(name, 'error', `not buildable: ${unbuildable.map((u) => u.reason).join('; ')}`);
      continue;
    }
    simulationController.stop();
    const report = await simulationController.build(project);
    const build = report.builds[0];
    if (!report.anyRunnable) {
      add(name, 'note', 'the toolchain is unavailable here, so compile and run were not checked');
      continue;
    }
    if (build?.status !== 'built') {
      add(name, 'error', `does not compile: ${build?.detail ?? 'no build'}`);
      continue;
    }
    // Its own test bench, run on a fresh headless emulator against the real
    // compiled firmware. This replaced a cruder check — sampling pin levels
    // every 10 ms and asking whether anything moved — which reported the
    // ultrasonic starter as dead because a 10 microsecond TRIG pulse falls
    // between two samples. A bench states what the starter claims, in the
    // vocabulary the app already has, and the emulator answers it exactly.
    const firmware = build?.result?.firmware?.data;
    const boardId = build?.result?.boardId;
    if (project.tests.length === 0) {
      add(name, 'warning', 'nothing asserts this starter works — it compiles, and that is all anyone knows');
      console.log(`   ${name}: built (no bench)`);
      continue;
    }
    if (!firmware || !boardId) {
      add(name, 'error', 'the build produced no firmware to test with');
      continue;
    }
    for (const test of project.tests) {
      const result = await runTest(project, { hex: firmware, boardId }, test);
      const failed = result.assertionResults.filter((a) => !a.passed);
      if (result.status === 'passed') {
        console.log(`   ${name}: "${test.name}" passed (${result.assertionResults.length} assertions)`);
      } else if (result.status === 'error') {
        add(name, 'error', `bench "${test.name}" could not run: ${result.message}`);
      } else {
        add(
          name,
          'error',
          `bench "${test.name}" failed: ` +
            failed.map((a) => `expected ${a.expected}, got ${a.actual}`).join('; '),
        );
      }
    }
    simulationController.stop();
  }
}

// ---------------------------------------------------------------- report

const byTemplate = new Map<string, Finding[]>();
for (const f of findings) byTemplate.set(f.template, [...(byTemplate.get(f.template) ?? []), f]);

console.log('\n================ audit ================\n');
for (const template of PROJECT_TEMPLATES) {
  const list = byTemplate.get(template.name) ?? [];
  const errors = list.filter((f) => f.severity === 'error').length;
  const warnings = list.filter((f) => f.severity === 'warning').length;
  const mark = errors > 0 ? 'BROKEN ' : warnings > 0 ? 'WEAK   ' : 'OK     ';
  console.log(`${mark} ${template.name}`);
  for (const f of list) {
    console.log(`         ${f.severity === 'error' ? '✗' : f.severity === 'warning' ? '!' : '·'} ${f.text}`);
  }
}

const errors = findings.filter((f) => f.severity === 'error').length;
const warnings = findings.filter((f) => f.severity === 'warning').length;
console.log(`\n${errors} error(s), ${warnings} warning(s) across ${PROJECT_TEMPLATES.length} templates.`);
process.exit(0);
