import { describe, expect, it } from 'vitest';
import { compose, toProject } from '../src/lib/beatmaker/compose';
import { review } from '../src/lib/beatmaker/critics';
import { randomGenome, rngFrom, uniformChooser, type Genome } from '../src/lib/beatmaker/genome';
import { GENRES, GENRE_LIST, ROLES } from '../src/lib/beatmaker/knowledge';
import { emptyGenreMemory, evolve, experiment, learnedChooser } from '../src/lib/beatmaker/learn';
import { getInstrument } from '../src/lib/instruments';
import { PROFILES } from '../src/lib/beatmaker/profiles';

const score = (g: Genome, length: 'loop' | 'song' = 'loop') => review(compose(g, length));
const verdict = (g: Genome, id: string) => score(g).verdicts.find((v) => v.id === id)!.score;

describe('beat maker: writing', () => {
  for (const genre of GENRE_LIST) {
    it(`${genre.name}: loops and songs are playable projects that respect each instrument`, () => {
      const rng = rngFrom(genre.id.length * 97);
      for (const length of ['loop', 'song'] as const) {
        for (let k = 0; k < 6; k++) {
          const g = randomGenome(genre.id, rng);
          const c = compose(g, length);
          expect(c.parts.length).toBeGreaterThan(1);
          expect(c.bpm).toBeGreaterThanOrEqual(genre.bpm[0]);
          expect(c.bpm).toBeLessThanOrEqual(genre.bpm[1]);
          for (const p of c.parts) {
            const def = getInstrument(p.instrumentId)!;
            expect(def, p.instrumentId).toBeDefined();
            expect(p.volume).toBeGreaterThanOrEqual(-36);
            expect(p.volume).toBeLessThanOrEqual(6);
            for (const n of p.notes) {
              if (def.engine !== 'drums') expect(n.pitch >= def.range[0] && n.pitch <= def.range[1], `${p.role} ${n.pitch} on ${def.name}`).toBe(true);
              expect(n.velocity).toBeGreaterThan(0);
              expect(n.velocity).toBeLessThanOrEqual(1);
              expect(n.start).toBeGreaterThanOrEqual(0);
              expect(n.start).toBeLessThan(c.lengthBars * 4);
            }
          }
          // the same genome always gives the same notes
          expect(JSON.stringify(compose(g, length).parts.map((p) => p.notes.map((n) => [n.pitch, n.start, n.duration])))).toBe(JSON.stringify(c.parts.map((p) => p.notes.map((n) => [n.pitch, n.start, n.duration]))));
          const p = toProject(c, 'test');
          const noteCount = p.clips.reduce((a, cl) => a + (cl.type === 'midi' ? cl.notes.length : 0), 0);
          expect(noteCount).toBe(c.parts.reduce((a, part) => a + part.notes.length, 0));
          for (const cl of p.clips) if (cl.type === 'midi') for (const n of cl.notes) { expect(n.start).toBeGreaterThanOrEqual(0); expect(n.start).toBeLessThan(cl.length); }
        }
      }
    });
  }

  it('every instrument it may choose has been measured', () => {
    for (const g of GENRE_LIST) for (const list of Object.values(g.roles)) for (const id of list ?? []) {
      expect(!!(PROFILES.instruments[id] || PROFILES.kits[id]), id).toBe(true);
    }
  });
});

