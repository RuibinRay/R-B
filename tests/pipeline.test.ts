import { describe, expect, it } from 'vitest';
import { analyzeRecording } from '../src/lib/dsp/analyze';
import { resample } from '../src/lib/dsp/resample';
import { chordAudio, drumCases, melodyCases } from './cases';
import { score } from './synth';

describe('choosing the detector ("decide for me")', () => {
  it('treats singing as a melody, at the microphone sample rate', async () => {
    const c = melodyCases()[1];
    const stages: string[] = [];
    const res = await analyzeRecording(resample(c.audio, 16000, 44100), 44100, 'auto', (_, stage) => { if (stages.at(-1) !== stage) stages.push(stage); });
    expect(res.kind).toBe('melody');
    expect(score(res.notes, c.truth).f1).toBeGreaterThanOrEqual(0.93);
    expect(res.contour!.pitch.length).toBeGreaterThan(100);
    expect(res.stats.voicedRatio).toBeGreaterThan(0.8);
    expect(res.stats.polyphony).toBeLessThan(0.15);
    expect(stages.length).toBeGreaterThanOrEqual(2); // progress is reported in named stages
  });

  it('treats whistling and a noisy take as melodies too', async () => {
    for (const name of ['Whistle (pure tone, C6 up)', 'Heavy noise (about 6 dB)', 'Breathy voice']) {
      const c = melodyCases().find((k) => k.name === name)!;
      expect((await analyzeRecording(c.audio, c.sr, 'auto')).kind, name).toBe('melody');
    }
  });

  it('treats beatboxing as rhythm', async () => {
    for (const c of drumCases()) {
      const res = await analyzeRecording(c.samples, c.sr, 'auto');
      expect(res.kind, c.name).toBe('rhythm');
      expect(res.notes.length).toBeGreaterThan(20);
      expect(Math.abs(res.bpm! - c.bpm)).toBeLessThanOrEqual(2);
    }
  });

  it('recognises several notes sounding at once and hands over to the polyphonic model', async () => {
    const res = await analyzeRecording(chordAudio(), 16000, 'auto');
    expect(res.kind).toBe('poly');
  });

  it('does what it is told when a mode is forced, and survives an empty recording', async () => {
    const c = melodyCases()[0];
    expect((await analyzeRecording(c.audio, c.sr, 'rhythm')).kind).toBe('rhythm');
    expect((await analyzeRecording(drumCases()[0].samples, 44100, 'melody')).kind).toBe('melody');
    const empty = await analyzeRecording(new Float32Array(44100 * 2), 44100, 'auto');
    expect(empty.notes).toHaveLength(0);
  });
});
