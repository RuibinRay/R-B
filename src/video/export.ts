import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { engine } from '../audio/engine';
import { renderProject } from '../audio/render';
import type { Project } from '../types';
import { MAX_SONG_SECONDS } from '../types';
import { limitPeaks } from '../lib/loudness';
import { beatsToSec, projectEndBeats } from '../lib/music';
import { Compositor, frameSize } from './video';

// MP4 export. Every frame is composed exactly as in the preview (the video
// elements are stepped to each frame time, not played), encoded with WebCodecs
// and muxed together with the offline-rendered song mix.

export interface Mp4Options { short: 720 | 1080; fps: 24 | 30; onProgress?: (fraction: number, stage: string) => void; cancelled?: () => boolean }
export interface Mp4Result { blob: Blob; width: number; height: number; fps: number; duration: number; videoCodec: string; audioCodec: string | null }

/* eslint-disable @typescript-eslint/no-explicit-any */
const W = window as any;

export const canExportMp4 = (): boolean => typeof W.VideoEncoder === 'function' && typeof W.VideoFrame === 'function';

async function pickVideoCodec(width: number, height: number, fps: number, bitrate: number): Promise<{ codec: string; mux: 'avc' | 'vp9' }> {
  const tries: [string, 'avc' | 'vp9'][] = [['avc1.640033', 'avc'], ['avc1.640028', 'avc'], ['avc1.4d0028', 'avc'], ['avc1.42001f', 'avc'], ['vp09.00.40.08', 'vp9']];
  for (const [codec, mux] of tries) {
    try {
      const ok = await W.VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps });
      if (ok?.supported) return { codec, mux };
    } catch { /* try the next one */ }
  }
  throw new Error('This browser has no video encoder that can write MP4. Use a current version of Chrome, Edge or Safari.');
}

async function pickAudioCodec(): Promise<{ codec: string; mux: 'aac' | 'opus'; sampleRate: number } | null> {
  if (typeof W.AudioEncoder !== 'function') return null;
  const tries: [string, 'aac' | 'opus', number][] = [['mp4a.40.2', 'aac', 44100], ['opus', 'opus', 48000]];
  for (const [codec, mux, sampleRate] of tries) {
    try {
      const ok = await W.AudioEncoder.isConfigSupported({ codec, sampleRate, numberOfChannels: 2, bitrate: 192000 });
      if (ok?.supported) return { codec, mux, sampleRate };
    } catch { /* try the next one */ }
  }
  return null;
}

export async function exportMp4(project: Project, opts: Mp4Options): Promise<Mp4Result> {
  if (!canExportMp4()) throw new Error('MP4 export needs WebCodecs, which this browser does not have. Use a current version of Chrome, Edge or Safari.');
  const video = project.video;
  if (!video || (!video.clips.length && !video.texts.length)) throw new Error('Add a video clip or some text first.');
  const report = (f: number, stage: string) => opts.onProgress?.(f, stage);
  const stop = () => { if (opts.cancelled?.()) throw new Error('Export cancelled.'); };

  const [width, height] = frameSize(video.aspect, opts.short);
  const fps = opts.fps;
  const songEnd = beatsToSec(projectEndBeats(project), project.bpm);
  const pictureEnd = Math.max(0, ...video.clips.map((c) => c.start + c.length), ...video.texts.map((t) => t.start + t.length));
  const duration = Math.min(MAX_SONG_SECONDS, Math.max(pictureEnd, songEnd));
  const frames = Math.max(1, Math.round(duration * fps));
  const bitrate = opts.short === 1080 ? 8_000_000 : 4_500_000;

  const vCodec = await pickVideoCodec(width, height, fps, bitrate);
  const aCodec = songEnd > 0.05 ? await pickAudioCodec() : null;

  // ---- the song, mixed offline exactly as the audio export does it ----
  let pcm: Float32Array[] | null = null;
  if (aCodec) {
    report(0, 'Mixing the song…');
    const mix = await renderProject(project, engine.buffers, { sampleRate: aCodec.sampleRate });
    const n = Math.min(mix.length, Math.round(duration * aCodec.sampleRate));
    pcm = [0, 1].map((c) => mix.getChannelData(Math.min(c, mix.numberOfChannels - 1)).slice(0, n));
    limitPeaks({ channels: pcm, sampleRate: aCodec.sampleRate }, -1);
  }
  stop();

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: vCodec.mux, width, height, frameRate: fps },
    ...(aCodec && pcm ? { audio: { codec: aCodec.mux, numberOfChannels: 2, sampleRate: aCodec.sampleRate } } : {}),
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  let failure: Error | null = null;
  const fail = (e: unknown) => { failure = e instanceof Error ? e : new Error(String(e)); };
  const videoEncoder = new W.VideoEncoder({ output: (chunk: unknown, meta: unknown) => muxer.addVideoChunk(chunk as never, meta as never), error: fail });
  videoEncoder.configure({ codec: vCodec.codec, width, height, bitrate, framerate: fps });

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const comp = new Compositor(canvas);
  try {
    for (let i = 0; i < frames; i++) {
      stop();
      if (failure) throw failure;
      const t = i / fps;
      await comp.prepare(video, t);
      comp.render(video, t);
      const frame = new W.VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      videoEncoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      // do not let frames pile up faster than the encoder takes them
      while (videoEncoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 4));
      if (i % 5 === 0) { report(0.02 + 0.9 * (i / frames), `Encoding picture: frame ${i + 1} of ${frames}`); await new Promise((r) => setTimeout(r, 0)); }
    }
    await videoEncoder.flush();
    if (failure) throw failure;

    if (aCodec && pcm) {
      report(0.93, 'Encoding sound…');
      const audioEncoder = new W.AudioEncoder({ output: (chunk: unknown, meta: unknown) => muxer.addAudioChunk(chunk as never, meta as never), error: fail });
      audioEncoder.configure({ codec: aCodec.codec, sampleRate: aCodec.sampleRate, numberOfChannels: 2, bitrate: 192000 });
      const block = 4096, n = pcm[0].length;
      for (let o = 0; o < n; o += block) {
        const len = Math.min(block, n - o);
        const planar = new Float32Array(len * 2);
        planar.set(pcm[0].subarray(o, o + len), 0);
        planar.set(pcm[1].subarray(o, o + len), len);
        const data = new W.AudioData({ format: 'f32-planar', sampleRate: aCodec.sampleRate, numberOfFrames: len, numberOfChannels: 2, timestamp: Math.round((o * 1e6) / aCodec.sampleRate), data: planar });
        audioEncoder.encode(data);
        data.close();
        if ((o / block) % 64 === 0) { stop(); await new Promise((r) => setTimeout(r, 0)); }
      }
      await audioEncoder.flush();
      audioEncoder.close();
      if (failure) throw failure;
    }
    videoEncoder.close();
    muxer.finalize();
    report(1, 'Done');
    return { blob: new Blob([target.buffer], { type: 'video/mp4' }), width, height, fps, duration, videoCodec: vCodec.mux === 'avc' ? 'H.264' : 'VP9', audioCodec: aCodec && pcm ? (aCodec.mux === 'aac' ? 'AAC' : 'Opus') : null };
  } finally {
    comp.dispose();
    if (videoEncoder.state !== 'closed') { try { videoEncoder.close(); } catch { /* already closed */ } }
  }
}
