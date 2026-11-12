import { describe, expect, it } from 'vitest';
import { resample } from '../src/lib/dsp/resample';
import { classifyHits, detectOnsets, estimateTempo } from '../src/lib/dsp/rhythm';
import { DRUM_PITCH, drumCases } from './cases';
import { score } from './synth';

describe('beatbox to drums', () => {
  for (const c of drumCases()) {
    it(`finds and names the hits: ${c.name}`, () => {
      const onsets = detectOnsets(resample(c.samples, c.sr, 16000), 16000);
      const hits = classifyHits(onsets);
      const s = score(hits, c.truth.map((h) => ({ midi: DRUM_PITCH[h.type], start: h.t })), 0.05);
      expect(Math.abs(hits.length - c.truth.length), 'every hit found once').toBeLessThanOrEqual(1);
      expect(s.f1, `${s.correct} of ${s.expected} named correctly`).toBeGreaterThanOrEqual(0.85);
      expect(s.meanOnsetErrorMs).toBeLessThan(30);
      expect(Math.abs(estimateTempo(onsets)! - c.bpm)).toBeLessThanOrEqual(2);
    });
  }

  it('tells kick, snare and hi-hat apart on a microphone with no bass', () => {
    const c = drumCases().find((k) => /phone/.test(k.name))!;
    const hits = classifyHits(detectOnsets(resample(c.samples, c.sr, 16000), 16000));
    const s = score(hits, c.truth.map((h) => ({ midi: DRUM_PITCH[h.type], start: h.t })), 0.05);
    expect(s.f1).toBe(1);
  });

  it('separates open from closed hi-hats by how long they ring', () => {
    const c = drumCases().find((k) => /open/.test(k.name))!;
    const hits = classifyHits(detectOnsets(resample(c.samples, c.sr, 16000), 16000));
    expect(hits.filter((h) => h.pitch === 46)).toHaveLength(c.truth.filter((h) => h.type === 'open').length);
    expect(hits.filter((h) => h.pitch === 46).every((h) => h.duration >= 0.16)).toBe(true);
  });

  it('gives every hit a confidence and returns nothing for silence', () => {
    const c = drumCases()[0];
    const hits = classifyHits(detectOnsets(resample(c.samples, c.sr, 16000), 16000));
    expect(hits.every((h) => h.confidence! > 0.3 && h.confidence! <= 1)).toBe(true);
    expect(detectOnsets(new Float32Array(16000 * 3), 16000)).toHaveLength(0);
    expect(classifyHits([])).toHaveLength(0);
  });

  it('does not let frequencies above the new limit fold back when resampling', () => {
    // a 15 kHz tone must (almost) vanish at 16 kHz, not reappear at 1 kHz
    const sr = 44100;
    const tone = Float32Array.from({ length: sr }, (_, i) => Math.sin((2 * Math.PI * 15000 * i) / sr));
    const out = resample(tone, sr, 16000);
    const rms = Math.sqrt(out.reduce((a, v) => a + v * v, 0) / out.length);
    expect(rms).toBeLessThan(0.01);
    // while a 1 kHz tone passes untouched
    const low = resample(Float32Array.from({ length: sr }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / sr)), sr, 16000);
    const rmsLow = Math.sqrt(low.slice(200, -200).reduce((a, v) => a + v * v, 0) / (low.length - 400));
    expect(rmsLow).toBeGreaterThan(0.69);
    expect(rmsLow).toBeLessThan(0.72);
  });
});
