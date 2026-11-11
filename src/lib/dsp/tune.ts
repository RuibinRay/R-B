import { clamp, inScale, type Key } from '../music';
import { trackPitch } from './pitch';

// Pitch correction for a single voice or instrument.
//
// 1. Track the pitch every 10 ms (YIN).
// 2. For every voiced frame pick the nearest allowed note and work out how far to
//    move, smoothed by a glide time so slides and vibrato can survive.
// 3. Resynthesize with TD-PSOLA: the waveform is cut into pitch-period grains and
//    the grains are laid back down closer together (higher) or further apart
//    (lower). Timing and length do not change, and unvoiced sound passes through.

export interface TuneOptions {
  key: Key | null; // null = any semitone
  strength: number; // 0..1, how much of the correction is applied
  speedMs: number; // glide time; 0 snaps instantly
  transpose: number; // extra shift in semitones
}

export interface TuneResult {
  channels: Float32Array[];
  sampleRate: number;
  /** Pitch per 10 ms frame as fractional MIDI (0 = unvoiced), before and after. */
  curve: { hopSec: number; original: Float32Array; corrected: Float32Array };
  voicedRatio: number;
  meanCents: number; // average size of the correction on voiced frames
}

const ANALYSIS_RATE = 16000;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function mixDown(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] / channels.length;
  return out;
}

function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(x.length / ratio));
  const span = Math.max(1, Math.floor(ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    let s = 0;
    for (let k = 0; k < span; k++) s += x[Math.min(x.length - 1, start + k)];
    out[i] = s / span;
  }
  return out;
}

function nearestAllowed(pitch: number, key: Key | null): number {
  if (!key) return Math.round(pitch);
  let best = Math.round(pitch), bestD = Infinity;
  for (let n = Math.floor(pitch) - 6; n <= Math.ceil(pitch) + 6; n++) {
    const d = Math.abs(n - pitch);
    if (d < bestD && inScale(n, key)) { bestD = d; best = n; }
  }
  return best;
}

