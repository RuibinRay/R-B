import { describe, expect, it } from 'vitest';
import { articulate, familyOf, fitOctave, type PerfNote } from '../src/lib/articulate';
import { getInstrument } from '../src/lib/instruments';
import { arrange, quantize, type Layer } from '../src/lib/voiceArrange';

const note = (pitch: number, start: number, duration: number, extra: Partial<PerfNote> = {}): PerfNote => ({ id: `${pitch}-${start}`, pitch, start, duration, velocity: 0.7, ...extra });
const vibrato = Array.from({ length: 16 }, (_, i) => Math.round(60 * Math.sin(i)));
const scoop = [-150, -90, -30, 0, 0, 0, 0, 0, 0];
// three joined notes, a breath, then two more; the first has vibrato, the fourth a scoop
const sung = (): PerfNote[] => [
  note(60, 0, 0.5, { bend: vibrato, dyn: [0.6, 1, 1.3, 0.9], velocity: 0.9 }),
  note(62, 0.5, 0.5, { velocity: 0.5 }),
  note(64, 1.02, 0.4),
  note(65, 2.0, 0.15, { bend: scoop }),
  note(65, 2.2, 0.15),
];

describe('instrument articulation', () => {
  it('knows which family each instrument belongs to', () => {
    expect(familyOf(getInstrument('violin'))).toBe('bowed');
    expect(familyOf(getInstrument('cello'))).toBe('bowed');
    expect(familyOf(getInstrument('grand-piano'))).toBe('keys');
    expect(familyOf(getInstrument('acoustic-guitar'))).toBe('pluck');
    expect(familyOf(getInstrument('flute'))).toBe('wind');
    expect(familyOf(getInstrument('studio-kit'))).toBe('drums');
  });

  it('never adds or drops notes, or changes their pitch or start', () => {
    for (const family of ['keys', 'pluck', 'bowed', 'wind', 'bass', 'synth'] as const) {
      for (const mode of ['clean', 'natural', 'expressive'] as const) {
        const out = articulate(sung(), family, mode);
        expect(out.map((n) => [n.pitch, n.start]), `${family} ${mode}`).toEqual(sung().map((n) => [n.pitch, n.start]));
      }
    }
  });

  it('piano: no pitch bends or swells in any mode; loudness becomes key velocity', () => {
    for (const mode of ['clean', 'natural', 'expressive'] as const) {
      const out = articulate(sung(), 'keys', mode);
      expect(out.every((n) => !n.bend && !n.dyn && !n.legato)).toBe(true);
    }
    const natural = articulate(sung(), 'keys', 'natural'), clean = articulate(sung(), 'keys', 'clean'), expressive = articulate(sung(), 'keys', 'expressive');
    const spread = (ns: PerfNote[]) => Math.max(...ns.map((n) => n.velocity)) - Math.min(...ns.map((n) => n.velocity));
    expect(spread(natural)).toBeCloseTo(0.4, 5);
    expect(spread(clean)).toBeLessThan(spread(natural) * 0.5);
    expect(spread(expressive)).toBeGreaterThan(spread(natural));
  });

  it('violin: joins touching notes under one bow, keeps separated and repeated notes apart', () => {
    const out = articulate(sung(), 'bowed', 'natural');
    expect(out.map((n) => !!n.legato)).toEqual([false, true, true, false, false]);
    // a slurred note overlaps the one before, so there is no gap in the sound
    expect(out[0].start + out[0].duration).toBeGreaterThan(out[1].start);
    // the repeated F is bowed again: its neighbour ends before it starts
    expect(out[3].start + out[3].duration).toBeLessThanOrEqual(out[4].start);
    // clean mode plays separate strokes
    expect(articulate(sung(), 'bowed', 'clean').some((n) => n.legato)).toBe(false);
  });

  it('violin: keeps vibrato and swells, in full when expressive and reduced when natural', () => {
    const natural = articulate(sung(), 'bowed', 'natural')[0], expressive = articulate(sung(), 'bowed', 'expressive')[0], clean = articulate(sung(), 'bowed', 'clean')[0];
    expect(expressive.bend).toEqual(vibrato);
    expect(Math.max(...natural.bend!)).toBeLessThan(Math.max(...vibrato));
    expect(Math.max(...natural.bend!)).toBeGreaterThan(0);
    expect(expressive.dyn).toEqual([0.6, 1, 1.3, 0.9]);
    expect(natural.dyn![2]).toBeCloseTo(1.15, 5);
    expect(clean.bend).toBeUndefined();
    expect(clean.dyn).toBeUndefined();
  });

  it('guitar: notes ring past a short syllable, a scoop becomes a slide, vibrato is dropped', () => {
    const out = articulate(sung(), 'pluck', 'natural');
    expect(out[3].duration).toBeGreaterThan(0.15); // rings on...
    expect(out[3].start + out[3].duration).toBeLessThanOrEqual(out[4].start); // ...but not through the same string being plucked again
    expect(out[4].duration).toBeCloseTo(0.3, 5);
    expect(out[0].bend).toBeUndefined(); // vibrato around the note: not a guitar gesture in natural mode
    expect(out[3].bend![0]).toBeLessThan(-60); // the slide up into the note is
    expect(out[3].bend!.slice(3).every((c) => c === 0)).toBe(true);
    expect(out.every((n) => !n.dyn && !n.legato)).toBe(true);
  });

  it('chooses the octave that fits the instrument', () => {
    const high = [72, 74, 76, 79].map((pitch) => ({ pitch }));
    expect(fitOctave(high, getInstrument('cello')!.range)).toBe(0); // already playable
    expect(fitOctave([84, 86, 88].map((pitch) => ({ pitch })), getInstrument('cello')!.range)).toBe(-12);
    expect(fitOctave([40, 43, 45].map((pitch) => ({ pitch })), getInstrument('flute')!.range)).toBe(24);
    // a bass takes the lowest octave that fits, even when the sung octave would also fit
    expect(fitOctave([60, 62, 64].map((pitch) => ({ pitch })), getInstrument('electric-bass')!.range, true)).toBe(-24);
  });
});

