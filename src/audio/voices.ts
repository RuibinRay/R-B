import * as Tone from 'tone';
import { type Fallback, type InstrumentDef } from '../lib/instruments';
import { midiToName } from '../lib/music';
import { loadZones, loadedZones, type Zone } from './samples';

// Sound generators. Every voice is created in whichever Tone context is current,
// so the exact same code runs live and inside an offline export render.

export interface Voice {
  output: Tone.Gain;
  noteOn(midi: number, time: number, velocity: number): void;
  noteOff(midi: number, time: number): void;
  /** One complete note with a known length (seconds). `bend` is a pitch contour in cents. */
  play(midi: number, duration: number, time: number, velocity: number, bend?: number[], expr?: Expression): void;
  releaseAll(): void;
  dispose(): void;
}

/** How a note is shaped beyond pitch and velocity (used by sampled instruments). */
export interface Expression {
  legato?: boolean; // joined to the note before it: no fresh attack
  dyn?: number[]; // loudness contour over the note, 1 = its own level
}

type Raw = BaseAudioContext;
const rawOf = (): Raw => Tone.getContext().rawContext as unknown as Raw;

// ---- sampled instruments -------------------------------------------------

interface Live { src: AudioBufferSourceNode; g: GainNode; t0: number; done: boolean }

class SampleVoice implements Voice {
  output: Tone.Gain;
  private raw: Raw;
  private held = new Map<number, Live[]>();
  private live = new Set<Live>();
  private attack: number;
  private release: number;

  constructor(private zones: Zone[], def: InstrumentDef) {
    this.raw = rawOf();
    this.output = new Tone.Gain(def.gain ?? 4.5);
    this.attack = def.attack ?? 0.003;
    this.release = def.release ?? (def.sustain ? 0.22 : 0.45);
  }

  private zoneFor(midi: number): Zone {
    let best = this.zones[0];
    for (const z of this.zones) if (Math.abs(z.midi - midi) < Math.abs(best.midi - midi)) best = z;
    return best;
  }

  private begin(midi: number, time: number, velocity: number, bend?: number[], duration?: number, expr?: Expression): Live {
    const z = this.zoneFor(midi);
    const src = this.raw.createBufferSource();
    src.buffer = z.buffer;
    const rate = Math.pow(2, (midi - z.midi) / 12);
    src.playbackRate.value = rate;
    if (z.loopEnd) {
      src.loop = true;
      src.loopStart = z.loopStart ?? 0;
      src.loopEnd = z.loopEnd;
    }
    if (bend && bend.length > 1 && duration) {
      const step = duration / (bend.length - 1);
      src.playbackRate.setValueAtTime(rate * Math.pow(2, bend[0] / 1200), time);
      for (let i = 1; i < bend.length; i++) {
        src.playbackRate.linearRampToValueAtTime(rate * Math.pow(2, bend[i] / 1200), time + i * step);
      }
    }
    // A slurred note on a bowed or blown instrument has no attack of its own: it fades in
    // over the tail of the note before, and playback starts past the sample's own bow
    // scrape or breath puff. Only looped (sustaining) samples can do this.
    const legato = !!expr?.legato && !!z.loopEnd;
    const attack = legato ? Math.max(this.attack, 0.06) : this.attack;
    const peak = Math.pow(Math.max(0.02, velocity), 1.4);
    const dyn = expr?.dyn && expr.dyn.length > 1 && duration ? expr.dyn : null;
    const g = this.raw.createGain();
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(peak * (dyn ? dyn[0] : 1), time + attack);
    if (dyn && duration) {
      // the singer's swells and fades inside the note
      const step = duration / (dyn.length - 1);
      for (let i = 1; i < dyn.length; i++) if (i * step > attack + 0.01) g.gain.linearRampToValueAtTime(peak * dyn[i], time + i * step);
    }
    // Softly played notes are not only quieter but darker, as on the real instruments.
    if (velocity < 0.9) {
      const tone = this.raw.createBiquadFilter();
      tone.type = 'lowpass';
      tone.Q.value = 0.5;
      tone.frequency.value = Math.min(18000, 350 * Math.pow(2, velocity * 6));
      src.connect(tone);
      tone.connect(g);
    } else src.connect(g);
    Tone.connect(g as never, this.output);
    src.start(time, legato ? Math.min(0.09, z.loopStart ?? 0.09) : 0);
    const v: Live = { src, g, t0: time, done: false };
    src.onended = () => {
      g.disconnect();
      this.live.delete(v);
    };
    this.live.add(v);
    return v;
  }

