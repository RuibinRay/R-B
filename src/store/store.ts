import { create } from 'zustand';
import { produce } from 'immer';
import type { AssetMeta, AudioClip, AutoKind, AutoPoint, Clip, FxName, FxState, ID, MasterState, MidiClip, Note, Project, TextOverlay, Track, TrackGroup, VideoAspect, VideoClip, VideoState } from '../types';
import { MAX_SONG_SECONDS, defaultFx } from '../types';
import { engine, type InstrumentStatus } from '../audio/engine';
import { mic } from '../audio/recorder';
import * as db from '../lib/db';
import { getInstrument, isDrums } from '../lib/instruments';
import { midiToTracks } from '../lib/midi';
import { TRACK_COLORS, barBeats, beatsToSec, clamp, clipEnd, clipLengthBeats, floorBeat, maxBeats, secToBeats, snapBeat, snapValue, uid } from '../lib/music';
import { importProjectFile } from '../lib/projectFile';
import { createFromTemplate, createProject } from '../lib/templates';
import { encodeWav, toPcm } from '../lib/wav';
import { probeVideo, registerVideo } from '../video/video';

export type Page = 'home' | 'composer' | 'voice' | 'stems' | 'studio' | 'video' | 'projects' | 'library';
export const PAGES: Page[] = ['home', 'composer', 'voice', 'stems', 'studio', 'video', 'projects', 'library'];
export type BottomPanel = 'editor' | 'mixer' | 'fx' | 'master';
export interface Toast { id: string; kind: 'info' | 'error' | 'success'; text: string }

export interface UI {
  page: Page;
  mode: 'beginner' | 'advanced';
  selectedTrackId: ID | null;
  selectedClipIds: ID[];
  editClipId: ID | null;
  tool: 'select' | 'split';
  snap: number; // beats; 0 = off, -1 = one bar
  pxPerBeat: number;
  metronome: boolean;
  countIn: boolean;
  midiRecord: boolean;
  bottomPanel: BottomPanel;
  panelOpen: boolean;
  browserOpen: boolean;
  exportOpen: boolean;
  latencyMs: number;
  monitor: boolean;
  inputGain: number;
  typing: boolean; // play the selected instrument with the computer keyboard
  autoLanes: Record<ID, AutoKind>; // tracks whose automation lane is open, and which curve it shows
  videoSel: ID | null; // selected video clip or text overlay
}

export interface RecordingState { trackId: ID; startBeat: number; ctxStart: number }

export interface State {
  project: Project;
  past: Project[];
  future: Project[];
  ready: boolean;
  saveState: 'saved' | 'saving' | 'error';
  playing: boolean;
  recording: RecordingState | null;
  ui: UI;
  toasts: Toast[];
  clipboard: Clip[];
  instrumentStatus: Record<string, InstrumentStatus>;
}

const PREFS_KEY = 'rnb.prefs';
const LAST_KEY = 'rnb.lastProject';

function loadPrefs(): Partial<UI> {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<UI>; } catch { return {}; }
}

const pageFromHash = (): Page => {
  const h = window.location.hash.replace(/^#\/?/, '') as Page;
  return PAGES.includes(h) ? h : 'home';
};

const prefs = loadPrefs();

export const useStore = create<State>(() => ({
  project: createProject(),
  past: [],
  future: [],
  ready: false,
  saveState: 'saved',
  playing: false,
  recording: null,
  ui: {
    page: pageFromHash(),
    mode: prefs.mode ?? 'beginner',
    selectedTrackId: null,
    selectedClipIds: [],
    editClipId: null,
    tool: 'select',
    snap: prefs.snap ?? 0.25,
    pxPerBeat: 28,
    metronome: false,
    countIn: prefs.countIn ?? true,
    midiRecord: false,
    bottomPanel: 'editor',
    panelOpen: true,
    browserOpen: window.innerWidth >= 860,
    exportOpen: false,
    latencyMs: prefs.latencyMs ?? 0,
    monitor: false,
    inputGain: prefs.inputGain ?? 0,
    typing: true,
    autoLanes: {},
    videoSel: null,
  },
  toasts: [],
  clipboard: [],
  instrumentStatus: {},
}));

const get = useStore.getState;
const set = useStore.setState;

// ---- history -------------------------------------------------------------

function commit(fn: (p: Project) => void): void {
  const { project, past } = get();
  const next = produce(project, fn);
  if (next === project) return;
  set({ project: next, past: [...past.slice(-79), project], future: [] });
}

function live(fn: (p: Project) => void): void {
  const { project } = get();
  const next = produce(project, fn);
  if (next !== project) set({ project: next });
}

let gestureBase: Project | null = null;

/** Start a continuous edit (drag, slider): changes apply live and become one undo step. */
export function beginGesture(): void { gestureBase ??= get().project; }

export function endGesture(): void {
  const base = gestureBase;
  gestureBase = null;
  if (base && base !== get().project) set((s) => ({ past: [...s.past.slice(-79), base], future: [] }));
}

const apply = (fn: (p: Project) => void, isLive?: boolean): void => (isLive ? live(fn) : commit(fn));

// ---- helpers -------------------------------------------------------------

export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = uid();
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
  window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 7000 : 3500);
}

export const setUI = (patch: Partial<UI>): void => {
  set((s) => ({ ui: { ...s.ui, ...patch } }));
  const { mode, snap, countIn, latencyMs, inputGain } = get().ui;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ mode, snap, countIn, latencyMs, inputGain })); } catch { /* private mode */ }
};

export function navigate(page: Page): void {
  if (window.location.hash !== `#/${page}`) window.location.hash = `#/${page}`;
  setUI({ page });
}

