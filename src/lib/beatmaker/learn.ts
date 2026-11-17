import { compose, type Length } from './compose';
import { review, type Review } from './critics';
import { choicesOf, crossover, mutate, randomGenome, rngFrom, type Chooser, type Genome, type Rng } from './genome';
import { GENRES, ROLES, type GenreId, type Role } from './knowledge';

// Learning by trial and error.
//
// 1. Evolution: a population of beats is made, each one is judged by the critics, the
//    better ones are kept and changed a little or combined, and that repeats.
// 2. Experiments: the best beats of each round are taken apart one decision at a time.
//    Everything else is kept and only, say, the lead instrument is swapped for each of
//    the alternatives, and every version is judged. How much better or worse each option
//    did than the average of the options, in the same beat, is recorded ("lead = flute"
//    +0.02, "bass = 808 with lead = bells" -0.01, ...). Averaged over many beats, that
//    says which instruments, patterns and combinations suit each style. New beats are
//    drawn with a preference for what has measured well, while still trying the rest.
// 3. Your ratings are recorded the same way, so it also learns what you like.

export interface Stat { n: number; mean: number }
export interface GenreMemory {
  /** decision -> average gain in score over the alternatives, from swap experiments */
  effects: Record<string, Stat>;
  /** "role:instrument|role:instrument" -> average gain when the first was chosen next to the second */
  pairs: Record<string, Stat>;
  taste: Record<string, Stat>; // from the listener's ratings (+1 / -1)
  elites: { genome: Genome; score: number }[];
  history: { round: number; firstMean: number; bestScore: number; finalMean: number; evaluated: number }[];
  evaluated: number;
}
export type Memory = Partial<Record<GenreId, GenreMemory>>;

export const emptyGenreMemory = (): GenreMemory => ({ effects: {}, pairs: {}, taste: {}, elites: [], history: [], evaluated: 0 });

function bump(map: Record<string, Stat>, key: string, value: number, cap = 200): void {
  const s = (map[key] ??= { n: 0, mean: 0 });
  s.n++;
  s.mean += (value - s.mean) / Math.min(s.n, cap);
}

/** Count one judged attempt. */
export function remember(mem: GenreMemory): void {
  mem.evaluated++;
}

/** The alternatives tried in swap experiments, for each kind of decision. */
function alternatives(g: Genome): { gene: string; options: string[]; apply: (x: Genome, v: string) => void }[] {
  const genre = GENRES[g.genre];
  const out: { gene: string; options: string[]; apply: (x: Genome, v: string) => void }[] = [];
  for (const role of ROLES) {
    const opts = genre.roles[role];
    if (g.inst[role] && opts && opts.length > 1) out.push({ gene: `inst.${role}`, options: opts, apply: (x, v) => { x.inst[role] = v; } });
  }
  const list = (gene: keyof Genome, options: readonly (string | number)[]) => {
    if (options.length > 1) out.push({ gene, options: options.map(String), apply: (x, v) => { (x as unknown as Record<string, unknown>)[gene] = typeof options[0] === 'number' ? Number(v) : v; } });
  };
  list('bassStyle', genre.bassStyles); list('chordStyle', genre.chordStyles); list('prog', genre.progressions.map((_, i) => i)); list('scale', genre.scales);
  list('voicing', ['triad', 'seventh', 'open']); list('chordOct', [3, 4]); list('melOct', [4, 5]); list('bassOct', [1, 2]);
  list('answer', ['repeat', 'resolve', 'sequence', 'invert']); list('arp', ['up', 'down', 'updown', 'broken']); list('arpRate', [2, 4]);
  return out;
}

/**
 * Swap experiments on one beat: change one decision at a time to each alternative,
 * judge every version, and record how each option did against the others.
 */
