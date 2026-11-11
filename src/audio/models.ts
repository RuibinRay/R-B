import { fft } from '../lib/dsp/rhythm';

// Instruments that are computed rather than sampled. Each model writes its sound
// straight into a buffer the first time the instrument is used; the sampler then
// plays those buffers like any other instrument. Nothing is downloaded.
//
//   string    Karplus-Strong plucked string (a noise burst circulating in a damped delay line)
//   additive  bells, bars and tines: a handful of partials, each with its own decay
//   organ     drawbar organ: steady harmonics rendered as a perfectly periodic loop
//   pad       PADsynth: harmonics smeared in frequency with random phase -> lush seamless loops
//   texture   noise-based atmospheres and one-shot effects

export const MODEL_RATE = 44100;
const SR = MODEL_RATE;

export interface ModelOutput { data: Float32Array; midi: number; loop?: [number, number] }

type Partial3 = [ratio: number, amp: number, decay: number];

export type ModelSpec =
  | { kind: 'string'; bright: number; blend: number; sustain: number; pick: number }
  | { kind: 'additive'; partials: Partial3[]; beat?: number; tap?: number; attack?: number }
  | { kind: 'organ'; bars: [ratio: number, amp: number][] }
  | { kind: 'pad'; profile: 'saw' | 'odd' | 'dark' | 'bright' | 'vocal'; width: number; spread: number }
  | { kind: 'texture'; type: 'wind' | 'vinyl' | 'riser' | 'downlifter' | 'impact' | 'zap' | 'subdrop' };

export const MODELS: Record<string, ModelSpec> = {
  nylon: { kind: 'string', bright: 0.45, blend: 0.5, sustain: 2.2, pick: 0.2 },
  steel: { kind: 'string', bright: 0.95, blend: 0.36, sustain: 3.6, pick: 0.12 },
  wire: { kind: 'string', bright: 1, blend: 0.2, sustain: 2.6, pick: 0.07 },
  muted: { kind: 'string', bright: 0.5, blend: 0.5, sustain: 0.28, pick: 0.3 },
  pluckBass: { kind: 'string', bright: 0.38, blend: 0.5, sustain: 2.4, pick: 0.25 },
  glassBells: { kind: 'additive', partials: [[1, 1, 3.5], [2.756, 0.6, 2.2], [5.404, 0.35, 1.4], [8.933, 0.2, 0.9], [13.34, 0.1, 0.6]] },
  tines: { kind: 'additive', partials: [[1, 1, 3.2], [2, 0.25, 2], [3, 0.1, 1.2], [7.1, 0.12, 0.4], [14.2, 0.22, 0.22]], tap: 0.15 },
  bowl: { kind: 'additive', partials: [[1, 1, 7], [2.71, 0.55, 5], [5.15, 0.3, 3.5], [8.2, 0.15, 2.4]], beat: 5, attack: 0.03 },
  handpan: { kind: 'additive', partials: [[1, 1, 2.2], [2, 0.7, 1.6], [3, 0.45, 1.2], [4.2, 0.1, 0.5]], tap: 0.35 },
  woodBars: { kind: 'additive', partials: [[1, 1, 0.6], [3.93, 0.4, 0.25], [9.8, 0.2, 0.12]], tap: 0.25 },
  gamelan: { kind: 'additive', partials: [[1, 1, 3], [1.52, 0.35, 2.2], [2.74, 0.5, 1.8], [3.46, 0.25, 1.2], [4.21, 0.2, 0.9]], beat: 7 },
  jazzOrgan: { kind: 'organ', bars: [[0.5, 1], [1.5, 1], [1, 1]] },
  fullOrgan: { kind: 'organ', bars: [[0.5, 0.8], [1.5, 0.5], [1, 1], [2, 0.8], [3, 0.6], [4, 0.6], [5, 0.4], [6, 0.4], [8, 0.5]] },
  fluteOrgan: { kind: 'organ', bars: [[1, 1], [2, 0.35], [4, 0.08]] },
  reedOrgan: { kind: 'organ', bars: [[1, 1], [3, 0.5], [5, 0.3], [7, 0.2], [9, 0.12]] },
  ensemblePad: { kind: 'pad', profile: 'saw', width: 38, spread: 1 },
  vocalPad: { kind: 'pad', profile: 'vocal', width: 55, spread: 0.9 },
  hollowPad: { kind: 'pad', profile: 'odd', width: 22, spread: 1 },
  darkPad: { kind: 'pad', profile: 'dark', width: 50, spread: 1.1 },
  shimmerPad: { kind: 'pad', profile: 'bright', width: 26, spread: 1 },
  wind: { kind: 'texture', type: 'wind' },
  vinyl: { kind: 'texture', type: 'vinyl' },
  riser: { kind: 'texture', type: 'riser' },
  downlifter: { kind: 'texture', type: 'downlifter' },
  impact: { kind: 'texture', type: 'impact' },
  zap: { kind: 'texture', type: 'zap' },
  subdrop: { kind: 'texture', type: 'subdrop' },
};

