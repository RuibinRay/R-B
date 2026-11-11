import type { Note } from '../types';
import { CHORDS, NOTE_NAMES, chordSuffix, diatonicChords, shiftDegrees, uid, type Key } from './music';

// Rule-based arrangement helpers: chord suggestions from a melody, and chord,
// bass, drum and harmony parts. These are music-theory heuristics, not a model.

export interface ChordEvent { beat: number; length: number; rootPc: number; quality: string; label: string }
type MelodyNote = Pick<Note, 'pitch' | 'start' | 'duration'>;

const mk = (pitch: number, start: number, duration: number, velocity: number): Note => ({ id: uid(), pitch, start, duration, velocity });

const PRIOR_MAJOR = [0.25, 0.08, 0.04, 0.2, 0.2, 0.14, 0];
const PRIOR_MINOR = [0.25, 0, 0.12, 0.16, 0.14, 0.18, 0.15];

/** One diatonic triad per bar, chosen by how well its tones cover the melody in that bar. */
export function suggestChords(melody: MelodyNote[], key: Key, totalBeats: number, bar: number): ChordEvent[] {
  const cands = diatonicChords(key).filter((c) => c.quality === 'maj' || c.quality === 'min');
  const prior = key.scale === 'major' || key.scale === 'lydian' || key.scale === 'mixolydian' || key.scale === 'majorPentatonic' ? PRIOR_MAJOR : PRIOR_MINOR;
  const bars = Math.max(1, Math.ceil(totalBeats / bar - 1e-6));
  const out: ChordEvent[] = [];
  let prev = cands[0];
  for (let b = 0; b < bars; b++) {
    const s = b * bar, e = s + bar;
    const inBar = melody.filter((n) => n.start < e && n.start + n.duration > s);
    let best = prev, bestScore = -Infinity;
    if (inBar.length) {
      for (const c of cands) {
        const tones = new Set(CHORDS[c.quality].steps.map((st) => (c.rootPc + st) % 12));
        let score = prior[c.degree] ?? 0;
        for (const n of inBar) {
          const w = (Math.min(e, n.start + n.duration) - Math.max(s, n.start)) / bar;
          const pc = ((n.pitch % 12) + 12) % 12;
          score += tones.has(pc) ? w : -0.45 * w;
          if (n.start >= s - 0.01 && n.start < s + 0.26 && tones.has(pc)) score += 0.15;
        }
        if (b === 0 && c.degree === 0) score += 0.2;
        if (b === bars - 1 && c.degree === 0) score += 0.15;
        if (c === prev) score -= 0.05;
        if (score > bestScore) { bestScore = score; best = c; }
      }
    }
    prev = best;
    out.push({ beat: s, length: bar, rootPc: best.rootPc, quality: best.quality, label: best.label });
  }
  return out;
}

