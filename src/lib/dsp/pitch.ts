import { detectOnsets, fft, type Onset } from './rhythm';

// Monophonic audio-to-notes: a YIN pitch tracker whose frame-by-frame choices are made
// by a best-path search (so octave slips are avoided rather than patched afterwards),
// followed by note segmentation. Works on a mono signal (16 kHz) and returns seconds.

export type NoteIssue = 'unclear' | 'between' | 'octave' | 'short';

export interface DetectedNote {
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
  bend?: number[]; // pitch contour in cents around `pitch`, evenly spaced over the note
  dyn?: number[]; // loudness contour relative to the note's own average level
  confidence?: number; // 0..1: how sure the detector is about this note
  issue?: NoteIssue; // why a note may need checking
}

export interface MelodyResult {
  notes: DetectedNote[];
  voicedRatio: number;
  meanConfidence: number;
  snrDb: number; // level of the sung parts over the background
  contour: { hopSec: number; pitch: Float32Array }; // fractional MIDI per 10 ms frame, 0 = no pitch
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface PitchTrack {
  pitch: Float32Array; // fractional MIDI per frame, 0 = unvoiced
  conf: Float32Array; // 0..1 per frame: how periodic the sound is at the chosen pitch
  rms: Float32Array;
  frames: number;
  hop: number; // samples between frames (10 ms)
  maxRms: number;
  gate: number;
  noise: number; // estimated background level
  voicedRatio: number;
}

/** Two cascaded one-pole high-pass filters: removes rumble, hum and DC offset under the lowest sung note. */
function highpass(x: Float32Array, sr: number, hz: number): Float32Array {
  const a = 1 / (1 + (2 * Math.PI * hz) / sr);
  let y = new Float32Array(x.length), src = x;
  for (let pass = 0; pass < 2; pass++) {
    let prevIn = 0, prevOut = 0;
    for (let i = 0; i < src.length; i++) {
      const out = a * (prevOut + src[i] - prevIn);
      prevIn = src[i]; prevOut = out;
      y[i] = out;
    }
    if (pass === 0) { src = y; y = new Float32Array(x.length); }
  }
  return y;
}

const DIPS = 5; // candidate periods kept per frame
const CANDS = DIPS + 1; // plus one from the spectrum, for whistling
const UNVOICED = CANDS;

/**
 * Frame-by-frame pitch every 10 ms.
 *
 * Each frame offers up to five candidate periods (the dips of the YIN difference
 * function). Instead of taking the best dip of each frame on its own, the cheapest path
 * through all frames is found: a candidate costs its aperiodicity, and moving between
 * frames costs more the further the pitch jumps. One frame whose best dip is an octave
 * off no longer drags the note with it, because the octave jump costs more than staying.
 */
export async function trackPitch(input: Float32Array, sr: number, onProgress?: (fraction: number) => void): Promise<PitchTrack> {
  const x = highpass(input, sr, 55);
  const W = Math.round(sr * 0.04); // 40 ms analysis window
  const hop = Math.round(sr * 0.01); // 10 ms hop
  const minLag = Math.floor(sr / 1100); // highest pitch ~1100 Hz
  const maxLag = Math.ceil(sr / 65); // lowest pitch ~65 Hz
  const frames = Math.max(0, Math.floor((x.length - W - maxLag) / hop));
  const rms = new Float32Array(frames);

  let maxRms = 0;
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    let e = 0;
    for (let j = 0; j < W; j++) e += x[o + j] * x[o + j];
    rms[f] = Math.sqrt(e / W);
    if (rms[f] > maxRms) maxRms = rms[f];
  }
  // Background level: the quietest twentieth of the recording. The gate sits above it, but
  // never so high that soft singing is cut off when the whole take is sound.
  const sorted = Float32Array.from(rms).sort();
  const noise = frames ? sorted[Math.floor(frames * 0.05)] : 0;
  const gate = Math.max(0.004, maxRms * 0.05, Math.min(noise * 3, maxRms * 0.15));

  const candPitch = new Float32Array(frames * CANDS); // MIDI, 0 = no candidate
  const candCost = new Float32Array(frames * CANDS); // cost used by the path search
  const candAper = new Float32Array(frames * CANDS); // the plain aperiodicity, for confidence
  const d = new Float32Array(maxLag + 2);
  let active = 0;
  // for the whistle candidate
  const N = 1024, re = new Float32Array(N), im = new Float32Array(N), power = new Float32Array(N / 2);
  const loBin = Math.ceil((900 * N) / sr), hiBin = Math.floor((4000 * N) / sr);