const findClip = (p: Project, id: ID | null): Clip | undefined => (id ? p.clips.find((c) => c.id === id) : undefined);
export const selectedTrack = (s: State): Track | undefined => s.project.tracks.find((t) => t.id === s.ui.selectedTrackId);
export const gridBeats = (s: State): number => snapValue(s.ui.snap, s.project.timeSig);

function nextColor(p: Project): string {
  return TRACK_COLORS[p.tracks.length % TRACK_COLORS.length];
}

/** Runs of tracks that move together: each ungrouped track alone, each group as one block. */
function blocks(p: Project): Track[][] {
  const out: Track[][] = [];
  for (const t of p.tracks) {
    const last = out[out.length - 1];
    if (t.groupId && last && last[0].groupId === t.groupId) last.push(t);
    else out.push([t]);
  }
  return out;
}

function moveBlock(p: Project, is: (b: Track[]) => boolean, delta: number): void {
  const bs = blocks(p);
  const i = bs.findIndex(is), j = i + Math.sign(delta);
  if (i < 0 || j < 0 || j >= bs.length) return;
  [bs[i], bs[j]] = [bs[j], bs[i]];
  p.tracks = bs.flat();
}

/** Keep groups tidy: drop empty ones and keep every group's tracks next to each other. */
function normalizeGroups(p: Project): void {
  const used = new Set(p.tracks.map((t) => t.groupId).filter(Boolean));
  const groups = (p.groups ?? []).filter((g) => used.has(g.id));
  p.groups = groups.length ? groups : undefined;
  for (const t of p.tracks) if (t.groupId && !groups.some((g) => g.id === t.groupId)) t.groupId = undefined;
  const out: Track[] = [];
  const done = new Set<ID>();
  for (const t of p.tracks) {
    if (done.has(t.id)) continue;
    if (!t.groupId) { out.push(t); continue; }
    for (const m of p.tracks) if (m.groupId === t.groupId) { out.push(m); done.add(m.id); }
  }
  p.tracks = out;
}

/** Bring projects saved by earlier versions up to date, and drop processed audio nothing uses any more. */
function migrate(project: Project): Project {
  const stale: ID[] = [];
  const next = produce(project, (p) => {
    const used = new Set<ID>();
    for (const c of p.clips) {
      if (c.type !== 'audio') continue;
      if (c.tuned) {
        c.proc = { original: { assetId: c.tuned.assetId, offset: c.tuned.offset, length: c.length }, tune: { key: null, strength: 1, speedMs: 40, transpose: 0 } };
        delete c.tuned;
      }
      used.add(c.assetId);
      if (c.proc) used.add(c.proc.original.assetId);
    }
    for (const v of p.video?.clips ?? []) used.add(v.assetId);
    // every re-tune or re-stretch renders new audio; the versions left behind are only needed for undo
    for (const a of p.assets) if (a.derived && !used.has(a.id)) stale.push(a.id);
    if (stale.length) p.assets = p.assets.filter((a) => !stale.includes(a.id));
  });
  if (stale.length) void db.dropUnusedAssets(stale, project.id).catch(() => { /* tidying up can wait */ });
  return next;
}

function registerAsset(p: Project, meta: AssetMeta): void {
  if (!p.assets.some((a) => a.id === meta.id)) p.assets.push(meta);
}

/** Decode an audio file, keep its original bytes in local storage, and return its metadata. */
export async function importAudio(file: Blob, name: string): Promise<AssetMeta> {
  let buffer: AudioBuffer;
  try {
    buffer = await engine.decode(await file.arrayBuffer());
  } catch {
    throw new Error(`"${name}" could not be decoded. Try WAV, MP3, FLAC, OGG or M4A.`);
  }
  const meta: AssetMeta = { id: uid(), name: name.replace(/\.[^.]+$/, ''), duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels };
  engine.buffers.set(meta.id, buffer);
  await db.putAsset({ id: meta.id, name: meta.name, blob: file });
  return meta;
}

/** Keep a video file in local storage and make it playable. Its sound is only decoded if it gets used. */
export async function importVideo(file: Blob, name: string): Promise<AssetMeta> {
  const info = await probeVideo(file);
  const meta: AssetMeta = { id: uid(), name: name.replace(/\.[^.]+$/, ''), duration: info.duration, sampleRate: 0, channels: 0, kind: 'video', width: info.width, height: info.height };
  await db.putAsset({ id: meta.id, name: meta.name, blob: file });
  registerVideo(meta.id, file);
  return meta;
}

const emptyVideo = (): VideoState => ({ clips: [], texts: [], aspect: '16:9' });
export const videoEnd = (v: VideoState | undefined): number =>
  v ? Math.max(0, ...v.clips.map((c) => c.start + c.length), ...v.texts.map((t) => t.start + t.length)) : 0;

/** Store generated audio (a recording, a merge) as a 24-bit WAV asset. */
export async function addBufferAsset(buffer: AudioBuffer, name: string): Promise<AssetMeta> {
  const meta: AssetMeta = { id: uid(), name, duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels };
  engine.buffers.set(meta.id, buffer);
  await db.putAsset({ id: meta.id, name, blob: encodeWav(toPcm(buffer), 24) });
  return meta;
}

// ---- actions -------------------------------------------------------------

const heldNotes = new Map<number, { beat: number; velocity: number; trackId: ID }>();

