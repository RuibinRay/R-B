import { defaultFx, type FxState, type MidiClip, type Note, type Project, type Track } from '../../types';
import { getInstrument } from '../instruments';
import { SCALES, chordPitches, uid } from '../music';
import { createProject, newTrack } from '../templates';
import { type Answer, type Genome, rngFrom, type Rng } from './genome';
import { GENRES, ROLES, type ChordSpec, type Role, type Section, type SectionPlan } from './knowledge';
import { partLoudness } from './profiles';

// Genome -> notes. Everything here is deterministic for a given genome (its seed drives
// the small random choices), so a beat that scored well sounds the same when played.

export interface Part { role: Role; instrumentId: string; notes: Note[]; volume: number; pan: number; fx: FxState }
export interface SectionSpan extends SectionPlan { startBar: number }
export interface BarChord { rootPc: number; quality: string; tones: number[] } // tones: pitch classes
export interface Composition {
  genome: Genome;
  bpm: number;
  key: { root: number; scale: Genome['scale'] };
  lengthBars: number;
  sections: SectionSpan[];
  chords: BarChord[];
  parts: Part[];
}
export type Length = 'loop' | 'song';

/** Target loudness (in the units the profiles were measured in) of the loudest role. */
const ANCHOR = -32;
const BAR = 4;

const fit = (pitch: number, range: [number, number]): number => {
  let p = pitch;
  while (p < range[0]) p += 12;
  while (p > range[1]) p -= 12;
  return p < range[0] ? range[0] : p;
};

function chordAt(prog: ChordSpec[], bar: number): ChordSpec {
  const L = prog.length;
  const pos = bar % 4;
  if (L >= 4) return prog[pos % L];
  if (L === 2) return prog[pos < 2 ? 0 : 1];
  if (L === 3) return prog[pos < 1 ? 0 : pos < 2 ? 1 : 2];
  return prog[0];
}

/** Chord voicing nearest to the previous one (smooth voice leading). */
function voice(chord: BarChord, octave: number, style: Genome['voicing'], prev: number[] | null): number[] {
  const base = chordPitches(chord.rootPc, chord.quality, octave);
  let tones = style === 'triad' ? base.slice(0, 3) : base.slice(0, 4);
  if (style === 'open') tones = [base[0] - 12, base[2] ?? base[1], (base[1] ?? base[0]) + 12, ...(base[3] !== undefined ? [base[3] + 12] : [])];
  if (!prev) return tones;
  const options: number[][] = [];
  for (let inv = 0; inv < tones.length; inv++) {
    for (const shift of [-12, 0, 12]) {
      const v = tones.map((t, i) => t + shift + (i < inv ? 12 : 0)).sort((a, b) => a - b);
      options.push(v);
    }
  }
  const centre = prev.reduce((a, b) => a + b, 0) / prev.length;
  const home = 12 * (octave + 1) + 4;
  let best = options[0], bestCost = Infinity;
  for (const o of options) {
    const c = o.reduce((a, b) => a + b, 0) / o.length;
    const cost = Math.abs(c - centre) + 0.25 * Math.abs(c - home);
    if (cost < bestCost) { bestCost = cost; best = o; }
  }
  return best;
}

/** Scale degree -> MIDI pitch (degrees beyond the scale wrap into the next octave). */
function degreePitch(deg: number, root: number, steps: number[], octave: number): number {
  const n = steps.length;
  const o = Math.floor(deg / n), i = ((deg % n) + n) % n;
  return 12 * (octave + 1) + root + steps[i] + 12 * o;
}

function answerOf(motif: Genome['motif'], kind: Answer): Genome['motif'] {
  if (!motif.length) return motif;
  if (kind === 'repeat') return motif;
  if (kind === 'sequence') return motif.map((n) => ({ ...n, deg: n.deg + 1 }));
  if (kind === 'invert') return motif.map((n) => ({ ...n, deg: Math.max(-3, Math.min(9, 2 * motif[0].deg - n.deg)) }));
  // resolve: the phrase ends on the tonic, held
  const out = motif.map((n) => ({ ...n }));
  const last = out[out.length - 1];
  last.deg = last.deg > 3 ? 7 : 0;
  last.len = Math.max(last.len, 32 - last.step);
  return out;
}

