// The pitch tracker as it was before the voice-to-instrument upgrade, kept only so the
// benchmark can show old against new on the same recordings. Not used by the app.
// Monophonic audio-to-notes: a YIN pitch tracker followed by note segmentation.
// Works on a mono signal (16 kHz recommended) and returns notes in seconds.

export interface DetectedNote { pitch: number; start: number; duration: number; velocity: number; bend?: number[] }
export interface MelodyResult { notes: DetectedNote[]; voicedRatio: number }

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface PitchTrack {
  pitch: Float32Array; // fractional MIDI per frame, 0 = unvoiced
  rms: Float32Array;
  frames: number;
  hop: number; // samples between frames (10 ms)
  maxRms: number;
  gate: number;
  voicedRatio: number;
}

/** Frame-by-frame pitch every 10 ms: YIN, an energy gate, median smoothing and octave-jump repair. */
export async function trackPitch(x: Float32Array, sr: number, onProgress?: (fraction: number) => void): Promise<PitchTrack> {
  const W = Math.round(sr * 0.04); // 40 ms analysis window
  const hop = Math.round(sr * 0.01); // 10 ms hop
  const minLag = Math.floor(sr / 1100); // highest pitch ~1100 Hz
  const maxLag = Math.ceil(sr / 65); // lowest pitch ~65 Hz
  const frames = Math.max(0, Math.floor((x.length - W - maxLag) / hop));
  const pitch = new Float32Array(frames); // MIDI (fractional); 0 = unvoiced
  const rms = new Float32Array(frames);
  const d = new Float32Array(maxLag + 2);

  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    let e = 0;
    for (let j = 0; j < W; j++) e += x[o + j] * x[o + j];
    rms[f] = Math.sqrt(e / W);
    if (rms[f] > 0.003) {
      // YIN: difference function, cumulative mean normalisation, absolute threshold.
      let running = 0, best = -1, bestVal = 1;
      for (let tau = 1; tau <= maxLag; tau++) {
        let sum = 0;
        for (let j = 0; j < W; j++) { const diff = x[o + j] - x[o + j + tau]; sum += diff * diff; }
        running += sum;
        d[tau] = running > 0 ? (sum * tau) / running : 1;
      }
      for (let tau = minLag; tau <= maxLag; tau++) {
        if (d[tau] < 0.15) {
          while (tau + 1 <= maxLag && d[tau + 1] < d[tau]) tau++;
          best = tau; bestVal = d[tau];
          break;
        }
        if (d[tau] < bestVal) { bestVal = d[tau]; best = tau; }
      }
      if (best > 0 && bestVal < 0.3) {
        const a = d[Math.max(1, best - 1)], b = d[best], c = d[Math.min(maxLag, best + 1)];
        const denom = a - 2 * b + c;
        const refined = best + (denom !== 0 ? (0.5 * (a - c)) / denom : 0);
        pitch[f] = 69 + 12 * Math.log2(sr / refined / 440);
      }
    }
    if (f % 200 === 0) { onProgress?.(f / frames); await tick(); }
  }

  // Energy gate relative to the loudest part of the recording.
  let maxRms = 0;
  for (let f = 0; f < frames; f++) if (rms[f] > maxRms) maxRms = rms[f];
  const gate = Math.max(0.004, maxRms * 0.06);
  let voiced = 0, active = 0;
  for (let f = 0; f < frames; f++) {
    if (rms[f] < gate) pitch[f] = 0;
    if (rms[f] >= gate) active++;
    if (pitch[f] > 0) voiced++;
  }

  // Median smoothing and octave-jump repair.
  const smooth = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    if (pitch[f] === 0) continue;
    const near: number[] = [];
    for (let k = Math.max(0, f - 2); k <= Math.min(frames - 1, f + 2); k++) if (pitch[k] > 0) near.push(pitch[k]);
    const m = median(near);
    let p = pitch[f];
    if (Math.abs(Math.abs(p - m) - 12) < 0.8) p += p < m ? 12 : -12;
    smooth[f] = Math.abs(p - m) > 2.5 ? m : p;
  }
  return { pitch: smooth, rms, frames, hop, maxRms, gate, voicedRatio: active ? voiced / active : 0 };
}

