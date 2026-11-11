import type { FxState, MidiClip, Note, Project, ScaleName, Track } from '../types';
import { defaultFx, defaultMaster } from '../types';
import { bassPart, chordPart, drumPart, line, progression } from './accompaniment';
import { getInstrument } from './instruments';
import { TRACK_COLORS, uid } from './music';

// New-project starters. Every template is a real, editable arrangement built from
// the same notes and instruments the user works with.

export interface TemplateInfo { id: string; name: string; bpm: number; keyLabel: string; desc: string; parts: string }

export const TEMPLATES: TemplateInfo[] = [
  { id: 'pop', name: 'Pop', bpm: 104, keyLabel: 'C major', desc: 'Piano chords, bass and a steady beat with room for a vocal.', parts: 'Piano, bass, drums, strings, vocal track' },
  { id: 'rock', name: 'Rock', bpm: 124, keyLabel: 'E minor', desc: 'Power chords, driving bass and a lead guitar line.', parts: 'Rhythm and lead guitar, bass, drums, vocal track' },
  { id: 'electronic', name: 'Electronic', bpm: 126, keyLabel: 'A minor', desc: 'Four-on-the-floor drums, offbeat bass and an arpeggio.', parts: 'Supersaw, sub bass, drum machine, arp' },
  { id: 'lofi', name: 'Lo-fi', bpm: 78, keyLabel: 'C major', desc: 'Jazzy electric piano chords over a relaxed swung beat.', parts: 'Electric piano, bass, drums, vibraphone' },
  { id: 'orchestral', name: 'Orchestral', bpm: 84, keyLabel: 'D minor', desc: 'String chords, cello, harp and a French horn theme.', parts: 'Strings, cello, horn, harp, timpani' },
  { id: 'cinematic', name: 'Cinematic', bpm: 72, keyLabel: 'C minor', desc: 'Slow strings, choir, taiko and a sparse piano motif.', parts: 'Pad, strings, choir, taiko, piano' },
];

const fx = (o: Partial<FxState> = {}): FxState => ({ ...defaultFx(), ...o });
const verb = (decay: number, mix: number) => ({ reverb: { on: true, decay, mix } });

let colorIndex = 0;
export function newTrack(name: string, instrumentId: string | null, opts: Partial<Track> = {}): Track {
  return {
    id: uid(), name, kind: instrumentId ? 'instrument' : 'audio', instrumentId,
    color: TRACK_COLORS[colorIndex++ % TRACK_COLORS.length], volume: -8, pan: 0, mute: false, solo: false, fx: defaultFx(), ...opts,
  };
}

const clipOf = (track: Track, notes: Note[], length: number, start = 0): MidiClip =>
  ({ id: uid(), type: 'midi', trackId: track.id, name: track.name, start, length, notes });

function base(name: string, bpm: number, root: number, scale: ScaleName): Project {
  colorIndex = 0;
  const now = Date.now();
  return {
    id: uid(), name, createdAt: now, updatedAt: now, bpm, timeSig: [4, 4], key: { root, scale },
    tracks: [], clips: [], markers: [], loop: { on: false, start: 0, end: 16 }, master: defaultMaster(), assets: [],
  };
}

export function createProject(name = 'Untitled song'): Project {
  const p = base(name, 110, 0, 'major');
  const piano = newTrack('Grand piano', 'grand-piano');
  p.tracks.push(piano);
  p.clips.push(clipOf(piano, [], 16));
  return p;
}

const repeat = (triples: [number, number, number][], every: number, times: number): [number, number, number][] =>
  Array.from({ length: times }, (_, i) => triples.map(([t, pch, d]) => [t + i * every, pch, d] as [number, number, number])).flat();

