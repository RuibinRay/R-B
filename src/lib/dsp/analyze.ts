import { detectMelody, type DetectedNote } from './pitch';
import { resample } from './resample';
import { classifyHits, detectOnsets, estimateTempo, fft } from './rhythm';

// The whole "what did you record?" pipeline, free of any browser API so that it can run
// in a Web Worker (keeping the page responsive) and in the automated tests.

export type DetectMode = 'auto' | 'melody' | 'rhythm';
/** `poly` means several notes sound at once: the caller should use the Basic Pitch model. */
export type DetectedKind = 'melody' | 'rhythm' | 'poly';

export interface VoiceAnalysis {
  kind: DetectedKind;
  reason: string; // why this kind was chosen, in plain words
  notes: DetectedNote[]; // melody notes, or drum hits (36 kick, 38 snare, 42/46 hi-hat)
  bpm: number | null;
  contour: { hopSec: number; pitch: Float32Array } | null;
  stats: {
    voicedRatio: number; // share of the sounding time that had a clear pitch
    meanConfidence: number;
    snrDb: number;
    onsetsPerSecond: number;
    percussive: number; // share of the sounding time that is the 150 ms after a hit
    polyphony: number; // 0 = one note at a time, towards 1 = several
    seconds: number; // length of the recording
    tookMs: number; // processing time
  };
}

export const ANALYSIS_RATE = 16000;

/**
 * How much of the tonal energy does NOT belong to the tracked note's harmonic series.
 * One voice or instrument scores near 0; chords and full mixes score well above.
 */
export function polyphonyScore(x: Float32Array, sr: number, contour: { hopSec: number; pitch: Float32Array }): number {
  const N = 2048, half = N / 2;
  const re = new Float32Array(N), im = new Float32Array(N), mag = new Float32Array(half);
  const hop = Math.round(contour.hopSec * sr);
  let total = 0, count = 0;
  for (let f = 0; f < contour.pitch.length; f += 8) {
    const midi = contour.pitch[f];
    if (midi <= 0 || f * hop + N > x.length) continue;
    for (let i = 0; i < N; i++) { re[i] = x[f * hop + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))); im[i] = 0; }
    fft(re, im);
    let top = 0;
    for (let k = 1; k < half; k++) { mag[k] = Math.hypot(re[k], im[k]); if (mag[k] > top) top = mag[k]; }
    if (top <= 0) continue;
    const f0 = 440 * 2 ** ((midi - 69) / 12);
    let inSeries = 0, outside = 0, lowest = 99;
    for (let k = Math.ceil((70 * N) / sr); k < Math.floor((4000 * N) / sr); k++) {
      if (mag[k] < top * 0.1 || mag[k] < mag[k - 1] || mag[k] <= mag[k + 1]) continue;
      const a = mag[k - 1], b = mag[k], c = mag[k + 1];
      const hz = ((k + (0.5 * (a - c)) / (a - 2 * b + c || 1)) * sr) / N;
      const h = hz / f0, whole = Math.round(h);
      if (whole >= 1 && Math.abs(h - whole) <= 0.08 + 6 / f0) { inSeries += b * b; if (whole < lowest) lowest = whole; }
      else outside += b * b;
    }
    if (inSeries + outside <= 0) continue;
    // a "note" whose first three harmonics are all missing is the common sub-harmonic of a chord
    total += lowest >= 4 && f0 < 120 ? 1 : outside / (inSeries + outside);
    count++;
  }
  return count ? total / count : 0;
}

