import type { ID, TextOverlay, VideoAspect, VideoClip, VideoState } from '../types';

// Video playback for the video mode: a registry of imported files, thumbnail
// strips, and a compositor that draws the frame for any moment of the song
// (clips with fades and dissolves, then text overlays) onto a canvas. The same
// compositor drives the live preview and the frame-by-frame MP4 export.

const urls = new Map<ID, string>();

export function registerVideo(id: ID, blob: Blob): void {
  if (!urls.has(id)) urls.set(id, URL.createObjectURL(blob));
}
export const hasVideo = (id: ID): boolean => urls.has(id);

function makeElement(assetId: ID): HTMLVideoElement {
  const el = document.createElement('video');
  el.muted = true; // the picture only: sound goes through the studio's mixer
  el.playsInline = true;
  el.preload = 'auto';
  el.src = urls.get(assetId) ?? '';
  return el;
}

/** Jump a video element to a time and wait until that frame can be drawn. */
function seek(el: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(el.currentTime - t) < 0.001 && el.readyState >= 2) { resolve(); return; }
    let timer = 0;
    const done = () => { el.removeEventListener('seeked', done); window.clearTimeout(timer); resolve(); };
    timer = window.setTimeout(done, 4000);
    el.addEventListener('seeked', done);
    el.currentTime = t;
  });
}

const whenLoaded = (el: HTMLVideoElement): Promise<void> =>
  new Promise((resolve) => {
    if (el.readyState >= 2) { resolve(); return; }
    const timer = window.setTimeout(resolve, 6000);
    el.addEventListener('loadeddata', () => { window.clearTimeout(timer); resolve(); }, { once: true });
  });

export function probeVideo(blob: Blob): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('video');
    const url = URL.createObjectURL(blob);
    const fail = () => { URL.revokeObjectURL(url); reject(new Error('The browser cannot play this video. Try MP4 (H.264) or WebM.')); };
    const finish = () => {
      const info = { duration: el.duration, width: el.videoWidth, height: el.videoHeight };
      URL.revokeObjectURL(url);
      if (!Number.isFinite(info.duration) || info.duration <= 0 || !info.width) reject(new Error('This file has no readable video track.'));
      else resolve(info);
    };
    el.preload = 'metadata';
    el.muted = true;
    el.onerror = fail;
    el.onloadedmetadata = () => {
      if (Number.isFinite(el.duration)) { finish(); return; }
      // some recorded WebM files only report their length after a seek to the end
      el.ondurationchange = () => { if (Number.isFinite(el.duration)) finish(); };
      el.currentTime = 1e7;
      window.setTimeout(() => (Number.isFinite(el.duration) ? undefined : fail()), 5000);
    };
    el.src = url;
  });
}

export interface Thumb { time: number; image: HTMLCanvasElement }
const thumbCache = new Map<ID, Promise<Thumb[]>>();

/** A strip of small stills across a video, made once per file. */
export function thumbnails(assetId: ID, duration: number): Promise<Thumb[]> {
  let p = thumbCache.get(assetId);
  if (!p) {
    p = (async () => {
      const el = makeElement(assetId);
      await whenLoaded(el);
      const count = Math.max(4, Math.min(30, Math.ceil(duration / 2)));
      const out: Thumb[] = [];
      for (let i = 0; i < count; i++) {
        const time = ((i + 0.5) * duration) / count;
        await seek(el, time);
        const image = document.createElement('canvas');
        image.width = 160;
        image.height = 90;
        const ctx = image.getContext('2d')!;
        const scale = Math.max(160 / (el.videoWidth || 160), 90 / (el.videoHeight || 90));
        const w = (el.videoWidth || 160) * scale, h = (el.videoHeight || 90) * scale;
        ctx.drawImage(el, (160 - w) / 2, (90 - h) / 2, w, h);
        out.push({ time, image });
      }
      el.removeAttribute('src');
      el.load();
      return out;
    })();
    thumbCache.set(assetId, p);
    p.catch(() => thumbCache.delete(assetId));
  }
  return p;
}

export const frameSize = (aspect: VideoAspect, short: number): [number, number] =>
  aspect === '16:9' ? [Math.round((short * 16) / 9 / 2) * 2, short] : aspect === '9:16' ? [short, Math.round((short * 16) / 9 / 2) * 2] : [short, short];

