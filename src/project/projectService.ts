import { dbGetProject, dbListProjects, dbPutProject, dbDeleteProject } from '../persistence/db';
import { resolveDefinition } from './partsRegistry';
import { ensureSketchAssignments } from './sketches';
import { migratePinIds } from './pinMigrations';
import { revalidateEmbeddedBoards } from '../custom-boards/projectBoards';
import {
  PROJECT_SCHEMA_VERSION,
  uid,
  type CircuitProject,
  type ProjectMeta,
  type SupportLevel,
} from '../types';

export function projectMeta(p: CircuitProject): ProjectMeta {
  const primaryBoardInst = p.boardInstances[0];
  const primaryDef = primaryBoardInst ? resolveDefinition(primaryBoardInst.definitionId, p) : undefined;
  const supportLevel: SupportLevel = primaryDef?.supportLevel ?? 'visual-only';
  return {
    id: p.id,
    name: p.name,
    updatedAt: p.updatedAt,
    createdAt: p.createdAt,
    primaryBoard: primaryDef?.name ?? 'No board',
    componentCount: p.componentInstances.length + p.boardInstances.length,
    supportLevel,
    thumbnailSvg: p.thumbnailSvg,
  };
}

export async function listProjectMetas(): Promise<ProjectMeta[]> {
  const all = await dbListProjects();
  return all
    .map(projectMeta)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function saveProject(p: CircuitProject): Promise<void> {
  await dbPutProject(p);
}

export async function loadProject(id: string): Promise<CircuitProject | undefined> {
  const raw = await dbGetProject(id);
  if (!raw) return undefined;
  return normalizeProject(raw);
}

export async function deleteProject(id: string): Promise<void> {
  await dbDeleteProject(id);
}

export async function duplicateProject(id: string): Promise<CircuitProject | undefined> {
  const src = await loadProject(id);
  if (!src) return undefined;
  const copy = structuredClone(src);
  copy.id = uid('proj');
  copy.name = `${src.name} (copy)`;
  const now = new Date().toISOString();
  copy.createdAt = now;
  copy.updatedAt = now;
  await saveProject(copy);
  return copy;
}

export class ProjectValidationError extends Error {}

/** Validates and repairs a project object loaded from storage or import. */
export function normalizeProject(raw: unknown): CircuitProject {
  if (!raw || typeof raw !== 'object') throw new ProjectValidationError('Project data is not an object.');
  const p = raw as Partial<CircuitProject>;
  if (typeof p.id !== 'string' || typeof p.name !== 'string') {
    throw new ProjectValidationError('Project is missing id or name.');
  }
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const project: CircuitProject = {
    id: p.id,
    name: p.name,
    version: typeof p.version === 'string' ? p.version : PROJECT_SCHEMA_VERSION,
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : new Date().toISOString(),
    boardInstances: arr(p.boardInstances),
    componentInstances: arr(p.componentInstances),
    connections: arr(p.connections),
    codeFiles: arr(p.codeFiles),
    tests: arr(p.tests),
    customDefinitions: arr(p.customDefinitions),
    settings: p.settings && typeof p.settings === 'object' ? p.settings : {},
    thumbnailSvg: typeof p.thumbnailSvg === 'string' ? p.thumbnailSvg : undefined,
  };
  const major = project.version.split('.')[0];
  if (major !== PROJECT_SCHEMA_VERSION.split('.')[0]) {
    throw new ProjectValidationError(
      `Project schema version ${project.version} is not compatible with this build (expected ${PROJECT_SCHEMA_VERSION}).`,
    );
  }
  if (project.codeFiles.length === 0) {
    project.codeFiles = [{ id: uid('file'), name: 'sketch.ino', content: '', language: 'cpp' }];
  }
  // Pin renames, BEFORE the filter below drops connections whose pin does not
  // exist: a renamed pin looks exactly like a deleted one to that filter, so a
  // migration that ran after it would have nothing left to migrate.
  const migrated = migratePinIds(project);
  if (migrated.moved.length > 0) {
    console.info(
      `[CircuitDesk] moved ${migrated.moved.length} wire endpoint(s) onto renamed pins: ` +
      migrated.moved.map((m) => `${m.definitionId} ${m.from}→${m.to}`).join(', '),
    );
  }
  // Custom boards are re-derived from their descriptions before anything reads
  // them. A project file can say a board is simulated; only the profiles decide
  // whether it is, and this is where the file's opinion is discarded.
  const boards = revalidateEmbeddedBoards(project);
  if (boards.disarmed.length > 0) {
    console.warn(
      `[CircuitDesk] ${boards.disarmed.length} custom board(s) in this project no longer describe a valid board ` +
      'and have been reduced to wiring only: ' +
      boards.disarmed.map((d) => `${d.boardId} — ${d.reason}`).join('; '),
    );
  }

  // The project has now been brought up to this build's schema, so it is saved
  // as such — which is also what stops a rename rule firing twice.
  project.version = PROJECT_SCHEMA_VERSION;

  // Sketch assignments. A project saved before per-board sketches has one
  // source and no assignments; every board is put on it, which is exactly what
  // it was already doing. Idempotent, so a new-format project is untouched.
  Object.assign(project, ensureSketchAssignments(project));
  // Drop connections that reference missing instances or pins.
  const instMap = new Map(
    [...project.boardInstances, ...project.componentInstances].map((i) => [i.id, i] as const),
  );
  project.connections = project.connections.filter((c) => {
    const a = instMap.get(c.sourceComponentId);
    const b = instMap.get(c.targetComponentId);
    if (!a || !b) return false;
    const da = resolveDefinition(a.definitionId, project);
    const db = resolveDefinition(b.definitionId, project);
    return Boolean(
      da?.pins.some((pin) => pin.id === c.sourcePinId) && db?.pins.some((pin) => pin.id === c.targetPinId),
    );
  });
  return project;
}
