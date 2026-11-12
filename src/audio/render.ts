import * as Tone from 'tone';
import type { ID, Project } from '../types';
import { MAX_SONG_SECONDS, defaultMaster } from '../types';
import { getInstrument, type InstrumentDef } from '../lib/instruments';
import { effectiveFades, trackMix } from '../lib/mix';
import { projectEndBeats } from '../lib/music';
import { MasterChain, TrackChain, startClipSource } from './graph';
import { createVoiceSync, ensureInstrument, type Expression } from './voices';

// Offline render of the real project graph: the same voices, effect chains and mix
// used for live playback are rebuilt in OfflineAudioContexts and bounced to a buffer.

export interface RenderOptions {
  /** Render a single track as a stem (track effects on, master processing bypassed). */
  onlyTrackId?: ID;
  sampleRate?: number;
}

/** Build a graph while `ctx` is the current Tone context, then hand the global context straight back. */
function inContext<T>(ctx: Tone.OfflineContext, build: () => T): T {
  const live = Tone.getContext();
  Tone.setContext(ctx);
  try { return build(); } finally { Tone.setContext(live); }
}

async function bounce(ctx: Tone.OfflineContext): Promise<AudioBuffer> {
  // Synchronous clock pass (no timer yields), so exports stay fast even in a background tab.
  const out = (await ctx.render(false)).get();
  if (!out) throw new Error('The render produced no audio.');
  return out;
}

interface PlayNote { t: number; dur: number; pitch: number; velocity: number; bend?: number[]; expr?: Expression }

const WINDOW = 6; // seconds of note starts rendered per pass
const TAIL = 4; // room after the last note of a pass for it to ring out

/**
 * The plain sound of one instrument playing `notes` (no track effects), `seconds` long.
 *
 * Every note is a handful of audio nodes that exist for the whole length of a render,
 * so rendering a full song in one pass costs (number of notes) x (length of the song).
 * Rendering it a few seconds of note starts at a time and adding the pieces together
 * gives the same sound (the instruments simply sum their notes) at a fraction of the cost.
 */
async function renderVoice(def: InstrumentDef, notes: PlayNote[], seconds: number, sampleRate: number): Promise<Float32Array[]> {
  const total = Math.ceil(seconds * sampleRate);
  const out = [new Float32Array(total), new Float32Array(total)];
  const sorted = [...notes].sort((a, b) => a.t - b.t);
  for (let from = 0, i = 0; i < sorted.length; from += WINDOW) {
    const group: PlayNote[] = [];
    while (i < sorted.length && sorted[i].t < from + WINDOW) group.push(sorted[i++]);
    if (!group.length) continue;
    const length = Math.min(seconds - from, Math.max(...group.map((n) => n.t + n.dur)) - from + TAIL);
    if (length <= 0) continue;
    const ctx = new Tone.OfflineContext(2, length, sampleRate);
    inContext(ctx, () => {
      const voice = createVoiceSync(def);
      voice.output.toDestination();
      for (const n of group) voice.play(n.pitch, n.dur, n.t - from, n.velocity, n.bend, n.expr);
    });
    const piece = await bounce(ctx);
    const at = Math.round(from * sampleRate);
    for (let c = 0; c < 2; c++) {
      const src = piece.getChannelData(Math.min(c, piece.numberOfChannels - 1)), dst = out[c];
      const n = Math.min(src.length, total - at);
      for (let k = 0; k < n; k++) dst[at + k] += src[k];
    }
  }
  return out;
}

