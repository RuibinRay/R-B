import data from './profiles.json';

// Measured sound of each instrument (see measureProfiles.ts): loudness in dB, share of
// energy per band (BANDS), and how long a note rings, for a low, middle and high note.

export interface NoteProfile { db: number; bands: number[]; ring: number }
export interface InstrumentProfiles {
  instruments: Record<string, (NoteProfile & { pitch: number })[]>;
  kits: Record<string, Record<number, NoteProfile>>;
  /** Learned by listening to real renders (calibrate.ts): level offset and per-band factors. */
  corrections?: Record<string, { db: number; bands: number[]; n: number }>;
}

export const PROFILES = data as unknown as InstrumentProfiles;

const FLAT: NoteProfile = { db: -20, bands: [0, 0.05, 0.2, 0.35, 0.25, 0.1, 0.05], ring: 1 };

/** The measured note nearest in pitch, corrected by what calibration learned. */
export function noteProfile(instrumentId: string, pitch: number): NoteProfile {
  const raw = rawProfile(instrumentId, pitch);
  const fix = PROFILES.corrections?.[instrumentId];
  if (!fix) return raw;
  const bands = raw.bands.map((b, i) => b * (fix.bands[i] ?? 1));
  const total = bands.reduce((a, b) => a + b, 0) || 1;
  return { db: raw.db + fix.db, bands: bands.map((b) => b / total), ring: raw.ring };
}

/** The measured note nearest in pitch (shifted along the bands for notes far from it). */
function rawProfile(instrumentId: string, pitch: number): NoteProfile {
  const kit = PROFILES.kits[instrumentId];
  if (kit) return kit[pitch] ?? kit[38] ?? FLAT;
  const list = PROFILES.instruments[instrumentId];
  if (!list?.length) return FLAT;
  let best = list[0];
  for (const n of list) if (Math.abs(n.pitch - pitch) < Math.abs(best.pitch - pitch)) best = n;
  // one band is roughly 1.3 octaves wide: move the energy along for big pitch differences
  const shift = Math.round((pitch - best.pitch) / 16);
  if (!shift) return best;
  const bands = best.bands.map((_, i) => best.bands[Math.max(0, Math.min(best.bands.length - 1, i - shift))]);
  const total = bands.reduce((a, b) => a + b, 0) || 1;
  return { ...best, bands: bands.map((b) => b / total) };
}

/** Predicted loudness (dB, at fader 0) of a run of notes on one instrument while it plays. */
export function partLoudness(instrumentId: string, notes: { pitch: number; start: number; duration: number; velocity: number }[], bpm: number): number {
  const spb = 60 / bpm;
  let energy = 0;
  const bars = new Set<number>();
  for (const n of notes) {
    const prof = noteProfile(instrumentId, n.pitch);
    const power = 10 ** ((prof.db + 28 * Math.log10(Math.max(0.05, n.velocity) / 0.8)) / 10);
    energy += power * Math.max(0.05, Math.min(n.duration * spb + 0.15, prof.ring >= 1.9 ? n.duration * spb + 0.3 : prof.ring));
    bars.add(Math.floor(n.start / 4));
  }
  return 10 * Math.log10(energy / (Math.max(1, bars.size) * 4 * spb) + 1e-15);
}

export const hasProfile = (instrumentId: string): boolean => !!(PROFILES.instruments[instrumentId] || PROFILES.kits[instrumentId]);
