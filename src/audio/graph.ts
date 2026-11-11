import * as Tone from 'tone';
import type { AudioClip, FxName, FxState, MasterState, TrackAutomation } from '../types';
import { autoValueAt, clamp, dbToGain } from '../lib/music';
import type { ClipFades } from '../lib/mix';

// Signal chains shared by live playback and offline export, so a render always
// reflects the same instruments, effects and mix the user hears.

type Node = Tone.ToneAudioNode;
const FX_ORDER: FxName[] = ['eq', 'gate', 'comp', 'pitch', 'dist', 'chorus', 'delay', 'reverb'];

function makeFx(name: FxName): Node {
  switch (name) {
    case 'eq': return new Tone.EQ3({ lowFrequency: 250, highFrequency: 3500 });
    case 'gate': return new Tone.Gate(-45, 0.08);
    case 'comp': return new Tone.Compressor({ attack: 0.01, release: 0.2, knee: 12 });
    case 'pitch': return new Tone.PitchShift({ windowSize: 0.08 });
    case 'dist': return new Tone.Distortion({ distortion: 0.3, oversample: '2x' });
    case 'chorus': return new Tone.Chorus({ frequency: 1.5, delayTime: 3.5, depth: 0.6 }).start();
    case 'delay': return new Tone.FeedbackDelay({ delayTime: 0.3, feedback: 0.3, maxDelay: 2 });
    case 'reverb': return new Tone.Reverb({ decay: 2.2, preDelay: 0.01 });
  }
}

export class TrackChain {
  input: Tone.Gain;
  meter?: Tone.Meter;
  /** Promises that must settle before an offline render (reverb impulse responses). */
  ready: Promise<unknown>[] = [];
  private fader: Tone.Gain;
  private auto: GainNode; // volume automation; 1 = no change
  private panner: StereoPannerNode;
  private raw: BaseAudioContext;
  private basePan = 0;
  private panAutomated = false;
  private nodes: Partial<Record<FxName, Node>> = {};
  private sig = '-';

  constructor(dest: Tone.InputNode, withMeter: boolean) {
    this.raw = Tone.getContext().rawContext as unknown as BaseAudioContext;
    this.input = new Tone.Gain(1);
    this.fader = new Tone.Gain(1);
    // fader -> automation gain -> pan. The last two are plain Web Audio nodes so
    // automation can be scheduled on their parameters sample-accurately.
    this.auto = this.raw.createGain();
    this.panner = this.raw.createStereoPanner();
    Tone.connect(this.fader, this.auto as never);
    this.auto.connect(this.panner);
    Tone.connect(this.panner as never, dest);
    if (withMeter) {
      this.meter = new Tone.Meter({ smoothing: 0.7, channelCount: 2 });
      Tone.connect(this.panner as never, this.meter);
    }
  }

  setFx(fx: FxState): void {
    const sig = FX_ORDER.filter((k) => fx[k].on).join(',');
    if (sig !== this.sig) {
      this.input.disconnect();
      for (const n of Object.values(this.nodes)) n?.dispose();
      this.nodes = {};
      const chain: Node[] = [];
      for (const k of FX_ORDER) {
        if (!fx[k].on) continue;
        const n = makeFx(k);
        this.nodes[k] = n;
        chain.push(n);
      }
      this.input.chain(...chain, this.fader);
      this.sig = sig;
    }
    const n = this.nodes;
    if (n.eq) { const e = n.eq as Tone.EQ3; e.low.value = fx.eq.low; e.mid.value = fx.eq.mid; e.high.value = fx.eq.high; }
    if (n.gate) (n.gate as Tone.Gate).threshold = fx.gate.threshold;
    if (n.comp) { const c = n.comp as Tone.Compressor; c.threshold.value = fx.comp.threshold; c.ratio.value = fx.comp.ratio; }
    if (n.pitch) (n.pitch as Tone.PitchShift).pitch = fx.pitch.semitones;
    if (n.dist) (n.dist as Tone.Distortion).distortion = fx.dist.amount;
    if (n.chorus) { const c = n.chorus as Tone.Chorus; c.frequency.value = fx.chorus.rate; c.depth = fx.chorus.depth; c.wet.value = fx.chorus.mix; }
    if (n.delay) { const d = n.delay as Tone.FeedbackDelay; d.delayTime.value = fx.delay.time; d.feedback.value = fx.delay.feedback; d.wet.value = fx.delay.mix; }
    if (n.reverb) {
      const r = n.reverb as Tone.Reverb;
      r.wet.value = fx.reverb.mix;
      if (Math.abs(Number(r.decay) - fx.reverb.decay) > 0.01) r.decay = fx.reverb.decay;
      this.ready.push(r.ready);
    }
  }