export async function renderProject(p: Project, buffers: Map<ID, AudioBuffer>, opts: RenderOptions = {}): Promise<AudioBuffer> {
  const spb = 60 / p.bpm;
  const endSec = Math.min(MAX_SONG_SECONDS, projectEndBeats(p) * spb);
  if (endSec <= 0.01) throw new Error('There is nothing to export yet. Add some notes or audio first.');
  const sampleRate = opts.sampleRate ?? 44100;
  const duration = Math.min(MAX_SONG_SECONDS, endSec + 2.5); // room for reverb and release tails
  const frames = Math.ceil(duration * sampleRate);

  const used = p.tracks.filter((t) => t.kind === 'instrument' && p.clips.some((c) => c.trackId === t.id));
  await Promise.all(used.map((t) => { const def = getInstrument(t.instrumentId); return def ? ensureInstrument(def) : null; }));

  // Tracks only meet at the master, so each one is rendered on its own (instrument,
  // effects, fader, automation) and added to the mix; the master runs over the sum.
  const mix = [new Float32Array(frames), new Float32Array(frames)];
  const fades = effectiveFades(p);
  for (const track of p.tracks) {
    const level = trackMix(p, track);
    if (opts.onlyTrackId ? track.id !== opts.onlyTrackId : !level.audible) continue;
    const clips = p.clips.filter((c) => c.trackId === track.id && !c.muted && c.start * spb < endSec);
    if (!clips.length) continue;

    const def = track.kind === 'instrument' ? getInstrument(track.instrumentId) : undefined;
    const notes: PlayNote[] = [];
    if (def) {
      for (const clip of clips) {
        if (clip.type !== 'midi') continue;
        const t0 = clip.start * spb;
        for (const n of clip.notes) {
          if (n.start < 0 || n.start >= clip.length) continue;
          const t = t0 + n.start * spb;
          if (t >= endSec) continue;
          const dur = Math.min(n.duration, clip.length - n.start) * spb;
          notes.push({ t, dur: Math.min(dur, endSec - t), pitch: n.pitch, velocity: n.velocity, bend: n.bend, expr: n.legato || n.dyn ? { legato: n.legato, dyn: n.dyn } : undefined });
        }
      }
    }
    const audio = clips.filter((c) => c.type === 'audio' && buffers.has(c.assetId));
    if (!notes.length && !audio.length) continue;
    const dry = def && notes.length ? await renderVoice(def, notes, duration, sampleRate) : null;

    const ctx = new Tone.OfflineContext(2, duration, sampleRate);
    const ready = inContext(ctx, () => {
      const raw = ctx.rawContext as unknown as BaseAudioContext;
      const chain = new TrackChain(new Tone.Gain(1).toDestination(), false);
      chain.setFx(track.fx);
      chain.setMix(level.volume, track.pan, true, true);
      chain.scheduleAutomation(track.automation, p.bpm, 0, 0);
      if (dry) {
        const buffer = raw.createBuffer(2, frames, sampleRate);
        buffer.getChannelData(0).set(dry[0]);
        buffer.getChannelData(1).set(dry[1]);
        const src = raw.createBufferSource();
        src.buffer = buffer;
        Tone.connect(src as never, chain.input);
        src.start(0);
      }
      for (const clip of audio) {
        if (clip.type !== 'audio') continue;
        const t0 = clip.start * spb;
        startClipSource(chain.input, buffers.get(clip.assetId)!, { ...clip, length: Math.min(clip.length, endSec - t0) }, t0, 0, fades.get(clip.id));
      }
      return chain.ready;
    });
    await Promise.all(ready);
    const wet = await bounce(ctx);
    for (let c = 0; c < 2; c++) {
      const src = wet.getChannelData(Math.min(c, wet.numberOfChannels - 1)), dst = mix[c];
      const n = Math.min(src.length, frames);
      for (let k = 0; k < n; k++) dst[k] += src[k];
    }
  }

  // The master chain (EQ, compressor, limiter, volume) over the summed tracks.
  const ctx = new Tone.OfflineContext(2, duration, sampleRate);
  inContext(ctx, () => {
    const raw = ctx.rawContext as unknown as BaseAudioContext;
    const master = new MasterChain(false);
    master.set(opts.onlyTrackId ? defaultMasterBypass() : p.master, true);
    const buffer = raw.createBuffer(2, frames, sampleRate);
    buffer.getChannelData(0).set(mix[0]);
    buffer.getChannelData(1).set(mix[1]);
    const src = raw.createBufferSource();
    src.buffer = buffer;
    Tone.connect(src as never, master.input);
    src.start(0);
  });
  return bounce(ctx);
}

const defaultMasterBypass = () => ({ ...defaultMaster(), limiter: { on: false, ceiling: 0 } });
