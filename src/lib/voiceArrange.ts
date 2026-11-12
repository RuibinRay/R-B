import type { Note } from '../types';
import { bassPart, chordPart, drumPart, harmonyPart, suggestChords, type BassStyle, type ChordEvent, type ChordStyle, type DrumStyle } from './accompaniment';
import { articulate, familyOf, fitOctave, type PerfNote, type RenderMode } from './articulate';
import { getInstrument } from './instruments';
import type { Key } from './music';

// From detected notes to a playable arrangement: the melody on one or more instrument
// layers, plus optional accompaniment. Pure data in, pure data out, so the preview,
// the studio insert and the WAV/MIDI export all play exactly the same thing.

export interface VoiceNote { id: string; pitch: number; start: number; duration: number; velocity: number; bend?: number[]; dyn?: number[] } // seconds
export interface Layer { id: string; instrumentId: string; gain: number; octave: 'auto' | number; on: boolean }
export type Style = 'ballad' | 'pop' | 'rock' | 'electronic' | 'lofi';
export interface Accompaniment { chords: boolean; bass: boolean; drums: boolean; harmony: boolean; style: Style; intensity: number; level: number }

export type Role = 'lead' | 'chords' | 'bass' | 'drums' | 'harmony';
export interface ArrangedPart { id: string; role: Role; name: string; instrumentId: string; gain: number; notes: PerfNote[]; octaveShift: number }
export interface Arrangement { parts: ArrangedPart[]; chords: ChordEvent[]; lengthBeats: number }

export const STYLES: { id: Style; name: string; hint: string }[] = [
  { id: 'ballad', name: 'Ballad', hint: 'Held chords, long bass notes, a light beat' },
  { id: 'pop', name: 'Pop', hint: 'Steady chords, a bouncing bass and a backbeat' },
  { id: 'rock', name: 'Rock', hint: 'Driving eighth notes and a heavier kit' },
  { id: 'electronic', name: 'Electronic', hint: 'Four-on-the-floor with synth stabs' },
  { id: 'lofi', name: 'Lo-fi', hint: 'Electric piano arpeggios and dusty drums' },
];

/** What each style plays at low, middle and high intensity, and on which instruments. */
const RECIPES: Record<Style, { chords: [ChordStyle, ChordStyle, ChordStyle]; bass: [BassStyle, BassStyle, BassStyle]; drums: [DrumStyle, DrumStyle, DrumStyle]; keys: string; low: string; kit: string }> = {
  ballad: { chords: ['block', 'half', 'arp8'], bass: ['roots', 'roots', 'bounce'], drums: ['basic', 'basic', 'pop'], keys: 'grand-piano', low: 'electric-bass', kit: 'brush-kit' },
  pop: { chords: ['block', 'half', 'eighths'], bass: ['roots', 'bounce', 'pulse'], drums: ['basic', 'pop', 'pop'], keys: 'grand-piano', low: 'electric-bass', kit: 'studio-kit' },
  rock: { chords: ['half', 'eighths', 'eighths'], bass: ['roots', 'pulse', 'pulse'], drums: ['basic', 'rock', 'rock'], keys: 'grand-piano', low: 'electric-bass', kit: 'rock-kit' },
  electronic: { chords: ['block', 'stab', 'arp8'], bass: ['roots', 'offbeat', 'pulse'], drums: ['basic', 'electronic', 'electronic'], keys: 'supersaw', low: 'reese-bass', kit: 'electro-kit' },
  lofi: { chords: ['block', 'arp8', 'arp'], bass: ['roots', 'roots', 'bounce'], drums: ['lofi', 'lofi', 'lofi'], keys: 'electric-piano', low: 'electric-bass', kit: 'lofi-kit' },
};

const exists = (id: string, fallback: string) => (getInstrument(id) ? id : fallback);

