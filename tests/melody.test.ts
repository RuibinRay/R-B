import { describe, expect, it } from 'vitest';
import { detectMelody } from '../src/lib/dsp/pitch';
import { estimateTempo } from '../src/lib/dsp/rhythm';
import { melodyCases } from './cases';
import { line, rng, score, sing } from './synth';

const SR = 16000;

describe('melody transcription', () => {
  for (const c of melodyCases()) {
    it(`finds the right notes: ${c.name}`, async () => {
      const res = await detectMelody(c.audio, c.sr);
      const s = score(res.notes, c.truth);
      expect(s.recall, `${s.correct} of ${s.expected} notes found`).toBeGreaterThanOrEqual(0.93);
      expect(s.precision, `${s.found} notes reported for ${s.expected}`).toBeGreaterThanOrEqual(0.93);
      expect(s.meanOnsetErrorMs).toBeLessThan(45);
    });
  }

  it('keeps repeated notes on one pitch apart (clear gaps and soft re-articulations)', async () => {
    for (const name of ['Repeated notes, clear gaps', 'Repeated notes, legato (soft dips)']) {
      const c = melodyCases().find((k) => k.name === name)!;
      const res = await detectMelody(c.audio, c.sr);
      expect(res.notes.length, name).toBe(c.truth.length);
      expect(new Set(res.notes.map((n) => n.pitch)).size, name).toBe(1);
    }
  });

  it('keeps a long note with vibrato as one note, with its length and its wobble', async () => {
    const res = await detectMelody(sing([{ midi: 67, start: 0.3, dur: 3.2, vibrato: { rate: 5.5, cents: 80, am: 0.2 } }]), SR);
    expect(res.notes).toHaveLength(1);
    expect(res.notes[0].pitch).toBe(67);
    expect(res.notes[0].duration).toBeGreaterThan(3.0);
    expect(res.notes[0].duration).toBeLessThan(3.35);
    const bend = res.notes[0].bend!;
    expect(bend, 'vibrato is kept as a pitch contour').toBeDefined();
    expect(Math.max(...bend) - Math.min(...bend)).toBeGreaterThan(80); // +-80 cents sung
    expect(Math.max(...bend.map(Math.abs))).toBeLessThanOrEqual(200);
  });

  it('gives a steady note no pitch contour, and a scooped note one that starts flat', async () => {
    const res = await detectMelody(sing([{ midi: 62, start: 0.3, dur: 0.8 }, { midi: 64, start: 1.4, dur: 0.8, scoop: 150 }]), SR);
    expect(res.notes.map((n) => n.pitch)).toEqual([62, 64]);
    expect(res.notes[0].bend).toBeUndefined();
    expect(res.notes[1].bend![0]).toBeLessThan(-40);
    expect(Math.abs(res.notes[1].bend!.at(-1)!)).toBeLessThan(25);
  });

  it('measures note lengths to within 80 ms', async () => {
    const sung = line([[60, 0.5], [64, 1], [67, 2], [65, 0.25], [64, 0.25], [62, 1.5]], 100);
    const res = await detectMelody(sing(sung), SR);
    expect(res.notes).toHaveLength(sung.length);
    res.notes.forEach((n, i) => expect(Math.abs(n.duration - sung[i].dur), `note ${i}`).toBeLessThan(0.08));
  });

  it('reports nothing for silence, hiss or a hum of mains noise', async () => {
    const rand = rng(4);
    const hiss = Float32Array.from({ length: SR * 4 }, () => 0.05 * rand());
    const hum = Float32Array.from({ length: SR * 4 }, (_, i) => 0.002 * Math.sin((2 * Math.PI * 50 * i) / SR) + 0.001 * rand());
    expect((await detectMelody(new Float32Array(SR * 4), SR)).notes).toHaveLength(0);
    expect((await detectMelody(hiss, SR)).notes).toHaveLength(0);
    expect((await detectMelody(hum, SR)).notes).toHaveLength(0);
  });

  it('carries loudness over: quiet notes get lower velocities than loud ones', async () => {
    const sung = line([[60, 1], [62, 1], [64, 1], [65, 1], [67, 1], [69, 1]], 100).map((n, i) => ({ ...n, amp: i % 2 ? 0.07 : 0.4 }));
    const res = await detectMelody(sing(sung), SR);
    expect(res.notes).toHaveLength(6);
    const loud = res.notes.filter((_, i) => i % 2 === 0).map((n) => n.velocity), quiet = res.notes.filter((_, i) => i % 2 === 1).map((n) => n.velocity);
    expect(Math.min(...loud)).toBeGreaterThan(Math.max(...quiet) + 0.15);
  });

  it('carries a swell inside a note over as a loudness contour', async () => {
    const audio = sing([{ midi: 64, start: 0.3, dur: 2 }]);
    for (let i = 0; i < audio.length; i++) { const t = i / SR - 0.3; if (t > 0 && t < 2) audio[i] *= 0.25 + 0.75 * (t / 2); } // crescendo
    const res = await detectMelody(audio, SR);
    const dyn = res.notes[0].dyn!;
    expect(dyn).toBeDefined();
    expect(dyn.at(-2)!).toBeGreaterThan(dyn[1] * 1.6);
  });

  it('is confident about clean notes and marks doubtful ones', async () => {
    const clean = await detectMelody(sing(line([[60, 1], [62, 1], [64, 1], [65, 1]], 100)), SR);
    expect(clean.meanConfidence).toBeGreaterThan(0.8);
    expect(clean.notes.every((n) => !n.issue && n.confidence! >= 0.6)).toBe(true);

    // one note sung almost a quarter-tone sharp, and one lone note more than an octave above its neighbours
    const sung = line([[60, 1], [62.45, 1], [64, 1], [79, 1], [65, 1], [64, 1]], 100);
    const res = await detectMelody(sing(sung), SR);
    expect(res.notes).toHaveLength(6);
    expect(res.notes[1].issue).toBe('between');
    expect(res.notes[1].confidence!).toBeLessThan(0.6);
    expect(res.notes[3].pitch).toBe(79); // a real leap is kept as sung...
    expect(res.notes[3].issue).toBe('octave'); // ...and marked for a look
    expect(res.notes[0].issue).toBeUndefined();
  });

  it('estimates the tempo of a sung line', async () => {
    for (const bpm of [80, 100, 120, 140]) {
      const pattern: [number, number][] = [[60, 1], [62, 0.5], [64, 0.5], [65, 1], [67, 1], [65, 0.5], [64, 0.5], [62, 1], [60, 1], [64, 1], [67, 1], [72, 1], [67, 1]];
      const res = await detectMelody(sing(line(pattern, bpm)), SR);
      const found = estimateTempo(res.notes.map((n) => ({ time: n.start, strength: n.velocity })))!;
      // half or double time is the same pulse counted differently
      const off = Math.min(...[0.5, 1, 2].map((k) => Math.abs(found * k - bpm)));
      expect(off, `${bpm} BPM heard as ${found}`).toBeLessThanOrEqual(3);
    }
  });
});
