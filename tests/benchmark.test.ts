import { describe, it } from 'vitest';
import { detectMelody } from '../src/lib/dsp/pitch';
import { resample } from '../src/lib/dsp/resample';
import { classifyHits, detectOnsets, estimateTempo } from '../src/lib/dsp/rhythm';
import { analyzeRecording } from '../src/lib/dsp/analyze';
import * as v1 from './baseline/pitch-v1';
import * as r1 from './baseline/rhythm-v1';
import { DRUM_PITCH, drumCases, melodyCases } from './cases';
import { score } from './synth';

// Prints accuracy, speed and memory for the detectors, old against new. Run: npm run bench

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const pct = (v: number) => `${Math.round(v * 100)}%`;

describe('benchmark', () => {
  it('melody transcription: previous version against this one', async () => {
    const rows: string[] = [];
    let oldSum = 0, newSum = 0, audio = 0, ms = 0;
    for (const c of melodyCases()) {
      const before = score((await v1.detectMelody(c.audio, c.sr)).notes, c.truth);
      const t0 = performance.now();
      const now = score((await detectMelody(c.audio, c.sr)).notes, c.truth);
      ms += performance.now() - t0;
      audio += c.audio.length / c.sr;
      oldSum += before.f1; newSum += now.f1;
      rows.push(`${pad(c.name, 38)} ${pad(`${before.correct}/${before.expected} (${before.found} found)`, 20)} ${pad(pct(before.f1), 6)} ${pad(`${now.correct}/${now.expected} (${now.found} found)`, 20)} ${pad(pct(now.f1), 6)} ${now.meanOnsetErrorMs.toFixed(0)} ms`);
    }
    const n = rows.length;
    console.log(['', `${pad('MELODY', 38)} ${pad('before: right/expected', 20)} ${pad('F1', 6)} ${pad('now: right/expected', 20)} ${pad('F1', 6)} onset error`, ...rows,
      `${pad('Average F1', 38)} ${pad('', 20)} ${pad(pct(oldSum / n), 6)} ${pad('', 20)} ${pad(pct(newSum / n), 6)}`,
      `Speed: ${audio.toFixed(0)} s of audio in ${(ms / 1000).toFixed(2)} s (${(audio / (ms / 1000)).toFixed(0)}x faster than real time)`, ''].join('\n'));
  });

  it('beatbox classification: previous version against this one', () => {
    const rows: string[] = [];
    for (const c of drumCases()) {
      const x = resample(c.samples, c.sr, 16000);
      const truth = c.truth.map((h) => ({ midi: DRUM_PITCH[h.type], start: h.t }));
      // the previous version also used a crude resampler; give both the same clean input so only the detector differs
      const before = score(r1.classifyHits(r1.detectOnsets(x, 16000)), truth, 0.05);
      const onsets = detectOnsets(x, 16000);
      const now = score(classifyHits(onsets), truth, 0.05);
      rows.push(`${pad(c.name, 38)} ${pad(`${before.correct}/${before.expected}`, 10)} ${pad(pct(before.f1), 6)} ${pad(`${now.correct}/${now.expected}`, 10)} ${pad(pct(now.f1), 6)} tempo ${estimateTempo(onsets)} (true ${c.bpm})`);
    }
    console.log(['', `${pad('BEATBOX', 38)} ${pad('before', 10)} ${pad('F1', 6)} ${pad('now', 10)} ${pad('F1', 6)}`, ...rows, ''].join('\n'));
  });

  it('whole pipeline: speed and memory on a two-minute take', async () => {
    const one = melodyCases()[1];
    const reps = Math.ceil((120 * 44100) / (one.audio.length * (44100 / one.sr)));
    // a 44.1 kHz recording, as the microphone delivers it
    const src = new Float32Array(one.audio.length * reps);
    for (let r = 0; r < reps; r++) src.set(one.audio, r * one.audio.length);
    const mic = resample(src, 16000, 44100);
    // memory: the most that was in use at any progress report, over what was in use before
    const used = () => { const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
    const before = used();
    let peak = before;
    const t0 = performance.now();
    const res = await analyzeRecording(mic, 44100, 'auto', () => { peak = Math.max(peak, used()); });
    const took = performance.now() - t0;
    peak = Math.max(peak, used());
    const sec = mic.length / 44100;
    console.log(['', `PIPELINE  ${sec.toFixed(0)} s recording at 44.1 kHz -> ${res.notes.length} notes (${res.kind})`,
      `  time ${(took / 1000).toFixed(2)} s (${(sec / (took / 1000)).toFixed(0)}x faster than real time)`,
      `  peak extra memory while analysing: about ${((peak - before) / 1e6).toFixed(0)} MB (the recording itself is ${(mic.byteLength / 1e6).toFixed(0)} MB)`, ''].join('\n'));
  });
});