export function arrange(input: { notes: VoiceNote[]; rhythm: boolean; bpm: number; key: Key; layers: Layer[]; mode: RenderMode; accompaniment: Accompaniment | null }): Arrangement {
  const { notes, rhythm, bpm, key, layers, mode, accompaniment } = input;
  const spb = 60 / bpm, bar = 4;
  const end = Math.max(0, ...notes.map((n) => n.start + n.duration));
  const lengthBeats = Math.max(bar, Math.ceil(end / spb / bar - 1e-6) * bar);
  const parts: ArrangedPart[] = [];

  const lead = (id: string, role: Role, name: string, instrumentId: string, gain: number, source: VoiceNote[], octave: 'auto' | number): ArrangedPart => {
    const def = getInstrument(instrumentId);
    const shift = rhythm || !def ? 0 : octave === 'auto' ? fitOctave(source, def.range, familyOf(def) === 'bass') : octave * 12;
    const shifted = source.map((n) => ({ ...n, pitch: n.pitch + shift }));
    // the level is applied to how hard the notes are played, so preview, studio and export all balance the same way
    const played = articulate(shifted, familyOf(def), mode).map((n) => ({ ...n, velocity: Math.max(0.05, Math.min(1, n.velocity * gain)) }));
    return { id, role, name, instrumentId, gain, notes: played, octaveShift: shift };
  };
  for (const l of layers) {
    if (!l.on) continue;
    const def = getInstrument(l.instrumentId);
    parts.push(lead(l.id, 'lead', rhythm ? `${def?.name ?? 'Drums'} beat` : `${def?.name ?? 'Melody'} melody`, l.instrumentId, l.gain, notes, l.octave));
  }

  let chords: ChordEvent[] = [];
  if (!rhythm && notes.length) {
    const inBeats = notes.map((n) => ({ ...n, start: n.start / spb, duration: n.duration / spb }));
    chords = suggestChords(inBeats, key, lengthBeats, bar);
    if (accompaniment) {
      const a = accompaniment, r = RECIPES[a.style];
      const tier = a.intensity < 0.34 ? 0 : a.intensity < 0.67 ? 1 : 2;
      const push = 0.7 + 0.45 * a.intensity; // busier also means played harder
      const toSec = (ns: Note[]): PerfNote[] => ns.map((n) => ({ id: n.id, pitch: n.pitch, start: n.start * spb, duration: n.duration * spb, velocity: Math.max(0.05, Math.min(1, n.velocity * push * a.level)) }));
      if (a.chords) parts.push({ id: 'chords', role: 'chords', name: 'Chords', instrumentId: exists(r.keys, 'grand-piano'), gain: a.level, notes: toSec(chordPart(chords, r.chords[tier], 3, 0.55)), octaveShift: 0 });
      if (a.bass) parts.push({ id: 'bass', role: 'bass', name: 'Bass', instrumentId: exists(r.low, 'electric-bass'), gain: a.level, notes: toSec(bassPart(chords, r.bass[tier])), octaveShift: 0 });
      if (a.drums) parts.push({ id: 'drums', role: 'drums', name: 'Drums', instrumentId: exists(r.kit, 'studio-kit'), gain: a.level, notes: toSec(drumPart(lengthBeats, bar, r.drums[tier])), octaveShift: 0 });
      if (a.harmony) {
        const first = layers.find((l) => l.on) ?? layers[0];
        if (first) {
          const third = harmonyPart(inBeats as Note[], key, -2).map((n, i) => ({ ...notes[i], id: n.id, pitch: n.pitch, velocity: n.velocity }));
          parts.push(lead('harmony', 'harmony', 'Harmony', first.instrumentId, first.gain * 0.8 * a.level, third, first.octave));
        }
      }
    }
  }
  return { parts, chords, lengthBeats };
}

/** Pull timing towards a grid. `strength` 0 leaves it as performed, 1 snaps fully. `grid` is in beats. */
export function quantize(start: number, duration: number, spb: number, grid: number, strength: number): { start: number; duration: number } {
  if (grid <= 0 || strength <= 0) return { start, duration };
  const snap = (v: number) => Math.round(v / spb / grid) * grid * spb;
  const s = Math.max(0, start + (snap(start) - start) * strength);
  const d = Math.max(grid * spb * 0.5, duration + (Math.max(grid * spb, snap(duration)) - duration) * strength);
  return { start: s, duration: d };
}
