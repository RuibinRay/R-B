import * as Tone from 'tone';
import type { AudioClip, ID, Project } from '../types';
import { getInstrument } from '../lib/instruments';
import { effectiveFades, trackMix, type ClipFades } from '../lib/mix';
import { barBeats, maxBeats, projectEndBeats } from '../lib/music';
import { MasterChain, TrackChain, startClipSource, type ClipSource } from './graph';
import { loadedZones } from './samples';
import { createVoiceSync, ensureInstrument, type Voice } from './voices';

// The live engine: mirrors the project into a Web Audio graph, schedules clips and
// notes on the Tone transport, and exposes transport, metering and live note input.

interface LiveTrack {
  chain: TrackChain;
  voice: Voice | null;
  instrumentId: string | null;
  token: number;
  fx: unknown;
  auto: unknown;
  pan: number;
  disposed: boolean;
}

export type InstrumentStatus = 'loading' | 'ready' | 'fallback';
export type EngineEvent = { type: 'ended' } | { type: 'instrument'; id: string; status: InstrumentStatus };

export interface SeqNote { pitch: number; time: number; duration: number; velocity: number; bend?: number[] }
export interface SeqPart { instrumentId: string; notes: SeqNote[]; gain?: number }
export interface SeqHandle { stop(): void; position(): number; duration: number }

class Engine {
  readonly buffers = new Map<ID, AudioBuffer>();
  readonly instrumentStatus = new Map<string, InstrumentStatus>();
  metronome = false;
  /** While true (recording) the transport neither loops nor auto-stops at the song end. */
  holdOpen = false;

  private tracks = new Map<ID, LiveTrack>();
  private master!: MasterChain;
  private previewBus!: Tone.Gain;
  private previewVoices = new Map<string, Voice>();
  private project: Project | null = null;
  private eventIds: number[] = [];
  private sources = new Set<ClipSource>();
  private fades = new Map<ID, ClipFades>();
  private audioSig = '';
  private metronomeId: number | null = null;
  private metronomeSig = '';
  private listeners = new Set<(e: EngineEvent) => void>();
  private built = false;
  private endBeat = 0;