  private end(v: Live, time: number, release = this.release): void {
    if (v.done) return;
    v.done = true;
    const t = Math.max(time, v.t0 + this.attack + 0.005);
    v.g.gain.setTargetAtTime(0, t, release / 3);
    try { v.src.stop(t + release * 2); } catch { /* already stopped */ }
  }

  noteOn(midi: number, time: number, velocity: number): void {
    const v = this.begin(midi, time, velocity);
    const list = this.held.get(midi) ?? [];
    list.push(v);
    this.held.set(midi, list);
  }

  noteOff(midi: number, time: number): void {
    const v = this.held.get(midi)?.shift();
    if (v) this.end(v, time);
  }

  play(midi: number, duration: number, time: number, velocity: number, bend?: number[], expr?: Expression): void {
    this.end(this.begin(midi, time, velocity, bend, duration, expr), time + duration);
  }

  releaseAll(): void {
    const now = this.raw.currentTime;
    for (const v of this.live) {
      v.done = true;
      try {
        v.g.gain.cancelScheduledValues(now);
        v.g.gain.setTargetAtTime(0, now, 0.02);
        v.src.stop(now + 0.15);
      } catch { /* ignore */ }
    }
    this.held.clear();
  }

  dispose(): void {
    this.releaseAll();
    const out = this.output;
    setTimeout(() => out.dispose(), 400);
  }
}

// ---- synthesizers --------------------------------------------------------

interface SynthPreset { voice?: 'synth' | 'fm' | 'mono' | 'am' | 'duo' | 'membrane'; options: Record<string, unknown>; volume: number; cutoff?: number; poly?: number; wobble?: number }

const env = (attack: number, decay: number, sustain: number, release: number) => ({ attack, decay, sustain, release });