/** Textures are generated once, at middle C; playing other keys changes their speed and colour. */
export const isSingleZone = (spec: ModelSpec): boolean => spec.kind === 'texture';

const hz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);
const toMidi = (f: number): number => 69 + 12 * Math.log2(f / 440);

/** Small deterministic random generator, so a model always produces the same sound. */
function random(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function finish(x: Float32Array, peak: number, fadeOut = 0.02, fadeIn = 0.001): Float32Array {
  let max = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > max) max = a; }
  const g = max > 0 ? peak / max : 1;
  const fi = Math.floor(fadeIn * SR), fo = Math.floor(fadeOut * SR);
  for (let i = 0; i < x.length; i++) {
    let w = g;
    if (i < fi) w *= i / fi;
    if (fo && i >= x.length - fo) w *= (x.length - i) / fo;
    x[i] *= w;
  }
  return x;
}

// ---- plucked string ---------------------------------------------------------

function pluck(midi: number, o: Extract<ModelSpec, { kind: 'string' }>): ModelOutput {
  const f = hz(midi);
  const N = Math.max(2, Math.round(SR / f + o.blend));
  const period = N - o.blend; // the loop filter looks `blend` samples ahead, shortening the round trip
  const t60 = o.sustain * Math.pow(220 / f, 0.35);
  const g = Math.pow(10, -3 / (t60 * (SR / period)));
  const len = Math.floor(Math.min(4.5, t60 * 1.15 + 0.25) * SR);
  const rand = random(midi * 7919 + 13);
  const burst = new Float32Array(N);
  const a = 0.12 + 0.88 * o.bright;
  let lp = 0, mean = 0;
  for (let i = 0; i < N; i++) { lp += a * (rand() * 2 - 1 - lp); burst[i] = lp; }
  // plucking away from the end of the string removes some harmonics (a comb filter)
  const d = Math.max(1, Math.round(o.pick * N));
  const line = new Float32Array(N);
  for (let i = 0; i < N; i++) { line[i] = burst[i] - burst[(i - d + N) % N]; mean += line[i] / N; }
  for (let i = 0; i < N; i++) line[i] -= mean;
  const out = new Float32Array(len);
  for (let n = 0, idx = 0; n < len; n++) {
    const cur = line[idx], next = line[(idx + 1) % N];
    out[n] = cur;
    line[idx] = g * ((1 - o.blend) * cur + o.blend * next);
    idx = (idx + 1) % N;
  }
  return { data: finish(out, 0.32), midi: toMidi(SR / period) };
}

// ---- bells, bars, tines -----------------------------------------------------

function additive(midi: number, o: Extract<ModelSpec, { kind: 'additive' }>): ModelOutput {
  const f = hz(midi);
  const scale = Math.min(1.6, Math.max(0.4, Math.pow(220 / f, 0.25)));
  const longest = Math.max(...o.partials.map((p) => p[2])) * scale;
  const len = Math.floor(Math.min(6, longest * 2.4 + 0.1) * SR);
  const out = new Float32Array(len);
  const rand = random(midi * 131 + 5);
  const voices: [number, number, number][] = [];
  for (const [ratio, amp, decay] of o.partials) {
    voices.push([f * ratio, amp, decay * scale]);
    // a slightly detuned twin makes the partial beat slowly, as in bowls and gamelan
    if (o.beat) voices.push([f * ratio * Math.pow(2, o.beat / 1200), amp * 0.6, decay * scale]);
  }
  for (const [fp, amp, tau] of voices) {
    if (fp > SR * 0.45) continue;
    const w = (2 * Math.PI * fp) / SR, k = Math.exp(-1 / (tau * SR));
    let phase = rand() * Math.PI * 2, env = amp;
    for (let n = 0; n < len; n++) { out[n] += env * Math.sin(phase); phase += w; env *= k; }
  }
  if (o.tap) {
    // the knock of the mallet or finger
    let lp = 0;
    const n = Math.floor(0.012 * SR);
    for (let i = 0; i < n; i++) { lp += 0.35 * (rand() * 2 - 1 - lp); out[i] += lp * o.tap * 3 * (1 - i / n); }
  }
  return { data: finish(out, 0.32, 0.03, o.attack ?? 0.0015), midi };
}

