// New Project has to mean new.
//
// It used to build a wired Blink: an Uno, a resistor, an LED, three wires, a
// test and a sketch. So the first thing a user did with a fresh project was
// delete somebody else's circuit, and anything they had been running stayed on
// screen underneath it. This proves both halves of the fix — the project that
// gets created is empty, and nothing from the previous one survives into it.

import 'fake-indexeddb/auto';

import { simulationController } from '../src/simulation/simulationController';
import { useSimulationStore } from '../src/simulation/simulationStore';
import { useEditorStore } from '../src/app/editorStore';
import { emptyProject, buildBlinkProject } from '../src/project/templates';
import { saveProject, loadProject, normalizeProject } from '../src/project/projectService';
import { sketchDocuments, sketchIdFor } from '../src/project/sketches';
import { validateProject } from '../src/validation/validator';
import { readFileSync } from 'node:fs';

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

// ======================= 1. the New Project button builds an empty project ==
section('1. the action wired to New Project');
{
  // The button's own source, so this cannot pass while the UI still calls the
  // Blink builder. A behavioural assertion alone would not catch a regression
  // that swapped the handler back.
  const dashboard = readFileSync('src/dashboard/Dashboard.tsx', 'utf8');
  const newProjectButton = /New project<\/button>|New project\s*\n\s*<\/button>/.test(dashboard);
  check(newProjectButton, 'the dashboard has a New project button');
  const handler = /createProject\(\(\) => emptyProject\(/.test(dashboard);
  check(handler, 'and it creates an empty project rather than a template');
  check(
    !/createProject\(\(\) => buildBlinkProject\('New Project'\)\)/.test(dashboard),
    'the old Blink-on-new-project handler is gone',
  );
}

// ============================== 2. what an empty project actually contains ==
section('2. the project that gets created');
{
  const p = emptyProject('Untitled Project');
  check(p.boardInstances.length === 0, `no board (${p.boardInstances.length})`);
  check(p.componentInstances.length === 0, `no components (${p.componentInstances.length})`);
  check(p.connections.length === 0, `no wires (${p.connections.length})`);
  check(p.tests.length === 0, `no test cases (${p.tests.length})`);
  check(p.customDefinitions.length === 0, 'no custom parts');
  check(typeof p.id === 'string' && p.id.length > 0, `a fresh project id (${p.id})`);
  check(p.name === 'Untitled Project', `a clean default name (${p.name})`);

  // Per-board sketches need a source model, so one blank sketch is expected —
  // and it must be the ordinary starter, not a worked example.
  const sketches = sketchDocuments(p);
  check(sketches.length === 1, `exactly one default sketch (${sketches.length})`);
  check(sketches[0].name === 'sketch.ino', `named sketch.ino (${sketches[0].name})`);
  check(/void setup\(\)/.test(sketches[0].content) && /void loop\(\)/.test(sketches[0].content), 'with the standard empty setup/loop');
  check(!/digitalWrite|pinMode|Serial\./.test(sketches[0].content), 'and no example code in it');

  // A blank canvas has nothing to complain about.
  check(validateProject(p).length === 0, `validation is silent on a blank project (${validateProject(p).length} issues)`);

  // Two new projects are two projects.
  check(emptyProject('a').id !== emptyProject('a').id, 'each new project gets its own id');
}

// ========== 3. creating a new project after running a populated one ========
section('3. nothing leaks from the project before it');
{
  const populated = normalizeProject(buildBlinkProject('Busy Project'));
  await saveProject(populated);

  const built = await simulationController.build(populated);
  for (const b of built.builds) console.log(`   build: ${b.detail}`);
  const started = built.anyRunnable && (await simulationController.start());

  if (!started) {
    skip('the AVR toolchain is unavailable — running the populated project first');
  } else {
    simulationController.pause();
    simulationController.advance(800);
    simulationController.publishNow();

    // Generate state of every kind the new project must not inherit.
    const before = useSimulationStore.getState();
    check(before.serialText.length > 0, `the populated project produced serial output (${before.serialText.length} chars)`);
    check(before.builds.length > 0, `and a build report (${before.builds.length})`);
    check(simulationController.boardInstanceIds.length === 1, 'and a running board');
    before.pressButton('some-part', true);
    before.setSensor('some-sensor', 42);
    useEditorStore.setState({ project: populated, validationIssues: validateProject(populated), lastCompile: null });
  }

  // This is what leaving the editor does — the route changing to a different
  // project id remounts the shell and runs exactly this.
  simulationController.closeProject();

  const after = useSimulationStore.getState();
  check(after.status === 'stopped', `the simulation is stopped (${after.status})`);
  check(after.error === null, 'with no stale error');
  check(simulationController.boardInstanceIds.length === 0, `no runners survive (${simulationController.boardInstanceIds.length})`);
  check(after.serialText === '', `no stale serial output (${JSON.stringify(after.serialText.slice(0, 40))})`);
  check(after.serialLineCount === 0, 'no stale serial line count');
  check(after.serialBoards.length === 0, `no stale serial targets (${after.serialBoards.length})`);
  check(after.serialTarget === null, 'no stale serial input target');
  check(after.builds.length === 0, `no stale build report (${after.builds.length})`);
  check(Object.keys(after.visuals).length === 0, `no stale component visuals (${Object.keys(after.visuals).length})`);
  check(after.simTimeMs === 0, `the clock is back to zero (${after.simTimeMs})`);
  check(after.pressedButtons.length === 0, 'no stale input state');
  check(Object.keys(after.sensorValues).length === 0, 'no stale sensor values');
  check(simulationController.buildReport.length === 0, 'the controller holds no build report');
  check(!simulationController.hasFirmware, 'and no firmware');

  // Now the new project opens.
  const fresh = emptyProject('Untitled Project');
  await saveProject(fresh);
  useEditorStore.setState({
    project: normalizeProject(fresh),
    activeFileId: fresh.codeFiles[0].id,
    activeBoardId: null,
    selection: { componentIds: [], connectionIds: [] },
    validationIssues: [],
    lastCompile: null,
    saveState: 'saved',
  });

  const editor = useEditorStore.getState();
  check(editor.project!.id === fresh.id, 'the editor is on the new project');
  check(editor.project!.id !== populated.id, 'which is a different project entirely');
  check(editor.project!.componentInstances.length === 0, 'zero components');
  check(editor.project!.boardInstances.length === 0, 'zero boards');
  check(editor.project!.connections.length === 0, 'zero wires');
  check(editor.validationIssues.length === 0, 'zero validation issues');
  check(editor.lastCompile === null, 'no previous compile result');
  check(editor.selection.componentIds.length === 0, 'nothing selected');
  check(editor.activeBoardId === null, 'no board scope carried over');
  check(sketchIdFor(editor.project!, 'nothing') === editor.project!.codeFiles[0].id, 'one clean sketch is the default');

  // And the project the user was in before is still there, untouched.
  const reloaded = await loadProject(populated.id);
  check(reloaded !== undefined, 'the previous project is still saved');
  check(reloaded!.componentInstances.length === populated.componentInstances.length, `with its components intact (${reloaded!.componentInstances.length})`);
  check(reloaded!.connections.length === populated.connections.length, `and its wires (${reloaded!.connections.length})`);
  check(reloaded!.codeFiles[0].content === populated.codeFiles[0].content, 'and its source byte for byte');
  check(reloaded!.name === 'Busy Project', `and its name (${reloaded!.name})`);
}

// ================================ 4. templates are still available =========
section('4. worked examples are still one click away');
{
  const blink = buildBlinkProject('Blink');
  check(blink.boardInstances.length === 1, 'the Blink template still builds a wired circuit');
  check(blink.componentInstances.length === 2, 'with its parts');
  check(blink.connections.length === 3, 'and its wires');
  check(/digitalWrite/.test(blink.codeFiles[0].content), 'and its example code');
}

simulationController.closeProject();
console.log(
  failures === 0
    ? `\nNew-project checks passed (${skipped} skipped).`
    : `\n${failures} check(s) FAILED (${skipped} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
