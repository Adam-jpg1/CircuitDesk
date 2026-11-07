// Sketch documents, board assignments, and the migration into them.
//
// Everything here is pure project data — no compiler, no runtime — because the
// rules are about what happens to a user's source, and those are the rules that
// must never be got wrong. Losing someone's code to a UI action is the one
// failure that cannot be undone by pressing the button again.

import {
  ensureSketchAssignments,
  sketchIdFor,
  sketchFor,
  boardsUsingSketch,
  filesForBoard,
  assignSketch,
  createSeparateSketch,
  renameSketch,
  sketchDocuments,
  supportFiles,
  unassignedSketches,
  isSketchFile,
} from '../src/project/sketches';
import { normalizeProject } from '../src/project/projectService';
import { resolveWorkspaceTargets } from '../src/compiler/targets';
import { emptyProject } from '../src/project/templates';
import type { CircuitProject, ComponentInstance } from '../src/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(cond ? 'PASS:' : 'FAIL:', msg);
  if (!cond) failures++;
}

const board = (id: string, definitionId: string, extra: Partial<ComponentInstance> = {}): ComponentInstance =>
  ({ id, definitionId, x: 0, y: 0, rotation: 0, properties: {}, simulationState: {}, ...extra }) as ComponentInstance;

function projectWith(boards: ComponentInstance[], files: { id: string; name: string; content: string }[]): CircuitProject {
  const p = emptyProject('sketches');
  p.boardInstances = boards;
  p.codeFiles = files.map((f) => ({ ...f, language: 'cpp' as const }));
  return p;
}

// ======================================= 1. migrating a project from before ==
//
// The shape every existing project has: one source, no assignments. It must
// keep working with nobody touching anything.
{
  const old = projectWith(
    [board('b1', 'board.raspberry-pi-pico'), board('b2', 'board.raspberry-pi-pico'), board('b3', 'board.esp32-c6-devkitc-1')],
    [{ id: 'f1', name: 'sketch.ino', content: 'void setup(){}\nvoid loop(){}' }],
  );
  check(old.boardInstances.every((b) => b.sketchId === undefined), 'the old shape has no assignments to start with');

  const migrated = ensureSketchAssignments(old);
  check(migrated.boardInstances.every((b) => b.sketchId === 'f1'), 'every board lands on the one source that existed');
  check(migrated.codeFiles.length === 1, 'and no new document is invented');
  check(migrated.codeFiles[0].content === old.codeFiles[0].content, 'with the source untouched');
  check(boardsUsingSketch(migrated, 'f1').length === 3, 'all three boards share it, as they did before');

  // Idempotent: running it again changes nothing at all.
  const again = ensureSketchAssignments(migrated);
  check(again === migrated, 'a project that is already assigned is returned unchanged');

  // And it happens on load, without the caller asking.
  const loaded = normalizeProject(JSON.parse(JSON.stringify(old)));
  check(loaded.boardInstances.every((b) => b.sketchId === 'f1'), 'normalizeProject migrates on the way in');
  check(loaded.codeFiles[0].content === old.codeFiles[0].content, 'and still loses nothing');
}

// ====================================== 2. an assignment that has gone stale ==
{
  const p = ensureSketchAssignments(
    projectWith([board('b1', 'board.raspberry-pi-pico', { sketchId: 'missing' })], [{ id: 'f1', name: 'sketch.ino', content: 'x' }]),
  );
  check(p.boardInstances[0].sketchId === 'f1', 'a board pointing at a sketch that is gone is repaired, not left dangling');
  check(sketchFor(p, 'b1')?.content === 'x', 'and resolves to real source');
}

// ============================================ 3. what belongs in which build ==
{
  const p = ensureSketchAssignments(
    projectWith(
      [board('b1', 'board.raspberry-pi-pico', { sketchId: 'send' }), board('b2', 'board.raspberry-pi-pico', { sketchId: 'recv' })],
      [
        { id: 'send', name: 'sender.ino', content: 'SENDER' },
        { id: 'recv', name: 'receiver.ino', content: 'RECEIVER' },
        { id: 'hdr', name: 'shared.h', content: '#define N 1' },
      ],
    ),
  );
  check(sketchDocuments(p).length === 2, 'the .ino files are the sketches');
  check(supportFiles(p).length === 1 && supportFiles(p)[0].name === 'shared.h', 'and the header is not one');
  check(!isSketchFile(p.codeFiles[2]), 'a .h is not a sketch document');

  const forB1 = filesForBoard(p, 'b1');
  check(forB1.length === 2, `a board's build is its own sketch plus the shared files (${forB1.length})`);
  check(forB1[0].content === 'SENDER', 'the sketch is its own');
  check(forB1[0].name === 'sketch.ino', 'renamed to the primary name the builder expects');
  check(forB1.some((f) => f.name === 'shared.h'), 'and the header travels with it');
  // This is the one that matters: two .ino files in one build would merge into
  // two setup() definitions and fail on something the user did not write.
  check(!forB1.some((f) => f.content === 'RECEIVER'), 'the other board\'s sketch is not in this build');
  check(filesForBoard(p, 'b2')[0].content === 'RECEIVER', 'and the other board gets its own');
}