// ---- drawbar organ ----------------------------------------------------------

function organ(midi: number, o: Extract<ModelSpec, { kind: 'organ' }>): ModelOutput {
  const f = hz(midi);
  const lowest = Math.min(...o.bars.map((b) => b[0]));
  const P = SR / (f * lowest); // samples in one cycle of the lowest pipe
  let K = Math.ceil((0.6 * SR) / P), best = Infinity;
  // pick a whole number of cycles that lands almost exactly on a whole number of samples: a seamless loop
  for (let k = K; k < K + 60; k++) { const err = Math.abs(k * P - Math.round(k * P)); if (err < best) { best = err; K = k; } }
  const L = Math.round(K * P);
  const out = new Float32Array(L);
  for (const [ratio, amp] of o.bars) {
    const cycles = Math.round((K * ratio) / lowest);
    if ((cycles * SR) / L > SR * 0.45) continue;
    const w = (2 * Math.PI * cycles) / L;
    for (let n = 0; n < L; n++) out[n] += amp * Math.sin(w * n);
  }
  let max = 0;
  for (let i = 0; i < L; i++) max = Math.max(max, Math.abs(out[i]));
  for (let i = 0; i < L; i++) out[i] *= 0.2 / max;
  return { data: out, midi: toMidi(((K / lowest) * SR) / L), loop: [0, L / SR] };
}

// ---- PADsynth ---------------------------------------------------------------

const FFT_SIZE = 131072; // about three seconds: long enough that the loop is not heard as a cycle

function harmonicLevel(profile: Extract<ModelSpec, { kind: 'pad' }>['profile'], h: number, fh: number): number {
  switch (profile) {
    case 'saw': return 1 / h;
    case 'odd': return h % 2 ? 1 / h : 0;
    case 'dark': return 1 / (h * h);
    case 'bright': return h <= 24 ? 1 / Math.sqrt(h) : 0;
    case 'vocal': {
      // an "ah" vowel: three formant peaks over a falling spectrum
      const peak = (c: number, w: number) => Math.exp(-(((fh - c) / w) ** 2));
      return (1 / h) * (0.08 + peak(800, 140) + 0.7 * peak(1150, 170) + 0.35 * peak(2900, 260));
    }
  }
}

function pad(midi: number, o: Extract<ModelSpec, { kind: 'pad' }>): ModelOutput {
  const f = hz(midi);
  const half = FFT_SIZE / 2;
  const mag = new Float32Array(half);
  for (let h = 1; h <= 96; h++) {
    const fh = f * h;
    if (fh > SR * 0.45) break;
    const level = harmonicLevel(o.profile, h, fh);
    if (level <= 0) continue;
    // each harmonic becomes a narrow bell curve; higher harmonics are smeared wider, like a real ensemble
    const bwHz = (Math.pow(2, o.width / 1200) - 1) * f * Math.pow(h, o.spread);
    const bwi = bwHz / (2 * SR), fi = fh / SR;
    const centre = fi * FFT_SIZE, reach = Math.max(2, bwi * FFT_SIZE * 4);
    for (let i = Math.max(1, Math.floor(centre - reach)); i <= Math.min(half - 1, Math.ceil(centre + reach)); i++) {
      const x = (i / FFT_SIZE - fi) / bwi;
      mag[i] += (level * Math.exp(-x * x)) / bwi;
    }
  }
  const rand = random(midi * 31 + 7);
  const re = new Float32Array(FFT_SIZE), im = new Float32Array(FFT_SIZE);
  for (let i = 1; i < half; i++) {
    const phase = rand() * Math.PI * 2;
    re[i] = mag[i] * Math.cos(phase);
    im[i] = -mag[i] * Math.sin(phase); // conjugated, so the forward transform below acts as the inverse
    re[FFT_SIZE - i] = re[i];
    im[FFT_SIZE - i] = -im[i];
  }
  fft(re, im);
  let max = 0;
  for (let i = 0; i < FFT_SIZE; i++) max = Math.max(max, Math.abs(re[i]));
  for (let i = 0; i < FFT_SIZE; i++) re[i] *= 0.3 / max;
  return { data: re, midi, loop: [0, FFT_SIZE / SR] };
}

// ---- noise textures and effects --------------------------------------------