export function experiment(mem: GenreMemory, g: Genome, length: Length): number {
  let tried = 0;
  for (const alt of alternatives(g)) {
    const scores = alt.options.map((v) => {
      const x: Genome = JSON.parse(JSON.stringify(g));
      alt.apply(x, v);
      tried++;
      return judge(x, length).total;
    });
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    alt.options.forEach((v, i) => {
      const gain = scores[i] - mean;
      bump(mem.effects, `${alt.gene}:${v}`, gain, 400);
      if (alt.gene.startsWith('inst.')) {
        const me = `${alt.gene.slice(5)}:${v}`;
        for (const role of ROLES) {
          const other = g.inst[role];
          if (!other || `inst.${role}` === alt.gene) continue;
          bump(mem.pairs, [me, `${role}:${other}`].sort().join('|'), gain, 400);
        }
      }
    });
  }
  mem.evaluated += tried;
  return tried;
}

/** Record a rating from the listener (+1 liked, -1 disliked). */
export function rate(mem: GenreMemory, g: Genome, rating: 1 | -1): void {
  for (const c of choicesOf(g)) bump(mem.taste, c, rating, 20);
}

/** How promising a decision looks: measured gain, a bonus for being little tried, and taste. */
function appeal(mem: GenreMemory | undefined, key: string, total: number, explore: number): number {
  const s = mem?.effects[key];
  const mean = s ? s.mean : 0;
  const bonus = explore * Math.sqrt(Math.log(total + 2) / ((s?.n ?? 0) + 1));
  const taste = mem?.taste[key] ? 0.08 * mem.taste[key].mean * Math.min(1, mem.taste[key].n / 3) : 0;
  return mean + bonus + taste;
}

/**
 * Chooses options in proportion to how well they have worked. Instrument choices also
 * look at how well each candidate has combined with the instruments already chosen.
 */
export function learnedChooser(rng: Rng, mem: GenreMemory | undefined, opts: { explore?: number; sharpness?: number } = {}): Chooser {
  const explore = opts.explore ?? 0.01, sharp = opts.sharpness ?? 60;
  const total = mem?.evaluated ?? 0;
  const chosen: string[] = [];
  return (<T,>(gene: string, options: readonly T[]): T => {
    if (options.length === 1) return options[0];
    const scores = options.map((o) => {
      const key = `${gene}:${String(o)}`;
      let a = appeal(mem, key, total, explore);
      if (gene.startsWith('inst.') && mem) {
        const me = `${gene.slice(5)}:${String(o)}`;
        const pairs = chosen.map((other) => mem.pairs[[me, other].sort().join('|')]).filter((s): s is Stat => !!s && s.n >= 3);
        if (pairs.length) a += pairs.reduce((x, s) => x + s.mean, 0) / pairs.length;
      }
      return a;
    });
    const max = Math.max(...scores);
    const w = scores.map((s) => Math.exp((s - max) * sharp));
    let r = rng() * w.reduce((a, b) => a + b, 0);
    let i = 0;
    while (i < w.length - 1 && r > w[i]) { r -= w[i]; i++; }
    if (gene.startsWith('inst.')) chosen.push(`${gene.slice(5)}:${String(options[i])}`);
    return options[i];
  }) as Chooser;
}

export interface Candidate { genome: Genome; review: Review }
export interface EvolveOptions {
  population?: number;
  generations?: number;
  length?: Length;
  seed?: number;
  /** Extra score for things the listener has liked (0 = ignore ratings). */
  tasteWeight?: number;
  /** Override decisions, e.g. a tempo or key the user asked for. */
  fix?: (g: Genome) => Genome;
  onGeneration?: (gen: number, best: Candidate, mean: number) => void;
  /** Run swap experiments on the round's best beats afterwards (default true). */
  experiments?: boolean;
  shouldStop?: () => boolean;
}

export function judge(g: Genome, length: Length): Review {
  return review(compose(g, length));
}

function tasteOf(mem: GenreMemory | undefined, g: Genome): number {
  if (!mem) return 0;
  const vals = choicesOf(g).map((c) => mem.taste[c]).filter((s): s is Stat => !!s);
  return vals.length ? vals.reduce((a, s) => a + s.mean * Math.min(1, s.n / 3), 0) / vals.length : 0;
}

