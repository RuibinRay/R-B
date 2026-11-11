import * as Tone from 'tone';
import type { ID, Project } from '../types';
import { MAX_SONG_SECONDS, defaultMaster } from '../types';
import { getInstrument } from '../lib/instruments';
import { effectiveFades, trackMix } from '../lib/mix';
import { projectEndBeats } from '../lib/music';
import { MasterChain, TrackChain, startClipSource } from './graph';
import { createVoiceSync, ensureInstrument, type Voice } from './voices';

// Offline render of the real project graph: the same voices, effect chains and mix
// used for live playback are rebuilt in an OfflineAudioContext and bounced to a buffer.

export interface RenderOptions {
  /** Render a single track as a stem (track effects on, master processing bypassed). */
  onlyTrackId?: ID;
  sampleRate?: number;
}

export async function renderProject(p: Project, buffers: Map<ID, AudioBuffer>, opts: RenderOptions = {}): Promise<AudioBuffer> {
  const spb = 60 / p.bpm;
  const endSec = Math.min(MAX_SONG_SECONDS, projectEndBeats(p) * spb);
  if (endSec <= 0.01) throw new Error('There is nothing to export yet. Add some notes or audio first.');

  const used = p.tracks.filter((t) => t.kind === 'instrument' && p.clips.some((c) => c.trackId === t.id));
  await Promise.all(used.map((t) => { const def = getInstrument(t.instrumentId); return def ? ensureInstrument(def) : null; }));

  const duration = Math.min(MAX_SONG_SECONDS, endSec + 2.5); // room for reverb and release tails
  const ctx = new Tone.OfflineContext(2, duration, opts.sampleRate ?? 44100);
  const live = Tone.getContext();
  const ready: Promise<unknown>[] = [];

  // Build synchronously while the offline context is current, then hand the global
  // context straight back so the live engine is never left pointing at the render.
  Tone.setContext(ctx);
  try {
    const master = new MasterChain(false);
    master.set(opts.onlyTrackId ? defaultMasterBypass() : p.master, true);
    const fades = effectiveFades(p);
    for (const track of p.tracks) {
      const mix = trackMix(p, track);
      if (opts.onlyTrackId ? track.id !== opts.onlyTrackId : !mix.audible) continue;
      const clips = p.clips.filter((c) => c.trackId === track.id && !c.muted);
      if (!clips.length) continue;
      const chain = new TrackChain(master.input, false);
      chain.setFx(track.fx);
      chain.setMix(mix.volume, track.pan, true, true);
      chain.scheduleAutomation(track.automation, p.bpm, 0, 0);
      ready.push(...chain.ready);
      let voice: Voice | null = null;
      const def = track.kind === 'instrument' ? getInstrument(track.instrumentId) : undefined;
      if (def) {
        voice = createVoiceSync(def);
        voice.output.connect(chain.input);
      }
      for (const clip of clips) {
        const t0 = clip.start * spb;
        if (t0 >= endSec) continue;
        if (clip.type === 'midi') {
          if (!voice) continue;
          for (const n of clip.notes) {
            if (n.start < 0 || n.start >= clip.length) continue;
            const t = t0 + n.start * spb;
            if (t >= endSec) continue;
            const dur = Math.min(n.duration, clip.length - n.start) * spb;
            voice.play(n.pitch, Math.min(dur, endSec - t), t, n.velocity, n.bend);
          }
        } else {
          const buf = buffers.get(clip.assetId);
          if (!buf) continue;
          const length = Math.min(clip.length, endSec - t0);
          startClipSource(chain.input, buf, { ...clip, length }, t0, 0, fades.get(clip.id));
        }
      }
    }
  } finally {
    Tone.setContext(live);
  }

  await Promise.all(ready);
  // Synchronous clock pass (no timer yields), so exports stay fast even in a background tab.
  const rendered = await ctx.render(false);
  const out = rendered.get();
  if (!out) throw new Error('The render produced no audio.');
  return out;
}

const defaultMasterBypass = () => ({ ...defaultMaster(), limiter: { on: false, ceiling: 0 } });
