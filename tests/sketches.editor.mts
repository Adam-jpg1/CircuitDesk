// The editor half of per-board sketches.
//
// The store, not the pixels: which document a board opens, what happens to the
// other document while you are typing in this one, and whether "create separate
// sketch" splits exactly one board off. The one thing that must never happen is
// text loss — switching boards is a change of view, not a change of content.

import { useEditorStore } from '../src/app/editorStore';
import { emptyProject } from '../src/project/templates';
import { normalizeProject } from '../src/project/projectService';
import { boardsUsingSketch, sketchIdFor, sketchDocuments } from '../src/project/sketches';
import type { CircuitProject, ComponentInstance } from '../src/types';

const PICO = 'board.raspberry-pi-pico';
const UNO = 'board.arduino-uno';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

let seq = 0;
const uid = (p: string) => `${p}${++seq}`;

const store = useEditorStore;
/** Installs a project directly, the way `load()` would once it has one. */
function open(project: CircuitProject): void {
  const normalized = normalizeProject(project);
  store.setState({
    project: normalized,
    activeFileId: normalized.codeFiles[0]?.id ?? null,
    activeBoardId: null,
    saveState: 'saved',
  });
}

function board(definitionId: string, sketchId?: string, label?: string): ComponentInstance {
  return {
    id: uid('b'), definitionId, x: 0, y: 0, rotation: 0, properties: {}, simulationState: {},
    ...(sketchId ? { sketchId } : {}), ...(label ? { label } : {}),
  } as ComponentInstance;
}

function textOf(id: string): string | undefined {
  return store.getState().project?.codeFiles.find((f) => f.id === id)?.content;
}

// ================================ 1. opening a board opens its own document ==
{
  const p = emptyProject('editor');
  p.codeFiles = [
    { id: 'sa', name: 'sender.ino', content: '// sender', language: 'cpp' },
    { id: 'sb', name: 'receiver.ino', content: '// receiver', language: 'cpp' },
  ];
  const a = board(PICO, 'sa');
  const b = board(UNO, 'sb');
  p.boardInstances.push(a, b);
  open(p);

  check(store.getState().activeBoardId === null, 'a freshly opened project is not scoped to a board');

  store.getState().setActiveBoard(a.id);
  check(store.getState().activeFileId === 'sa', 'selecting a board opens the sketch it runs');
  check(store.getState().activeBoardId === a.id, 'and remembers which board is being viewed');

  store.getState().setActiveBoard(b.id);
  check(store.getState().activeFileId === 'sb', 'selecting the other board opens the other sketch');

  // Nothing about the documents changed by looking at them.
  check(textOf('sa') === '// sender' && textOf('sb') === '// receiver', 'switching view copied nothing');
  check(store.getState().project?.codeFiles.length === 2, 'and created nothing');

  // Picking a file directly leaves board scope, because the user chose a
  // document rather than a board.
  store.getState().setActiveFile('sa');
  check(store.getState().activeBoardId === null, 'choosing a file directly clears the board scope');
}

// ============================= 2. editing, switching, and switching back =====
{
  const p = emptyProject('editor');
  p.codeFiles = [
    { id: 'sa', name: 'a.ino', content: 'void setup(){}\nvoid loop(){}', language: 'cpp' },
    { id: 'sb', name: 'b.ino', content: 'void setup(){}\nvoid loop(){}', language: 'cpp' },
  ];
  const a = board(PICO, 'sa');
  const b = board(PICO, 'sb');
  p.boardInstances.push(a, b);
  open(p);

  const A_TEXT = 'void setup(){ pinMode(15, OUTPUT); }\nvoid loop(){ digitalWrite(15, HIGH); }';
  const B_TEXT = 'void setup(){ pinMode(16, INPUT); }\nvoid loop(){ digitalRead(16); }';

  store.getState().setActiveBoard(a.id);
  store.getState().updateCodeFile(store.getState().activeFileId!, A_TEXT);
  check(textOf('sa') === A_TEXT, "the first board's sketch takes the edit");
  check(textOf('sb') !== A_TEXT, 'and the other document is untouched');

  store.getState().setActiveBoard(b.id);
  check(store.getState().activeFileId === 'sb', 'switching boards shows the other document');
  store.getState().updateCodeFile(store.getState().activeFileId!, B_TEXT);
  check(textOf('sb') === B_TEXT, 'which takes its own edit');

  store.getState().setActiveBoard(a.id);
  check(store.getState().activeFileId === 'sa', 'switching back returns to the first document');
  check(textOf('sa') === A_TEXT, 'with every character of it still there');
  check(textOf('sb') === B_TEXT, 'and the second still holding its own');

  // Round trip a few more times: nothing may drift.
  for (let i = 0; i < 5; i++) {
    store.getState().setActiveBoard(b.id);
    store.getState().setActiveBoard(a.id);
  }
  check(textOf('sa') === A_TEXT && textOf('sb') === B_TEXT, 'repeated switching loses nothing');
}

