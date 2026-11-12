import type { InstrumentDef } from './instruments';

// Turning a sung line into something an instrument would actually play.
//
// A voice slides, swells and wobbles on every note; a piano cannot bend a note at all, a
// guitar note dies away once plucked, and a violinist joins notes under one bow. These
// rules decide, per instrument family, how much of the singer's pitch movement, loudness
// and note joining is carried over. They only ever remove or reshape what was sung: no
// notes, ornaments or vibrato are invented.

export type RenderMode = 'clean' | 'natural' | 'expressive';
export type Family = 'keys' | 'pluck' | 'bowed' | 'wind' | 'brass' | 'mallet' | 'pad' | 'bass' | 'synth' | 'drums';

export interface PerfNote {
  id: string;
  pitch: number;
  start: number; // seconds
  duration: number;
  velocity: number;
  bend?: number[];
  dyn?: number[];
  legato?: boolean; // slurred from the previous note: no new attack
}

export function familyOf(def: InstrumentDef | undefined): Family {
  if (!def) return 'keys';
  if (def.engine === 'drums') return 'drums';
  if (def.engine === 'synth') return def.range[1] <= 67 ? 'bass' : 'synth';
  if (def.fallback) return def.fallback;
  return def.sustain ? 'pad' : 'pluck'; // modeled instruments: organs and pads hold, strings and bells decay
}

const SUSTAINED: Family[] = ['bowed', 'wind', 'brass', 'pad', 'synth'];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The whole-octave shift that puts the most notes inside an instrument's range (the smallest such shift). */
export function fitOctave(notes: { pitch: number }[], range: [number, number], preferLow = false): number {
  const inside = (shift: number) => notes.filter((n) => n.pitch + shift >= range[0] && n.pitch + shift <= range[1]).length;
  // a bass line belongs at the bottom of the instrument: take the lowest octave that still fits
  const order = preferLow ? [-36, -24, -12, 0, 12, 24, 36] : [0, -12, 12, -24, 24, -36, 36];
  let best = 0, bestIn = -1;
  for (const shift of order) { const n = inside(shift); if (n > bestIn) { bestIn = n; best = shift; } }
  return best;
}

export function articulate(input: PerfNote[], family: Family, mode: RenderMode): PerfNote[] {
  const notes = [...input].sort((a, b) => a.start - b.start).map((n) => ({ ...n, legato: undefined as boolean | undefined }));
  if (family === 'drums') return notes.map((n) => ({ ...n, bend: undefined, dyn: undefined }));
  const sustained = SUSTAINED.includes(family);
  const mean = notes.length ? notes.reduce((a, n) => a + n.velocity, 0) / notes.length : 0.7;

  for (let i = 0; i < notes.length; i++) {
    const n = notes[i], prev = notes[i - 1], next = notes[i + 1];

    // Loudness from note to note: evened out, as sung, or widened.
    const spread = mode === 'clean' ? 0.35 : mode === 'natural' ? 1 : 1.3;
    let v = mean + (n.velocity - mean) * spread;
    if (mode === 'expressive' && (!prev || n.start - (prev.start + prev.duration) > 0.35)) v += 0.05; // a phrase begins with a little weight
    n.velocity = clamp(v, 0.2, 1);

    // Pitch movement inside the note.
    if (!n.bend || mode === 'clean' || family === 'keys' || family === 'mallet') n.bend = undefined;
    else if (family === 'pluck' || family === 'bass') {
      // a fretted string can slide or be bent into a note, but does not carry a singer's vibrato
      const limit = mode === 'expressive' ? 150 : 100;
      const cut = Math.max(2, Math.ceil(n.bend.length / 3));
      const bend = n.bend.map((c, k) => (mode === 'expressive' || k < cut ? clamp(c * (mode === 'expressive' ? 1 : 0.7), -limit, limit) : 0));
      if (mode !== 'expressive') bend[cut - 1] = 0;
      n.bend = bend.some((c) => Math.abs(c) >= 40) ? bend : undefined;
    } else if (mode === 'natural') n.bend = n.bend.map((c) => Math.round(c * 0.7));

    // Swells and fades inside the note: only instruments that can shape a held note.
    if (!n.dyn || !sustained || mode === 'clean') n.dyn = undefined;
    else if (mode === 'natural') n.dyn = n.dyn.map((d) => Math.round((1 + (d - 1) * 0.5) * 100) / 100);

    // Length, and how the note meets the next one.
    const gap = next ? next.start - (n.start + n.duration) : Infinity;
    if (sustained) {
      if (next && mode !== 'clean' && gap < 0.07 && next.pitch !== n.pitch && Math.abs(next.pitch - n.pitch) <= 12) {
        // joined notes: one bow or one breath. The first note runs slightly into the second
        // and the second starts without a new attack.
        n.duration = next.start - n.start + 0.04;
        next.legato = true;
      } else if (next && gap < 0.03) n.duration = Math.max(0.06, next.start - n.start - 0.012); // separate strokes, almost touching
      n.duration = Math.max(n.duration, 0.09);
    } else if (family === 'keys') {
      if (mode === 'expressive' && next && gap < 0.05) n.duration = next.start - n.start; // fingers joined, never overlapping
      n.duration = Math.max(n.duration, 0.12);
    } else {
      // plucked and struck: the note rings on after a short sung syllable, until the next one takes over
      let ring = Math.max(n.duration, 0.3);
      if (next) ring = Math.min(ring, Math.max(0.08, next.start - n.start + (next.pitch === n.pitch ? -0.01 : 0.02)));
      n.duration = ring;
    }
  }
  // `legato` was written onto the following note while walking: keep it, and clear false leftovers
  return notes.map((n) => (n.legato ? n : { ...n, legato: undefined }));
}