describe('beat maker: production techniques from the tutorials', () => {
  it('hi-hats are accented on the beat and softer in between', () => {
    const c = compose(randomGenome('boombap', rngFrom(12)), 'loop');
    const hats = c.parts.find((p) => p.role === 'drums')!.notes.filter((n) => n.pitch === 42);
    const on = hats.filter((n) => Math.abs(n.start - Math.round(n.start)) < 0.05).map((n) => n.velocity);
    const off = hats.filter((n) => Math.abs(n.start - Math.round(n.start)) >= 0.05).map((n) => n.velocity);
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(mean(on)).toBeGreaterThan(mean(off) + 0.1);
  });

  it('marks the end of phrases with a fill, a roll or a drop-out, as the style does it', () => {
    const fills = (id: 'boombap' | 'house' | 'trap') => {
      const c = compose(randomGenome(id, rngFrom(3)), 'song');
      const drums = c.parts.find((p) => p.role === 'drums')!.notes;
      return { c, drums };
    };
    const bb = fills('boombap');
    expect(bb.drums.some((n) => [41, 45, 48].includes(n.pitch))).toBe(true); // tom fills
    const house = fills('house');
    const sec = house.c.sections.find((x, i) => x.energy >= 0.5 && x.roles.includes('drums') && i < house.c.sections.length - 1)!; // quiet sections play no fills
    const lastBar = (sec.startBar + sec.bars - 1) * 4;
    expect(house.drums.filter((n) => n.pitch === 38 && n.start >= lastBar && n.start < lastBar + 4).length).toBe(16); // snare roll
  });

  it('house and techno bass and pads pump with the kick (sidechain)', () => {
    const p = toProject(compose(randomGenome('house', rngFrom(8)), 'loop'), 'pump');
    const bass = p.tracks.find((t) => t.name.startsWith('Bass'))!;
    const pts = bass.automation?.volume ?? [];
    expect(pts.length).toBeGreaterThan(30);
    expect(Math.min(...pts.map((x) => x.value))).toBeLessThanOrEqual(-5);
    const trap = toProject(compose(randomGenome('trap', rngFrom(8)), 'loop'), 'no pump');
    expect(trap.tracks.every((t) => !t.automation?.volume?.length)).toBe(true);
  });

  it('808 lines in trap and drill slide into some notes, within an octave', () => {
    let slides = 0;
    for (let s = 0; s < 20; s++) {
      const g = { ...randomGenome('drill', rngFrom(100 + s)), bassStyle: 'glide' as const };
      for (const n of compose(g, 'loop').parts.find((p) => p.role === 'bass')?.notes ?? []) {
        if (n.bend) { slides++; expect(Math.abs(n.bend[0])).toBeLessThanOrEqual(1200); expect(n.bend[n.bend.length - 1]).toBe(0); }
      }
    }
    expect(slides).toBeGreaterThan(5);
  });

  it('game music loops end without a fill so they repeat seamlessly', () => {
    const c = compose(randomGenome('chiptune', rngFrom(4)), 'loop');
    const drums = c.parts.find((p) => p.role === 'drums')!.notes;
    expect(drums.some((n) => [41, 45, 48].includes(n.pitch) && n.start >= 7 * 4)).toBe(false);
  });
});

describe('beat maker: critics', () => {
  const base = () => randomGenome('house', rngFrom(5));

  it('prefers a drum pattern that fits the style', () => {
    const g = base();
    const typical = { ...g, drums: { ...g.drums!, kick: Array.from({ length: 32 }, (_, i) => (i % 4 === 0 ? 1 : 0)), snare: Array.from({ length: 32 }, (_, i) => (i % 8 === 4 ? 1 : 0)) } };
    const odd = { ...g, drums: { ...g.drums!, kick: Array.from({ length: 32 }, (_, i) => (i % 4 === 1 ? 1 : 0)), snare: Array.from({ length: 32 }, (_, i) => (i % 8 === 1 ? 1 : 0)) } };
    expect(verdict(typical, 'groove')).toBeGreaterThan(verdict(odd, 'groove') + 0.25);
  });

  it('notices a melody written outside the key', () => {
    const g = base();
    const inKey = verdict(g, 'harmony');
    const out = verdict({ ...g, motif: g.motif.map((n) => ({ ...n, deg: n.deg })) , scale: 'phrygian' }, 'harmony');
    expect(inKey).toBeGreaterThan(0.6);
    expect(Number.isFinite(out)).toBe(true);
    // pushing every melody note a semitone off the scale
    const c = compose(g, 'loop');
    const lead = c.parts.find((p) => p.role === 'lead');
    if (lead) for (const n of lead.notes) n.pitch += 1;
    expect(review(c).verdicts.find((v) => v.id === 'harmony')!.score).toBeLessThan(inKey);
  });

  it('notices parts fighting for the low end and a bass that is not at the bottom', () => {
    const g = randomGenome('trap', rngFrom(11));
    const good = score(g);
    const bad = { ...g, inst: { ...g.inst, chords: 'dark-pad', pad: 'dark-pad' }, chordOct: 2, bassOct: 2 };
    const worse = score(bad);
    expect(worse.verdicts.find((v) => v.id === 'register')!.score).toBeLessThanOrEqual(good.verdicts.find((v) => v.id === 'register')!.score);
  });

  it('judges arrangement only for full songs, and a song with a breakdown and drop scores it', () => {
    const g = randomGenome('techno', rngFrom(3));
    expect(score(g, 'loop').verdicts.some((v) => v.id === 'arrangement')).toBe(false);
    const song = score(g, 'song');
    expect(song.verdicts.find((v) => v.id === 'arrangement')!.score).toBeGreaterThan(0.4);
  });
});