// ========================= 3. shared sketches show the same document ========
{
  const p = emptyProject('editor');
  p.codeFiles = [{ id: 'sh', name: 'shared.ino', content: '// shared', language: 'cpp' }];
  const a = board(PICO, 'sh');
  const b = board(PICO, 'sh');
  p.boardInstances.push(a, b);
  open(p);

  store.getState().setActiveBoard(a.id);
  const openedForA = store.getState().activeFileId;
  store.getState().setActiveBoard(b.id);
  check(store.getState().activeFileId === openedForA, 'two boards on one sketch open the same document');

  // An edit made "on" one board is an edit to the document both run.
  store.getState().updateCodeFile('sh', '// edited once');
  check(textOf('sh') === '// edited once', 'editing it edits the one document');
  check(store.getState().project!.codeFiles.length === 1, 'there is still only one');
  check(boardsUsingSketch(store.getState().project!, 'sh').length === 2, 'and both boards still run it');
}

// ================================== 4. create separate sketch splits one =====
{
  const p = emptyProject('editor');
  p.codeFiles = [{ id: 'sh', name: 'shared.ino', content: '// original text', language: 'cpp' }];
  const a = board(PICO, 'sh');
  const b = board(PICO, 'sh');
  const c = board(PICO, 'sh');
  p.boardInstances.push(a, b, c);
  open(p);

  store.getState().createSeparateSketchForBoard(b.id);
  const project = store.getState().project!;
  const newId = sketchIdFor(project, b.id)!;

  check(newId !== 'sh', 'the board now has a sketch of its own');
  check(store.getState().activeFileId === newId, 'and the editor is showing it');
  check(store.getState().activeBoardId === b.id, 'still scoped to that board');
  check(textOf(newId) === '// original text', 'starting from exactly what it was running');
  check(sketchIdFor(project, a.id) === 'sh' && sketchIdFor(project, c.id) === 'sh', 'the other two are untouched');
  check(sketchDocuments(project).length === 2, 'one new document, not three');

  const names = sketchDocuments(project).map((f) => f.name);
  check(new Set(names).size === names.length, `the new name does not collide (${names.join(', ')})`);

  // Now they diverge, which is the entire point.
  store.getState().updateCodeFile(newId, '// its own text now');
  check(textOf('sh') === '// original text', 'editing the copy does not touch the shared original');
  check(textOf(newId) === '// its own text now', 'and the copy holds the new text');
}

// ================================= 5. assigning an existing sketch ==========
{
  const p = emptyProject('editor');
  p.codeFiles = [
    { id: 's1', name: 'one.ino', content: '// one', language: 'cpp' },
    { id: 's2', name: 'two.ino', content: '// two', language: 'cpp' },
  ];
  const a = board(PICO, 's1');
  const b = board(PICO, 's2');
  p.boardInstances.push(a, b);
  open(p);

  store.getState().assignSketchToBoard(b.id, 's1');
  const project = store.getState().project!;
  check(sketchIdFor(project, b.id) === 's1', 'the board now runs the sketch it was pointed at');
  check(store.getState().activeFileId === 's1', 'and the editor follows it there');
  check(textOf('s2') === '// two', 'the sketch it left still exists, with its text');
  check(sketchDocuments(project).length === 2, 'nothing was deleted');
  check(boardsUsingSketch(project, 's1').length === 2, 'the target sketch is now shared by two boards');
  check(boardsUsingSketch(project, 's2').length === 0, 'and the old one is used by none');
}

// ============================== 6. renaming is not reassignment =============
{
  const p = emptyProject('editor');
  p.codeFiles = [{ id: 's1', name: 'sketch.ino', content: '// text', language: 'cpp' }];
  const a = board(PICO, 's1');
  p.boardInstances.push(a);
  open(p);

  store.getState().renameSketchDocument('s1', 'motor-controller.ino');
  const project = store.getState().project!;
  check(project.codeFiles[0].name === 'motor-controller.ino', 'the sketch takes the new name');
  check(project.codeFiles[0].id === 's1', 'keeping its identity');
  check(sketchIdFor(project, a.id) === 's1', 'so the board still runs it');
  check(textOf('s1') === '// text', 'and the text is unchanged');
}

console.log(failures === 0 ? '\nSketch editor checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
