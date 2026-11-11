import { useEffect, useRef, useState } from 'react';
import { Grid3x3, Piano } from 'lucide-react';
import { STRETCH_MAX, STRETCH_MIN, detectClipTempo, originalRegion, processClip, type ProcessRequest, type ProcessResult } from '../audio/clipProcess';
import { engine } from '../audio/engine';
import type { AudioClip, MidiClip, Note } from '../types';
import type { TuneResult } from '../lib/dsp/tune';
import { drumSound, getInstrument, isDrums, kitPads } from '../lib/instruments';
import { NOTE_NAMES, SCALES, barBeats, clamp, formatTime, inScale, midiToName, snapValue, uid, type Key } from '../lib/music';
import { fitCanvas } from '../lib/peaks';
import { A, beginGesture, endGesture, useStore } from '../store/store';
import { PianoRoll } from './PianoRoll';
import { Hint, Slider, Switch, fmtDb, useFrame, useSize } from './ui';

// Connects the clip that is open for editing to the piano roll, the drum step grid
// or (for audio) the clip inspector.

const STEP = 0.25;

function StepSequencer({ clip, instrumentId }: { clip: MidiClip; instrumentId: string | null }) {
  const timeSig = useStore((s) => s.project.timeSig);
  const rows = kitPads(instrumentId);
  const steps = Math.min(512, Math.round(clip.length / STEP));
  const perBar = Math.round(barBeats(timeSig) / STEP);
  const perBeat = Math.round(4 / timeSig[1] / STEP);
  const now = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const paint = useRef<{ add: boolean; soft: boolean } | null>(null);
  const clipRef = useRef(clip);
  clipRef.current = clip;

  const noteAt = (pitch: number, step: number): Note | undefined =>
    clipRef.current.notes.find((n) => n.pitch === pitch && Math.abs(n.start - step * STEP) < 0.01);

  const apply = (pitch: number, step: number) => {
    const p = paint.current;
    if (!p) return;
    const existing = noteAt(pitch, step);
    if (p.add && !existing) {
      A.setNotes(clipRef.current.id, [...clipRef.current.notes, { id: uid(), pitch, start: step * STEP, duration: STEP, velocity: p.soft ? 0.5 : 0.85 }], true);
    } else if (!p.add && existing) {
      A.setNotes(clipRef.current.id, clipRef.current.notes.filter((n) => n.id !== existing.id), true);
    }
  };

  useEffect(() => {
    const up = () => { if (paint.current) { paint.current = null; endGesture(); } };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);

  useFrame(() => {
    const el = now.current, g = grid.current;
    if (!el || !g) return;
    const step = Math.floor((engine.beat - clipRef.current.start) / STEP);
    const cell = step >= 0 && step < steps && engine.playing ? g.querySelector<HTMLElement>(`[data-step="${step}"]`) : null;
    if (!cell) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.transform = `translateX(${cell.offsetLeft}px)`;
  });

  return (
    <div className="steps">
      <div ref={grid} className="steps-grid" style={{ gridTemplateColumns: `auto repeat(${steps}, 24px)`, position: 'relative' }}>
        <div ref={now} style={{ position: 'absolute', top: 14, bottom: 0, left: 0, width: 24, borderRadius: 4, boxShadow: 'inset 0 0 0 1.5px #fff', pointerEvents: 'none', display: 'none', zIndex: 2 }} />
        <div className="step-bar" />
        {Array.from({ length: steps }, (_, i) => (
          <div key={i} className="step-bar num" data-step={i} style={{ marginLeft: i % perBar === 0 && i ? 6 : 0 }}>{i % perBar === 0 ? i / perBar + 1 : ''}</div>
        ))}
        {rows.map((pitch) => (
          <div key={pitch} style={{ display: 'contents' }}>
            <button className="step-label" title="Click to hear this sound" onClick={() => engine.auditionTrack(clip.trackId, pitch, 0.9)}>{drumSound(pitch)?.name}</button>
            {Array.from({ length: steps }, (_, i) => {
              const n = clip.notes.find((x) => x.pitch === pitch && Math.abs(x.start - i * STEP) < 0.01);
              return (
                <button
                  key={i} aria-label={`${drumSound(pitch)?.name}, step ${i + 1}`} aria-pressed={!!n}
                  className={`step ${i % perBeat === 0 ? 'beat' : ''} ${n ? 'on' : ''} ${n && n.velocity < 0.65 ? 'soft' : ''}`}
                  style={{ marginLeft: i % perBar === 0 && i ? 6 : 0 }}
                  onPointerDown={(e) => {
                    e.currentTarget.releasePointerCapture?.(e.pointerId);
                    beginGesture();
                    paint.current = { add: !n, soft: e.shiftKey };
                    apply(pitch, i);
                    if (!n) engine.auditionTrack(clip.trackId, pitch, e.shiftKey ? 0.5 : 0.85);
                  }}
                  onPointerEnter={(e) => { if (e.buttons && paint.current) apply(pitch, i); }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <Hint>Click a square to add a hit, drag to paint a run, Shift-click for a softer hit. Each square is a sixteenth note.</Hint>
    </div>
  );
}

/** Before/after pitch of a corrected clip, drawn against the note grid. */
function PitchPlot({ result, musicKey }: { result: TuneResult; musicKey: Key | null }) {
  const [ref, size] = useSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || size.w < 20) return;
    const W = size.w, H = 132;
    const ctx = fitCanvas(cv, W, H);
    ctx.clearRect(0, 0, W, H);
    const { original, corrected } = result.curve;
    let lo = 127, hi = 0;
    for (let f = 0; f < original.length; f++) {
      if (original[f] <= 0) continue;
      lo = Math.min(lo, original[f], corrected[f]);
      hi = Math.max(hi, original[f], corrected[f]);
    }
    if (hi <= 0) { ctx.fillStyle = '#96969c'; ctx.font = '12px Inter Variable, system-ui, sans-serif'; ctx.fillText('No pitched sound was found in this clip.', 10, 24); return; }
    lo = Math.floor(lo - 1); hi = Math.ceil(hi + 1);
    const y = (m: number) => 6 + (1 - (m - lo) / (hi - lo)) * (H - 12);
    const every = hi - lo > 18 ? 12 : 1;
    ctx.font = '10px Inter Variable, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (let m = lo; m <= hi; m++) {
      if (every > 1 && m % 12 !== 0) continue;
      const allowed = !musicKey || inScale(m, musicKey);
      ctx.fillStyle = allowed ? '#2e2e33' : '#19191c';
      ctx.fillRect(34, Math.round(y(m)), W - 34, 1);
      if (allowed && (hi - lo <= 14 || m % 12 === 0)) { ctx.fillStyle = '#96969c'; ctx.fillText(midiToName(m), 4, y(m)); }
    }
    const line = (data: Float32Array, color: string, width: number) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
      let pen = false;
      for (let f = 0; f < data.length; f++) {
        const x = 34 + (f / Math.max(1, data.length - 1)) * (W - 38);
        if (original[f] <= 0) { pen = false; continue; }
        if (pen) ctx.lineTo(x, y(data[f])); else ctx.moveTo(x, y(data[f]));
        pen = true;
      }
      ctx.stroke();
    };
    line(original, '#77777e', 1.25);
    line(corrected, '#4fc3e8', 1.75);
  }, [result, musicKey, size.w]);
  return <div ref={ref} className="wave-box"><canvas ref={canvas} role="img" aria-label="Pitch before (grey) and after (blue) correction" /></div>;
}

/** One job at a time per clip: the two tools share this so they cannot run over each other. */
interface Job { tool: 'pitch' | 'stretch'; progress: number }
interface ToolProps { clip: AudioClip; job: Job | null; start: (tool: Job['tool'], req: ProcessRequest) => Promise<ProcessResult | null>; error: string }

function PitchTool({ clip, job, start, error }: ToolProps) {
  const key = useStore((s) => s.project.key);
  const advanced = useStore((s) => s.ui.mode === 'advanced');
  const applied = clip.proc?.tune;
  const [scale, setScale] = useState<'key' | 'any'>(applied && !applied.key ? 'any' : 'key');
  const [strength, setStrength] = useState(applied?.strength ?? 0.85);
  const [speed, setSpeed] = useState(applied?.speedMs ?? 40);
  const [transpose, setTranspose] = useState(applied?.transpose ?? 0);
  const [result, setResult] = useState<{ clipId: string; data: TuneResult; key: Key | null } | null>(null);
  const keyLabel = `${NOTE_NAMES[key.root]} ${SCALES[key.scale].name.toLowerCase()}`;
  const busy = job !== null;

  const run = async () => {
    const musicKey = scale === 'key' ? key : null;
    const done = await start('pitch', { tune: { key: musicKey, strength, speedMs: speed, transpose } });
    if (done?.tune) setResult({ clipId: clip.id, data: done.tune, key: musicKey });
  };
  const revert = async () => { await start('pitch', { tune: null }); setResult(null); };
  const shown = result && result.clipId === clip.id && applied ? result : null;

  return (
    <div className="col">
      <div className="row"><span style={{ fontWeight: 500 }}>Pitch correction</span>{applied && <span className="chip ok">Corrected</span>}</div>
      <Hint>Nudges a sung or played line onto the notes of the key without changing its timing. Use it on one voice or instrument at a time; chords and full mixes will not survive it.</Hint>
      <label className="field"><span>Snap to</span>
        <select className="select" value={scale} onChange={(e) => setScale(e.target.value as 'key' | 'any')}>
          <option value="key">The song’s key ({keyLabel})</option>
          <option value="any">The nearest semitone</option>
        </select>
      </label>
      <div className="fx-param"><span>Amount</span><Slider plain label="Correction amount" min={0} max={1} step={0.01} value={strength} reset={0.85} onChange={setStrength} /><output className="num">{Math.round(strength * 100)}%</output></div>
      <div className="fx-param"><span>Glide</span><Slider plain label="Glide time" min={0} max={200} step={5} value={speed} reset={40} onChange={setSpeed} /><output className="num">{speed} ms</output></div>
      {advanced && <div className="fx-param"><span>Transpose</span><Slider plain label="Transpose" min={-12} max={12} step={1} value={transpose} reset={0} onChange={setTranspose} /><output className="num">{transpose > 0 ? '+' : ''}{transpose} st</output></div>}
      <Hint>A short glide (0 to 20 ms) gives the hard “auto-tune” sound; 40 ms and up keeps slides and vibrato natural.</Hint>
      <div className="row wrap">
        <button className="btn" disabled={busy} onClick={() => void run()}>{job?.tool === 'pitch' ? 'Correcting…' : applied ? 'Correct again' : 'Correct pitch'}</button>
        {applied && <button className="btn ghost" disabled={busy} onClick={() => void revert()}>Remove correction</button>}
      </div>
      {job?.tool === 'pitch' && <div className="progress"><i style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>}
      {error && <div className="error-box" role="alert">{error}</div>}
      {shown && (
        <>
          <PitchPlot result={shown.data} musicKey={shown.key} />
          <span className="faint num" style={{ fontSize: 12 }}>
            Grey is the original pitch, blue the corrected one. Moved by {shown.data.meanCents.toFixed(0)} cents on average; {Math.round(shown.data.voicedRatio * 100)}% of the clip had a clear pitch.
          </span>
        </>
      )}
    </div>
  );
}

const FIT_BARS = [0.5, 1, 2, 4, 8, 16, 32];

/** Change a clip's length (and so its speed) without changing its pitch. */
function StretchTool({ clip, job, start, error }: ToolProps) {
  const bpm = useStore((s) => s.project.bpm);
  const timeSig = useStore((s) => s.project.timeSig);
  const applied = clip.proc?.stretch ?? 1;
  const [ratio, setRatio] = useState(applied);
  const [tempo, setTempo] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { setRatio(applied); setNote(''); }, [clip.id, applied]);
  const busy = job !== null;
  const original = originalRegion(clip).length;
  const barSec = (barBeats(timeSig) * 60) / bpm;
  const inRange = (r: number) => r >= STRETCH_MIN && r <= STRETCH_MAX;
  const speedPct = Math.round(100 / ratio);
  const bars = (original * ratio) / barSec;
  const changed = Math.abs(ratio - applied) > 0.004;
  const clipTempo = Number(tempo);
  const tempoRatio = clipTempo > 0 ? clipTempo / bpm : NaN;

  const detect = () => {
    const found = detectClipTempo(clip);
    if (found) { setTempo(String(Math.round(found * 10) / 10)); setNote(''); }
    else setNote('No steady beat was found in this clip. Type its tempo in if you know it.');
  };
  const matchSong = () => {
    if (!inRange(tempoRatio)) { setNote('That tempo is too far from the song’s to match.'); return; }
    setRatio(tempoRatio);
    setNote('');
  };

  return (
    <div className="col">
      <div className="row"><span style={{ fontWeight: 500 }}>Speed and length</span>{clip.proc?.stretch && <span className="chip ok">Stretched</span>}</div>
      <Hint>Makes the clip faster or slower without changing its pitch, so a loop or a take can be fitted to the song. Small changes sound cleanest; big ones turn grainy.</Hint>
      <div className="fx-param"><span>Speed</span>
        <Slider plain label="Clip speed" min={50} max={200} step={1} value={clamp(speedPct, 50, 200)} reset={100} onChange={(v) => setRatio(100 / v)} />
        <output className="num">{speedPct}%</output>
      </div>
      <span className="faint num" style={{ fontSize: 12 }}>
        {formatTime(original)} at normal speed → {formatTime(original * ratio)} ({bars.toFixed(Math.abs(bars - Math.round(bars)) < 0.005 ? 0 : 2)} bar{Math.abs(bars - 1) < 0.005 ? '' : 's'})
      </span>
      <label className="field"><span>Fit to a length</span>
        <select className="select" value="" onChange={(e) => { const b = Number(e.target.value); if (b) { setRatio((b * barSec) / original); setNote(''); } }}>
          <option value="">Choose a number of bars…</option>
          {FIT_BARS.map((b) => <option key={b} value={b} disabled={!inRange((b * barSec) / original)}>{b === 0.5 ? 'Half a bar' : `${b} bar${b === 1 ? '' : 's'}`}</option>)}
        </select>
      </label>
      <div className="field"><span>Match the song’s tempo ({bpm} BPM)</span>
        <div className="row" style={{ gap: 6 }}>
          <input className="input num" style={{ width: 92 }} inputMode="decimal" placeholder="Clip BPM" aria-label="Tempo the clip was recorded at" value={tempo} onChange={(e) => setTempo(e.target.value.replace(/[^0-9.]/g, ''))} />
          <button className="btn sm ghost" disabled={busy} onClick={detect} title="Estimate the clip’s tempo from its beats">Detect</button>
          <button className="btn sm ghost" disabled={!(clipTempo > 0)} onClick={matchSong}>Match</button>
        </div>
      </div>
      <div className="row wrap">
        <button className="btn" disabled={busy || !changed || !inRange(ratio)} onClick={() => void start('stretch', { stretch: ratio })}>{job?.tool === 'stretch' ? 'Stretching…' : 'Apply'}</button>
        {clip.proc?.stretch && <button className="btn ghost" disabled={busy} onClick={() => void start('stretch', { stretch: null })}>Back to normal speed</button>}
      </div>
      {job?.tool === 'stretch' && <div className="progress"><i style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>}
      {(note || error) && <div className="error-box" role="alert">{note || error}</div>}
    </div>
  );
}

function AudioInspector({ clip }: { clip: AudioClip }) {
  const asset = useStore((s) => s.project.assets.find((a) => a.id === clip.assetId));
  const autoCrossfade = useStore((s) => s.project.autoCrossfade !== false);
  const [name, setName] = useState(clip.name);
  const [job, setJob] = useState<Job | null>(null);
  const [failure, setFailure] = useState<{ tool: Job['tool']; text: string } | null>(null);
  useEffect(() => setName(clip.name), [clip.name]);
  useEffect(() => setFailure(null), [clip.id]);
  const maxFade = Math.max(0.01, clip.length);
  const source = originalRegion(clip);

  const start = async (tool: Job['tool'], req: ProcessRequest): Promise<ProcessResult | null> => {
    if (job) return null;
    setFailure(null);
    setJob({ tool, progress: 0 });
    try {
      return await processClip(clip.id, req, (progress) => setJob({ tool, progress }));
    } catch (e) {
      setFailure({ tool, text: e instanceof Error ? e.message : 'The clip could not be processed.' });
      return null;
    } finally {
      setJob(null);
    }
  };

  return (
    <div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 22, alignItems: 'start' }}>
      <div className="col">
        <label className="field"><span>Clip name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && A.updateClip(clip.id, { name: name.trim() })} />
        </label>
        <div className="faint num" style={{ fontSize: 12 }}>
          {formatTime(clip.length)} of {formatTime(asset?.duration ?? clip.length)} source · starts {formatTime(clip.offset)} in · {asset?.sampleRate ?? '—'} Hz, {asset?.channels === 1 ? 'mono' : 'stereo'}
          {clip.proc && ` · made from ${formatTime(source.length)} of the original`}
        </div>
        <label className="t-field"><Switch on={!!clip.muted} onChange={(v) => A.updateClip(clip.id, { muted: v })} label="Mute clip" />Mute this clip</label>
        <div className="fx-param"><span>Gain</span><Slider label="Clip gain" min={-24} max={12} step={0.5} value={clip.gain} reset={0} onChange={(v) => A.updateClip(clip.id, { gain: v }, true)} /><output className="num">{fmtDb(clip.gain)} dB</output></div>
        <div className="fx-param"><span>Fade in</span><Slider label="Fade in" min={0} max={Math.min(10, maxFade)} step={0.01} value={clip.fadeIn} reset={0} onChange={(v) => A.updateClip(clip.id, { fadeIn: Math.min(v, clip.length - clip.fadeOut) }, true)} /><output className="num">{clip.fadeIn.toFixed(2)} s</output></div>
        <div className="fx-param"><span>Fade out</span><Slider label="Fade out" min={0} max={Math.min(10, maxFade)} step={0.01} value={clip.fadeOut} reset={0} onChange={(v) => A.updateClip(clip.id, { fadeOut: Math.min(v, clip.length - clip.fadeIn) }, true)} /><output className="num">{clip.fadeOut.toFixed(2)} s</output></div>
        <Hint>{autoCrossfade
          ? 'Where two clips on a track overlap, one fades into the other automatically. Slide a clip over its neighbour to make the crossfade longer.'
          : 'Automatic crossfades are off (the toolbar button turns them back on), so overlapping clips simply play on top of each other.'}</Hint>
      </div>
      <PitchTool key={`p${clip.id}`} clip={clip} job={job} start={start} error={failure?.tool === 'pitch' ? failure.text : ''} />
      <StretchTool clip={clip} job={job} start={start} error={failure?.tool === 'stretch' ? failure.text : ''} />
    </div>
  );
}

