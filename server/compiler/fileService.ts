import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const MAX_FILES = 24;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024;

const FILE_NAME_RE = /^[A-Za-z0-9_\-]{1,64}\.(ino|h|hpp|c|cpp)$/;

export class InputValidationError extends Error {}

export function validateFileName(name: string): void {
  if (typeof name !== 'string' || !FILE_NAME_RE.test(name)) {
    throw new InputValidationError(
      `Invalid file name "${String(name).slice(0, 80)}". File names may only contain letters, numbers, dashes and underscores, and must end in .ino, .h, .hpp, .c or .cpp.`,
    );
  }
}

export function validateFiles(files: { name: string; content: string }[]): void {
  if (!Array.isArray(files) || files.length === 0) {
    throw new InputValidationError('No source files were provided.');
  }
  if (files.length > MAX_FILES) {
    throw new InputValidationError(`Too many files (max ${MAX_FILES}).`);
  }
  let total = 0;
  const seen = new Set<string>();
  for (const f of files) {
    validateFileName(f.name);
    if (seen.has(f.name)) {
      throw new InputValidationError(`Duplicate file name "${f.name}".`);
    }
    seen.add(f.name);
    if (typeof f.content !== 'string') {
      throw new InputValidationError(`File "${f.name}" has no text content.`);
    }
    const bytes = Buffer.byteLength(f.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) {
      throw new InputValidationError(`File "${f.name}" exceeds the ${MAX_FILE_BYTES / 1024} KB limit.`);
    }
    total += bytes;
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new InputValidationError('Project source exceeds the total size limit.');
  }
  if (!files.some((f) => f.name.endsWith('.ino'))) {
    throw new InputValidationError('Project must contain at least one .ino sketch file.');
  }
}

export async function createBuildDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'circuitdesk-build-'));
}

export async function cleanupDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
}

export async function writeTextFile(dir: string, name: string, content: string): Promise<string> {
  const target = path.join(dir, name);
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
    throw new InputValidationError('Path traversal rejected.');
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, content, 'utf8');
  return resolved;
}

export async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    await stat(file);
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}
