import type { AudioClip, ID, TuneSettings } from '../types';
import { MAX_SONG_SECONDS } from '../types';
import { detectOnsets, estimateTempo } from '../lib/dsp/rhythm';
import { stretchAudio } from '../lib/dsp/stretch';
import { tuneAudio, type TuneResult } from '../lib/dsp/tune';
import { A, addBufferAsset, useStore } from '../store/store';
import { engine } from './engine';

// Pitch correction and time-stretching of one audio clip.
//
// Both always start again from the clip's untouched original audio, in the order
// tune → stretch, so changing one setting never stacks processing on top of
// processing and either one can be removed on its own later.

export interface ProcessRequest {
  tune?: TuneSettings | null; // null removes the correction; leave out to keep what the clip has
  stretch?: number | null; // new length / original length; null removes it
}
export interface ProcessResult { tune?: TuneResult; length: number }

export const STRETCH_MIN = 0.25;
export const STRETCH_MAX = 4;

/** The part of the untouched source that a clip currently plays. */
export function originalRegion(clip: AudioClip): { assetId: ID; offset: number; length: number } {
  if (!clip.proc) return { assetId: clip.assetId, offset: clip.offset, length: clip.length };
  const r = clip.proc.stretch ?? 1;
  return { assetId: clip.proc.original.assetId, offset: clip.proc.original.offset + clip.offset / r, length: clip.length / r };
}

export async function processClip(clipId: ID, req: ProcessRequest, onProgress?: (fraction: number) => void): Promise<ProcessResult> {
  const clip = useStore.getState().project.clips.find((c) => c.id === clipId);
  if (!clip || clip.type !== 'audio') throw new Error('That clip is no longer in the project.');
  const src = originalRegion(clip);
  const tune = req.tune === undefined ? clip.proc?.tune : req.tune ?? undefined;
  let stretch = req.stretch === undefined ? clip.proc?.stretch : req.stretch ?? undefined;
  if (stretch !== undefined && Math.abs(stretch - 1) < 0.005) stretch = undefined;
  if (stretch !== undefined && (stretch < STRETCH_MIN || stretch > STRETCH_MAX)) throw new Error('That is too big a change: a clip can be made up to four times longer or shorter.');

  const buf = engine.buffers.get(src.assetId);
  if (!buf) throw new Error('The original audio for this clip is not loaded.');
  const fades = (length: number) => ({ fadeIn: Math.min(clip.fadeIn, length), fadeOut: Math.min(clip.fadeOut, Math.max(0, length - clip.fadeIn)) });

  if (!tune && !stretch) {
    // nothing left to apply: point the clip back at its original audio
    A.updateClip(clip.id, { assetId: src.assetId, offset: src.offset, length: src.length, proc: undefined, ...fades(src.length) });
    return { length: src.length };
  }

  const sr = buf.sampleRate;
  const start = Math.max(0, Math.round(src.offset * sr));
  const n = Math.min(buf.length - start, Math.round(src.length * sr));
  if (n < sr * 0.2) throw new Error('This clip is too short to process.');
  if (stretch && (n * stretch) / sr > MAX_SONG_SECONDS) throw new Error('The stretched clip would be longer than the five-minute song limit.');

  let channels: Float32Array[] = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice(start, start + n));
  const steps = (tune ? 1 : 0) + (stretch ? 1 : 0);
  let done = 0;
  const part = (f: number) => onProgress?.((done + f) / steps);
  onProgress?.(0);

  let tuned: TuneResult | undefined;
  if (tune) {
    tuned = await tuneAudio(channels, sr, tune, part);
    if (tuned.voicedRatio < 0.05) throw new Error('No clear single pitch was found, so nothing was changed. Pitch correction needs one voice or instrument at a time.');
    channels = tuned.channels;
    done++;
  }
  if (stretch) {
    channels = await stretchAudio(channels, sr, stretch, part);
    done++;
  }

  const out = engine.createBuffer(channels.length, channels[0].length, sr);
  channels.forEach((ch, c) => out.getChannelData(c).set(ch));
  const meta = { ...(await addBufferAsset(out, `${clip.name} (processed)`)), derived: true };
  const length = channels[0].length / sr;
  A.retargetClip(clip.id, meta, { offset: 0, length, proc: { original: src, tune, stretch }, ...fades(length) });
  return { tune: tuned, length };
}

/** A tempo estimate for the clip's original audio, from its note and drum onsets. */
export function detectClipTempo(clip: AudioClip): number | null {
  const src = originalRegion(clip);
  const buf = engine.buffers.get(src.assetId);
  if (!buf) return null;
  const sr = buf.sampleRate;
  const start = Math.max(0, Math.round(src.offset * sr));
  const n = Math.min(buf.length - start, Math.round(Math.min(src.length, 60) * sr)); // a minute is plenty
  const mono = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[start + i] / buf.numberOfChannels;
  }
  return estimateTempo(detectOnsets(mono, sr));
}