describe('beat maker: learning', () => {
  it('breeding raises the score above random beats', async () => {
    const rng = rngFrom(42);
    let random = 0;
    for (let i = 0; i < 60; i++) random += score(randomGenome('lofi', rng, uniformChooser(rng))).total / 60;
    const mem = emptyGenreMemory();
    const res = await evolve('lofi', mem, { population: 24, generations: 12, seed: 7, experiments: false });
    expect(res.best[0].review.total).toBeGreaterThan(random + 0.06);
    expect(res.finalMean).toBeGreaterThan(res.firstMean);
  });

  it('learns from experiments: after training, its first guesses are better than untrained ones', async () => {
    const mem = emptyGenreMemory();
    const firstRound = await evolve('boombap', mem, { population: 24, generations: 10, seed: 1 });
    for (let r = 2; r <= 4; r++) await evolve('boombap', mem, { population: 24, generations: 10, seed: r });
    // fresh beats drawn from the learned preferences, against fresh beats drawn uniformly
    const rngA = rngFrom(99), rngB = rngFrom(99);
    let learned = 0, plain = 0;
    for (let i = 0; i < 80; i++) {
      learned += score(randomGenome('boombap', rngA, learnedChooser(rngA, mem))).total / 80;
      plain += score(randomGenome('boombap', rngB, uniformChooser(rngB))).total / 80;
    }
    expect(Object.keys(mem.effects).length).toBeGreaterThan(20);
    expect(learned).toBeGreaterThan(plain);
    expect(firstRound.best.length).toBeGreaterThan(0);
  });

  it('a swap experiment finds a planted bad choice', () => {
    // a lead instrument that sits in the bass register clashes with the bass and buries the melody
    const mem = emptyGenreMemory();
    const genre = GENRES.house;
    const saved = genre.roles.lead;
    genre.roles.lead = ['pluck', 'sub-bass'];
    try {
      for (let s = 0; s < 6; s++) experiment(mem, randomGenome('house', rngFrom(s + 20)), 'loop');
      expect(mem.effects['inst.lead:pluck'].mean).toBeGreaterThan(mem.effects['inst.lead:sub-bass'].mean);
    } finally {
      genre.roles.lead = saved;
    }
  });

  it('every role it can fill is covered by the experiments', () => {
    const mem = emptyGenreMemory();
    experiment(mem, randomGenome('adventure', rngFrom(4)), 'loop');
    const roles = ROLES.filter((r) => (GENRES.adventure.roles[r]?.length ?? 0) > 1);
    for (const r of roles) expect(Object.keys(mem.effects).some((k) => k.startsWith(`inst.${r}:`)), r).toBe(true);
  });
});
