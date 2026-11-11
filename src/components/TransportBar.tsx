import { useEffect, useRef, useState } from 'react';
import { Circle, Download, Play, Redo2, Repeat, SkipBack, Square, Timer, Undo2 } from 'lucide-react';
import { engine } from '../audio/engine';
import { NOTE_NAMES, SCALES, beatsToSec, formatBars, formatTime } from '../lib/music';
import type { ScaleName } from '../types';
import { A, setUI, useStore } from '../store/store';
import { useFrame } from './ui';

function MetronomeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3h6l4 18H5L9 3Z" /><path d="M12 15 17 6" /><path d="M7.5 15h9" />
    </svg>
  );
}

/** The song's key and scale: drives the scale shading, chord suggestions and "stay in key". */
export function KeySelect() {
  const key = useStore((s) => s.project.key);
  return (
    <label className="t-field">
      Key
      <select className="select" aria-label="Key" value={key.root} onChange={(e) => A.setKey(Number(e.target.value), key.scale)}>
        {NOTE_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}
      </select>
      <select className="select" aria-label="Scale" value={key.scale} onChange={(e) => A.setKey(key.root, e.target.value as ScaleName)}>
        {(Object.keys(SCALES) as ScaleName[]).map((s) => <option key={s} value={s}>{SCALES[s].name}</option>)}
      </select>
    </label>
  );
}

export function TransportBar() {
  const name = useStore((s) => s.project.name);
  const bpm = useStore((s) => s.project.bpm);
  const timeSig = useStore((s) => s.project.timeSig);
  const loopOn = useStore((s) => s.project.loop.on);
  const playing = useStore((s) => s.playing);
  const recording = useStore((s) => !!s.recording);
  const metronome = useStore((s) => s.ui.metronome);
  const countIn = useStore((s) => s.ui.countIn);
  const saveState = useStore((s) => s.saveState);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const bars = useRef<HTMLElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const [bpmText, setBpmText] = useState(String(bpm));
  const [nameText, setNameText] = useState(name);
  useEffect(() => setBpmText(String(bpm)), [bpm]);
  useEffect(() => setNameText(name), [name]);

  useFrame(() => {
    const beat = engine.beat;
    if (bars.current) bars.current.textContent = formatBars(beat, timeSig);
    if (time.current) time.current.textContent = formatTime(beatsToSec(beat, bpm)).slice(0, -2);
  });

  const commitBpm = () => {
    const v = parseFloat(bpmText);
    if (Number.isFinite(v)) A.setBpm(v);
    else setBpmText(String(bpm));
  };

  return (
    <div className="transport" role="toolbar" aria-label="Transport">
      <div className="t-group t-name" style={{ minWidth: 0 }}>
        <input
          className="input bare" aria-label="Project name" value={nameText} style={{ width: 150 }}
          onChange={(e) => setNameText(e.target.value)} onBlur={() => A.rename(nameText)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
        <span className="save-state desktop-only">{saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved' : 'Saved'}</span>
      </div>
      <div className="t-div" />
      <div className="t-group">
        <button className="icon-btn" title="Back to start (Enter)" aria-label="Back to start" onClick={A.toStart}><SkipBack /></button>
        <button className="play-btn" title={playing ? 'Stop (Space)' : 'Play (Space)'} aria-label={playing ? 'Stop' : 'Play'} onClick={A.toggle}>
          {playing ? <Square fill="currentColor" /> : <Play fill="currentColor" style={{ marginLeft: 2 }} />}
        </button>
        <button
          className={`icon-btn rec-btn ${recording ? 'on' : ''}`} title={recording ? 'Stop recording (R)' : 'Record from microphone (R)'}
          aria-label={recording ? 'Stop recording' : 'Record'} aria-pressed={recording}
          onClick={() => (recording ? void A.stopRecording() : void A.startRecording())}
        ><Circle fill="currentColor" /></button>
      </div>
      <div className="pos num" aria-label="Position">
        <b ref={bars}>1.1.1</b>
        <span ref={time}>0:00.0</span>
      </div>
      <div className="t-group">
        <button className={`icon-btn ${loopOn ? 'on' : ''}`} title="Loop the marked region (L)" aria-label="Loop" aria-pressed={loopOn} onClick={() => A.setLoop({ on: !loopOn })}><Repeat /></button>
        <button className={`icon-btn ${metronome ? 'on' : ''}`} title="Metronome (K)" aria-label="Metronome" aria-pressed={metronome} onClick={() => A.setMetronome(!metronome)}><MetronomeIcon /></button>
        <button className={`icon-btn ${countIn ? 'on' : ''}`} title="Count in one bar before recording" aria-label="Count-in" aria-pressed={countIn} onClick={() => setUI({ countIn: !countIn })}><Timer /></button>
      </div>
      <div className="t-div" />
      <label className="t-field">
        Tempo
        <input
          className="input t-num num" inputMode="decimal" aria-label="Tempo in beats per minute" value={bpmText}
          onChange={(e) => setBpmText(e.target.value)} onBlur={commitBpm} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
      </label>
      <label className="t-field">
        Time
        <select className="select num" aria-label="Beats per bar" value={timeSig[0]} onChange={(e) => A.setTimeSig(Number(e.target.value), timeSig[1])}>
          {[2, 3, 4, 5, 6, 7, 9, 12].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <select className="select num" aria-label="Beat unit" value={timeSig[1]} onChange={(e) => A.setTimeSig(timeSig[0], Number(e.target.value))}>
          {[4, 8].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <span className="wide-only"><KeySelect /></span>
      <div className="t-right">
        <button className="icon-btn" title="Undo (Ctrl/Cmd+Z)" aria-label="Undo" disabled={!canUndo} onClick={A.undo}><Undo2 /></button>
        <button className="icon-btn" title="Redo (Shift+Ctrl/Cmd+Z)" aria-label="Redo" disabled={!canRedo} onClick={A.redo}><Redo2 /></button>
        <button className="btn primary" onClick={() => setUI({ exportOpen: true })}><Download />Export</button>
      </div>
    </div>
  );
}