/** Make a buffer loop seamlessly by folding `extra` overflow samples back into its start. */
function foldLoop(x: Float32Array, len: number): Float32Array {
  const extra = x.length - len;
  const out = x.slice(0, len);
  for (let i = 0; i < extra; i++) { const w = i / extra; out[i] = out[i] * w + x[len + i] * (1 - w); }
  return out;
}

function texture(type: Extract<ModelSpec, { kind: 'texture' }>['type']): ModelOutput {
  const rand = random(type.length * 977 + type.charCodeAt(0));
  const noise = () => rand() * 2 - 1;
  // state-variable band-pass filter
  const bandpass = (len: number, fc: (t: number) => number, q: number, amp: (t: number) => number): Float32Array => {
    const out = new Float32Array(len);
    let low = 0, band = 0;
    for (let n = 0; n < len; n++) {
      const t = n / SR;
      const f = 2 * Math.sin(Math.PI * Math.min(0.24, fc(t) / SR));
      low += f * band;
      const high = noise() - low - q * band;
      band += f * high;
      out[n] = band * amp(t);
    }
    return out;
  };

  if (type === 'wind') {
    const len = 5 * SR, extra = SR;
    const x = bandpass(len + extra, (t) => 520 * (1 + 0.45 * Math.sin(2 * Math.PI * 0.23 * t + 1) + 0.25 * Math.sin(2 * Math.PI * 0.61 * t)), 0.35, (t) => 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.31 * t + 2));
    const data = finish(foldLoop(x, len), 0.3, 0, 0);
    return { data, midi: 60, loop: [0, len / SR] };
  }
  if (type === 'vinyl') {
    const len = 4 * SR, extra = SR / 2;
    const x = new Float32Array(len + extra);
    let lp = 0, ring = 0, ringV = 0;
    for (let n = 0; n < x.length; n++) {
      lp += 0.08 * (noise() - lp);
      if (rand() < 22 / SR) ringV += (0.3 + rand() * 0.7) * (rand() < 0.5 ? 1 : -1); // a click
      ringV += -0.35 * ring - 0.25 * ringV; // short resonant ring
      ring += ringV;
      x[n] = lp * 0.5 + ring;
    }
    return { data: finish(foldLoop(x, len), 0.22, 0, 0), midi: 60, loop: [0, len / SR] };
  }
  if (type === 'riser' || type === 'downlifter') {
    const dur = 4, len = dur * SR;
    const x = bandpass(len, (t) => 200 * Math.pow(45, t / dur), 0.5, (t) => Math.pow(t / dur, 1.5));
    let phase = 0;
    for (let n = 0; n < len; n++) { const t = n / SR; phase += (2 * Math.PI * 130 * Math.pow(4, t / dur)) / SR; x[n] += 0.25 * Math.pow(t / dur, 2) * Math.sin(phase); }
    if (type === 'downlifter') x.reverse();
    return { data: finish(x, 0.32, 0.02, 0.01), midi: 60 };
  }
  if (type === 'impact') {
    const len = Math.floor(2.4 * SR);
    const x = bandpass(len, (t) => 200 + 1800 * Math.exp(-t / 0.12), 1, (t) => 0.8 * Math.exp(-t / 0.25));
    let phase = 0;
    for (let n = 0; n < len; n++) { const t = n / SR; phase += (2 * Math.PI * (32 + 63 * Math.exp(-t / 0.18))) / SR; x[n] = Math.tanh(1.6 * (x[n] + Math.exp(-t / 0.7) * Math.sin(phase))); }
    return { data: finish(x, 0.34, 0.05), midi: 60 };
  }
  const zap = type === 'zap';
  const dur = zap ? 0.4 : 2.6, len = Math.floor(dur * SR);
  const x = new Float32Array(len);
  let phase = 0;
  for (let n = 0; n < len; n++) {
    const t = n / SR;
    const f = zap ? 180 + 3000 * Math.exp(-t / 0.05) : 28 + 82 * Math.exp(-t / 0.6);
    phase += (2 * Math.PI * f) / SR;
    x[n] = Math.sin(phase) * Math.exp(-t / (zap ? 0.12 : 1.2));
  }
  return { data: finish(x, 0.32, 0.03, 0.003), midi: 60 };
}

export function generateModel(spec: ModelSpec, midi: number): ModelOutput {
  switch (spec.kind) {
    case 'string': return pluck(midi, spec);
    case 'additive': return additive(midi, spec);
    case 'organ': return organ(midi, spec);
    case 'pad': return pad(midi, spec);
    case 'texture': return texture(spec.type);
  }
}
