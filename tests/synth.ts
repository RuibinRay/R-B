// Synthetic test signals with a known answer: a voice-like singer and a beatboxer.
// They are deliberately awkward in the ways real takes are (vibrato, scoops, breath
// noise, soft re-articulations, a phone microphone with no bass).

export interface SungNote {
  midi: number;
  start: number;
  dur: number;
  amp?: number;
  vibrato?: { rate: number; cents: number; am?: number }; // am = loudness wobble 0..1
  scoop?: number; // start this many cents flat and slide up over 70 ms
  glideFrom?: number; // slide from this MIDI pitch over the first 90 ms
  attack?: number;
  release?: number;
}

export interface SingOptions {
  sr?: number;
  length?: number;
  noise?: number; // background noise amplitude
  breath?: number; // noise that follows the voice's own level
  weakFundamental?: boolean; // little energy at the fundamental, strong second harmonic
  pure?: boolean; // a sine, like whistling
  seed?: number;
}

export function rng(seed = 1): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; };
}

export function sing(notes: SungNote[], opts: SingOptions = {}): Float32Array {
  const sr = opts.sr ?? 16000;
  const end = Math.max(...notes.map((n) => n.start + n.dur)) + 0.4;
  const out = new Float32Array(Math.round((opts.length ?? end) * sr));
  const rand = rng(opts.seed ?? 3);
  for (const n of notes) {
    const a0 = Math.round(n.start * sr), len = Math.round(n.dur * sr);
    const attack = n.attack ?? 0.03, release = n.release ?? 0.05, amp = n.amp ?? 0.3;
    let phase = 0;
    for (let i = 0; i < len && a0 + i < out.length; i++) {
      const t = i / sr;
      let midi = n.midi;
      if (n.scoop) midi -= (n.scoop / 100) * Math.max(0, 1 - t / 0.07);
      if (n.glideFrom !== undefined) midi += (n.glideFrom - n.midi) * Math.max(0, 1 - t / 0.09);
      let level = amp * Math.min(1, t / attack) * Math.min(1, (n.dur - t) / release);
      if (n.vibrato) {
        const depth = Math.min(1, t / 0.25); // vibrato sets in after the note starts
        midi += (n.vibrato.cents / 100) * depth * Math.sin(2 * Math.PI * n.vibrato.rate * t);
        level *= 1 + (n.vibrato.am ?? 0) * depth * Math.sin(2 * Math.PI * n.vibrato.rate * t + 1);
      }
      const f0 = 440 * 2 ** ((midi - 69) / 12);
      phase += (2 * Math.PI * f0) / sr;
      let v = 0;
      if (opts.pure) v = Math.sin(phase);
      else {
        for (let h = 1; h * f0 < Math.min(4200, sr * 0.45); h++) {
          const hz = h * f0;
          // source roll-off shaped by two vowel-like resonances
          let g = (1 / h) * (1 + 2.2 * Math.exp(-(((hz - 700) / 260) ** 2)) + 1.2 * Math.exp(-(((hz - 1250) / 320) ** 2)));
          if (opts.weakFundamental) g *= h === 1 ? 0.08 : h === 2 ? 2.2 : 1;
          v += g * Math.sin(h * phase);
        }
        v *= 0.4;
      }
      out[a0 + i] += level * (v + (opts.breath ?? 0.03) * rand());
    }
  }
  if (opts.noise) for (let i = 0; i < out.length; i++) out[i] += opts.noise * rand();
  return out;
}

/** Notes at steady spacing: [midi, beats] pairs at a tempo. */
export function line(pairs: [number, number][], bpm: number, opts: Partial<SungNote> & { gap?: number; startAt?: number } = {}): SungNote[] {
  const spb = 60 / bpm;
  let t = opts.startAt ?? 0.3;
  return pairs.map(([midi, beats]) => {
    const n: SungNote = { ...opts, midi, start: t, dur: beats * spb - (opts.gap ?? 0.04) };
    t += beats * spb;
    return n;
  });
}