export const A = {
  undo(): void {
    const { past, project, future } = get();
    if (!past.length) return;
    set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future].slice(0, 80) });
  },
  redo(): void {
    const { past, project, future } = get();
    if (!future.length) return;
    set({ project: future[0], future: future.slice(1), past: [...past, project] });
  },

  // project
  rename: (name: string) => commit((p) => { p.name = name.trim() || 'Untitled song'; }),
  setBpm: (bpm: number, isLive?: boolean) => apply((p) => { p.bpm = clamp(Math.round(bpm * 100) / 100, 40, 240); }, isLive),
  setTimeSig: (num: number, den: number) => commit((p) => { p.timeSig = [clamp(num, 1, 12), den]; }),
  setKey: (root: number, scale: Project['key']['scale']) => commit((p) => { p.key = { root, scale }; }),
  setLoop: (patch: Partial<Project['loop']>, isLive?: boolean) => apply((p) => { Object.assign(p.loop, patch); }, isLive),
  setMaster: (patch: Partial<MasterState>, isLive?: boolean) => apply((p) => { Object.assign(p.master, patch); }, isLive),
  addMarker(beat: number, name?: string): void {
    commit((p) => {
      p.markers.push({ id: uid(), beat, name: name ?? `Marker ${p.markers.length + 1}` });
      p.markers.sort((a, b) => a.beat - b.beat);
    });
  },
  renameMarker: (id: ID, name: string) => commit((p) => { const m = p.markers.find((x) => x.id === id); if (m) m.name = name; }),
  removeMarker: (id: ID) => commit((p) => { p.markers = p.markers.filter((m) => m.id !== id); }),

  // tracks
  addTrack(kind: 'instrument' | 'audio', instrumentId: string | null = null, name?: string): ID {
    const id = uid();
    commit((p) => {
      const def = getInstrument(instrumentId);
      p.tracks.push({
        id, kind, instrumentId: kind === 'instrument' ? instrumentId ?? 'grand-piano' : null,
        name: name ?? (kind === 'audio' ? `Audio ${p.tracks.filter((t) => t.kind === 'audio').length + 1}` : def?.name ?? 'Grand piano'),
        color: nextColor(p), volume: kind === 'audio' ? -4 : -8, pan: 0, mute: false, solo: false, fx: defaultFx(),
      });
    });
    setUI({ selectedTrackId: id });
    return id;
  },
  removeTrack(id: ID): void {
    commit((p) => {
      p.tracks = p.tracks.filter((t) => t.id !== id);
      p.clips = p.clips.filter((c) => c.trackId !== id);
      normalizeGroups(p);
    });
    const s = get();
    if (s.ui.selectedTrackId === id) setUI({ selectedTrackId: s.project.tracks[0]?.id ?? null, editClipId: null, selectedClipIds: [] });
  },
  duplicateTrack(id: ID): void {
    const newId = uid();
    commit((p) => {
      const i = p.tracks.findIndex((t) => t.id === id);
      if (i < 0) return;
      p.tracks.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(p.tracks[i])), id: newId, name: `${p.tracks[i].name} copy` });
      for (const c of p.clips.filter((x) => x.trackId === id)) {
        const copy = JSON.parse(JSON.stringify(c)) as Clip;
        copy.id = uid(); copy.trackId = newId;
        if (copy.type === 'midi') copy.notes.forEach((n) => { n.id = uid(); });
        p.clips.push(copy);
      }
    });
    setUI({ selectedTrackId: newId });
  },
  moveTrack: (id: ID, delta: number) => commit((p) => {
    const t = p.tracks.find((x) => x.id === id);
    if (!t) return;
    if (!t.groupId) { moveBlock(p, (b) => b[0].id === id, delta); return; }
    // inside a group, a track only changes places with its group neighbours
    const members = p.tracks.filter((x) => x.groupId === t.groupId);
    const i = members.findIndex((x) => x.id === id), j = i + Math.sign(delta);
    if (j < 0 || j >= members.length) return;
    const a = p.tracks.findIndex((x) => x.id === members[i].id), b = p.tracks.findIndex((x) => x.id === members[j].id);
    [p.tracks[a], p.tracks[b]] = [p.tracks[b], p.tracks[a]];
  }),

  // track groups
  createGroup(trackId: ID): ID {
    const id = uid();
    commit((p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      if (!t) return;
      p.groups ??= [];
      p.groups.push({ id, name: `Group ${p.groups.length + 1}`, color: t.color, volume: 0, mute: false, solo: false });
      t.groupId = id;
      normalizeGroups(p);
    });
    return id;
  },
  setTrackGroup(trackId: ID, groupId: ID | null): void {
    commit((p) => {
      const i = p.tracks.findIndex((x) => x.id === trackId);
      if (i < 0) return;
      const [t] = p.tracks.splice(i, 1);
      t.groupId = groupId ?? undefined;
      // a track joining a group goes to the end of it; one leaving stays just below it
      let at = i;
      if (groupId) { at = 0; p.tracks.forEach((x, k) => { if (x.groupId === groupId) at = k + 1; }); }
      else { while (at < p.tracks.length && p.tracks[at].groupId && p.tracks[at - 1]?.groupId === p.tracks[at].groupId) at++; }
      p.tracks.splice(at, 0, t);
      normalizeGroups(p);
    });
  },
  updateGroup: (id: ID, patch: Partial<TrackGroup>, isLive?: boolean) =>
    apply((p) => { const g = p.groups?.find((x) => x.id === id); if (g) Object.assign(g, patch); }, isLive),
  ungroup: (id: ID) => commit((p) => {
    for (const t of p.tracks) if (t.groupId === id) t.groupId = undefined;
    normalizeGroups(p);
  }),
  moveGroup: (id: ID, delta: number) => commit((p) => moveBlock(p, (b) => b[0].groupId === id, delta)),
  setAutoCrossfade: (on: boolean) => commit((p) => { p.autoCrossfade = on; }),
  updateTrack: (id: ID, patch: Partial<Track>, isLive?: boolean) => apply((p) => { const t = p.tracks.find((x) => x.id === id); if (t) Object.assign(t, patch); }, isLive),
  setFx<K extends FxName>(id: ID, name: K, patch: Partial<FxState[K]>, isLive?: boolean): void {
    apply((p) => { const t = p.tracks.find((x) => x.id === id); if (t) Object.assign(t.fx[name], patch); }, isLive);
  },
  /** Replace one automation curve of a track (points are kept sorted by beat). An empty list removes it. */
  setAutomation(trackId: ID, kind: AutoKind, points: AutoPoint[], isLive?: boolean): void {
    apply((p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      if (!t) return;
      const next = { ...(t.automation ?? {}) };
      if (points.length) next[kind] = [...points].sort((a, b) => a.beat - b.beat);
      else delete next[kind];
      t.automation = Object.keys(next).length ? next : undefined;
    }, isLive);
  },
  toggleAutoLane(trackId: ID, kind?: AutoKind): void {
    const lanes = { ...get().ui.autoLanes };
    if (kind) lanes[trackId] = kind;
    else if (lanes[trackId]) delete lanes[trackId];
    else lanes[trackId] = 'volume';
    setUI({ autoLanes: lanes });
  },
  /** Point a clip at different audio (used by pitch correction) in one undo step. */
  retargetClip(clipId: ID, asset: AssetMeta, patch: Partial<AudioClip>): void {
    commit((p) => {
      registerAsset(p, asset);
      const c = p.clips.find((x) => x.id === clipId);
      if (c && c.type === 'audio') Object.assign(c, patch, { assetId: asset.id });
    });
  },
  // video mode
  addVideoClip(asset: AssetMeta, start: number): ID {
    const id = uid();
    commit((p) => {
      registerAsset(p, asset);
      p.video ??= emptyVideo();
      const room = Math.max(0.1, MAX_SONG_SECONDS - start);
      p.video.clips.push({ id, assetId: asset.id, start: Math.max(0, start), offset: 0, length: Math.min(asset.duration, room), fadeIn: 0, fadeOut: 0 });
    });
    setUI({ videoSel: id });
    return id;
  },
  updateVideoClip: (id: ID, patch: Partial<VideoClip>, isLive?: boolean) =>
    apply((p) => { const c = p.video?.clips.find((x) => x.id === id); if (c) Object.assign(c, patch); }, isLive),
  splitVideoClip(id: ID, at: number): void {
    commit((p) => {
      const c = p.video?.clips.find((x) => x.id === id);
      if (!c || at <= c.start + 0.05 || at >= c.start + c.length - 0.05) return;
      const cut = at - c.start;
      p.video!.clips.push({ ...c, id: uid(), start: at, offset: c.offset + cut, length: c.length - cut, fadeIn: 0 });
      c.length = cut;
      c.fadeOut = 0;
    });
  },
  addText(start: number): ID {
    const id = uid();
    commit((p) => {
      p.video ??= emptyVideo();
      p.video.texts.push({ id, text: 'Your title', start: Math.max(0, start), length: 3, x: 0.5, y: 0.82, size: 0.08, color: '#ffffff' });
    });
    setUI({ videoSel: id });
    return id;
  },
  updateText: (id: ID, patch: Partial<TextOverlay>, isLive?: boolean) =>
    apply((p) => { const t = p.video?.texts.find((x) => x.id === id); if (t) Object.assign(t, patch); }, isLive),
  removeVideoItem(id: ID): void {
    commit((p) => {
      if (!p.video) return;
      p.video.clips = p.video.clips.filter((c) => c.id !== id);
      p.video.texts = p.video.texts.filter((t) => t.id !== id);
    });
    if (get().ui.videoSel === id) setUI({ videoSel: null });
  },
  setVideoAspect: (aspect: VideoAspect) => commit((p) => { p.video ??= emptyVideo(); p.video.aspect = aspect; }),
  /** Put a video clip's own soundtrack on an audio track, lined up with the picture. */
  async useVideoSound(clipId: ID): Promise<void> {
    const p = get().project;
    const clip = p.video?.clips.find((c) => c.id === clipId);
    const meta = p.assets.find((a) => a.id === clip?.assetId);
    if (!clip || !meta) return;
    try {
      if (!engine.buffers.has(meta.id)) {
        const stored = await db.getAsset(meta.id);
        if (!stored) throw new Error('The video file is missing from local storage.');
        engine.buffers.set(meta.id, await engine.decode(await stored.blob.arrayBuffer()));
      }
    } catch (e) {
      toast(e instanceof Error && e.message.includes('missing') ? e.message : 'This video has no sound the browser can read.', 'error');
      return;
    }
    const trackId = A.addTrack('audio', null, `${meta.name} sound`.slice(0, 30));
    A.addAudioClip(trackId, meta, secToBeats(clip.start, p.bpm), { offset: clip.offset, length: clip.length });
    toast('The video’s sound is now an audio track in the studio.', 'success');
  },
  setInstrument(trackId: ID, instrumentId: string): void {
    const def = getInstrument(instrumentId);
    if (!def) return;
    commit((p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      if (!t || t.kind !== 'instrument') return;
      const wasDefaultName = !t.instrumentId || t.name === getInstrument(t.instrumentId)?.name;
      t.instrumentId = instrumentId;
      if (wasDefaultName) t.name = def.name;
    });
  },

  // clips
  addMidiClip(trackId: ID, start: number, length?: number, notes: Note[] = [], name?: string): ID {
    const id = uid();
    commit((p) => {
      const t = p.tracks.find((x) => x.id === trackId);
      if (!t) return;
      p.clips.push({ id, type: 'midi', trackId, name: name ?? t.name, start: Math.max(0, start), length: length ?? barBeats(p.timeSig) * 4, notes });
    });
    return id;
  },
  addAudioClip(trackId: ID, asset: AssetMeta, start: number, patch: Partial<AudioClip> = {}): ID {
    const id = uid();
    commit((p) => {
      registerAsset(p, asset);
      const room = MAX_SONG_SECONDS - beatsToSec(Math.max(0, start), p.bpm);
      p.clips.push({
        id, type: 'audio', trackId, name: asset.name, start: Math.max(0, start), assetId: asset.id,
        offset: 0, length: Math.max(0.05, Math.min(asset.duration, room)), gain: 0, fadeIn: 0, fadeOut: 0, ...patch,
      });
    });
    return id;
  },
  updateClip: (id: ID, patch: Partial<MidiClip> | Partial<AudioClip>, isLive?: boolean) =>
    apply((p) => { const c = p.clips.find((x) => x.id === id); if (c) Object.assign(c, patch); }, isLive),
  /** Move the left edge of a clip without moving its content on the timeline. */
  trimClipStart(id: ID, newStart: number, isLive?: boolean): void {
    apply((p) => {
      const c = p.clips.find((x) => x.id === id);
      if (!c) return;
      if (c.type === 'midi') {
        const s = clamp(newStart, 0, c.start + c.length - 0.125);
        const delta = s - c.start;
        c.start = s; c.length -= delta;
        for (const n of c.notes) n.start -= delta;
      } else {
        const minStart = c.start - secToBeats(c.offset, p.bpm);
        const s = clamp(newStart, Math.max(0, minStart), c.start + secToBeats(c.length, p.bpm) - 0.05);
        const dSec = beatsToSec(s - c.start, p.bpm);
        c.start = s; c.offset = Math.max(0, c.offset + dSec); c.length -= dSec;
        c.fadeIn = Math.min(c.fadeIn, c.length); c.fadeOut = Math.min(c.fadeOut, c.length);
      }
    }, isLive);
  },
  /** Move the right edge of a clip. Audio clips cannot extend past their source. */
  trimClipEnd(id: ID, newEnd: number, isLive?: boolean): void {
    apply((p) => {
      const c = p.clips.find((x) => x.id === id);
      if (!c) return;
      if (c.type === 'midi') c.length = Math.max(0.125, newEnd - c.start);
      else {
        const asset = p.assets.find((a) => a.id === c.assetId);
        const maxLen = (asset?.duration ?? c.offset + c.length) - c.offset;
        c.length = clamp(beatsToSec(newEnd - c.start, p.bpm), 0.05, maxLen);
        c.fadeIn = Math.min(c.fadeIn, c.length); c.fadeOut = Math.min(c.fadeOut, c.length);
      }
    }, isLive);
  },
  placeClips: (items: { id: ID; start: number; trackId: ID }[], isLive?: boolean) => apply((p) => {
    for (const it of items) {
      const c = p.clips.find((x) => x.id === it.id);
      const t = p.tracks.find((x) => x.id === it.trackId);
      if (!c || !t) continue;
      c.start = clamp(it.start, 0, maxBeats(p.bpm) - 0.25);
      if ((c.type === 'midi') === (t.kind === 'instrument')) c.trackId = it.trackId;
    }
  }, isLive),
  removeClips(ids: ID[]): void {
    if (!ids.length) return;
    commit((p) => { p.clips = p.clips.filter((c) => !ids.includes(c.id)); });
    const s = get();
    setUI({ selectedClipIds: s.ui.selectedClipIds.filter((i) => !ids.includes(i)), editClipId: ids.includes(s.ui.editClipId ?? '') ? null : s.ui.editClipId });
  },
  duplicateClips(ids: ID[], isLive?: boolean): ID[] {
    const made: ID[] = [];
    apply((p) => {
      for (const id of ids) {
        const c = p.clips.find((x) => x.id === id);
        if (!c) continue;
        const copy = JSON.parse(JSON.stringify(c)) as Clip;
        copy.id = uid();
        copy.start = isLive ? c.start : clipEnd(c, p.bpm);
        if (copy.type === 'midi') copy.notes.forEach((n) => { n.id = uid(); });
        p.clips.push(copy);
        made.push(copy.id);
      }
    }, isLive);
    if (!isLive) setUI({ selectedClipIds: made });
    return made;
  },
  splitClips(ids: ID[], beat: number): void {
    commit((p) => {
      for (const id of ids) {
        const c = p.clips.find((x) => x.id === id);
        if (!c) continue;
        const end = clipEnd(c, p.bpm);
        if (beat <= c.start + 0.01 || beat >= end - 0.01) continue;
        if (c.type === 'midi') {
          const cut = beat - c.start;
          const right: MidiClip = { ...c, id: uid(), start: beat, length: c.length - cut, notes: c.notes.filter((n) => n.start >= cut).map((n) => ({ ...n, id: uid(), start: n.start - cut })) };
          c.notes = c.notes.filter((n) => n.start < cut).map((n) => ({ ...n, duration: Math.min(n.duration, cut - n.start) }));
          c.length = cut;
          p.clips.push(right);
        } else {
          const cutSec = beatsToSec(beat - c.start, p.bpm);
          const right: AudioClip = { ...c, id: uid(), start: beat, offset: c.offset + cutSec, length: c.length - cutSec, fadeIn: 0 };
          c.length = cutSec; c.fadeOut = 0;
          right.fadeOut = Math.min(right.fadeOut, right.length);
          c.fadeIn = Math.min(c.fadeIn, c.length);
          p.clips.push(right);
        }
      }
    });
  },
  /** Join MIDI clips on one track into a single clip. */
  mergeMidiClips(ids: ID[]): void {
    const s = get();
    const clips = s.project.clips.filter((c): c is MidiClip => ids.includes(c.id) && c.type === 'midi');
    if (clips.length < 2 || new Set(clips.map((c) => c.trackId)).size !== 1) {
      toast('Select two or more note clips on the same track to merge.', 'info');
      return;
    }
    const start = Math.min(...clips.map((c) => c.start));
    const end = Math.max(...clips.map((c) => c.start + c.length));
    const merged: MidiClip = {
      id: uid(), type: 'midi', trackId: clips[0].trackId, name: clips[0].name, start, length: end - start,
      notes: clips.flatMap((c) => c.notes.filter((n) => n.start >= 0 && n.start < c.length).map((n) => ({ ...n, id: uid(), start: n.start + c.start - start, duration: Math.min(n.duration, c.length - n.start) }))),
    };
    commit((p) => { p.clips = p.clips.filter((c) => !ids.includes(c.id)); p.clips.push(merged); });
    setUI({ selectedClipIds: [merged.id], editClipId: merged.id });
  },
  /** Bounce audio clips on one track (with their gains and fades) into one new clip. */
  async mergeAudioClips(ids: ID[]): Promise<void> {
    const s = get();
    const clips = s.project.clips.filter((c): c is AudioClip => ids.includes(c.id) && c.type === 'audio').sort((a, b) => a.start - b.start);
    if (clips.length < 2 || new Set(clips.map((c) => c.trackId)).size !== 1) {
      toast('Select two or more audio clips on the same track to merge.', 'info');
      return;
    }
    const bpm = s.project.bpm;
    const sr = engine.sampleRate;
    const start = clips[0].start;
    const endSec = Math.max(...clips.map((c) => beatsToSec(c.start - start, bpm) + c.length));
    const bufs = clips.map((c) => engine.buffers.get(c.assetId));
    const channels = Math.max(1, ...bufs.map((b) => b?.numberOfChannels ?? 1));
    const out = engine.createBuffer(channels, Math.ceil(endSec * sr), sr);
    clips.forEach((c, i) => {
      const src = bufs[i];
      if (!src) return;
      const at = Math.round(beatsToSec(c.start - start, bpm) * sr);
      const n = Math.round(c.length * sr);
      const ratio = src.sampleRate / sr;
      const g = Math.pow(10, c.gain / 20);
      for (let ch = 0; ch < channels; ch++) {
        const sd = src.getChannelData(Math.min(ch, src.numberOfChannels - 1));
        const od = out.getChannelData(ch);
        for (let k = 0; k < n && at + k < od.length; k++) {
          const t = k / sr;
          let env = g;
          if (c.fadeIn > 0 && t < c.fadeIn) env *= t / c.fadeIn;
          if (c.fadeOut > 0 && t > c.length - c.fadeOut) env *= Math.max(0, (c.length - t) / c.fadeOut);
          od[at + k] += (sd[Math.min(sd.length - 1, Math.round((c.offset + t) * sr * ratio))] ?? 0) * env;
        }
      }
    });
    const meta = await addBufferAsset(out, `${clips[0].name} merged`);
    const newId = uid();
    commit((p) => {
      registerAsset(p, meta);
      p.clips = p.clips.filter((c) => !ids.includes(c.id));
      p.clips.push({ id: newId, type: 'audio', trackId: clips[0].trackId, name: meta.name, start, assetId: meta.id, offset: 0, length: meta.duration, gain: 0, fadeIn: 0, fadeOut: 0 });
    });
    setUI({ selectedClipIds: [newId] });
  },
  copyClips(ids: ID[]): void {
    const clips = get().project.clips.filter((c) => ids.includes(c.id));
    if (clips.length) set({ clipboard: JSON.parse(JSON.stringify(clips)) as Clip[] });
  },
  pasteClips(atBeat: number): void {
    const { clipboard, project, ui } = get();
    if (!clipboard.length) return;
    const first = Math.min(...clipboard.map((c) => c.start));
    const made: ID[] = [];
    commit((p) => {
      for (const c of clipboard) {
        const copy = JSON.parse(JSON.stringify(c)) as Clip;
        copy.id = uid();
        copy.start = atBeat + (c.start - first);
        // Paste onto the selected track when it is the same kind and a single clip was copied.
        const target = project.tracks.find((t) => t.id === ui.selectedTrackId);
        if (clipboard.length === 1 && target && (target.kind === 'instrument') === (copy.type === 'midi')) copy.trackId = target.id;
        if (!p.tracks.some((t) => t.id === copy.trackId)) continue;
        if (copy.type === 'midi') copy.notes.forEach((n) => { n.id = uid(); });
        p.clips.push(copy);
        made.push(copy.id);
      }
    });
    setUI({ selectedClipIds: made });
  },

  // notes
  setNotes: (clipId: ID, notes: Note[], isLive?: boolean) => apply((p) => {
    const c = p.clips.find((x) => x.id === clipId);
    if (c && c.type === 'midi') c.notes = notes;
  }, isLive),

  // selection
  selectTrack(id: ID | null): void {
    const s = get();
    const edit = findClip(s.project, s.ui.editClipId);
    setUI({ selectedTrackId: id, editClipId: edit && edit.trackId === id ? edit.id : null });
  },
  openClip(id: ID): void {
    const c = findClip(get().project, id);
    if (!c) return;
    setUI({ selectedTrackId: c.trackId, selectedClipIds: [id], editClipId: c.type === 'midi' ? id : get().ui.editClipId, bottomPanel: 'editor', panelOpen: true });
  },
  /** Make sure the selected instrument track has a clip open in the note editor; create one if needed. */
  ensureEditClip(): ID | null {
    const s = get();
    const track = selectedTrack(s);
    if (!track || track.kind !== 'instrument') return null;
    const current = findClip(s.project, s.ui.editClipId);
    if (current && current.trackId === track.id) return current.id;
    const beat = engine.beat;
    const clips = s.project.clips.filter((c) => c.trackId === track.id && c.type === 'midi').sort((a, b) => a.start - b.start);
    const hit = clips.find((c) => beat >= c.start && beat < clipEnd(c, s.project.bpm)) ?? clips[0];
    const id = hit?.id ?? A.addMidiClip(track.id, 0);
    setUI({ editClipId: id });
    return id;
  },

  // transport
  async play(): Promise<void> {
    await engine.play();
    set({ playing: true });
  },
  stop(): void {
    if (get().recording) { void A.stopRecording(); return; }
    engine.pause();
    set({ playing: false });
  },
  toggle(): void { if (get().playing) A.stop(); else void A.play(); },
  seek(beat: number): void { engine.seek(clamp(beat, 0, maxBeats(get().project.bpm))); },
  toStart(): void { engine.seek(get().project.loop.on ? get().project.loop.start : 0); },
  setMetronome(on: boolean): void { engine.setMetronome(on); setUI({ metronome: on }); },

  // live playing (on-screen keyboard, pads, computer keys)
  noteOn(midi: number, velocity = 0.8): void {
    const s = get();
    const track = selectedTrack(s);
    if (!track || track.kind !== 'instrument') return;
    engine.noteOn(track.id, midi, velocity);
    if (s.playing && s.ui.midiRecord) heldNotes.set(midi, { beat: engine.beat, velocity, trackId: track.id });
  },
  noteOff(midi: number): void {
    const s = get();
    const track = selectedTrack(s);
    if (track) engine.noteOff(track.id, midi);
    const h = heldNotes.get(midi);
    if (!h) return;
    heldNotes.delete(midi);
    const grid = gridBeats(s);
    const drums = isDrums(s.project.tracks.find((t) => t.id === h.trackId)?.instrumentId);
    const startAbs = grid > 0 ? snapBeat(h.beat, grid) : h.beat;
    const dur = drums ? 0.25 : Math.max(grid > 0 ? grid : 0.1, engine.beat - h.beat);
    commit((p) => {
      let clip = p.clips.find((c): c is MidiClip => c.type === 'midi' && c.trackId === h.trackId && startAbs >= c.start && startAbs < c.start + c.length + 1e-6);
      if (!clip) {
        const bar = barBeats(p.timeSig);
        clip = { id: uid(), type: 'midi', trackId: h.trackId, name: 'Recorded notes', start: floorBeat(startAbs, bar), length: bar * 4, notes: [] };
        p.clips.push(clip);
      }
      const start = startAbs - clip.start;
      if (start + dur > clip.length) clip.length = Math.ceil((start + dur) / barBeats(p.timeSig)) * barBeats(p.timeSig);
      clip.notes.push({ id: uid(), pitch: midi, start, duration: dur, velocity: h.velocity });
    });
  },

  // audio recording
  async startRecording(): Promise<void> {
    const s = get();
    if (s.recording) return;
    try {
      await engine.resume();
      await mic.open();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The microphone could not be opened.', 'error');
      return;
    }
    mic.setGain(s.ui.inputGain);
    mic.setMonitor(s.ui.monitor);
    const sel = selectedTrack(get());
    const takes = get().project.tracks.filter((t) => t.kind === 'audio').length;
    const trackId = sel && sel.kind === 'audio' ? sel.id : A.addTrack('audio', null, `Vocal take ${takes + 1}`);
    engine.pause();
    engine.setHoldOpen(true);
    const startBeat = engine.beat;
    const ctxStart = get().ui.countIn ? engine.countIn(1) : undefined;
    mic.start();
    const startAt = ctxStart ?? engine.contextTime + 0.12;
    await engine.play(startAt);
    set({ recording: { trackId, startBeat, ctxStart: startAt }, playing: true });
  },
  async stopRecording(): Promise<void> {
    const rec = get().recording;
    if (!rec) return;
    engine.pause();
    engine.setHoldOpen(false);
    set({ recording: null, playing: false });
    try {
      const r = await mic.stop();
      // Drop the count-in and shift by the round-trip latency so the take lines up with what was heard.
      const comp = mic.roundTripLatency() + get().ui.latencyMs / 1000;
      const skip = Math.max(0, Math.round((rec.ctxStart + comp - r.startTime) * r.sampleRate));
      const data = r.data.subarray(Math.min(skip, r.data.length));
      if (data.length < r.sampleRate * 0.15) {
        toast('That take was too short to keep.', 'info');
        return;
      }
      const buffer = engine.createBuffer(1, data.length, r.sampleRate);
      buffer.getChannelData(0).set(data);
      const n = get().project.assets.length + 1;
      const meta = await addBufferAsset(buffer, `Take ${n}`);
      const id = A.addAudioClip(rec.trackId, meta, rec.startBeat);
      setUI({ selectedClipIds: [id], selectedTrackId: rec.trackId });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The recording could not be saved.', 'error');
    }
  },

  // projects
  async openProject(id: ID): Promise<boolean> {
    const p = await db.getProject(id);
    if (!p) { toast('That project could not be found.', 'error'); return false; }
    await loadIntoSession(p);
    return true;
  },
  async newProject(templateId?: string, name?: string): Promise<void> {
    const p = templateId ? createFromTemplate(templateId) : createProject(name);
    if (name) p.name = name;
    await db.putProject(p);
    await loadIntoSession(p);
  },
  async duplicateProject(id: ID): Promise<void> {
    const p = await db.getProject(id);
    if (!p) return;
    const now = Date.now();
    await db.putProject({ ...p, id: uid(), name: `${p.name} copy`, createdAt: now, updatedAt: now });
  },
  async deleteProject(id: ID): Promise<void> {
    await db.deleteProject(id);
    if (get().project.id === id) {
      const rest = await db.listProjects();
      if (rest.length) await A.openProject(rest[0].id);
      else await A.newProject();
    }
  },
  async importProject(file: File): Promise<void> {
    const { project, assets } = await importProjectFile(file);
    const now = Date.now();
    const p: Project = { ...project, id: uid(), updatedAt: now };
    for (const a of assets) await db.putAsset(a);
    await db.putProject(p);
    await loadIntoSession(p);
  },
  async importMidi(file: File): Promise<void> {
    const res = midiToTracks(await file.arrayBuffer(), get().project.tracks.length);
    if (!res.tracks.length) { toast('No notes were found in that MIDI file.', 'error'); return; }
    commit((p) => {
      if (!p.clips.length && res.bpm) p.bpm = clamp(res.bpm, 40, 240);
      p.tracks.push(...res.tracks);
      p.clips.push(...res.clips);
    });
    toast(`Imported ${res.tracks.length} track${res.tracks.length === 1 ? '' : 's'} from ${file.name}.`, 'success');
  },
  /** Import audio files onto new or existing audio tracks at a beat position. */
  async importAudioFiles(files: File[], atBeat = 0, trackId?: ID): Promise<void> {
    for (const file of files) {
      if (file.size > 200 * 1024 * 1024) { toast(`${file.name} is larger than 200 MB.`, 'error'); continue; }
      try {
        const meta = await importAudio(file, file.name);
        const target = get().project.tracks.find((t) => t.id === trackId && t.kind === 'audio');
        const id = target?.id ?? A.addTrack('audio', null, meta.name.slice(0, 28));
        A.addAudioClip(id, meta, atBeat);
        trackId = undefined;
      } catch (e) {
        toast(e instanceof Error ? e.message : `Could not import ${file.name}.`, 'error');
      }
    }
  },
};