const shouldPlay = (section: SectionSpan, role: Role) => section.roles.includes(role);

export function sectionsFor(g: Genome, length: Length): SectionSpan[] {
  const genre = GENRES[g.genre];
  const plan: SectionPlan[] = length === 'loop'
    ? [{ name: 'loop', bars: 8, energy: 1, roles: ROLES.filter((r) => r !== 'texture' || !['riser', 'impact', 'downlifter', 'orchestra-hit'].includes(g.inst.texture ?? '')) }]
    : genre.forms[g.form % genre.forms.length];
  let bar = 0;
  return plan.map((s) => { const span = { ...s, startBar: bar }; bar += s.bars; return span; });
}

export function compose(g: Genome, length: Length = 'loop'): Composition {
  const genre = GENRES[g.genre];
  const rng: Rng = rngFrom(g.seed);
  const sections = sectionsFor(g, length);
  const lengthBars = sections.reduce((a, s) => a + s.bars, 0);
  const steps = SCALES[g.scale].steps;
  const prog = genre.progressions[g.prog % genre.progressions.length];
  const chords: BarChord[] = Array.from({ length: lengthBars }, (_, bar) => {
    const [semis, quality] = chordAt(prog, bar);
    const rootPc = (g.root + semis) % 12;
    return { rootPc, quality, tones: chordPitches(rootPc, quality, 4).map((p) => p % 12) };
  });
  const spb16 = 0.25;
  const habits = genre.habits ?? {};
  const swing = (step: number) => (step % 2 === 1 ? g.swing * spb16 : 0);
  const notes: Partial<Record<Role, Note[]>> = {};
  const add = (role: Role, pitch: number, start: number, duration: number, velocity: number) => {
    (notes[role] ??= []).push({ id: uid(), pitch, start, duration: Math.max(0.05, duration), velocity: Math.max(0.05, Math.min(1, velocity)) });
  };
  const rangeOf = (role: Role): [number, number] => getInstrument(g.inst[role])?.range ?? [24, 108];

  for (const sec of sections) {
    const vScale = 0.72 + 0.28 * sec.energy;
    for (let b = 0; b < sec.bars; b++) {
      const bar = sec.startBar + b;
      const t0 = bar * BAR;
      const chord = chords[bar];
      const lastOfPhrase = b % 2 === 1;

      // ---- drums ----
      if (g.drums && g.inst.drums && shouldPlay(sec, 'drums')) {
        const d = g.drums;
        const half = (b % 2) * 16;
        const sparse = sec.energy < 0.5;
        const snarePitch = genre.family === 'electronic' || g.genre === 'trap' ? 39 : 38;
        const finalBuildBar = sec.name === 'build' && b === sec.bars - 1;
        // The end of a phrase is marked: the last bar of every eight, and the bar before a new section.
        const nextSec = sections[sections.indexOf(sec) + 1];
        const sectionEnd = b === sec.bars - 1 && !!nextSec;
        const phraseEnd = (b % 8 === 7 || sectionEnd) && !(habits.seamless && length === 'loop' && b === sec.bars - 1);
        const fill = phraseEnd && !sparse && sec.name !== 'build' ? (habits.fill ?? 'fill') : 'none';
        const dropout = fill === 'dropout' && nextSec ? true : fill === 'dropout' && b % 8 === 7;
        // Humanize: players drift a few milliseconds and never hit two notes exactly alike.
        const drift = (habits.humanize ?? 0) * 0.008 * (g.bpm / 60);
        const human = (at: number) => Math.max(sec.startBar * BAR, at + (drift ? (rng() - 0.5) * 2 * drift : 0));
        const vary = (v: number) => v * (1 + (habits.humanize ?? 0) * 0.2 * (rng() - 0.5));
        // Hi-hat dynamics from drum programming guides: strong on the beat, medium on the
        // off-beat eighth, soft on the sixteenths in between.
        const hatAccent = (s: number) => (s % 4 === 0 ? 1 : s % 2 === 0 ? 0.72 : 0.5);
        const backbeats = genre.halfTime ? [8] : [4, 12];
        for (let s = 0; s < 16; s++) {
          const at = t0 + s * spb16 + swing(s);
          const inFill = fill === 'fill' && s >= 12;
          const k = d.kick[half + s], sn = d.snare[half + s], h = d.hat[half + s], o = d.open[half + s];
          if (dropout && s >= 14) continue; // a breath before the next phrase lands
          if (k && !(finalBuildBar && s >= 12) && !inFill) add('drums', 36, human(at), 0.25, vary(k) * vScale);
          if (sn && !sparse && sec.name !== 'build' && !inFill) add('drums', snarePitch, human(at), 0.25, vary(sn) * vScale);
          else if (!sn && !sparse && !inFill && d.ghosts > 0 && backbeats.some((bb) => bb - 1 === s) && rng() < d.ghosts * 1.5) {
            add('drums', 38, human(at), 0.12, 0.3 + 0.08 * rng()); // ghost note leading into the backbeat
          }
          const rollZone = lastOfPhrase && s >= 12 && d.rolls > 0 && rng() < d.rolls && !inFill;
          if (rollZone && s === 12) {
            const n = rng() < 0.5 ? 6 : 8; // triplet or 32nd roll over the last beat
            for (let i = 0; i < n; i++) add('drums', 42, t0 + 3 + i / n, 0.08, (0.35 + (0.5 * i) / n) * vScale);
          } else if (!(lastOfPhrase && s >= 12 && rollZone) && h && !inFill) add('drums', 42, human(at), 0.1, vary(h * hatAccent(s)) * (sparse ? 0.7 : 1) * vScale);
          if (o && !sparse && !inFill) add('drums', 46, human(at), 0.4, vary(o) * 0.85 * vScale);
        }
        if (fill === 'fill') {
          // a one-beat fill on the last beat: snare and toms falling to the next downbeat
          const kit = [38, 48, 45, 41];
          const shape = rng() < 0.5 ? [0, 1, 2, 3] : [0, 0, 1, 2];
          shape.forEach((which, i) => add('drums', kit[which], t0 + 3 + i * 0.25 + swing(i), 0.2, (0.6 + 0.1 * i) * vScale));
        } else if (fill === 'roll' && (b % 8 === 7 || sectionEnd)) {
          // house and techno: a sixteenth snare roll fading up through the last bar
          for (let i = 0; i < 16; i++) add('drums', 38, t0 + i * spb16, 0.1, (0.25 + 0.5 * (i / 15)) * vScale);
        }
        if (sec.name === 'build') {
          // snare roll that doubles in speed through the section
          const rate = b < sec.bars / 2 ? 2 : b < sec.bars - 1 ? 4 : 8;
          const stop = finalBuildBar ? 3 : 4;
          for (let i = 0; i < rate * stop; i++) add('drums', 38, t0 + i / rate, 0.1, 0.45 + 0.5 * ((b * rate * 4 + i) / (sec.bars * rate * 4)));
        }
        const prevSec = sections[sections.indexOf(sec) - 1];
        if (b === 0 && (sec.name === 'hook' || sec.name === 'drop' || (prevSec && (habits.fill ?? 'fill') !== 'none'))) add('drums', 49, t0, 2, sec.name === 'hook' || sec.name === 'drop' ? 0.7 : 0.55);
      }

      // ---- bass ----
      if (g.inst.bass && shouldPlay(sec, 'bass')) {
        const range = rangeOf('bass');
        const root = fit(12 * (g.bassOct + 1) + chord.rootPc, range);
        const fifth = fit(root + 7, range);
        const kicks = g.drums ? g.drums.kick.slice((b % 2) * 16, (b % 2) * 16 + 16).map((v, s) => (v ? s : -1)).filter((s) => s >= 0) : [0, 8];
        const v = 0.85 * vScale;
        switch (g.bassStyle) {
          case 'follow-kick':
          case 'glide': {
            const hits = kicks.length ? kicks : [0, 8];
            let prev = -1;
            hits.forEach((s, i) => {
              const next = hits[i + 1] ?? 16;
              const jump = g.bassStyle === 'glide' && i > 0 && rng() < 0.3 ? 12 : 0;
              const pitch = fit(root + jump, range);
              const len = Math.min(8, next - s) * spb16 * 0.95;
              add('bass', pitch, t0 + s * spb16, len, v);
              // 808 slide: the note starts on the previous pitch and glides in (kept within an octave)
              if (habits.slides && g.bassStyle === 'glide' && prev >= 0 && prev !== pitch && Math.abs(prev - pitch) <= 12 && rng() < 0.45) {
                const n = notes.bass![notes.bass!.length - 1];
                n.bend = [(prev - pitch) * 100, Math.round((prev - pitch) * 35), 0, 0, 0, 0, 0, 0];
              }
              prev = pitch;
            });
            break;
          }
          case 'roots': add('bass', root, t0, 1.9, v); add('bass', rng() < 0.4 ? fifth : root, t0 + 2, 1.9, v * 0.9); break;
          case 'pulse8': for (let i = 0; i < 8; i++) add('bass', i % 4 === 3 && rng() < 0.3 ? fit(root + 12, range) : root, t0 + i * 0.5, 0.42, i % 2 ? v * 0.8 : v); break;
          case 'offbeat': for (let i = 0; i < 4; i++) add('bass', root, t0 + i + 0.5, 0.35, v); break;
          case 'rumble': for (let i = 0; i < 4; i++) for (const s of [1, 2, 3]) add('bass', root, t0 + i + s * spb16, 0.2, s === 2 ? v : v * 0.75); break;
          case 'walking': {
            const tones = [root, fit(root + (chord.quality.startsWith('min') ? 3 : 4), range), fifth, fit(root + (rng() < 0.5 ? 10 : 9), range)];
            for (let i = 0; i < 4; i++) add('bass', tones[i], t0 + i, 0.9, v * (i === 0 ? 1 : 0.85));
            break;
          }
          case 'arp': { const tones = [root, fit(root + 7, range), fit(root + 12, range), fit(root + 7, range)]; for (let i = 0; i < 8; i++) add('bass', tones[i % 4], t0 + i * 0.5, 0.4, v); break; }
        }
      }

      // ---- chords and pad ----
      const vChord = voice(chord, g.chordOct, g.voicing, (notes.chords ?? []).length ? (notes.chords ?? []).slice(-4).map((n) => n.pitch) : null).map((p) => fit(p, rangeOf('chords')));
      if (g.inst.chords && shouldPlay(sec, 'chords')) {
        const hit = (at: number, dur: number, vel: number) => vChord.forEach((p) => add('chords', p, t0 + at, dur, vel * vScale));
        switch (g.chordStyle) {
          case 'block': hit(0, 3.9, 0.62); break;
          case 'swell': hit(0, 3.95, 0.5); break;
          case 'half': hit(0, 1.9, 0.62); hit(2, 1.9, 0.55); break;
          case 'pulse': for (let i = 0; i < 4; i++) hit(i, 0.45, i % 2 ? 0.55 : 0.62); break;
          case 'eighths': for (let i = 0; i < 8; i++) hit(i * 0.5, 0.4, i % 2 ? 0.5 : 0.62); break;
          case 'stab': { const rhythm = g.seed % 3 === 0 ? [0, 1.5, 3] : g.seed % 3 === 1 ? [0.5, 2.5] : [0, 0.75, 2, 2.75]; rhythm.forEach((at) => hit(at, 0.3, 0.66)); break; }
          case 'arp': case 'arp8': {
            const rate = g.chordStyle === 'arp' ? 4 : 2;
            for (let i = 0; i < 4 * rate; i++) add('chords', vChord[i % vChord.length], t0 + i / rate, 1 / rate - 0.02, (i % rate === 0 ? 0.65 : 0.52) * vScale);
            break;
          }
        }
      }
      if (g.inst.pad && shouldPlay(sec, 'pad') && b % 2 === 0) {
        const range = rangeOf('pad');
        voice(chord, g.chordOct, 'triad', null).map((p) => fit(p + 12, range)).forEach((p) => add('pad', p, t0, Math.min(8, (sec.bars - b) * 4) - 0.1, 0.48 * vScale));
      }
      if (g.inst.arp && shouldPlay(sec, 'arp')) {
        const range = rangeOf('arp');
        const pool = [...vChord.map((p) => p + 12), vChord[0] + 24].map((p) => fit(p, range)).sort((a, z) => a - z);
        const order = g.arp === 'up' ? pool : g.arp === 'down' ? [...pool].reverse() : g.arp === 'updown' ? [...pool, ...pool.slice(1, -1).reverse()] : [pool[0], pool[2] ?? pool[0], pool[1], pool[3] ?? pool[1]];
        const n = 4 * g.arpRate;
        for (let i = 0; i < n; i++) add('arp', order[i % order.length], t0 + i / g.arpRate + swing(i % 2 ? 1 : 0), 1 / g.arpRate - 0.03, (i % g.arpRate === 0 ? 0.62 : 0.5) * vScale);
      }

      // ---- melody: the motif, then its answer, as a four-bar phrase ----
      if (g.inst.lead && shouldPlay(sec, 'lead') && b % 2 === 0) {
        const range = rangeOf('lead');
        const phrasePos = b % 4; // 0: motif, 2: answer
        const last8 = b + 2 >= sec.bars && sec.bars >= 8;
        let motif = phrasePos === 0 ? g.motif : answerOf(g.motif, g.answer);
        if (last8) motif = answerOf(motif, 'resolve');
        for (const n of motif) {
          const bar2 = Math.floor(n.step / 16);
          if (b + bar2 >= sec.bars) continue;
          const ch = chords[bar + bar2];
          let p = degreePitch(n.deg, g.root, steps, g.melOct);
          if (n.step % 8 === 0 && !ch.tones.includes(((p % 12) + 12) % 12)) {
            // a note on a strong beat leans onto the nearest chord tone
            for (const d of [1, -1, 2, -2]) if (ch.tones.includes((((p + d) % 12) + 12) % 12)) { p += d; break; }
          }
          add('lead', fit(p, range), t0 + n.step * spb16 + swing(n.step), n.len * spb16 * 0.95, (0.55 + 0.4 * n.acc) * vScale);
        }
      }
    }

    // ---- texture: once per section ----
    const tex = g.inst.texture;
    if (tex && shouldPlay(sec, 'texture')) {
      const t0 = sec.startBar * BAR, len = sec.bars * BAR;
      if (tex === 'riser') {
        const next = sections[sections.indexOf(sec) + 1];
        const target = next && (next.name === 'hook' || next.name === 'drop') ? next.startBar * BAR : t0 + len;
        const beats = (4 * g.bpm) / 60; // the riser sample lasts about four seconds
        add('texture', 60, Math.max(t0, target - beats), Math.min(beats, target - t0), 0.8);
      } else if (tex === 'impact' || tex === 'orchestra-hit') add('texture', tex === 'impact' ? 48 : 60, t0, 3, 0.85);
      else if (tex === 'downlifter') add('texture', 60, t0, Math.min(len, 8), 0.7);
      else if (tex === 'taiko' || tex === 'timpani') {
        for (let b = 0; b < sec.bars; b++) {
          const rootPitch = fit(36 + chords[sec.startBar + b].rootPc, rangeOf('texture'));
          (tex === 'taiko' ? [0, 0.75, 1.5, 3] : b % 2 === 0 ? [0] : [3.5]).forEach((at, i) => add('texture', tex === 'taiko' ? 41 : rootPitch, t0 + b * BAR + at, 0.5, i === 0 ? 0.85 : 0.65));
        }
      } else if (tex === 'laser-zap') { for (let b = 3; b < sec.bars; b += 4) add('texture', 72, t0 + b * BAR + 3.5, 0.4, 0.6); }
      else add('texture', fit(60, rangeOf('texture')), t0, len - 0.05, 0.65); // a bed of crackle, rain, wind or birds
    }
  }

  const parts: Part[] = [];
  for (const role of ROLES) {
    const id = g.inst[role];
    const ns = notes[role];
    if (!id || !ns?.length) continue;
    parts.push({ role, instrumentId: id, notes: ns, volume: volumeFor(g, role, id, ns), pan: role === 'arp' ? 0.25 : role === 'pad' ? -0.15 : role === 'texture' ? 0.1 : 0, fx: fxFor(g, role) });
  }
  return { genome: g, bpm: g.bpm, key: { root: g.root, scale: g.scale }, lengthBars, sections, chords, parts };
}

