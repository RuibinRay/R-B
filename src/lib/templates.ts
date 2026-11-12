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
  { id: 'hiphop', name: 'Hip-hop', bpm: 88, keyLabel: 'D minor', desc: 'A one-minute beat: swung boom-bap drums, an 808 bass line and a dark piano hook, with an intro and two verses.', parts: 'Drums, 808, electric piano, piano, bell, vinyl' },
  { id: 'techno', name: 'Techno', bpm: 130, keyLabel: 'A minor', desc: 'A full club arrangement: intro, groove, breakdown, an eight-bar build with a riser, then the drop.', parts: 'Kick, hats, clap, acid bass, sub, stabs, pad, arp, risers' },
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

// ---- arranged songs ---------------------------------------------------------
// The two beats below are whole arrangements rather than an eight-bar loop, so they
// are written section by section: every track gets one clip per section.

/** [beat within the section, pitch, velocity, length in beats] */
type Hit = [beat: number, pitch: number, velocity: number, duration?: number];
const BAR = 4;
const notesOf = (hits: Hit[]): Note[] => hits.map(([start, pitch, velocity, duration = 0.24]) => ({ id: uid(), pitch, start, duration, velocity }));
/** The same kind of bar written `count` times; `write` gets the bar number and returns that bar's hits. */
const perBar = (count: number, write: (bar: number) => Hit[]): Hit[] =>
  Array.from({ length: count }, (_, b) => write(b).map(([t, ...rest]) => [t + b * BAR, ...rest] as Hit)).flat();
const chordHits = (pitches: number[], beat: number, velocity: number, duration: number): Hit[] => pitches.map((pch) => [beat, pch, velocity, duration]);
const section = (p: Project, track: Track, name: string, startBar: number, bars: number, hits: Hit[]) => {
  p.clips.push({ id: uid(), type: 'midi', trackId: track.id, name, start: startBar * BAR, length: bars * BAR, notes: notesOf(hits) });
};
const point = (beat: number, value: number) => ({ id: uid(), beat, value });
const marker = (bar: number, name: string) => ({ id: uid(), beat: bar * BAR, name });

