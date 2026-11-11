import { useEffect, useMemo, useRef, useState } from 'react';
import { Circle, LoaderCircle, Play, Square, Upload } from 'lucide-react';
import { engine, type SeqHandle, type SeqPart } from '../audio/engine';
import { mic } from '../audio/recorder';
import type { Note } from '../types';
import { bassPart, chordPart, drumPart, harmonyPart, suggestChords } from '../lib/accompaniment';
import { basicPitchDetect } from '../lib/dsp/basicPitch';
import { detectMelody, monophonize, type DetectedNote } from '../lib/dsp/pitch';
import { classifyHits, detectOnsets, estimateTempo } from '../lib/dsp/rhythm';
import { CATEGORIES, INSTRUMENTS, drumSound, getInstrument, isDrums, kitPads } from '../lib/instruments';
import { NOTE_NAMES, SCALES, barBeats, clamp, detectKey, formatTime, snapBeat, uid, type Key } from '../lib/music';
import { drawWaveform, fitCanvas } from '../lib/peaks';
import { toMono } from '../lib/wav';
import { A, addBufferAsset, importAudio, navigate, toast, useStore } from '../store/store';
import type { ScaleName } from '../types';
import { PianoRoll } from '../components/PianoRoll';
import { Hint, Switch, useFrame, useSize } from '../components/ui';

type Mode = 'auto' | 'melody' | 'rhythm';
interface Source { buffer: AudioBuffer; name: string; blob: Blob | null }
interface Analysis {
  kind: 'melody' | 'rhythm';
  bpm: number;
  tempoGuessed: boolean;
  offsetSec: number; // time of the first detected note; beat 0 of the grid
  key: Key;
  raw: Map<string, { start: number; duration: number }>; // natural timing, seconds
  engine: string;
  note: string;
}

const QUICK_MELODY = ['violin', 'grand-piano', 'flute', 'acoustic-guitar', 'cello', 'saw-lead', 'erhu', 'trumpet'];
const QUICK_RHYTHM = ['studio-kit', 'electro-kit', 'latin-kit'];
const MAX_RECORD_SECONDS = 120;

/** Snap notes to a grid starting from their natural (detected) timing. `grid` 0 restores it. */
function quantized(notes: Note[], raw: Analysis['raw'], spb: number, grid: number): Note[] {
  return notes.map((n) => {
    const r = raw.get(n.id);
    if (grid === 0) return r ? { ...n, start: r.start, duration: r.duration } : n;
    const base = r ?? { start: n.start, duration: n.duration };
    return { ...n, start: Math.max(0, snapBeat(base.start / spb, grid)) * spb, duration: Math.max(grid, snapBeat(base.duration / spb, grid)) * spb };
  });
}

function SourceWave({ source }: { source: Source }) {
  const [ref, size] = useSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current || size.w < 10) return;
    const ctx = fitCanvas(canvas.current, size.w, 72);
    ctx.clearRect(0, 0, size.w, 72);
    drawWaveform(ctx, source.buffer, 0, 4, size.w, 64, 0, source.buffer.duration, '#4fc3e8');
  }, [source, size.w]);
  return <div ref={ref} className="wave-box"><canvas ref={canvas} role="img" aria-label="Waveform of the recording" /></div>;
}

