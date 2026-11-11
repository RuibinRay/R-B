import type { DetectedNote } from './pitch';

// Rhythm analysis: spectral-flux onset detection, tempo estimation and a simple
// spectral classification of percussive hits (for beatboxing and tapping).

export interface Onset { time: number; strength: number; centroid: number; lowRatio: number; highRatio: number }

/** In-place iterative radix-2 FFT. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export function detectOnsets(x: Float32Array, sr: number): Onset[] {
  const N = 512, hop = Math.round(sr * 0.008);
  const frames = Math.max(0, Math.floor((x.length - N) / hop));
  if (frames < 4) return [];
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const half = N / 2;
  const mags: Float32Array[] = [];
  const flux = new Float32Array(frames);
  const re = new Float32Array(N), im = new Float32Array(N);
  let prev = new Float32Array(half);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) { re[i] = x[f * hop + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const mag = new Float32Array(half);
    let sum = 0;
    for (let k = 1; k < half; k++) {
      mag[k] = Math.log1p(20 * Math.hypot(re[k], im[k]));
      const diff = mag[k] - prev[k];
      if (diff > 0) sum += diff;
    }
    flux[f] = sum;
    mags.push(mag);
    prev = mag;
  }
  let maxFlux = 0;
  for (let f = 0; f < frames; f++) if (flux[f] > maxFlux) maxFlux = flux[f];
  if (maxFlux <= 0) return [];
  const onsets: Onset[] = [];
  const minGap = Math.round(0.06 / 0.008);
  let last = -minGap;
  for (let f = 2; f < frames - 2; f++) {
    const v = flux[f];
    if (v < maxFlux * 0.12) continue;
    let isPeak = true;
    for (let k = Math.max(0, f - 3); k <= Math.min(frames - 1, f + 3); k++) if (flux[k] > v) { isPeak = false; break; }
    if (!isPeak || f - last < minGap) continue;
    let mean = 0, count = 0;
    for (let k = Math.max(0, f - 14); k <= Math.min(frames - 1, f + 4); k++) { mean += flux[k]; count++; }
    if (v < (mean / count) * 1.5) continue;
    // Spectral shape of the hit: average the three frames following the onset.
    let total = 0, weighted = 0, low = 0, high = 0;
    for (let g = f; g < Math.min(frames, f + 3); g++) {
      for (let k = 1; k < half; k++) {
        const hz = (k * sr) / N;
        const p = Math.expm1(mags[g][k]) ** 2;
        total += p; weighted += p * hz;
        if (hz < 220) low += p;
        if (hz > 3000) high += p;
      }
    }
    onsets.push({ time: (f * hop) / sr, strength: v / maxFlux, centroid: total ? weighted / total : 0, lowRatio: total ? low / total : 0, highRatio: total ? high / total : 0 });
    last = f;
  }
  return onsets;
}

/**
 * Tempo from onset times: autocorrelation of an onset impulse train, weighted by a
 * broad preference for moderate tempos. Returns null when there is too little to go on.
 */
export function estimateTempo(onsets: { time: number; strength: number }[]): number | null {
  if (onsets.length < 4) return null;
  const rate = 100; // 10 ms resolution
  const end = onsets[onsets.length - 1].time + 0.5;
  const n = Math.ceil(end * rate);
  const env = new Float32Array(n);
  for (const o of onsets) {
    const c = Math.round(o.time * rate);
    for (let k = -3; k <= 3; k++) {
      const i = c + k;
      if (i >= 0 && i < n) env[i] += o.strength * Math.exp(-(k * k) / 4);
    }
  }
  const ac = (lag: number): number => {
    const a = Math.floor(lag), frac = lag - a;
    let s0 = 0, s1 = 0;
    for (let i = 0; i + a + 1 < n; i++) { s0 += env[i] * env[i + a]; s1 += env[i] * env[i + a + 1]; }
    return s0 * (1 - frac) + s1 * frac;
  };
  let best = 0, bestScore = -Infinity;
  for (let bpm = 60; bpm <= 180; bpm += 0.5) {
    const lag = (60 / bpm) * rate;
    const score = (ac(lag) + 0.5 * ac(lag * 2) + 0.25 * ac(lag / 2)) * Math.exp(-0.5 * (Math.log2(bpm / 105) / 0.7) ** 2);
    if (score > bestScore) { bestScore = score; best = bpm; }
  }
  return bestScore > 0 ? Math.round(best) : null;
}

/** Map percussive onsets to kick / snare / hi-hat by where their energy sits in the spectrum. */
export function classifyHits(onsets: Onset[]): DetectedNote[] {
  return onsets.map((o) => {
    let pitch = 38;
    if (o.lowRatio > 0.6 || o.centroid < 500) pitch = 36;
    else if (o.highRatio > 0.6 || o.centroid > 3800) pitch = 42;
    return { pitch, start: o.time, duration: 0.12, velocity: Math.max(0.35, Math.min(1, 0.4 + 0.6 * o.strength)) };
  });
}