export async function tuneAudio(channels: Float32Array[], sampleRate: number, opts: TuneOptions, onProgress?: (fraction: number) => void): Promise<TuneResult> {
  const n = channels[0]?.length ?? 0;
  const mono = mixDown(channels);
  const track = await trackPitch(resample(mono, sampleRate, ANALYSIS_RATE), ANALYSIS_RATE, (f) => onProgress?.(f * 0.55));
  const { frames, pitch } = track;
  const hopSec = track.hop / ANALYSIS_RATE;
  const frameCentre = 0.02; // a frame describes the 40 ms that start at its position

  // ---- how far to move each frame (semitones) ----
  const shift = new Float32Array(frames);
  const corrected = new Float32Array(frames);
  const alpha = opts.speedMs <= 1 ? 1 : 1 - Math.exp(-(hopSec * 1000) / opts.speedMs);
  // Stretches of continuous pitch: a new one starts after silence or a leap.
  const segStart = new Int32Array(frames), segEnd = new Int32Array(frames);
  for (let f = 0, open = -1; f <= frames; f++) {
    const isVoiced = f < frames && pitch[f] > 0;
    const leap = isVoiced && f > 0 && pitch[f - 1] > 0 && Math.abs(pitch[f] - pitch[f - 1]) > 0.8;
    if (open >= 0 && (!isVoiced || leap)) {
      for (let k = open; k < f; k++) { segStart[k] = open; segEnd[k] = f - 1; }
      open = -1;
    }
    if (isVoiced && open < 0) open = f;
  }

  let note = -1, glide = 0, wasVoiced = false, voiced = 0, cents = 0;
  const SPAN = 9; // a 190 ms window: about one cycle of vibrato
  for (let f = 0; f < frames; f++) {
    const m = pitch[f];
    if (m <= 0) { wasVoiced = false; continue; }
    // The note being aimed for is chosen from the average pitch around this moment,
    // so vibrato that swings past the halfway point does not flip to the next note.
    // At the edges of a stretch the window slides inward to keep a whole cycle in view.
    let lo = Math.max(segStart[f], f - SPAN), hi = Math.min(segEnd[f], f + SPAN);
    if (lo === segStart[f]) hi = Math.min(segEnd[f], lo + 2 * SPAN);
    if (hi === segEnd[f]) lo = Math.max(segStart[f], hi - 2 * SPAN);
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += pitch[k];
    const middle = sum / (hi - lo + 1);
    const near = nearestAllowed(middle, opts.key);
    // ...and it only changes once another note is clearly closer
    if (!wasVoiced || f === segStart[f] || note < 0 || Math.abs(middle - note) > Math.abs(middle - near) + 0.15) note = near;
    const want = clamp(note - m, -3, 3);
    glide = wasVoiced ? glide + (want - glide) * alpha : want;
    const fix = opts.strength * glide;
    shift[f] = fix + opts.transpose;
    corrected[f] = m + shift[f];
    cents += Math.abs(fix) * 100;
    voiced++;
    wasVoiced = true;
  }

  const frameOf = (sample: number) => clamp(Math.round((sample / sampleRate - frameCentre) / hopSec), 0, Math.max(0, frames - 1));
  const out = channels.map(() => new Float32Array(n));
  if (!frames || !voiced) {
    channels.forEach((ch, c) => out[c].set(ch));
    onProgress?.(1);
    return { channels: out, sampleRate, curve: { hopSec, original: pitch, corrected }, voicedRatio: 0, meanCents: 0 };
  }

  // ---- analysis marks: one per pitch period in voiced sound, every 5 ms elsewhere ----
  const unvoicedStep = Math.round(sampleRate * 0.005);
  const periodAt = (sample: number): number => {
    const m = pitch[frameOf(sample)];
    return m > 0 ? sampleRate / (440 * Math.pow(2, (m - 69) / 12)) : 0;
  };
  const peak = (from: number, to: number): number => {
    let best = clamp(Math.round(from), 0, n - 1), bestV = -Infinity;
    for (let i = Math.max(0, Math.round(from)); i <= Math.min(n - 1, Math.round(to)); i++) if (mono[i] > bestV) { bestV = mono[i]; best = i; }
    return best;
  };
  const marks: number[] = [];
  let pos = 0, inVoiced = false;
  while (pos < n) {
    const P = periodAt(pos);
    let at: number;
    if (P > 0) {
      // lock every mark to the waveform's peak so neighbouring grains line up
      at = inVoiced ? peak(pos - P * 0.25, pos + P * 0.25) : peak(pos, pos + P);
      inVoiced = true;
    } else {
      at = Math.round(pos);
      inVoiced = false;
    }
    const last = marks.length ? marks[marks.length - 1] : -1;
    if (at <= last) at = last + 1;
    if (at >= n) break;
    marks.push(at);
    const next = periodAt(at);
    pos = at + (next > 0 ? next : unvoicedStep);
  }
  if (marks.length < 2) {
    channels.forEach((ch, c) => out[c].set(ch));
    onProgress?.(1);
    return { channels: out, sampleRate, curve: { hopSec, original: pitch, corrected }, voicedRatio: track.voicedRatio, meanCents: cents / voiced };
  }

  // ---- synthesis: overlap-add grains at the new spacing ----
  const wsum = new Float32Array(n);
  let ts = marks[0], ai = 0, count = 0;
  while (ts < n) {
    while (ai + 1 < marks.length && Math.abs(marks[ai + 1] - ts) <= Math.abs(marks[ai] - ts)) ai++;
    const a = marks[ai];
    const R = ai + 1 < marks.length ? marks[ai + 1] - a : a - marks[ai - 1];
    const L = ai > 0 ? a - marks[ai - 1] : R;
    const f = frameOf(a);
    const ratio = pitch[f] > 0 ? Math.pow(2, shift[f] / 12) : 1;
    const centreOut = Math.round(ts);
    // a Hann half on each side, sized to the neighbouring periods, so unshifted grains sum back to the input exactly
    for (let k = -L; k < R; k++) {
      const src = a + k, dst = centreOut + k;
      if (src < 0 || src >= n || dst < 0 || dst >= n) continue;
      const w = 0.5 * (1 + Math.cos((Math.PI * k) / (k < 0 ? L : R)));
      wsum[dst] += w;
      for (let c = 0; c < channels.length; c++) out[c][dst] += channels[c][src] * w;
    }
    ts += R / ratio;
    if (++count % 4000 === 0) { onProgress?.(0.55 + 0.45 * Math.min(1, ts / n)); await tick(); }
  }
  for (let c = 0; c < channels.length; c++) {
    const o = out[c], x = channels[c];
    for (let i = 0; i < n; i++) o[i] = wsum[i] < 0.05 ? x[i] : o[i] / Math.max(0.5, wsum[i]);
  }
  onProgress?.(1);
  return { channels: out, sampleRate, curve: { hopSec, original: pitch, corrected }, voicedRatio: track.voicedRatio, meanCents: cents / voiced };
}
