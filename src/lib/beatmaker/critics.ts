import type { Note } from '../../types';
import { SCALES } from '../music';
import type { Composition, Part } from './compose';
import { BANDS, GENRES, HIT_P, type Role } from './knowledge';
import { noteProfile } from './profiles';

// The critics: each one listens for one thing producers check by ear and gives a score
// from 0 to 1, with a short reason. They work on the notes and on the measured sound of
// each instrument, so thousands of attempts can be judged per second. They measure
// craft (does it groove, clash, balance, fit the style), not whether it is moving.

export interface Verdict { id: string; name: string; score: number; weight: number; note: string }
export interface Review { total: number; verdicts: Verdict[]; estimate: MixEstimate }
export interface MixEstimate { bands: number[]; roleDb: Partial<Record<Role, number>>; roleBands: Partial<Record<Role, number[]>>; sectionDb: number[] }

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** 1 inside [lo, hi], falling to 0 at `soft` beyond either edge. */
const within = (v: number, lo: number, hi: number, soft: number) => (v < lo ? clamp01(1 - (lo - v) / soft) : v > hi ? clamp01(1 - (v - hi) / soft) : 1);
const pct = (v: number) => `${Math.round(v * 100)}%`;
const BAR = 4;

/** Predicted loudness and spectrum of the mix, from the measured instrument profiles. */
export function estimateMix(c: Composition): MixEstimate {
  const spb = 60 / c.bpm;
  const seconds = c.lengthBars * BAR * spb;
  const bands = new Array(BANDS.length).fill(0);
  const roleDb: MixEstimate['roleDb'] = {};
  const roleBands: MixEstimate['roleBands'] = {};
  const sectionEnergy = c.sections.map(() => 0);
  for (const part of c.parts) {
    const gain = 10 ** (part.volume / 10);
    const rb = new Array(BANDS.length).fill(0);
    let energy = 0;
    let active = 0;
    const activeBars = new Set<number>();
    for (const n of part.notes) {
      const prof = noteProfile(part.instrumentId, n.pitch);
      const power = 10 ** ((prof.db + 28 * Math.log10(Math.max(0.05, n.velocity) / 0.8)) / 10) * gain;
      const secs = Math.max(0.05, Math.min(n.duration * spb + 0.15, prof.ring >= 1.9 ? n.duration * spb + 0.3 : prof.ring));
      const e = power * secs;
      energy += e;
      prof.bands.forEach((share, i) => { rb[i] += e * share; });
      activeBars.add(Math.floor(n.start / BAR));
      const s = c.sections.findIndex((sec) => n.start >= sec.startBar * BAR && n.start < (sec.startBar + sec.bars) * BAR);
      if (s >= 0) sectionEnergy[s] += e;
    }
    active = Math.max(1, activeBars.size) * BAR * spb;
    roleDb[part.role] = 10 * Math.log10(energy / active + 1e-15);
    const total = rb.reduce((a, b) => a + b, 0) || 1;
    roleBands[part.role] = rb.map((b) => b / total);
    rb.forEach((b, i) => { bands[i] += b; });
  }
  const total = bands.reduce((a, b) => a + b, 0) || 1;
  return {
    bands: bands.map((b) => b / total),
    roleDb, roleBands,
    sectionDb: c.sections.map((s, i) => 10 * Math.log10(sectionEnergy[i] / (s.bars * BAR * spb) + 1e-15)),
    // (seconds kept for callers that want an overall level)
    ...{ seconds },
  } as MixEstimate;
}

const partOf = (c: Composition, role: Role): Part | undefined => c.parts.find((p) => p.role === role);
const onsetsByBar = (notes: Note[], bars: number): string[] => {
  const out: string[][] = Array.from({ length: bars }, () => []);
  for (const n of notes) { const b = Math.floor(n.start / BAR); if (b >= 0 && b < bars) out[b].push(`${Math.round((n.start - b * BAR) * 4)}:${n.pitch}`); }
  return out.map((o) => o.sort().join(','));
};

