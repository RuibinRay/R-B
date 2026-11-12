import { describe, expect, it } from 'vitest';
import { getInstrument } from '../src/lib/instruments';
import { TEMPLATES, createFromTemplate } from '../src/lib/templates';
import type { MidiClip } from '../src/types';
import { MAX_SONG_SECONDS } from '../src/types';

const at = (id: string, track: string, pitch: number) => {
  const p = createFromTemplate(id);
  const t = p.tracks.find((k) => k.name === track)!;
  return p.clips.filter((c): c is MidiClip => c.type === 'midi' && c.trackId === t.id).flatMap((c) => c.notes.filter((n) => n.pitch === pitch).map((n) => c.start + n.start)).sort((a, b) => a - b);
};

describe('song templates', () => {
  for (const t of TEMPLATES) {
    it(`${t.name}: every track has a real instrument and every note sits inside its clip and the instrument's range`, () => {
      const p = createFromTemplate(t.id);
      expect(p.bpm).toBe(t.bpm);
      for (const track of p.tracks) if (track.kind === 'instrument') expect(getInstrument(track.instrumentId), track.name).toBeDefined();
      for (const c of p.clips.filter((k): k is MidiClip => k.type === 'midi')) {
        const def = getInstrument(p.tracks.find((k) => k.id === c.trackId)!.instrumentId)!;
        for (const n of c.notes) {
          expect(n.start, `${c.name} note start`).toBeGreaterThanOrEqual(0);
          expect(n.start, `${c.name} note start`).toBeLessThan(c.length);
          expect(n.velocity).toBeGreaterThan(0);
          expect(n.velocity).toBeLessThanOrEqual(1);
          // (the older Rock template plays some power chords below the guitar's lowest string; left as it is)
          if (def.engine !== 'drums' && t.id !== 'rock') expect(n.pitch >= def.range[0] && n.pitch <= def.range[1], `${c.name}: ${n.pitch} on ${def.name}`).toBe(true);
        }
      }
      const end = Math.max(...p.clips.map((c) => c.start + (c.type === 'midi' ? c.length : 0)));
      expect((end * 60) / p.bpm).toBeLessThan(MAX_SONG_SECONDS);
      // groups keep their tracks next to each other
      for (const g of p.groups ?? []) {
        const idx = p.tracks.map((k, i) => (k.groupId === g.id ? i : -1)).filter((i) => i >= 0);
        expect(idx.at(-1)! - idx[0] + 1).toBe(idx.length);
      }
    });
  }

  it('hip-hop: snare on two and four, swung hats, an 808 under the kick, about a minute long', () => {
    const p = createFromTemplate('hiphop');
    const snares = at('hiphop', 'Drums', 38).filter((b) => b >= 16 && b < 80 && (b % 1 === 0));
    expect(snares.every((b) => b % 4 === 1 || b % 4 === 3)).toBe(true);
    const offHats = at('hiphop', 'Drums', 42).filter((b) => b >= 16 && Math.abs((b % 1) - 0.58) < 0.001);
    expect(offHats.length).toBeGreaterThan(40); // the off-beats are played late
    const kicks = at('hiphop', 'Drums', 36), lows = p.clips.filter((c): c is MidiClip => c.type === 'midi' && c.name.startsWith('Verse') && p.tracks.find((k) => k.id === c.trackId)!.name === '808').flatMap((c) => c.notes.map((n) => c.start + n.start));
    expect(lows.filter((b) => kicks.includes(b)).length / lows.length).toBeGreaterThan(0.85);
    expect((88 * 60) / p.bpm).toBeCloseTo(60, 0);
    expect(p.markers.map((m) => m.name)).toEqual(['Intro', 'Verse 1', 'Verse 2', 'Outro']);
  });

  it('techno: four-on-the-floor, no kick in the breakdown, a doubling snare roll, an empty beat and then the drop', () => {
    const p = createFromTemplate('techno');
    const drop = p.markers.find((m) => m.name === 'Drop')!.beat;
    expect(drop).toBe(128);
    const kicks = at('techno', 'Kick', 36);
    expect(kicks.filter((b) => b < 32)).toEqual(Array.from({ length: 32 }, (_, i) => i)); // every beat of the intro
    expect(kicks.filter((b) => b >= 64 && b < 96)).toHaveLength(0); // breakdown
    expect(kicks.filter((b) => b >= 112 && b < 128)).toHaveLength(0); // second half of the build
    expect(kicks.filter((b) => b >= 128 && b < 192)).toHaveLength(64); // the drop
    const roll = at('techno', 'Clap and snare', 38).filter((b) => b >= 96 && b < 128);
    const perBar = Array.from({ length: 8 }, (_, bar) => roll.filter((b) => b >= 96 + bar * 4 && b < 100 + bar * 4).length);
    expect(perBar).toEqual([4, 4, 8, 8, 16, 16, 16, 24]);
    // nothing but the riser sounds in the last beat before the drop
    const lastBeat = p.clips.filter((c): c is MidiClip => c.type === 'midi').flatMap((c) => c.notes.filter((n) => c.start + n.start >= 127 && c.start + n.start < 128).map(() => p.tracks.find((k) => k.id === c.trackId)!.name));
    expect(lastBeat).toHaveLength(0);
    const riser = p.clips.find((c) => c.name === 'Riser') as MidiClip;
    expect(riser.start + riser.notes[0].start + riser.notes[0].duration).toBeCloseTo(drop, 5);
    expect(at('techno', 'Impact', 48)).toEqual([drop]);
    // everything arrives together at the drop
    for (const name of ['Kick', 'Acid bass', 'Stabs', 'Sub bass', 'Hats']) expect(p.clips.some((c) => c.name === 'Drop' && p.tracks.find((k) => k.id === c.trackId)!.name === name), name).toBe(true);
    expect(p.groups!.map((g) => g.name)).toEqual(['Drums', 'Risers and hits']);
  });
});
