import { analyzeLoudness } from '../loudness';
import { fft } from '../dsp/rhythm';
import { BANDS, GENRES, type GenreId } from './knowledge';

// Listening to a finished render: the real loudness, peak and frequency balance of the
// audio, compared with what the style calls for.

export interface Hearing { lufs: number; peakDb: number; bands: number[]; spectrumMatch: number; worst: string }

export function listen(buf: AudioBuffer, genre: GenreId): Hearing {
  const sr = buf.sampleRate, N = 4096;
  const x = buf.getChannelData(0);
  const re = new Float32Array(N), im = new Float32Array(N);
  const bands = new Array(BANDS.length).fill(0);
  for (let o = 0; o + N <= x.length; o += N) {
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))); im[i] = 0; }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) { const hz = (k * sr) / N; const b = BANDS.findIndex((q) => hz >= q.lo && hz < q.hi); if (b >= 0) bands[b] += re[k] * re[k] + im[k] * im[k]; }
  }
  const total = bands.reduce((a, b) => a + b, 0) || 1;
  const share = bands.map((b) => b / total);
  const target = GENRES[genre].spectrum;
  const dist = share.reduce((a, b, i) => a + Math.abs(b - target[i]), 0);
  const w = share.map((b, i) => [b - target[i], i] as const).sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]))[0];
  const loud = analyzeLoudness({ channels: Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c)), sampleRate: sr });
  return {
    lufs: loud.lufs, peakDb: loud.peakDb, bands: share, spectrumMatch: Math.max(0, Math.min(1, 1 - dist * 0.9)),
    worst: `${BANDS[w[1]].name} ${w[0] > 0 ? 'heavier' : 'lighter'} than typical by ${Math.round(Math.abs(w[0]) * 100)}% of the mix`,
  };
}
