import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Circle, Download, Headphones, LoaderCircle, Play, Plus, Redo2, Square, Trash2, Undo2, Upload, X } from 'lucide-react';
import { engine, type SeqHandle, type SeqPart } from '../audio/engine';
import { mic } from '../audio/recorder';
import { renderProject } from '../audio/render';
import type { Note, Project, ScaleName } from '../types';
import { familyOf, type RenderMode } from '../lib/articulate';
import type { VoiceAnalysis } from '../lib/dsp/analyze';
import { startAnalysis, type AnalysisJob } from '../lib/dsp/analyzeClient';
import { basicPitchDetect } from '../lib/dsp/basicPitch';
import { monophonize, type DetectedNote, type NoteIssue } from '../lib/dsp/pitch';
import { estimateTempo } from '../lib/dsp/rhythm';
import { CATEGORIES, INSTRUMENTS, drumSound, getInstrument, kitPads } from '../lib/instruments';
import { projectToMidi } from '../lib/midi';
import { NOTE_NAMES, SCALES, barBeats, clamp, detectKey, formatTime, midiToName, uid, type Key } from '../lib/music';
import { drawWaveform, fitCanvas } from '../lib/peaks';
import { createProject, newTrack } from '../lib/templates';
import { STYLES, arrange, quantize, type Accompaniment, type Layer, type Style } from '../lib/voiceArrange';
import { downloadBlob, encodeWav, safeName, toMono, toPcm } from '../lib/wav';
import { A, addBufferAsset, importAudio, navigate, toast, useStore } from '../store/store';
import { PianoRoll } from '../components/PianoRoll';
import { Hint, Slider, Switch, useFrame, useSize } from '../components/ui';

type Mode = 'auto' | 'melody' | 'poly' | 'rhythm';
type Compare = 'instrument' | 'original' | 'both';
interface Source { buffer: AudioBuffer; name: string; blob: Blob | null }
interface Analysis {
  kind: 'melody' | 'rhythm';
  detector: string;
  reason: string;
  bpm: number;
  tempoGuessed: boolean;
  offsetSec: number; // time of the first detected note; beat 0 of the grid
  key: Key;
  contour: { hopSec: number; pitch: Float32Array } | null;
  stats: VoiceAnalysis['stats'] | null;
}
interface Flag { confidence: number; issue?: NoteIssue }
interface Snapshot { notes: Note[]; flags: Map<string, Flag> }