const clipAlpha = (c: VideoClip, t: number): number => {
  const a = c.fadeIn > 0 ? Math.min(1, (t - c.start) / c.fadeIn) : 1;
  const b = c.fadeOut > 0 ? Math.min(1, (c.start + c.length - t) / c.fadeOut) : 1;
  return Math.max(0, Math.min(a, b));
};

function drawText(ctx: CanvasRenderingContext2D, W: number, H: number, o: TextOverlay, t: number): void {
  const edge = Math.min(0.25, o.length / 3);
  const alpha = Math.max(0, Math.min(1, (t - o.start) / edge, (o.start + o.length - t) / edge));
  if (alpha <= 0 || !o.text.trim()) return;
  const px = Math.max(8, o.size * H);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `600 ${px}px "Inter Variable", Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = px * 0.2;
  ctx.shadowOffsetY = px * 0.04;
  ctx.fillStyle = o.color;
  const lines = o.text.split('\n');
  lines.forEach((line, i) => ctx.fillText(line, o.x * W, o.y * H + (i - (lines.length - 1) / 2) * px * 1.2, W * 0.96));
  ctx.restore();
}

export class Compositor {
  private els = new Map<ID, HTMLVideoElement>();

  constructor(private canvas: HTMLCanvasElement) {}

  private element(c: VideoClip): HTMLVideoElement {
    let el = this.els.get(c.id);
    if (!el) { el = makeElement(c.assetId); this.els.set(c.id, el); }
    return el;
  }

  private active(video: VideoState, t: number): VideoClip[] {
    return video.clips.filter((c) => t >= c.start && t < c.start + c.length).sort((a, b) => a.start - b.start);
  }

  /** Paint the frame for time `t` from whatever each video element currently shows. */
  render(video: VideoState | undefined, t: number): void {
    const { canvas } = this;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width, H = canvas.height;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (!video) return;
    for (const c of this.active(video, t)) {
      const el = this.element(c);
      if (el.readyState < 2 || !el.videoWidth) continue;
      // fit the whole picture inside the frame; a later clip fading in over an earlier one is a dissolve
      const scale = Math.min(W / el.videoWidth, H / el.videoHeight);
      const w = el.videoWidth * scale, h = el.videoHeight * scale;
      ctx.globalAlpha = clipAlpha(c, t);
      ctx.drawImage(el, (W - w) / 2, (H - h) / 2, w, h);
    }
    ctx.globalAlpha = 1;
    for (const o of video.texts) if (t >= o.start && t < o.start + o.length) drawText(ctx, W, H, o, t);
  }

  /** Live preview: keep the video elements in step with the transport, then paint. */
  draw(video: VideoState | undefined, t: number, playing: boolean): void {
    if (video) {
      const active = new Set(this.active(video, t).map((c) => c.id));
      const known = new Set(video.clips.map((c) => c.id));
      for (const [id, el] of this.els) {
        if (!known.has(id)) { el.pause(); el.removeAttribute('src'); el.load(); this.els.delete(id); }
        else if (!active.has(id) && !el.paused) el.pause();
      }
      for (const c of video.clips) {
        if (!active.has(c.id)) continue;
        const el = this.element(c);
        const want = c.offset + (t - c.start);
        if (playing) {
          if (el.paused) { el.currentTime = want; void el.play().catch(() => {}); }
          else if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = want; // drifted: pull it back
        } else {
          if (!el.paused) el.pause();
          if (!el.seeking && Math.abs(el.currentTime - want) > 0.02) el.currentTime = want;
        }
      }
    }
    this.render(video, t);
  }

  /** Export: put every clip that is on screen at `t` exactly on its frame, and wait for it. */
  async prepare(video: VideoState | undefined, t: number): Promise<void> {
    if (!video) return;
    await Promise.all(this.active(video, t).map(async (c) => {
      const el = this.element(c);
      el.pause();
      await whenLoaded(el);
      await seek(el, Math.min(c.offset + (t - c.start), Math.max(0, el.duration - 0.001)));
    }));
  }

  dispose(): void {
    for (const el of this.els.values()) { el.pause(); el.removeAttribute('src'); el.load(); }
    this.els.clear();
  }
}