/** Of the time the recording is sounding, how much falls within 150 ms after an attack. */
function percussiveShare(x: Float32Array, sr: number, attacks: number[]): number {
  const hop = Math.round(sr * 0.01), frames = Math.floor(x.length / hop);
  const level = new Float32Array(frames);
  let top = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) e += x[i] * x[i];
    level[f] = Math.sqrt(e / hop);
    if (level[f] > top) top = level[f];
  }
  const near = new Uint8Array(frames);
  for (const t of attacks) for (let f = Math.max(0, Math.round(t * 100) - 2); f < Math.min(frames, Math.round(t * 100) + 15); f++) near[f] = 1;
  let sounding = 0, struck = 0;
  for (let f = 0; f < frames; f++) if (level[f] > top * 0.06) { sounding++; if (near[f]) struck++; }
  return sounding ? struck / sounding : 0;
}

export async function analyzeRecording(mono: Float32Array, sampleRate: number, mode: DetectMode, onProgress?: (fraction: number, stage: string) => void): Promise<VoiceAnalysis> {
  const t0 = Date.now();
  onProgress?.(0, 'Preparing the recording…');
  const x = resample(mono, sampleRate, ANALYSIS_RATE);
  const sr = ANALYSIS_RATE;
  const seconds = x.length / sr;
  // onsets are needed by both paths (new syllables in a melody, hits in a rhythm): find them once
  const onsets = detectOnsets(x, sr, { minStrength: 0.05 });
  const hits = onsets.filter((o) => o.strength >= 0.12);
  const rate = hits.length / Math.max(0.5, seconds);
  const stats = { voicedRatio: 0, meanConfidence: 0, snrDb: 0, onsetsPerSecond: rate, percussive: percussiveShare(x, sr, hits.map((o) => o.time)), polyphony: 0, seconds, tookMs: 0 };

  const asRhythm = (reason: string): VoiceAnalysis => {
    const notes = classifyHits(hits);
    return { kind: 'rhythm', reason, notes, bpm: estimateTempo(hits), contour: null, stats: { ...stats, meanConfidence: notes.length ? notes.reduce((a, n) => a + (n.confidence ?? 0), 0) / notes.length : 0, tookMs: Date.now() - t0 } };
  };
  if (mode === 'rhythm') { onProgress?.(0.5, 'Finding hits…'); return asRhythm('Analysed as rhythm, as chosen.'); }

  const melody = await detectMelody(x, sr, (f) => onProgress?.(0.05 + 0.9 * f, 'Tracking pitch…'), onsets);
  stats.voicedRatio = melody.voicedRatio;
  stats.meanConfidence = melody.meanConfidence;
  stats.snrDb = melody.snrDb;
  stats.polyphony = melody.notes.length ? polyphonyScore(x, sr, melody.contour) : 0;
  const asMelody = (kind: DetectedKind, reason: string): VoiceAnalysis => ({
    kind, reason, notes: melody.notes, contour: melody.contour,
    bpm: estimateTempo(melody.notes.map((n) => ({ time: n.start, strength: n.velocity }))),
    stats: { ...stats, tookMs: Date.now() - t0 },
  });
  if (mode === 'melody') return asMelody('melody', 'Analysed as a single melody line, as chosen.');

  // "Decide for me"
  const several = 'Several notes seem to sound at the same time (an instrument or chords), so the Basic Pitch model is the better tool for it.';
  if (melody.voicedRatio < 0.3 || melody.notes.length === 0) {
    return asRhythm('Most of this had no clear pitch, so it was analysed as rhythm (tapping or beatboxing).');
  }
  if (melody.voicedRatio >= 0.7) {
    return stats.polyphony >= 0.35 && melody.meanConfidence < 0.8 ? asMelody('poly', several) : asMelody('melody', 'One clear pitch at a time: analysed as a melody with the pitch tracker.');
  }
  // Partly pitched. Short sounds that die away straight after each attack are hits (a
  // beatboxed kick has a pitch too); sound that carries on between attacks is being held.
  if (stats.percussive >= 0.6) return asRhythm('This is mostly short hits rather than held notes, so it was analysed as rhythm.');
  if (melody.meanConfidence >= 0.7) return asMelody('melody', 'Parts of this had no clear pitch, but what did was one note at a time: analysed as a melody.');
  return asMelody('poly', several);
}