/**
 * Gain staging, as an engineer would do it: the fader that brings this part to the level
 * the style wants, from the measured loudness of the instrument and how much it plays.
 */
export function volumeFor(g: Genome, role: Role, instrumentId: string, notes: Note[]): number {
  const genre = GENRES[g.genre];
  const typical = partLoudness(instrumentId, notes, g.bpm);
  const want = ANCHOR + (genre.levels[role] ?? -10) + (g.levels[role] ?? 0);
  return Math.round(Math.max(-36, Math.min(6, want - typical)) * 2) / 2;
}

function fxFor(g: Genome, role: Role): FxState {
  const genre = GENRES[g.genre];
  const fx = defaultFx();
  const wet = { drums: 0.2, bass: 0, chords: 0.7, lead: 0.55, pad: 1, arp: 0.7, texture: 0.6 }[role];
  if (wet > 0 && genre.reverb > 0) fx.reverb = { on: true, decay: Math.round((1.1 + 3.2 * genre.reverb) * 10) / 10, mix: Math.round(Math.min(0.5, genre.reverb * wet * 0.6) * 100) / 100 };
  if ((role === 'lead' || role === 'arp') && (genre.family === 'electronic' || g.genre === 'trap' || g.genre === 'lofi')) {
    fx.delay = { on: true, time: Math.round((60 / g.bpm) * 0.75 * 1000) / 1000, feedback: 0.3, mix: 0.18 };
  }
  if (g.genre === 'lofi' || g.genre === 'boombap') fx.eq = { on: true, low: role === 'drums' ? 2 : 0, mid: 0, high: role === 'texture' ? 0 : -5 };
  return fx;
}

