import * as Tone from 'tone';
import type { InstrumentDef } from '../lib/instruments';
import { MODELS, MODEL_RATE, generateModel, isSingleZone } from './models';

// Loads, trims and (for sustained instruments) loop-prepares soundfont samples.
// One sample every three semitones is fetched; notes in between are repitched by
// at most one semitone, which keeps downloads small without audible stretching.

export interface Zone { midi: number; buffer: AudioBuffer; loopStart?: number; loopEnd?: number }

const FILE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const CDN = 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/';

let basePromise: Promise<string> | null = null;

/** A self-hosted copy in /samples (see scripts/fetch-samples.mjs) wins over the CDN. */
function sampleBase(): Promise<string> {
  if (!basePromise) {
    const env = import.meta.env.VITE_SAMPLE_BASE as string | undefined;
    const local = `${import.meta.env.BASE_URL}samples/`;
    basePromise = env
      ? Promise.resolve(env)
      : fetch(`${local}manifest.json`)
          .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? local : CDN))
          .catch(() => CDN);
  }
  return basePromise;
}

export function zoneNotes(def: InstrumentDef): number[] {
  const out: number[] = [];
  for (let m = 21; m <= 108; m += 1) {
    if (m % 3 === 0 && m >= def.range[0] - 2 && m <= def.range[1] + 2) out.push(m);
  }
  return out;
}

const fileName = (midi: number): string => `${FILE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

/** Trim the MP3 encoder's leading silence and, for sustained patches, bake a crossfaded loop. */
function prepare(src: AudioBuffer, sustain: boolean): Zone['buffer'] & { __loop?: [number, number] } {
  const sr = src.sampleRate;
  const ch0 = src.getChannelData(0);
  let first = 0;
  const limit = Math.min(ch0.length, Math.floor(sr * 0.06));
  while (first < limit && Math.abs(ch0[first]) < 0.004) first++;
  first = Math.max(0, first - 24);
  const length = src.length - first;
  const out = Tone.getContext().createBuffer(src.numberOfChannels, length, sr) as AudioBuffer & { __loop?: [number, number] };
  const loopStart = Math.floor(0.75 * sr);
  const loopEnd = length - Math.floor(0.12 * sr);
  const fade = Math.floor(0.4 * sr);
  const canLoop = sustain && loopEnd - loopStart > sr * 0.8 && loopStart > fade;
  for (let c = 0; c < src.numberOfChannels; c++) {
    const data = out.getChannelData(c);
    data.set(src.getChannelData(c).subarray(first));
    if (canLoop) {
      // Blend the audio just before the loop start into the end of the loop so the jump is seamless.
      for (let i = 0; i < fade; i++) {
        const w = i / fade;
        const a = Math.cos((w * Math.PI) / 2), b = Math.sin((w * Math.PI) / 2);
        const pos = loopEnd - fade + i;
        data[pos] = data[pos] * a + data[loopStart - fade + i] * b;
      }
    }
  }
  if (canLoop) out.__loop = [loopStart / sr, loopEnd / sr];
  return out;
}

const loaded = new Map<string, Zone[]>();
const pending = new Map<string, Promise<Zone[]>>();
const failed = new Set<string>();

export const loadedZones = (id: string): Zone[] | undefined => loaded.get(id);
export const sampleFailed = (id: string): boolean => failed.has(id);

/** Compute the buffers of a modeled instrument (see models.ts), yielding between notes so the page stays responsive. */
async function modelZones(def: InstrumentDef): Promise<Zone[]> {
  const spec = MODELS[def.model ?? ''];
  if (!spec) throw new Error(`Unknown sound model for ${def.name}`);
  const zones: Zone[] = [];
  for (const midi of isSingleZone(spec) ? [60] : zoneNotes(def)) {
    const g = generateModel(spec, midi);
    const buffer = Tone.getContext().createBuffer(1, g.data.length, MODEL_RATE);
    buffer.getChannelData(0).set(g.data);
    zones.push(g.loop ? { midi: g.midi, buffer, loopStart: g.loop[0], loopEnd: g.loop[1] } : { midi: g.midi, buffer });
    await new Promise((r) => setTimeout(r, 0));
  }
  loaded.set(def.id, zones);
  return zones;
}

export function loadZones(def: InstrumentDef): Promise<Zone[]> {
  const done = loaded.get(def.id);
  if (done) return Promise.resolve(done);
  let p = pending.get(def.id);
  if (!p && def.engine === 'model') {
    p = modelZones(def);
    pending.set(def.id, p);
    p.catch(() => pending.delete(def.id));
  }
  if (!p) {
    p = (async () => {
      const base = await sampleBase();
      const results = await Promise.allSettled(
        zoneNotes(def).map(async (midi): Promise<Zone> => {
          const res = await fetch(`${base}${def.gm}-mp3/${fileName(midi)}.mp3`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const decoded = await Tone.getContext().decodeAudioData(await res.arrayBuffer());
          const buffer = prepare(decoded, !!def.sustain);
          const loop = buffer.__loop;
          return loop ? { midi, buffer, loopStart: loop[0], loopEnd: loop[1] } : { midi, buffer };
        }),
      );
      const zones = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])).sort((a, b) => a.midi - b.midi);
      if (!zones.length) {
        failed.add(def.id);
        throw new Error(`No samples could be loaded for ${def.name}`);
      }
      failed.delete(def.id);
      loaded.set(def.id, zones);
      return zones;
    })();
    pending.set(def.id, p);
    p.catch(() => pending.delete(def.id));
  }
  return p;
}