export function review(c: Composition): Review {
  const g = c.genome;
  const genre = GENRES[g.genre];
  const verdicts: Verdict[] = [];
  const add = (id: string, name: string, score: number, weight: number, note: string) => verdicts.push({ id, name, score: clamp01(score), weight, note });
  const est = estimateMix(c);
  const scale = SCALES[g.scale].steps.map((s) => (s + g.root) % 12);

  // 1. tempo
  add('tempo', 'Tempo for the style', within(c.bpm, genre.bpm[0], genre.bpm[1], 12), 0.6, `${c.bpm} BPM (${genre.name} usually ${genre.bpm[0]}-${genre.bpm[1]})`);

  // 2. groove: how typical the drum pattern is, and the backbeat
  const drums = partOf(c, 'drums');
  if (genre.drums && g.drums) {
    const tpl = genre.drums.templates[g.drums.template] ?? genre.drums.templates[0];
    const like = (line: number[], t: string) => {
      if (!t) return 1;
      const tt = t.length === 16 ? t + t : t;
      let s = 0;
      for (let i = 0; i < 32; i++) { const p = HIT_P[tt[i]] ?? 0; s += line[i] ? 0.2 + 0.8 * p : 1 - 0.85 * p; }
      return s / 32;
    };
    const kick = like(g.drums.kick, tpl.kick), snare = like(g.drums.snare, tpl.snare || tpl.clap || ''), hat = like(g.drums.hat, tpl.hat);
    const back = genre.halfTime ? [8, 24] : [4, 12, 20, 28];
    const backbeat = tpl.snare ? back.filter((i) => g.drums!.snare[i] > 0).length / back.length : 1;
    const downbeat = g.drums.kick[0] > 0 && g.drums.kick[16] > 0 ? 1 : g.drums.kick[0] > 0 ? 0.7 : 0.2;
    const score = 0.3 * kick + 0.2 * snare + 0.15 * hat + 0.2 * backbeat + 0.15 * downbeat;
    add('groove', 'Drum groove', score, 1.4, `kick ${pct(kick)}, snare ${pct(snare)}, hats ${pct(hat)} typical; backbeat ${pct(backbeat)}${downbeat < 1 ? ', a downbeat is missing' : ''}`);
  } else if (!genre.drums) add('groove', 'Drum groove', drums ? 0.4 : 1, 0.6, drums ? 'this style is usually played without a beat' : 'no beat, as the style wants');

  // 3. kick and bass: lock together or keep out of each other's way, as the style wants
  const bass = partOf(c, 'bass');
  if (drums && bass) {
    const kicks = new Set(drums.notes.filter((n) => n.pitch === 36).map((n) => Math.round(n.start * 4)));
    const starts = bass.notes.map((n) => Math.round(n.start * 4));
    const lock = starts.length ? starts.filter((s) => kicks.has(s)).length / starts.length : 0;
    add('kickbass', 'Kick and bass', 1 - Math.abs(lock - genre.bassKickLock) * 1.3, 1.1, `${pct(lock)} of bass notes land with a kick (style aims for about ${pct(genre.bassKickLock)})`);
  }

  // 4. harmony: notes in key, melody resting on chord tones
  const lead = partOf(c, 'lead');
  const tonal = c.parts.filter((p) => p.role !== 'drums' && p.role !== 'texture');
  const all = tonal.flatMap((p) => p.notes);
  const inKey = all.length ? all.filter((n) => scale.includes(((n.pitch % 12) + 12) % 12)).length / all.length : 1;
  let strong = 1, strongCount = 0;
  if (lead) {
    const s = lead.notes.filter((n) => Math.abs(n.start * 2 - Math.round(n.start * 2)) < 0.01 && Math.round(n.start * 4) % 8 === 0);
    strongCount = s.length;
    if (s.length) strong = s.filter((n) => c.chords[Math.min(c.chords.length - 1, Math.floor(n.start / BAR))].tones.includes(((n.pitch % 12) + 12) % 12)).length / s.length;
  }
  add('harmony', 'Harmony', 0.5 * inKey ** 2 + 0.5 * strong, 1.3, `${pct(inKey)} of notes in ${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][g.root]} ${SCALES[g.scale].name.toLowerCase()}; ${strongCount ? `${pct(strong)} of strong-beat melody notes are chord tones` : 'no melody on strong beats'}`);

  // 5. clashes: semitone rubs between parts, and muddy low chords
  let pairs = 0, rubs = 0, mud = 0, lowPairs = 0;
  const grid = new Map<number, { role: Role; pitch: number }[]>();
  for (const p of tonal) for (const n of p.notes) {
    const a = Math.round(n.start * 4), z = Math.max(a + 1, Math.round((n.start + n.duration) * 4));
    for (let t = a; t < z; t += 2) { const list = grid.get(t) ?? []; list.push({ role: p.role, pitch: n.pitch }); grid.set(t, list); }
  }
  for (const list of grid.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if (list[i].role === list[j].role) continue;
      pairs++;
      const d = Math.abs(list[i].pitch - list[j].pitch);
      if (d === 1 || d === 13 || (d === 11 && Math.min(list[i].pitch, list[j].pitch) < 60)) rubs++;
      if (Math.max(list[i].pitch, list[j].pitch) < 50) { lowPairs++; if (d > 0 && d < 5) mud++; }
    }
  }
  const rubRate = pairs ? rubs / pairs : 0, mudRate = lowPairs ? mud / lowPairs : 0;
  add('clash', 'No clashing notes', 1 - rubRate * 6 - mudRate * 1.5, 1.3, `${pct(rubRate)} of overlapping notes rub a semitone apart; ${pct(mudRate)} of low notes crowd each other`);

  // 6. melody shape
  if (lead && lead.notes.length > 2) {
    const ns = [...lead.notes].sort((a, b) => a.start - b.start);
    const iv = ns.slice(1).map((n, i) => n.pitch - ns[i].pitch);
    const stepRatio = iv.filter((d) => Math.abs(d) <= 2).length / iv.length;
    const leapsRecovered = iv.slice(0, -1).filter((d, i) => Math.abs(d) >= 5).length;
    const recovered = iv.slice(0, -1).filter((d, i) => Math.abs(d) >= 5 && Math.sign(iv[i + 1]) === -Math.sign(d) && Math.abs(iv[i + 1]) <= 3).length;
    const pitches = ns.map((n) => n.pitch);
    const range = Math.max(...pitches) - Math.min(...pitches);
    const bars = new Set(ns.map((n) => Math.floor(n.start / BAR))).size || 1;
    const perBar = ns.length / bars;
    const bigLeaps = iv.filter((d) => Math.abs(d) > 9).length / iv.length;
    const unique = new Set(pitches.map((p) => p % 12)).size;
    const score = 0.3 * within(stepRatio, 0.5, 0.85, 0.35) + 0.15 * (leapsRecovered ? recovered / leapsRecovered : 1) + 0.2 * within(range, 5, 16, 8)
      + 0.2 * within(perBar, genre.melodyDensity[0], genre.melodyDensity[1], 3) + 0.1 * (1 - Math.min(1, bigLeaps * 5)) + 0.05 * within(unique, 3, 7, 3);
    add('melody', 'Melody shape', score, 1.2, `${pct(stepRatio)} stepwise, range ${range} semitones, ${perBar.toFixed(1)} notes a bar${bigLeaps > 0.1 ? ', some awkward big leaps' : ''}`);
  } else if (genre.roles.lead) add('melody', 'Melody shape', lead ? 0.3 : 0.5, 0.6, 'little or no melody');

  // 7. repetition and variation
  const loopLike = c.sections.length === 1;
  const sims: number[] = [];
  for (const role of ['drums', 'lead', 'bass'] as Role[]) {
    const p = partOf(c, role);
    if (!p) continue;
    const bars = onsetsByBar(p.notes, c.lengthBars);
    const simOf = (x: string, y: string) => {
      const A = new Set(x.split(',')), B = new Set(y.split(','));
      return [...A].filter((v) => B.has(v)).length / Math.max(1, new Set([...A, ...B]).size);
    };
    // likeness at two scales: the next bar, and the same bar of the next four-bar phrase
    for (let b = 1; b < bars.length; b++) {
      if (bars[b] && bars[b - 1]) sims.push(simOf(bars[b], bars[b - 1]));
      if (b >= 4 && bars[b] && bars[b - 4]) sims.push(simOf(bars[b], bars[b - 4]));
    }
  }
  const sim = sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length : 0.5;
  add('repetition', 'Repetition and variation', within(sim, genre.repetition[0], genre.repetition[1], 0.35), 0.9, `bars are ${pct(sim)} alike (${genre.name} likes ${pct(genre.repetition[0])}-${pct(genre.repetition[1])})`);

  // 8. spectral balance against the style
  const dist = est.bands.reduce((a, b, i) => a + Math.abs(b - genre.spectrum[i]), 0);
  const worst = est.bands.map((b, i) => [b - genre.spectrum[i], i] as const).sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]))[0];
  add('spectrum', 'Frequency balance', 1 - dist * 0.9, 1.4, worst ? `${BANDS[worst[1]].name} ${worst[0] > 0 ? 'heavier' : 'lighter'} than typical for ${genre.name} by ${pct(Math.abs(worst[0]))} of the mix` : '');

  // 9. masking: too many parts fighting for the same band
  const crowded: string[] = [];
  let maskPenalty = 0;
  BANDS.forEach((band, i) => {
    const owners = (Object.entries(est.roleBands) as [Role, number[]][])
      .filter(([role]) => role !== 'drums' && role !== 'texture')
      .map(([role, b]) => ({ role, share: b[i] * 10 ** (((est.roleDb[role] ?? -60) - Math.max(...Object.values(est.roleDb).map((v) => v ?? -60))) / 10) }))
      .filter((o) => o.share > 0.04);
    const limit = i <= 1 ? 1 : i <= 3 ? 3 : 4;
    if (owners.length > limit) { maskPenalty += (owners.length - limit) * (i <= 1 ? 0.35 : 0.12); crowded.push(`${band.name}: ${owners.map((o) => o.role).join(', ')}`); }
  });
  add('masking', 'Room for every part', 1 - maskPenalty, 1.3, crowded.length ? `crowded ${crowded.join('; ')}` : 'each part has its own range');

  // 10. mix balance: are the parts as loud as the style wants, relative to each other
  const loudest = Math.max(...Object.values(est.roleDb).map((v) => v ?? -99));
  const devs: string[] = [];
  let dev = 0, counted = 0;
  for (const [role, db] of Object.entries(est.roleDb) as [Role, number][]) {
    const want = genre.levels[role];
    if (want === undefined) continue;
    const top = Math.max(...(Object.keys(est.roleDb) as Role[]).map((r) => genre.levels[r] ?? -99));
    const d = (db - loudest) - (want - top);
    dev += Math.min(12, Math.abs(d)); counted++;
    if (Math.abs(d) > 4) devs.push(`${role} ${d > 0 ? '+' : ''}${Math.round(d)} dB`);
  }
  add('balance', 'Mix balance', 1 - (counted ? dev / counted : 0) / 8, 1.1, devs.length ? `off target: ${devs.join(', ')}` : 'parts sit at the levels the style expects');

  // 11. register: bass at the bottom, melody on top
  const med = (p?: Part) => (p ? [...p.notes].map((n) => n.pitch).sort((a, b) => a - b)[p.notes.length >> 1] : null);
  const mb = med(bass), mc = med(partOf(c, 'chords')), ml = med(lead);
  let reg = 1;
  const regNotes: string[] = [];
  if (mb !== null && mc !== null && mb + 7 > mc) { reg -= 0.4; regNotes.push('bass sits too close to the chords'); }
  if (ml !== null && mc !== null && ml < mc + 3) { reg -= 0.4; regNotes.push('melody is buried inside the chords'); }
  if (ml !== null && mb !== null && ml - mb < 19) { reg -= 0.2; regNotes.push('melody and bass are close together'); }
  add('register', 'Parts in their own register', reg, 0.9, regNotes.join('; ') || 'bass low, chords in the middle, melody on top');

  // 12. arrangement: does the energy follow the plan (only for full songs)
  if (!loopLike) {
    const planned = c.sections.map((s) => s.energy);
    const got = est.sectionDb;
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const pm = mean(planned), gm = mean(got);
    let num = 0, da = 0, db = 0;
    planned.forEach((p, i) => { num += (p - pm) * (got[i] - gm); da += (p - pm) ** 2; db += (got[i] - gm) ** 2; });
    const corr = da && db ? num / Math.sqrt(da * db) : 0;
    const contrast = Math.max(...got) - Math.min(...got);
    add('arrangement', 'Arrangement', 0.7 * clamp01((corr + 0.2) / 1.2) + 0.3 * within(contrast, 4, 14, 6), 1, `energy follows the plan ${pct(clamp01(corr))}; ${contrast.toFixed(0)} dB from quietest to loudest section`);
  }

  const wsum = verdicts.reduce((a, v) => a + v.weight, 0);
  const total = verdicts.reduce((a, v) => a + v.score * v.weight, 0) / wsum;
  return { total, verdicts, estimate: est };
}