// ---- session loading and autosave ---------------------------------------

async function loadIntoSession(loaded: Project): Promise<void> {
  engine.pause();
  const p = migrate(loaded);
  const missing: string[] = [];
  await Promise.all(p.assets.map(async (meta) => {
    if (engine.buffers.has(meta.id)) return;
    try {
      const stored = await db.getAsset(meta.id);
      if (!stored) { missing.push(meta.name); return; }
      if (meta.kind === 'video') {
        registerVideo(meta.id, stored.blob);
        // a video's soundtrack is only decoded when an audio clip actually plays it
        if (!p.clips.some((c) => c.type === 'audio' && c.assetId === meta.id)) return;
      }
      engine.buffers.set(meta.id, await engine.decode(await stored.blob.arrayBuffer()));
    } catch {
      missing.push(meta.name);
    }
  }));
  engine.seek(0);
  set((s) => ({
    project: p, past: [], future: [], playing: false, ready: true, saveState: 'saved',
    ui: { ...s.ui, selectedTrackId: p.tracks[0]?.id ?? null, selectedClipIds: [], editClipId: null, videoSel: null },
  }));
  try { localStorage.setItem(LAST_KEY, p.id); } catch { /* ignore */ }
  if (missing.length) toast(`Audio missing from local storage: ${missing.join(', ')}.`, 'error');
}