  setMix(volumeDb: number, pan: number, audible: boolean, immediate = false): void {
    const g = audible ? dbToGain(volumeDb) : 0;
    this.basePan = pan;
    if (immediate) {
      this.fader.gain.value = g;
      if (!this.panAutomated) this.panner.pan.value = pan;
    } else {
      this.fader.gain.rampTo(g, 0.03);
      if (!this.panAutomated) this.panner.pan.setTargetAtTime(pan, this.raw.currentTime, 0.012);
    }
  }

  /**
   * Lay the track's automation onto the audio clock: the curve position `fromBeat`
   * is placed at context time `when`. With `run` false the values are only held
   * at that position (transport stopped). Volume moves in straight lines in dB.
   */
  scheduleAutomation(auto: TrackAutomation | undefined, bpm: number, fromBeat: number, when: number, run = true): void {
    const spb = 60 / bpm;
    const t0 = Math.max(0, when);
    const vol = auto?.volume ?? [];
    const g = this.auto.gain;
    g.cancelScheduledValues(t0);
    // The bottom of the lane means silence. A dB ramp cannot reach zero, so slopes run to
    // -60 dB (as drawn) and the gain is cut to exactly zero while the curve rests on the bottom.
    const before = vol.filter((p) => p.beat <= fromBeat).pop();
    const after = vol.find((p) => p.beat > fromBeat);
    const resting = vol.length > 0 && isSilent((before ?? after!).value) && isSilent((after ?? before!).value);
    g.setValueAtTime(!vol.length ? 1 : resting ? 0 : autoGain(autoValueAt(vol, fromBeat)), t0);
    if (run) {
      vol.forEach((p, i) => {
        if (p.beat <= fromBeat) return;
        const t = t0 + (p.beat - fromBeat) * spb;
        const prev = vol[i - 1], next = vol[i + 1];
        const silent = isSilent(p.value);
        if (!(silent && isSilent((prev ?? p).value))) g.exponentialRampToValueAtTime(autoGain(p.value), t);
        if (silent) g.setValueAtTime(!next || isSilent(next.value) ? 0 : autoGain(-60), t);
      });
    }

    const pan = auto?.pan ?? [];
    this.panAutomated = pan.length > 0;
    const at = (v: number) => clamp(this.basePan + v, -1, 1);
    const pn = this.panner.pan;
    pn.cancelScheduledValues(t0);
    pn.setValueAtTime(pan.length ? at(autoValueAt(pan, fromBeat)) : this.basePan, t0);
    if (run) for (const p of pan) if (p.beat > fromBeat) pn.linearRampToValueAtTime(at(p.value), t0 + (p.beat - fromBeat) * spb);
  }

  level(): number {
    const v = this.meter?.getValue();
    if (v === undefined) return -Infinity;
    return Array.isArray(v) ? Math.max(v[0], v[1]) : v;
  }

  dispose(): void {
    for (const n of Object.values(this.nodes)) n?.dispose();
    this.input.dispose();
    this.fader.dispose();
    this.auto.disconnect();
    this.panner.disconnect();
    this.meter?.dispose();
  }
}

const isSilent = (db: number): boolean => db <= -59.5;
const autoGain = (db: number): number => Math.pow(10, Math.max(-60, db) / 20);

export class MasterChain {
  input: Tone.Gain;
  meter?: Tone.Meter;
  fft?: Tone.Analyser;
  wave?: Tone.Analyser;
  private volume: Tone.Gain;
  private out: Tone.Gain;
  private nodes: Node[] = [];
  private eq?: Tone.EQ3;
  private comp?: Tone.Compressor;
  private limiter?: Tone.Limiter;
  private sig = '-';

  constructor(live: boolean) {
    this.input = new Tone.Gain(1);
    this.volume = new Tone.Gain(1);
    this.out = new Tone.Gain(1).toDestination();
    if (live) {
      this.meter = new Tone.Meter({ smoothing: 0.6, channelCount: 2 });
      this.fft = new Tone.Analyser('fft', 2048);
      this.wave = new Tone.Analyser('waveform', 2048);
      this.out.fan(this.meter, this.fft, this.wave);
    }
  }

