import learned from './learned.json';
import type { Length } from './compose';
import type { Candidate, GenreMemory, Memory } from './learn';
import { emptyGenreMemory } from './learn';
import type { GenreId } from './knowledge';
import type { Genome } from './genome';

// The app side of the beat maker: the memory that shipped with the app (from
// `npm run train`) plus what this browser has learned since (more training, ratings),
// and a Web Worker that does the breeding off the main thread.

const KEY = 'rnb.beatlab.v1.';
const SHIPPED = (learned as unknown as { memory: Memory; trainedAt?: string }).memory ?? {};
export const TRAINED_AT = (learned as unknown as { trainedAt?: string }).trainedAt ?? null;

export function shippedMemory(genre: GenreId): GenreMemory {
  return JSON.parse(JSON.stringify(SHIPPED[genre] ?? emptyGenreMemory()));
}

/**
 * This browser's memory for a style: the shipped one, plus local training and ratings.
 * When a newer training ships, local training gives way to it but your ratings are kept.
 */
export function loadMemory(genre: GenreId): GenreMemory {
  try {
    const raw = localStorage.getItem(KEY + genre);
    if (raw) {
      const local = { ...emptyGenreMemory(), ...JSON.parse(raw) } as GenreMemory & { basedOn?: string | null };
      if (local.basedOn === TRAINED_AT) return local;
      return { ...shippedMemory(genre), taste: local.taste ?? {} };
    }
  } catch { /* storage unavailable: use the shipped memory */ }
  return shippedMemory(genre);
}

export function saveMemory(genre: GenreId, mem: GenreMemory): void {
  try { localStorage.setItem(KEY + genre, JSON.stringify({ ...mem, basedOn: TRAINED_AT })); } catch { /* not saved; works for this visit */ }
}

export function forgetLocal(genre: GenreId): void {
  try { localStorage.removeItem(KEY + genre); } catch { /* ignore */ }
}

export interface LabRequest { genre: GenreId; memory: GenreMemory; length: Length; population: number; generations: number; rounds: number; seed: number; fix?: { bpm?: number; root?: number }; seedGenome?: Genome; tasteWeight: number }
export type LabMessage =
  | { type: 'progress'; round: number; gen: number; best: number; mean: number }
  | { type: 'done'; candidates: Candidate[]; memory: GenreMemory }
  | { type: 'error'; message: string };

export interface LabJob { result: Promise<{ candidates: Candidate[]; memory: GenreMemory }>; cancel(): void }

export function runLab(req: LabRequest, onProgress: (m: Extract<LabMessage, { type: 'progress' }>) => void): LabJob {
  const worker = new Worker(new URL('./lab.worker.ts', import.meta.url), { type: 'module' });
  let settle: ((v: never) => void) | null = null;
  const result = new Promise<{ candidates: Candidate[]; memory: GenreMemory }>((resolve, reject) => {
    settle = reject as never;
    worker.onmessage = (e: MessageEvent<LabMessage>) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m);
      else { worker.terminate(); if (m.type === 'done') resolve({ candidates: m.candidates, memory: m.memory }); else reject(new Error(m.message)); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'The beat maker stopped unexpectedly.')); };
    worker.postMessage(req);
  });
  return { result, cancel: () => { worker.terminate(); (settle as ((e: Error) => void) | null)?.(new Error('cancelled')); } };
}
