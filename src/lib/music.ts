import type { Clip, Note, Project, ScaleName } from '../types';
import { MAX_SONG_SECONDS } from '../types';

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const uid = (): string =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const midiToName = (m: number): string => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
export const midiToFreq = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
export const freqToMidi = (f: number): number => 69 + 12 * Math.log2(f / 440);
export const isBlackKey = (m: number): boolean => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const dbToGain = (db: number): number => (db <= -60 ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g: number): number => (g <= 0.000001 ? -120 : 20 * Math.log10(g));

export const SCALES: Record<ScaleName, { name: string; steps: number[] }> = {
  major: { name: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { name: 'Minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  harmonicMinor: { name: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  dorian: { name: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  mixolydian: { name: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  lydian: { name: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  phrygian: { name: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
  majorPentatonic: { name: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
  minorPentatonic: { name: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
  blues: { name: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
  chromatic: { name: 'Chromatic', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
};

export interface Key { root: number; scale: ScaleName }

export const inScale = (pitch: number, key: Key): boolean =>
  SCALES[key.scale].steps.includes((((pitch - key.root) % 12) + 12) % 12);

/** Nearest pitch that belongs to the key (ties resolve downward). */
export function snapToScale(pitch: number, key: Key): number {
  for (let d = 0; d < 7; d++) {
    if (inScale(pitch - d, key)) return pitch - d;
    if (inScale(pitch + d, key)) return pitch + d;
  }
  return pitch;
}

/** Move a pitch by a number of scale degrees inside the key. */
export function shiftDegrees(pitch: number, degrees: number, key: Key): number {
  let p = snapToScale(pitch, key);
  const dir = Math.sign(degrees);
  for (let i = 0; i < Math.abs(degrees); i++) {
    do { p += dir; } while (!inScale(p, key));
  }
  return p;
}

export const CHORDS: Record<string, { name: string; steps: number[] }> = {
  maj: { name: 'Major', steps: [0, 4, 7] },
  min: { name: 'Minor', steps: [0, 3, 7] },
  dim: { name: 'Diminished', steps: [0, 3, 6] },
  aug: { name: 'Augmented', steps: [0, 4, 8] },
  sus2: { name: 'Sus2', steps: [0, 2, 7] },
  sus4: { name: 'Sus4', steps: [0, 5, 7] },
  '7': { name: 'Dominant 7', steps: [0, 4, 7, 10] },
  maj7: { name: 'Major 7', steps: [0, 4, 7, 11] },
  min7: { name: 'Minor 7', steps: [0, 3, 7, 10] },
  '6': { name: 'Major 6', steps: [0, 4, 7, 9] },
  add9: { name: 'Add 9', steps: [0, 4, 7, 14] },
  min9: { name: 'Minor 9', steps: [0, 3, 7, 10, 14] },
  pow: { name: 'Power (5th)', steps: [0, 7, 12] },
};

export const chordSuffix: Record<string, string> = {
  pow: '5', maj: '', min: 'm', dim: '°', aug: '+', sus2: 'sus2', sus4: 'sus4', '7': '7', maj7: 'maj7', min7: 'm7', '6': '6', add9: 'add9', min9: 'm9',
};

/** MIDI pitches of a chord. `rootPc` 0-11, octave is the octave of the root (C4 = 60 → octave 4). */
export function chordPitches(rootPc: number, quality: string, octave = 4, inversion = 0): number[] {
  const base = 12 * (octave + 1) + rootPc;
  const p = (CHORDS[quality] ?? CHORDS.maj).steps.map((s) => base + s);
  for (let i = 0; i < inversion; i++) p.push(p.shift()! + 12);
  return p;
}

export interface DiatonicChord { degree: number; rootPc: number; quality: 'maj' | 'min' | 'dim' | 'aug'; roman: string; label: string }

/** Triads built on each degree of a seven-note scale. */
export function diatonicChords(key: Key): DiatonicChord[] {
  const steps = SCALES[key.scale].steps;
  if (steps.length !== 7) return diatonicChords({ root: key.root, scale: key.scale === 'minorPentatonic' || key.scale === 'blues' ? 'minor' : 'major' });
  const romans = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
  return steps.map((s, i) => {
    const third = (steps[(i + 2) % 7] - s + 12) % 12;
    const fifth = (steps[(i + 4) % 7] - s + 12) % 12;
    const quality = third === 4 ? (fifth === 8 ? 'aug' : 'maj') : fifth === 6 ? 'dim' : 'min';
    const rootPc = (key.root + s) % 12;
    const roman = quality === 'maj' || quality === 'aug' ? romans[i] : romans[i].toLowerCase();
    return { degree: i, rootPc, quality, roman: roman + (quality === 'dim' ? '°' : quality === 'aug' ? '+' : ''), label: NOTE_NAMES[rootPc] + chordSuffix[quality] };
  });
}

const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Krumhansl-Schmuckler key estimate from note durations. */
export function detectKey(notes: { pitch: number; duration: number }[]): Key & { confidence: number } {
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[((n.pitch % 12) + 12) % 12] += Math.max(0.05, n.duration);
  const corr = (profile: number[], root: number) => {
    const mx = hist.reduce((a, b) => a + b, 0) / 12;
    const my = profile.reduce((a, b) => a + b, 0) / 12;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < 12; i++) {
      const x = hist[(i + root) % 12] - mx, y = profile[i] - my;
      num += x * y; dx += x * x; dy += y * y;
    }
    return dx && dy ? num / Math.sqrt(dx * dy) : 0;
  };
  let best: Key & { confidence: number } = { root: 0, scale: 'major', confidence: -1 };
  for (let r = 0; r < 12; r++) {
    const a = corr(KS_MAJOR, r), b = corr(KS_MINOR, r);
    if (a > best.confidence) best = { root: r, scale: 'major', confidence: a };
    if (b > best.confidence) best = { root: r, scale: 'minor', confidence: b };
  }
  return best;
}

// ---- time helpers -------------------------------------------------------

export const beatsToSec = (beats: number, bpm: number): number => (beats * 60) / bpm;
export const secToBeats = (sec: number, bpm: number): number => (sec * bpm) / 60;
/** Bar length in quarter-note beats. */
export const barBeats = (ts: [number, number]): number => (ts[0] * 4) / ts[1];
export const snapBeat = (beat: number, grid: number): number => (grid > 0 ? Math.round(beat / grid) * grid : beat);
export const floorBeat = (beat: number, grid: number): number => (grid > 0 ? Math.floor(beat / grid + 1e-9) * grid : beat);

export const clipLengthBeats = (clip: Clip, bpm: number): number =>
  clip.type === 'midi' ? clip.length : secToBeats(clip.length, bpm);
export const clipEnd = (clip: Clip, bpm: number): number => clip.start + clipLengthBeats(clip, bpm);

export const maxBeats = (bpm: number): number => secToBeats(MAX_SONG_SECONDS, bpm);

/** End of the last clip in beats (0 for an empty project), capped at the five-minute limit. */
export function projectEndBeats(p: Project): number {
  let end = 0;
  for (const c of p.clips) end = Math.max(end, clipEnd(c, p.bpm));
  return Math.min(end, maxBeats(p.bpm));
}

export function formatTime(sec: number, ms = true): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return ms ? `${m}:${r.toFixed(3).padStart(6, '0')}` : `${m}:${Math.floor(r).toString().padStart(2, '0')}`;
}

/** "bar.beat.sixteenth", 1-based. */
export function formatBars(beat: number, ts: [number, number]): string {
  const unit = 4 / ts[1];
  const perBar = ts[0];
  const units = Math.max(0, beat) / unit;
  const bar = Math.floor(units / perBar);
  const b = Math.floor(units - bar * perBar);
  const six = Math.floor(((units - Math.floor(units)) * unit) / 0.25);
  return `${bar + 1}.${b + 1}.${six + 1}`;
}

/** Value of an automation curve at a beat: flat before the first and after the last point, straight lines between. */
export function autoValueAt(points: { beat: number; value: number }[], beat: number): number {
  if (!points.length) return 0;
  if (beat <= points[0].beat) return points[0].value;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (beat <= b.beat) return b.beat === a.beat ? b.value : a.value + ((b.value - a.value) * (beat - a.beat)) / (b.beat - a.beat);
  }
  return points[points.length - 1].value;
}

export const AUTO_RANGE = { volume: [-60, 6], pan: [-1, 1] } as const;

export const sortNotes = (notes: Note[]): Note[] => [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);

export const SNAP_OPTIONS: { label: string; value: number; advanced?: boolean }[] = [
  { label: 'Off', value: 0 },
  { label: 'Bar', value: -1 },
  { label: '1/4', value: 1 },
  { label: '1/8', value: 0.5 },
  { label: '1/16', value: 0.25 },
  { label: '1/32', value: 0.125, advanced: true },
  { label: '1/8 triplet', value: 1 / 3, advanced: true },
  { label: '1/16 triplet', value: 1 / 6, advanced: true },
];

/** Resolve the "Bar" pseudo-snap (-1) into beats. */
export const snapValue = (snap: number, ts: [number, number]): number => (snap < 0 ? barBeats(ts) : snap);

export const TRACK_COLORS = ['#8f7cf7', '#4fc3e8', '#e879a6', '#45c4b0', '#f2b33d', '#5b8def', '#f0876a', '#7bc96f'];