  set(m: MasterState, immediate = false): void {
    const sig = `${m.eq.on}${m.comp.on}${m.limiter.on}`;
    if (sig !== this.sig) {
      this.input.disconnect();
      this.volume.disconnect();
      for (const n of this.nodes) n.dispose();
      this.nodes = [];
      this.eq = m.eq.on ? new Tone.EQ3({ lowFrequency: 200, highFrequency: 4000 }) : undefined;
      this.comp = m.comp.on ? new Tone.Compressor({ attack: 0.02, release: 0.25, knee: 10 }) : undefined;
      this.limiter = m.limiter.on ? new Tone.Limiter(-1) : undefined;
      const pre = [this.eq, this.comp].filter(Boolean) as Node[];
      this.nodes = [...pre, ...(this.limiter ? [this.limiter] : [])];
      this.input.chain(...pre, this.volume);
      if (this.limiter) this.volume.chain(this.limiter, this.out);
      else this.volume.connect(this.out);
      this.sig = sig;
    }
    if (this.eq) { this.eq.low.value = m.eq.low; this.eq.mid.value = m.eq.mid; this.eq.high.value = m.eq.high; }
    if (this.comp) { this.comp.threshold.value = m.comp.threshold; this.comp.ratio.value = m.comp.ratio; }
    if (this.limiter) this.limiter.threshold.value = m.limiter.ceiling;
    const g = dbToGain(m.volume);
    if (immediate) this.volume.gain.value = g;
    else this.volume.gain.rampTo(g, 0.03);
  }
}

export interface ClipSource { src: AudioBufferSourceNode; g: GainNode }

/**
 * Start one audio clip at context time `when`, `elapsed` seconds into the clip
 * (non-zero when playback begins in the middle of it). Applies clip gain and
 * fades; `fades` overrides the clip's own (automatic crossfades are passed in here).
 */
export function startClipSource(dest: Tone.InputNode, buffer: AudioBuffer, clip: AudioClip, when: number, elapsed: number, fades?: ClipFades): ClipSource | null {
  const remain = clip.length - elapsed;
  if (remain <= 0.001) return null;
  const raw = Tone.getContext().rawContext as unknown as BaseAudioContext;
  const src = raw.createBufferSource();
  src.buffer = buffer;
  const g = raw.createGain();
  const peak = dbToGain(clip.gain);
  const f = fades ?? { fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, crossIn: false, crossOut: false };
  const fadeIn = Math.min(f.fadeIn, clip.length);
  const fadeOut = Math.min(f.fadeOut, Math.max(0, clip.length - fadeIn));
  const outStart = clip.length - fadeOut;
  const t = Math.max(0, when);
  // a clip's own fades are straight lines; crossfades use an equal-power curve so the level does not dip in the middle
  const shape = (x: number, cross: boolean) => { const c = Math.min(1, Math.max(0, x)); return cross ? Math.sin((Math.PI / 2) * c) : c; };
  const level = (tau: number) =>
    peak * (fadeIn > 0 && tau < fadeIn ? shape(tau / fadeIn, f.crossIn) : 1) * (fadeOut > 0 && tau > outStart ? shape((clip.length - tau) / fadeOut, f.crossOut) : 1);
  /** Automate the gain along the fade shape between two clip times. */
  const segment = (a: number, b: number) => {
    const dur = b - a;
    if (dur < 0.002) { g.gain.setValueAtTime(level(b), t + Math.max(0, a - elapsed)); return; }
    const m = Math.max(2, Math.min(256, Math.ceil(dur * 200)));
    const curve = new Float32Array(m);
    for (let k = 0; k < m; k++) curve[k] = level(a + (dur * k) / (m - 1));
    g.gain.setValueCurveAtTime(curve, t + (a - elapsed), dur);
  };
  try {
    const inEnd = Math.max(elapsed, fadeIn);
    const outBegin = Math.max(inEnd, outStart);
    if (elapsed < fadeIn) segment(elapsed, fadeIn);
    // (when playback starts inside the fade-out, its curve begins right at `t` and sets the level itself)
    else if (!(fadeOut > 0 && elapsed >= outStart)) g.gain.setValueAtTime(peak, t);
    if (fadeOut > 0) segment(outBegin, clip.length);
  } catch {
    g.gain.cancelScheduledValues(0);
    g.gain.setValueAtTime(peak, t);
  }
  src.connect(g);
  Tone.connect(g as never, dest);
  src.start(t, clip.offset + elapsed, remain);
  return { src, g };
}