function hiphop(): Project {
  const p = base('Hip-hop beat', 88, 2, 'minor');
  const drums = newTrack('Drums', 'lofi-kit', { volume: -2 });
  const sub = newTrack('808', 'bass-808', { volume: -6 });
  const keys = newTrack('Electric piano', 'electric-piano', { volume: -10, fx: fx({ eq: { on: true, low: 1, mid: 0, high: -6 }, chorus: { on: true, rate: 0.7, depth: 0.5, mix: 0.3 }, ...verb(2, 0.2) }) });
  const hook = newTrack('Piano hook', 'grand-piano', { volume: -9, pan: -0.1, fx: fx({ eq: { on: true, low: -3, mid: 0, high: -3 }, delay: { on: true, time: 0.51, feedback: 0.28, mix: 0.2 }, ...verb(2.2, 0.22) }) });
  const bell = newTrack('Bell', 'fm-bell', { volume: -12, pan: 0.25, fx: fx({ delay: { on: true, time: 0.34, feedback: 0.35, mix: 0.3 }, ...verb(2.6, 0.3) }) });
  const vinyl = newTrack('Vinyl crackle', 'vinyl', { volume: -20 });
  p.tracks.push(drums, sub, keys, hook, bell, vinyl);
  p.markers.push(marker(0, 'Intro'), marker(4, 'Verse 1'), marker(12, 'Verse 2'), marker(20, 'Outro'));

  // i - VI - iv - V in D minor, one chord a bar
  const chords = [[50, 57, 60, 65], [46, 53, 57, 62], [43, 53, 58, 62], [45, 52, 55, 61]];
  const roots = [38, 34, 31, 33];
  const keysBar = (bar: number): Hit[] => [...chordHits(chords[bar % 4], 0, 0.6, 1.9), ...chordHits(chords[bar % 4], 2.5, 0.42, 1.3)];

  // the hook: eight bars, answered differently in the last one
  const phrase: Hit[][] = [
    [[0.5, 69, 0.7, 0.5], [1, 74, 0.8, 0.5], [1.5, 72, 0.7, 0.5], [2, 69, 0.75, 1], [3.5, 65, 0.6, 0.5]],
    [[0, 74, 0.8, 1], [1.5, 72, 0.65, 0.5], [2, 70, 0.75, 1], [3, 69, 0.65, 0.5], [3.5, 65, 0.6, 0.5]],
    [[0.5, 67, 0.7, 0.5], [1, 70, 0.75, 0.5], [1.5, 74, 0.8, 0.5], [2, 72, 0.75, 1], [3, 70, 0.65, 1]],
    [[0, 69, 0.75, 1], [1, 73, 0.7, 0.5], [1.5, 76, 0.85, 1.25], [3, 73, 0.65, 0.5], [3.5, 69, 0.6, 0.5]],
  ];
  const hookBars = (count: number, ending = false): Hit[] => perBar(count, (b) => (ending && b === count - 1 ? [[0, 76, 0.85, 1.5], [2, 73, 0.7, 1], [3, 69, 0.7, 1]] : phrase[b % 4]));

  // swung boom-bap: the off-beat hats sit late, the last bar of every four ends in a hat roll
  const beat = (open: boolean) => (bar: number): Hit[] => {
    const odd = bar % 2 === 1, turn = bar % 4 === 3;
    const h: Hit[] = [];
    (odd ? [0, 0.75, 2.5] : [0, 1.75, 2.5]).forEach((t, i) => h.push([t, 36, i === 0 ? 0.95 : 0.8]));
    if (turn) h.push([3.5, 36, 0.75]);
    h.push([1, 38, 0.9], [3, 38, 0.92]);
    if (odd) h.push([1.75, 38, 0.3]); // ghost note
    for (let t = 0; t < 4; t += 0.5) {
      if (turn && t >= 3) break;
      const off = t % 1 !== 0;
      h.push([off ? t + 0.08 : t, 42, off ? 0.4 : 0.6]);
    }
    if (turn) [3, 3.25, 3.5, 3.625, 3.75, 3.875].forEach((t, i) => h.push([t, 42, 0.35 + i * 0.09, 0.1]));
    else if (open && odd) h.push([3.58, 46, 0.5, 0.4]);
    return h;
  };
  const low = (bar: number): Hit[] => {
    const r = roots[bar % 4];
    if (bar % 2 === 0) return [[0, r, 0.95, 1.6], [2.5, r, 0.85, 1.3]];
    const h: Hit[] = [[0, r, 0.95, 0.7], [0.75, r, 0.85, 1.6], [2.5, r, 0.85, 0.95]];
    if (bar % 4 === 3) h.push([3.5, r + 7, 0.8, 0.45]);
    return h;
  };

  // Intro: keys and hook alone, hats creep in, a fill leads into the beat
  section(p, keys, 'Intro', 0, 4, perBar(4, keysBar));
  section(p, hook, 'Intro', 0, 4, hookBars(4).map(([t, pch, v, d]) => [t, pch, v * 0.85, d] as Hit));
  section(p, drums, 'Intro', 0, 4, [
    ...perBar(2, () => [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t) => [t % 1 ? t + 8 + 0.08 : t + 8, 42, t % 1 ? 0.3 : 0.45] as Hit)),
    [15, 38, 0.6], [15.5, 38, 0.7], [15.75, 38, 0.85], [15.25, 36, 0.7],
  ]);
  // Verse 1: the beat and the 808; the hook rests for four bars and comes back
  section(p, drums, 'Verse 1', 4, 8, [[0, 49, 0.55, 2], ...perBar(8, beat(false))]);
  section(p, sub, 'Verse 1', 4, 8, perBar(8, low));
  section(p, keys, 'Verse 1', 4, 8, perBar(8, keysBar));
  section(p, hook, 'Verse 1', 4, 8, hookBars(4).map(([t, pch, v, d]) => [t + 16, pch, v, d] as Hit));
  // Verse 2: open hats, the hook throughout and a bell answering it an octave up
  section(p, drums, 'Verse 2', 12, 8, [[0, 49, 0.55, 2], ...perBar(8, beat(true))]);
  section(p, sub, 'Verse 2', 12, 8, perBar(8, low));
  section(p, keys, 'Verse 2', 12, 8, perBar(8, keysBar));
  section(p, hook, 'Verse 2', 12, 8, hookBars(8, true));
  section(p, bell, 'Verse 2', 12, 8, perBar(8, (b) => (b % 2 === 1 ? [[2, chords[b % 4][3] + 24, 0.6, 0.5], [2.5, chords[b % 4][2] + 24, 0.5, 0.5], [3, chords[b % 4][1] + 24, 0.55, 1]] : [[3.5, chords[b % 4][3] + 24, 0.45, 0.5]])));
  // Outro: the last chord rings out
  section(p, keys, 'Outro', 20, 2, chordHits(chords[0], 0, 0.55, 7));
  section(p, hook, 'Outro', 20, 2, [[0, 74, 0.7, 1], [1, 69, 0.6, 1], [2, 62, 0.65, 5]]);
  section(p, sub, 'Outro', 20, 2, [[0, 38, 0.9, 3]]);
  section(p, drums, 'Outro', 20, 2, [[0, 36, 0.95], [0, 49, 0.5, 2]]);
  section(p, vinyl, 'Vinyl', 0, 22, [[0, 60, 0.7, 88]]);
  return p;
}