// ================================================= 4. create separate sketch ==
//
// The interaction that must never lose text: two boards on one document, one of
// them asked for a copy of its own.
{
  const start = ensureSketchAssignments(
    projectWith(
      [board('b1', 'board.raspberry-pi-pico'), board('b2', 'board.raspberry-pi-pico')],
      [{ id: 'f1', name: 'shared.ino', content: 'ORIGINAL SOURCE' }],
    ),
  );
  check(boardsUsingSketch(start, 'f1').length === 2, 'both boards start on one sketch');

  const { project: after, sketchId } = createSeparateSketch(start, 'b2');
  check(sketchId !== 'f1', 'the new sketch has an id of its own');
  check(after.codeFiles.length === 2, `and is a second document (${after.codeFiles.length})`);
  check(after.codeFiles.find((f) => f.id === sketchId)?.content === 'ORIGINAL SOURCE', 'starting from what that board was running');
  check(after.codeFiles.find((f) => f.id === 'f1')?.content === 'ORIGINAL SOURCE', 'and the original is untouched');
  check(sketchIdFor(after, 'b1') === 'f1', 'the other board stays where it was');
  check(sketchIdFor(after, 'b2') === sketchId, 'and only the asking board moves');
  check(after.codeFiles.find((f) => f.id === sketchId)!.name !== 'shared.ino', 'the copy gets a name of its own');

  // Editing one no longer edits the other, which is the whole point.
  const edited: CircuitProject = {
    ...after,
    codeFiles: after.codeFiles.map((f) => (f.id === sketchId ? { ...f, content: 'CHANGED' } : f)),
  };
  check(sketchFor(edited, 'b2')?.content === 'CHANGED', 'editing the new sketch changes that board');
  check(sketchFor(edited, 'b1')?.content === 'ORIGINAL SOURCE', 'and leaves the other board alone');
}

// ================================================== 5. assign existing sketch ==
{
  const p = ensureSketchAssignments(
    projectWith(
      [
        board('b1', 'board.raspberry-pi-pico', { sketchId: 'send' }),
        board('b2', 'board.raspberry-pi-pico', { sketchId: 'recv' }),
        board('b3', 'board.raspberry-pi-pico', { sketchId: 'send' }),
      ],
      [
        { id: 'send', name: 'sender.ino', content: 'S' },
        { id: 'recv', name: 'receiver.ino', content: 'R' },
      ],
    ),
  );
  const after = assignSketch(p, 'b3', 'recv');
  check(sketchIdFor(after, 'b3') === 'recv', 'a board can be pointed at an existing sketch');
  check(after.codeFiles.length === 2, 'without duplicating it');
  check(boardsUsingSketch(after, 'recv').length === 2, 'so two boards now share it');
  check(boardsUsingSketch(after, 'send').length === 1, 'and the one it left has one board');

  const bogus = assignSketch(after, 'b3', 'nonexistent');
  check(bogus === after, 'assigning a sketch that does not exist does nothing');
}

// ================================================ 6. names are not identities ==
{
  const p = ensureSketchAssignments(
    projectWith(
      [board('b1', 'board.raspberry-pi-pico', { sketchId: 'f1', label: 'Sensor Node' })],
      [{ id: 'f1', name: 'receiver.ino', content: 'R' }],
    ),
  );
  const renamed = renameSketch(p, 'f1', 'sensor_receiver.ino');
  check(renamed.codeFiles[0].name === 'sensor_receiver.ino', 'a sketch can be renamed');
  check(renamed.codeFiles[0].id === 'f1', 'keeping its id');
  check(sketchIdFor(renamed, 'b1') === 'f1', 'so the assignment survives');
  check(renamed.boardInstances[0].label === 'Sensor Node', 'and the board keeps its own name');

  // The other direction: renaming the board leaves the sketch alone.
  const boardRenamed: CircuitProject = {
    ...renamed,
    boardInstances: renamed.boardInstances.map((b) => ({ ...b, label: 'Display Node' })),
  };
  check(boardRenamed.codeFiles[0].name === 'sensor_receiver.ino', 'renaming the board does not rename the sketch');

  // A name that is already taken does not silently overwrite the other file.
  const two = ensureSketchAssignments(
    projectWith([board('b1', 'board.raspberry-pi-pico')], [
      { id: 'f1', name: 'a.ino', content: 'A' },
      { id: 'f2', name: 'b.ino', content: 'B' },
    ]),
  );
  const collided = renameSketch(two, 'f2', 'a.ino');
  check(collided.codeFiles.find((f) => f.id === 'f2')?.name !== 'a.ino', 'a colliding name is made unique');
  check(collided.codeFiles.find((f) => f.id === 'f1')?.name === 'a.ino', 'and the existing file keeps its own');
  check(new Set(collided.codeFiles.map((f) => f.name)).size === 2, 'so no two documents share a name');
}

