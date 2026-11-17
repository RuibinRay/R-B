import type { ScaleName } from '../../types';
import { GENRES, HIT_P, ROLES, type BassStyle, type ChordStyle, type GenreId, type Role } from './knowledge';

// A beat as a set of decisions (its "genome"): tempo, key, chord progression, which
// instrument plays each part, the drum pattern, how the bass and chords move, and a short
// melodic idea. compose.ts turns a genome into notes; the trainer changes genomes a
// little at a time and keeps the ones the critics like.

export interface MotifNote { step: number; deg: number; len: number; acc: number } // 16th step in 2 bars, scale degree, length in 16ths, accent
export type Answer = 'repeat' | 'resolve' | 'sequence' | 'invert';
export type ArpShape = 'up' | 'down' | 'updown' | 'broken';
export type Voicing = 'triad' | 'seventh' | 'open';

export interface Genome {
  genre: GenreId;
  seed: number;
  bpm: number;
  swing: number;
  root: number;
  scale: ScaleName;
  prog: number;
  inst: Partial<Record<Role, string>>;
  drums: { template: number; kick: number[]; snare: number[]; hat: number[]; open: number[]; rolls: number; ghosts: number } | null;
  bassStyle: BassStyle;
  bassOct: number;
  chordStyle: ChordStyle;
  voicing: Voicing;
  chordOct: number;
  motif: MotifNote[];
  melOct: number;
  answer: Answer;
  arp: ArpShape;
  arpRate: 2 | 4; // notes per beat
  levels: Partial<Record<Role, number>>; // dB nudges around the style's balance
  form: number;
}

export type Rng = () => number;
export function rngFrom(seed: number): Rng {
  let s = seed >>> 0 || 1;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const pick = <T,>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)];
const between = (rng: Rng, lo: number, hi: number) => lo + rng() * (hi - lo);

/** Choose among options. `weight` gives each option a preference (learned stats plug in here). */
export type Chooser = <T>(gene: string, options: readonly T[], label?: (v: T) => string) => T;
export const uniformChooser = (rng: Rng): Chooser => (_gene, options) => pick(rng, options);

/** Sample a 32-step drum line from a template string (16 steps are repeated). */
export function sampleLine(rng: Rng, template: string | undefined): number[] {
  const t = template ? (template.length === 16 ? template + template : template) : '';
  return Array.from({ length: 32 }, (_, i) => {
    const p = HIT_P[t[i] ?? '.'] ?? 0;
    if (rng() >= p) return 0;
    const ch = t[i];
    return Math.round((ch === 'X' ? between(rng, 0.85, 1) : ch === 'x' ? between(rng, 0.55, 0.85) : between(rng, 0.35, 0.6)) * 100) / 100;
  });
}

/** A two-bar melodic idea: a few notes on the 16th grid, mostly stepwise, starting and ending stably. */
export function randomMotif(rng: Rng, density: [number, number]): MotifNote[] {
  const count = Math.max(2, Math.round(between(rng, density[0], density[1]) * 2));
  // favour strong positions: beats, then eighths, then sixteenths
  const weights = Array.from({ length: 32 }, (_, i) => (i % 4 === 0 ? 4 : i % 2 === 0 ? 2 : 0.7) * (i === 0 ? 2.5 : 1));
  const steps = new Set<number>();
  while (steps.size < Math.min(count, 24)) {
    let r = rng() * weights.reduce((a, b) => a + b, 0);
    let i = 0;
    while (r > weights[i]) { r -= weights[i]; i++; }
    steps.add(Math.min(31, i));
  }
  const sorted = [...steps].sort((a, b) => a - b);
  let deg = pick(rng, [0, 2, 4, 4, 7]);
  return sorted.map((step, k) => {
    if (k > 0) {
      const move = rng() < 0.68 ? pick(rng, [-1, 1, -1, 1, -2, 2]) : pick(rng, [-4, -3, 3, 4, 5, -5]);
      deg = Math.max(-3, Math.min(9, deg + move));
    }
    const next = sorted[k + 1] ?? 32;
    const len = Math.max(1, Math.min(next - step, rng() < 0.7 ? next - step : Math.ceil((next - step) / 2)));
    return { step, deg, len, acc: Math.round(between(rng, 0.6, 1) * 100) / 100 };
  });
}

