import type { DetectedNote } from './pitch';

// Rhythm analysis: spectral-flux onset detection, tempo estimation and a spectral
// classification of percussive hits (for beatboxing and tapping).

export interface Onset {
  time: number;
  strength: number; // 0..1, relative to the strongest onset in the recording
  centroid: number; // Hz, where the hit's energy sits on average
  lowRatio: number; // share of energy under 220 Hz
  highRatio: number; // share of energy over 3 kHz
  flatness: number; // 0 = a pure tone, 1 = white noise
  decay: number; // seconds until the hit has faded to a fifth of its peak
  level: number; // peak level of the hit (linear)
}

export interface OnsetOptions { minStrength?: number }

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

export function detectOnsets(x: Float32Array, sr: number, opts: OnsetOptions = {}): Onset[] {
  const N = 512, hop = Math.round(sr * 0.008);
  const frames = Math.max(0, Math.floor((x.length - N) / hop));
  if (frames < 4) return [];
  const minStrength = opts.minStrength ?? 0.12;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const half = N / 2;
  const re = new Float32Array(N), im = new Float32Array(N);
  const spectrum = (f: number) => { for (let i = 0; i < N; i++) { re[i] = x[f * hop + i] * win[i]; im[i] = 0; } fft(re, im); };

  // Pass 1: how much the (log) spectrum grew from one frame to the next, and each frame's level.
  // Only two frames of spectrum are kept at a time, so memory stays flat however long the take is.
  const flux = new Float32Array(frames), level = new Float32Array(frames);
  let prev = new Float32Array(half), mag = new Float32Array(half);
  for (let f = 0; f < frames; f++) {
    spectrum(f);
    let sum = 0, e = 0;
    for (let k = 1; k < half; k++) {
      mag[k] = Math.log1p(20 * Math.hypot(re[k], im[k]));
      const diff = mag[k] - prev[k];
      if (diff > 0) sum += diff;
    }
    for (let i = 0; i < N; i++) e += x[f * hop + i] * x[f * hop + i];
    flux[f] = sum;
    level[f] = Math.sqrt(e / N);
    const t = prev; prev = mag; mag = t;
  }
  let maxFlux = 0;
  for (let f = 0; f < frames; f++) if (flux[f] > maxFlux) maxFlux = flux[f];
  if (maxFlux <= 0) return [];

  const picks: number[] = [];
  const minGap = Math.round(0.06 / 0.008);
  let last = -minGap;
  for (let f = 2; f < frames - 2; f++) {
    const v = flux[f];
    if (v < maxFlux * minStrength) continue;
    let isPeak = true;
    for (let k = Math.max(0, f - 3); k <= Math.min(frames - 1, f + 3); k++) if (flux[k] > v) { isPeak = false; break; }
    if (!isPeak) continue;
    let mean = 0, count = 0;
    for (let k = Math.max(0, f - 14); k <= Math.min(frames - 1, f + 4); k++) { mean += flux[k]; count++; }
    if (v < (mean / count) * 1.5) continue;
    if (f - last < minGap) {
      // two peaks too close to be two hits: keep the stronger one
      if (v > flux[last]) { picks[picks.length - 1] = f; last = f; }
      continue;
    }
    picks.push(f);
    last = f;
  }

  // Pass 2: the spectral shape and the fade of each hit, from the frames that follow its onset.
  return picks.map((f, i) => {
    let total = 0, weighted = 0, low = 0, high = 0, logSum = 0, bins = 0;
    const acc = new Float32Array(half);
    for (let g = f; g < Math.min(frames, f + 4); g++) {
      spectrum(g);
      for (let k = 1; k < half; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    }
    for (let k = 1; k < half; k++) {
      const hz = (k * sr) / N, p = acc[k];
      total += p; weighted += p * hz;
      if (hz < 220) low += p;
      if (hz > 3000) high += p;
      if (hz > 150 && hz < 7000) { logSum += Math.log(p + 1e-12); bins++; }
    }
    let band = 0;
    for (let k = 1; k < half; k++) { const hz = (k * sr) / N; if (hz > 150 && hz < 7000) band += acc[k]; }
    const flatness = bins && band > 0 ? Math.exp(logSum / bins) / (band / bins) : 0;
    let peak = 0, peakAt = f;
    for (let g = f; g < Math.min(frames, f + 6); g++) if (level[g] > peak) { peak = level[g]; peakAt = g; }
    const stop = Math.min(frames - 1, i + 1 < picks.length ? picks[i + 1] : frames - 1, peakAt + 62);
    let g = peakAt;
    while (g < stop && level[g] > peak * 0.2) g++;
    return {
      time: (f * hop) / sr, strength: flux[f] / maxFlux,
      centroid: total ? weighted / total : 0, lowRatio: total ? low / total : 0, highRatio: total ? high / total : 0,
      flatness: Math.min(1, flatness), decay: ((g - f) * hop) / sr, level: peak,
    };
  });
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

// ---- drum classification ---------------------------------------------------

const KICK = 36, SNARE = 38, HAT = 42, OPEN_HAT = 46;
type Kind = 0 | 1 | 2; // kick, snare, hat

/**
 * Split values into groups at the widest gaps between neighbours (when sorted), provided
 * each gap is at least `minGap` wide. Returns each value's group index, darkest group 0.
 */
function splitAtGaps(values: number[], groups: number, minGap: number): { of: number[]; edges: number[] } | null {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const gaps = order.slice(1).map((idx, k) => ({ at: k + 1, size: values[idx] - values[order[k]] })).sort((a, b) => b.size - a.size).slice(0, groups - 1);
  if (gaps.length < groups - 1 || gaps.some((g) => g.size < minGap)) return null;
  const cuts = gaps.map((g) => g.at).sort((a, b) => a - b);
  const of = new Array<number>(values.length);
  order.forEach((idx, k) => { of[idx] = cuts.filter((c) => k >= c).length; });
  const edges = cuts.map((c) => (values[order[c - 1]] + values[order[c]]) / 2);
  return { of, edges };
}

/**
 * Map percussive onsets to kick / snare / closed or open hi-hat by where their energy sits.
 *
 * Fixed frequency limits work for a full-range microphone, but a phone or laptop mic has
 * almost no bass, which pushes every sound upwards. So when there are enough hits the
 * sounds are also grouped by brightness *relative to each other*: the darkest group is the
 * kick and the brightest the hi-hat, whatever the microphone did to them.
 */
export function classifyHits(onsets: Onset[]): DetectedNote[] {
  if (!onsets.length) return [];
  const bright = onsets.map((o) => Math.log2(Math.max(60, o.centroid)));
  const LOW = Math.log2(500), HIGH = Math.log2(3800);
  const fixed = (o: Onset): Kind => (o.lowRatio > 0.6 || o.centroid < 500 ? 0 : o.highRatio > 0.6 || o.centroid > 3800 ? 2 : 1);
  // first guess from fixed limits; `margin` is how far (in octaves) the hit is from changing class
  const kinds: Kind[] = onsets.map(fixed);
  const margin = bright.map((b, i) => (kinds[i] === 0 ? LOW - b : kinds[i] === 2 ? b - HIGH : Math.min(b - LOW, HIGH - b)));

  if (onsets.length >= 6) {
    const mean = (of: number[], g: number) => { const m = bright.filter((_, i) => of[i] === g); return 2 ** (m.reduce((a, b) => a + b, 0) / m.length); };
    const edgeMargin = (b: number, g: number, edges: number[]) => Math.min(g > 0 ? b - edges[g - 1] : Infinity, g < edges.length ? edges[g] - b : Infinity);
    const three = splitAtGaps(bright, 3, 0.7);
    const two = three ? null : splitAtGaps(bright, 2, 1);
    if (three && mean(three.of, 0) < 1500 && mean(three.of, 2) > 1500) {
      three.of.forEach((g, i) => { kinds[i] = g as Kind; margin[i] = edgeMargin(bright[i], g, three.edges); });
    } else if (two) {
      const lowIsKick = mean(two.of, 0) < 900, highIsHat = mean(two.of, 1) > 2800;
      two.of.forEach((g, i) => {
        const o = onsets[i], between = edgeMargin(bright[i], g, two.edges);
        if (g === 0 && lowIsKick) { kinds[i] = 0; margin[i] = between; }
        else if (g === 0 && highIsHat) { kinds[i] = 1; margin[i] = between; } // no kicks at all: the darker group is the snare
        else if (g === 1 && !lowIsKick && highIsHat) { kinds[i] = 2; margin[i] = between; }
        else if (g === 1) {
          // kicks are set apart; snare and hi-hat are too close to separate as groups, so fixed limits decide between them
          kinds[i] = o.highRatio > 0.6 || o.centroid > 3800 ? 2 : 1;
          margin[i] = Math.min(between, Math.abs(bright[i] - HIGH));
        }
      });
    }
    // unmistakable cases keep their class whatever the grouping says
    onsets.forEach((o, i) => { if (o.lowRatio > 0.75) kinds[i] = 0; else if (o.highRatio > 0.8) kinds[i] = 2; });
  }

  return onsets.map((o, i) => {
    const open = kinds[i] === 2 && o.decay > 0.16;
    const confidence = Math.max(0.3, Math.min(1, 0.45 + Math.max(0, margin[i]) * 0.9)) * (o.strength < 0.2 ? 0.8 : 1);
    return {
      pitch: kinds[i] === 0 ? KICK : kinds[i] === 1 ? SNARE : open ? OPEN_HAT : HAT,
      start: o.time, duration: open ? Math.min(0.4, Math.max(0.16, o.decay)) : 0.12,
      velocity: Math.max(0.35, Math.min(1, 0.4 + 0.6 * o.strength)),
      confidence, issue: confidence < 0.55 ? 'unclear' as const : undefined,
    };
  });
}