  for (let f = 0; f < frames; f++) {
    if (rms[f] >= gate) {
      active++;
      const o = f * hop;
      // YIN: difference function with cumulative mean normalisation.
      let running = 0;
      for (let tau = 1; tau <= maxLag; tau++) {
        let sum = 0;
        for (let j = 0; j < W; j++) { const diff = x[o + j] - x[o + j + tau]; sum += diff * diff; }
        running += sum;
        d[tau] = running > 0 ? (sum * tau) / running : 1;
      }
      d[maxLag + 1] = 1;
      // Every dip is a candidate period. A sound repeats at every multiple of its period
      // too, so a high note has many equally deep dips; the shortest believable periods
      // are the ones to keep, or the true one can be crowded out by its own multiples.
      const dips: { tau: number; refined: number; value: number }[] = [];
      let deepest = 1;
      for (let tau = Math.max(2, minLag); tau <= maxLag; tau++) {
        if (!(d[tau] < 0.55 && d[tau] < d[tau - 1] && d[tau] <= d[tau + 1])) continue;
        // the true minimum lies between samples: fit a parabola through the three points
        const a = d[tau - 1], b = d[tau], c = d[tau + 1];
        const denom = a - 2 * b + c;
        const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
        const value = Math.max(0, b - 0.25 * (a - c) * shift);
        dips.push({ tau, refined: tau + shift, value });
        if (value < deepest) deepest = value;
      }
      const kept = dips.filter((p) => p.value <= deepest + 0.2).slice(0, DIPS);

      // Whistling sits above the range the period search can resolve at this sample rate,
      // but it is almost a pure tone, so its pitch can be read straight off the spectrum.
      // Only a tone that holds nearly all of the energy counts: a voice never does.
      let whistle = 0, purity = 0;
      for (let i = 0; i < N; i++) { re[i] = (x[o + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))); im[i] = 0; }
      fft(re, im);
      let total = 0, top = loBin;
      for (let k = 2; k < N / 2; k++) { power[k] = re[k] * re[k] + im[k] * im[k]; total += power[k]; }
      for (let k = loBin; k <= hiBin; k++) if (power[k] > power[top]) top = k;
      if (total > 0 && top > loBin && top < hiBin) {
        let near = 0;
        for (let k = top - 2; k <= top + 2; k++) near += power[k];
        purity = near / total;
        if (purity >= 0.8) {
          const a = Math.log(power[top - 1] + 1e-20), b = Math.log(power[top] + 1e-20), c = Math.log(power[top + 1] + 1e-20);
          whistle = ((top + (0.5 * (a - c)) / (a - 2 * b + c || 1)) * sr) / N;
        }
      }

      for (let i = 0; i < kept.length; i++) {
        const { refined, value } = kept[i];
        // A period that is a whole multiple of another believable candidate is that
        // candidate's sub-harmonic (the classic octave-down error): make it expensive.
        let cost = value;
        for (const other of kept) {
          if (other.refined >= refined) continue;
          const ratio = refined / other.refined, whole = Math.round(ratio);
          if (whole >= 2 && Math.abs(ratio - whole) < 0.04 * whole && (other.value < value + 0.08 || other.value < 0.06)) { cost += 0.25; break; }
        }
        if (whistle) {
          // with a pure tone present, a period that is a multiple of the tone's own is its sub-harmonic
          const ratio = whistle / (sr / refined), whole = Math.round(ratio);
          if (whole >= 2 && Math.abs(ratio - whole) < 0.05 * whole) cost += 0.25;
        }
        candPitch[f * CANDS + i] = 69 + 12 * Math.log2(sr / refined / 440);
        candCost[f * CANDS + i] = cost;
        candAper[f * CANDS + i] = value;
      }
      if (whistle) {
        candPitch[f * CANDS + DIPS] = 69 + 12 * Math.log2(whistle / 440);
        candCost[f * CANDS + DIPS] = candAper[f * CANDS + DIPS] = 0.9 * (1 - purity);
      }
    }
    if (f % 200 === 0) { onProgress?.((f / frames) * 0.95); await tick(); }
  }

  // Cheapest path through the candidates (and "no pitch") of every frame.
  const STATES = CANDS + 1;
  const back = new Uint8Array(frames * STATES);
  let prev = new Float32Array(STATES), cur = new Float32Array(STATES);
  const UNVOICED_COST = 0.42, SWITCH = 0.1, PER_SEMITONE = 0.035;
  for (let f = 0; f < frames; f++) {
    for (let s = 0; s < STATES; s++) {
      const voiced = s !== UNVOICED;
      const p = voiced ? candPitch[f * CANDS + s] : 0;
      let local: number;
      if (voiced) local = p > 0 ? candCost[f * CANDS + s] : Infinity;
      else local = rms[f] >= gate ? UNVOICED_COST : 0;
      let best = Infinity, from = UNVOICED;
      if (f === 0 || local === Infinity) { best = f === 0 ? 0 : Infinity; }
      else {
        for (let q = 0; q < STATES; q++) {
          if (prev[q] === Infinity) continue;
          let move: number;
          if (q === UNVOICED || !voiced) move = q === UNVOICED && !voiced ? 0 : SWITCH;
          else move = PER_SEMITONE * Math.min(14, Math.abs(p - candPitch[(f - 1) * CANDS + q]));
          if (prev[q] + move < best) { best = prev[q] + move; from = q; }
        }
      }
      cur[s] = best + local;
      back[f * STATES + s] = from;
    }
    const t = prev; prev = cur; cur = t;
  }
  const pitch = new Float32Array(frames), conf = new Float32Array(frames);
  if (frames) {
    let s = 0;
    for (let q = 1; q < STATES; q++) if (prev[q] < prev[s]) s = q;
    for (let f = frames - 1; f >= 0; f--) {
      if (s !== UNVOICED) {
        pitch[f] = candPitch[f * CANDS + s];
        conf[f] = Math.max(0, Math.min(1, 1 - candAper[f * CANDS + s] / 0.6));
      }
      s = back[f * STATES + s];
    }
  }

  // Remove the odd single-frame glitch that is left.
  const smooth = new Float32Array(frames);
  let voiced = 0;
  for (let f = 0; f < frames; f++) {
    if (pitch[f] === 0) continue;
    voiced++;
    const near: number[] = [];
    for (let k = Math.max(0, f - 2); k <= Math.min(frames - 1, f + 2); k++) if (pitch[k] > 0) near.push(pitch[k]);
    const m = median(near);
    smooth[f] = Math.abs(pitch[f] - m) > 2.5 ? m : pitch[f];
  }
  onProgress?.(0.97);
  return { pitch: smooth, conf, rms, frames, hop, maxRms, gate, noise, voicedRatio: active ? voiced / active : 0 };
}