// ==================================== 7. removing a board does not lose code ==
{
  const p = ensureSketchAssignments(
    projectWith(
      [board('b1', 'board.raspberry-pi-pico', { sketchId: 'f1' }), board('b2', 'board.raspberry-pi-pico', { sketchId: 'f2' })],
      [
        { id: 'f1', name: 'a.ino', content: 'KEEP ME' },
        { id: 'f2', name: 'b.ino', content: 'ALSO KEEP ME' },
      ],
    ),
  );
  const removed: CircuitProject = { ...p, boardInstances: p.boardInstances.filter((b) => b.id !== 'b2') };
  check(removed.codeFiles.length === 2, 'deleting a board leaves its sketch in the project');
  check(removed.codeFiles.find((f) => f.id === 'f2')?.content === 'ALSO KEEP ME', 'with its text intact');
  check(unassignedSketches(removed).map((f) => f.id).join(',') === 'f2', 'and it is reported as unassigned rather than deleted');

  // Even normalising the project again must not tidy it away.
  const reloaded = normalizeProject(JSON.parse(JSON.stringify(removed)));
  check(reloaded.codeFiles.length === 2, 'a save and reload keeps the orphan');
  check(reloaded.codeFiles.find((f) => f.id === 'f2')?.content === 'ALSO KEEP ME', 'still with its text');
}

// ============================================ 8. duplicating a board shares ==
//
// Duplication goes through the editor's clipboard, which structuredClones the
// instance — so the copy carries the same sketchId. That is the behaviour we
// want, and this is what stops a future refactor from quietly changing it.
{
  const p = ensureSketchAssignments(
    projectWith([board('b1', 'board.raspberry-pi-pico', { sketchId: 'f1' })], [{ id: 'f1', name: 'receiver.ino', content: 'R' }]),
  );
  const copy = { ...structuredClone(p.boardInstances[0]), id: 'b2' };
  const after: CircuitProject = { ...p, boardInstances: [...p.boardInstances, copy] };
  check(copy.sketchId === 'f1', 'a duplicated board references the same sketch');
  check(boardsUsingSketch(after, 'f1').length === 2, 'so the two of them share one document');
  check(after.codeFiles.length === 1, 'and nothing was copied');

  // ...and it can then be separated, which is the documented escape hatch.
  const { project: separated } = createSeparateSketch(after, 'b2');
  check(separated.codeFiles.length === 2, 'the duplicate can be given its own sketch afterwards');
  check(sketchIdFor(separated, 'b1') === 'f1', 'leaving the original where it was');
}

// ================================== 9. the build unit is target plus sketch ==
{
  const shared = ensureSketchAssignments(
    projectWith(
      [board('b1', 'board.raspberry-pi-pico'), board('b2', 'board.raspberry-pi-pico')],
      [{ id: 'f1', name: 'shared.ino', content: 'S' }],
    ),
  );
  const t1 = resolveWorkspaceTargets(shared);
  check(t1.targets.length === 1, `two Picos on one sketch is one build (${t1.targets.length})`);
  check(t1.targets[0].instanceIds.length === 2, 'serving both boards');
  check(t1.targets[0].sketchName === 'shared.ino', 'named by the sketch it compiles');

  const split = assignSketch(
    { ...shared, codeFiles: [...shared.codeFiles, { id: 'f2', name: 'other.ino', content: 'O', language: 'cpp' }] },
    'b2',
    'f2',
  );
  const t2 = resolveWorkspaceTargets(split);
  check(t2.targets.length === 2, `two Picos on different sketches is two builds (${t2.targets.length})`);
  check(t2.targets.every((t) => t.fqbn === 'rp2040:rp2040:rpipico'), 'both for the same target');
  check(new Set(t2.targets.map((t) => t.sketchId)).size === 2, 'from two different sketches');

  const crossArch = ensureSketchAssignments(
    projectWith(
      [board('b1', 'board.raspberry-pi-pico'), board('b2', 'board.esp32-c6-devkitc-1')],
      [{ id: 'f1', name: 'shared.ino', content: 'S' }],
    ),
  );
  const t3 = resolveWorkspaceTargets(crossArch);
  check(t3.targets.length === 2, `one sketch on two architectures is two builds (${t3.targets.length})`);
  check(new Set(t3.targets.map((t) => t.sketchId)).size === 1, 'from one sketch');
  check(new Set(t3.targets.map((t) => t.fqbn)).size === 2, 'for two FQBNs');
}

console.log(failures === 0 ? '\nSketch model checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
