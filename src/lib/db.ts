import type { ID, Project } from '../types';

// Local persistence in IndexedDB: project documents in one store, audio bytes in another.
// Nothing leaves the browser.

export interface StoredAsset { id: ID; name: string; blob: Blob }
export interface ProjectSummary { id: ID; name: string; updatedAt: number; createdAt: number; bpm: number; tracks: number; clips: number }

const DB_NAME = 'rnb-studio';
let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open local storage.'));
  });
  return dbPromise;
}

function run<T>(store: 'projects' | 'assets', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error ?? new Error('Storage write was aborted (the browser may be out of space).'));
  }));
}

export const putProject = (p: Project): Promise<unknown> => run('projects', 'readwrite', (s) => s.put(p));
export const getProject = (id: ID): Promise<Project | undefined> => run('projects', 'readonly', (s) => s.get(id) as IDBRequest<Project | undefined>);
export const putAsset = (a: StoredAsset): Promise<unknown> => run('assets', 'readwrite', (s) => s.put(a));
export const getAsset = (id: ID): Promise<StoredAsset | undefined> => run('assets', 'readonly', (s) => s.get(id) as IDBRequest<StoredAsset | undefined>);

export async function listProjects(): Promise<ProjectSummary[]> {
  const all = await run('projects', 'readonly', (s) => s.getAll() as IDBRequest<Project[]>);
  return all
    .map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, createdAt: p.createdAt, bpm: p.bpm, tracks: p.tracks.length, clips: p.clips.length }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Delete a project and any audio that no other saved project still uses. */
export async function deleteProject(id: ID): Promise<void> {
  const all = await run('projects', 'readonly', (s) => s.getAll() as IDBRequest<Project[]>);
  const target = all.find((p) => p.id === id);
  await run('projects', 'readwrite', (s) => s.delete(id));
  if (!target) return;
  const stillUsed = new Set(all.filter((p) => p.id !== id).flatMap((p) => p.assets.map((a) => a.id)));
  for (const a of target.assets) {
    if (!stillUsed.has(a.id)) await run('assets', 'readwrite', (s) => s.delete(a.id));
  }
}

/** Delete stored audio that no saved project lists any more (`except` is the project doing the tidying). */
export async function dropUnusedAssets(ids: ID[], except: ID): Promise<void> {
  if (!ids.length) return;
  const all = await run('projects', 'readonly', (s) => s.getAll() as IDBRequest<Project[]>);
  const stillUsed = new Set(all.filter((p) => p.id !== except).flatMap((p) => p.assets.map((a) => a.id)));
  for (const id of ids) if (!stillUsed.has(id)) await run('assets', 'readwrite', (s) => s.delete(id));
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}
