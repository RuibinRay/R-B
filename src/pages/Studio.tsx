import { useEffect, useRef, useState } from 'react';
import { Blend, ChevronDown, ChevronUp, Combine, Copy, Flag, Maximize2, Mic, MousePointer2, PanelLeft, Plus, Scissors, Trash2, Upload, ZoomIn, ZoomOut } from 'lucide-react';
import { engine } from '../audio/engine';
import { mic } from '../audio/recorder';
import { SNAP_OPTIONS, barBeats, clamp, clipEnd, projectEndBeats } from '../lib/music';
import { A, setUI, toast, useStore, type BottomPanel } from '../store/store';
import { ClipEditor } from '../components/ClipEditor';
import { InstrumentBrowser } from '../components/InstrumentBrowser';
import { FxPanel, MasterPanel, Mixer } from '../components/Mixer';
import { Timeline } from '../components/Timeline';
import { TransportBar } from '../components/TransportBar';
import { Hint, Menu, Slider, Switch, useFrame } from '../components/ui';

export function SnapSelect() {
  const snap = useStore((s) => s.ui.snap);
  const advanced = useStore((s) => s.ui.mode === 'advanced');
  return (
    <label className="t-field" title="Clips and notes snap to this grid">
      Snap
      <select className="select" aria-label="Snap to grid" value={snap} onChange={(e) => setUI({ snap: Number(e.target.value) })}>
        {SNAP_OPTIONS.filter((o) => advanced || !o.advanced || o.value === snap).map((o) => <option key={o.label} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function InputMenu() {
  const monitor = useStore((s) => s.ui.monitor);
  const inputGain = useStore((s) => s.ui.inputGain);
  const latencyMs = useStore((s) => s.ui.latencyMs);
  const advanced = useStore((s) => s.ui.mode === 'advanced');
  const level = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(mic.isOpen);
  useFrame(() => { if (level.current) level.current.style.width = `${Math.min(100, Math.sqrt(mic.level()) * 100)}%`; });
  const connect = async () => {
    try { await mic.open(); mic.setGain(inputGain); mic.setMonitor(monitor); setOpen(true); }
    catch (e) { toast(e instanceof Error ? e.message : 'The microphone could not be opened.', 'error'); }
  };
  return (
    <Menu align="right" button={(toggle) => <button className="btn sm" onClick={toggle} title="Microphone and recording settings"><Mic />Input</button>}>
      {() => (
        <div className="col" style={{ width: 280, padding: 10, gap: 12 }}>
          {open ? (
            <div className="col" style={{ gap: 5 }}><span className="label">Microphone level</span><div className="level"><i ref={level} /></div></div>
          ) : (
            <button className="btn sm" onClick={connect}><Mic />Connect microphone</button>
          )}
          <div className="fx-param" style={{ gridTemplateColumns: '78px minmax(0,1fr) 48px' }}><span>Record level</span>
            <Slider plain label="Recording level" min={-24} max={24} step={1} value={inputGain} reset={0} onChange={(v) => { setUI({ inputGain: v }); mic.setGain(v); }} />
            <output className="num">{inputGain > 0 ? '+' : ''}{inputGain} dB</output></div>
          <label className="t-field"><Switch on={monitor} onChange={(v) => { setUI({ monitor: v }); mic.setMonitor(v); }} label="Monitor input" />Hear yourself while recording</label>
          <Hint>Use headphones when monitoring, or the microphone will pick up the speakers.</Hint>
          {advanced && (
            <div className="fx-param" style={{ gridTemplateColumns: '78px minmax(0,1fr) 48px' }}><span>Timing offset</span>
              <Slider plain label="Recording latency offset" min={-100} max={200} step={1} value={latencyMs} reset={0} onChange={(v) => setUI({ latencyMs: v })} />
              <output className="num">{latencyMs} ms</output></div>
          )}
          {advanced && <p className="hint">Takes are shifted earlier by the system’s reported round-trip latency ({Math.round(mic.roundTripLatency() * 1000)} ms). If your takes still sound late, raise the offset.</p>}
        </div>
      )}
    </Menu>
  );
}

const TABS: { id: BottomPanel; label: string }[] = [
  { id: 'editor', label: 'Editor' }, { id: 'mixer', label: 'Mixer' }, { id: 'fx', label: 'Effects' }, { id: 'master', label: 'Master' },
];

export function Studio() {
  const browserOpen = useStore((s) => s.ui.browserOpen);
  const tool = useStore((s) => s.ui.tool);
  const panel = useStore((s) => s.ui.bottomPanel);
  const panelOpen = useStore((s) => s.ui.panelOpen);
  const selected = useStore((s) => s.ui.selectedClipIds);
  const ppb = useStore((s) => s.ui.pxPerBeat);
  const autoCrossfade = useStore((s) => s.project.autoCrossfade !== false);
  const [dockH, setDockH] = useState(300);
  const audioInput = useRef<HTMLInputElement>(null);
  const midiInput = useRef<HTMLInputElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(window.innerWidth < 860);
  useEffect(() => {
    const on = () => {
      const now = window.innerWidth < 860;
      setNarrow((was) => { if (now && !was) setUI({ browserOpen: false }); return now; });
    };
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  const splitAtPlayhead = () => {
    const s = useStore.getState();
    const beat = engine.beat;
    const pool = s.ui.selectedClipIds.length ? s.project.clips.filter((c) => s.ui.selectedClipIds.includes(c.id)) : s.project.clips.filter((c) => c.trackId === s.ui.selectedTrackId);
    const ids = pool.filter((c) => beat > c.start + 0.01 && beat < clipEnd(c, s.project.bpm) - 0.01).map((c) => c.id);
    if (ids.length) A.splitClips(ids, beat);
    else toast('Move the playhead over a clip (or select one) to split it.', 'info');
  };
  const merge = () => {
    const s = useStore.getState();
    const clips = s.project.clips.filter((c) => s.ui.selectedClipIds.includes(c.id));
    if (clips.length && clips.every((c) => c.type === 'audio')) void A.mergeAudioClips(s.ui.selectedClipIds);
    else A.mergeMidiClips(s.ui.selectedClipIds);
  };
  const zoom = (factor: number) => setUI({ pxPerBeat: clamp(ppb * factor, 1, 2400) });
  const fit = () => {
    const p = useStore.getState().project;
    const width = (stage.current?.clientWidth ?? 900) - (narrow ? 132 : 216) - 40;
    setUI({ pxPerBeat: clamp(width / Math.max(barBeats(p.timeSig) * 4, projectEndBeats(p) + barBeats(p.timeSig)), 1, 400) });
  };
  const startResize = (e: React.PointerEvent) => {
    const y0 = e.clientY, h0 = dockH;
    const move = (ev: PointerEvent) => setDockH(clamp(h0 + (y0 - ev.clientY), 120, Math.max(160, window.innerHeight - 260)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <>
      <TransportBar />
      <div className="workspace">
        {(browserOpen || narrow) && <InstrumentBrowser open={narrow && browserOpen} onClose={() => setUI({ browserOpen: false })} />}
        <div className="stage" ref={stage}>
          <div className="toolbar" role="toolbar" aria-label="Studio tools">
            <button className={`icon-btn ${browserOpen ? 'on' : ''}`} title="Show or hide the instrument library" aria-label="Instrument library" aria-pressed={browserOpen} onClick={() => setUI({ browserOpen: !browserOpen })}><PanelLeft /></button>
            <Menu button={(toggle) => <button className="btn sm" onClick={toggle}><Plus />Add track</button>}>
              {(close) => (
                <>
                  <button className="menu-item" onClick={() => { const id = A.addTrack('instrument', 'grand-piano'); A.addMidiClip(id, 0); close(); }}>Instrument track</button>
                  <button className="menu-item" onClick={() => { A.addTrack('audio'); close(); }}>Audio track</button>
                  <button className="menu-item" onClick={() => { audioInput.current?.click(); close(); }}><Upload />Import audio…</button>
                  <button className="menu-item" onClick={() => { midiInput.current?.click(); close(); }}><Upload />Import MIDI…</button>
                </>
              )}
            </Menu>
            <input ref={audioInput} type="file" accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.aiff" multiple hidden onChange={(e) => { void A.importAudioFiles([...(e.target.files ?? [])], Math.floor(engine.beat)); e.target.value = ''; }} />
            <input ref={midiInput} type="file" accept=".mid,.midi,audio/midi" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void A.importMidi(f); e.target.value = ''; }} />
            <div className="t-div" />
            <div className="seg" role="group" aria-label="Tool">
              <button className={tool === 'select' ? 'on' : ''} onClick={() => setUI({ tool: 'select' })} title="Select, move and trim clips"><MousePointer2 />Select</button>
              <button className={tool === 'split' ? 'on' : ''} onClick={() => setUI({ tool: 'split' })} title="Click a clip to cut it in two"><Scissors />Split</button>
            </div>
            <SnapSelect />
            <div className="t-div" />
            <button className="icon-btn" title="Split at the playhead (S)" aria-label="Split at playhead" onClick={splitAtPlayhead}><Scissors /></button>
            <button className="icon-btn" title="Duplicate (Ctrl/Cmd+D)" aria-label="Duplicate clips" disabled={!selected.length} onClick={() => A.duplicateClips(selected)}><Copy /></button>
            <button className="icon-btn" title="Merge selected clips on one track" aria-label="Merge clips" disabled={selected.length < 2} onClick={merge}><Combine /></button>
            <button className="icon-btn" title="Delete (Delete)" aria-label="Delete clips" disabled={!selected.length} onClick={() => A.removeClips(selected)}><Trash2 /></button>
            <button className="icon-btn" title="Add a marker at the playhead (M). Alt-click a marker to remove it." aria-label="Add marker" onClick={() => A.addMarker(engine.beat)}><Flag /></button>
            <button
              className={`icon-btn ${autoCrossfade ? 'on' : ''}`} aria-label="Automatic crossfades" aria-pressed={autoCrossfade}
              title={autoCrossfade ? 'Automatic crossfades are on: overlapping audio clips on a track fade into each other' : 'Automatic crossfades are off: overlapping audio clips play on top of each other'}
              onClick={() => A.setAutoCrossfade(!autoCrossfade)}
            ><Blend /></button>
            <div className="grow" />
            <InputMenu />
            <button className="icon-btn" title="Zoom out" aria-label="Zoom out" onClick={() => zoom(1 / 1.5)}><ZoomOut /></button>
            <button className="icon-btn" title="Zoom in (Ctrl/Cmd + scroll)" aria-label="Zoom in" onClick={() => zoom(1.5)}><ZoomIn /></button>
            <button className="icon-btn" title="Fit the whole song" aria-label="Fit song to view" onClick={fit}><Maximize2 /></button>
          </div>
          <Timeline headWidth={narrow ? 132 : 216} />
          {panelOpen && <div className="resize-h" onPointerDown={startResize} title="Drag to resize" />}
          <div className="dock" style={{ height: panelOpen ? dockH : 38 }}>
            <div className="dock-tabs" role="tablist">
              {TABS.map((t) => (
                <button key={t.id} role="tab" aria-selected={panel === t.id && panelOpen} className={`tab ${panel === t.id && panelOpen ? 'on' : ''}`} onClick={() => setUI({ bottomPanel: t.id, panelOpen: true })}>{t.label}</button>
              ))}
              <div className="grow" />
              <button className="icon-btn sm" aria-label={panelOpen ? 'Collapse panel' : 'Expand panel'} title={panelOpen ? 'Collapse' : 'Expand'} onClick={() => setUI({ panelOpen: !panelOpen })}>{panelOpen ? <ChevronDown /> : <ChevronUp />}</button>
            </div>
            {panelOpen && (
              <div className="dock-body">
                {panel === 'editor' && <ClipEditor />}
                {panel === 'mixer' && <Mixer />}
                {panel === 'fx' && <FxPanel />}
                {panel === 'master' && <MasterPanel />}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
