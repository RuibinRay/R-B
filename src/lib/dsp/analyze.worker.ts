import { analyzeRecording, type DetectMode } from './analyze';

// Runs the detection pipeline off the main thread so the page stays responsive.

interface Request { samples: Float32Array; sampleRate: number; mode: DetectMode }
const scope = self as unknown as { onmessage: ((e: MessageEvent<Request>) => void) | null; postMessage(message: unknown, transfer?: Transferable[]): void };

scope.onmessage = async (e) => {
  const { samples, sampleRate, mode } = e.data;
  try {
    const result = await analyzeRecording(samples, sampleRate, mode, (fraction, stage) => scope.postMessage({ type: 'progress', fraction, stage }));
    scope.postMessage({ type: 'done', result }, result.contour ? [result.contour.pitch.buffer] : []);
  } catch (err) {
    scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
