import type { ScaleName } from '../../types';

// What the beat maker knows before it has tried anything: how each style is usually
// built. Distilled from producer guides for FL Studio, Ableton and GarageBand-style
// workflows (tempo ranges, drum placement, swing, typical sounds, arrangement) and from
// mixing practice (which instruments live in which part of the spectrum). The sources
// are listed in the README. These are starting points: the trainer measures which
// choices actually score well and shifts its preferences accordingly.

export type Role = 'drums' | 'bass' | 'chords' | 'lead' | 'pad' | 'arp' | 'texture';
export const ROLES: Role[] = ['drums', 'bass', 'chords', 'lead', 'pad', 'arp', 'texture'];
export type Family = 'rap' | 'electronic' | 'chill' | 'game';
export type GenreId = 'trap' | 'boombap' | 'drill' | 'techno' | 'house' | 'synthwave' | 'lofi' | 'ambient' | 'chiptune' | 'adventure' | 'battle' | 'cozy';

/** One chord of a progression: semitones above the key's root, and its quality. */
export type ChordSpec = [semis: number, quality: string];

/**
 * A drum line as a 16-step bar (or 32 steps for two bars), one character per sixteenth:
 * X almost always, x often, o sometimes, - rarely, . never.
 */
export interface DrumTemplate { kick: string; snare: string; hat: string; open?: string; clap?: string }

export type Section = 'intro' | 'verse' | 'hook' | 'break' | 'build' | 'drop' | 'outro' | 'loop';
/** Which roles play in a section and how hard (0..1). */
export interface SectionPlan { name: Section; bars: number; energy: number; roles: Role[] }

export interface Genre {
  id: GenreId;
  name: string;
  family: Family;
  hint: string;
  bpm: [number, number];
  /** 0 = straight, 0.33 = full triplet swing on the off-sixteenths */
  swing: [number, number];
  halfTime?: boolean; // the backbeat falls on beat 3 (trap, drill)
  scales: ScaleName[];
  progressions: ChordSpec[][];
  drums: { kits: string[]; templates: DrumTemplate[]; rolls: number; ghosts: number } | null;
  /** Candidate instruments per role; the first is the conventional choice. */
  roles: Partial<Record<Role, string[]>>;
  bassStyles: BassStyle[];
  chordStyles: ChordStyle[];
  /** Share of bass notes that should start together with a kick (0..1). */
  bassKickLock: number;
  /** Melody: notes per bar, and how much of the time it plays (0..1). */
  melodyDensity: [number, number];
  /** How alike the bars should be: techno is hypnotic, game themes develop. */
  repetition: [number, number];
  /**
   * Wanted share of the energy in each band (see BANDS). Mixes put most of their energy
   * low and fall off towards the top; these shares are judgement calls per style (heavier
   * low end for rap and club music, more midrange for orchestral and chiptune), not
   * measurements of particular records.
   */
  spectrum: number[];
  /** Loudness of each role relative to the loudest, in dB. */
  levels: Partial<Record<Role, number>>;
  forms: SectionPlan[][];
  reverb: number; // how wet the style is, 0..1
}

export type BassStyle = 'follow-kick' | 'roots' | 'pulse8' | 'offbeat' | 'walking' | 'rumble' | 'arp' | 'glide';
export type ChordStyle = 'block' | 'half' | 'stab' | 'eighths' | 'arp' | 'arp8' | 'pulse' | 'swell';

/** Frequency bands used to judge balance and masking. */
export const BANDS = [
  { name: 'sub', lo: 20, hi: 60 },
  { name: 'bass', lo: 60, hi: 150 },
  { name: 'low-mid', lo: 150, hi: 400 },
  { name: 'mid', lo: 400, hi: 1000 },
  { name: 'upper-mid', lo: 1000, hi: 2500 },
  { name: 'presence', lo: 2500, hi: 6000 },
  { name: 'air', lo: 6000, hi: 16000 },
] as const;

const m = (...c: ChordSpec[]): ChordSpec[] => c;
const all: Role[] = ['drums', 'bass', 'chords', 'lead', 'pad', 'arp', 'texture'];
const S = (name: Section, bars: number, energy: number, roles: Role[]): SectionPlan => ({ name, bars, energy, roles });