export async function initSession(): Promise<void> {
  try {
    const last = localStorage.getItem(LAST_KEY);
    const saved = last ? await db.getProject(last) : undefined;
    if (saved) { await loadIntoSession(saved); return; }
    const list = await db.listProjects();
    if (list.length) { const p = await db.getProject(list[0].id); if (p) { await loadIntoSession(p); return; } }
    const first = createFromTemplate('pop');
    first.name = 'My first song';
    await db.putProject(first);
    await loadIntoSession(first);
  } catch {
    // Storage unavailable (private browsing): keep working in memory.
    const p = createFromTemplate('pop');
    p.name = 'My first song';
    engine.seek(0);
    set((s) => ({ project: p, ready: true, saveState: 'error', ui: { ...s.ui, selectedTrackId: p.tracks[0]?.id ?? null } }));
    toast('Local storage is unavailable, so this session will not be saved.', 'error');
  }
}

let saveTimer = 0;
useStore.subscribe((s, prev) => {
  if (s.project === prev.project) return;
  engine.sync(s.project);
  if (!s.ready || !prev.ready || s.project.id !== prev.project.id) return;
  if (s.saveState !== 'saving') set({ saveState: 'saving' });
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const p = { ...get().project, updatedAt: Date.now() };
    db.putProject(p).then(() => set({ saveState: 'saved' }), () => set({ saveState: 'error' }));
  }, 900);
});

engine.on((e) => {
  if (e.type === 'ended') set({ playing: false });
  else set((s) => ({ instrumentStatus: { ...s.instrumentStatus, [e.id]: e.status } }));
});

window.addEventListener('hashchange', () => {
  const page = pageFromHash();
  if (page !== get().ui.page) setUI({ page });
});

export { clipLengthBeats };