export function ClipEditor({ emptyText, notesOnly }: { emptyText?: string; notesOnly?: boolean }) {
  const clip = useStore((s) => s.project.clips.find((c) => c.id === s.ui.editClipId));
  const selectedAudio = useStore((s) => {
    const c = s.project.clips.find((x) => x.id === s.ui.selectedClipIds[0]);
    return c?.type === 'audio' ? c : undefined;
  });
  const track = useStore((s) => s.project.tracks.find((t) => t.id === (clip ?? selectedAudio)?.trackId));
  const timeSig = useStore((s) => s.project.timeSig);
  const musicKey = useStore((s) => s.project.key);
  const snap = useStore((s) => s.ui.snap);
  const advanced = useStore((s) => s.ui.mode === 'advanced');
  const drums = isDrums(track?.instrumentId);
  const [view, setView] = useState<'steps' | 'roll'>('steps');

  if (!notesOnly && selectedAudio && (!clip || clip.trackId !== selectedAudio.trackId)) return <AudioInspector clip={selectedAudio} />;
  if (!clip || clip.type !== 'midi' || !track) {
    return <p className="hint" style={{ padding: 16 }}>{emptyText ?? 'Double-click a note clip on the timeline to edit its notes here, or select an audio clip to adjust its gain, fades, pitch and speed.'}</p>;
  }
  const def = getInstrument(track.instrumentId);
  const toggle = drums ? (
    <div className="seg" role="group" aria-label="Editor view">
      <button className={view === 'steps' ? 'on' : ''} onClick={() => setView('steps')}><Grid3x3 />Step grid</button>
      <button className={view === 'roll' ? 'on' : ''} onClick={() => setView('roll')}><Piano />Piano roll</button>
    </div>
  ) : null;

  if (drums && view === 'steps') {
    return (
      <div className="pianoroll">
        <div className="pr-tools">{toggle}<span className="faint" style={{ fontSize: 12 }}>{clip.name} · {clip.notes.length} hits</span></div>
        <div style={{ flex: 1, minHeight: 0 }}><StepSequencer clip={clip} instrumentId={track.instrumentId} /></div>
      </div>
    );
  }
  return (
    <PianoRoll
      viewKey={clip.id + (drums ? 'd' : '')}
      notes={clip.notes} length={clip.length} color={track.color} snap={snapValue(snap, timeSig)} timeSig={timeSig} musicKey={musicKey}
      onChange={(notes, live) => A.setNotes(clip.id, notes, live)}
      onGestureStart={beginGesture} onGestureEnd={endGesture}
      onAudition={(pitch, velocity) => engine.auditionTrack(track.id, pitch, velocity)}
      onLength={(length) => A.updateClip(clip.id, { length }, true)}
      range={def && !drums ? def.range : undefined}
      drumRows={drums ? [...kitPads(track.instrumentId)].reverse().map((pitch) => ({ pitch, label: drumSound(pitch)?.name ?? String(pitch) })) : undefined}
      getPlayhead={() => { const b = engine.beat - clip.start; return b >= 0 && b <= clip.length + 64 ? b : null; }}
      onSeek={(b) => A.seek(clip.start + b)}
      advanced={advanced}
      toolbar={toggle}
    />
  );
}
