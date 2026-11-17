import { renderProject } from '../../audio/render';
import { engine } from '../../audio/engine';
import { BANDS, GENRE_LIST } from './knowledge';
import { compose, toProject } from './compose';
import { randomGenome, rngFrom } from './genome';
import { fft } from '../dsp/rhythm';
import { estimateMix } from './critics';

// The beat maker listening to itself. It renders parts of its own beats through the
// real engine, measures their actual loudness and spectrum, and compares them with what
// its quick model (profiles.json) predicted. The average error per instrument becomes a
// correction applied to the model from then on.
//
// Development tool, run in the dev server's console:
//   const c = await import('/src/lib/beatmaker/calibrate.ts'); const r = await c.calibrate()
// then merge r into profiles.json under "corrections".

export interface Correction { db: number; bands: number[]; n: number }

function measure(buf: AudioBuffer): { db: number; bands: number[] } {
  const sr = buf.sampleRate, N = 4096;
  const re = new Float32Array(N), im = new Float32Array(N);
  const bands = new Array(BANDS.length).fill(0);
  let energy = 0, count = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const x = buf.getChannelData(c);
    for (let i = 0; i < x.length; i++) energy += x[i] * x[i];
    count += x.length;
    if (c > 0) continue;
    for (let o = 0; o + N <= x.length; o += N) {
      for (let i = 0; i < N; i++) { re[i] = x[o + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))); im[i] = 0; }
      fft(re, im);
      for (let k = 1; k < N / 2; k++) { const hz = (k * sr) / N; const b = BANDS.findIndex((q) => hz >= q.lo && hz < q.hi); if (b >= 0) bands[b] += re[k] * re[k] + im[k] * im[k]; }
    }
  }
  const total = bands.reduce((a, b) => a + b, 0) || 1;
  return { db: 10 * Math.log10(energy / count + 1e-15), bands: bands.map((b) => b / total) };
}

export async function calibrate(perGenre = 3, onProgress?: (done: number, total: number) => void): Promise<Record<string, Correction>> {
  const acc: Record<string, { db: number[]; ratio: number[][] }> = {};
  const total = GENRE_LIST.length * perGenre;
  let done = 0;
  for (const genre of GENRE_LIST) {
    const rng = rngFrom(4242 + genre.id.length);
    for (let k = 0; k < perGenre; k++) {
      const comp = compose(randomGenome(genre.id, rng), 'loop');
      const est = estimateMix(comp);
      const project = toProject(comp, 'calibration');
      const seconds = (comp.lengthBars * 4 * 60) / comp.bpm;
      for (const part of comp.parts) {
        const track = project.tracks.find((t) => t.instrumentId === part.instrumentId && t.volume === part.volume);
        if (!track) continue;
        // render the part dry (no effects) so only the instrument and the fader are measured
        const dry = { ...project, tracks: project.tracks.map((t) => ({ ...t, fx: { ...t.fx, reverb: { ...t.fx.reverb, on: false }, delay: { ...t.fx.delay, on: false }, chorus: { ...t.fx.chorus, on: false }, eq: { ...t.fx.eq, on: false } } })) };
        const buf = await renderProject(dry, engine.buffers, { onlyTrackId: track.id });
        const real = measure(buf);
        // predicted level of the part averaged over the whole loop, as the render measures it
        const bars = new Set(part.notes.map((n) => Math.floor(n.start / 4))).size;
        const predicted = (est.roleDb[part.role] ?? -60) + 10 * Math.log10(Math.max(1, bars) * 4 * (60 / comp.bpm) / (seconds + 2.5));
        const a = (acc[part.instrumentId] ??= { db: [], ratio: [] });
        a.db.push(real.db - predicted);
        const pb = est.roleBands[part.role] ?? [];
        a.ratio.push(real.bands.map((b, i) => Math.max(0.05, Math.min(20, (b + 0.002) / ((pb[i] ?? 0) + 0.002)))));
      }
      onProgress?.(++done, total);
    }
  }
  const out: Record<string, Correction> = {};
  const median = (v: number[]) => { const s = [...v].sort((x, y) => x - y); return s[s.length >> 1]; };
  for (const [id, a] of Object.entries(acc)) {
    const bands = BANDS.map((_, i) => Math.round(Math.exp(median(a.ratio.map((r) => Math.log(r[i])))) * 1000) / 1000);
    out[id] = { db: Math.round(median(a.db) * 10) / 10, bands, n: a.db.length };
  }
  return out;
}
