import { analyzeRecording, type DetectMode, type VoiceAnalysis } from './analyze';

// Starts an analysis in a Web Worker. If workers are unavailable the same code runs on
// the main thread instead (it yields regularly, so the page still updates).

export interface AnalysisJob { result: Promise<VoiceAnalysis>; cancel(): void }
type Message = { type: 'progress'; fraction: number; stage: string } | { type: 'done'; result: VoiceAnalysis } | { type: 'error'; message: string };

export function startAnalysis(samples: Float32Array, sampleRate: number, mode: DetectMode, onProgress: (fraction: number, stage: string) => void): AnalysisJob {
  let worker: Worker | null = null;
  let cancelled = false;
  const result = new Promise<VoiceAnalysis>((resolve, reject) => {
    const inline = () => analyzeRecording(samples, sampleRate, mode, (f, s) => { if (!cancelled) onProgress(f, s); }).then(resolve, reject);
    try {
      worker = new Worker(new URL('./analyze.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      void inline();
      return;
    }
    let heard = false;
    worker.onmessage = (e: MessageEvent<Message>) => {
      heard = true;
      const m = e.data;
      if (m.type === 'progress') onProgress(m.fraction, m.stage);
      else {
        worker?.terminate();
        if (m.type === 'done') resolve(m.result); else reject(new Error(m.message));
      }
    };
    worker.onerror = () => {
      worker?.terminate();
      worker = null;
      // the worker script could not start at all: fall back rather than fail
      if (!heard && !cancelled) void inline(); else reject(new Error('The analysis stopped unexpectedly.'));
    };
    // a copy is sent, so the caller's samples stay usable for the fallback
    worker.postMessage({ samples, sampleRate, mode });
  });
  return { result, cancel: () => { cancelled = true; worker?.terminate(); worker = null; } };
}