export function parseChord(name: string): { rootPc: number; quality: string } {
  const m = /^([A-G])([#b]?)(.*)$/.exec(name);
  if (!m) return { rootPc: 0, quality: 'maj' };
  const base = ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as Record<string, number>)[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  const quality = ({ '': 'maj', m: 'min', '7': '7', maj7: 'maj7', m7: 'min7', '5': 'pow', sus2: 'sus2', sus4: 'sus4', dim: 'dim' } as Record<string, string>)[m[3]] ?? 'maj';
  return { rootPc: (base + 12) % 12, quality };
}

/** Chord names ("Am", "F", "Cmaj7") laid out one per bar. */
export function progression(names: string[], bar: number): ChordEvent[] {
  return names.map((name, i) => {
    const c = parseChord(name);
    return { beat: i * bar, length: bar, ...c, label: NOTE_NAMES[c.rootPc] + (chordSuffix[c.quality] ?? '') };
  });
}

const tonesOf = (c: ChordEvent, octave: number): number[] => {
  const base = 12 * (octave + 1) + c.rootPc;
  return (CHORDS[c.quality] ?? CHORDS.maj).steps.map((s) => base + s);
};

export type ChordStyle = 'block' | 'half' | 'stab' | 'eighths' | 'arp' | 'arp8';

export function chordPart(chords: ChordEvent[], style: ChordStyle, octave = 4, velocity = 0.62): Note[] {
  const out: Note[] = [];
  for (const c of chords) {
    const tones = tonesOf(c, octave);
    const hits = (times: number[], dur: number, vel = velocity) => {
      for (const t of times) if (t < c.length) for (const p of tones) out.push(mk(p, c.beat + t, Math.min(dur, c.length - t), vel));
    };
    const range = (step: number, from = 0) => Array.from({ length: Math.ceil((c.length - from) / step) }, (_, i) => from + i * step);
    if (style === 'block') hits([0], c.length * 0.98);
    else if (style === 'half') hits(range(2), 1.9);
    else if (style === 'stab') hits(range(1, 0.5), 0.25);
    else if (style === 'eighths') hits(range(0.5), 0.42);
    else {
      const step = style === 'arp' ? 0.25 : 0.5;
      const cycle = [...tones, tones[0] + 12];
      range(step).forEach((t, i) => out.push(mk(cycle[i % cycle.length], c.beat + t, step * 0.95, i % 4 === 0 ? velocity : velocity * 0.8)));
    }
  }
  return out;
}

export type BassStyle = 'roots' | 'pulse' | 'bounce' | 'offbeat';

export function bassPart(chords: ChordEvent[], style: BassStyle, low = 28, velocity = 0.8): Note[] {
  const out: Note[] = [];
  for (const c of chords) {
    const root = low + ((c.rootPc - (low % 12) + 12) % 12);
    const add = (t: number, dur: number, p = root, v = velocity) => { if (t < c.length) out.push(mk(p, c.beat + t, Math.min(dur, c.length - t), v)); };
    if (style === 'roots') add(0, c.length * 0.97);
    else if (style === 'pulse') for (let t = 0; t < c.length; t += 0.5) add(t, 0.45, root, t % 1 === 0 ? velocity : velocity * 0.85);
    else if (style === 'offbeat') for (let t = 0.5; t < c.length; t += 1) add(t, 0.4);
    else { add(0, 1.4); add(2, 0.9); add(3, 0.9, root + 7, velocity * 0.85); }
  }
  return out;
}

export type DrumStyle = 'basic' | 'pop' | 'rock' | 'electronic' | 'lofi';

export function drumPart(totalBeats: number, bar: number, style: DrumStyle): Note[] {
  const out: Note[] = [];
  const bars = Math.max(1, Math.ceil(totalBeats / bar - 1e-6));
  const hit = (b: number, t: number, pitch: number, v: number) => { if (t < bar) out.push(mk(pitch, b * bar + t, 0.24, v)); };
  for (let b = 0; b < bars; b++) {
    if (bar !== 4) {
      // Any other meter: kick on one, snare on the middle beat, steady hats.
      hit(b, 0, 36, 0.9);
      hit(b, Math.floor(bar / 2), 38, 0.8);
      for (let t = 0; t < bar; t += 0.5) hit(b, t, 42, t % 1 === 0 ? 0.6 : 0.4);
      continue;
    }
    if (style === 'electronic') {
      for (let t = 0; t < 4; t++) { hit(b, t, 36, 0.95); hit(b, t + 0.5, 42, 0.55); }
      hit(b, 1, 39, 0.8); hit(b, 3, 39, 0.8);
      if (b % 2 === 1) hit(b, 3.5, 46, 0.5);
    } else if (style === 'rock') {
      hit(b, 0, 36, 0.95); hit(b, 1.5, 36, 0.8); hit(b, 2, 36, 0.9);
      hit(b, 1, 38, 0.9); hit(b, 3, 38, 0.9);
      for (let t = 0; t < 4; t += 0.5) hit(b, t, 42, t % 1 === 0 ? 0.65 : 0.45);
      if (b % 4 === 0) hit(b, 0, 49, 0.7);
    } else if (style === 'lofi') {
      hit(b, 0, 36, 0.8); hit(b, 2.5, 36, 0.7);
      hit(b, 1, 37, 0.6); hit(b, 3, 38, 0.6);
      for (let t = 0; t < 4; t += 0.5) hit(b, t % 1 === 0 ? t : t + 0.08, 42, t % 1 === 0 ? 0.45 : 0.3);
    } else {
      hit(b, 0, 36, 0.9); hit(b, 2, 36, 0.85);
      if (style === 'pop' && b % 2 === 1) hit(b, 2.5, 36, 0.7);
      hit(b, 1, 38, 0.85); hit(b, 3, 38, 0.85);
      for (let t = 0; t < 4; t += 0.5) hit(b, t, 42, t % 1 === 0 ? 0.6 : 0.42);
    }
  }
  return out;
}

/** A parallel line a fixed number of scale degrees from the melody (default: a third below). */
export function harmonyPart(melody: Note[], key: Key, degrees = -2): Note[] {
  return melody.map((n) => mk(shiftDegrees(n.pitch, degrees, key), n.start, n.duration, n.velocity * 0.75));
}

/** Notes from [beat, pitch, length] triples. */
export const line = (triples: [number, number, number][], velocity = 0.75): Note[] => triples.map(([t, p, d]) => mk(p, t, d, velocity));