/** Breed beats for one style. Updates `mem` with everything it tries. */
export async function evolve(genre: GenreId, mem: GenreMemory, opts: EvolveOptions = {}): Promise<{ best: Candidate[]; firstMean: number; finalMean: number }> {
  const P = opts.population ?? 32, G = opts.generations ?? 20, length = opts.length ?? 'loop';
  const rng = rngFrom(opts.seed ?? Math.floor(Math.random() * 1e9));
  const fix = opts.fix ?? ((g: Genome) => g);
  const tw = opts.tasteWeight ?? 0;
  const score = (r: Review, g: Genome) => r.total + tw * tasteOf(mem, g);
  const make = (g: Genome): Candidate & { fitness: number } => {
    const genome = fix(g);
    const r = judge(genome, length);
    remember(mem);
    return { genome, review: r, fitness: score(r, genome) };
  };

  // start from the remembered best beats and fresh ones drawn from what has worked
  let pop: (Candidate & { fitness: number })[] = [];
  const elites = mem.elites.slice(0, Math.floor(P / 4));
  for (const e of elites) pop.push(make(mutate(e.genome, rng, learnedChooser(rng, mem))));
  while (pop.length < P) pop.push(make(randomGenome(genre, rng, learnedChooser(rng, mem))));
  const firstMean = pop.reduce((a, c) => a + c.review.total, 0) / pop.length;

  const tournament = () => { const a = pick2(); return a; };
  const pick2 = () => { const a = pop[Math.floor(rng() * pop.length)], b = pop[Math.floor(rng() * pop.length)]; return a.fitness >= b.fitness ? a : b; };
  for (let gen = 0; gen < G; gen++) {
    if (opts.shouldStop?.()) break;
    pop.sort((a, b) => b.fitness - a.fitness);
    const next = pop.slice(0, Math.max(2, Math.floor(P / 8))); // the best few survive unchanged
    while (next.length < P) {
      const r = rng();
      const chooser = learnedChooser(rng, mem);
      let child: Genome;
      if (r < 0.25) child = mutate(crossover(tournament().genome, tournament().genome, rng), rng, chooser);
      else if (r < 0.9) child = mutate(tournament().genome, rng, chooser);
      else child = randomGenome(genre, rng, chooser); // keep some fresh ideas coming
      next.push(make(child));
    }
    pop = next;
    const mean = pop.reduce((a, c) => a + c.review.total, 0) / pop.length;
    pop.sort((a, b) => b.fitness - a.fitness);
    opts.onGeneration?.(gen, pop[0], mean);
    if (gen % 4 === 3) await new Promise((r) => setTimeout(r, 0));
  }
  pop.sort((a, b) => b.fitness - a.fitness);
  const finalMean = pop.reduce((a, c) => a + c.review.total, 0) / pop.length;
  // remember the best distinct beats for next time
  const seen = new Set<string>();
  const merged = [...pop.map((c) => ({ genome: c.genome, score: c.review.total })), ...mem.elites].sort((a, b) => b.score - a.score).filter((e) => {
    const sig = choicesOf(e.genome).join('|') + e.genome.motif.map((n) => n.deg).join('');
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
  mem.elites = merged.slice(0, 8);
  // learn from the best of this round: take them apart one decision at a time
  if (opts.experiments !== false) for (const c of pop.slice(0, 3)) experiment(mem, c.genome, length);
  return { best: pop.slice(0, 6), firstMean, finalMean };
}

/** What the memory has learned, in words: the best-scoring instruments and pairings for a style. */
export function lessons(genre: GenreId, mem: GenreMemory, minTries = 20): { role: Role; best: { id: string; mean: number; n: number }[] }[] {
  const g = GENRES[genre];
  return ROLES.filter((r) => (g.roles[r]?.length ?? 0) > 1).map((role) => ({
    role,
    best: (g.roles[role] ?? []).map((id) => ({ id, ...(mem.effects[`inst.${role}:${id}`] ?? { n: 0, mean: 0 }) })).filter((s) => s.n >= minTries).sort((a, b) => b.mean - a.mean),
  }));
}

export function bestPairs(mem: GenreMemory, count = 6, minTries = 30): { pair: string; mean: number; n: number }[] {
  return Object.entries(mem.pairs).filter(([, s]) => s.n >= minTries).map(([pair, s]) => ({ pair, ...s })).sort((a, b) => b.mean - a.mean).slice(0, count);
}