export type Drum = 'kick' | 'snare' | 'hat' | 'open';

/** Beatbox-like hits at 44.1 kHz. `phone` removes everything under ~350 Hz, like a small microphone. */
export function beatbox(hits: { t: number; type: Drum; amp?: number }[], opts: { phone?: boolean; noise?: number; seed?: number } = {}): { samples: Float32Array; sr: number } {
  const sr = 44100;
  const end = Math.max(...hits.map((h) => h.t)) + 0.8;
  const out = new Float32Array(Math.round(end * sr));
  const rand = rng(opts.seed ?? 9);
  for (const h of hits) {
    const a0 = Math.round(h.t * sr), amp = h.amp ?? 0.5;
    const dur = h.type === 'open' ? 0.45 : 0.3;
    let phase = 0, lp = 0, hp = 0, prev = 0, bp = 0, bp2 = 0;
    for (let i = 0; i < dur * sr && a0 + i < out.length; i++) {
      const t = i / sr, n = rand();
      const att = Math.min(1, t / 0.002);
      let v = 0;
      if (h.type === 'kick') {
        const f = 55 + 70 * Math.exp(-t / 0.03); // "boom": a falling low tone with a lip pop
        phase += (2 * Math.PI * f) / sr;
        lp += 0.08 * (n - lp);
        v = Math.sin(phase) * Math.exp(-t / 0.11) + (0.5 * Math.sin(3 * phase) + 1.2 * lp) * Math.exp(-t / 0.025);
      } else if (h.type === 'snare') {
        // "pf / kh": band-limited noise around 1-4 kHz with a short body tone
        bp += 0.35 * (n - bp); bp2 += 0.06 * (bp - bp2);
        phase += (2 * Math.PI * 210) / sr;
        v = 2.2 * (bp - bp2) * Math.exp(-t / 0.07) + 0.35 * Math.sin(phase) * Math.exp(-t / 0.04);
      } else {
        // "ts": hiss above 5 kHz
        hp = 0.55 * (hp + n - prev); prev = n;
        const hp2 = hp - (lp += 0.45 * (hp - lp));
        v = 1.6 * hp2 * Math.exp(-t / (h.type === 'open' ? 0.22 : 0.025));
      }
      out[a0 + i] += amp * att * v;
    }
  }
  if (opts.phone) {
    // two one-pole high-passes at ~350 Hz
    const a = 1 / (1 + (2 * Math.PI * 350) / sr);
    for (let pass = 0; pass < 2; pass++) {
      let pi = 0, po = 0;
      for (let i = 0; i < out.length; i++) { const o = a * (po + out[i] - pi); pi = out[i]; po = o; out[i] = o; }
    }
  }
  if (opts.noise) for (let i = 0; i < out.length; i++) out[i] += opts.noise * rand();
  return { samples: out, sr };
}

export interface Score { found: number; expected: number; correct: number; precision: number; recall: number; f1: number; meanOnsetErrorMs: number; maxOnsetErrorMs: number }

/** Match detected notes to the truth: same pitch, onset within `tol` seconds, each used once. */
export function score(detected: { pitch: number; start: number }[], truth: { midi: number; start: number }[], tol = 0.07): Score {
  const used = new Set<number>();
  let correct = 0, sum = 0, worst = 0;
  for (const t of truth) {
    let best = -1, bestErr = tol;
    detected.forEach((d, i) => { const err = Math.abs(d.start - t.start); if (!used.has(i) && d.pitch === t.midi && err <= bestErr) { best = i; bestErr = err; } });
    if (best >= 0) { used.add(best); correct++; sum += bestErr; worst = Math.max(worst, bestErr); }
  }
  const precision = detected.length ? correct / detected.length : truth.length ? 0 : 1;
  const recall = truth.length ? correct / truth.length : 1;
  return {
    found: detected.length, expected: truth.length, correct, precision, recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    meanOnsetErrorMs: correct ? (sum / correct) * 1000 : 0, maxOnsetErrorMs: worst * 1000,
  };
}