export async function detectMelody(x: Float32Array, sr: number, onProgress?: (fraction: number) => void): Promise<MelodyResult> {
  const { pitch: smooth, rms, frames, hop, maxRms, gate, voicedRatio } = await trackPitch(x, sr, onProgress);

  // Segment into notes: split on silence, on a sustained pitch change, or on an energy dip.
  interface Seg { start: number; end: number; pitches: number[]; energy: number[] }
  const segs: Seg[] = [];
  let cur: Seg | null = null;
  let gap = 0, off = 0, peak = 0;
  const close = (end: number) => { if (cur) { cur.end = end; segs.push(cur); cur = null; } };
  for (let f = 0; f < frames; f++) {
    const p = smooth[f];
    if (p === 0) {
      if (cur && ++gap > 4) close(f - gap + 1);
      continue;
    }
    gap = 0;
    if (!cur) { cur = { start: f, end: f, pitches: [p], energy: [rms[f]] }; off = 0; peak = rms[f]; continue; }
    const ref = median(cur.pitches.slice(-25));
    if (Math.abs(p - ref) > 0.75) {
      if (++off >= 4) {
        const at = f - off + 1;
        cur.pitches.splice(cur.pitches.length - (off - 1));
        cur.energy.splice(cur.energy.length - (off - 1));
        close(at);
        cur = { start: at, end: f, pitches: [], energy: [] };
        for (let k = at; k <= f; k++) { cur.pitches.push(smooth[k] || p); cur.energy.push(rms[k]); }
        off = 0; peak = rms[f];
        continue;
      }
    } else off = 0;
    // re-articulation on the same pitch: the level dipped to under half the note's peak and is rising again
    if (cur.pitches.length > 8) {
      let low = rms[f - 1], lowAt = f - 1;
      for (let k = f - 2; k >= Math.max(cur.start + 4, f - 8); k--) if (rms[k] < low) { low = rms[k]; lowAt = k; }
      if (low < peak * 0.5 && rms[f] > low * 1.5 && rms[f] > gate * 1.5 && f - lowAt >= 2) {
        const keep = lowAt - cur.start;
        const carriedP: number[] = cur.pitches.splice(keep);
        const carriedE: number[] = cur.energy.splice(keep);
        close(lowAt);
        cur = { start: lowAt, end: f, pitches: [...carriedP, p], energy: [...carriedE, rms[f]] };
        off = 0; peak = rms[f];
        continue;
      }
    }
    cur.pitches.push(p);
    cur.energy.push(rms[f]);
    if (rms[f] > peak) peak = rms[f];
  }
  close(frames);

  const dt = hop / sr;
  const notes: DetectedNote[] = [];
  for (const s of segs) {
    const len = s.end - s.start;
    if (len < 7 || s.pitches.length < 5) continue; // shorter than ~70 ms: a glitch, not a note
    const body = s.pitches.length > 6 ? s.pitches.slice(2) : s.pitches; // skip the scoop into the note
    const center = Math.round(median(body));
    const meanE = s.energy.reduce((a, b) => a + b, 0) / s.energy.length;
    const cents = s.pitches.map((p) => Math.max(-200, Math.min(200, (p - center) * 100)));
    let bend: number[] | undefined;
    if (cents.some((c) => Math.abs(c) > 25)) {
      const points = Math.min(16, Math.max(2, Math.round(len / 4)));
      bend = Array.from({ length: points }, (_, i) => {
        const pos = (i / (points - 1)) * (cents.length - 1);
        const a = Math.floor(pos), b = Math.min(cents.length - 1, a + 1);
        return Math.round(cents[a] + (cents[b] - cents[a]) * (pos - a));
      });
    }
    notes.push({
      pitch: center, start: s.start * dt, duration: len * dt,
      velocity: Math.max(0.3, Math.min(1, 0.35 + 0.65 * Math.sqrt(meanE / (maxRms || 1)))), bend,
    });
  }

  // Absorb slivers created by vibrato or slides into the neighbouring note.
  const merged: DetectedNote[] = [];
  for (const n of notes) {
    const prev = merged[merged.length - 1];
    if (prev && n.start - (prev.start + prev.duration) < 0.03 && Math.abs(prev.pitch - n.pitch) <= 1 && (n.duration < 0.1 || prev.duration < 0.1)) {
      const keep = n.duration > prev.duration ? n.pitch : prev.pitch;
      prev.duration = n.start + n.duration - prev.start;
      prev.pitch = keep;
      prev.bend = undefined;
      continue;
    }
    merged.push({ ...n });
  }
  onProgress?.(1);
  return { notes: merged, voicedRatio };
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