export function Voice() {
  const projectBpm = useStore((s) => s.project.bpm);
  const projectEmpty = useStore((s) => s.project.clips.every((c) => c.type === 'midi' && c.notes.length === 0));
  const advanced = useStore((s) => s.ui.mode === 'advanced');
  const [source, setSource] = useState<Source | null>(null);
  const [recording, setRecording] = useState(false);
  const [mode, setMode] = useState<Mode>('auto');
  const [useModel, setUseModel] = useState(false);
  const [single, setSingle] = useState(true);
  const [busy, setBusy] = useState<{ text: string; progress: number } | null>(null);
  const [error, setError] = useState('');
  const [notes, setNotes] = useState<Note[]>([]); // seconds from analysis.offsetSec
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [instrumentId, setInstrumentId] = useState('violin');
  const [quant, setQuant] = useState(0);
  const [bends, setBends] = useState(true);
  const [withOriginal, setWithOriginal] = useState(false);
  const [sugg, setSugg] = useState({ chords: false, bass: false, drums: false, harmony: false });
  const [includeAudio, setIncludeAudio] = useState(true);
  const [adoptTempo, setAdoptTempo] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [bpmText, setBpmText] = useState('');
  const handle = useRef<SeqHandle | null>(null);
  const cursor = useRef(0); // beats
  const recStart = useRef(0);
  const timer = useRef<HTMLSpanElement>(null);
  const level = useRef<HTMLElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const spb = 60 / (analysis?.bpm ?? 100);
  const bar = 4;
  const beatNotes = useMemo(() => notes.map((n) => ({ ...n, start: n.start / spb, duration: n.duration / spb })), [notes, spb]);
  const lengthBeats = useMemo(() => Math.max(bar, Math.ceil(Math.max(0, ...beatNotes.map((n) => n.start + n.duration)) / bar - 1e-6) * bar), [beatNotes]);
  const rhythm = analysis?.kind === 'rhythm';

  const suggestions = useMemo(() => {
    if (!analysis || rhythm || !beatNotes.length) return null;
    const chords = suggestChords(beatNotes, analysis.key, lengthBeats, bar);
    return { chords, chordNotes: chordPart(chords, 'block', 3, 0.55), bass: bassPart(chords, 'bounce'), drums: drumPart(lengthBeats, bar, 'basic'), harmony: harmonyPart(beatNotes, analysis.key, -2) };
  }, [analysis, rhythm, beatNotes, lengthBeats]);

  const stopPlay = () => { handle.current?.stop(); handle.current = null; setPlaying(false); };
  useEffect(() => () => { handle.current?.stop(); if (recStart.current) void mic.stop().catch(() => {}); }, []);

  const buildParts = (): SeqPart[] => {
    if (!analysis) return [];
    const off = analysis.offsetSec;
    const seq = (ns: Note[]) => ns.map((n) => ({ pitch: n.pitch, time: off + n.start * spb, duration: n.duration * spb, velocity: n.velocity }));
    const parts: SeqPart[] = [{ instrumentId, notes: notes.map((n) => ({ pitch: n.pitch, time: off + n.start, duration: n.duration, velocity: n.velocity, bend: bends ? n.bend : undefined })) }];
    if (suggestions) {
      if (sugg.chords) parts.push({ instrumentId: 'grand-piano', notes: seq(suggestions.chordNotes), gain: 0.8 });
      if (sugg.bass) parts.push({ instrumentId: 'electric-bass', notes: seq(suggestions.bass) });
      if (sugg.drums) parts.push({ instrumentId: 'studio-kit', notes: seq(suggestions.drums), gain: 0.8 });
      if (sugg.harmony) parts.push({ instrumentId, notes: seq(suggestions.harmony), gain: 0.8 });
    }
    return parts;
  };

  const play = async (fromSec?: number) => {
    if (!analysis) return;
    handle.current?.stop();
    A.stop();
    const from = fromSec ?? (cursor.current <= 0 ? Math.max(0, analysis.offsetSec - 0.2) : analysis.offsetSec + cursor.current * spb);
    const h = await engine.playSequence(buildParts(), withOriginal && source ? { buffer: source.buffer, gain: 0.8 } : null, from, () => { handle.current = null; cursor.current = 0; setPlaying(false); });
    handle.current = h;
    setPlaying(true);
  };

  // Changing the sound while it plays restarts from the same spot, for instant comparison.
  useEffect(() => {
    if (handle.current) void play(Math.max(0, handle.current.position()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrumentId, bends, withOriginal, sugg]);

  const analyze = async (src: Source, forced?: Mode) => {
    stopPlay();
    setError('');
    setBusy({ text: 'Listening…', progress: 0 });
    const want = forced ?? mode;
    try {
      const mono = toMono(src.buffer, 16000);
      let kind: 'melody' | 'rhythm' = want === 'rhythm' ? 'rhythm' : 'melody';
      let detected: DetectedNote[] = [];
      let used = 'Built-in pitch tracker (YIN)';
      let note = '';
      if (want !== 'rhythm') {
        const share = useModel ? 0.3 : 1;
        const yin = await detectMelody(mono, 16000, (f) => setBusy({ text: 'Tracking pitch…', progress: f * share }));
        if (want === 'auto' && (yin.voicedRatio < 0.3 || yin.notes.length === 0)) {
          kind = 'rhythm';
          note = 'This sounded like rhythm rather than a sung melody, so it was analysed as beats. Choose “Melody” to force pitch detection.';
        } else {
          detected = yin.notes;
          if (useModel) {
            try {
              setBusy({ text: 'Running Basic Pitch…', progress: share });
              const bp = await basicPitchDetect(src.buffer, (f) => setBusy({ text: 'Running Basic Pitch…', progress: share + (1 - share) * f }));
              const out = single ? monophonize(bp) : bp;
              if (out.length) { detected = out; used = 'Spotify Basic Pitch'; }
              else note = 'Basic Pitch found no notes here, so the built-in pitch tracker was used.';
            } catch {
              note = 'Basic Pitch could not be loaded, so the built-in pitch tracker was used instead.';
            }
          }
        }
      }
      let bpm: number | null;
      if (kind === 'rhythm') {
        setBusy({ text: 'Finding hits…', progress: 0.6 });
        const onsets = detectOnsets(mono, 16000);
        detected = classifyHits(onsets);
        bpm = estimateTempo(onsets);
        used = 'Spectral-flux onset detector';
      } else {
        bpm = estimateTempo(detected.map((n) => ({ time: n.start, strength: n.velocity })));
      }
      if (!detected.length) {
        throw new Error(kind === 'rhythm'
          ? 'No clear hits were found. Try tapping or beatboxing closer to the microphone.'
          : 'No clear notes were found. Try humming closer to the microphone, with less background noise, or switch to Rhythm for tapping and beatboxing.');
      }
      const offsetSec = detected[0].start;
      const raw: Analysis['raw'] = new Map();
      const ns: Note[] = detected.map((d) => {
        const id = uid();
        raw.set(id, { start: d.start - offsetSec, duration: d.duration });
        return { id, pitch: d.pitch, start: d.start - offsetSec, duration: d.duration, velocity: d.velocity, bend: d.bend };
      });
      const tempo = bpm ?? 100;
      setNotes(ns);
      setAnalysis({ kind, bpm: tempo, tempoGuessed: bpm === null, offsetSec, key: detectKey(detected), raw, engine: used, note });
      setBpmText(String(tempo));
      setQuant(0);
      cursor.current = 0;
      setInstrumentId((cur) => (kind === 'rhythm' ? (isDrums(cur) ? cur : 'studio-kit') : isDrums(cur) ? 'violin' : cur));
    } catch (e) {
      setAnalysis(null);
      setNotes([]);
      setError(e instanceof Error ? e.message : 'The recording could not be analysed.');
    } finally {
      setBusy(null);
    }
  };

  const load = (src: Source) => { setSource(src); setAnalysis(null); setNotes([]); void analyze(src); };

  const startRec = async () => {
    setError('');
    stopPlay();
    A.stop();
    try {
      await engine.resume();
      await mic.open();
      mic.setMonitor(false);
      mic.start();
      recStart.current = performance.now();
      setRecording(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The microphone could not be opened.');
    }
  };
  const stopRec = async () => {
    if (!recStart.current) return;
    recStart.current = 0;
    setRecording(false);
    try {
      const r = await mic.stop();
      if (r.data.length < r.sampleRate * 0.6) { setError('That was too short. Record at least a second or two.'); return; }
      const buffer = engine.createBuffer(1, r.data.length, r.sampleRate);
      buffer.getChannelData(0).set(r.data);
      load({ buffer, name: 'Voice recording', blob: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The recording could not be read.');
    }
  };
  const onFile = async (f: File) => {
    setError('');
    if (f.size > 80 * 1024 * 1024) { setError('That file is larger than 80 MB. Use a shorter clip.'); return; }
    try {
      const buffer = await engine.decode(await f.arrayBuffer());
      if (buffer.duration > 300) { setError('That clip is longer than five minutes. Trim it to the part you want to convert.'); return; }
      load({ buffer, name: f.name.replace(/\.[^.]+$/, ''), blob: f });
    } catch {
      setError(`“${f.name}” could not be decoded. Try WAV, MP3, FLAC, OGG or M4A.`);
    }
  };

  useFrame(() => {
    if (level.current) level.current.style.width = `${recording ? Math.min(100, Math.sqrt(mic.level()) * 100) : 0}%`;
    if (recording && recStart.current) {
      const sec = (performance.now() - recStart.current) / 1000;
      if (timer.current) timer.current.textContent = formatTime(sec, false);
      if (sec >= MAX_RECORD_SECONDS) void stopRec();
    }
  });

  const setTempo = (text: string) => {
    const v = parseFloat(text);
    if (!analysis || !Number.isFinite(v)) { setBpmText(String(analysis?.bpm ?? '')); return; }
    const bpm = clamp(Math.round(v * 10) / 10, 40, 240);
    setBpmText(String(bpm));
    setAnalysis({ ...analysis, bpm, tempoGuessed: false });
    if (quant > 0) setNotes((ns) => quantized(ns, analysis.raw, 60 / bpm, quant));
  };
  const applyQuant = (g: number) => {
    setQuant(g);
    if (analysis) setNotes((ns) => quantized(ns, analysis.raw, spb, g));
  };

  const insert = async (target: 'current' | 'new') => {
    if (!analysis || !source) return;
    stopPlay();
    try {
      if (target === 'new') {
        await A.newProject(undefined, `${source.name} idea`);
        useStore.getState().project.tracks.forEach((t) => A.removeTrack(t.id));
        A.setBpm(analysis.bpm);
        if (!rhythm) A.setKey(analysis.key.root, analysis.key.scale);
      } else if (adoptTempo && projectEmpty) {
        A.setBpm(analysis.bpm);
      }
      const p = useStore.getState().project;
      const pspb = 60 / p.bpm;
      const pbar = barBeats(p.timeSig);
      const at = target === 'new' ? 0 : Math.ceil(engine.beat / pbar - 1e-6) * pbar;
      const conv = (ns: Note[], scale: number): Note[] => ns.map((n) => ({ ...n, id: uid(), start: (n.start * scale) / pspb, duration: (n.duration * scale) / pspb, bend: bends ? n.bend : undefined }));
      const length = Math.max(pbar, Math.ceil(Math.max(...notes.map((n) => n.start + n.duration)) / pspb / pbar - 1e-6) * pbar);
      const def = getInstrument(instrumentId);
      const melodyTrack = A.addTrack('instrument', instrumentId, rhythm ? 'Beat from voice' : `${def?.name ?? 'Melody'} melody`);
      A.addMidiClip(melodyTrack, at, length, conv(notes, 1), rhythm ? 'Beat' : 'Melody');
      if (suggestions) {
        const addPart = (on: boolean, inst: string, name: string, ns: Note[]) => {
          if (!on) return;
          const id = A.addTrack('instrument', inst, name);
          A.addMidiClip(id, at, length, conv(ns, spb), name);
        };
        addPart(sugg.chords, 'grand-piano', 'Chords', suggestions.chordNotes);
        addPart(sugg.bass, 'electric-bass', 'Bass', suggestions.bass);
        addPart(sugg.drums, 'studio-kit', 'Drums', suggestions.drums);
        addPart(sugg.harmony, instrumentId, 'Harmony', suggestions.harmony);
      }
      if (includeAudio) {
        const meta = source.blob ? await importAudio(source.blob, source.name) : await addBufferAsset(source.buffer, source.name);
        const audioTrack = A.addTrack('audio', null, 'Original recording');
        A.addAudioClip(audioTrack, meta, at, { offset: analysis.offsetSec, length: Math.max(0.1, meta.duration - analysis.offsetSec) });
        A.updateTrack(audioTrack, { mute: true });
      }
      A.selectTrack(melodyTrack);
      A.seek(at);
      toast(`Added ${notes.length} notes${includeAudio ? ' and the original recording (muted)' : ''} to the studio.`, 'success');
      navigate('studio');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The arrangement could not be inserted.', 'error');
    }
  };

  const drumRows = useMemo(() => [...kitPads(instrumentId)].reverse().map((pitch) => ({ pitch, label: drumSound(pitch)?.name ?? String(pitch) })), [instrumentId]);
  const def = getInstrument(instrumentId);
  const quick = rhythm ? QUICK_RHYTHM : QUICK_MELODY;

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div className="grow">
            <h1 className="title">Voice to instrument</h1>
            <p className="sub">Hum, sing or tap an idea. The notes you performed are detected and written as editable MIDI, then played by any instrument.</p>
          </div>
        </div>

        <div className="cols-2">
          <section className="panel pad col" style={{ gap: 14 }} aria-label="Record or upload">
            <h2 className="section-title">1. Record or upload</h2>
            <div className="row wrap">
              {recording ? (
                <button className="btn lg danger" onClick={() => void stopRec()}><Square fill="currentColor" />Stop <span ref={timer} className="num">0:00</span></button>
              ) : (
                <button className="btn lg primary" onClick={() => void startRec()} disabled={!!busy}><Circle fill="var(--record)" stroke="var(--record)" />Record</button>
              )}
              <button className="btn lg" onClick={() => fileInput.current?.click()} disabled={recording || !!busy}><Upload />Upload audio</button>
              <input ref={fileInput} type="file" accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }} />
            </div>
            <div className="col" style={{ gap: 5 }}>
              <span className="label">{recording ? `Recording… up to ${MAX_RECORD_SECONDS / 60} minutes` : 'Microphone level while recording'}</span>
              <div className="level"><i ref={level} /></div>
            </div>
            {source ? (
              <div className="col" style={{ gap: 6 }}>
                <SourceWave source={source} />
                <span className="faint num" style={{ fontSize: 12 }}>{source.name} · {formatTime(source.buffer.duration, false)} · {source.buffer.sampleRate} Hz</span>
              </div>
            ) : (
              <Hint>One clear voice or instrument works best. Ten to thirty seconds is plenty to start a song.</Hint>
            )}
            {error && <div className="error-box" role="alert">{error}</div>}
          </section>

          <section className="panel pad col" style={{ gap: 14 }} aria-label="Detection settings">
            <h2 className="section-title">2. Detect the notes</h2>
            <div className="field">
              <span>What did you record?</span>
              <div className="seg" style={{ alignSelf: 'flex-start' }}>
                {([['auto', 'Decide for me'], ['melody', 'Melody'], ['rhythm', 'Rhythm']] as const).map(([id, label]) => (
                  <button key={id} className={mode === id ? 'on' : ''} onClick={() => { setMode(id); if (source && !busy) void analyze(source, id); }}>{label}</button>
                ))}
              </div>
              <Hint>Melody finds pitches for humming and singing. Rhythm finds the hits in tapping or beatboxing and maps them to kick, snare and hi-hat.</Hint>
            </div>
            <label className="t-field"><Switch on={useModel} onChange={setUseModel} label="Use Basic Pitch" />Use the Basic Pitch neural model (for instruments and chords; slower)</label>
            {advanced && <label className="t-field"><Switch on={single} onChange={setSingle} label="Single melody line" />Keep a single melody line (turn off for chords)</label>}
            {busy ? (
              <div className="col">
                <div className="row"><LoaderCircle className="spin" style={{ width: 16, height: 16 }} /><span>{busy.text}</span></div>
                <div className="progress"><i style={{ width: `${Math.round(busy.progress * 100)}%` }} /></div>
              </div>
            ) : analysis ? (
              <div className="stat-strip">
                <div><b className="num">{notes.length}</b><span>{rhythm ? 'hits' : 'notes'}</span></div>
                <div><b className="num">{analysis.bpm}</b><span>BPM {analysis.tempoGuessed ? '(default)' : 'estimated'}</span></div>
                <div><b>{rhythm ? '—' : `${NOTE_NAMES[analysis.key.root]} ${analysis.key.scale === 'minor' ? 'minor' : 'major'}`}</b><span>key estimate</span></div>
                <div><b style={{ fontSize: 14, lineHeight: '28px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={analysis.engine}>{analysis.engine.replace('Spotify ', '').replace('Built-in pitch tracker (YIN)', 'Pitch tracker').replace('Spectral-flux onset detector', 'Onset detector')}</b><span>detector</span></div>
              </div>
            ) : (
              <div className="empty">Record or upload something and the detected notes will appear below.</div>
            )}
            {analysis?.note && <div className="notice">{analysis.note}</div>}
            {source && !busy && <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => void analyze(source)}>Analyse again</button>}
            <p className="hint">Transcription is an estimate. Expect a few wrong or missing notes, especially with breathy singing or background noise, and fix them in the editor below.</p>
          </section>
        </div>

        {analysis && source && (
          <>
            <section className="panel" aria-label="Edit and preview">
              <div className="row wrap" style={{ padding: '14px 16px 12px', gap: 10 }}>
                <button className="play-btn" aria-label={playing ? 'Stop preview' : 'Play preview'} onClick={() => (playing ? stopPlay() : void play())}>
                  {playing ? <Square fill="currentColor" /> : <Play fill="currentColor" style={{ marginLeft: 2 }} />}
                </button>
                <div className="col" style={{ gap: 4 }}>
                  <span className="label">3. Choose the instrument</span>
                  <div className="row wrap" style={{ gap: 4 }}>
                    {quick.map((id) => (
                      <button key={id} className={`btn sm ${instrumentId === id ? 'primary' : ''}`} style={{ borderRadius: 7 }} onClick={() => { setInstrumentId(id); if (!handle.current) void play(); }}>{getInstrument(id)?.name}</button>
                    ))}
                    <select className="select" aria-label="All instruments" value={instrumentId} onChange={(e) => setInstrumentId(e.target.value)} style={{ height: 28 }}>
                      {CATEGORIES.map((c) => (
                        <optgroup key={c.id} label={c.name}>
                          {INSTRUMENTS.filter((i) => i.category === c.id && (rhythm ? i.engine === 'drums' : i.engine !== 'drums')).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="grow" />
                <label className="t-field">Tempo
                  <input className="input t-num num" inputMode="decimal" aria-label="Tempo" value={bpmText} onChange={(e) => setBpmText(e.target.value)} onBlur={(e) => setTempo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
                </label>
                <label className="t-field">Timing
                  <select className="select" aria-label="Quantize" value={quant} onChange={(e) => applyQuant(Number(e.target.value))}>
                    <option value={0}>Natural (as performed)</option>
                    <option value={0.5}>Snap to 1/8 notes</option>
                    <option value={0.25}>Snap to 1/16 notes</option>
                    <option value={1 / 3}>Snap to triplets</option>
                    <option value={1}>Snap to beats</option>
                  </select>
                </label>
                {!rhythm && <label className="t-field" title="Slides and vibrato from your voice are replayed on sampled instruments"><Switch on={bends} onChange={setBends} label="Expressive pitch bends" />Pitch bends</label>}
                <label className="t-field"><Switch on={withOriginal} onChange={setWithOriginal} label="Play the original recording too" />Original</label>
              </div>
              <div style={{ height: 380, borderTop: '1px solid var(--rule)' }}>
                <PianoRoll
                  viewKey={`${source.name}-${analysis.kind}-${analysis.raw.size}`}
                  notes={beatNotes} length={lengthBeats} color={rhythm ? '#4fc3e8' : '#8f7cf7'} snap={quant} timeSig={[4, 4]} musicKey={analysis.key}
                  onChange={(next) => setNotes(next.map((n) => ({ ...n, start: n.start * spb, duration: n.duration * spb })))}
                  onGestureStart={() => {}} onGestureEnd={() => {}}
                  onAudition={(pitch, velocity) => void engine.previewNote(instrumentId, pitch, 0.35, velocity)}
                  range={def && !rhythm ? def.range : undefined}
                  drumRows={rhythm ? drumRows : undefined}
                  getPlayhead={() => (handle.current ? (handle.current.position() - analysis.offsetSec) / spb : cursor.current)}
                  onSeek={(b) => { cursor.current = b; if (handle.current) void play(analysis.offsetSec + b * spb); }}
                  backdrop={{ buffer: source.buffer, offsetSec: analysis.offsetSec, bpm: analysis.bpm }}
                />
              </div>
              <p className="hint" style={{ padding: '10px 16px 14px' }}>
                The blue lane is your recording; the notes below it are what was detected. Drag a note to fix its pitch or timing, drag its right edge to change its length, click empty space to add one, right-click to delete. Changing the tempo moves the grid, not your notes.
              </p>
            </section>

            <div className="cols-2">
              <section className="panel pad col" style={{ gap: 10 }} aria-label="Accompaniment suggestions">
                <h2 className="section-title">4. Add accompaniment (optional)</h2>
                {rhythm || !suggestions ? (
                  <div className="empty">Suggestions are made from a melody. For a beat, add instruments in the composer after inserting it.</div>
                ) : (
                  <>
                    <div className="row wrap">
                      <label className="t-field">Key
                        <select className="select" aria-label="Key" value={analysis.key.root} onChange={(e) => setAnalysis({ ...analysis, key: { ...analysis.key, root: Number(e.target.value) } })}>{NOTE_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}</select>
                        <select className="select" aria-label="Scale" value={analysis.key.scale} onChange={(e) => setAnalysis({ ...analysis, key: { ...analysis.key, scale: e.target.value as ScaleName } })}>
                          {(['major', 'minor'] as ScaleName[]).map((s) => <option key={s} value={s}>{SCALES[s].name}</option>)}
                        </select>
                      </label>
                    </div>
                    <div className="list">
                      {([['chords', 'Piano chords', suggestions.chords.map((c) => c.label).join('  ·  ')], ['bass', 'Bassline', 'Follows the chord roots'], ['drums', 'Drums', 'Kick, snare and hi-hat'], ['harmony', 'Harmony line', 'A third below the melody, in key']] as const).map(([id, name, detail]) => (
                        <div key={id} className="list-row" style={{ minHeight: 46 }}>
                          <Switch on={sugg[id]} onChange={(v) => setSugg({ ...sugg, [id]: v })} label={name} />
                          <span className="grow"><span className="name" style={{ display: 'block' }}>{name}</span><span className="meta" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail}</span></span>
                        </div>
                      ))}
                    </div>
                    <p className="hint">These are written with music-theory rules from the detected key, as a starting point. Turn them on to hear them in the preview; everything stays editable after inserting.</p>
                  </>
                )}
              </section>

              <section className="panel pad col" style={{ gap: 12 }} aria-label="Insert into the studio">
                <h2 className="section-title">5. Send it to the studio</h2>
                <label className="t-field"><Switch on={includeAudio} onChange={setIncludeAudio} label="Include the original recording" />Include the original recording on its own muted track</label>
                {projectEmpty
                  ? <label className="t-field"><Switch on={adoptTempo} onChange={setAdoptTempo} label="Use detected tempo" />Set the open project to {analysis.bpm} BPM</label>
                  : analysis.bpm !== projectBpm && <div className="notice">The open project is at {projectBpm} BPM and this idea is at {analysis.bpm} BPM. Added to the project it keeps its real speed but will not sit on the project’s grid; a new project uses the detected tempo.</div>}
                <div className="row wrap">
                  <button className="btn primary" onClick={() => void insert('current')}>Add to the open project</button>
                  <button className="btn" onClick={() => void insert('new')}>New project from this</button>
                </div>
                <Hint>The melody arrives as a normal instrument track. Change its instrument, edit the notes, add piano and drums, record vocals over it and export.</Hint>
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
