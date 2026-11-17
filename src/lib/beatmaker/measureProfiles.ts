import { renderProject } from '../../audio/render';
import { engine } from '../../audio/engine';
import { defaultFx, type Project } from '../../types';
import { getInstrument } from '../instruments';
import { fft } from '../dsp/rhythm';
import { createProject, newTrack } from '../templates';
import { BANDS, GENRE_LIST, candidateInstruments } from './knowledge';
import type { InstrumentProfiles, NoteProfile } from './profiles';

// Measures how every instrument the beat maker may choose really sounds, by rendering
// notes through the app's own engine: its loudness, where its energy sits in the
// spectrum, and how long a note keeps sounding. The trainer uses these measurements to
// predict the balance and the clashes of a mix without rendering it.
//
// Development tool. In the dev server's console:
//   const m = await import('/src/lib/beatmaker/measureProfiles.ts'); copy(JSON.stringify(await m.measureProfiles()))
// and save the result as src/lib/beatmaker/profiles.json.

const DRUM_PITCHES = [36, 38, 39, 37, 42, 46, 44, 49, 51, 41, 45, 70];

function analyse(buf: AudioBuffer): NoteProfile {
  const sr = buf.sampleRate;
  const x = buf.getChannelData(0);
  const N = 4096, hop = 2048;
  const re = new Float32Array(N), im = new Float32Array(N);
  const bands = new Array(BANDS.length).fill(0);
  for (let o = 0; o + N <= x.length; o += hop) {
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))); im[i] = 0; }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const hz = (k * sr) / N;
      const b = BANDS.findIndex((band) => hz >= band.lo && hz < band.hi);
      if (b >= 0) bands[b] += re[k] * re[k] + im[k] * im[k];
    }
  }
  const total = bands.reduce((a, b) => a + b, 0) || 1;
  // loudness over the loudest 400 ms, and how long the sound lasts above -20 dB of its peak
  const w = Math.round(sr * 0.05);
  const env: number[] = [];
  for (let i = 0; i + w <= x.length; i += w) { let e = 0; for (let j = i; j < i + w; j++) e += x[j] * x[j]; env.push(e / w); }
  const peak = Math.max(...env, 1e-12);
  const at = env.indexOf(peak);
  const loud = env.slice(at, at + 8);
  let end = at;
  while (end < env.length && env[end] > peak / 100) end++;
  return {
    db: Math.round(10 * Math.log10(loud.reduce((a, b) => a + b, 0) / loud.length + 1e-12) * 10) / 10,
    bands: bands.map((b) => Math.round((b / total) * 1000) / 1000),
    ring: Math.round(((end - at) * w) / sr * 100) / 100,
  };
}

async function renderNote(instrumentId: string, pitch: number, seconds: number): Promise<AudioBuffer> {
  const p: Project = createProject('measure');
  const t = newTrack('m', instrumentId, { volume: 0, fx: defaultFx() });
  p.tracks = [t];
  p.bpm = 60;
  p.clips = [{ id: 'c', type: 'midi', trackId: t.id, name: 'm', start: 0, length: seconds + 0.5, notes: [{ id: 'n', pitch, start: 0, duration: seconds, velocity: 0.8 }] }];
  return renderProject(p, engine.buffers, { onlyTrackId: t.id });
}

export async function measureProfiles(onProgress?: (done: number, total: number, id: string) => void): Promise<InstrumentProfiles> {
  const out: InstrumentProfiles = { instruments: {}, kits: {} };
  const ids = candidateInstruments().filter((id) => getInstrument(id)?.engine !== 'drums');
  const kits = [...new Set(GENRE_LIST.flatMap((g) => g.drums?.kits ?? []))];
  const total = ids.length + kits.length;
  let done = 0;
  for (const id of ids) {
    const def = getInstrument(id)!;
    const [lo, hi] = def.range;
    const pitches = [0.2, 0.5, 0.8].map((f) => Math.round(lo + (hi - lo) * f));
    const notes: (NoteProfile & { pitch: number })[] = [];
    for (const pitch of pitches) notes.push({ pitch, ...analyse(await renderNote(id, pitch, 2)) });
    out.instruments[id] = notes;
    onProgress?.(++done, total, id);
  }
  for (const inst of kits) {
    const kit: Record<number, NoteProfile> = {};
    for (const pitch of DRUM_PITCHES) kit[pitch] = analyse(await renderNote(inst, pitch, 0.2));
    out.kits[inst] = kit;
    onProgress?.(++done, total, inst);
  }
  return out;
}
