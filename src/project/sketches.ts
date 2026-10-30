// Which board runs which sketch.
//
// CircuitDesk runs several genuinely independent boards, but every one of them
// took its firmware from a single editor source. That made the obvious project
// — a sender and a receiver — awkward: you had to write one sketch that was
// both, and pick a role with an architecture conditional or a strapping pin.
//
// The fix is not "a string of code per board". Two nodes running identical
// firmware is a real and common thing, and copying the source into each of them
// would make editing it twice the user's problem. So a board *references* a
// source document:
//
//     sender.ino   <-- ESP32-C6 #1
//     receiver.ino <-- Pico #1
//                  <-- Pico #2
//
// The documents are the `codeFiles` the project already had. They already carry
// a stable id, a name and their text, and they already persist — so this adds
// one field to a board instance rather than a second parallel file system.
// A sketch's id is its identity; its name is what a person calls it, and
// renaming one is not renaming the other.
//
// Auxiliary files (.h, .cpp) are not sketches. They are shared by every board,
// as they are in an Arduino sketch folder, and they travel with whichever
// sketch is being built.

import { uid, type CircuitProject, type CodeFile, type ComponentInstance } from '../types';

/**
 * A sketch is a board's program: an .ino document, or a .py one for the boards
 * that run Python (the Raspberry Pi headers). Headers and .cpp files are not
 * sketches.
 */
export function isSketchFile(file: CodeFile): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith('.ino') || name.endsWith('.py');
}

/** Which kind of program a board runs: an Arduino sketch or a Python script. */
export type ProgramKind = 'ino' | 'py';

export function programKindOf(file: CodeFile): ProgramKind {
  return file.name.toLowerCase().endsWith('.py') ? 'py' : 'ino';
}

/** What a new Raspberry Pi script starts as: a blink, the hello world of GPIO. */
export const PYTHON_STARTER = `# Raspberry Pi GPIO in Python. Pins are BCM GPIO numbers (GPIO17 is 17).
from gpiozero import LED
from time import sleep

led = LED(17)

while True:
    led.on()
    sleep(0.5)
    led.off()
    sleep(0.5)
`;

/**
 * The document a board of `kind` should run: the first one of that kind, or a
 * new one (main.py with a starter blink, or an empty sketch.ino) added to the
 * project. A Pi is never handed an .ino, nor an Arduino board a .py.
 */
export function programFor(project: CircuitProject, kind: ProgramKind): { project: CircuitProject; sketchId: string } {
  const existing = project.codeFiles.find((f) => isSketchFile(f) && programKindOf(f) === kind);
  if (existing) return { project, sketchId: existing.id };
  const file: CodeFile =
    kind === 'py'
      ? { id: uid('file'), name: uniqueSketchName(project, 'main.py'), content: PYTHON_STARTER, language: 'python' }
      : { id: uid('file'), name: uniqueSketchName(project, 'sketch.ino'), content: '', language: 'cpp' };
  return { project: { ...project, codeFiles: [...project.codeFiles, file] }, sketchId: file.id };
}

/** Every sketch document in the project, in project order. */
export function sketchDocuments(project: CircuitProject): CodeFile[] {
  return project.codeFiles.filter(isSketchFile);
}

/**
 * The .h/.cpp files, which belong to the project rather than to one board.
 *
 * They go into every build, exactly as they would sitting next to a sketch in
 * an Arduino folder.
 */
export function supportFiles(project: CircuitProject): CodeFile[] {
  return project.codeFiles.filter((f) => !isSketchFile(f));
}

/**
 * The sketch a board falls back to when it has never been assigned one.
 *
 * The first sketch in the project, which for every project that existed before
 * this feature is the single source they were all sharing.
 */
export function defaultSketchId(project: CircuitProject): string | undefined {
  return sketchDocuments(project)[0]?.id;
}

function defaultSketchIdOfKind(project: CircuitProject, kind: ProgramKind): string | undefined {
  return project.codeFiles.find((f) => isSketchFile(f) && programKindOf(f) === kind)?.id;
}

/** The sketch id a board instance uses, resolved through the fallback. */
export function sketchIdFor(project: CircuitProject, boardInstanceId: string): string | undefined {
  const board = project.boardInstances.find((b) => b.id === boardInstanceId);
  const assigned = board?.sketchId;
  if (assigned && project.codeFiles.some((f) => f.id === assigned)) return assigned;
  return defaultSketchId(project);
}

export function sketchFor(project: CircuitProject, boardInstanceId: string): CodeFile | undefined {
  const id = sketchIdFor(project, boardInstanceId);
  return id ? project.codeFiles.find((f) => f.id === id) : undefined;
}

/** Board instances currently running a given sketch. */
export function boardsUsingSketch(project: CircuitProject, sketchId: string): ComponentInstance[] {
  return project.boardInstances.filter((b) => sketchIdFor(project, b.id) === sketchId);
}

/**
 * The files one board's build should contain.
 *
 * Its own sketch and nothing else's: the compiler merges every .ino it is
 * given, so handing it two boards' sketches would produce two `setup()`
 * definitions and a build error that has nothing to do with the user's code.
 * The sketch is named `sketch.ino` on the way out because that is the name the
 * builder treats as primary; the document keeps its own name here.
 */
export function filesForBoard(project: CircuitProject, boardInstanceId: string): CodeFile[] {
  const sketch = sketchFor(project, boardInstanceId);
  const support = supportFiles(project);
  // A Python script is the whole program; the .h/.cpp files are not its.
  if (sketch && programKindOf(sketch) === 'py') return [sketch];
  if (!sketch) return support;
  return [{ ...sketch, name: 'sketch.ino' }, ...support];
}