function techno(): Project {
  const p = base('Techno drop', 130, 9, 'minor');
  const group = { id: uid(), name: 'Drums', color: TRACK_COLORS[4], volume: 0, mute: false, solo: false };
  const fxGroup = { id: uid(), name: 'Risers and hits', color: TRACK_COLORS[6], volume: 0, mute: false, solo: false, collapsed: true };
  p.groups = [group, fxGroup];
  const kick = newTrack('Kick', 'house-kit', { volume: -3, groupId: group.id });
  const hats = newTrack('Hats', 'house-kit', { volume: -10, groupId: group.id });
  const clap = newTrack('Clap and snare', 'house-kit', { volume: -8, groupId: group.id, fx: fx(verb(1.2, 0.12)) });
  const perc = newTrack('Shaker and ride', 'house-kit', { volume: -14, pan: 0.2, groupId: group.id });
  const acid = newTrack('Acid bass', 'acid-bass', { volume: -7, fx: fx({ dist: { on: true, amount: 0.25 }, delay: { on: true, time: 0.346, feedback: 0.2, mix: 0.1 } }) });
  const sub = newTrack('Sub bass', 'sub-bass', { volume: -7 });
  const stab = newTrack('Stabs', 'supersaw', { volume: -11, fx: fx({ ...verb(1.8, 0.22), delay: { on: true, time: 0.346, feedback: 0.3, mix: 0.18 } }) });
  const lead = newTrack('Lead', 'saw-lead', { volume: -13, pan: -0.15, fx: fx({ delay: { on: true, time: 0.346, feedback: 0.4, mix: 0.3 }, ...verb(2, 0.25) }) });
  const pad = newTrack('Pad', 'warm-pad', { volume: -11, fx: fx(verb(3.2, 0.35)) });
  const arp = newTrack('Arp', 'pluck', { volume: -11, pan: 0.2, fx: fx({ delay: { on: true, time: 0.346, feedback: 0.4, mix: 0.3 }, ...verb(2, 0.2) }) });
  const riser = newTrack('Riser', 'riser', { volume: -9, groupId: fxGroup.id, fx: fx(verb(2, 0.2)) });
  const impact = newTrack('Impact', 'impact', { volume: -6, groupId: fxGroup.id, fx: fx(verb(3, 0.3)) });
  const fall = newTrack('Downlifter', 'downlifter', { volume: -12, groupId: fxGroup.id, fx: fx(verb(2.5, 0.3)) });
  p.tracks.push(kick, hats, clap, perc, acid, sub, stab, lead, pad, arp, riser, impact, fall);
  // bars:       0 intro | 8 groove | 16 breakdown | 24 build | 32 DROP | 48 outro | 52 end
  p.markers.push(marker(0, 'Intro'), marker(8, 'Groove'), marker(16, 'Breakdown'), marker(24, 'Build'), marker(32, 'Drop'), marker(48, 'Outro'));
  p.loop = { on: false, start: 24 * BAR, end: 40 * BAR };

  const four = (v = 0.95): Hit[] => [0, 1, 2, 3].map((t) => [t, 36, v] as Hit);
  const offHat = (open: boolean) => (): Hit[] => [0.5, 1.5, 2.5, 3.5].map((t) => [t, open ? 46 : 42, open ? 0.5 : 0.55, open ? 0.3 : 0.12] as Hit);
  const shaker = (): Hit[] => Array.from({ length: 16 }, (_, i) => [i * 0.25, 70, i % 4 === 2 ? 0.5 : 0.28, 0.1] as Hit);
  const backbeat = (): Hit[] => [[1, 39, 0.85], [3, 39, 0.85]];
  // the acid line: a pedal A in sixteenths with accented jumps; every fourth bar climbs
  const line16 = [33, 33, 45, 33, 33, 36, 33, 45, 33, 33, 43, 33, 33, 40, 45, 48];
  const acidBar = (bar: number): Hit[] => line16.map((pch, i) => {
    const note = bar % 4 === 3 && i >= 12 ? [45, 48, 52, 57][i - 12] : pch;
    return [i * 0.25, note, note > 40 ? 0.9 : 0.62, note > 40 ? 0.22 : 0.17] as Hit;
  });
  const rumble = (): Hit[] => [0.5, 1.5, 2.5, 3.5].map((t) => [t, 33, 0.85, 0.42] as Hit);
  // A minor for two bars, then F and G
  const harmony = [[57, 60, 64], [57, 60, 64], [53, 57, 60], [55, 59, 62]];
  const stabBar = (bar: number): Hit[] => [0, 0.75, 1.5, 2.5, 3.25].flatMap((t, i) => chordHits(harmony[bar % 4], t, i === 0 ? 0.9 : 0.75, 0.2));
  const padBar = (bar: number, cut = 4): Hit[] => chordHits([harmony[bar % 4][0] - 12, ...harmony[bar % 4]], 0, 0.6, Math.min(4, cut) - 0.05);
  const arpBar = (bar: number, until = 4): Hit[] => {
    const [a, b, c] = harmony[bar % 4].map((n) => n + 12);
    return [a, b, c, a + 12, c, b, a, b, c, a + 12, c, b, a + 12, c, b, a].map((pch, i) => [i * 0.25, pch, i % 4 === 0 ? 0.75 : 0.55, 0.2] as Hit).filter(([t]) => t < until);
  };
  const hookBar = (bar: number): Hit[] => [
    [[0, 69, 0.8, 0.5], [0.75, 72, 0.75, 0.5], [1.5, 76, 0.85, 1.25], [3, 74, 0.7, 0.5], [3.5, 72, 0.7, 0.5]],
    [[0, 69, 0.8, 1.5], [2, 67, 0.7, 0.5], [2.5, 69, 0.75, 1.25]],
    [[0, 72, 0.8, 0.5], [0.75, 77, 0.8, 0.5], [1.5, 81, 0.85, 1.25], [3, 79, 0.7, 0.5], [3.5, 77, 0.7, 0.5]],
    [[0, 79, 0.85, 1], [1, 74, 0.75, 0.5], [1.5, 71, 0.75, 1], [3, 74, 0.7, 0.5], [3.5, 76, 0.75, 0.5]],
  ][bar % 4] as Hit[];

  // Intro (bars 0-7): kick and rumble, hats from bar 4
  section(p, kick, 'Intro', 0, 8, perBar(8, () => four()));
  section(p, sub, 'Intro', 0, 8, perBar(8, rumble));
  section(p, hats, 'Intro', 4, 4, perBar(4, offHat(false)));
  section(p, perc, 'Intro', 4, 4, perBar(4, shaker));
  // Groove (8-15): clap, open hats and the acid line, held back
  section(p, kick, 'Groove', 8, 8, [[0, 49, 0.5, 2], ...perBar(8, () => four())]);
  section(p, sub, 'Groove', 8, 8, perBar(8, rumble));
  section(p, hats, 'Groove', 8, 8, perBar(8, offHat(true)));
  section(p, perc, 'Groove', 8, 8, perBar(8, shaker));
  section(p, clap, 'Groove', 8, 8, perBar(8, backbeat));
  section(p, acid, 'Groove', 8, 8, perBar(8, acidBar));
  // Breakdown (16-23): the drums fall away; pad and arp carry it
  section(p, fall, 'Into the breakdown', 16, 3, [[0, 60, 0.8, 10]]);
  section(p, pad, 'Breakdown', 16, 8, perBar(8, (b) => padBar(b)));
  section(p, arp, 'Breakdown', 16, 8, perBar(8, (b) => (b < 2 ? [] : arpBar(b))));
  section(p, clap, 'Breakdown', 20, 4, perBar(4, () => [[3, 39, 0.6]]));
  // Build (24-31): the snare roll doubles in speed, the acid line and arp rise, and
  // the last beat before the drop is left empty
  const roll: Hit[] = [
    ...perBar(2, () => [0, 1, 2, 3].map((t) => [t, 38, 0.5] as Hit)),
    ...perBar(2, (b) => Array.from({ length: 8 }, (_, i) => [8 + i * 0.5, 38, 0.52 + (b * 8 + i) * 0.01] as Hit)),
    ...perBar(2, (b) => Array.from({ length: 16 }, (_, i) => [16 + i * 0.25, 38, 0.6 + (b * 16 + i) * 0.007, 0.12] as Hit)),
    ...Array.from({ length: 16 }, (_, i) => [24 + i * 0.25, 38, 0.82 + i * 0.008, 0.12] as Hit),
    ...Array.from({ length: 24 }, (_, i) => [28 + i * 0.125, 38, 0.8 + i * 0.008, 0.08] as Hit),
    ...[24, 25, 26, 27, 28, 29, 30].map((t) => [t, 39, 0.8] as Hit),
  ];
  section(p, clap, 'Build', 24, 8, roll);
  section(p, kick, 'Build', 24, 4, perBar(4, () => four(0.9)));
  section(p, hats, 'Build', 24, 8, perBar(8, (b) => (b === 7 ? [] : offHat(false)())));
  section(p, pad, 'Build', 24, 8, perBar(8, (b) => padBar(b, b === 7 ? 3 : 4)));
  section(p, arp, 'Build', 24, 8, perBar(8, (b) => arpBar(b, b === 7 ? 3 : 4)));
  section(p, acid, 'Build', 24, 8, perBar(8, (b) => acidBar(b).filter(([t]) => b < 7 || t < 3)));
  section(p, riser, 'Riser', 29, 3, [[32 * BAR - 29 * BAR - 8.67, 60, 0.9, 8.67]]); // four seconds, ending on the drop
  // Drop (32-47)
  section(p, impact, 'Drop', 32, 2, [[0, 48, 1, 6]]);
  section(p, kick, 'Drop', 32, 16, [[0, 49, 0.7, 2], [32, 49, 0.6, 2], ...perBar(16, () => four(1))]);
  section(p, sub, 'Drop', 32, 16, perBar(16, rumble));
  section(p, hats, 'Drop', 32, 16, perBar(16, offHat(true)));
  section(p, clap, 'Drop', 32, 16, perBar(16, (b) => (b % 8 === 7 ? [...backbeat(), [3.5, 38, 0.7], [3.75, 38, 0.85]] : backbeat())));
  section(p, perc, 'Drop', 32, 16, perBar(16, (b) => (b < 8 ? shaker() : [...shaker(), ...[0, 1, 2, 3].map((t) => [t, 51, 0.5, 0.3] as Hit)])));
  section(p, acid, 'Drop', 32, 16, perBar(16, acidBar));
  section(p, stab, 'Drop', 32, 16, perBar(16, stabBar));
  section(p, arp, 'Drop', 40, 8, perBar(8, (b) => arpBar(b)));
  section(p, lead, 'Drop', 40, 8, perBar(8, hookBar));
  // Outro (48-51): back to kick, hats and rumble
  section(p, fall, 'Out of the drop', 48, 3, [[0, 60, 0.7, 10]]);
  section(p, kick, 'Outro', 48, 4, [...perBar(4, () => four()), [16, 36, 1]]);
  section(p, sub, 'Outro', 48, 4, perBar(4, rumble));
  section(p, hats, 'Outro', 48, 4, perBar(4, offHat(false)));
  section(p, perc, 'Outro', 48, 4, perBar(2, shaker));
  p.clips.find((c) => c.trackId === kick.id && c.name === 'Outro')!.length = 5 * BAR; // room for the final kick

  // The acid line is held back in the groove, creeps up through the build and is at full level for the drop.
  acid.automation = { volume: [point(8 * BAR, -9), point(16 * BAR, -9), point(24 * BAR, -22), point(31 * BAR, -3), point(32 * BAR, 0)] };
  arp.automation = { volume: [point(16 * BAR, -6), point(24 * BAR, -4), point(31 * BAR, 2), point(32 * BAR, 0)] };
  pad.automation = { volume: [point(24 * BAR, 0), point(31 * BAR + 3, 3)] };
  return p;
}

export function createFromTemplate(id: string): Project {
  const info = TEMPLATES.find((t) => t.id === id);
  if (!info) return createProject();
  if (id === 'hiphop') return hiphop();
  if (id === 'techno') return techno();
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
