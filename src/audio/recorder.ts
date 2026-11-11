import * as Tone from 'tone';
import { dbToGain } from '../lib/music';

// Microphone capture through an AudioWorklet, with input gain, optional monitoring,
// a level meter and the timing data needed for latency-compensated placement.

export class MicError extends Error {
  constructor(public code: 'denied' | 'missing' | 'busy' | 'unsupported' | 'unknown', message: string) {
    super(message);
  }
}

function toMicError(e: unknown): MicError {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new MicError('denied', 'Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new MicError('missing', 'No microphone was found. Plug one in and try again.');
  if (name === 'NotReadableError' || name === 'AbortError') return new MicError('busy', 'The microphone is in use by another app or could not be started.');
  return new MicError('unknown', `The microphone could not be opened${e instanceof Error ? `: ${e.message}` : '.'}`);
}

export interface Recording { data: Float32Array; sampleRate: number; startTime: number }

type AnyCtx = BaseAudioContext & { createMediaStreamSource(s: MediaStream): AudioNode; outputLatency?: number; baseLatency?: number; _nativeAudioContext?: AudioContext };

class MicRecorder {
  /** Running peak per captured block, for drawing the waveform while recording. */
  peaks: number[] = [];
  inputLatency = 0;
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private inputGain: GainNode | null = null;
  private monitor: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private module: Promise<void> | null = null;
  private chunks: Float32Array[] = [];
  /** Context time of the first captured sample of the current take. */
  startTime = 0;
  private onDone: (() => void) | null = null;
  private meterBuf = new Float32Array(1024);
  private gainDb = 0;
  private monitorOn = false;

  get isOpen(): boolean { return !!this.stream; }

  async open(): Promise<void> {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new MicError('unsupported', 'Recording needs a secure page (https or localhost) and a browser with microphone support.');
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) {
      throw toMicError(e);
    }
    try {
      await Tone.start();
      const ctx = Tone.getContext();
      const raw = ctx.rawContext as unknown as AnyCtx;
      if (!raw.audioWorklet) throw new MicError('unsupported', 'This browser does not support AudioWorklet recording.');
      this.module ??= raw.audioWorklet.addModule(`${import.meta.env.BASE_URL}recorder-worklet.js`);
      await this.module;
      const source = raw.createMediaStreamSource(stream);
      const inputGain = raw.createGain();
      inputGain.gain.value = dbToGain(this.gainDb);
      const analyser = raw.createAnalyser();
      analyser.fftSize = 1024;
      const monitor = raw.createGain();
      monitor.gain.value = this.monitorOn ? 1 : 0;
      const worklet = ctx.createAudioWorkletNode('rnb-recorder', {
        numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1],
      }) as unknown as AudioWorkletNode;
      const sink = raw.createGain();
      sink.gain.value = 0;
      source.connect(inputGain);
      inputGain.connect(analyser);
      inputGain.connect(worklet);
      worklet.connect(sink);
      sink.connect(raw.destination);
      inputGain.connect(monitor);
      monitor.connect(raw.destination);
      worklet.port.onmessage = (e: MessageEvent) => {
        if (e.data.type === 'data') {
          const samples = e.data.samples as Float32Array;
          if (!this.chunks.length) this.startTime = e.data.time as number;
          this.chunks.push(samples);
          let peak = 0;
          for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
          this.peaks.push(peak);
        } else if (e.data.type === 'done') {
          this.onDone?.();
        }
      };
      const settings = stream.getAudioTracks()[0]?.getSettings() as MediaTrackSettings & { latency?: number };
      this.inputLatency = typeof settings?.latency === 'number' ? settings.latency : 0.005;
      this.stream = stream;
      this.inputGain = inputGain;
      this.monitor = monitor;
      this.analyser = analyser;
      this.worklet = worklet;
      this.nodes = [source, inputGain, analyser, monitor, worklet, sink];
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      throw e instanceof MicError ? e : toMicError(e);
    }
  }

  /** Seconds between a sound being scheduled and that same sound arriving back through the mic. */
  roundTripLatency(): number {
    const raw = Tone.getContext().rawContext as unknown as AnyCtx;
    const out = raw.outputLatency ?? raw._nativeAudioContext?.outputLatency ?? 0;
    const base = raw.baseLatency ?? raw._nativeAudioContext?.baseLatency ?? 0;
    return out + base + this.inputLatency;
  }

  setGain(db: number): void {
    this.gainDb = db;
    if (this.inputGain) this.inputGain.gain.value = dbToGain(db);
  }

  setMonitor(on: boolean): void {
    this.monitorOn = on;
    if (this.monitor) this.monitor.gain.value = on ? 1 : 0;
  }

  /** Input peak level, 0..1. */
  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let peak = 0;
    for (let i = 0; i < this.meterBuf.length; i++) { const a = Math.abs(this.meterBuf[i]); if (a > peak) peak = a; }
    return peak;
  }

  start(): void {
    this.chunks = [];
    this.peaks = [];
    this.worklet?.port.postMessage('start');
  }

  async stop(): Promise<Recording> {
    if (!this.worklet) throw new MicError('unknown', 'The recorder is not open.');
    await new Promise<void>((resolve) => {
      this.onDone = resolve;
      this.worklet!.port.postMessage('stop');
      window.setTimeout(resolve, 1500);
    });
    this.onDone = null;
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const data = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks) { data.set(c, o); o += c.length; }
    this.chunks = [];
    return { data, sampleRate: Tone.getContext().sampleRate, startTime: this.startTime };
  }

  close(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    for (const n of this.nodes) { try { n.disconnect(); } catch { /* ignore */ } }
    this.stream = null;
    this.nodes = [];
    this.inputGain = this.monitor = null;
    this.analyser = null;
    this.worklet = null;
  }
}

export const mic = new MicRecorder();