  on(fn: (e: EngineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(e: EngineEvent): void { for (const l of this.listeners) l(e); }

  private build(): void {
    if (this.built) return;
    this.built = true;
    this.master = new MasterChain(true);
    this.previewBus = new Tone.Gain(1);
    this.previewBus.connect(this.master.input);
    const tr = Tone.getTransport();
    const begin = (time: number, offset: number) => { this.startSpanning(time, offset); this.automate(time, (offset * (this.project?.bpm ?? 120)) / 60, true); };
    const halt = (time: number) => { this.stopSources(time); this.automate(time, tr.getTicksAtTime(time) / tr.PPQ, false); };
    tr.on('start', begin);
    tr.on('loopStart', begin);
    tr.on('stop', halt);
    tr.on('pause', halt);
    tr.on('loopEnd', (time: number) => this.stopSources(time));
  }

  /** Audio can only start after a user gesture; call this from input handlers. */
  async resume(): Promise<void> {
    this.build();
    if (Tone.getContext().state !== 'running') await Tone.start();
  }

  get running(): boolean { return Tone.getContext().state === 'running'; }
  /** Current audio-clock time in seconds (no look-ahead). */
  get contextTime(): number { return Tone.immediate(); }
  get sampleRate(): number { return Tone.getContext().sampleRate; }
  /** The underlying Web Audio context, for small self-contained players. */
  get rawContext(): BaseAudioContext { return Tone.getContext().rawContext as unknown as BaseAudioContext; }

  // ---- project sync ----------------------------------------------------

  sync(p: Project): void {
    this.build();
    const prev = this.project;
    this.project = p;
    const tr = Tone.getTransport();

    const ids = new Set(p.tracks.map((t) => t.id));
    for (const [id, lt] of this.tracks) {
      if (ids.has(id)) continue;
      lt.disposed = true;
      lt.voice?.dispose();
      lt.chain.dispose();
      this.tracks.delete(id);
    }
    for (const t of p.tracks) {
      let lt = this.tracks.get(t.id);
      if (!lt) {
        lt = { chain: new TrackChain(this.master.input, true), voice: null, instrumentId: null, token: 0, fx: null, auto: null, pan: NaN, disposed: false };
        this.tracks.set(t.id, lt);
      }
      if (lt.fx !== t.fx) { lt.chain.setFx(t.fx); lt.fx = t.fx; lt.chain.ready = []; }
      const mix = trackMix(p, t);
      lt.chain.setMix(mix.volume, t.pan, mix.audible);
      if (lt.auto !== t.automation || lt.pan !== t.pan || !prev || prev.bpm !== p.bpm) {
        // automation edited (or tempo / pan knob moved): re-lay the curve from where the playhead is now
        lt.auto = t.automation;
        lt.pan = t.pan;
        lt.chain.scheduleAutomation(t.automation, p.bpm, this.beat, Tone.immediate(), tr.state === 'started');
      }
      const want = t.kind === 'instrument' ? t.instrumentId : null;
      if (lt.instrumentId !== want) void this.loadVoice(lt, want);
    }

    if (!prev || prev.master !== p.master) this.master.set(p.master);
    if (!prev || prev.bpm !== p.bpm) tr.bpm.value = p.bpm;
    tr.timeSignature = p.timeSig[1] === 4 ? p.timeSig[0] : [p.timeSig[0], p.timeSig[1]];
    this.applyLoop();

    const metSig = `${p.timeSig[0]}/${p.timeSig[1]}`;
    if (metSig !== this.metronomeSig) { this.metronomeSig = metSig; this.refreshMetronome(); }

    if (!prev || prev.clips !== p.clips || prev.bpm !== p.bpm || prev.tracks.length !== p.tracks.length || prev.autoCrossfade !== p.autoCrossfade) this.schedule();
  }

  private applyLoop(): void {
    const p = this.project;
    if (!p) return;
    const tr = Tone.getTransport();
    const on = p.loop.on && p.loop.end - p.loop.start > 0.01 && !this.holdOpen;
    if (on) tr.setLoopPoints(`${Math.round(p.loop.start * tr.PPQ)}i`, `${Math.round(p.loop.end * tr.PPQ)}i`);
    tr.loop = on;
  }

  setHoldOpen(v: boolean): void { this.holdOpen = v; this.applyLoop(); }

  private setStatus(id: string, status: InstrumentStatus): void {
    this.instrumentStatus.set(id, status);
    this.emit({ type: 'instrument', id, status });
  }

  private async loadVoice(lt: LiveTrack, instrumentId: string | null): Promise<void> {
    lt.instrumentId = instrumentId;
    const token = ++lt.token;
    const def = getInstrument(instrumentId);
    if (!def) { lt.voice?.dispose(); lt.voice = null; return; }
    if ((def.engine === 'sample' || def.engine === 'model') && !loadedZones(def.id)) this.setStatus(def.id, 'loading');
    const ok = await ensureInstrument(def);
    if (lt.token !== token || lt.disposed) return;
    lt.voice?.dispose();
    lt.voice = createVoiceSync(def);
    lt.voice.output.connect(lt.chain.input);
    this.setStatus(def.id, ok ? 'ready' : 'fallback');
  }

  // ---- scheduling ------------------------------------------------------

  private schedule(): void {
    const p = this.project;
    if (!p) return;
    const tr = Tone.getTransport();
    for (const id of this.eventIds) tr.clear(id);
    this.eventIds = [];
    const ppq = tr.PPQ;
    const spb = 60 / p.bpm;
    const limit = maxBeats(p.bpm);
    this.fades = effectiveFades(p);
    const audio: string[] = [];
    for (const clip of p.clips) {
      if (clip.muted || clip.start >= limit) continue;
      const lt = this.tracks.get(clip.trackId);
      if (!lt) continue;
      if (clip.type === 'midi') {
        for (const n of clip.notes) {
          if (n.start < 0 || n.start >= clip.length) continue;
          const dur = Math.min(n.duration, clip.length - n.start) * spb;
          const { pitch, velocity, bend } = n;
          this.eventIds.push(tr.schedule((time) => lt.voice?.play(pitch, dur, time, velocity, bend), `${Math.round((clip.start + n.start) * ppq)}i`));
        }
      } else {
        const f = this.fades.get(clip.id);
        audio.push([clip.id, clip.trackId, clip.start, clip.offset, clip.length, clip.gain, f?.fadeIn, f?.fadeOut, f?.crossIn, f?.crossOut, clip.assetId].join(':'));
        this.eventIds.push(tr.schedule((time) => this.startAudioClip(clip, time, 0), `${Math.round(clip.start * ppq)}i`));
      }
    }
    this.endBeat = Math.min(limit, projectEndBeats(p) + barBeats(p.timeSig));
    this.eventIds.push(tr.schedule(() => {
      if (tr.loop || this.holdOpen) return;
      this.pause();
      this.emit({ type: 'ended' });
    }, `${Math.round(this.endBeat * ppq)}i`));

    const audioSig = `${p.bpm}|${audio.join('|')}`;
    if (audioSig !== this.audioSig) {
      this.audioSig = audioSig;
      if (tr.state === 'started') {
        const now = Tone.now();
        this.stopSources(now);
        this.startSpanning(now, tr.seconds);
      }
    }
  }

  /** Start (or, with `run` false, freeze) every track's automation at a beat position. */
  private automate(time: number, beat: number, run: boolean): void {
    const p = this.project;
    if (!p) return;
    for (const t of p.tracks) this.tracks.get(t.id)?.chain.scheduleAutomation(t.automation, p.bpm, beat, time, run);
  }

  private startAudioClip(clip: AudioClip, time: number, elapsed: number): void {
    const lt = this.tracks.get(clip.trackId);
    const buf = this.buffers.get(clip.assetId);
    if (!lt || !buf) return;
    const s = startClipSource(lt.chain.input, buf, clip, time, elapsed, this.fades.get(clip.id));
    if (!s) return;
    this.sources.add(s);
    s.src.onended = () => { s.g.disconnect(); this.sources.delete(s); };
  }

  /** Start every audio clip that is already under the playhead when playback begins there. */
  private startSpanning(time: number, offsetSeconds: number): void {
    const p = this.project;
    if (!p) return;
    const beat = (offsetSeconds * p.bpm) / 60;
    for (const clip of p.clips) {
      if (clip.type !== 'audio' || clip.muted) continue;
      const len = (clip.length * p.bpm) / 60;
      if (clip.start < beat - 1e-4 && clip.start + len > beat + 1e-4) {
        this.startAudioClip(clip, time, ((beat - clip.start) * 60) / p.bpm);
      }
    }
  }

  private stopSources(time: number): void {
    for (const s of this.sources) {
      try {
        // hold the level where it is (also in the middle of a fade), then duck out quickly
        if (typeof s.g.gain.cancelAndHoldAtTime === 'function') s.g.gain.cancelAndHoldAtTime(time);
        else s.g.gain.cancelScheduledValues(time);
        s.g.gain.setTargetAtTime(0, time, 0.008);
      } catch { /* a fade curve was in progress: the stop below still ends the clip */ }
      try { s.src.stop(time + 0.06); } catch { /* already stopped */ }
    }
    this.sources.clear();
  }

  // ---- transport -------------------------------------------------------

  get playing(): boolean { return Tone.getTransport().state === 'started'; }

  get beat(): number {
    const tr = Tone.getTransport();
    return Math.max(0, tr.getTicksAtTime(Tone.immediate()) / tr.PPQ);
  }

  async play(atContextTime?: number): Promise<void> {
    await this.resume();
    const tr = Tone.getTransport();
    if (tr.state === 'started') return;
    if (!this.holdOpen && !tr.loop && this.beat >= this.endBeat - 0.01) this.seek(0);
    tr.start(atContextTime ?? '+0.05');
  }

  pause(): void {
    const tr = Tone.getTransport();
    if (tr.state === 'started') tr.pause();
    for (const lt of this.tracks.values()) lt.voice?.releaseAll();
  }

  seek(beat: number): void {
    const tr = Tone.getTransport();
    tr.ticks = Math.max(0, Math.round(beat * tr.PPQ));
    if (tr.state !== 'started') this.automate(Tone.immediate(), Math.max(0, beat), false);
  }

  // ---- metronome -------------------------------------------------------

  setMetronome(on: boolean): void {
    this.metronome = on;
    this.refreshMetronome();
  }

  private refreshMetronome(): void {
    const tr = Tone.getTransport();
    if (this.metronomeId !== null) { tr.clear(this.metronomeId); this.metronomeId = null; }
    if (!this.metronome || !this.project) return;
    const [num, den] = this.project.timeSig;
    const step = Math.round((tr.PPQ * 4) / den);
    this.metronomeId = tr.scheduleRepeat((time) => {
      const idx = Math.round(tr.getTicksAtTime(time) / step);
      this.click(time, idx % num === 0);
    }, `${step}i`, 0);
  }

  /** A metronome tick straight to the speakers (never part of the mix or an export). */
  click(time: number, accent: boolean): void {
    const raw = Tone.getContext().rawContext as unknown as BaseAudioContext;
    const o = raw.createOscillator();
    const g = raw.createGain();
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(accent ? 0.35 : 0.22, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.045);
    o.connect(g);
    g.connect(raw.destination);
    o.start(time);
    o.stop(time + 0.06);
    o.onended = () => g.disconnect();
  }

  /** Schedule `bars` of count-in clicks and return the context time at which playback should start. */
  countIn(bars: number): number {
    const p = this.project!;
    const [num, den] = p.timeSig;
    const step = (60 / p.bpm) * (4 / den);
    const t0 = Tone.immediate() + 0.12;
    const total = bars * num;
    for (let i = 0; i < total; i++) this.click(t0 + i * step, i % num === 0);
    return t0 + total * step;
  }

  // ---- live input and previews ----------------------------------------

  noteOn(trackId: ID, midi: number, velocity = 0.8): void {
    void this.resume();
    this.tracks.get(trackId)?.voice?.noteOn(midi, Tone.immediate(), velocity);
  }

  noteOff(trackId: ID, midi: number): void {
    this.tracks.get(trackId)?.voice?.noteOff(midi, Tone.immediate());
  }

  /** Short one-off note on a project track (used when drawing or moving notes). */
  auditionTrack(trackId: ID, midi: number, velocity = 0.8, duration = 0.3): void {
    void this.resume();
    this.tracks.get(trackId)?.voice?.play(midi, duration, Tone.immediate(), velocity);
  }

  async previewVoice(instrumentId: string): Promise<Voice | null> {
    this.build();
    const existing = this.previewVoices.get(instrumentId);
    if (existing) return existing;
    const def = getInstrument(instrumentId);
    if (!def) return null;
    if ((def.engine === 'sample' || def.engine === 'model') && !loadedZones(def.id)) this.setStatus(def.id, 'loading');
    const ok = await ensureInstrument(def);
    const raced = this.previewVoices.get(instrumentId);
    if (raced) return raced;
    const v = createVoiceSync(def);
    v.output.connect(this.previewBus);
    this.previewVoices.set(instrumentId, v);
    this.setStatus(def.id, ok ? 'ready' : 'fallback');
    return v;
  }

  async previewNote(instrumentId: string, midi: number, duration = 0.7, velocity = 0.8): Promise<void> {
    await this.resume();
    const v = await this.previewVoice(instrumentId);
    v?.play(midi, duration, Tone.immediate() + 0.01, velocity);
  }

  async previewOn(instrumentId: string, midi: number, velocity = 0.8): Promise<void> {
    await this.resume();
    (await this.previewVoice(instrumentId))?.noteOn(midi, Tone.immediate(), velocity);
  }

  previewOff(instrumentId: string, midi: number): void {
    this.previewVoices.get(instrumentId)?.noteOff(midi, Tone.immediate());
  }

  /**
   * Play note parts (times in seconds) and an optional audio buffer outside the project
   * timeline — used to audition detected melodies and suggestions before inserting them.
   */
  async playSequence(parts: SeqPart[], audio?: { buffer: AudioBuffer; gain: number } | null, from = 0, onEnd?: () => void): Promise<SeqHandle> {
    await this.resume();
    const voices = await Promise.all(parts.map((p) => this.previewVoice(p.instrumentId)));
    const raw = Tone.getContext().rawContext as unknown as BaseAudioContext;
    const sorted = parts.map((p) => [...p.notes].sort((a, b) => a.time - b.time));
    let duration = audio ? audio.buffer.duration : 0;
    for (const notes of sorted) for (const n of notes) duration = Math.max(duration, n.time + n.duration);
    const t0 = raw.currentTime + 0.1 - from;
    const idx = sorted.map((notes) => notes.findIndex((n) => n.time >= from - 1e-6)).map((i, k) => (i < 0 ? sorted[k].length : i));
    let src: AudioBufferSourceNode | null = null;
    let g: GainNode | null = null;
    if (audio && from < audio.buffer.duration) {
      src = raw.createBufferSource();
      src.buffer = audio.buffer;
      g = raw.createGain();
      g.gain.value = audio.gain;
      src.connect(g);
      Tone.connect(g as never, this.previewBus);
      src.start(t0 + from, from);
    }
    let stopped = false;
    const tick = () => {
      const horizon = raw.currentTime - t0 + 0.25;
      sorted.forEach((notes, k) => {
        const v = voices[k];
        while (idx[k] < notes.length && notes[idx[k]].time < horizon) {
          const n = notes[idx[k]++];
          v?.play(n.pitch, n.duration, t0 + n.time, Math.min(1, n.velocity * (parts[k].gain ?? 1)), n.bend);
        }
      });
      if (raw.currentTime - t0 > duration + 0.3) { handle.stop(); onEnd?.(); }
    };
    const timer = window.setInterval(tick, 40);
    const handle: SeqHandle = {
      duration,
      position: () => raw.currentTime - t0,
      stop: () => {
        if (stopped) return;
        stopped = true;
        window.clearInterval(timer);
        voices.forEach((v) => v?.releaseAll());
        try { src?.stop(); g?.disconnect(); } catch { /* ignore */ }
      },
    };
    tick();
    return handle;
  }

  // ---- metering --------------------------------------------------------

  trackLevel(id: ID): number { return this.tracks.get(id)?.chain.level() ?? -Infinity; }

  masterLevels(): [number, number] {
    const v = this.built ? this.master.meter?.getValue() : undefined;
    return Array.isArray(v) ? [v[0], v[1]] : [-Infinity, -Infinity];
  }

  spectrum(): Float32Array | null { return this.built ? (this.master.fft?.getValue() as Float32Array) ?? null : null; }
  waveform(): Float32Array | null { return this.built ? (this.master.wave?.getValue() as Float32Array) ?? null : null; }

  /** Decode an encoded audio file (wav/mp3/flac/ogg/m4a — whatever the browser supports). */
  decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return Tone.getContext().decodeAudioData(data);
  }

  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    return Tone.getContext().createBuffer(channels, length, sampleRate);
  }
}

export const engine = new Engine();