const SYNTHS: Record<string, SynthPreset> = {
  sawLead: { volume: -10, cutoff: 4200, options: { oscillator: { type: 'sawtooth' }, envelope: env(0.008, 0.15, 0.65, 0.2) } },
  squareLead: { volume: -12, cutoff: 3600, options: { oscillator: { type: 'square' }, envelope: env(0.008, 0.12, 0.7, 0.18) } },
  supersaw: { volume: -11, cutoff: 6500, options: { oscillator: { type: 'fatsawtooth', count: 5, spread: 30 }, envelope: env(0.02, 0.3, 0.7, 0.5) } },
  pluck: { volume: -2, cutoff: 3000, options: { oscillator: { type: 'fatsawtooth', count: 2, spread: 14 }, envelope: env(0.002, 0.22, 0, 0.18) } },
  chip: { volume: -13, options: { oscillator: { type: 'pulse', width: 0.25 }, envelope: env(0.002, 0.05, 0.7, 0.06) } },
  warmPad: { volume: -6, cutoff: 1500, options: { oscillator: { type: 'fatsawtooth', count: 3, spread: 20 }, envelope: env(0.7, 0.6, 0.8, 1.8) } },
  glassPad: { voice: 'fm', volume: -1, options: { harmonicity: 2, modulationIndex: 2.5, envelope: env(0.35, 0.5, 0.7, 2), modulation: { type: 'triangle' }, modulationEnvelope: env(0.5, 0.3, 0.6, 1.5) } },
  subBass: { volume: -9, poly: 6, options: { oscillator: { type: 'sine' }, envelope: env(0.005, 0.12, 0.9, 0.12) } },
  acidBass: { voice: 'mono', volume: -16, poly: 4, options: { oscillator: { type: 'sawtooth' }, filter: { Q: 7, type: 'lowpass', rolloff: -24 }, envelope: env(0.004, 0.2, 0.5, 0.08), filterEnvelope: { ...env(0.004, 0.16, 0.15, 0.15), baseFrequency: 110, octaves: 3.8 } } },
  fmBass: { voice: 'fm', volume: 0, poly: 6, options: { harmonicity: 1, modulationIndex: 7, envelope: env(0.004, 0.25, 0.45, 0.12), modulationEnvelope: env(0.004, 0.18, 0.2, 0.1) } },
  fmBell: { voice: 'fm', volume: 0, options: { harmonicity: 3.01, modulationIndex: 12, envelope: env(0.002, 1.5, 0, 1.5), modulationEnvelope: env(0.002, 0.5, 0, 0.5) } },
  pwmPad: { volume: -16, cutoff: 2400, options: { oscillator: { type: 'pwm', modulationFrequency: 0.45 }, envelope: env(0.5, 0.4, 0.8, 1.5) } },
  stringMachine: { volume: -9, cutoff: 3600, options: { oscillator: { type: 'fatsawtooth', count: 3, spread: 26 }, envelope: env(0.22, 0.3, 0.9, 0.7) } },
  synthBrass: { voice: 'mono', volume: -12, poly: 8, options: { oscillator: { type: 'sawtooth' }, filter: { Q: 1.5, type: 'lowpass', rolloff: -24 }, envelope: env(0.03, 0.2, 0.8, 0.2), filterEnvelope: { ...env(0.07, 0.25, 0.55, 0.3), baseFrequency: 350, octaves: 3.4 } } },
  bass808: { voice: 'membrane', volume: -10, poly: 4, options: { pitchDecay: 0.045, octaves: 2.2, oscillator: { type: 'sine' }, envelope: env(0.001, 1.6, 0, 1.2) } },
  reeseBass: { volume: -8, cutoff: 650, poly: 6, options: { oscillator: { type: 'fatsawtooth', count: 2, spread: 38 }, envelope: env(0.01, 0.2, 0.9, 0.15) } },
  wobbleBass: { volume: -9, poly: 6, wobble: 4, options: { oscillator: { type: 'fatsawtooth', count: 2, spread: 20 }, envelope: env(0.01, 0.1, 1, 0.12) } },
  dxPiano: { voice: 'fm', volume: 0, options: { harmonicity: 14, modulationIndex: 1.4, envelope: env(0.002, 1.9, 0.05, 0.9), modulationEnvelope: env(0.002, 0.35, 0, 0.3) } },
  vibratoLead: { voice: 'duo', volume: -17, poly: 6, options: { vibratoAmount: 0.25, vibratoRate: 5.5, harmonicity: 1.003,
    voice0: { oscillator: { type: 'sawtooth' }, envelope: env(0.02, 0.1, 0.8, 0.25), filterEnvelope: { ...env(0.02, 0.2, 0.7, 0.3), baseFrequency: 600, octaves: 3 } },
    voice1: { oscillator: { type: 'square' }, envelope: env(0.02, 0.1, 0.8, 0.25), filterEnvelope: { ...env(0.02, 0.2, 0.7, 0.3), baseFrequency: 600, octaves: 3 } } } },
  bellPad: { voice: 'fm', volume: -1, options: { harmonicity: 3.5, modulationIndex: 5, envelope: env(0.15, 1.6, 0.45, 2.2), modulationEnvelope: env(0.1, 1.2, 0.3, 1.5) } },
  squarePluck: { volume: -2, cutoff: 3400, options: { oscillator: { type: 'fatsquare', count: 2, spread: 10 }, envelope: env(0.002, 0.18, 0, 0.15) } },
  sineLead: { volume: -14, options: { oscillator: { type: 'sine' }, envelope: env(0.02, 0.05, 0.9, 0.2) } },
  amKeys: { voice: 'am', volume: 5, options: { harmonicity: 2, envelope: env(0.004, 0.9, 0.15, 0.6), modulation: { type: 'sine' }, modulationEnvelope: env(0.004, 0.5, 0.3, 0.5) } },
};

/** Synth stand-ins used only when an instrument's samples cannot be downloaded. */
const FALLBACKS: Record<Fallback, SynthPreset> = {
  keys: { volume: -6, cutoff: 3200, options: { oscillator: { type: 'triangle' }, envelope: env(0.003, 1.2, 0.05, 0.5) } },
  pluck: { volume: -6, cutoff: 2800, options: { oscillator: { type: 'sawtooth' }, envelope: env(0.002, 0.5, 0, 0.3) } },
  bowed: { volume: -10, cutoff: 2600, options: { oscillator: { type: 'fatsawtooth', count: 3, spread: 12 }, envelope: env(0.08, 0.2, 0.85, 0.3) } },
  wind: { volume: -7, cutoff: 3500, options: { oscillator: { type: 'triangle' }, envelope: env(0.04, 0.1, 0.9, 0.15) } },
  brass: { volume: -9, cutoff: 2200, options: { oscillator: { type: 'sawtooth' }, envelope: env(0.03, 0.15, 0.8, 0.15) } },
  mallet: { voice: 'fm', volume: -7, options: { harmonicity: 4, modulationIndex: 3, envelope: env(0.002, 0.6, 0, 0.6), modulationEnvelope: env(0.002, 0.15, 0, 0.2) } },
  pad: { volume: -10, cutoff: 1600, options: { oscillator: { type: 'fatsawtooth', count: 3, spread: 22 }, envelope: env(0.4, 0.5, 0.8, 1.2) } },
  bass: { volume: -6, cutoff: 900, poly: 6, options: { oscillator: { type: 'triangle' }, envelope: env(0.004, 0.3, 0.6, 0.12) } },
};