describe('arrangement', () => {
  const melody = [60, 62, 64, 65, 67, 65, 64, 62].map((pitch, i) => ({ id: `n${i}`, pitch, start: i * 0.5, duration: 0.45, velocity: 0.7 }));
  const layer = (instrumentId: string, extra: Partial<Layer> = {}): Layer => ({ id: instrumentId, instrumentId, gain: 1, octave: 'auto', on: true, ...extra });
  const key = { root: 0, scale: 'major' as const };

  it('plays the same melody on every active layer', () => {
    const out = arrange({ notes: melody, rhythm: false, bpm: 120, key, layers: [layer('violin'), layer('grand-piano'), layer('flute', { on: false })], mode: 'natural', accompaniment: null });
    expect(out.parts.map((p) => p.instrumentId)).toEqual(['violin', 'grand-piano']);
    for (const p of out.parts) expect(p.notes.map((n) => n.pitch % 12)).toEqual(melody.map((n) => n.pitch % 12));
    expect(out.lengthBeats).toBe(8);
  });

  it('moves a layer by whole octaves only, and only when the instrument needs it', () => {
    const high = melody.map((n) => ({ ...n, pitch: n.pitch + 12 })); // C5 and up: above the bass guitar
    const out = arrange({ notes: high, rhythm: false, bpm: 120, key, layers: [layer('electric-bass'), layer('violin'), layer('violin', { id: 'v2', octave: -1 })], mode: 'clean', accompaniment: null });
    expect(out.parts[0].octaveShift).toBe(-36);
    expect(out.parts[1].octaveShift).toBe(0);
    expect(out.parts[2].notes[0].pitch).toBe(60);
  });

  it('adds accompaniment in the chosen style, louder and busier at higher intensity', () => {
    const acc = { chords: true, bass: true, drums: true, harmony: true, style: 'pop' as const, level: 1 };
    const sparse = arrange({ notes: melody, rhythm: false, bpm: 120, key, layers: [layer('violin')], mode: 'natural', accompaniment: { ...acc, intensity: 0.1 } });
    const busy = arrange({ notes: melody, rhythm: false, bpm: 120, key, layers: [layer('violin')], mode: 'natural', accompaniment: { ...acc, intensity: 0.9 } });
    expect(sparse.parts.map((p) => p.role)).toEqual(['lead', 'chords', 'bass', 'drums', 'harmony']);
    const count = (a: typeof sparse, role: string) => a.parts.find((p) => p.role === role)!.notes.length;
    expect(count(busy, 'chords')).toBeGreaterThan(count(sparse, 'chords'));
    expect(count(busy, 'bass')).toBeGreaterThan(count(sparse, 'bass'));
    expect(busy.parts[1].notes[0].velocity).toBeGreaterThan(sparse.parts[1].notes[0].velocity);
    expect(busy.chords.length).toBe(2); // one chord per bar
    const lofi = arrange({ notes: melody, rhythm: false, bpm: 120, key, layers: [layer('violin')], mode: 'natural', accompaniment: { ...acc, style: 'lofi', intensity: 0.5 } });
    expect(lofi.parts.find((p) => p.role === 'drums')!.instrumentId).toBe('lofi-kit');
  });

  it('leaves a beat alone: no octave shifts, bends or accompaniment', () => {
    const hits = [36, 42, 38, 42].map((pitch, i) => ({ id: `h${i}`, pitch, start: i * 0.5, duration: 0.12, velocity: 0.8 }));
    const out = arrange({ notes: hits, rhythm: true, bpm: 120, key, layers: [layer('studio-kit')], mode: 'expressive', accompaniment: { chords: true, bass: true, drums: true, harmony: true, style: 'pop', intensity: 0.5, level: 1 } });
    expect(out.parts).toHaveLength(1);
    expect(out.parts[0].notes.map((n) => n.pitch)).toEqual([36, 42, 38, 42]);
  });

  it('pulls timing towards the grid by the chosen strength', () => {
    const spb = 0.5; // 120 BPM
    expect(quantize(0.56, 0.4, spb, 0.5, 1).start).toBeCloseTo(0.5, 6);
    expect(quantize(0.56, 0.4, spb, 0.5, 0.5).start).toBeCloseTo(0.53, 6);
    expect(quantize(0.56, 0.4, spb, 0.5, 0)).toEqual({ start: 0.56, duration: 0.4 });
    expect(quantize(0.56, 0.4, spb, 0, 1)).toEqual({ start: 0.56, duration: 0.4 });
  });
});
