import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, Scissors, Trash2, Type, Upload, ZoomIn, ZoomOut } from 'lucide-react';
import { engine } from '../audio/engine';
import type { AssetMeta, TextOverlay, VideoAspect, VideoClip } from '../types';
import { beatsToSec, clamp, clipLengthBeats, formatTime, projectEndBeats, secToBeats } from '../lib/music';
import { fitCanvas } from '../lib/peaks';
import { downloadBlob, safeName } from '../lib/wav';
import { A, beginGesture, endGesture, importVideo, setUI, toast, useStore, videoEnd } from '../store/store';
import { canExportMp4, exportMp4, type Mp4Result } from '../video/export';
import { Compositor, frameSize, thumbnails } from '../video/video';
import { TransportBar } from '../components/TransportBar';
import { Dialog, Hint, Slider, useFrame } from '../components/ui';

// Video mode: lay video clips and titles against the song, preview them in sync
// with the studio's transport, and export an MP4 with the mixed song as its sound.

const LANE = { ruler: 24, video: 64, text: 30, song: 54 };
const now = (): number => { const s = useStore.getState(); return beatsToSec(engine.beat, s.project.bpm); };

function Preview({ aspect, empty }: { aspect: VideoAspect; empty: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const comp = useRef<Compositor | null>(null);
  const [w, h] = frameSize(aspect, 720);
  useEffect(() => {
    comp.current = new Compositor(canvas.current!);
    return () => comp.current?.dispose();
  }, []);
  useFrame(() => {
    const s = useStore.getState();
    comp.current?.draw(s.project.video, beatsToSec(engine.beat, s.project.bpm), engine.playing);
  });
  return (
    <div className="video-preview">
      <canvas ref={canvas} width={w} height={h} className="video-canvas" style={{ aspectRatio: `${w} / ${h}` }} role="img" aria-label="Video preview" />
      {empty && (
        <div className="video-empty">
          <p style={{ fontWeight: 600, fontSize: 16 }}>No video yet</p>
          <p className="muted">Import a clip and it will play here in step with your song.</p>
        </div>
      )}
    </div>
  );
}

/** Stills from the source video across the clip, with fades drawn as wedges. */
function ClipStrip({ clip, asset, pps }: { clip: VideoClip; asset: AssetMeta | undefined; pps: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const width = Math.min(6000, Math.max(8, clip.length * pps));
  useEffect(() => {
    let live = true;
    const paint = (thumbs: { time: number; image: HTMLCanvasElement }[]) => {
      const cv = canvas.current;
      if (!live || !cv) return;
      const H = LANE.video - 6;
      const ctx = fitCanvas(cv, width, H);
      ctx.fillStyle = '#1b1b1e';
      ctx.fillRect(0, 0, width, H);
      const tw = (H * 16) / 9;
      for (let x = 0; x < width; x += tw) {
        const t = clip.offset + (x + tw / 2) / pps;
        let best = thumbs[0];
        for (const th of thumbs) if (!best || Math.abs(th.time - t) < Math.abs(best.time - t)) best = th;
        if (best) ctx.drawImage(best.image, x, 0, tw, H);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      if (clip.fadeIn > 0) { ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(clip.fadeIn * pps, 0); ctx.lineTo(0, H); ctx.fill(); }
      if (clip.fadeOut > 0) { ctx.beginPath(); ctx.moveTo(width, 0); ctx.lineTo(width - clip.fadeOut * pps, 0); ctx.lineTo(width, H); ctx.fill(); }
    };
    paint([]);
    if (asset) thumbnails(asset.id, asset.duration).then(paint, () => {});
    return () => { live = false; };
  }, [clip.offset, clip.length, clip.fadeIn, clip.fadeOut, pps, asset, width]);
  return <canvas ref={canvas} style={{ position: 'absolute', inset: 0, borderRadius: 5, pointerEvents: 'none' }} />;
}

/** Start a horizontal drag on an element; `move` gets the distance in pixels. */
function dragX(e: React.PointerEvent, move: (dx: number) => void): void {
  e.stopPropagation();
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  const x0 = e.clientX;
  beginGesture();
  const onMove = (ev: PointerEvent) => move(ev.clientX - x0);
  const onUp = () => { el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onUp); endGesture(); };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
}

function Timeline({ pps }: { pps: number }) {
  const project = useStore((s) => s.project);
  const sel = useStore((s) => s.ui.videoSel);
  const video = project.video;
  const scroller = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const song = useRef<HTMLCanvasElement>(null);
  const songEnd = beatsToSec(projectEndBeats(project), project.bpm);
  const total = clamp(Math.max(videoEnd(video), songEnd) + 10, 30, 300);
  const width = total * pps;

  useFrame(() => {
    const t = now();
    if (head.current) head.current.style.transform = `translateX(${t * pps}px)`;
    const sc = scroller.current;
    if (sc && engine.playing) {
      const x = t * pps - sc.scrollLeft;
      if (x > sc.clientWidth - 30 || x < 0) sc.scrollLeft = Math.max(0, t * pps - 60);
    }
  });

  // the song underneath, so cuts can be placed against the music
  useEffect(() => {
    const cv = song.current;
    if (!cv) return;
    const W = Math.min(16000, width), H = LANE.song;
    const ctx = fitCanvas(cv, W, H);
    ctx.clearRect(0, 0, W, H);
    const rows = Math.max(3, project.tracks.length);
    const rh = (H - 8) / rows;
    project.tracks.forEach((t, i) => {
      ctx.fillStyle = t.color;
      ctx.globalAlpha = t.mute ? 0.25 : 0.75;
      for (const c of project.clips) {
        if (c.trackId !== t.id) continue;
        const x = beatsToSec(c.start, project.bpm) * pps, w = beatsToSec(clipLengthBeats(c, project.bpm), project.bpm) * pps;
        ctx.fillRect(x, 4 + i * rh, Math.max(2, w - 1), Math.max(1.5, rh - 1.5));
      }
    });
    ctx.globalAlpha = 1;
  }, [project.clips, project.tracks, project.bpm, pps, width]);

  const seekTo = (clientX: number) => {
    const sc = scroller.current!;
    A.seek(secToBeats(clamp((clientX - sc.getBoundingClientRect().left + sc.scrollLeft) / pps, 0, total), project.bpm));
  };
  const scrub = (e: React.PointerEvent) => {
    setUI({ videoSel: null });
    seekTo(e.clientX);
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => seekTo(ev.clientX);
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  /** Snap a clip's start so that either of its edges meets the playhead or another clip's edge. */
  const snap = (id: string, start: number, length: number): number => {
    const edges = [0, now()];
    for (const c of video?.clips ?? []) if (c.id !== id) edges.push(c.start, c.start + c.length);
    for (const e of edges) {
      if (Math.abs(start - e) * pps < 7) return e;
      if (Math.abs(start + length - e) * pps < 7) return Math.max(0, e - length);
    }
    return Math.max(0, Math.round(start * 100) / 100);
  };

  const step = [1, 2, 5, 10, 15, 30, 60].find((s) => s * pps >= 64) ?? 60;
  const ticks = Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => i * step);
  const assetOf = (c: VideoClip) => project.assets.find((a) => a.id === c.assetId);

  return (
    <div className="vt">
      <div className="vt-labels">
        <div style={{ height: LANE.ruler }} />
        <div style={{ height: LANE.video }}>Video</div>
        <div style={{ height: LANE.text }}>Text</div>
        <div style={{ height: LANE.song }}>Song</div>
      </div>
      <div className="vt-scroll" ref={scroller}>
        <div style={{ width, position: 'relative', height: LANE.ruler + LANE.video + LANE.text + LANE.song }}>
          <div className="vt-ruler" style={{ height: LANE.ruler }} onPointerDown={scrub}>
            {ticks.map((t) => <span key={t} className="num" style={{ left: t * pps }}>{formatTime(t, false)}</span>)}
          </div>
          <div className="vt-lane" style={{ top: LANE.ruler, height: LANE.video }} onPointerDown={scrub}>
            {(video?.clips ?? []).map((c) => {
              const asset = assetOf(c);
              return (
                <div
                  key={c.id} className={`vclip ${sel === c.id ? 'sel' : ''}`} style={{ left: c.start * pps, width: Math.max(8, c.length * pps) }}
                  title={`${asset?.name ?? 'Video'} · ${c.length.toFixed(1)} s`}
                  onPointerDown={(e) => { setUI({ videoSel: c.id }); const base = { ...c }; dragX(e, (dx) => A.updateVideoClip(c.id, { start: snap(c.id, base.start + dx / pps, base.length) }, true)); }}
                >
                  <ClipStrip clip={c} asset={asset} pps={pps} />
                  <span className="vclip-name">{asset?.name ?? 'Video'}</span>
                  <i className="vhandle l" onPointerDown={(e) => {
                    setUI({ videoSel: c.id });
                    const base = { ...c };
                    dragX(e, (dx) => {
                      const start = clamp(base.start + dx / pps, Math.max(0, base.start - base.offset), base.start + base.length - 0.1);
                      A.updateVideoClip(c.id, { start, offset: base.offset + (start - base.start), length: base.length - (start - base.start) }, true);
                    });
                  }} />
                  <i className="vhandle r" onPointerDown={(e) => {
                    setUI({ videoSel: c.id });
                    const base = { ...c };
                    dragX(e, (dx) => A.updateVideoClip(c.id, { length: clamp(base.length + dx / pps, 0.1, (asset?.duration ?? base.offset + base.length) - base.offset) }, true));
                  }} />
                </div>
              );
            })}
          </div>
          <div className="vt-lane" style={{ top: LANE.ruler + LANE.video, height: LANE.text }} onPointerDown={scrub}>
            {(video?.texts ?? []).map((o) => (
              <div
                key={o.id} className={`vtext ${sel === o.id ? 'sel' : ''}`} style={{ left: o.start * pps, width: Math.max(10, o.length * pps) }}
                onPointerDown={(e) => { setUI({ videoSel: o.id }); const base = { ...o }; dragX(e, (dx) => A.updateText(o.id, { start: Math.max(0, Math.round((base.start + dx / pps) * 100) / 100) }, true)); }}
              >
                <span>{o.text.split('\n')[0] || 'Text'}</span>
                <i className="vhandle r" onPointerDown={(e) => { setUI({ videoSel: o.id }); const base = { ...o }; dragX(e, (dx) => A.updateText(o.id, { length: Math.max(0.3, base.length + dx / pps) }, true)); }} />
              </div>
            ))}
          </div>
          <div className="vt-lane" style={{ top: LANE.ruler + LANE.video + LANE.text, height: LANE.song }} onPointerDown={scrub}>
            <canvas ref={song} style={{ pointerEvents: 'none' }} />
          </div>
          <div ref={head} className="playhead" />
        </div>
      </div>
    </div>
  );
}

function Inspector() {
  const sel = useStore((s) => s.ui.videoSel);
  const clip = useStore((s) => s.project.video?.clips.find((c) => c.id === sel));
  const text = useStore((s) => s.project.video?.texts.find((t) => t.id === sel));
  const asset = useStore((s) => s.project.assets.find((a) => a.id === clip?.assetId));
  if (clip) {
    const maxFade = Math.min(3, clip.length / 2);
    return (
      <div className="col" style={{ gap: 12 }}>
        <div>
          <div style={{ fontWeight: 600 }}>{asset?.name ?? 'Video clip'}</div>
          <div className="faint num" style={{ fontSize: 12 }}>
            At {formatTime(clip.start)} · {clip.length.toFixed(2)} s of {(asset?.duration ?? clip.length).toFixed(2)} s · {asset?.width}×{asset?.height}
          </div>
        </div>
        <div className="fx-param"><span>Fade in</span><Slider label="Fade in" min={0} max={maxFade} step={0.05} value={Math.min(clip.fadeIn, maxFade)} reset={0} onChange={(v) => A.updateVideoClip(clip.id, { fadeIn: v }, true)} /><output className="num">{clip.fadeIn.toFixed(2)} s</output></div>
        <div className="fx-param"><span>Fade out</span><Slider label="Fade out" min={0} max={maxFade} step={0.05} value={Math.min(clip.fadeOut, maxFade)} reset={0} onChange={(v) => A.updateVideoClip(clip.id, { fadeOut: v }, true)} /><output className="num">{clip.fadeOut.toFixed(2)} s</output></div>
        <Hint>A fade starts or ends on black. For a dissolve, overlap two clips and give the later one a fade in.</Hint>
        <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => void A.useVideoSound(clip.id)}>Add this clip’s sound to the song</button>
        <Hint>Video plays silently here. This puts its soundtrack on an audio track in the studio, lined up with the picture, where you can mix or mute it.</Hint>
      </div>
    );
  }
  if (text) {
    const set = (patch: Partial<TextOverlay>, live = true) => A.updateText(text.id, patch, live);
    return (
      <div className="col" style={{ gap: 12 }}>
        <label className="field"><span>Text</span>
          <textarea className="input" style={{ height: 72, padding: '8px 10px', resize: 'vertical' }} value={text.text} onFocus={beginGesture} onBlur={endGesture} onChange={(e) => set({ text: e.target.value })} />
        </label>
        <div className="fx-param"><span>Size</span><Slider label="Text size" min={0.03} max={0.3} step={0.005} value={text.size} reset={0.08} onChange={(v) => set({ size: v })} /><output className="num">{Math.round(text.size * 100)}%</output></div>
        <div className="fx-param"><span>Across</span><Slider label="Horizontal position" min={0} max={1} step={0.01} value={text.x} reset={0.5} onChange={(v) => set({ x: v })} /><output className="num">{Math.round(text.x * 100)}%</output></div>
        <div className="fx-param"><span>Down</span><Slider label="Vertical position" min={0} max={1} step={0.01} value={text.y} reset={0.82} onChange={(v) => set({ y: v })} /><output className="num">{Math.round(text.y * 100)}%</output></div>
        <div className="fx-param"><span>Shown for</span><Slider label="Duration" min={0.3} max={30} step={0.1} value={text.length} reset={3} onChange={(v) => set({ length: v })} /><output className="num">{text.length.toFixed(1)} s</output></div>
        <label className="t-field">Colour <input type="color" value={text.color} aria-label="Text colour" onChange={(e) => set({ color: e.target.value }, false)} style={{ width: 40, height: 28, border: 0, background: 'none', padding: 0 }} /></label>
        <span className="faint num" style={{ fontSize: 12 }}>Appears at {formatTime(text.start)}. Drag it on the Text lane to move it.</span>
      </div>
    );
  }
  return (
    <div className="col" style={{ gap: 10 }}>
      <div style={{ fontWeight: 600 }}>Nothing selected</div>
      <p className="hint">Click a video clip or a title on the timeline to change it here.</p>
      <p className="hint">Drag a clip to move it, drag its ends to trim, and use Split to cut at the playhead. The Song lane shows your music so cuts can land on the beat.</p>
      <p className="hint">Press Space to play. The picture follows the same transport as the studio.</p>
    </div>
  );
}

function ExportVideo({ onClose }: { onClose: () => void }) {
  const [short, setShort] = useState<720 | 1080>(720);
  const [fps, setFps] = useState<24 | 30>(30);
  const [busy, setBusy] = useState<{ fraction: number; stage: string } | null>(null);
  const [result, setResult] = useState<Mp4Result | null>(null);
  const [error, setError] = useState('');
  const cancel = useRef(false);
  const name = useStore((s) => s.project.name);
  const aspect = useStore((s) => s.project.video?.aspect ?? '16:9');
  const [w, h] = frameSize(aspect, short);
  const supported = canExportMp4();

  const run = async () => {
    setError(''); setResult(null);
    cancel.current = false;
    A.stop();
    setBusy({ fraction: 0, stage: 'Starting…' });
    try {
      const r = await exportMp4(useStore.getState().project, { short, fps, onProgress: (fraction, stage) => setBusy({ fraction, stage }), cancelled: () => cancel.current });
      setResult(r);
      downloadBlob(r.blob, `${safeName(name)}.mp4`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The export failed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog title="Export video" onClose={() => { if (!busy) onClose(); }}>
      <div className="col" style={{ gap: 16, marginTop: 14 }}>
        <p className="hint">Writes an MP4 of the picture and titles with your song (the full studio mix) as the sound. Every frame is rendered exactly, so it takes about as long as the video itself.</p>
        {!supported && <div className="error-box">MP4 export needs a browser with WebCodecs: a current Chrome, Edge or Safari.</div>}
        <div className="row wrap" style={{ gap: 16 }}>
          <label className="field"><span>Size</span>
            <select className="select" value={short} onChange={(e) => setShort(Number(e.target.value) as 720 | 1080)}>
              <option value={720}>HD ({frameSize(aspect, 720).join(' × ')})</option>
              <option value={1080}>Full HD ({frameSize(aspect, 1080).join(' × ')})</option>
            </select>
          </label>
          <label className="field"><span>Frames per second</span>
            <select className="select" value={fps} onChange={(e) => setFps(Number(e.target.value) as 24 | 30)}>
              <option value={30}>30</option>
              <option value={24}>24</option>
            </select>
          </label>
        </div>
        {error && <div className="error-box" role="alert">{error}</div>}
        {busy && (
          <div className="col" role="status">
            <div className="row"><LoaderCircle className="spin" style={{ width: 16, height: 16 }} /><span>{busy.stage}</span></div>
            <div className="progress"><i style={{ width: `${Math.round(busy.fraction * 100)}%` }} /></div>
          </div>
        )}
        {result && (
          <div className="well col" style={{ gap: 10 }}>
            <div className="stat-strip">
              <div><b className="num">{formatTime(result.duration, false)}</b><span>length</span></div>
              <div><b className="num">{result.width}×{result.height}</b><span>{result.fps} fps</span></div>
              <div><b className="num">{(result.blob.size / 1048576).toFixed(1)}</b><span>MB</span></div>
              <div><b>{result.videoCodec}</b><span>{result.audioCodec ? `${result.audioCodec} sound` : 'no sound'}</span></div>
            </div>
            {(result.videoCodec !== 'H.264' || result.audioCodec === 'Opus') && <div className="notice">This browser could not encode H.264 with AAC, so the file uses {result.videoCodec}{result.audioCodec ? ` and ${result.audioCodec}` : ''}. It plays in browsers and VLC but may not open in every player.</div>}
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => downloadBlob(result.blob, `${safeName(name)}.mp4`)}><Download />Download again</button>
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {busy ? <button className="btn" onClick={() => { cancel.current = true; }}>Cancel</button> : <button className="btn ghost" onClick={onClose}>Close</button>}
          <button className="btn primary" disabled={!!busy || !supported} onClick={() => void run()}><Download />Export {w} × {h}</button>
        </div>
      </div>
    </Dialog>
  );
}

export function Video() {
  const video = useStore((s) => s.project.video);
  const sel = useStore((s) => s.ui.videoSel);
  const [pps, setPps] = useState(40);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const aspect = video?.aspect ?? '16:9';
  const empty = !video || (!video.clips.length && !video.texts.length);

  const add = async (files: File[]) => {
    setImporting(true);
    try {
      for (const f of files) {
        if (f.size > 600 * 1024 * 1024) { toast(`${f.name} is larger than 600 MB.`, 'error'); continue; }
        try {
          const meta = await importVideo(f, f.name);
          const at = videoEnd(useStore.getState().project.video && { ...useStore.getState().project.video!, texts: [] });
          A.addVideoClip(meta, at);
        } catch (e) {
          toast(e instanceof Error ? e.message : `Could not import ${f.name}.`, 'error');
        }
      }
    } finally {
      setImporting(false);
    }
  };
  const split = () => {
    const v = useStore.getState().project.video;
    const t = now();
    const target = v?.clips.find((c) => c.id === sel && t > c.start && t < c.start + c.length) ?? v?.clips.find((c) => t > c.start + 0.05 && t < c.start + c.length - 0.05);
    if (target) A.splitVideoClip(target.id, t);
    else toast('Move the playhead over a video clip to split it.', 'info');
  };

  return (
    <>
      <TransportBar />
      <div className="workspace">
        <div className="stage">
          <div className="toolbar" role="toolbar" aria-label="Video tools">
            <button className="btn sm" disabled={importing} onClick={() => fileInput.current?.click()}>{importing ? <LoaderCircle className="spin" /> : <Upload />}Import video</button>
            <input ref={fileInput} type="file" accept="video/*,.mp4,.mov,.webm,.m4v" multiple hidden onChange={(e) => { void add([...(e.target.files ?? [])]); e.target.value = ''; }} />
            <button className="btn sm" onClick={() => A.addText(now())}><Type />Add text</button>
            <div className="t-div" />
            <button className="icon-btn" title="Split the clip at the playhead (S)" aria-label="Split at playhead" onClick={split}><Scissors /></button>
            <button className="icon-btn" title="Delete the selected clip or text (Delete)" aria-label="Delete" disabled={!sel} onClick={() => sel && A.removeVideoItem(sel)}><Trash2 /></button>
            <div className="t-div" />
            <label className="t-field">Frame
              <select className="select" aria-label="Frame shape" value={aspect} onChange={(e) => A.setVideoAspect(e.target.value as VideoAspect)}>
                <option value="16:9">Wide 16:9</option>
                <option value="9:16">Tall 9:16</option>
                <option value="1:1">Square 1:1</option>
              </select>
            </label>
            <div className="grow" />
            <button className="icon-btn" title="Zoom out" aria-label="Zoom out" onClick={() => setPps((p) => Math.max(4, p / 1.5))}><ZoomOut /></button>
            <button className="icon-btn" title="Zoom in" aria-label="Zoom in" onClick={() => setPps((p) => Math.min(400, p * 1.5))}><ZoomIn /></button>
            <button className="btn sm" disabled={empty} onClick={() => setExporting(true)}><Download />Export MP4</button>
          </div>
          <div className="video-main">
            <Preview key={aspect} aspect={aspect} empty={empty} />
            <aside className="video-side" aria-label="Selected item"><Inspector /></aside>
          </div>
          <Timeline pps={pps} />
        </div>
      </div>
      {exporting && <ExportVideo onClose={() => setExporting(false)} />}
    </>
  );
}