class SynthVoice implements Voice {
  output: Tone.Gain;
  private poly: Tone.PolySynth;
  private post: Tone.ToneAudioNode[] = [];

  constructor(preset: SynthPreset) {
    this.output = new Tone.Gain(1);
    const classes = { synth: Tone.Synth, fm: Tone.FMSynth, mono: Tone.MonoSynth, am: Tone.AMSynth, duo: Tone.DuoSynth, membrane: Tone.MembraneSynth };
    this.poly = new Tone.PolySynth({ voice: classes[preset.voice ?? 'synth'], options: preset.options, maxPolyphony: preset.poly ?? 20 } as never);
    this.poly.volume.value = preset.volume;
    if (preset.cutoff) this.post.push(new Tone.Filter(preset.cutoff, 'lowpass', -12));
    // a filter swept by a slow oscillator: the "wobble" of wobble bass
    if (preset.wobble) this.post.push(new Tone.AutoFilter({ frequency: preset.wobble, baseFrequency: 90, octaves: 4.5, depth: 1, wet: 1 }).start());
    this.poly.chain(...this.post, this.output);
  }

  noteOn(midi: number, time: number, velocity: number): void { this.poly.triggerAttack(midiToName(midi), time, velocity); }
  noteOff(midi: number, time: number): void { this.poly.triggerRelease(midiToName(midi), time); }
  play(midi: number, duration: number, time: number, velocity: number): void {
    this.poly.triggerAttackRelease(midiToName(midi), Math.max(0.02, duration), time, velocity);
  }
  releaseAll(): void { this.poly.releaseAll(); }
  dispose(): void {
    this.poly.releaseAll();
    const { poly, post, output } = this;
    setTimeout(() => { poly.dispose(); post.forEach((n) => n.dispose()); output.dispose(); }, 400);
  }
}

// ---- drum synthesis ------------------------------------------------------

const noiseBuffers = new WeakMap<object, AudioBuffer>();
function noiseBuffer(raw: Raw): AudioBuffer {
  let b = noiseBuffers.get(raw);
  if (!b) {
    b = raw.createBuffer(1, raw.sampleRate * 2, raw.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseBuffers.set(raw, b);
  }
  return b;
}

function tone(raw: Raw, out: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, sweep: number, decay: number, gain: number): void {
  const o = raw.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + sweep);
  const g = raw.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0008, t + decay);
  o.connect(g);
  g.connect(out);
  o.start(t);
  o.stop(t + decay + 0.02);
  o.onended = () => g.disconnect();
}

