import { Fragment, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { renderProject } from '../audio/render';
import type { FxName, FxState, Track, TrackGroup } from '../types';
import { defaultFx } from '../types';
import { analyzeLoudness, type LoudnessStats } from '../lib/loudness';
import { fitCanvas } from '../lib/peaks';
import { trackSound } from '../lib/templates';
import { toPcm } from '../lib/wav';
import { A, beginGesture, endGesture, selectedTrack, setUI, toast, useStore } from '../store/store';
import { Hint, Slider, Switch, fmtDb, useFrame, useSize } from './ui';

// Mixing console, per-track effects and the master/mastering panel.

const meterPct = (db: number): number => Math.max(0, Math.min(1, (db + 60) / 66)) * 100;
const meterClass = (db: number): string => (db > -0.5 ? 'clip' : db > -6 ? 'hot' : '');
const NO_GROUPS: TrackGroup[] = [];

export function Mixer() {
  const tracks = useStore((s) => s.project.tracks);
  const master = useStore((s) => s.project.master);
  const groups = useStore((s) => s.project.groups) ?? NO_GROUPS;
  const selectedId = useStore((s) => s.ui.selectedTrackId);
  const bars = useRef(new Map<string, HTMLElement>());
  const peak = useRef<HTMLSpanElement>(null);
  const hold = useRef({ value: -Infinity, at: 0 });

  useFrame(() => {
    const groupDb = new Map<string, number>();
    for (const t of tracks) {
      const db = engine.trackLevel(t.id);
      if (t.groupId) groupDb.set(t.groupId, Math.max(groupDb.get(t.groupId) ?? -Infinity, db));
      const el = bars.current.get(t.id);
      if (!el) continue;
      el.style.height = `${meterPct(db)}%`;
      el.className = meterClass(db);
    }
    for (const [id, db] of groupDb) {
      const el = bars.current.get(`group:${id}`);
      if (el) { el.style.height = `${meterPct(db)}%`; el.className = meterClass(db); }
    }
    const [l, r] = engine.masterLevels();
    for (const [key, db] of [['L', l], ['R', r]] as const) {
      const el = bars.current.get(`master${key}`);
      if (el) { el.style.height = `${meterPct(db)}%`; el.className = meterClass(db); }
    }
    const top = Math.max(l, r);
    const now = performance.now();
    if (top > hold.current.value || now - hold.current.at > 1500) hold.current = { value: top, at: now };
    if (peak.current) peak.current.textContent = hold.current.value > -90 ? `${hold.current.value.toFixed(1)} dB` : '—';
  });

  const setBar = (id: string) => (el: HTMLElement | null) => { if (el) bars.current.set(id, el); else bars.current.delete(id); };

  return (
    <div className="mixer" role="group" aria-label="Mixer">
      {tracks.length === 0 && <p className="hint">Add a track to see its channel strip here.</p>}
      {tracks.map((t: Track, i) => {
        // a group's own strip sits right after its last track
        const g = t.groupId && tracks[i + 1]?.groupId !== t.groupId ? groups.find((x) => x.id === t.groupId) : undefined;
        const count = g ? tracks.filter((x) => x.groupId === g.id).length : 0;
        return (
        <Fragment key={t.id}>
        <div className={`strip ${t.id === selectedId ? 'sel' : ''}`} onPointerDown={() => A.selectTrack(t.id)}>
          <div className="strip-color" style={{ background: t.color }} />
          <button className="strip-name" title={`${t.name} — ${trackSound(t)}`}>{t.name}</button>
          <Slider className="pan" label={`${t.name} pan`} min={-1} max={1} step={0.02} value={t.pan} reset={0} onChange={(v) => A.updateTrack(t.id, { pan: v }, true)} />
          <span className="db num">{Math.abs(t.pan) < 0.02 ? 'Centre' : `${Math.round(Math.abs(t.pan) * 100)}${t.pan < 0 ? ' L' : ' R'}`}</span>
          <div className="fader-row">
            <Slider vertical label={`${t.name} volume`} min={-60} max={6} step={0.5} value={t.volume} reset={-8} onChange={(v) => A.updateTrack(t.id, { volume: v }, true)} />
            <div className="meter" aria-hidden><i ref={setBar(t.id)} /></div>
          </div>
          <span className="db num">{fmtDb(t.volume)} dB</span>
          <div className="row" style={{ gap: 4 }}>
            <button className={`ms m ${t.mute ? 'on' : ''}`} aria-label={`Mute ${t.name}`} aria-pressed={t.mute} onClick={() => A.updateTrack(t.id, { mute: !t.mute })}>M</button>
            <button className={`ms s ${t.solo ? 'on' : ''}`} aria-label={`Solo ${t.name}`} aria-pressed={t.solo} onClick={() => A.updateTrack(t.id, { solo: !t.solo })}>S</button>
          </div>
        </div>
        {g && (
          <div className="strip group">
            <div className="strip-color" style={{ background: g.color }} />
            <span className="strip-name" style={{ fontWeight: 600 }} title={`${g.name}: one fader, mute and solo for its ${count} track${count === 1 ? '' : 's'}`}>{g.name}</span>
            <span className="db">Group</span>
            <span className="db num">{count} track{count === 1 ? '' : 's'}</span>
            <div className="fader-row">
              <Slider vertical label={`${g.name} group volume`} min={-48} max={12} step={0.5} value={g.volume} reset={0} onChange={(v) => A.updateGroup(g.id, { volume: v }, true)} />
              <div className="meter" aria-hidden><i ref={setBar(`group:${g.id}`)} /></div>
            </div>
            <span className="db num">{fmtDb(g.volume)} dB</span>
            <div className="row" style={{ gap: 4 }}>
              <button className={`ms m ${g.mute ? 'on' : ''}`} aria-label={`Mute group ${g.name}`} aria-pressed={g.mute} onClick={() => A.updateGroup(g.id, { mute: !g.mute })}>M</button>
              <button className={`ms s ${g.solo ? 'on' : ''}`} aria-label={`Solo group ${g.name}`} aria-pressed={g.solo} onClick={() => A.updateGroup(g.id, { solo: !g.solo })}>S</button>
            </div>
          </div>
        )}
        </Fragment>
        );
      })}
      <div className="strip master">
        <div className="strip-color" style={{ background: '#f5f5f6' }} />
        <span className="strip-name" style={{ fontWeight: 600 }}>Master</span>
        <span className="db">Peak</span>
        <span ref={peak} className="db num" style={{ color: 'var(--text)' }}>—</span>
        <div className="fader-row">
          <Slider vertical label="Master volume" min={-60} max={6} step={0.5} value={master.volume} reset={0} onChange={(v) => A.setMaster({ volume: v }, true)} />
          <div className="meter" aria-hidden><i ref={setBar('masterL')} /></div>
          <div className="meter" aria-hidden><i ref={setBar('masterR')} /></div>
        </div>
        <span className="db num">{fmtDb(master.volume)} dB</span>
        <button className="btn sm ghost" onClick={() => setUI({ bottomPanel: 'master' })}>Mastering</button>
      </div>
    </div>
  );
}

// ---- track effects --------------------------------------------------------

interface ParamSpec { key: string; label: string; min: number; max: number; step: number; fmt: (v: number) => string }
interface FxSpec { name: FxName; title: string; hint: string; advanced?: boolean; params: ParamSpec[] }

const dB = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

const FX_SPECS: FxSpec[] = [
  { name: 'eq', title: 'Equalizer', hint: 'Boost or cut the bass, middle and treble.', params: [
    { key: 'low', label: 'Low', min: -18, max: 18, step: 0.5, fmt: dB }, { key: 'mid', label: 'Mid', min: -18, max: 18, step: 0.5, fmt: dB }, { key: 'high', label: 'High', min: -18, max: 18, step: 0.5, fmt: dB }] },
  { name: 'comp', title: 'Compressor', hint: 'Evens out loud and quiet moments.', advanced: true, params: [
    { key: 'threshold', label: 'Threshold', min: -60, max: 0, step: 1, fmt: (v) => `${v} dB` }, { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.5, fmt: (v) => `${v}:1` }] },
  { name: 'gate', title: 'Noise gate', hint: 'Silences background noise between phrases.', advanced: true, params: [
    { key: 'threshold', label: 'Threshold', min: -80, max: -10, step: 1, fmt: (v) => `${v} dB` }] },
  { name: 'pitch', title: 'Pitch shift', hint: 'Moves everything on the track up or down.', advanced: true, params: [
    { key: 'semitones', label: 'Shift', min: -12, max: 12, step: 1, fmt: (v) => `${v > 0 ? '+' : ''}${v} st` }] },
  { name: 'dist', title: 'Distortion', hint: 'Adds grit and drive.', params: [{ key: 'amount', label: 'Drive', min: 0, max: 1, step: 0.01, fmt: pct }] },
  { name: 'chorus', title: 'Chorus', hint: 'Thickens the sound with a shimmering double.', params: [
    { key: 'rate', label: 'Rate', min: 0.1, max: 8, step: 0.1, fmt: (v) => `${v.toFixed(1)} Hz` }, { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, fmt: pct }, { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, fmt: pct }] },
  { name: 'delay', title: 'Delay', hint: 'Echoes that repeat and fade away.', params: [
    { key: 'time', label: 'Time', min: 0.02, max: 1.5, step: 0.01, fmt: (v) => `${Math.round(v * 1000)} ms` }, { key: 'feedback', label: 'Repeats', min: 0, max: 0.9, step: 0.01, fmt: pct }, { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, fmt: pct }] },
  { name: 'reverb', title: 'Reverb', hint: 'Places the sound in a room or hall.', params: [
    { key: 'decay', label: 'Size', min: 0.3, max: 8, step: 0.1, fmt: (v) => `${v.toFixed(1)} s` }, { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, fmt: pct }] },
];

const PRESETS: { name: string; fx: Partial<FxState> }[] = [
  { name: 'Clean', fx: {} },
  { name: 'Warm room', fx: { eq: { on: true, low: 2, mid: 0, high: -2 }, reverb: { on: true, decay: 1.4, mix: 0.2 } } },
  { name: 'Big hall', fx: { reverb: { on: true, decay: 4.5, mix: 0.35 } } },
  { name: 'Echo', fx: { delay: { on: true, time: 0.3, feedback: 0.4, mix: 0.3 } } },
  { name: 'Lo-fi', fx: { eq: { on: true, low: 2, mid: 0, high: -10 }, dist: { on: true, amount: 0.15 }, chorus: { on: true, rate: 0.6, depth: 0.5, mix: 0.3 } } },
  { name: 'Vocal polish', fx: { eq: { on: true, low: -3, mid: 0, high: 3 }, comp: { on: true, threshold: -24, ratio: 3 }, reverb: { on: true, decay: 1.8, mix: 0.18 } } },
];

export function FxPanel() {
  const track = useStore(selectedTrack);
  const advanced = useStore((s) => s.ui.mode === 'advanced');
  if (!track) return <p className="hint" style={{ padding: 16 }}>Select a track to shape its sound with effects.</p>;
  const specs = FX_SPECS.filter((f) => advanced || !f.advanced || track.fx[f.name].on);
  return (
    <div>
      <div className="row wrap" style={{ padding: '10px 12px 0' }}>
        <span style={{ fontWeight: 500 }}>Effects on {track.name}</span>
        <span className="faint" style={{ fontSize: 12 }}>Quick sounds</span>
        {PRESETS.map((p) => (
          <button key={p.name} className="btn sm" onClick={() => A.updateTrack(track.id, { fx: { ...defaultFx(), ...p.fx } })}>{p.name}</button>
        ))}
      </div>
      <div className="fx-grid">
        {specs.map((f) => {
          const state = track.fx[f.name] as unknown as Record<string, number | boolean>;
          return (
            <div key={f.name} className={`fx-card ${state.on ? 'on' : ''}`}>
              <div className="fx-head">
                <Switch on={!!state.on} onChange={(v) => A.setFx(track.id, f.name, { on: v } as never)} label={`${f.title} on ${track.name}`} />
                {f.title}
              </div>
              <Hint>{f.hint}</Hint>
              {f.params.map((p) => (
                <div key={p.key} className="fx-param">
                  <span>{p.label}</span>
                  <Slider label={`${f.title} ${p.label}`} min={p.min} max={p.max} step={p.step} value={state[p.key] as number} disabled={!state.on} onChange={(v) => A.setFx(track.id, f.name, { [p.key]: v } as never, true)} />
                  <output className="num">{p.fmt(state[p.key] as number)}</output>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {!advanced && <p className="hint" style={{ padding: '0 14px 14px' }}>Switch to Advanced mode for the compressor, noise gate and pitch shifter.</p>}
    </div>
  );
}

// ---- master ---------------------------------------------------------------

const heat = (t: number): string => {
  // black → violet → cyan → white
  const stops = [[9, 9, 10], [143, 124, 247], [79, 195, 232], [255, 255, 255]];
  const x = Math.max(0, Math.min(0.999, t)) * 3;
  const i = Math.floor(x), f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};

function Analyzer() {
  const [ref, size] = useSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<'spectrum' | 'spectrogram'>('spectrum');
  const last = useRef('');
  useFrame(() => {
    const cv = canvas.current;
    const fft = engine.spectrum();
    if (!cv || !fft || size.w < 10) return;
    const W = size.w, H = 120;
    const sr = engine.sampleRate;
    const binHz = sr / 2 / fft.length;
    const sig = `${mode}${W}`;
    const fresh = last.current !== sig;
    last.current = sig;
    if (mode === 'spectrum') {
      const ctx = fitCanvas(cv, W, H);
      ctx.clearRect(0, 0, W, H);
      const bars = Math.min(96, Math.floor(W / 5));
      const bw = W / bars;
      ctx.fillStyle = '#4fc3e8';
      for (let b = 0; b < bars; b++) {
        const f0 = 30 * Math.pow(600, b / bars), f1 = 30 * Math.pow(600, (b + 1) / bars);
        let max = -140;
        for (let k = Math.max(1, Math.floor(f0 / binHz)); k <= Math.min(fft.length - 1, Math.ceil(f1 / binHz)); k++) if (fft[k] > max) max = fft[k];
        const h = Math.max(0, Math.min(1, (max + 100) / 85)) * (H - 16);
        if (h > 0.5) ctx.fillRect(b * bw + 1, H - 14 - h, bw - 2, h);
      }
      ctx.fillStyle = '#96969c'; ctx.font = '11px Inter Variable, system-ui, sans-serif'; ctx.textBaseline = 'alphabetic';
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        const x = (Math.log(f / 30) / Math.log(600)) * W;
        ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x, H - 2);
      }
    } else {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (fresh || cv.width !== Math.floor(W) * dpr) { const c = fitCanvas(cv, W, H); c.fillStyle = '#09090a'; c.fillRect(0, 0, W, H); }
      const ctx = cv.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(cv, -dpr, 0);
      const rowsN = cv.height;
      for (let y = 0; y < rowsN; y += 2) {
        const f = 30 * Math.pow(600, 1 - y / rowsN);
        const v = fft[Math.min(fft.length - 1, Math.max(1, Math.round(f / binHz)))];
        ctx.fillStyle = heat((v + 100) / 80);
        ctx.fillRect(cv.width - dpr, y, dpr, 2);
      }
    }
  });
  return (
    <div className="col">
      <div className="row">
        <span className="label">Frequency analysis of the master output</span>
        <div className="grow" />
        <div className="seg">
          <button className={mode === 'spectrum' ? 'on' : ''} onClick={() => setMode('spectrum')}>Spectrum</button>
          <button className={mode === 'spectrogram' ? 'on' : ''} onClick={() => setMode('spectrogram')}>Spectrogram</button>
        </div>
      </div>
      <div ref={ref} className="analyzer"><canvas ref={canvas} style={{ borderRadius: 8 }} /></div>
    </div>
  );
}

export function MasterPanel() {
  const master = useStore((s) => s.project.master);
  const advanced = useStore((s) => s.ui.mode === 'advanced');
  const [stats, setStats] = useState<LoudnessStats | null>(null);
  const [busy, setBusy] = useState(false);
  const measure = async () => {
    setBusy(true);
    try {
      const s = useStore.getState();
      setStats(analyzeLoudness(toPcm(await renderProject(s.project, engine.buffers))));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The mix could not be measured.', 'error');
    } finally {
      setBusy(false);
    }
  };
  const band = (key: 'low' | 'mid' | 'high', label: string) => (
    <div className="fx-param"><span>{label}</span>
      <Slider label={`Master EQ ${label}`} min={-12} max={12} step={0.5} value={master.eq[key]} disabled={!master.eq.on} onChange={(v) => A.setMaster({ eq: { ...master.eq, [key]: v } }, true)} />
      <output className="num">{dB(master.eq[key])}</output></div>
  );
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10, padding: '10px 12px 14px', alignItems: 'start' }}>
      <div className="col" style={{ gap: 8 }}>
        <div className={`fx-card ${master.limiter.on ? 'on' : ''}`}>
          <div className="fx-head"><Switch on={master.limiter.on} onChange={(v) => A.setMaster({ limiter: { ...master.limiter, on: v } })} label="Master limiter" />Limiter</div>
          <Hint>Catches peaks so the mix never clips. Leave it on.</Hint>
          <div className="fx-param"><span>Ceiling</span>
            <Slider label="Limiter ceiling" min={-6} max={0} step={0.1} value={master.limiter.ceiling} disabled={!master.limiter.on} onChange={(v) => A.setMaster({ limiter: { ...master.limiter, ceiling: v } }, true)} />
            <output className="num">{master.limiter.ceiling.toFixed(1)} dB</output></div>
        </div>
        {advanced && (
          <>
            <div className={`fx-card ${master.eq.on ? 'on' : ''}`}>
              <div className="fx-head"><Switch on={master.eq.on} onChange={(v) => A.setMaster({ eq: { ...master.eq, on: v } })} label="Master equalizer" />Master EQ</div>
              {band('low', 'Low')}{band('mid', 'Mid')}{band('high', 'High')}
            </div>
            <div className={`fx-card ${master.comp.on ? 'on' : ''}`}>
              <div className="fx-head"><Switch on={master.comp.on} onChange={(v) => A.setMaster({ comp: { ...master.comp, on: v } })} label="Master compressor" />Glue compressor</div>
              <div className="fx-param"><span>Threshold</span>
                <Slider label="Master compressor threshold" min={-40} max={0} step={1} value={master.comp.threshold} disabled={!master.comp.on} onChange={(v) => A.setMaster({ comp: { ...master.comp, threshold: v } }, true)} />
                <output className="num">{master.comp.threshold} dB</output></div>
              <div className="fx-param"><span>Ratio</span>
                <Slider label="Master compressor ratio" min={1} max={10} step={0.5} value={master.comp.ratio} disabled={!master.comp.on} onChange={(v) => A.setMaster({ comp: { ...master.comp, ratio: v } }, true)} />
                <output className="num">{master.comp.ratio}:1</output></div>
            </div>
          </>
        )}
      </div>
      <div className="col" style={{ gap: 10 }}>
        <Analyzer />
        <div className="fx-card on">
          <div className="fx-head">Loudness of the full mix
            <div className="grow" />
            <button className="btn sm" disabled={busy} onClick={measure}>{busy ? 'Measuring…' : stats ? 'Measure again' : 'Measure'}</button>
          </div>
          {stats ? (
            <div className="stat-strip" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
              <div><b className="num">{Number.isFinite(stats.lufs) ? stats.lufs.toFixed(1) : '—'}</b><span>LUFS integrated</span></div>
              <div><b className="num">{stats.peakDb.toFixed(1)}</b><span>dBFS peak</span></div>
              <div><b className="num">{stats.clippedSamples}</b><span>clipped samples</span></div>
            </div>
          ) : (
            <p className="hint">Renders the whole song and measures it the way streaming services do. Around −14 LUFS is a common target.</p>
          )}
          <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setUI({ exportOpen: true })}>Export with loudness target…</button>
        </div>
      </div>
    </div>
  );
}

export { beginGesture, endGesture };