const PART_NAMES: Record<Role, string> = { drums: 'Drums', bass: 'Bass', chords: 'Chords', lead: 'Melody', pad: 'Pad', arp: 'Arpeggio', texture: 'Texture' };

/** The composition as a normal R&B project: one track per part, one clip per section. */
export function toProject(c: Composition, name: string): Project {
  const p = createProject(name);
  p.tracks = [];
  p.clips = [];
  p.bpm = c.bpm;
  p.key = { root: c.key.root, scale: c.key.scale };
  p.markers = c.sections.length > 1 ? c.sections.map((s) => ({ id: uid(), beat: s.startBar * BAR, name: s.name[0].toUpperCase() + s.name.slice(1) })) : [];
  const kicks = (c.parts.find((x) => x.role === 'drums')?.notes ?? []).filter((n) => n.pitch === 36).map((n) => n.start).sort((x, y) => x - y);
  for (const part of c.parts) {
    const def = getInstrument(part.instrumentId);
    const t: Track = newTrack(`${PART_NAMES[part.role]}${def ? ` (${def.name})` : ''}`, part.instrumentId, { volume: part.volume, pan: part.pan, fx: part.fx });
    const duck = GENRES[c.genome.genre].habits?.sidechain;
    if (duck && kicks.length && (part.role === 'bass' || part.role === 'chords' || part.role === 'pad' || part.role === 'arp')) {
      // Sidechain pump: the part dips on every kick and recovers within an eighth note.
      const depth = part.role === 'bass' ? duck : duck * 0.6;
      const pts: { id: string; beat: number; value: number }[] = [];
      for (const k of kicks) pts.push({ id: uid(), beat: Math.max(0, k - 0.02), value: 0 }, { id: uid(), beat: k + 0.01, value: -depth }, { id: uid(), beat: k + 0.45, value: 0 });
      t.automation = { volume: pts };
    }
    p.tracks.push(t);
    for (const s of c.sections) {
      const a = s.startBar * BAR, z = a + s.bars * BAR;
      const inside = part.notes.filter((n) => n.start >= a - 1e-6 && n.start < z - 1e-6);
      // a riser that starts in the bar before a section belongs to the section it leads into
      if (!inside.length) continue;
      const clip: MidiClip = { id: uid(), type: 'midi', trackId: t.id, name: s.name[0].toUpperCase() + s.name.slice(1), start: a, length: s.bars * BAR, notes: inside.map((n) => ({ ...n, id: uid(), start: n.start - a })) };
      p.clips.push(clip);
    }
  }
  if (c.sections.length > 1 && p.tracks.length) p.loop = { on: false, start: 0, end: c.lengthBars * BAR };
  else p.loop = { on: true, start: 0, end: c.lengthBars * BAR };
  return p;
}

export type { Section };
