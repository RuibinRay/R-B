import { evolve, type Candidate } from './learn';
import type { LabRequest } from './lab';
import { mutate, rngFrom } from './genome';
import { GENRES } from './knowledge';

// Breeds beats off the main thread and returns three different ones.

const scope = self as unknown as { onmessage: ((e: MessageEvent<LabRequest>) => void) | null; postMessage(m: unknown): void };

scope.onmessage = async (e) => {
  const req = e.data;
  try {
    const mem = req.memory;
    const rng = rngFrom(req.seed);
    const fix = (g: Candidate['genome']) => ({ ...g, ...(req.fix?.bpm ? { bpm: req.fix.bpm } : {}), ...(req.fix?.root !== undefined ? { root: req.fix.root } : {}) });
    if (req.seedGenome) {
      // "more like this": start from variations of the chosen beat
      mem.elites = [{ genome: req.seedGenome, score: 1 }, ...Array.from({ length: 5 }, () => ({ genome: mutate(req.seedGenome!, rng), score: 0.99 }))];
    }
    // Three separate searches, each told to avoid the lead and chord sounds the earlier ones
    // settled on, so the three results really differ instead of being one beat three times.
    const picked: Candidate[] = [];
    const avoidLead = new Set<string>(), avoidChords = new Set<string>();
    const genre = GENRES[req.genre];
    const searches = 3;
    for (let k = 0; k < searches; k++) {
      const avoid = (g: Candidate['genome']) => {
        const x = fix(g);
        const leads = (genre.roles.lead ?? []).filter((v) => !avoidLead.has(v));
        const chords = (genre.roles.chords ?? []).filter((v) => !avoidChords.has(v));
        if (x.inst.lead && avoidLead.has(x.inst.lead) && leads.length) x.inst = { ...x.inst, lead: leads[Math.floor(rng() * leads.length)] };
        if (x.inst.chords && avoidChords.has(x.inst.chords) && chords.length) x.inst = { ...x.inst, chords: chords[Math.floor(rng() * chords.length)] };
        return x;
      };
      let best: Candidate | null = null;
      for (let round = 0; round < req.rounds; round++) {
        const res = await evolve(req.genre, mem, {
          population: req.population, generations: req.generations, length: req.length, seed: req.seed + k * 104729 + round * 7919, tasteWeight: req.tasteWeight, fix: avoid,
          onGeneration: (gen, b, mean) => scope.postMessage({ type: 'progress', round: k * req.rounds + round, gen, best: b.review.total, mean }),
        });
        if (!best || res.best[0].review.total > best.review.total) best = res.best[0];
      }
      if (best) {
        picked.push(best);
        if (best.genome.inst.lead) avoidLead.add(best.genome.inst.lead);
        if (best.genome.inst.chords) avoidChords.add(best.genome.inst.chords);
      }
    }
    picked.sort((a, b) => b.review.total - a.review.total);
    scope.postMessage({ type: 'done', candidates: picked, memory: mem });
  } catch (err) {
    scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