export function createFromTemplate(id: string): Project {
  const info = TEMPLATES.find((t) => t.id === id);
  if (!info) return createProject();
  const L = 32; // eight bars of 4/4
  const add = (p: Project, track: Track, notes: Note[]) => { p.tracks.push(track); p.clips.push(clipOf(track, notes, L)); };
  const twice = (names: string[]) => progression([...names, ...names], 4);

  if (id === 'pop') {
    const p = base('Pop song', 104, 0, 'major');
    const ch = twice(['C', 'G', 'Am', 'F']);
    add(p, newTrack('Piano', 'grand-piano', { volume: -8 }), chordPart(ch, 'half', 4, 0.6));
    add(p, newTrack('Bass', 'electric-bass', { volume: -7 }), bassPart(ch, 'bounce'));
    add(p, newTrack('Drums', 'studio-kit', { volume: -6 }), drumPart(L, 4, 'pop'));
    add(p, newTrack('Strings', 'cinematic-strings', { volume: -15, fx: fx(verb(2.6, 0.3)) }), chordPart(ch, 'block', 4, 0.5));
    p.tracks.push(newTrack('Vocals', null, { volume: -4, fx: fx(verb(1.8, 0.18)) }));
    return p;
  }
  if (id === 'rock') {
    const p = base('Rock song', 124, 4, 'minor');
    const ch = twice(['E5', 'C5', 'G5', 'D5']);
    add(p, newTrack('Rhythm guitar', 'distortion-guitar', { volume: -13, pan: -0.25 }), chordPart(ch, 'eighths', 2, 0.7));
    add(p, newTrack('Bass', 'electric-bass', { volume: -8 }), bassPart(ch, 'pulse'));
    add(p, newTrack('Drums', 'studio-kit', { volume: -5 }), drumPart(L, 4, 'rock'));
    const lead: [number, number, number][] = [[0, 64, 1.5], [1.5, 67, 0.5], [2, 69, 1], [3, 71, 1], [4, 67, 2], [6, 64, 2], [8, 74, 1.5], [9.5, 71, 0.5], [10, 69, 1], [11, 67, 1], [12, 69, 3]];
    add(p, newTrack('Lead guitar', 'overdrive-guitar', { volume: -11, pan: 0.2, fx: fx({ delay: { on: true, time: 0.36, feedback: 0.25, mix: 0.2 } }) }), line(repeat(lead, 16, 2), 0.8));
    p.tracks.push(newTrack('Vocals', null, { volume: -4, fx: fx(verb(1.6, 0.15)) }));
    return p;
  }
  if (id === 'electronic') {
    const p = base('Electronic track', 126, 9, 'minor');
    const ch = twice(['Am', 'F', 'C', 'G']);
    add(p, newTrack('Supersaw', 'supersaw', { volume: -12, fx: fx(verb(2.2, 0.25)) }), chordPart(ch, 'stab', 4, 0.7));
    add(p, newTrack('Sub bass', 'sub-bass', { volume: -6 }), bassPart(ch, 'offbeat', 33));
    add(p, newTrack('Drum machine', 'electro-kit', { volume: -5 }), drumPart(L, 4, 'electronic'));
    add(p, newTrack('Arp', 'pluck', { volume: -12, pan: 0.15, fx: fx({ delay: { on: true, time: 0.357, feedback: 0.35, mix: 0.25 } }) }), chordPart(ch, 'arp', 5, 0.65));
    return p;
  }
  if (id === 'lofi') {
    const p = base('Lo-fi beat', 78, 0, 'major');
    const ch = twice(['Dm7', 'G7', 'Cmaj7', 'Am7']);
    add(p, newTrack('Electric piano', 'electric-piano', { volume: -8, fx: fx({ chorus: { on: true, rate: 0.8, depth: 0.5, mix: 0.35 }, ...verb(2, 0.22) }) }), chordPart(ch, 'block', 3, 0.55));
    add(p, newTrack('Bass', 'electric-bass', { volume: -8 }), bassPart(ch, 'bounce'));
    add(p, newTrack('Drums', 'studio-kit', { volume: -8, fx: fx({ eq: { on: true, low: 2, mid: 0, high: -7 } }) }), drumPart(L, 4, 'lofi'));
    const mel: [number, number, number][] = [[0.5, 69, 1], [1.5, 67, 0.5], [2, 64, 1.5], [4, 62, 1], [5, 64, 1], [6, 67, 2], [8.5, 76, 0.5], [9, 74, 0.5], [9.5, 72, 1.5], [12, 69, 2], [14, 72, 1], [15, 69, 1]];
    add(p, newTrack('Vibraphone', 'vibraphone', { volume: -11, pan: 0.2, fx: fx(verb(2.4, 0.3)) }), line(repeat(mel, 16, 2), 0.6));
    return p;
  }
  if (id === 'orchestral') {
    const p = base('Orchestral sketch', 84, 2, 'minor');
    const ch = twice(['Dm', 'Bb', 'F', 'C']);
    add(p, newTrack('Strings', 'cinematic-strings', { volume: -10, fx: fx(verb(3, 0.3)) }), chordPart(ch, 'block', 3, 0.6));
    add(p, newTrack('Cello', 'cello', { volume: -9, pan: 0.2, fx: fx(verb(3, 0.25)) }), bassPart(ch, 'roots', 36, 0.7));
    const horn: [number, number, number][] = [[0, 57, 2], [2, 62, 2], [4, 65, 3], [7, 62, 1], [8, 60, 2], [10, 65, 1], [11, 69, 1], [12, 67, 2], [14, 64, 2]];
    add(p, newTrack('French horn', 'french-horn', { volume: -9, pan: -0.2, fx: fx(verb(3, 0.3)) }), line(repeat(horn, 16, 2), 0.7));
    add(p, newTrack('Harp', 'harp', { volume: -12, pan: 0.3, fx: fx(verb(2.6, 0.25)) }), chordPart(ch, 'arp8', 4, 0.55));
    const timp: [number, number, number][] = [[0, 38, 1], [3.5, 38, 0.5], [4, 46, 1], [8, 41, 1], [11.5, 41, 0.5], [12, 48, 1]];
    add(p, newTrack('Timpani', 'timpani', { volume: -10, fx: fx(verb(3, 0.3)) }), line(repeat(timp, 16, 2), 0.75));
    return p;
  }
  // cinematic
  const p = base('Cinematic cue', 72, 0, 'minor');
  const ch = twice(['Cm', 'Ab', 'Eb', 'Bb']);
  add(p, newTrack('Drone pad', 'soundtrack', { volume: -17, fx: fx(verb(4, 0.35)) }), bassPart(ch, 'roots', 36, 0.6));
  add(p, newTrack('Slow strings', 'slow-strings', { volume: -10, fx: fx(verb(3.5, 0.35)) }), chordPart(ch, 'block', 3, 0.6));
  add(p, newTrack('Choir', 'choir', { volume: -15, fx: fx(verb(3.5, 0.4)) }), chordPart(ch.slice(4), 'block', 4, 0.5));
  const taiko: [number, number, number][] = [[0, 41, 0.5], [0.75, 41, 0.5], [1.5, 41, 0.5], [3, 38, 0.5], [3.5, 38, 0.5]];
  add(p, newTrack('Taiko', 'taiko', { volume: -8, fx: fx(verb(2.5, 0.25)) }), line(repeat(taiko, 4, 8), 0.85));
  const piano: [number, number, number][] = [[0, 67, 1], [1, 63, 1], [2, 60, 2], [4, 68, 1], [5, 63, 1], [6, 60, 2], [8, 70, 1], [9, 67, 1], [10, 63, 2], [12, 65, 2], [14, 62, 2]];
  add(p, newTrack('Piano', 'grand-piano', { volume: -9, fx: fx(verb(3, 0.35)) }), line(repeat(piano, 16, 2), 0.6));
  return p;
}

/** Display name for a track's sound. */
export const trackSound = (t: Track): string => (t.kind === 'audio' ? 'Audio' : getInstrument(t.instrumentId)?.name ?? 'No instrument');
