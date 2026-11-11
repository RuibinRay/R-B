import { Midi } from '@tonejs/midi';
import type { MidiClip, Note, Project, Track } from '../types';
import { defaultFx } from '../types';
import { INSTRUMENTS, getInstrument, isDrums } from './instruments';
import { TRACK_COLORS, uid } from './music';

// Standard MIDI file export and import.

const GM = ['acoustic_grand_piano', 'bright_acoustic_piano', 'electric_grand_piano', 'honkytonk_piano', 'electric_piano_1', 'electric_piano_2', 'harpsichord', 'clavinet', 'celesta', 'glockenspiel', 'music_box', 'vibraphone', 'marimba', 'xylophone', 'tubular_bells', 'dulcimer', 'drawbar_organ', 'percussive_organ', 'rock_organ', 'church_organ', 'reed_organ', 'accordion', 'harmonica', 'tango_accordion', 'acoustic_guitar_nylon', 'acoustic_guitar_steel', 'electric_guitar_jazz', 'electric_guitar_clean', 'electric_guitar_muted', 'overdriven_guitar', 'distortion_guitar', 'guitar_harmonics', 'acoustic_bass', 'electric_bass_finger', 'electric_bass_pick', 'fretless_bass', 'slap_bass_1', 'slap_bass_2', 'synth_bass_1', 'synth_bass_2', 'violin', 'viola', 'cello', 'contrabass', 'tremolo_strings', 'pizzicato_strings', 'orchestral_harp', 'timpani', 'string_ensemble_1', 'string_ensemble_2', 'synth_strings_1', 'synth_strings_2', 'choir_aahs', 'voice_oohs', 'synth_choir', 'orchestra_hit', 'trumpet', 'trombone', 'tuba', 'muted_trumpet', 'french_horn', 'brass_section', 'synth_brass_1', 'synth_brass_2', 'soprano_sax', 'alto_sax', 'tenor_sax', 'baritone_sax', 'oboe', 'english_horn', 'bassoon', 'clarinet', 'piccolo', 'flute', 'recorder', 'pan_flute', 'blown_bottle', 'shakuhachi', 'whistle', 'ocarina', 'lead_1_square', 'lead_2_sawtooth', 'lead_3_calliope', 'lead_4_chiff', 'lead_5_charang', 'lead_6_voice', 'lead_7_fifths', 'lead_8_bass__lead', 'pad_1_new_age', 'pad_2_warm', 'pad_3_polysynth', 'pad_4_choir', 'pad_5_bowed', 'pad_6_metallic', 'pad_7_halo', 'pad_8_sweep', 'fx_1_rain', 'fx_2_soundtrack', 'fx_3_crystal', 'fx_4_atmosphere', 'fx_5_brightness', 'fx_6_goblins', 'fx_7_echoes', 'fx_8_scifi', 'sitar', 'banjo', 'shamisen', 'koto', 'kalimba', 'bagpipe', 'fiddle', 'shanai', 'tinkle_bell', 'agogo', 'steel_drums', 'woodblock', 'taiko_drum', 'melodic_tom', 'synth_drum', 'reverse_cymbal', 'guitar_fret_noise', 'breath_noise', 'seashore', 'bird_tweet', 'telephone_ring', 'helicopter', 'applause', 'gunshot'];

const SYNTH_PROGRAMS: Record<string, number> = { sawLead: 81, squareLead: 80, supersaw: 81, pluck: 84, chip: 80, warmPad: 89, glassPad: 88, subBass: 38, acidBass: 38, fmBass: 39, fmBell: 98 };

function programFor(instrumentId: string | null): number {
  const def = getInstrument(instrumentId);
  if (!def) return 0;
  if (def.engine === 'sample') return Math.max(0, GM.indexOf(def.gm ?? ''));
  if (def.engine === 'synth') return SYNTH_PROGRAMS[def.synth ?? ''] ?? 81;
  return 0;
}

const PPQ = 480;

export function projectToMidi(p: Project): Uint8Array {
  const midi = new Midi();
  midi.header.name = p.name;
  midi.header.setTempo(p.bpm);
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: [p.timeSig[0], p.timeSig[1]] });
  let channel = 0;
  for (const track of p.tracks) {
    if (track.kind !== 'instrument') continue;
    const clips = p.clips.filter((c): c is MidiClip => c.type === 'midi' && c.trackId === track.id && !c.muted);
    if (!clips.length) continue;
    const t = midi.addTrack();
    t.name = track.name;
    if (isDrums(track.instrumentId)) {
      t.channel = 9;
    } else {
      if (channel === 9) channel++;
      t.channel = channel++ % 16;
      t.instrument.number = programFor(track.instrumentId);
    }
    for (const clip of clips) {
      for (const n of clip.notes) {
        if (n.start < 0 || n.start >= clip.length) continue;
        t.addNote({
          midi: n.pitch,
          ticks: Math.round((clip.start + n.start) * PPQ),
          durationTicks: Math.max(1, Math.round(Math.min(n.duration, clip.length - n.start) * PPQ)),
          velocity: n.velocity,
        });
      }
    }
  }
  return midi.toArray();
}

export interface MidiImport { bpm: number | null; timeSig: [number, number] | null; tracks: Track[]; clips: MidiClip[] }

export function midiToTracks(data: ArrayBuffer, colorOffset = 0): MidiImport {
  const midi = new Midi(data);
  const ppq = midi.header.ppq || PPQ;
  const tracks: Track[] = [];
  const clips: MidiClip[] = [];
  midi.tracks.forEach((mt, i) => {
    if (!mt.notes.length) return;
    const drums = mt.channel === 9 || mt.instrument.percussion;
    const gmName = GM[mt.instrument.number] ?? '';
    const def = drums ? getInstrument('studio-kit') : INSTRUMENTS.find((d) => d.gm === gmName) ?? getInstrument('grand-piano');
    const track: Track = {
      id: uid(), name: mt.name || def?.name || `Track ${i + 1}`, kind: 'instrument', instrumentId: def?.id ?? 'grand-piano',
      color: TRACK_COLORS[(colorOffset + tracks.length) % TRACK_COLORS.length], volume: -6, pan: 0, mute: false, solo: false, fx: defaultFx(),
    };
    const notes: Note[] = mt.notes.map((n) => ({
      id: uid(), pitch: n.midi, start: n.ticks / ppq, duration: Math.max(0.05, n.durationTicks / ppq), velocity: Math.max(0.05, n.velocity),
    }));
    const end = Math.max(...notes.map((n) => n.start + n.duration));
    tracks.push(track);
    clips.push({ id: uid(), type: 'midi', trackId: track.id, name: track.name, start: 0, length: Math.max(4, Math.ceil(end / 4) * 4), notes });
  });
  const ts = midi.header.timeSignatures[0]?.timeSignature;
  return {
    bpm: midi.header.tempos[0]?.bpm ? Math.round(midi.header.tempos[0].bpm * 100) / 100 : null,
    timeSig: ts ? [ts[0], ts[1]] : null,
    tracks,
    clips,
  };
}