const QUICK_MELODY: [string, string][] = [['grand-piano', 'Piano'], ['violin', 'Violin'], ['acoustic-guitar', 'Guitar'], ['flute', 'Flute'], ['electric-bass', 'Bass'], ['saw-lead', 'Synth']];
const QUICK_RHYTHM: [string, string][] = [['studio-kit', 'Studio kit'], ['electro-kit', 'Electronic'], ['lofi-kit', 'Lo-fi'], ['rock-kit', 'Rock']];
const MAX_RECORD_SECONDS = 120;
const FLAG_BELOW = 0.6;
const ISSUE_TEXT: Record<NoteIssue, string> = {
  between: 'Sung between two notes, so it may belong a semitone higher or lower.',
  unclear: 'The pitch was unsteady or breathy here.',
  octave: 'A leap of an octave or more: check that it is in the right octave.',
  short: 'Very short: it may be a slip rather than a note.',
};
const MODES: [Mode, string, string][] = [
  ['auto', 'Decide for me', 'Listens first, then picks the right detector'],
  ['melody', 'Melody', 'Humming, singing or whistling: one note at a time'],
  ['poly', 'Instrument or chords', 'Several notes at once: uses the Basic Pitch model'],
  ['rhythm', 'Beatbox or tapping', 'Hits become kick, snare and hi-hat'],
];
const newLayer = (instrumentId: string, on = true): Layer => ({ id: uid(), instrumentId, gain: 0.85, octave: 'auto', on });

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
  const [single, setSingle] = useState(false);
  const [busy, setBusy] = useState<{ text: string; progress: number } | null>(null);
  const [error, setError] = useState('');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [notes, setNotes] = useState<Note[]>([]); // seconds from analysis.offsetSec, timing as performed (or as edited)
  const [flags, setFlags] = useState<Map<string, Flag>>(new Map());
  const [, setHistoryTick] = useState(0);
  const [layers, setLayers] = useState<Layer[]>([newLayer('violin')]);
  const [solo, setSolo] = useState<string | null>(null);
  const [renderMode, setRenderMode] = useState<RenderMode>('natural');
  const [compare, setCompare] = useState<Compare>('instrument');
  const [grid, setGrid] = useState(0);
  const [strength, setStrength] = useState(1);
  const [acc, setAcc] = useState<Accompaniment>({ chords: false, bass: false, drums: false, harmony: false, style: 'pop', intensity: 0.5, level: 0.8 });
  const [includeAudio, setIncludeAudio] = useState(true);
  const [adoptTempo, setAdoptTempo] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [bpmText, setBpmText] = useState('');
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  const [exporting, setExporting] = useState('');
  const handle = useRef<SeqHandle | null>(null);
  const playToken = useRef(0);
  const stopAt = useRef(0);
  const cursor = useRef(0); // beats
  const recStart = useRef(0);
  const job = useRef<AnalysisJob | null>(null);
  const run = useRef(0);
  const history = useRef<{ past: Snapshot[]; future: Snapshot[]; gesture: Snapshot | null }>({ past: [], future: [], gesture: null });
  const timer = useRef<HTMLSpanElement>(null);
  const level = useRef<HTMLElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const bpm = analysis?.bpm ?? 100;
  const spb = 60 / bpm;
  const rhythm = analysis?.kind === 'rhythm';

  // What is shown, played and exported: the performed timing pulled towards the grid.
  const shown = useMemo(() => (grid > 0 && strength > 0 ? notes.map((n) => ({ ...n, ...quantize(n.start, n.duration, spb, grid, strength) })) : notes), [notes, grid, strength, spb]);
  const beatNotes = useMemo(() => shown.map((n) => ({ ...n, start: n.start / spb, duration: n.duration / spb })), [shown, spb]);
  const anyAcc = acc.chords || acc.bass || acc.drums || acc.harmony;
  const arrangement = useMemo(() => (analysis
    ? arrange({ notes: shown, rhythm: !!rhythm, bpm, key: analysis.key, layers, mode: renderMode, accompaniment: !rhythm && anyAcc ? acc : null })
    : null), [analysis, shown, rhythm, bpm, layers, renderMode, acc, anyAcc]);
  const lengthBeats = arrangement?.lengthBeats ?? 4;
  const flagged = useMemo(() => new Set([...flags.keys()].filter((id) => notes.some((n) => n.id === id))), [flags, notes]);
  const toCheck = useMemo(() => shown.filter((n) => flagged.has(n.id)).sort((a, b) => a.start - b.start), [shown, flagged]);
  const focused = focus ? shown.find((n) => n.id === focus.id) ?? null : null;
  const contour = useMemo(() => (analysis?.contour && !rhythm && grid === 0
    ? { startBeat: -analysis.offsetSec / spb, stepBeat: analysis.contour.hopSec / spb, midi: analysis.contour.pitch }
    : null), [analysis, rhythm, grid, spb]);

  const stopPlay = () => { playToken.current++; handle.current?.stop(); handle.current = null; stopAt.current = 0; setPlaying(false); };
  useEffect(() => () => { handle.current?.stop(); job.current?.cancel(); if (recStart.current) void mic.stop().catch(() => {}); }, []);

  const previewParts = (): SeqPart[] => {
    if (!analysis || !arrangement) return [];
    const off = analysis.offsetSec;
    const parts = solo ? arrangement.parts.filter((p) => p.id === solo) : arrangement.parts;
    return parts.map((p) => ({ instrumentId: p.instrumentId, notes: p.notes.map((n) => ({ pitch: n.pitch, time: off + n.start, duration: n.duration, velocity: n.velocity, bend: n.bend, dyn: n.dyn, legato: n.legato })) }));
  };

  const play = async (fromSec?: number, untilSec?: number) => {
    if (!analysis || !source) return;
    const token = ++playToken.current;
    handle.current?.stop();
    A.stop();
    const from = fromSec ?? (cursor.current <= 0 ? Math.max(0, analysis.offsetSec - 0.2) : analysis.offsetSec + cursor.current * spb);
    const parts = compare === 'original' ? [] : previewParts();
    const audio = compare === 'instrument' ? null : { buffer: source.buffer, gain: compare === 'both' ? 0.7 : 1 };
    const h = await engine.playSequence(parts, audio, from, () => { if (handle.current === h) { handle.current = null; cursor.current = 0; stopAt.current = 0; setPlaying(false); } });
    if (token !== playToken.current) { h.stop(); return; } // something else was started while the sounds were loading
    handle.current = h;
    stopAt.current = untilSec ?? 0;
    setPlaying(true);
  };

  // Changing what is heard while it plays restarts from the same spot, for instant comparison.
  useEffect(() => {
    if (handle.current) void play(Math.max(0, handle.current.position()), stopAt.current || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, solo, renderMode, compare, acc]);

  // ---- note editing with undo ------------------------------------------------
  const bump = () => setHistoryTick((v) => v + 1);
  const remember = (snap: Snapshot) => { const h = history.current; h.past.push(snap); if (h.past.length > 100) h.past.shift(); h.future = []; bump(); };
  const commit = (next: Note[], nextFlags: Map<string, Flag> = flags) => { remember({ notes, flags }); setNotes(next); setFlags(nextFlags); };
  const undo = () => { const h = history.current; const s = h.past.pop(); if (!s) return; h.future.push({ notes, flags }); setNotes(s.notes); setFlags(s.flags); bump(); };
  const redo = () => { const h = history.current; const s = h.future.pop(); if (!s) return; h.past.push({ notes, flags }); setNotes(s.notes); setFlags(s.flags); bump(); };

  /** Notes coming back from the piano roll (in beats, on the quantized view) become performed-time notes again. */
  const fromRoll = (next: Note[]): { notes: Note[]; flags: Map<string, Flag> } => {
    const before = new Map(beatNotes.map((n) => [n.id, n]));
    const natural = new Map(notes.map((n) => [n.id, n]));
    const nextFlags = new Map(flags);
    const out = next.map((n) => {
      const b = before.get(n.id), orig = natural.get(n.id);
      const moved = !b || Math.abs(b.start - n.start) > 1e-6 || Math.abs(b.duration - n.duration) > 1e-6;
      if (!b || !orig) return { ...n, start: n.start * spb, duration: n.duration * spb };
      if (moved || b.pitch !== n.pitch) nextFlags.delete(n.id); // corrected by hand: no longer in question
      // a note that was not moved keeps its performed timing, so changing the grid later still starts from what was sung
      return moved ? { ...n, start: n.start * spb, duration: n.duration * spb } : { ...orig, pitch: n.pitch, velocity: n.velocity, bend: b.pitch !== n.pitch ? undefined : orig.bend };
    });
    return { notes: out, flags: nextFlags };
  };
  const onRollChange = (next: Note[], live: boolean) => {
    const r = fromRoll(next);
    if (live) { setNotes(r.notes); setFlags(r.flags); } else commit(r.notes, r.flags);
  };
  const editFocused = (change: (n: Note) => Note | null) => {
    if (!focus) return;
    const nextFlags = new Map(flags);
    nextFlags.delete(focus.id);
    commit(notes.flatMap((n) => { if (n.id !== focus.id) return [n]; const c = change(n); return c ? [c] : []; }), nextFlags);
  };

  // ---- review of uncertain notes --------------------------------------------
  const goTo = (n: Note) => {
    if (!analysis) return;
    setFocus({ id: n.id, nonce: Date.now() });
    cursor.current = n.start / spb;
    void play(Math.max(0, analysis.offsetSec + n.start - 0.35), analysis.offsetSec + n.start + n.duration + 0.35);
  };
  const step = (dir: 1 | -1) => {
    if (!toCheck.length) return;
    const at = focused ? toCheck.findIndex((n) => n.id === focused.id) : -1;
    const i = at < 0 ? (dir === 1 ? 0 : toCheck.length - 1) : (at + dir + toCheck.length) % toCheck.length;
    goTo(toCheck[i]);
  };
  const accept = () => {
    if (!focused) return;
    const rest = toCheck.filter((n) => n.id !== focused.id);
    const at = toCheck.findIndex((n) => n.id === focused.id);
    const nextFlags = new Map(flags);
    nextFlags.delete(focused.id);
    remember({ notes, flags });
    setFlags(nextFlags);
    if (rest.length) goTo(rest[Math.min(at, rest.length - 1)]); else { setFocus(null); stopPlay(); }
  };

  // ---- analysis ----------------------------------------------------------------
  const analyze = async (src: Source, want: Mode = mode) => {
    job.current?.cancel();
    stopPlay();
    setError('');
    setBusy({ text: 'Preparing the recording…', progress: 0 });
    const id = ++run.current;
    const current = () => id === run.current;
    try {
      let kind: Analysis['kind'] = 'melody';
      let detected: DetectedNote[] = [];
      let detector = '', reason = '';
      let tempo: number | null = null;
      let contour: Analysis['contour'] = null;
      let stats: Analysis['stats'] = null;
      const neural = async (from: number): Promise<DetectedNote[]> => {
        setBusy({ text: 'Loading the Basic Pitch model…', progress: from });
        const out = await basicPitchDetect(src.buffer, (f) => { if (current()) setBusy({ text: 'Running the Basic Pitch model…', progress: from + (1 - from) * f }); });
        return single ? monophonize(out) : out;
      };
      if (want === 'poly') {
        detected = await neural(0);
        detector = 'Basic Pitch model';
        reason = 'Analysed with the Basic Pitch model, as chosen.';
      } else {
        const share = want === 'auto' ? 0.85 : 1;
        job.current = startAnalysis(toMono(src.buffer), src.buffer.sampleRate, want, (f, stage) => { if (current()) setBusy({ text: stage, progress: f * share }); });
        const res = await job.current.result;
        if (!current()) return;
        stats = res.stats;
        reason = res.reason;
        tempo = res.bpm;
        if (res.kind === 'rhythm') { kind = 'rhythm'; detected = res.notes; detector = 'Onset detector'; }
        else if (res.kind === 'poly') {
          try {
            const out = await neural(share);
            if (out.length) { detected = out; detector = 'Basic Pitch model'; tempo = null; }
          } catch { /* handled just below */ }
          if (!detected.length) {
            detected = res.notes; detector = 'Pitch tracker'; contour = res.contour;
            reason = 'This sounded like several notes at once, but the Basic Pitch model could not be used here, so the single-line pitch tracker was used instead. Expect mistakes.';
          }
        } else { detected = res.notes; detector = 'Pitch tracker'; contour = res.contour; }
      }
      if (!current()) return;
      if (!detected.length) {
        throw new Error(kind === 'rhythm'
          ? 'No clear hits were found. Try tapping or beatboxing closer to the microphone.'
          : 'No clear notes were found. Try humming closer to the microphone, with less background noise, or choose “Beatbox or tapping”.');
      }
      detected = [...detected].sort((a, b) => a.start - b.start);
      tempo ??= estimateTempo(detected.map((n) => ({ time: n.start, strength: n.velocity })));
      const offsetSec = detected[0].start;
      const nextFlags = new Map<string, Flag>();
      const ns: Note[] = detected.map((d) => {
        const nid = uid();
        if (d.confidence !== undefined && (d.confidence < FLAG_BELOW || d.issue)) nextFlags.set(nid, { confidence: d.confidence, issue: d.issue });
        return { id: nid, pitch: d.pitch, start: d.start - offsetSec, duration: d.duration, velocity: d.velocity, bend: d.bend, dyn: d.dyn };
      });
      history.current = { past: [], future: [], gesture: null };
      setNotes(ns);
      setFlags(nextFlags);
      setFocus(null);
      setAnalysis({ kind, detector, reason, bpm: tempo ?? 100, tempoGuessed: tempo === null, offsetSec, key: detectKey(detected), contour, stats });
      setBpmText(String(tempo ?? 100));
      setGrid(0);
      setSolo(null);
      cursor.current = 0;
      // keep the chosen sounds when the kind of material has not changed
      setLayers((cur) => { const drums = cur.every((l) => getInstrument(l.instrumentId)?.engine === 'drums'); return kind === 'rhythm' ? (drums ? cur : [newLayer('studio-kit')]) : drums ? [newLayer('violin')] : cur; });
    } catch (e) {
      if (!current()) return;
      setAnalysis(null);
      setNotes([]);
      setError(e instanceof Error ? e.message : 'The recording could not be analysed.');
    } finally {
      if (current()) { setBusy(null); job.current = null; }
    }
  };
  const cancelAnalysis = () => { run.current++; job.current?.cancel(); job.current = null; setBusy(null); };
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
    // a short excerpt (reviewing one note) stops by itself
    if (stopAt.current && handle.current && handle.current.position() >= stopAt.current) stopPlay();
  });

  const setTempo = (text: string) => {
    const v = parseFloat(text);
    if (!analysis || !Number.isFinite(v)) { setBpmText(String(analysis?.bpm ?? '')); return; }
    const next = clamp(Math.round(v * 10) / 10, 40, 240);
    setBpmText(String(next));
    setAnalysis({ ...analysis, bpm: next, tempoGuessed: false });
  };

  // ---- layers ------------------------------------------------------------------
  const patchLayer = (id: string, patch: Partial<Layer>) => setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const addLayer = (instrumentId: string) => { setLayers((ls) => [...ls, newLayer(instrumentId)]); };
  const removeLayer = (id: string) => { setLayers((ls) => (ls.length > 1 ? ls.filter((l) => l.id !== id) : ls)); if (solo === id) setSolo(null); };
  const listenAlone = (id: string) => {
    const next = solo === id ? null : id;
    setSolo(next);
    setCompare((c) => (c === 'original' ? 'instrument' : c));
    if (next && !handle.current) window.setTimeout(() => void play(), 0);
  };

  // ---- sending the result somewhere -------------------------------------------
  /** The arrangement as a self-contained project (used for the WAV and MIDI downloads). */
  const asProject = (): Project | null => {
    if (!analysis || !arrangement || !source) return null;
    const p = createProject(`${source.name} idea`);
    p.tracks = []; p.clips = [];
    p.bpm = analysis.bpm;
    if (!rhythm) p.key = { root: analysis.key.root, scale: analysis.key.scale };
    for (const part of arrangement.parts) {
      const t = newTrack(part.name, part.instrumentId);
      p.tracks.push(t);
      p.clips.push({ id: uid(), type: 'midi', trackId: t.id, name: part.name, start: 0, length: arrangement.lengthBeats, notes: part.notes.map((n) => ({ ...n, id: uid(), start: n.start / spb, duration: n.duration / spb })) });
    }
    return p;
  };
  const download = async (kind: 'wav' | 'midi') => {
    const p = asProject();
    if (!p || !p.tracks.length) { toast('Switch on at least one instrument first.', 'info'); return; }
    stopPlay();
    try {
      if (kind === 'midi') {
        downloadBlob(new Blob([projectToMidi(p) as BlobPart], { type: 'audio/midi' }), `${safeName(p.name)}.mid`);
        toast('MIDI file saved. Pitch slides and swells are not part of MIDI notes and are left out.', 'success');
      } else {
        setExporting('Rendering the audio…');
        const mix = await renderProject(p, engine.buffers);
        downloadBlob(encodeWav(toPcm(mix), 16), `${safeName(p.name)}.wav`);
        toast('WAV file saved.', 'success');
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The file could not be made.', 'error');
    } finally {
      setExporting('');
    }
  };

  const insert = async (target: 'current' | 'new') => {
    if (!analysis || !source || !arrangement) return;
    if (!arrangement.parts.length) { toast('Switch on at least one instrument first.', 'info'); return; }
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
      const end = Math.max(...arrangement.parts.flatMap((part) => part.notes.map((n) => n.start + n.duration)));
      const length = Math.max(pbar, Math.ceil(end / pspb / pbar - 1e-6) * pbar);
      let first = '';
      for (const part of arrangement.parts) {
        const id = A.addTrack('instrument', part.instrumentId, part.name);
        first ||= id;
        A.addMidiClip(id, at, length, part.notes.map((n) => ({ ...n, id: uid(), start: n.start / pspb, duration: n.duration / pspb })), part.role === 'lead' ? (rhythm ? 'Beat' : 'Melody') : part.name);
      }
      if (includeAudio) {
        const meta = source.blob ? await importAudio(source.blob, source.name) : await addBufferAsset(source.buffer, source.name);
        const audioTrack = A.addTrack('audio', null, 'Original recording');
        A.addAudioClip(audioTrack, meta, at, { offset: analysis.offsetSec, length: Math.max(0.1, meta.duration - analysis.offsetSec) });
        A.updateTrack(audioTrack, { mute: true });
      }
      A.selectTrack(first);
      A.seek(at);
      toast(`Added ${arrangement.parts.length} track${arrangement.parts.length === 1 ? '' : 's'}${includeAudio ? ' and the original recording (muted)' : ''} to the studio.`, 'success');
      navigate('studio');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The arrangement could not be inserted.', 'error');
    }
  };

  const firstLayer = layers.find((l) => l.on) ?? layers[0];
  const firstDef = getInstrument(firstLayer?.instrumentId);
  const drumRows = useMemo(() => [...kitPads(firstLayer?.instrumentId)].reverse().map((pitch) => ({ pitch, label: drumSound(pitch)?.name ?? String(pitch) })), [firstLayer?.instrumentId]);
  const quick = rhythm ? QUICK_RHYTHM : QUICK_MELODY;
  const h = history.current;
  const meanConfidence = notes.length && analysis?.stats ? analysis.stats.meanConfidence : null;

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div className="grow">
            <h1 className="title">Voice to instrument</h1>
            <p className="sub">Hum, sing, whistle or beatbox an idea. The notes you performed are written down as editable MIDI and played by real instrument sounds.</p>
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
            <p className="hint">Your recording is analysed on this device and is not uploaded anywhere. What you get is your melody played by an instrument: the notes are transcribed and performed again. The sound of your voice itself is not turned into an instrument (that kind of audio-to-audio conversion needs a separate neural model and is not part of this app).</p>
          </section>

          <section className="panel pad col" style={{ gap: 14 }} aria-label="Detection settings">
            <h2 className="section-title">2. Detect the notes</h2>
            <div className="field">
              <span>What did you record?</span>
              <div className="voice-modes" role="radiogroup" aria-label="What did you record?">
                {MODES.map(([id, label, hint]) => (
                  <button key={id} role="radio" aria-checked={mode === id} className={`voice-mode ${mode === id ? 'on' : ''}`} disabled={!!busy} onClick={() => { setMode(id); if (source) void analyze(source, id); }}>
                    <span className="name">{label}</span><span className="meta">{hint}</span>
                  </button>
                ))}
              </div>
            </div>
            {(mode === 'poly' || advanced) && <label className="t-field"><Switch on={single} onChange={setSingle} label="Single melody line" />With the Basic Pitch model, keep only one melody line (off keeps chords)</label>}
            {busy ? (
              <div className="col" role="status">
                <div className="row"><LoaderCircle className="spin" style={{ width: 16, height: 16 }} /><span className="grow">{busy.text}</span><span className="num faint">{Math.round(busy.progress * 100)}%</span>
                  <button className="btn sm ghost" onClick={cancelAnalysis}>Cancel</button></div>
                <div className="progress"><i style={{ width: `${Math.round(busy.progress * 100)}%` }} /></div>
              </div>
            ) : analysis ? (
              <div className="stat-strip">
                <div><b className="num">{notes.length}</b><span>{rhythm ? 'hits' : 'notes'}{toCheck.length ? ` · ${toCheck.length} to check` : ''}</span></div>
                <div><b className="num">{analysis.bpm}</b><span>BPM {analysis.tempoGuessed ? '(default)' : 'estimated'}</span></div>
                <div><b>{rhythm ? '—' : `${NOTE_NAMES[analysis.key.root]} ${analysis.key.scale === 'minor' ? 'minor' : 'major'}`}</b><span>key estimate</span></div>
                <div><b className="num">{meanConfidence !== null ? `${Math.round(meanConfidence * 100)}%` : '—'}</b><span>confidence</span></div>
              </div>
            ) : (
              <div className="empty">Record or upload something and the detected notes will appear below.</div>
            )}
            {analysis && !busy && <p className="hint" style={{ color: 'var(--muted)' }}>{analysis.reason}{analysis.stats ? ` Analysed ${formatTime(analysis.stats.seconds, false)} of audio in ${(analysis.stats.tookMs / 1000).toFixed(1)} s.` : ''}</p>}
            {source && !busy && <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => void analyze(source)}>Analyse again</button>}
            <p className="hint">Transcription is an estimate. Expect a few wrong or missing notes, especially with breathy singing or background noise. Notes the detector was unsure about are outlined in amber so you can check them.</p>
          </section>
        </div>

        {analysis && source && (
          <>
            <section className="panel" aria-label="Edit and preview">
              <div className="voice-bar">
                <button className="play-btn" aria-label={playing ? 'Stop preview' : 'Play preview'} onClick={() => (playing ? stopPlay() : void play())}>
                  {playing ? <Square fill="currentColor" /> : <Play fill="currentColor" style={{ marginLeft: 2 }} />}
                </button>
                <div className="col" style={{ gap: 4 }}>
                  <span className="label">Listen to</span>
                  <div className="seg" role="group" aria-label="What to listen to">
                    {([['original', 'Your recording'], ['instrument', rhythm ? 'Drums' : 'Instrument'], ['both', 'Both']] as const).map(([id, label]) => (
                      <button key={id} className={compare === id ? 'on' : ''} aria-pressed={compare === id} onClick={() => setCompare(id)}>{label}</button>
                    ))}
                  </div>
                </div>
                {!rhythm && (
                  <div className="col" style={{ gap: 4 }}>
                    <span className="label">Performance</span>
                    <div className="seg" role="group" aria-label="Performance style">
                      {([['clean', 'Clean', 'Exact notes, even loudness, no slides'], ['natural', 'Natural', 'Your loudness, joined notes and a share of your slides'], ['expressive', 'Expressive', 'All of your slides, vibrato and swells, where the instrument can do them']] as const).map(([id, label, hint]) => (
                        <button key={id} className={renderMode === id ? 'on' : ''} aria-pressed={renderMode === id} title={hint} onClick={() => setRenderMode(id)}>{label}</button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="grow" />
                <label className="t-field">Tempo
                  <input className="input t-num num" inputMode="decimal" aria-label="Tempo" value={bpmText} onChange={(e) => setBpmText(e.target.value)} onBlur={(e) => setTempo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
                </label>
                <label className="t-field">Timing
                  <select className="select" aria-label="Snap timing to" value={grid} onChange={(e) => setGrid(Number(e.target.value))}>
                    <option value={0}>As performed</option>
                    <option value={0.5}>1/8 notes</option>
                    <option value={0.25}>1/16 notes</option>
                    <option value={1 / 3}>Triplets</option>
                    <option value={1}>Beats</option>
                  </select>
                </label>
                {grid > 0 && (
                  <label className="t-field" title="How far each note is pulled towards the grid">Strength
                    <Slider plain label="Timing correction strength" min={0} max={1} step={0.05} value={strength} reset={1} onChange={setStrength} className="voice-strength" />
                    <span className="num" style={{ width: 34 }}>{Math.round(strength * 100)}%</span>
                  </label>
                )}
                <div className="row" style={{ gap: 2 }}>
                  <button className="icon-btn" aria-label="Undo" title="Undo the last note change" disabled={!h.past.length} onClick={undo}><Undo2 /></button>
                  <button className="icon-btn" aria-label="Redo" title="Redo" disabled={!h.future.length} onClick={redo}><Redo2 /></button>
                </div>
              </div>

              {(toCheck.length > 0 || focused) && (
                <div className="voice-review" role="group" aria-label="Notes to check">
                  <span className="chip warn">{toCheck.length} to check</span>
                  <button className="icon-btn sm" aria-label="Previous note to check" disabled={!toCheck.length} onClick={() => step(-1)}><ChevronLeft /></button>
                  <button className="icon-btn sm" aria-label="Next note to check" disabled={!toCheck.length} onClick={() => step(1)}><ChevronRight /></button>
                  {focused ? (
                    <>
                      <span className="grow voice-review-text">
                        <b>{rhythm ? drumSound(focused.pitch)?.name ?? focused.pitch : midiToName(focused.pitch)}</b> at {formatTime(analysis.offsetSec + focused.start)}
                        {flags.get(focused.id) ? ` · ${Math.round(flags.get(focused.id)!.confidence * 100)}% sure. ${ISSUE_TEXT[flags.get(focused.id)!.issue ?? 'unclear']}` : ' · checked.'}
                      </span>
                      {!rhythm && (
                        <>
                          <button className="btn sm" onClick={() => editFocused((n) => ({ ...n, pitch: n.pitch - 1, bend: undefined }))}>−1 semitone</button>
                          <button className="btn sm" onClick={() => editFocused((n) => ({ ...n, pitch: n.pitch + 1, bend: undefined }))}>+1 semitone</button>
                          <button className="btn sm" onClick={() => editFocused((n) => ({ ...n, pitch: n.pitch - 12 }))}>Octave down</button>
                          <button className="btn sm" onClick={() => editFocused((n) => ({ ...n, pitch: n.pitch + 12 }))}>Octave up</button>
                        </>
                      )}
                      <button className="btn sm danger" onClick={() => editFocused(() => null)}><Trash2 />Remove</button>
                      {flags.has(focused.id) && <button className="btn sm" onClick={accept}><Check />Looks right</button>}
                    </>
                  ) : (
                    <span className="grow voice-review-text">Step through the notes the detector was unsure about. Each one plays as you reach it, in whatever you chose under “Listen to”.</span>
                  )}
                </div>
              )}

              <div style={{ height: 380, borderTop: '1px solid var(--rule)' }}>
                <PianoRoll
                  viewKey={`${source.name}-${analysis.kind}-${analysis.offsetSec}-${analysis.detector}`}
                  notes={beatNotes} length={lengthBeats} color={rhythm ? '#4fc3e8' : '#8f7cf7'} snap={grid} timeSig={[4, 4]} musicKey={analysis.key}
                  onChange={onRollChange}
                  onGestureStart={() => { history.current.gesture = { notes, flags }; }}
                  onGestureEnd={() => { const g = history.current.gesture; history.current.gesture = null; if (g) remember(g); }}
                  onAudition={(pitch, velocity) => { if (firstLayer) void engine.previewNote(firstLayer.instrumentId, pitch, 0.35, velocity); }}
                  range={firstDef && !rhythm ? firstDef.range : undefined}
                  drumRows={rhythm ? drumRows : undefined}
                  getPlayhead={() => (handle.current ? (handle.current.position() - analysis.offsetSec) / spb : cursor.current)}
                  onSeek={(b) => { cursor.current = b; if (handle.current) void play(analysis.offsetSec + b * spb); }}
                  backdrop={{ buffer: source.buffer, offsetSec: analysis.offsetSec, bpm: analysis.bpm }}
                  contour={contour} flagged={flagged} focus={focus}
                />
              </div>
              <p className="hint" style={{ padding: '10px 16px 14px' }}>
                Top lane: your recording. {contour ? 'Thin blue line: the pitch you sang. ' : ''}Blocks: the notes it was turned into, all on one time axis. Drag a note to fix its pitch or timing, drag its right edge for its length, drag in the bottom lane for its loudness, click empty space to add a note, right-click to delete. Changing the tempo moves the grid, not your notes.
              </p>
            </section>

            <div className="cols-2">
              <section className="panel pad col" style={{ gap: 12 }} aria-label="Instruments">
                <h2 className="section-title">3. {rhythm ? 'Choose the drum kit' : 'Choose the instruments'}</h2>
                <div className="list">
                  {layers.map((l) => {
                    const def = getInstrument(l.instrumentId);
                    const part = arrangement?.parts.find((p) => p.id === l.id);
                    const family = familyOf(def);
                    return (
                      <div key={l.id} className="voice-layer">
                        <Switch on={l.on} onChange={(v) => patchLayer(l.id, { on: v })} label={`Use ${def?.name ?? 'this instrument'}`} />
                        <select className="select grow" aria-label="Instrument" value={l.instrumentId} onChange={(e) => patchLayer(l.id, { instrumentId: e.target.value })}>
                          {CATEGORIES.map((c) => {
                            const items = INSTRUMENTS.filter((i) => i.category === c.id && (rhythm ? i.engine === 'drums' : i.engine !== 'drums'));
                            return items.length ? <optgroup key={c.id} label={c.name}>{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</optgroup> : null;
                          })}
                        </select>
                        {!rhythm && (
                          <select className="select" aria-label="Octave" title="Which octave the melody is played in" value={String(l.octave)} onChange={(e) => patchLayer(l.id, { octave: e.target.value === 'auto' ? 'auto' : Number(e.target.value) })}>
                            <option value="auto">Octave: fit</option>
                            {[2, 1, 0, -1, -2].map((o) => <option key={o} value={o}>{o === 0 ? 'As sung' : `${o > 0 ? '+' : ''}${o} octave${Math.abs(o) > 1 ? 's' : ''}`}</option>)}
                          </select>
                        )}
                        <Slider className="voice-level" label={`${def?.name ?? 'Layer'} level`} plain min={0.2} max={1} step={0.05} value={l.gain} reset={0.85} onChange={(v) => patchLayer(l.id, { gain: v })} />
                        <button className={`icon-btn sm ${solo === l.id ? 'on' : ''}`} aria-pressed={solo === l.id} aria-label={`Listen to ${def?.name ?? 'this layer'} alone`} title="Listen to this one alone" onClick={() => listenAlone(l.id)}><Headphones /></button>
                        <button className="icon-btn sm" aria-label={`Remove ${def?.name ?? 'this layer'}`} title="Remove" disabled={layers.length < 2} onClick={() => removeLayer(l.id)}><X /></button>
                        {!rhythm && part && (
                          <span className="meta">
                            {part.octaveShift ? `Moved ${Math.abs(part.octaveShift / 12)} octave${Math.abs(part.octaveShift) > 12 ? 's' : ''} ${part.octaveShift > 0 ? 'up' : 'down'} to fit the instrument. ` : ''}
                            {renderMode === 'clean' ? 'Plays the plain notes.'
                              : family === 'keys' || family === 'mallet' ? 'Cannot bend notes: your loudness becomes how hard each key is struck.'
                              : family === 'pluck' || family === 'bass' ? 'Plucked: notes ring and fade, slides into notes are kept, vibrato is not.'
                              : `Joined notes are slurred (${part.notes.filter((n) => n.legato).length} here); your slides and swells shape the sound.`}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="row wrap" style={{ gap: 6 }}>
                  <span className="label">Add a layer</span>
                  {quick.map(([id, label]) => <button key={id} className="btn sm" onClick={() => addLayer(id)}><Plus />{label}</button>)}
                </div>
                <Hint>Every layer plays the same melody, so you can stack instruments or switch layers on and off to compare versions. The headphones button plays one layer alone.</Hint>
              </section>

              <section className="panel pad col" style={{ gap: 10 }} aria-label="Accompaniment suggestions">
                <h2 className="section-title">4. Add accompaniment (optional)</h2>
                {rhythm || !arrangement ? (
                  <div className="empty">Suggestions are made from a melody. For a beat, add instruments in the composer after sending it to the studio.</div>
                ) : (
                  <>
                    <div className="row wrap">
                      <label className="t-field">Key
                        <select className="select" aria-label="Key" value={analysis.key.root} onChange={(e) => setAnalysis({ ...analysis, key: { ...analysis.key, root: Number(e.target.value) } })}>{NOTE_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}</select>
                        <select className="select" aria-label="Scale" value={analysis.key.scale} onChange={(e) => setAnalysis({ ...analysis, key: { ...analysis.key, scale: e.target.value as ScaleName } })}>
                          {(['major', 'minor'] as ScaleName[]).map((s) => <option key={s} value={s}>{SCALES[s].name}</option>)}
                        </select>
                      </label>
                      <label className="t-field">Style
                        <select className="select" aria-label="Style" value={acc.style} title={STYLES.find((s) => s.id === acc.style)?.hint} onChange={(e) => setAcc({ ...acc, style: e.target.value as Style })}>
                          {STYLES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </label>
                    </div>
                    <div className="fx-param"><span>Intensity</span><Slider plain label="Arrangement intensity" min={0} max={1} step={0.05} value={acc.intensity} reset={0.5} onChange={(v) => setAcc({ ...acc, intensity: v })} /><output className="num">{acc.intensity < 0.34 ? 'Sparse' : acc.intensity < 0.67 ? 'Medium' : 'Busy'}</output></div>
                    <div className="fx-param"><span>Level</span><Slider plain label="Accompaniment level" min={0.3} max={1} step={0.05} value={acc.level} reset={0.8} onChange={(v) => setAcc({ ...acc, level: v })} /><output className="num">{Math.round(acc.level * 100)}%</output></div>
                    <div className="list">
                      {([['chords', 'Chords', arrangement.chords.map((c) => c.label).join('  ·  ')], ['bass', 'Bassline', 'Follows the chord roots'], ['drums', 'Drums', 'Kick, snare and hi-hat'], ['harmony', 'Harmony line', 'A third below the melody, in key']] as const).map(([id, name, detail]) => (
                        <div key={id} className="list-row" style={{ minHeight: 44 }}>
                          <Switch on={acc[id]} onChange={(v) => setAcc({ ...acc, [id]: v })} label={name} />
                          <span className="grow" style={{ minWidth: 0 }}><span className="name" style={{ display: 'block' }}>{name}</span><span className="meta" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail}</span></span>
                        </div>
                      ))}
                    </div>
                    <p className="hint">These parts are written by music-theory rules from the detected key and your melody (not generated by an AI model), as a starting point. Everything stays editable in the studio.</p>
                  </>
                )}
              </section>
            </div>

            <section className="panel pad col" style={{ gap: 12 }} aria-label="Send or download">
              <h2 className="section-title">5. Use it</h2>
              <div className="row wrap" style={{ gap: 16 }}>
                <label className="t-field"><Switch on={includeAudio} onChange={setIncludeAudio} label="Include the original recording" />Include the original recording on its own muted track</label>
                {projectEmpty && <label className="t-field"><Switch on={adoptTempo} onChange={setAdoptTempo} label="Use detected tempo" />Set the open project to {analysis.bpm} BPM</label>}
              </div>
              {!projectEmpty && analysis.bpm !== projectBpm && <div className="notice">The open project is at {projectBpm} BPM and this idea is at {analysis.bpm} BPM. Added to the project it keeps its real speed but will not sit on the project’s grid; a new project uses the detected tempo.</div>}
              <div className="row wrap">
                <button className="btn primary" onClick={() => void insert('current')}>Add to the open project</button>
                <button className="btn" onClick={() => void insert('new')}>New project from this</button>
                <button className="btn" disabled={!!exporting} onClick={() => void download('wav')}>{exporting ? <LoaderCircle className="spin" /> : <Download />}{exporting || 'Download WAV'}</button>
                <button className="btn" disabled={!!exporting} onClick={() => void download('midi')}><Download />Download MIDI</button>
              </div>
              <Hint>Each instrument arrives as a normal track in the studio, where you can change its sound, edit the notes, record vocals over it and export.</Hint>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
