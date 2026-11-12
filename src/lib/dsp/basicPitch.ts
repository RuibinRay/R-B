import { toMono } from '../wav';
import { resample } from './resample';
import type { DetectedNote } from './pitch';

// Spotify Basic Pitch (Apache-2.0) running in the browser through TensorFlow.js.
// The model weights are served from /models/basic-pitch and loaded on first use,
// so the heavy ML bundle is only downloaded when someone actually transcribes.

// The library and the model weights are fetched once and kept: analysing a second
// recording (or the same one again) does not download or build the network again.
type Lib = typeof import('@spotify/basic-pitch');
let loaded: Promise<{ lib: Lib; model: InstanceType<Lib['BasicPitch']> }> | null = null;
const load = () => (loaded ??= import('@spotify/basic-pitch').then((lib) => ({ lib, model: new lib.BasicPitch(`${import.meta.env.BASE_URL}models/basic-pitch/model.json`) })).catch((e) => { loaded = null; throw e; }));

export async function basicPitchDetect(buffer: AudioBuffer, onProgress?: (fraction: number) => void): Promise<DetectedNote[]> {
  const { lib: { outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime }, model } = await load();
  const audio = resample(toMono(buffer), buffer.sampleRate, 22050); // the model expects 22.05 kHz mono
  const frames: number[][] = [], onsets: number[][] = [], contours: number[][] = [];
  await model.evaluateModel(
    audio,
    (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); },
    (p) => onProgress?.(p),
  );
  // onset 0.5 / frame 0.3 thresholds, notes of at least ~120 ms, pitch limited to a singable/playable band
  const events = outputToNotesPoly(frames, onsets, 0.5, 0.3, 11, true, 2000, 60, true);
  const timed = noteFramesToTime(addPitchBendsToNoteEvents(contours, events));
  const notes = timed
    .map((n): DetectedNote => {
      const cents = n.pitchBends?.map((b) => Math.max(-200, Math.min(200, Math.round((b * 100) / 3))));
      let bend: number[] | undefined;
      if (cents && cents.length > 1 && cents.some((c) => Math.abs(c) > 25)) {
        const points = Math.min(16, cents.length);
        bend = Array.from({ length: points }, (_, i) => cents[Math.round((i / (points - 1)) * (cents.length - 1))]);
      }
      return { pitch: n.pitchMidi, start: n.startTimeSeconds, duration: n.durationSeconds, velocity: Math.max(0.3, Math.min(1, 0.3 + n.amplitude)), bend };
    })
    .sort((a, b) => a.start - b.start);
  // The model sometimes cuts one held note into a long piece and a short, quieter
  // tail at the same pitch. Glue those tails back on; real repeated notes are kept.
  const out: DetectedNote[] = [];
  for (const n of notes) {
    const prev = [...out].reverse().find((p) => p.pitch === n.pitch);
    if (prev && n.start - (prev.start + prev.duration) < 0.03 && n.start >= prev.start && n.duration < 0.18 && n.velocity <= prev.velocity) {
      prev.duration = Math.max(prev.duration, n.start + n.duration - prev.start);
    } else out.push(n);
  }
  return out;
}
