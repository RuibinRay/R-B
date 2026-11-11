import type { ID, Project, Track } from '../types';

// Mix rules shared by live playback, export and the timeline drawing, so all three
// always agree: how groups affect a track, and how overlapping audio clips crossfade.

/** A track's level and audibility once its group's fader, mute and solo are applied. */
export function trackMix(p: Project, t: Track): { volume: number; audible: boolean } {
  const groups = p.groups ?? [];
  const g = t.groupId ? groups.find((x) => x.id === t.groupId) : undefined;
  const anySolo = p.tracks.some((x) => x.solo) || groups.some((x) => x.solo);
  return {
    volume: t.volume + (g?.volume ?? 0),
    audible: !t.mute && !g?.mute && (!anySolo || t.solo || !!g?.solo),
  };
}

export interface ClipFades {
  fadeIn: number; // seconds
  fadeOut: number;
  crossIn: boolean; // the fade-in is an automatic crossfade (equal-power curve)
  crossOut: boolean;
}

/**
 * The fades every audio clip is actually played with. A clip keeps its own fades;
 * where it overlaps the next clip on the same track, both get a fade across the
 * whole overlap so one hands over to the other without a bump or a click.
 */
export function effectiveFades(p: Project): Map<ID, ClipFades> {
  const out = new Map<ID, ClipFades>();
  const spb = 60 / p.bpm;
  const byTrack = new Map<ID, { id: ID; start: number; end: number; length: number }[]>();
  for (const c of p.clips) {
    if (c.type !== 'audio') continue;
    out.set(c.id, { fadeIn: c.fadeIn, fadeOut: c.fadeOut, crossIn: false, crossOut: false });
    if (c.muted) continue;
    const list = byTrack.get(c.trackId) ?? [];
    list.push({ id: c.id, start: c.start * spb, end: c.start * spb + c.length, length: c.length });
    byTrack.set(c.trackId, list);
  }
  if (p.autoCrossfade === false) return out;
  for (const list of byTrack.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i], b = list[i + 1];
      const overlap = a.end - b.start;
      if (overlap < 0.005 || b.end <= a.end) continue; // apart, or one sits wholly inside the other
      const x = Math.min(overlap, a.length, b.length);
      const fa = out.get(a.id)!, fb = out.get(b.id)!;
      if (x > fa.fadeOut) { fa.fadeOut = x; fa.crossOut = true; }
      if (x > fb.fadeIn) { fb.fadeIn = x; fb.crossIn = true; }
    }
  }
  return out;
}