export function randomGenome(genreId: GenreId, rng: Rng, choose: Chooser = uniformChooser(rng)): Genome {
  const g = GENRES[genreId];
  const inst: Partial<Record<Role, string>> = {};
  for (const role of ROLES) {
    const options = g.roles[role];
    if (options?.length) inst[role] = choose(`inst.${role}`, options);
  }
  const template = g.drums ? choose('drumTemplate', g.drums.templates.map((_, i) => i)) : 0;
  const tpl = g.drums?.templates[template];
  const levels: Partial<Record<Role, number>> = {};
  for (const role of ROLES) levels[role] = Math.round(between(rng, -3, 3));
  return {
    genre: genreId,
    seed: Math.floor(rng() * 1e9),
    bpm: Math.round(between(rng, g.bpm[0], g.bpm[1])),
    swing: Math.round(between(rng, g.swing[0], g.swing[1]) * 100) / 100,
    root: choose('root', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    scale: choose('scale', g.scales),
    prog: choose('prog', g.progressions.map((_, i) => i)),
    inst,
    drums: g.drums && tpl ? {
      template, kick: sampleLine(rng, tpl.kick), snare: sampleLine(rng, tpl.snare || tpl.clap), hat: sampleLine(rng, tpl.hat), open: sampleLine(rng, tpl.open),
      rolls: Math.round(between(rng, 0, g.drums.rolls) * 100) / 100, ghosts: Math.round(between(rng, 0, g.drums.ghosts) * 100) / 100,
    } : null,
    bassStyle: choose('bassStyle', g.bassStyles),
    bassOct: choose('bassOct', [1, 2]),
    chordStyle: choose('chordStyle', g.chordStyles),
    voicing: choose('voicing', ['triad', 'seventh', 'open'] as Voicing[]),
    chordOct: choose('chordOct', [3, 4]),
    motif: randomMotif(rng, g.melodyDensity),
    melOct: choose('melOct', [4, 5]),
    answer: choose('answer', ['repeat', 'resolve', 'sequence', 'invert'] as Answer[]),
    arp: choose('arp', ['up', 'down', 'updown', 'broken'] as ArpShape[]),
    arpRate: choose('arpRate', [2, 4] as (2 | 4)[]),
    levels,
    form: choose('form', g.forms.map((_, i) => i)),
  };
}

const clone = (g: Genome): Genome => JSON.parse(JSON.stringify(g));

/** A small random change: one or two decisions are made again. */
export function mutate(parent: Genome, rng: Rng, choose: Chooser = uniformChooser(rng)): Genome {
  const g = clone(parent);
  const genre = GENRES[g.genre];
  const fresh = randomGenome(g.genre, rng, choose);
  const ops = rng() < 0.35 ? 2 : 1;
  for (let k = 0; k < ops; k++) {
    const r = rng();
    if (r < 0.14) {
      // nudge the melody: move, lengthen or replace one note, or rewrite it
      if (rng() < 0.25 || !g.motif.length) g.motif = fresh.motif;
      else {
        const n = pick(rng, g.motif);
        const what = rng();
        if (what < 0.5) n.deg = Math.max(-3, Math.min(9, n.deg + pick(rng, [-2, -1, 1, 2])));
        else if (what < 0.75) n.len = Math.max(1, n.len + pick(rng, [-1, 1, 2]));
        else n.acc = Math.round(between(rng, 0.5, 1) * 100) / 100;
      }
    } else if (r < 0.3 && g.drums && fresh.drums) {
      const line = pick(rng, ['kick', 'snare', 'hat', 'open'] as const);
      if (rng() < 0.5) g.drums[line] = fresh.drums[line];
      else { const i = Math.floor(rng() * 32); g.drums[line][i] = g.drums[line][i] ? 0 : Math.round(between(rng, 0.4, 0.95) * 100) / 100; }
      if (rng() < 0.2) { g.drums.rolls = fresh.drums.rolls; g.drums.ghosts = fresh.drums.ghosts; }
    } else if (r < 0.5) {
      const roles = Object.keys(g.inst) as Role[];
      if (roles.length) { const role = pick(rng, roles); g.inst[role] = fresh.inst[role]; }
    } else if (r < 0.58) g.bassStyle = fresh.bassStyle;
    else if (r < 0.66) { g.chordStyle = fresh.chordStyle; g.voicing = fresh.voicing; }
    else if (r < 0.72) g.prog = fresh.prog;
    else if (r < 0.77) { g.bpm = Math.round(Math.max(genre.bpm[0], Math.min(genre.bpm[1], g.bpm + pick(rng, [-4, -2, 2, 4])))); g.swing = fresh.swing; }
    else if (r < 0.83) { const role = pick(rng, ROLES); g.levels[role] = Math.max(-6, Math.min(6, (g.levels[role] ?? 0) + pick(rng, [-2, -1, 1, 2]))); }
    else if (r < 0.88) { g.answer = fresh.answer; g.arp = fresh.arp; g.arpRate = fresh.arpRate; }
    else if (r < 0.93) { g.melOct = fresh.melOct; g.chordOct = fresh.chordOct; g.bassOct = fresh.bassOct; }
    else if (r < 0.97) g.scale = fresh.scale;
    else g.form = fresh.form;
  }
  g.seed = Math.floor(rng() * 1e9);
  return g;
}

/** Take each group of decisions from one parent or the other. */
export function crossover(a: Genome, b: Genome, rng: Rng): Genome {
  const c = clone(a);
  const from = () => (rng() < 0.5 ? a : b);
  const take = <K extends keyof Genome>(...keys: K[]) => { const src = from(); for (const k of keys) (c as Genome)[k] = JSON.parse(JSON.stringify(src[k])); };
  take('bpm', 'swing'); take('root', 'scale', 'prog'); take('drums'); take('bassStyle', 'bassOct'); take('chordStyle', 'voicing', 'chordOct');
  take('motif', 'melOct', 'answer'); take('arp', 'arpRate'); take('levels'); take('form');
  for (const role of ROLES) { const src = from(); if (src.inst[role]) c.inst[role] = src.inst[role]; }
  c.seed = Math.floor(rng() * 1e9);
  return c;
}

/** The decisions as "gene:value" labels, for keeping statistics about what works. */
export function choicesOf(g: Genome): string[] {
  const out = [`scale:${g.scale}`, `prog:${g.prog}`, `bassStyle:${g.bassStyle}`, `bassOct:${g.bassOct}`, `chordStyle:${g.chordStyle}`, `voicing:${g.voicing}`,
    `chordOct:${g.chordOct}`, `melOct:${g.melOct}`, `answer:${g.answer}`, `arp:${g.arp}`, `arpRate:${g.arpRate}`, `form:${g.form}`];
  if (g.drums) out.push(`drumTemplate:${g.drums.template}`);
  for (const role of ROLES) if (g.inst[role]) out.push(`inst.${role}:${g.inst[role]}`);
  return out;
}

/** Instrument pairs, e.g. "bass:bass-808|lead:fm-bell", for learning which sounds combine well. */
export function pairsOf(g: Genome, roles: Role[]): string[] {
  const used = roles.filter((r) => g.inst[r]).map((r) => `${r}:${g.inst[r]}`).sort();
  const out: string[] = [];
  for (let i = 0; i < used.length; i++) for (let j = i + 1; j < used.length; j++) out.push(`${used[i]}|${used[j]}`);
  return out;
}