export const GENRES: Record<GenreId, Genre> = {
  // ---- rap ---------------------------------------------------------------
  trap: {
    id: 'trap', name: 'Trap', family: 'rap', hint: 'Half-time 808s, rolling hi-hats, dark bells and keys',
    bpm: [130, 160], swing: [0, 0.08], halfTime: true, scales: ['minor', 'harmonicMinor', 'phrygian'],
    progressions: [m([0, 'min'], [8, 'maj'], [5, 'min'], [7, 'min']), m([0, 'min'], [8, 'maj']), m([0, 'min'], [3, 'maj'], [8, 'maj'], [7, 'maj']), m([0, 'min'], [1, 'maj'])],
    drums: {
      kits: ['trap-kit'], rolls: 0.6, ghosts: 0.1, templates: [
        { kick: 'X.....x...x.o...X..o..x.....o...', snare: '........X...............X.......', hat: 'X.x.X.x.X.x.X.x.X.x.X.x.X.xxX.x.', open: '..............o...............-.' },
        { kick: 'X......x..x.....X.....x.x.......', snare: '........X...............X.......', hat: 'XxXxXxXxXxXxXxXxXxXxXxXxXxXxXxXx', open: '......o.........' },
      ],
    },
    roles: {
      drums: ['trap-kit'], bass: ['bass-808', 'sub-bass'], chords: ['grand-piano', 'dark-pad', 'synth-strings', 'choir-pad'],
      lead: ['fm-bell', 'glass-bells', 'music-box', 'flute', 'celesta', 'pluck', 'vibrato-lead'], pad: ['dark-pad', 'choir', 'slow-strings'],
      arp: ['pluck', 'music-box', 'fm-bell'], texture: ['vinyl', 'riser'],
    },
    bassStyles: ['follow-kick', 'glide'], chordStyles: ['block', 'half', 'swell'], bassKickLock: 0.85,
    melodyDensity: [2, 6], repetition: [0.6, 0.9],
    spectrum: [0.26, 0.36, 0.12, 0.11, 0.09, 0.04, 0.02], levels: { drums: 0, bass: 0, lead: -7, chords: -10, pad: -14, arp: -12, texture: -20 },
    forms: [
      [S('intro', 4, 0.3, ['chords', 'lead', 'pad']), S('hook', 8, 1, all), S('verse', 8, 0.75, ['drums', 'bass', 'chords', 'pad']), S('hook', 8, 1, all), S('outro', 4, 0.3, ['chords', 'lead'])],
      [S('intro', 4, 0.35, ['lead', 'pad', 'texture']), S('verse', 8, 0.8, ['drums', 'bass', 'chords', 'lead']), S('hook', 8, 1, all), S('verse', 8, 0.8, ['drums', 'bass', 'chords', 'arp']), S('hook', 8, 1, all)],
    ],
    reverb: 0.3,
  },
  boombap: {
    id: 'boombap', name: 'Boom bap', family: 'rap', hint: 'Swung 90s drums, upright bass, dusty jazzy keys',
    bpm: [84, 98], swing: [0.12, 0.24], scales: ['minor', 'dorian'],
    progressions: [m([0, 'min7'], [5, 'min7']), m([2, 'min7'], [7, '7'], [0, 'maj7'], [9, 'min7']), m([0, 'min7'], [8, 'maj7'], [5, 'min7'], [7, 'min7']), m([0, 'min9'], [10, '7'])],
    drums: {
      kits: ['studio-kit', 'lofi-kit', 'rock-kit'], rolls: 0.05, ghosts: 0.4, templates: [
        { kick: 'X.....x...X.....X..x..x...X...-.', snare: '....X.......X.......X.......X..-', hat: 'X.x.X.x.X.x.X.x.X.x.X.x.X.x.X.x.', open: '..............-...............o.' },
        { kick: 'X......xX.......X......x..x.....', snare: '....X.......X.......X.......X...', hat: 'X.x.X.x.X.x.X.x.X.x.X.x.X.x.X.xx' },
      ],
    },
    roles: {
      drums: ['studio-kit', 'lofi-kit', 'rock-kit'], bass: ['upright-bass', 'electric-bass', 'picked-bass', 'fretless-bass'], chords: ['electric-piano', 'grand-piano', 'jazz-organ', 'vibraphone', 'tine-keys'],
      lead: ['muted-trumpet', 'flute', 'vibraphone', 'alto-sax', 'jazz-guitar'], pad: ['slow-strings', 'warm-pad'], arp: ['vibraphone', 'jazz-guitar'], texture: ['vinyl'],
    },
    bassStyles: ['follow-kick', 'roots', 'walking'], chordStyles: ['stab', 'block', 'half'], bassKickLock: 0.6,
    melodyDensity: [2, 5], repetition: [0.55, 0.85],
    spectrum: [0.08, 0.36, 0.22, 0.16, 0.11, 0.05, 0.02], levels: { drums: 0, bass: -3, chords: -8, lead: -8, pad: -15, arp: -12, texture: -18 },
    forms: [
      [S('intro', 4, 0.35, ['chords', 'texture']), S('verse', 8, 0.8, ['drums', 'bass', 'chords', 'texture']), S('hook', 8, 1, ['drums', 'bass', 'chords', 'lead', 'texture']), S('verse', 8, 0.8, ['drums', 'bass', 'chords', 'arp', 'texture']), S('hook', 8, 1, ['drums', 'bass', 'chords', 'lead', 'pad', 'texture']), S('outro', 4, 0.3, ['chords', 'texture'])],
    ],
    reverb: 0.2,
  },
  drill: {
    id: 'drill', name: 'Drill', family: 'rap', hint: 'Sliding 808s, offbeat snares, triplet hats, dark strings',
    bpm: [138, 146], swing: [0, 0.05], halfTime: true, scales: ['minor', 'harmonicMinor', 'phrygian'],
    progressions: [m([0, 'min'], [8, 'maj'], [7, 'maj']), m([0, 'min'], [1, 'maj'], [0, 'min'], [7, 'maj']), m([0, 'min'], [5, 'min'], [8, 'maj'], [7, 'maj'])],
    drums: {
      kits: ['trap-kit'], rolls: 0.45, ghosts: 0.2, templates: [
        { kick: 'X.........x.......X.....x.......', snare: '........X.......--....X.X.......', hat: 'X..x..X.x.X..x..X..x..X.x.X..x..', open: '' },
        { kick: 'X.....x...........X.......x.....', snare: '........X........-.....X........', hat: 'X.xX.xX.X.xX.xX.X.xX.xX.X.xX.x..' },
      ],
    },
    roles: {
      drums: ['trap-kit'], bass: ['bass-808', 'sub-bass'], chords: ['grand-piano', 'tremolo-strings', 'slow-strings', 'choir-pad'],
      lead: ['tremolo-strings', 'grand-piano', 'glass-bells', 'voice-oohs', 'flute'], pad: ['choir', 'dark-pad', 'cinematic-strings'], arp: ['pizzicato', 'grand-piano'], texture: ['riser', 'vinyl'],
    },
    bassStyles: ['glide', 'follow-kick'], chordStyles: ['swell', 'block', 'half'], bassKickLock: 0.75,
    melodyDensity: [2, 6], repetition: [0.6, 0.9],
    spectrum: [0.24, 0.34, 0.13, 0.12, 0.11, 0.04, 0.02], levels: { drums: 0, bass: 0, lead: -7, chords: -10, pad: -13, arp: -11, texture: -20 },
    forms: [
      [S('intro', 4, 0.3, ['chords', 'pad']), S('hook', 8, 1, all), S('verse', 8, 0.8, ['drums', 'bass', 'chords', 'arp']), S('hook', 8, 1, all), S('outro', 4, 0.3, ['chords', 'pad'])],
    ],
    reverb: 0.35,
  },
  // ---- electronic ----------------------------------------------------------
  techno: {
    id: 'techno', name: 'Techno', family: 'electronic', hint: 'Four-on-the-floor, rolling bass, hypnotic repetition, breakdown and drop',
    bpm: [125, 138], swing: [0, 0.06], scales: ['minor', 'phrygian', 'dorian'],
    progressions: [m([0, 'min']), m([0, 'min'], [10, 'maj']), m([0, 'min'], [8, 'maj'], [10, 'maj']), m([0, 'min7'], [5, 'min7'])],
    drums: {
      kits: ['house-kit', 'electro-kit'], rolls: 0.1, ghosts: 0.05, templates: [
        { kick: 'X...X...X...X...', snare: '....x.......x...', hat: 'xxXxxxXxxxXxxxXx', open: '..X...X...X...X.' },
        { kick: 'X...X...X...X..o', snare: '....X.......X...', hat: '..X...X...X...X.', open: '..o...o...o...o.' },
      ],
    },
    roles: {
      drums: ['house-kit', 'electro-kit'], bass: ['acid-bass', 'sub-bass', 'reese-bass', 'fm-bass'], chords: ['supersaw', 'analog-brass', 'pwm-pad', 'polysynth-pad'],
      lead: ['saw-lead', 'square-lead', 'fifths-lead', 'pluck'], pad: ['dark-pad', 'warm-pad', 'sweep-pad', 'metallic-pad'], arp: ['pluck', 'square-pluck', 'fm-bell'], texture: ['riser', 'impact', 'downlifter'],
    },
    bassStyles: ['rumble', 'offbeat', 'pulse8'], chordStyles: ['stab', 'pulse', 'swell'], bassKickLock: 0.1,
    melodyDensity: [1, 5], repetition: [0.75, 0.97],
    spectrum: [0.22, 0.38, 0.15, 0.1, 0.09, 0.04, 0.02], levels: { drums: 0, bass: -2, chords: -8, lead: -9, pad: -12, arp: -10, texture: -12 },
    forms: [
      [S('intro', 8, 0.4, ['drums', 'bass']), S('verse', 8, 0.7, ['drums', 'bass', 'arp']), S('break', 8, 0.35, ['pad', 'arp', 'texture']), S('build', 4, 0.6, ['drums', 'pad', 'arp', 'texture']), S('drop', 16, 1, ['drums', 'bass', 'chords', 'lead', 'arp', 'texture']), S('outro', 4, 0.4, ['drums', 'bass'])],
    ],
    reverb: 0.3,
  },
  house: {
    id: 'house', name: 'House', family: 'electronic', hint: 'Four-on-the-floor, offbeat bass, piano or organ chords',
    bpm: [120, 126], swing: [0.04, 0.14], scales: ['minor', 'dorian', 'major'],
    progressions: [m([0, 'min7'], [5, 'min7'], [10, 'maj'], [3, 'maj7']), m([0, 'min7'], [3, 'maj7'], [10, '7']), m([5, 'maj7'], [7, '7'], [4, 'min7'], [9, 'min7'])],
    drums: {
      kits: ['house-kit', 'electro-kit'], rolls: 0.05, ghosts: 0.15, templates: [
        { kick: 'X...X...X...X...', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.', open: '..X...X...X...X.' },
        { kick: 'X...X...X...X...', snare: '....X.......X..-', hat: 'xxxxxxxxxxxxxxxx', open: '..X...X...X...X.' },
      ],
    },
    roles: {
      drums: ['house-kit'], bass: ['fm-bass', 'synth-bass-1', 'rubber-bass', 'sub-bass'], chords: ['grand-piano', 'electric-piano', 'jazz-organ', 'dx-piano'],
      lead: ['pluck', 'vibrato-lead', 'voice-lead', 'fm-bell'], pad: ['warm-pad', 'string-machine'], arp: ['pluck', 'square-pluck'], texture: ['riser'],
    },
    bassStyles: ['offbeat', 'pulse8'], chordStyles: ['stab', 'pulse', 'eighths'], bassKickLock: 0.05,
    melodyDensity: [2, 6], repetition: [0.7, 0.95],
    spectrum: [0.18, 0.36, 0.18, 0.12, 0.1, 0.04, 0.02], levels: { drums: 0, bass: -3, chords: -7, lead: -9, pad: -13, arp: -11, texture: -14 },
    forms: [
      [S('intro', 8, 0.45, ['drums', 'bass']), S('verse', 8, 0.75, ['drums', 'bass', 'chords']), S('break', 4, 0.4, ['chords', 'pad']), S('drop', 16, 1, ['drums', 'bass', 'chords', 'lead', 'arp']), S('outro', 4, 0.45, ['drums', 'bass'])],
    ],
    reverb: 0.3,
  },
  synthwave: {
    id: 'synthwave', name: 'Synthwave', family: 'electronic', hint: 'Eighties drums, pulsing bass, big pads and a saw lead',
    bpm: [84, 118], swing: [0, 0.04], scales: ['minor', 'dorian'],
    progressions: [m([0, 'min'], [8, 'maj'], [3, 'maj'], [10, 'maj']), m([0, 'min'], [5, 'min'], [8, 'maj'], [7, 'maj']), m([0, 'min'], [10, 'maj'], [8, 'maj'], [10, 'maj'])],
    drums: {
      kits: ['electro-kit', 'studio-kit'], rolls: 0.05, ghosts: 0.05, templates: [
        { kick: 'X.......X.......', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.' },
        { kick: 'X.......X.x.....', snare: '....X.......X...', hat: 'xxxxxxxxxxxxxxxx' },
      ],
    },
    roles: {
      drums: ['electro-kit', 'studio-kit'], bass: ['synth-bass-1', 'bass-lead', 'fm-bass'], chords: ['polysynth-pad', 'string-machine', 'dx-piano', 'synth-brass'],
      lead: ['saw-lead', 'vibrato-lead', 'charang-lead', 'square-lead'], pad: ['warm-pad', 'string-machine', 'pwm-pad'], arp: ['pluck', 'square-pluck', 'dx-piano'], texture: ['riser'],
    },
    bassStyles: ['pulse8', 'roots'], chordStyles: ['block', 'half', 'swell'], bassKickLock: 0.4,
    melodyDensity: [2, 6], repetition: [0.55, 0.85],
    spectrum: [0.12, 0.32, 0.18, 0.15, 0.14, 0.06, 0.03], levels: { drums: 0, bass: -3, chords: -8, lead: -5, pad: -11, arp: -9, texture: -16 },
    forms: [
      [S('intro', 4, 0.4, ['pad', 'arp']), S('verse', 8, 0.75, ['drums', 'bass', 'chords', 'arp']), S('hook', 8, 1, ['drums', 'bass', 'chords', 'lead', 'arp', 'pad']), S('verse', 8, 0.75, ['drums', 'bass', 'chords', 'arp']), S('hook', 8, 1, all), S('outro', 4, 0.4, ['pad', 'arp'])],
    ],
    reverb: 0.4,
  },
  // ---- chill -----------------------------------------------------------------
  lofi: {
    id: 'lofi', name: 'Lo-fi', family: 'chill', hint: 'Lazy swung drums, jazzy seventh chords, vinyl crackle',
    bpm: [70, 88], swing: [0.16, 0.3], scales: ['major', 'dorian', 'minor'],
    progressions: [m([2, 'min7'], [7, '7'], [0, 'maj7'], [9, 'min7']), m([0, 'maj7'], [9, 'min7'], [2, 'min7'], [7, '7']), m([5, 'maj7'], [4, 'min7'], [2, 'min7'], [0, 'maj7']), m([0, 'min7'], [5, 'min7'])],
    drums: {
      kits: ['lofi-kit', 'brush-kit'], rolls: 0.02, ghosts: 0.35, templates: [
        { kick: 'X......x..x.....X......-..x.....', snare: '....X.......X.......X.......X...', hat: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.' },
        { kick: 'X.........x.....X.....x.........', snare: '....X.......X.......X.......X..-', hat: 'x.xxx.x.x.xxx.x.x.xxx.x.x.xxx.x.' },
      ],
    },
    roles: {
      drums: ['lofi-kit', 'brush-kit'], bass: ['electric-bass', 'upright-bass', 'fretless-bass'], chords: ['electric-piano', 'tine-keys', 'grand-piano', 'vibraphone'],
      lead: ['vibraphone', 'jazz-guitar', 'flute', 'kalimba', 'music-box'], pad: ['warm-pad', 'rain-pad'], arp: ['kalimba', 'jazz-guitar', 'harp'], texture: ['vinyl', 'rain-pad'],
    },
    bassStyles: ['roots', 'follow-kick', 'walking'], chordStyles: ['block', 'half', 'arp8'], bassKickLock: 0.55,
    melodyDensity: [1.5, 5], repetition: [0.55, 0.85],
    spectrum: [0.05, 0.3, 0.28, 0.2, 0.11, 0.04, 0.02], levels: { drums: -2, bass: -3, chords: 0, lead: -5, pad: -12, arp: -8, texture: -14 },
    forms: [
      [S('intro', 4, 0.35, ['chords', 'texture']), S('verse', 8, 0.75, ['drums', 'bass', 'chords', 'texture']), S('hook', 8, 0.9, ['drums', 'bass', 'chords', 'lead', 'texture']), S('verse', 8, 0.75, ['drums', 'bass', 'chords', 'arp', 'texture']), S('outro', 4, 0.35, ['chords', 'lead', 'texture'])],
    ],
    reverb: 0.35,
  },
  ambient: {
    id: 'ambient', name: 'Ambient chill', family: 'chill', hint: 'Slow pads, soft piano or kalimba, nature sounds, no hard beat',
    bpm: [60, 80], swing: [0, 0.1], scales: ['major', 'lydian', 'majorPentatonic', 'dorian'],
    progressions: [m([0, 'maj7'], [5, 'maj7']), m([0, 'add9'], [9, 'min7'], [5, 'maj7'], [7, 'sus4']), m([0, 'maj'], [7, 'maj'], [9, 'min'], [5, 'maj'])],
    drums: null,
    roles: {
      bass: ['sub-bass', 'fretless-bass'], chords: ['halo-pad', 'shimmer-pad', 'warm-pad', 'ensemble-pad'],
      lead: ['grand-piano', 'kalimba', 'celesta', 'handpan', 'glass-bells', 'pan-flute'], pad: ['atmosphere', 'bowed-glass', 'choir-pad', 'warm-texture'], arp: ['harp', 'kalimba', 'music-box'], texture: ['seashore', 'birds', 'wind', 'rain-pad'],
    },
    bassStyles: ['roots'], chordStyles: ['swell', 'block'], bassKickLock: 0,
    melodyDensity: [0.6, 3], repetition: [0.45, 0.8],
    spectrum: [0.04, 0.16, 0.28, 0.27, 0.17, 0.05, 0.03], levels: { bass: -8, chords: -3, lead: 0, pad: -6, arp: -6, texture: -10 },
    forms: [
      [S('intro', 4, 0.3, ['chords', 'texture']), S('verse', 8, 0.6, ['bass', 'chords', 'lead', 'texture']), S('hook', 8, 0.8, ['bass', 'chords', 'lead', 'pad', 'arp', 'texture']), S('outro', 4, 0.3, ['chords', 'pad', 'texture'])],
    ],
    reverb: 0.7,
  },
  // ---- game ------------------------------------------------------------------
  chiptune: {
    id: 'chiptune', name: 'Chiptune (game)', family: 'game', hint: 'Pulse-wave leads, fast arpeggios, 8-bit drums',
    bpm: [120, 160], swing: [0, 0.04], scales: ['major', 'minor', 'mixolydian'],
    progressions: [m([0, 'maj'], [5, 'maj'], [7, 'maj'], [0, 'maj']), m([0, 'min'], [8, 'maj'], [10, 'maj'], [0, 'min']), m([0, 'maj'], [9, 'min'], [5, 'maj'], [7, 'maj'])],
    drums: {
      kits: ['electro-kit'], rolls: 0.1, ghosts: 0.05, templates: [
        { kick: 'X.......X.x.....', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.' },
        { kick: 'X...X...X...X...', snare: '....X.......X..x', hat: 'xxxxxxxxxxxxxxxx' },
      ],
    },
    roles: {
      drums: ['electro-kit'], bass: ['square-pluck', 'bass-lead', 'chip-lead'], chords: ['chip-lead', 'square-pluck'],
      lead: ['chip-lead', 'square-lead', 'calliope-lead'], pad: ['square-lead'], arp: ['chip-lead', 'square-pluck'], texture: ['laser-zap'],
    },
    bassStyles: ['pulse8', 'arp', 'roots'], chordStyles: ['arp', 'stab'], bassKickLock: 0.4,
    melodyDensity: [4, 9], repetition: [0.45, 0.75],
    spectrum: [0.03, 0.17, 0.2, 0.25, 0.24, 0.08, 0.03], levels: { drums: -2, bass: -3, chords: -9, lead: 0, pad: -12, arp: -6, texture: -16 },
    forms: [
      [S('intro', 2, 0.5, ['drums', 'arp']), S('verse', 8, 0.8, ['drums', 'bass', 'lead', 'arp']), S('hook', 8, 1, ['drums', 'bass', 'lead', 'arp', 'chords']), S('verse', 8, 0.8, ['drums', 'bass', 'lead', 'arp'])],
    ],
    reverb: 0.1,
  },
  adventure: {
    id: 'adventure', name: 'Adventure (game)', family: 'game', hint: 'Orchestral exploration theme: strings, horn, harp, light percussion',
    bpm: [90, 120], swing: [0, 0.04], scales: ['major', 'mixolydian', 'dorian', 'lydian'],
    progressions: [m([0, 'maj'], [7, 'maj'], [9, 'min'], [5, 'maj']), m([0, 'maj'], [5, 'maj'], [10, 'maj'], [0, 'maj']), m([0, 'maj'], [2, 'min'], [5, 'maj'], [7, 'maj'])],
    drums: {
      kits: ['studio-kit'], rolls: 0.1, ghosts: 0.1, templates: [
        { kick: 'X.......X.......', snare: '........--......', hat: '' },
        { kick: 'X.....x.X.......', snare: '....-.......X...', hat: '' },
      ],
    },
    roles: {
      drums: ['studio-kit'], bass: ['double-bass', 'cello', 'pizzicato'], chords: ['cinematic-strings', 'slow-strings', 'ensemble-pad'],
      lead: ['french-horn', 'flute', 'oboe', 'trumpet', 'violin'], pad: ['choir', 'slow-strings'], arp: ['harp', 'pizzicato', 'celesta'], texture: ['timpani'],
    },
    bassStyles: ['roots', 'pulse8'], chordStyles: ['block', 'swell', 'half'], bassKickLock: 0.3,
    melodyDensity: [2, 6], repetition: [0.35, 0.7],
    spectrum: [0.04, 0.2, 0.22, 0.27, 0.19, 0.06, 0.02], levels: { drums: -6, bass: -5, chords: -4, lead: 0, pad: -9, arp: -6, texture: -6 },
    forms: [
      [S('intro', 4, 0.4, ['chords', 'arp']), S('verse', 8, 0.7, ['bass', 'chords', 'lead', 'arp']), S('hook', 8, 1, ['drums', 'bass', 'chords', 'lead', 'pad', 'arp', 'texture']), S('verse', 8, 0.7, ['bass', 'chords', 'lead', 'arp']), S('outro', 4, 0.4, ['chords', 'lead'])],
    ],
    reverb: 0.5,
  },
  battle: {
    id: 'battle', name: 'Battle (game)', family: 'game', hint: 'Fast and driving: string ostinato, brass, taiko and choir',
    bpm: [140, 172], swing: [0, 0.03], scales: ['harmonicMinor', 'minor', 'phrygian'],
    progressions: [m([0, 'min'], [8, 'maj'], [10, 'maj'], [7, 'maj']), m([0, 'min'], [5, 'min'], [7, 'maj'], [0, 'min']), m([0, 'min'], [1, 'maj'], [0, 'min'], [10, 'maj'])],
    drums: {
      kits: ['rock-kit', 'studio-kit'], rolls: 0.2, ghosts: 0.2, templates: [
        { kick: 'X.x.X.x.X.x.X.x.', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.' },
        { kick: 'X..xX..xX..xX.xx', snare: '....X.......X.xx', hat: 'xxxxxxxxxxxxxxxx' },
      ],
    },
    roles: {
      drums: ['rock-kit', 'studio-kit'], bass: ['double-bass', 'pizzicato', 'synth-bass-1', 'cello'], chords: ['tremolo-strings', 'brass-section', 'cinematic-strings'],
      lead: ['brass-section', 'french-horn', 'trumpet', 'violin', 'distortion-guitar'], pad: ['choir', 'synth-choir'], arp: ['tremolo-strings', 'pizzicato', 'harpsichord'], texture: ['taiko', 'orchestra-hit', 'impact'],
    },
    bassStyles: ['pulse8', 'roots'], chordStyles: ['eighths', 'stab', 'block'], bassKickLock: 0.5,
    melodyDensity: [3, 8], repetition: [0.45, 0.8],
    spectrum: [0.08, 0.26, 0.17, 0.21, 0.18, 0.07, 0.03], levels: { drums: 0, bass: -4, chords: -5, lead: -2, pad: -9, arp: -6, texture: -4 },
    forms: [
      [S('intro', 4, 0.6, ['drums', 'arp', 'texture']), S('verse', 8, 0.85, ['drums', 'bass', 'chords', 'arp', 'texture']), S('hook', 8, 1, all), S('verse', 8, 0.85, ['drums', 'bass', 'chords', 'lead']), S('hook', 8, 1, all)],
    ],
    reverb: 0.35,
  },
  cozy: {
    id: 'cozy', name: 'Cozy (game)', family: 'game', hint: 'Light village or menu music: pizzicato, marimba, flute, gentle beat',
    bpm: [96, 120], swing: [0.05, 0.18], scales: ['major', 'majorPentatonic', 'lydian'],
    progressions: [m([0, 'maj'], [5, 'maj'], [7, 'maj'], [0, 'maj']), m([0, 'maj7'], [9, 'min7'], [5, 'maj7'], [7, '7']), m([0, 'maj'], [4, 'min'], [5, 'maj'], [7, 'maj'])],
    drums: {
      kits: ['brush-kit', 'latin-kit'], rolls: 0, ghosts: 0.2, templates: [
        { kick: 'X.......X.......', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' },
        { kick: 'X.....x.X.......', snare: '....x.......x...', hat: 'x...x...x...x...' },
      ],
    },
    roles: {
      drums: ['brush-kit', 'latin-kit'], bass: ['pizzicato', 'upright-bass', 'tuba'], chords: ['marimba', 'acoustic-guitar', 'accordion', 'harp'],
      lead: ['flute', 'ocarina', 'clarinet', 'glockenspiel', 'xylophone', 'whistle'], pad: ['soft-synth-strings', 'warm-pad'], arp: ['marimba', 'harp', 'glockenspiel', 'kalimba'], texture: ['birds'],
    },
    bassStyles: ['roots', 'pulse8'], chordStyles: ['stab', 'arp8', 'half'], bassKickLock: 0.5,
    melodyDensity: [3, 7], repetition: [0.45, 0.8],
    spectrum: [0.03, 0.16, 0.18, 0.27, 0.25, 0.07, 0.04], levels: { drums: -5, bass: -4, chords: -4, lead: 0, pad: -10, arp: -5, texture: -14 },
    forms: [
      [S('intro', 2, 0.4, ['chords', 'arp']), S('verse', 8, 0.75, ['drums', 'bass', 'chords', 'lead']), S('hook', 8, 0.9, ['drums', 'bass', 'chords', 'lead', 'arp', 'pad']), S('verse', 8, 0.75, ['drums', 'bass', 'chords', 'lead', 'texture'])],
    ],
    reverb: 0.3,
  },
};

export const GENRE_LIST = Object.values(GENRES);
export const FAMILY_NAMES: Record<Family, string> = { rap: 'Rap', electronic: 'Electronic', chill: 'Chill', game: 'Game music' };

/** Every instrument any style may choose, so their sound can be measured ahead of time. */
export function candidateInstruments(): string[] {
  const set = new Set<string>();
  for (const g of GENRE_LIST) for (const list of Object.values(g.roles)) for (const id of list ?? []) set.add(id);
  return [...set].sort();
}

/** Probability that a template character puts a hit on that step. */
export const HIT_P: Record<string, number> = { X: 0.97, x: 0.65, o: 0.3, '-': 0.08, '.': 0 };
