// Trains the beat maker by trial and error and saves what it learned.
//
//   npm run train                 # every style, default amount of training
//   npm run train -- trap techno  # only some styles
//   ROUNDS=12 npm run train       # longer
//
// Each style is trained in rounds. A round breeds a population of beats for a number of
// generations (judged by the critics); everything it tries is added to the style's
// memory, so the next round starts from better guesses. The memory, the best beats and
// a log of the scores per round go to src/lib/beatmaker/learned.json, which the app's
// AI Beat Lab starts from.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { GENRE_LIST, type GenreId } from '../src/lib/beatmaker/knowledge';
import { bestPairs, emptyGenreMemory, evolve, lessons, type GenreMemory, type Memory } from '../src/lib/beatmaker/learn';
import { compose } from '../src/lib/beatmaker/compose';
import { review } from '../src/lib/beatmaker/critics';
import { randomGenome, rngFrom, uniformChooser } from '../src/lib/beatmaker/genome';

const OUT = new URL('../src/lib/beatmaker/learned.json', import.meta.url);
const ROUNDS = Number(process.env.ROUNDS ?? 8);
const POP = Number(process.env.POP ?? 36);
const GENS = Number(process.env.GENS ?? 24);
const only = process.argv.slice(2).filter((a) => !a.startsWith('-')) as GenreId[];
const fresh = process.argv.includes('--fresh');

const memory: Memory = !fresh && existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf8')).memory ?? {}) : {};

/** Average score of beats made with no memory at all: the baseline that training must beat. */
function baseline(genre: GenreId, n = 200): number {
  const rng = rngFrom(1234);
  let s = 0;
  for (let i = 0; i < n; i++) s += review(compose(randomGenome(genre, rng, uniformChooser(rng)), i % 4 === 0 ? 'song' : 'loop')).total;
  return s / n;
}

function slim(mem: GenreMemory): GenreMemory {
  // keep the file small: drop rarely tried pairs and round the numbers
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  const pairs: GenreMemory['pairs'] = {};
  for (const [k, v] of Object.entries(mem.pairs)) if (v.n >= 8) pairs[k] = { n: v.n, mean: r(v.mean) };
  const effects: GenreMemory['effects'] = {};
  for (const [k, v] of Object.entries(mem.effects)) effects[k] = { n: v.n, mean: r(v.mean) };
  return { ...mem, pairs, effects, taste: {}, elites: mem.elites.map((e) => ({ ...e, score: r(e.score) })) };
}

const t0 = Date.now();
const report: string[] = [];
for (const genre of GENRE_LIST) {
  if (only.length && !only.includes(genre.id)) continue;
  const mem = (memory[genre.id] ??= emptyGenreMemory());
  const base = baseline(genre.id);
  const start = Date.now();
  for (let round = 0; round < ROUNDS; round++) {
    // alternate short loops and whole songs so arrangements are trained too
    const length = round % 2 === 1 ? 'song' : 'loop';
    const res = await evolve(genre.id, mem, { population: POP, generations: length === 'song' ? Math.round(GENS / 2) : GENS, length, seed: 1000 * round + genre.id.length });
    const n = mem.history.length;
    mem.history.push({ round: n + 1, firstMean: Math.round(res.firstMean * 1e4) / 1e4, bestScore: Math.round(res.best[0].review.total * 1e4) / 1e4, finalMean: Math.round(res.finalMean * 1e4) / 1e4, evaluated: mem.evaluated });
    process.stdout.write(`${genre.id.padEnd(10)} round ${String(n + 1).padStart(2)} (${length.padEnd(4)}): starts at ${res.firstMean.toFixed(3)}, best ${res.best[0].review.total.toFixed(3)}, population ends at ${res.finalMean.toFixed(3)}\n`);
  }
  const h = mem.history;
  const learnt = lessons(genre.id, mem, 8).filter((l) => l.best.length).map((l) => `${l.role}: ${l.best.slice(0, 2).map((b) => `${b.id} ${b.mean >= 0 ? '+' : ''}${b.mean.toFixed(3)}`).join(', ')}`).join(' | ');
  report.push(`${genre.name}: random ${base.toFixed(3)} -> first round starts ${h[0].firstMean.toFixed(3)} -> last round starts ${h[h.length - 1].firstMean.toFixed(3)}, best ${Math.max(...h.map((x) => x.bestScore)).toFixed(3)} (${mem.evaluated} beats tried, ${((Date.now() - start) / 1000).toFixed(0)} s)\n    learned (score gain over the alternatives) ${learnt}\n    pairs ${bestPairs(mem, 3, 8).map((p) => `${p.pair} ${p.mean >= 0 ? '+' : ''}${p.mean.toFixed(3)}`).join(' ; ')}`);
  (mem as GenreMemory & { baseline?: number }).baseline = Math.round(base * 1e4) / 1e4;
}

const slimmed: Memory = {};
for (const [k, v] of Object.entries(memory)) slimmed[k as GenreId] = slim(v as GenreMemory);
writeFileSync(OUT, JSON.stringify({ trainedAt: new Date().toISOString(), rounds: ROUNDS, population: POP, generations: GENS, memory: slimmed }));
console.log('\n' + report.join('\n') + `\n\nSaved ${OUT.pathname} after ${((Date.now() - t0) / 1000).toFixed(0)} s.`);