function hiss(raw: Raw, out: AudioNode, t: number, type: BiquadFilterType, freq: number, q: number, attack: number, decay: number, gain: number): void {
  const n = raw.createBufferSource();
  n.buffer = noiseBuffer(raw);
  n.loop = true;
  const f = raw.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = raw.createGain();
  if (attack > 0) {
    g.gain.setValueAtTime(0.0008, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
  } else {
    g.gain.setValueAtTime(gain, t);
  }
  g.gain.exponentialRampToValueAtTime(0.0008, t + attack + decay);
  n.connect(f);
  f.connect(g);
  g.connect(out);
  n.start(t, Math.random() * 1.5);
  n.stop(t + attack + decay + 0.02);
  n.onended = () => g.disconnect();
}

const DRUM_ALIASES: Record<number, number> = { 35: 36, 40: 38, 43: 41, 47: 45, 50: 48, 52: 49, 55: 49, 57: 49, 53: 51, 59: 51, 69: 70, 76: 75, 77: 75 };

// Every drum sound is a few layers: swept oscillators ("t") and filtered noise bursts ("n").
type Layer =
  | { k: 't'; type: OscillatorType; f0: number; f1: number; sweep: number; decay: number; gain: number; at: number }
  | { k: 'n'; filter: BiquadFilterType; freq: number; q: number; attack: number; decay: number; gain: number; at: number };
const T = (type: OscillatorType, f0: number, f1: number, sweep: number, decay: number, gain: number, at = 0): Layer => ({ k: 't', type, f0, f1, sweep, decay, gain, at });
const N = (filter: BiquadFilterType, freq: number, q: number, attack: number, decay: number, gain: number, at = 0): Layer => ({ k: 'n', filter, freq, q, attack, decay, gain, at });
const clap = (freq: number, q: number, tail: number, gain: number): Layer[] =>
  [N('bandpass', freq, q, 0, 0.012, gain * 0.85), N('bandpass', freq, q, 0, 0.012, gain * 0.85, 0.012), N('bandpass', freq, q, 0, 0.012, gain * 0.85, 0.024), N('bandpass', freq, q * 0.75, 0, tail, gain, 0.034)];

type Kit = Record<number, Layer[]>;

const STUDIO: Kit = {
  36: [T('sine', 125, 50, 0.07, 0.3, 1), N('lowpass', 3200, 0.7, 0, 0.014, 0.4)],
  38: [T('triangle', 215, 172, 0.05, 0.11, 0.5), N('highpass', 1800, 0.7, 0, 0.19, 0.7), N('bandpass', 4500, 0.8, 0, 0.12, 0.3)],
  37: [T('square', 820, 820, 0, 0.025, 0.28), T('triangle', 1750, 1750, 0, 0.02, 0.3)],
  39: clap(1200, 1.2, 0.17, 0.7),
  42: [N('highpass', 7500, 0.7, 0, 0.045, 0.42), N('bandpass', 10000, 1, 0, 0.03, 0.2)],
  46: [N('highpass', 7200, 0.7, 0, 0.32, 0.4), N('bandpass', 9500, 1, 0, 0.2, 0.18)],
  44: [N('highpass', 7800, 0.7, 0, 0.028, 0.3)],
  41: [T('sine', 112, 70, 0.18, 0.32, 0.85)],
  45: [T('sine', 152, 96, 0.17, 0.29, 0.8)],
  48: [T('sine', 205, 130, 0.16, 0.26, 0.75)],
  49: [N('highpass', 4500, 0.7, 0, 1.3, 0.45), N('bandpass', 8000, 0.5, 0, 0.9, 0.25)],
  51: [N('highpass', 8000, 0.7, 0, 0.5, 0.2), T('sine', 3400, 3400, 0, 0.4, 0.06), T('sine', 5100, 5100, 0, 0.3, 0.05)],
  54: [N('highpass', 6500, 0.7, 0, 0.07, 0.38), N('bandpass', 9000, 1.5, 0, 0.09, 0.25, 0.03)],
  56: [T('square', 545, 545, 0, 0.22, 0.2), T('square', 815, 815, 0, 0.22, 0.2)],
  70: [N('bandpass', 6500, 1.5, 0.015, 0.06, 0.4)],
  75: [T('sine', 2450, 2450, 0, 0.05, 0.5)],
  60: [T('sine', 415, 330, 0.03, 0.13, 0.7), N('bandpass', 2500, 1, 0, 0.01, 0.2)],
  61: [T('sine', 305, 240, 0.03, 0.16, 0.7), N('bandpass', 2000, 1, 0, 0.01, 0.2)],
  62: [T('sine', 285, 250, 0.02, 0.06, 0.7)],
  63: [T('sine', 262, 215, 0.04, 0.2, 0.75)],
  64: [T('sine', 192, 160, 0.04, 0.26, 0.8)],
};

const KITS: Record<string, Kit> = {
  studio: STUDIO,
  latin: STUDIO,
  // analog drum machine: long sine kick, simple noise snare
  electro: { ...STUDIO,
    36: [T('sine', 165, 43, 0.13, 0.62, 1), N('lowpass', 2000, 0.7, 0, 0.008, 0.2)],
    38: [T('sine', 195, 160, 0.05, 0.1, 0.55), N('highpass', 1000, 0.7, 0, 0.16, 0.6)],
    42: [N('highpass', 7500, 0.7, 0, 0.035, 0.42), N('bandpass', 10000, 1, 0, 0.03, 0.2)],
    46: [N('highpass', 7200, 0.7, 0, 0.26, 0.4), N('bandpass', 9500, 1, 0, 0.2, 0.18)],
    41: [T('sine', 112, 70, 0.18, 0.42, 0.85)], 45: [T('sine', 152, 96, 0.17, 0.38, 0.8)], 48: [T('sine', 205, 130, 0.16, 0.34, 0.75)],
  },
  // punchy house machine: clicky kick, bright snare and hats
  house: { ...STUDIO,
    36: [T('sine', 210, 55, 0.045, 0.34, 0.85), T('triangle', 900, 120, 0.012, 0.03, 0.28), N('highpass', 4000, 0.7, 0, 0.006, 0.18)],
    38: [T('triangle', 330, 185, 0.03, 0.13, 0.5), T('sine', 180, 160, 0.02, 0.09, 0.3), N('highpass', 2600, 0.7, 0, 0.2, 0.75)],
    37: [T('triangle', 1800, 1800, 0, 0.018, 0.4), T('square', 480, 480, 0, 0.02, 0.22)],
    39: clap(1500, 0.9, 0.24, 0.75),
    42: [N('highpass', 9000, 0.7, 0, 0.04, 0.45), N('bandpass', 12000, 2, 0, 0.03, 0.2)],
    46: [N('highpass', 8500, 0.7, 0, 0.38, 0.42)],
    41: [T('sine', 130, 75, 0.1, 0.3, 0.9)], 45: [T('sine', 175, 100, 0.1, 0.27, 0.85)], 48: [T('sine', 235, 140, 0.09, 0.24, 0.8)],
    49: [N('highpass', 5500, 0.7, 0, 1.6, 0.45), N('bandpass', 9500, 0.6, 0, 1.1, 0.25)],
    51: [N('highpass', 9000, 0.7, 0, 0.6, 0.2), T('square', 4300, 4300, 0, 0.35, 0.03), T('square', 6200, 6200, 0, 0.3, 0.025)],
  },
  // trap: very long sub kick, tight hats, cracking snare
  trap: { ...STUDIO,
    36: [T('sine', 130, 40, 0.3, 1.4, 1), N('lowpass', 2500, 0.7, 0, 0.01, 0.3)],
    38: [T('triangle', 260, 200, 0.02, 0.09, 0.4), N('bandpass', 3600, 0.6, 0, 0.14, 0.85), N('highpass', 7000, 0.7, 0, 0.08, 0.3)],
    37: [T('sine', 1100, 1100, 0, 0.02, 0.5)],
    39: clap(1400, 1, 0.22, 0.8),
    42: [N('highpass', 9500, 0.7, 0, 0.022, 0.42)],
    46: [N('highpass', 9000, 0.7, 0, 0.18, 0.4)],
    44: [N('highpass', 10000, 0.7, 0, 0.014, 0.3)],
    41: [T('sine', 100, 55, 0.25, 0.6, 0.9)], 45: [T('sine', 135, 75, 0.22, 0.5, 0.85)], 48: [T('sine', 180, 100, 0.2, 0.45, 0.8)],
  },
  // dusty and soft: everything band-limited
  lofi: { ...STUDIO,
    36: [T('sine', 105, 48, 0.09, 0.28, 0.9), N('lowpass', 1200, 0.7, 0, 0.02, 0.25)],
    38: [T('triangle', 190, 160, 0.05, 0.1, 0.4), N('bandpass', 1800, 0.8, 0, 0.16, 0.6)],
    37: [T('triangle', 900, 900, 0, 0.03, 0.35)],
    39: [N('bandpass', 1000, 1, 0, 0.012, 0.5), N('bandpass', 1000, 1, 0, 0.012, 0.5, 0.014), N('bandpass', 1000, 0.8, 0, 0.12, 0.55, 0.028)],
    42: [N('bandpass', 5500, 1.2, 0, 0.05, 0.3)],
    46: [N('bandpass', 5000, 1, 0, 0.22, 0.28)],
    44: [N('bandpass', 5200, 1.2, 0, 0.03, 0.22)],
    49: [N('bandpass', 4500, 0.6, 0, 0.9, 0.3)],
    51: [N('bandpass', 5200, 2, 0, 0.35, 0.2)],
  },
  // big acoustic-style kit: fat kick, long snare, deep toms
  rock: { ...STUDIO,
    36: [T('sine', 135, 46, 0.06, 0.36, 1), N('lowpass', 4500, 0.7, 0, 0.02, 0.55)],
    38: [T('triangle', 200, 165, 0.06, 0.16, 0.6), N('highpass', 1400, 0.7, 0, 0.28, 0.8), N('bandpass', 5000, 0.7, 0, 0.2, 0.35)],
    41: [T('sine', 95, 58, 0.2, 0.45, 0.95), N('lowpass', 2000, 0.7, 0, 0.015, 0.25)],
    45: [T('sine', 130, 80, 0.19, 0.4, 0.9), N('lowpass', 2400, 0.7, 0, 0.015, 0.25)],
    48: [T('sine', 175, 110, 0.18, 0.36, 0.85), N('lowpass', 2800, 0.7, 0, 0.015, 0.25)],
    46: [N('highpass', 6800, 0.7, 0, 0.45, 0.42), N('bandpass', 9000, 1, 0, 0.3, 0.2)],
    49: [N('highpass', 4000, 0.7, 0, 1.9, 0.5), N('bandpass', 7500, 0.5, 0, 1.3, 0.28)],
  },
  // jazz brushes: swished snare, soft kick, long ride
  brush: { ...STUDIO,
    36: [T('sine', 100, 50, 0.08, 0.25, 0.7)],
    38: [N('bandpass', 2800, 0.6, 0.03, 0.22, 0.45), N('highpass', 5000, 0.7, 0.01, 0.1, 0.2)],
    37: [T('triangle', 1500, 1500, 0, 0.02, 0.3)],
    42: [N('highpass', 8000, 0.7, 0.005, 0.06, 0.22)],
    46: [N('highpass', 7500, 0.7, 0.01, 0.3, 0.2)],
    41: [T('sine', 105, 68, 0.15, 0.28, 0.6)], 45: [T('sine', 145, 95, 0.14, 0.25, 0.55)], 48: [T('sine', 195, 128, 0.13, 0.22, 0.5)],
    49: [N('highpass', 5000, 0.7, 0.01, 1.4, 0.3)],
    51: [N('highpass', 7000, 0.7, 0, 0.9, 0.16), T('sine', 3000, 3000, 0, 0.7, 0.05), T('sine', 4600, 4600, 0, 0.5, 0.04)],
  },
};

class DrumVoice implements Voice {
  output: Tone.Gain;
  private raw: Raw;
  private mix: GainNode;
  private kit: Kit;

  constructor(kit: string) {
    this.raw = rawOf();
    this.kit = KITS[kit] ?? STUDIO;
    this.output = new Tone.Gain(0.5);
    this.mix = this.raw.createGain();
    Tone.connect(this.mix as never, this.output);
  }

  noteOn(midi: number, time: number, velocity: number): void {
    const { raw, mix } = this;
    const v = Math.pow(Math.max(0.05, velocity), 1.3);
    const t = Math.max(time, 0);
    for (const l of this.kit[DRUM_ALIASES[midi] ?? midi] ?? []) {
      if (l.k === 't') tone(raw, mix, t + l.at, l.type, l.f0, l.f1, l.sweep, l.decay, v * l.gain);
      else hiss(raw, mix, t + l.at, l.filter, l.freq, l.q, l.attack, l.decay, v * l.gain);
    }
  }

  noteOff(): void { /* one-shots */ }
  play(midi: number, _duration: number, time: number, velocity: number): void { this.noteOn(midi, time, velocity); }
  releaseAll(): void { /* one-shots decay on their own */ }
  dispose(): void {
    const { mix, output } = this;
    setTimeout(() => { mix.disconnect(); output.dispose(); }, 1500);
  }
}

// ---- factory -------------------------------------------------------------

/** Build a voice from whatever is already loaded (samples if cached, otherwise a synth stand-in). */
export function createVoiceSync(def: InstrumentDef): Voice {
  if (def.engine === 'drums') return new DrumVoice(def.kit ?? 'studio');
  if (def.engine === 'synth') return new SynthVoice(SYNTHS[def.synth ?? 'sawLead'] ?? SYNTHS.sawLead);
  const zones = loadedZones(def.id);
  return zones ? new SampleVoice(zones, def) : new SynthVoice(FALLBACKS[def.fallback ?? 'keys']);
}

/** Load any samples the instrument needs. Resolves false if they could not be fetched. */
export async function ensureInstrument(def: InstrumentDef): Promise<boolean> {
  if (def.engine !== 'sample' && def.engine !== 'model') return true;
  try {
    await loadZones(def);
    return true;
  } catch {
    return false;
  }
}
