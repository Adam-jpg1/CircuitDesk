// The projects the community ships with must work when someone opens them.
//
// "Open a copy" on a project that does not build would be the first thing a
// newcomer learns about the community. So each one is held to what a starter
// template is held to: every part and pin exists, it survives a save and
// reopen, the validator finds nothing wrong with it, every part on it is
// simulated, and its sketch compiles and passes its own test bench on the
// emulator.

import { BUILTIN_PROJECTS } from '../src/community/builtinProjects';
import { normalizeProject } from '../src/project/projectService';
import { resolveDefinition } from '../src/project/partsRegistry';
import { validateProject } from '../src/validation/validator';
import { simulationController } from '../src/simulation/simulationController';
import { runTest } from '../src/testing/testRunner';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { readFileSync } from 'node:fs';

let failures = 0;
let skipped = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

check(BUILTIN_PROJECTS.length >= 9, `there are built-in projects (${BUILTIN_PROJECTS.length})`);
check(BUILTIN_PROJECTS.filter((s) => s.author === 'creator').length >= 5, 'including the creator\'s larger builds');
for (const c of BUILTIN_PROJECTS.filter((s) => s.author === 'creator')) {
  const built = c.build();
  check(built.componentInstances.length >= 3 && built.connections.length >= 12, `"${c.title}" is a real build (${built.componentInstances.length + built.boardInstances.length} parts, ${built.connections.length} wires)`);
}
check(new Set(BUILTIN_PROJECTS.map((s) => s.id)).size === BUILTIN_PROJECTS.length, 'with unique ids');

// The server ships the generated file, not this module; they must agree.
const shipped = JSON.parse(readFileSync('server/community/builtin.json', 'utf8')) as {
  posts: { id: string; title: string; baseLikes: number; creator: boolean; project: { codeFiles: { content: string }[] } }[];
};
for (const entry of BUILTIN_PROJECTS) {
  const post = shipped.posts.find((p) => p.id === entry.id);
  const sameCode = post?.project.codeFiles[0]?.content === entry.build().codeFiles[0]?.content;
  check(
    post !== undefined && post.title === entry.title && post.baseLikes === entry.baseLikes && post.creator === (entry.author === 'creator') && sameCode,
    `server/community/builtin.json is current for "${entry.title}" (regenerate with tools/community/buildBuiltins.mts)`,
  );
}
check(shipped.posts.length === BUILTIN_PROJECTS.length, 'and holds nothing else');

for (const entry of BUILTIN_PROJECTS) {
  console.log(`\n--- ${entry.title}`);
  const p = entry.build();
  const instances = [...p.boardInstances, ...p.componentInstances];
  const byId = new Map(instances.map((i) => [i.id, i]));
  let refsOk = true;
  for (const c of p.connections) {
    for (const [id, pin] of [[c.sourceComponentId, c.sourcePinId], [c.targetComponentId, c.targetPinId]]) {
      const def = resolveDefinition(byId.get(id)?.definitionId ?? '', p);
      if (!def?.pins.some((x) => x.id === pin || (x.aliases ?? []).includes(pin))) {
        refsOk = false;
        console.log(`   no pin ${pin} on ${def?.name ?? id}`);
      }
    }
  }
  check(refsOk, 'every wire lands on a real pin');
  const reopened = normalizeProject(JSON.parse(JSON.stringify(p)));
  check(reopened.connections.length === p.connections.length, 'it survives a save and reopen with every wire');
  const issues = validateProject(p).filter((i) => i.severity !== 'info');
  check(issues.length === 0, `the validator has nothing to say${issues.map((i) => ` — ${i.severity}: ${i.title}`).join('')}`);
  const unsimulated = instances.map((i) => resolveDefinition(i.definitionId, p)).filter((d) => d && d.supportLevel !== 'simulated');
  check(unsimulated.length === 0, `every part is simulated${unsimulated.map((d) => ` — ${d!.name}`).join('')}`);
  check(p.tests.length > 0, 'it has a test bench');

  simulationController.stop();
  const report = await simulationController.build(p);
  if (!report.anyRunnable) {
    console.log('SKIP: the toolchain is unavailable, so it was not compiled');
    skipped++;
    continue;
  }
  for (const b of report.builds) check(b.status === 'built', `it compiles (${b.detail})`);
  const build = report.builds[0];
  const firmware = build?.result?.firmware;
  if (!firmware || !build?.result?.boardId) continue;
  for (const test of p.tests) {
    const result = await runTest(p, { data: firmware.data, boardId: build.result.boardId, format: firmware.format, regions: firmware.regions }, test);
    const failed = result.assertionResults.filter((a) => !a.passed);
    check(
      result.status === 'passed',
      `its bench "${test.name}" passes${result.message ? ` — ${result.message}` : ''}${failed.map((a) => ` — expected ${a.expected}, got ${a.actual}`).join('')}`,
    );
  }
  simulationController.stop();

  // A bench runs one board. A project with several is also run whole, every
  // board at once, and held to what that must produce.
  if (entry.together && p.boardInstances.length > 1) {
    simulationController.stop();
    await simulationController.build(p);
    const started = await simulationController.start();
    check(started, `all ${p.boardInstances.length} boards start together`);
    if (started) {
      simulationController.pause();
      for (const key of entry.together.contacts(p)) useSimulationStore.getState().pressButton(key, true);
      simulationController.advance(entry.together.runMs);
      simulationController.publishNow();
      const text = useSimulationStore.getState().serialText;
      for (const line of entry.together.expectSerial) {
        check(text.includes(line), `${entry.together.description} — "${line}"`);
      }
      useSimulationStore.getState().resetInputs();
    }
    simulationController.stop();
  }
}

console.log(`\n--- ${failures} failing, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