interface Piece { start: number; end: number } // frames, end exclusive

/** Sample `values` at `points` evenly spaced positions (linear interpolation). */
function sample(values: number[], points: number): number[] {
  return Array.from({ length: points }, (_, i) => {
    const pos = (i / (points - 1)) * (values.length - 1);
    const a = Math.floor(pos), b = Math.min(values.length - 1, a + 1);
    return values[a] + (values[b] - values[a]) * (pos - a);
  });
}

/**
 * Notes from a hummed, sung, whistled or played single line.
 * `onsets` may be passed in when the caller has already computed them for the same audio.
 */
export async function detectMelody(x: Float32Array, sr: number, onProgress?: (fraction: number) => void, onsets?: Onset[]): Promise<MelodyResult> {
  const track = await trackPitch(x, sr, onProgress);
  const { pitch, conf, rms, frames, hop, maxRms, gate, noise, voicedRatio } = track;
  const dt = hop / sr;

  // A slow version of the pitch for deciding where notes change: a median over 130 ms
  // keeps the step between two notes sharp but flattens vibrato, which would otherwise
  // be cut into a string of short notes a semitone apart.
  const slow = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    if (pitch[f] === 0) continue;
    const near: number[] = [];
    for (let k = Math.max(0, f - 6); k <= Math.min(frames - 1, f + 6); k++) if (pitch[k] > 0) near.push(pitch[k]);
    slow[f] = median(near);
  }
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) env[f] = (rms[Math.max(0, f - 1)] + rms[f] + rms[Math.min(frames - 1, f + 1)]) / 3;

  // 1. Cut at silences and at lasting pitch changes.
  const rough: Piece[] = [];
  let start = -1, gap = 0, off = 0;
  let ref: number[] = [];
  for (let f = 0; f < frames; f++) {
    const p = slow[f];
    if (p === 0) {
      if (start >= 0 && ++gap > 4) { rough.push({ start, end: f - gap + 1 }); start = -1; }
      continue;
    }
    gap = 0;
    if (start < 0) { start = f; ref = [p]; off = 0; continue; }
    if (Math.abs(p - median(ref.slice(-40))) > 0.7) {
      if (++off >= 3) {
        const at = f - off + 1;
        rough.push({ start, end: at });
        start = at; ref = [];
        for (let k = at; k <= f; k++) if (slow[k] > 0) ref.push(slow[k]);
        off = 0;
      }
    } else { off = 0; ref.push(p); }
  }
  if (start >= 0) rough.push({ start, end: frames - gap });

  // 2. Cut held pitches where the note was struck again: the level dips and comes back.
  //    A deep dip is enough on its own; a shallow one counts only together with a fresh
  //    attack in the spectrum (a new syllable), so that the gentle pulsing of vibrato is
  //    not mistaken for repeated notes.
  const attacks = (onsets ?? detectOnsets(x, sr, { minStrength: 0.05 })).filter((o) => o.strength >= 0.16).map((o) => Math.round(o.time / dt));
  const attackNear = (a: number, b: number) => attacks.some((t) => t >= a && t <= b);
  const pieces: Piece[] = [];
  for (const piece of rough) {
    let from = piece.start, peak = env[from];
    for (let f = piece.start + 1; f < piece.end - 1; f++) {
      if (env[f] > peak) peak = env[f];
      if (f - from < 6 || piece.end - f < 5 || !(env[f] <= env[f - 1] && env[f] < env[f + 1])) continue;
      let after = 0;
      for (let k = f + 1; k <= Math.min(piece.end - 1, f + 10); k++) if (env[k] > after) after = env[k];
      const deep = env[f] < 0.5 * peak && after > 1.5 * env[f] && after > gate * 1.5;
      const shallow = env[f] < 0.78 * Math.min(peak, after) && attackNear(f - 2, f + 7);
      if (deep || shallow) { pieces.push({ start: from, end: f }); from = f; peak = env[f]; }
    }
    pieces.push({ start: from, end: piece.end });
  }

  // 3. Slivers shorter than 70 ms are the slide into (or out of) a note, not notes of
  //    their own: they join the note they lead into, or the one they trail from.
  const centreOf = (p: Piece): number => {
    const vals: number[] = [];
    for (let f = p.start; f < p.end; f++) if (pitch[f] > 0) vals.push(pitch[f]);
    return vals.length ? median(vals) : 0;
  };
  const joined: Piece[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const p = { ...pieces[i] };
    if (p.end - p.start >= 7) { joined.push(p); continue; }
    // collect a run of touching slivers
    let j = i;
    while (j + 1 < pieces.length && pieces[j + 1].start === pieces[j].end && pieces[j + 1].end - pieces[j + 1].start < 7) j++;
    const run = { start: p.start, end: pieces[j].end };
    const next = pieces[j + 1], prev = joined[joined.length - 1];
    if (next && next.start === run.end && Math.abs(centreOf(pieces[j]) - centreOf(next)) <= 4) { pieces[j + 1] = { start: run.start, end: next.end }; }
    else if (prev && prev.end === run.start && Math.abs(centreOf(p) - centreOf(prev)) <= 4) { prev.end = run.end; }
    else if (run.end - run.start >= 7) joined.push(run);
    i = j;
  }

  // 4. Measure each note.
  const notes: DetectedNote[] = [];
  for (const p of joined) {
    const len = p.end - p.start;
    const all: number[] = [], confs: number[] = [], levels: number[] = [];
    let held = 0;
    for (let f = p.start; f < p.end; f++) {
      if (pitch[f] > 0) { held = pitch[f]; confs.push(conf[f]); }
      else if (!held) { for (let k = f + 1; k < p.end; k++) if (pitch[k] > 0) { held = pitch[k]; break; } }
      all.push(held);
      levels.push(env[f]);
    }
    if (len < 6 || confs.length < 5) continue; // shorter than ~60 ms: a glitch, not a note
    const skip = Math.min(6, Math.floor(len * 0.2)); // the scoop into the note does not vote on its pitch
    const body = all.slice(skip).filter((v) => v > 0);
    const med = median(body);
    const centre = Math.round(med);
    const meanE = levels.reduce((a, b) => a + b, 0) / levels.length;

    let bend: number[] | undefined;
    const cents = all.map((v) => Math.max(-200, Math.min(200, (v - centre) * 100)));
    if (cents.some((c) => Math.abs(c) > 30)) bend = sample(cents, Math.min(24, Math.max(2, Math.round(len / 3)))).map(Math.round);

    let dyn: number[] | undefined;
    if (len >= 25 && meanE > 0) {
      // Every sung note fades in and out at its ends; that is not expression, and the
      // instrument has an attack and release of its own. Only the body of the note counts.
      const a = 4, b = len - 5;
      const inner = levels.slice(a, b + 1);
      const bodyMean = inner.reduce((x, y) => x + y, 0) / inner.length;
      const rel = levels.map((_, k) => Math.max(0.25, Math.min(1.8, levels[Math.max(a, Math.min(b, k))] / bodyMean)));
      const pts = sample(rel, Math.min(12, Math.max(3, Math.round(len / 8))));
      if (Math.max(...pts) - Math.min(...pts) > 0.3) dyn = pts.map((v) => Math.round(v * 100) / 100);
    }

    // Confidence: how periodic the sound was, how steadily it sat on the note, and how
    // close its pitch was to the note it was rounded to.
    const periodic = confs.reduce((a, b) => a + b, 0) / confs.length;
    let steady = 0, counted = 0;
    for (let f = p.start + skip; f < p.end; f++) if (slow[f] > 0) { counted++; if (Math.abs(slow[f] - centre) <= 0.6) steady++; }
    const steadiness = counted ? steady / counted : 0;
    const offCentre = Math.abs(med - centre); // 0..0.5 semitones
    const confidence = Math.max(0, Math.min(1, periodic ** 0.7 * (0.5 + 0.5 * steadiness) * (1 - 2 * Math.max(0, offCentre - 0.2)) * (len >= 9 ? 1 : 0.8)));
    let issue: NoteIssue | undefined;
    if (offCentre > 0.36) issue = 'between';
    else if (periodic < 0.5 || steadiness < 0.6) issue = 'unclear';
    else if (len < 9) issue = 'short';

    notes.push({
      pitch: centre, start: p.start * dt, duration: len * dt,
      velocity: Math.max(0.3, Math.min(1, 0.35 + 0.65 * Math.sqrt(meanE / (maxRms || 1)))),
      bend, dyn, confidence: Math.round(confidence * 100) / 100, issue,
    });
  }

  // 5. Join the pieces that vibrato or a slide still broke off: touching notes a semitone
  //    apart where one of them is too short to have been meant as a note.
  const merged: DetectedNote[] = [];
  for (const n of notes) {
    const prev = merged[merged.length - 1];
    if (prev && n.start - (prev.start + prev.duration) < 0.03 && Math.abs(prev.pitch - n.pitch) === 1 && (n.duration < 0.1 || prev.duration < 0.1)) {
      const keep = n.duration > prev.duration ? n : prev;
      prev.duration = n.start + n.duration - prev.start;
      prev.pitch = keep.pitch;
      prev.confidence = Math.min(prev.confidence ?? 1, n.confidence ?? 1, 0.6);
      prev.issue = prev.issue ?? 'unclear';
      prev.bend = undefined;
      prev.dyn = undefined;
      continue;
    }
    merged.push({ ...n });
  }

  // 6. A lone note an octave or more away from both of its neighbours may be a real leap
  //    or a tracking slip. It is kept as heard, but marked for checking.
  for (let i = 1; i + 1 < merged.length; i++) {
    const a = merged[i].pitch - merged[i - 1].pitch, b = merged[i].pitch - merged[i + 1].pitch;
    if (Math.abs(a) >= 11 && Math.abs(b) >= 11 && Math.sign(a) === Math.sign(b) && Math.abs(merged[i - 1].pitch - merged[i + 1].pitch) <= 5) {
      merged[i].issue = 'octave';
      merged[i].confidence = Math.min(merged[i].confidence ?? 1, 0.45);
    }
  }

  let sung = 0, count = 0;
  for (let f = 0; f < frames; f++) if (pitch[f] > 0) { sung += rms[f]; count++; }
  const meanConfidence = merged.length ? merged.reduce((a, n) => a + (n.confidence ?? 0), 0) / merged.length : 0;
  onProgress?.(1);
  return {
    notes: merged, voicedRatio, meanConfidence,
    snrDb: count && noise > 0 ? 20 * Math.log10(sung / count / noise) : 60,
    contour: { hopSec: dt, pitch },
  };
}

/** Reduce possibly overlapping (polyphonic) detections to a single melody line. */
export function monophonize(notes: DetectedNote[]): DetectedNote[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start || b.velocity - a.velocity);
  const out: DetectedNote[] = [];
  for (const n of sorted) {
    const prev = out[out.length - 1];
    if (!prev) { out.push({ ...n }); continue; }
    const prevEnd = prev.start + prev.duration;
    const overlap = prevEnd - n.start;
    if (overlap <= 0.02) { out.push({ ...n }); continue; }
    if (overlap > 0.5 * Math.min(prev.duration, n.duration)) {
      // mostly simultaneous: keep the stronger one
      if (n.velocity > prev.velocity * 1.15) out[out.length - 1] = { ...n, start: prev.start, duration: Math.max(prevEnd, n.start + n.duration) - prev.start };
      else prev.duration = Math.max(prevEnd, n.start + n.duration) - prev.start;
    } else {
      prev.duration = n.start - prev.start;
      out.push({ ...n });
    }
  }
  return out.filter((n) => n.duration >= 0.06);
}
