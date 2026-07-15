// Minimal promise wrapper over IndexedDB for CircuitDesk project storage.

import type { CircuitProject, CustomDefinition } from '../types';

const DB_NAME = 'circuitdesk';
const DB_VERSION = 1;
const PROJECTS = 'projects';
const CUSTOM_PARTS = 'customParts';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PROJECTS)) {
        db.createObjectStore(PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(CUSTOM_PARTS)) {
        db.createObjectStore(CUSTOM_PARTS, { keyPath: 'definition.id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function reqResult<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export async function dbPutProject(project: CircuitProject): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(PROJECTS, 'readwrite');
  tx.objectStore(PROJECTS).put(project);
  await txDone(tx);
}

export async function dbGetProject(id: string): Promise<CircuitProject | undefined> {
  const db = await openDb();
  const tx = db.transaction(PROJECTS, 'readonly');
  return reqResult(tx.objectStore(PROJECTS).get(id)) as Promise<CircuitProject | undefined>;
}

export async function dbListProjects(): Promise<CircuitProject[]> {
  const db = await openDb();
  const tx = db.transaction(PROJECTS, 'readonly');
  const all = (await reqResult(tx.objectStore(PROJECTS).getAll())) as CircuitProject[];
  return all;
}

export async function dbDeleteProject(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(PROJECTS, 'readwrite');
  tx.objectStore(PROJECTS).delete(id);
  await txDone(tx);
}

export async function dbPutCustomPart(part: CustomDefinition): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(CUSTOM_PARTS, 'readwrite');
  tx.objectStore(CUSTOM_PARTS).put(part);
  await txDone(tx);
}

export async function dbListCustomParts(): Promise<CustomDefinition[]> {
  const db = await openDb();
  const tx = db.transaction(CUSTOM_PARTS, 'readonly');
  return (await reqResult(tx.objectStore(CUSTOM_PARTS).getAll())) as CustomDefinition[];
}

export async function dbDeleteCustomPart(definitionId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(CUSTOM_PARTS, 'readwrite');
  tx.objectStore(CUSTOM_PARTS).delete(definitionId);
  await txDone(tx);
}
