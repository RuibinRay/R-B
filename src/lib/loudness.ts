import type { Pcm } from './wav';
import { dbToGain, gainToDb } from './music';

// Mastering measurements: ITU-R BS.1770 integrated loudness (LUFS), sample peak,
// plus gain and a look-ahead peak limiter used when exporting.

export interface LoudnessStats { lufs: number; peakDb: number; clippedSamples: number; durationSec: number }

function biquad(x: Float32Array, b0: number, b1: number, b2: number, a1: number, a2: number): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

/** K-weighting: a high shelf followed by a high-pass, coefficients derived for the given sample rate. */
function kWeight(x: Float32Array, fs: number): Float32Array {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = biquad(x, (Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  return biquad(shelf, 1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
}

export function analyzeLoudness(pcm: Pcm): LoudnessStats {
  const { channels, sampleRate } = pcm;
  const n = channels[0]?.length ?? 0;
  let peak = 0, clipped = 0;
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
      if (a >= 0.9999) clipped++;
    }
  }
  const step = Math.floor(sampleRate * 0.1);
  const steps = Math.floor(n / step);
  const energy = new Float64Array(steps);
  for (const ch of channels) {
    const w = kWeight(ch, sampleRate);
    for (let s = 0; s < steps; s++) {
      let sum = 0;
      const o = s * step;
      for (let i = 0; i < step; i++) sum += w[o + i] * w[o + i];
      energy[s] += sum / step;
    }
  }
  // 400 ms blocks with 75% overlap = four consecutive 100 ms steps.
  const blocks: number[] = [];
  for (let s = 0; s + 4 <= steps; s++) blocks.push((energy[s] + energy[s + 1] + energy[s + 2] + energy[s + 3]) / 4);
  const toLufs = (z: number) => -0.691 + 10 * Math.log10(Math.max(z, 1e-12));
  const abs = blocks.filter((z) => toLufs(z) > -70);
  let lufs = -Infinity;
  if (abs.length) {
    const rel = toLufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const gated = abs.filter((z) => toLufs(z) > rel);
    if (gated.length) lufs = toLufs(gated.reduce((a, b) => a + b, 0) / gated.length);
  }
  return { lufs, peakDb: gainToDb(peak), clippedSamples: clipped, durationSec: n / sampleRate };
}

export function applyGain(pcm: Pcm, db: number): void {
  const g = dbToGain(db);
  for (const ch of pcm.channels) for (let i = 0; i < ch.length; i++) ch[i] *= g;
}

/**
 * Transparent look-ahead limiter: gain is reduced just enough, 5 ms ahead of every
 * peak, that no sample exceeds the ceiling. Returns the deepest gain reduction in dB.
 */
export function limitPeaks(pcm: Pcm, ceilingDb: number): number {
  const { channels, sampleRate } = pcm;
  const n = channels[0]?.length ?? 0;
  const ceil = dbToGain(ceilingDb);
  const need = new Float32Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const ch of channels) { const a = Math.abs(ch[i]); if (a > p) p = a; }
    if (p > ceil) { need[i] = ceil / p; any = true; } else need[i] = 1;
  }
  if (!any) return 0;
  const look = Math.max(1, Math.round(0.005 * sampleRate));
  // 1. minimum over the next `look` samples (monotonic deque)
  const ahead = new Float32Array(n);
  const dq = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (tail > head && need[dq[tail - 1]] >= need[i]) tail--;
    dq[tail++] = i;
    while (dq[head] > i + look) head++;
    ahead[i] = need[dq[head]];
  }
  // 2. box average turns the steps into ramps that still reach the target at each peak
  // 3. slow release so the gain recovers smoothly
  const rel = 1 - Math.exp(-1 / (0.08 * sampleRate));
  let sum = 0, g = 1, minG = 1;
  for (let i = 0; i < n; i++) {
    sum += ahead[i];
    if (i >= look) sum -= ahead[i - look];
    const avg = sum / Math.min(i + 1, look);
    g = Math.min(avg, g + (1 - g) * rel);
    if (g < minG) minG = g;
    if (g < 0.99999) for (const ch of channels) ch[i] *= g;
  }
  return gainToDb(minG);
}