/**
 * Fills in assignments a project does not have yet.
 *
 * Idempotent, and the whole of the migration: a project written before this
 * feature has one sketch and no assignments, so every board ends up on it and
 * behaves exactly as it did. Nothing is renamed and no source is touched.
 */
export function ensureSketchAssignments(
  project: CircuitProject,
  /** The kind of program each board definition runs, when known. */
  kindOf?: (definitionId: string) => ProgramKind,
): CircuitProject {
  if (kindOf) {
    // Boards whose program is of the wrong kind (a Pi on an .ino, an Arduino
    // board on a .py) are moved to one of the right kind, created if need be.
    let p = project;
    let moved = false;
    const boardInstances = project.boardInstances.map((b) => {
      const want = kindOf(b.definitionId);
      const current = p.codeFiles.find((f) => f.id === (b.sketchId ?? defaultSketchIdOfKind(p, want)));
      if (current && isSketchFile(current) && programKindOf(current) === want) return b.sketchId ? b : { ...b, sketchId: current.id };
      const r = programFor(p, want);
      p = r.project;
      moved = true;
      return { ...b, sketchId: r.sketchId };
    });
    if (moved || boardInstances.some((b, i) => b !== project.boardInstances[i])) project = { ...p, boardInstances };
  }
  const sketches = sketchDocuments(project);
  // A project with no .ino at all gets one, which is what an empty project has
  // always been given.
  const codeFiles =
    sketches.length > 0
      ? project.codeFiles
      : [...project.codeFiles, { id: uid('file'), name: 'sketch.ino', content: '', language: 'cpp' as const }];
  const fallback = codeFiles.filter(isSketchFile)[0]!.id;
  const valid = new Set(codeFiles.filter(isSketchFile).map((f) => f.id));

  let changed = codeFiles !== project.codeFiles;
  const boardInstances = project.boardInstances.map((b) => {
    // An assignment pointing at a sketch that is gone is repaired rather than
    // left dangling — a board with no source would silently not build.
    if (b.sketchId && valid.has(b.sketchId)) return b;
    changed = true;
    return { ...b, sketchId: fallback };
  });
  if (!changed) return project;
  return { ...project, codeFiles, boardInstances };
}

/** A name no existing document is using, so two sketches never look alike. */
export function uniqueSketchName(project: CircuitProject, base: string): string {
  const used = new Set(project.codeFiles.map((f) => f.name.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let n = 2; n < 500; n++) {
    const candidate = `${stem}_${n}${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem}_${uid('s')}${ext}`;
}

/** Points a board at an existing sketch. Nothing is copied. */
export function assignSketch(project: CircuitProject, boardInstanceId: string, sketchId: string): CircuitProject {
  if (!project.codeFiles.some((f) => f.id === sketchId && isSketchFile(f))) return project;
  return {
    ...project,
    boardInstances: project.boardInstances.map((b) => (b.id === boardInstanceId ? { ...b, sketchId } : b)),
  };
}

/**
 * Gives one board a sketch of its own, starting from what it is running now.
 *
 * The source is cloned, not moved: the boards left behind keep the document
 * they were sharing, with its text unchanged. This is the moment a shared
 * sketch stops being shared for one board, and nothing about it should be
 * destructive.
 */
export function createSeparateSketch(
  project: CircuitProject,
  boardInstanceId: string,
  name?: string,
): { project: CircuitProject; sketchId: string } {
  const current = sketchFor(project, boardInstanceId);
  const board = project.boardInstances.find((b) => b.id === boardInstanceId);
  const suggested = name ?? `${slug(board?.label) ?? stem(current?.name ?? 'sketch')}.ino`;
  const file: CodeFile = {
    id: uid('file'),
    name: uniqueSketchName(project, suggested),
    content: current?.content ?? '',
    language: 'cpp',
  };
  const next: CircuitProject = {
    ...project,
    codeFiles: [...project.codeFiles, file],
    boardInstances: project.boardInstances.map((b) =>
      b.id === boardInstanceId ? { ...b, sketchId: file.id } : b,
    ),
  };
  return { project: next, sketchId: file.id };
}

/** Renames a sketch. Assignments are by id, so nothing else moves. */
export function renameSketch(project: CircuitProject, sketchId: string, name: string): CircuitProject {
  const trimmed = name.trim();
  if (!trimmed) return project;
  const withExt = /\.(ino|h|hpp|c|cpp)$/i.test(trimmed) ? trimmed : `${trimmed}.ino`;
  const taken = project.codeFiles.some((f) => f.id !== sketchId && f.name.toLowerCase() === withExt.toLowerCase());
  const final = taken ? uniqueSketchName(project, withExt) : withExt;
  return {
    ...project,
    codeFiles: project.codeFiles.map((f) => (f.id === sketchId ? { ...f, name: final } : f)),
  };
}

/**
 * A sketch left with no board on it.
 *
 * Reported rather than removed. Deleting a board is not a reason to delete the
 * code that was on it — the user may be about to add the board back, and code
 * they wrote should not disappear because a part left the canvas.
 */
export function unassignedSketches(project: CircuitProject): CodeFile[] {
  const used = new Set(project.boardInstances.map((b) => sketchIdFor(project, b.id)));
  return sketchDocuments(project).filter((f) => !used.has(f.id));
}

function stem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** A board's own label as a filename, when it has one worth using. */
function slug(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const cleaned = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 40) : undefined;
}
