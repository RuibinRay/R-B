// Shared project data model. Timeline positions are in beats (quarter notes);
// audio clip lengths/offsets are in seconds because audio does not stretch with tempo.

export type ID = string;

export interface Note {
  id: ID;
  pitch: number; // MIDI note number
  start: number; // beats, relative to the clip start
  duration: number; // beats
  velocity: number; // 0..1
  bend?: number[]; // optional pitch contour in cents, evenly spaced over the note
}

interface ClipBase {
  id: ID;
  trackId: ID;
  name: string;
  start: number; // beats on the timeline
  muted?: boolean;
}

export interface MidiClip extends ClipBase {
  type: 'midi';
  length: number; // beats
  notes: Note[];
}

export interface AudioClip extends ClipBase {
  type: 'audio';
  assetId: ID;
  offset: number; // seconds into the asset
  length: number; // seconds
  gain: number; // dB
  fadeIn: number; // seconds
  fadeOut: number; // seconds
  /** Set while the clip plays a processed copy (pitch-corrected and/or time-stretched). */
  proc?: ClipProc;
  /** @deprecated replaced by `proc`; only read when opening older projects. */
  tuned?: { assetId: ID; offset: number };
}

export interface TuneSettings { key: { root: number; scale: ScaleName } | null; strength: number; speedMs: number; transpose: number }

/** How a clip's audio was made from its untouched original, so it can be redone or removed. */
export interface ClipProc {
  original: { assetId: ID; offset: number; length: number };
  tune?: TuneSettings;
  stretch?: number; // new length / original length
}

export type Clip = MidiClip | AudioClip;

export interface Eq3 { on: boolean; low: number; mid: number; high: number }
export interface Comp { on: boolean; threshold: number; ratio: number }

export interface FxState {
  eq: Eq3;
  gate: { on: boolean; threshold: number };
  comp: Comp;
  pitch: { on: boolean; semitones: number };
  dist: { on: boolean; amount: number };
  chorus: { on: boolean; rate: number; depth: number; mix: number };
  delay: { on: boolean; time: number; feedback: number; mix: number };
  reverb: { on: boolean; decay: number; mix: number };
}

export type FxName = keyof FxState;

/** One automation breakpoint. Volume values are dB relative to the fader; pan values are added to the pan knob. */
export interface AutoPoint { id: ID; beat: number; value: number }
export type AutoKind = 'volume' | 'pan';
export type TrackAutomation = Partial<Record<AutoKind, AutoPoint[]>>;

export interface Track {
  id: ID;
  name: string;
  kind: 'instrument' | 'audio';
  instrumentId: string | null;
  color: string;
  volume: number; // dB
  pan: number; // -1..1
  mute: boolean;
  solo: boolean;
  fx: FxState;
  automation?: TrackAutomation;
  groupId?: ID;
}

/** A named set of neighbouring tracks with a shared fader, mute and solo. */
export interface TrackGroup {
  id: ID;
  name: string;
  color: string;
  volume: number; // dB, added to every member
  mute: boolean;
  solo: boolean;
  collapsed?: boolean;
}

export interface MasterState {
  volume: number; // dB
  eq: Eq3;
  comp: Comp;
  limiter: { on: boolean; ceiling: number };
}

export interface AssetMeta {
  id: ID;
  name: string;
  duration: number;
  sampleRate: number;
  channels: number;
  kind?: 'audio' | 'video';
  width?: number;
  height?: number;
  /** Made by processing a clip (tuning, stretching); dropped once no clip uses it. */
  derived?: boolean;
}

// ---- video mode (times in seconds: picture does not follow the tempo) ----

export interface VideoClip {
  id: ID;
  assetId: ID;
  start: number; // on the song timeline
  offset: number; // into the source video
  length: number;
  fadeIn: number;
  fadeOut: number;
}

export interface TextOverlay {
  id: ID;
  text: string;
  start: number;
  length: number;
  x: number; // centre, 0..1 of the frame width
  y: number; // centre, 0..1 of the frame height
  size: number; // text height as a fraction of the frame height
  color: string;
}

export type VideoAspect = '16:9' | '9:16' | '1:1';

export interface VideoState {
  clips: VideoClip[];
  texts: TextOverlay[];
  aspect: VideoAspect;
}

export interface Marker { id: ID; beat: number; name: string }

export type ScaleName =
  | 'major' | 'minor' | 'harmonicMinor' | 'dorian' | 'mixolydian' | 'lydian' | 'phrygian'
  | 'majorPentatonic' | 'minorPentatonic' | 'blues' | 'chromatic';

export interface Project {
  id: ID;
  name: string;
  createdAt: number;
  updatedAt: number;
  bpm: number;
  timeSig: [number, number];
  key: { root: number; scale: ScaleName };
  tracks: Track[];
  clips: Clip[];
  markers: Marker[];
  loop: { on: boolean; start: number; end: number };
  master: MasterState;
  assets: AssetMeta[];
  video?: VideoState;
  groups?: TrackGroup[];
  autoCrossfade?: boolean; // overlapping audio clips crossfade (on unless set to false)
}

export const MAX_SONG_SECONDS = 300; // five-minute song limit

export const defaultFx = (): FxState => ({
  eq: { on: false, low: 0, mid: 0, high: 0 },
  gate: { on: false, threshold: -45 },
  comp: { on: false, threshold: -20, ratio: 4 },
  pitch: { on: false, semitones: 0 },
  dist: { on: false, amount: 0.3 },
  chorus: { on: false, rate: 1.5, depth: 0.6, mix: 0.4 },
  delay: { on: false, time: 0.3, feedback: 0.3, mix: 0.25 },
  reverb: { on: false, decay: 2.2, mix: 0.25 },
});

export const defaultMaster = (): MasterState => ({
  volume: 0,
  eq: { on: false, low: 0, mid: 0, high: 0 },
  comp: { on: false, threshold: -16, ratio: 2.5 },
  limiter: { on: true, ceiling: -1 },
});
