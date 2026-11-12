import { beatbox, line, sing, type Drum, type SungNote } from './synth';

// The recordings the tests and the benchmark are run on. Each has a known answer.

export interface MelodyCase { name: string; audio: Float32Array; truth: { midi: number; start: number }[]; sr: number }

const C_SCALE: [number, number][] = [[60, 1], [62, 1], [64, 1], [65, 1], [67, 1], [69, 1], [71, 1], [72, 2], [71, 1], [69, 1], [67, 1], [65, 1], [64, 1], [62, 1], [60, 2]];
const TUNE: [number, number][] = [[64, 1], [64, 1], [65, 1], [67, 1], [67, 1], [65, 1], [64, 1], [62, 1], [60, 1], [60, 1], [62, 1], [64, 1], [64, 1.5], [62, 0.5], [62, 2]];

const truthOf = (notes: SungNote[]) => notes.map((n) => ({ midi: n.midi, start: n.start }));
const make = (name: string, notes: SungNote[], opts: Parameters<typeof sing>[1] = {}): MelodyCase => ({ name, audio: sing(notes, opts), truth: truthOf(notes), sr: 16000 });

export function melodyCases(): MelodyCase[] {
  const cases: MelodyCase[] = [];
  cases.push(make('Scale, clean', line(C_SCALE, 100)));
  cases.push(make('Tune with repeated notes', line(TUNE, 110)));
  cases.push(make('Repeated notes, clear gaps', line(Array.from({ length: 8 }, () => [62, 0.5] as [number, number]), 100)));
  // legato repeats: the level only dips to ~55% and a short consonant marks the new syllable
  cases.push(softRepeats());
  cases.push(make('Long note with wide vibrato', [{ midi: 67, start: 0.3, dur: 3.2, vibrato: { rate: 5.5, cents: 80, am: 0.2 } }]));
  cases.push(make('Vibrato on every note', line(TUNE, 90, { vibrato: { rate: 5.8, cents: 60, am: 0.15 } })));
  cases.push(make('Scoops into notes', line(C_SCALE, 100, { scoop: 150 })));
  cases.push(glides());
  cases.push(make('Fast sixteenth notes', line([60, 62, 64, 65, 67, 65, 64, 62, 60, 62, 64, 65, 67, 69, 71, 72].map((m) => [m, 0.25] as [number, number]), 110, { gap: 0.02, attack: 0.015, release: 0.02 })));
  cases.push(make('Background noise (about 12 dB)', line(TUNE, 110), { noise: 0.035 }));
  cases.push(make('Heavy noise (about 6 dB)', line(TUNE, 110), { noise: 0.07 }));
  cases.push(make('Low voice (E2 to E3)', line(C_SCALE.map(([m, b]) => [m - 20, b] as [number, number]), 100)));
  cases.push(make('Whistle (pure tone, C6 up)', line(C_SCALE.map(([m, b]) => [m + 24, b] as [number, number]), 100), { pure: true }));
  cases.push(make('Weak fundamental (octave trap)', line(C_SCALE.map(([m, b]) => [m - 8, b] as [number, number]), 100), { weakFundamental: true }));
  cases.push(make('Breathy voice', line(TUNE, 100), { breath: 0.3 }));
  cases.push({ ...make('Sung 30 cents flat', line(TUNE, 100).map((n) => ({ ...n, midi: n.midi - 0.3 }))), truth: line(TUNE, 100).map((n) => ({ midi: n.midi, start: n.start })) });
  cases.push(make('Quiet and loud notes', line(TUNE, 100).map((n, i) => ({ ...n, amp: i % 2 ? 0.08 : 0.4 }))));
  return cases;
}

function softRepeats(): MelodyCase {
  // one continuous sound re-articulated five times: built as overlapping notes at the same pitch
  const sr = 16000;
  const starts = [0.3, 0.8, 1.3, 1.8, 2.3, 2.8];
  const base = sing([{ midi: 64, start: 0.3, dur: 3.0, attack: 0.03, release: 0.06 }], { sr, breath: 0.02 });
  // dip the level to 55% for 60 ms before each re-articulation and add a consonant-like burst
  let seed = 11;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  for (const s of starts.slice(1)) {
    const c = Math.round(s * sr);
    for (let i = -Math.round(0.06 * sr); i < Math.round(0.03 * sr); i++) {
      const d = Math.abs(i + 0.015 * sr) / (0.045 * sr); // 0 at the centre of the dip
      base[c + i] *= 1 - 0.45 * Math.max(0, 1 - d);
    }
    for (let i = 0; i < Math.round(0.02 * sr); i++) base[c + i] += 0.05 * rnd() * (1 - i / (0.02 * sr));
  }
  return { name: 'Repeated notes, legato (soft dips)', audio: base, truth: starts.map((start) => ({ midi: 64, start })), sr };
}

function glides(): MelodyCase {
  const notes = line([[60, 1], [64, 1], [67, 1], [72, 2], [67, 1], [64, 1], [60, 2]], 90, { gap: 0 });
  for (let i = 1; i < notes.length; i++) notes[i].glideFrom = notes[i - 1].midi;
  // each note runs into the next: no silence between them
  return make('Slides between notes (no gaps)', notes.map((n) => ({ ...n, attack: 0.005, release: 0.005 })));
}

export interface DrumCase { name: string; samples: Float32Array; sr: number; truth: { t: number; type: Drum }[]; bpm: number }

export function drumCases(): DrumCase[] {
  const pattern = (bpm: number, bars: number): { t: number; type: Drum }[] => {
    const spb = 60 / bpm, out: { t: number; type: Drum }[] = [];
    const bar: Drum[] = ['kick', 'hat', 'snare', 'hat', 'kick', 'kick', 'snare', 'hat'];
    for (let b = 0; b < bars; b++) bar.forEach((type, i) => out.push({ t: 0.3 + (b * 8 + i) * spb * 0.5, type }));
    return out;
  };
  const withOpen = pattern(96, 3).map((h, i) => (i % 8 === 7 ? { ...h, type: 'open' as Drum } : h));
  const varied = pattern(120, 4).map((h, i) => ({ ...h, amp: [0.5, 0.25, 0.45, 0.2][i % 4] }));
  return [
    { name: 'Beatbox, full-range microphone', ...beatbox(pattern(100, 4)), truth: pattern(100, 4), bpm: 100 },
    { name: 'Beatbox, phone microphone (no bass)', ...beatbox(pattern(100, 4), { phone: true }), truth: pattern(100, 4), bpm: 100 },
    { name: 'Beatbox with open hi-hats', ...beatbox(withOpen), truth: withOpen, bpm: 96 },
    { name: 'Beatbox, quiet hats, some noise', ...beatbox(varied, { noise: 0.004 }), truth: varied, bpm: 120 },
  ];
}

export const DRUM_PITCH: Record<Drum, number> = { kick: 36, snare: 38, hat: 42, open: 46 };

/** Three sung notes at once: what a chord or an instrument recording looks like to the detector. */
export function chordAudio(): Float32Array {
  const a = sing(line([[48, 2], [53, 2], [55, 2], [48, 2]], 90, { gap: 0.1 }), { seed: 1 });
  const b = sing(line([[52, 2], [57, 2], [59, 2], [52, 2]], 90, { gap: 0.1 }), { seed: 2 });
  const c = sing(line([[55, 2], [60, 2], [62, 2], [55, 2]], 90, { gap: 0.1 }), { seed: 5 });
  return a.map((v, i) => (v + b[i] + c[i]) * 0.6);
}
