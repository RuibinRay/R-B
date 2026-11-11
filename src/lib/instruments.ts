// The instrument catalog. Sampled instruments use the FluidR3_GM soundfont
// (CC BY 3.0, pre-rendered by the midi-js-soundfonts project); synths and drum
// kits are synthesized in the browser. Ranges are each instrument's real playable range.

export type Category = 'keys' | 'strings' | 'woodwinds' | 'brass' | 'percussion' | 'electronic' | 'world' | 'orchestral' | 'fx';

export const CATEGORIES: { id: Category; name: string }[] = [
  { id: 'keys', name: 'Piano & Keyboards' },
  { id: 'strings', name: 'Strings' },
  { id: 'woodwinds', name: 'Woodwinds' },
  { id: 'brass', name: 'Brass' },
  { id: 'percussion', name: 'Percussion' },
  { id: 'electronic', name: 'Electronic' },
  { id: 'world', name: 'World Instruments' },
  { id: 'orchestral', name: 'Orchestral & Ambient' },
  { id: 'fx', name: 'Sound Effects' },
];

export type Fallback = 'keys' | 'pluck' | 'bowed' | 'wind' | 'brass' | 'mallet' | 'pad' | 'bass';

export interface InstrumentDef {
  id: string;
  name: string;
  category: Category;
  engine: 'sample' | 'synth' | 'drums' | 'model';
  range: [number, number];
  desc: string;
  gm?: string; // soundfont patch name
  sustain?: boolean; // loop the sample so held notes keep sounding
  attack?: number;
  release?: number;
  gain?: number;
  fallback?: Fallback; // synth family used if samples cannot be loaded
  synth?: string; // synth preset id
  kit?: string; // drum kit id
  model?: string; // sound model id (computed in the browser, see audio/models.ts)
  approx?: string; // honest note when a sample stands in for the real instrument
}

const s = (
  id: string, name: string, category: Category, gm: string, lo: number, hi: number, fallback: Fallback, desc: string,
  extra: Partial<InstrumentDef> = {},
): InstrumentDef => ({ id, name, category, engine: 'sample', gm, range: [lo, hi], fallback, desc, ...extra });

const y = (id: string, name: string, synth: string, lo: number, hi: number, desc: string): InstrumentDef =>
  ({ id, name, category: 'electronic', engine: 'synth', synth, range: [lo, hi], desc });

/** A modeled instrument: its sound is computed in the browser rather than sampled. */
const m = (id: string, name: string, category: Category, model: string, lo: number, hi: number, desc: string, extra: Partial<InstrumentDef> = {}): InstrumentDef =>
  ({ id, name, category, engine: 'model', model, range: [lo, hi], desc, gain: 1, ...extra });

const kit = (id: string, name: string, category: Category, kitId: string, desc: string): InstrumentDef =>
  ({ id, name, category, engine: 'drums', kit: kitId, range: [35, 81], desc });

const held = { sustain: true };

export const INSTRUMENTS: InstrumentDef[] = [
  // Piano & Keyboards
  s('grand-piano', 'Grand piano', 'keys', 'acoustic_grand_piano', 21, 108, 'keys', 'Concert grand with a full 88-key range.'),
  s('upright-piano', 'Upright piano', 'keys', 'bright_acoustic_piano', 21, 108, 'keys', 'Brighter, closer piano voicing.'),
  s('electric-piano', 'Electric piano', 'keys', 'electric_piano_1', 28, 100, 'keys', 'Warm tine electric piano.'),
  s('fm-piano', 'FM electric piano', 'keys', 'electric_piano_2', 28, 100, 'keys', 'Glassy digital electric piano.'),
  s('organ', 'Drawbar organ', 'keys', 'drawbar_organ', 36, 96, 'pad', 'Tonewheel organ, holds as long as the key.', held),
  s('church-organ', 'Church organ', 'keys', 'church_organ', 24, 96, 'pad', 'Pipe organ with full ranks.', held),
  s('harpsichord', 'Harpsichord', 'keys', 'harpsichord', 29, 89, 'pluck', 'Plucked baroque keyboard.'),
  s('clavinet', 'Clavinet', 'keys', 'clavinet', 29, 88, 'pluck', 'Funky electric clavichord.'),
  s('celesta', 'Celesta', 'keys', 'celesta', 60, 108, 'mallet', 'Bell-like keyboard.'),
  s('music-box', 'Music box', 'keys', 'music_box', 60, 96, 'mallet', 'Delicate comb chimes.'),
  s('accordion', 'Accordion', 'keys', 'accordion', 53, 93, 'pad', 'Reed bellows instrument.', held),
  s('honkytonk', 'Honky-tonk piano', 'keys', 'honkytonk_piano', 21, 108, 'keys', 'Detuned saloon piano.'),
  s('electric-grand', 'Electric grand', 'keys', 'electric_grand_piano', 28, 103, 'keys', 'Stage piano with a pickup bite.'),
  s('percussive-organ', 'Percussive organ', 'keys', 'percussive_organ', 36, 96, 'pad', 'Organ with a clicky attack.', held),
  s('rock-organ', 'Rock organ', 'keys', 'rock_organ', 36, 96, 'pad', 'Overdriven rotary organ.', held),
  s('reed-organ', 'Reed organ', 'keys', 'reed_organ', 36, 96, 'pad', 'Harmonium-style pump organ.', held),
  s('bandoneon', 'Bandoneon', 'keys', 'tango_accordion', 53, 93, 'pad', 'Tango concertina.', held),
  m('tine-keys', 'Tine keys', 'keys', 'tines', 36, 96, 'Bell-topped electric piano, modeled.'),
  m('jazz-organ', 'Jazz organ', 'keys', 'jazzOrgan', 36, 96, 'Three low drawbars, modeled.', { sustain: true, release: 0.06, attack: 0.004 }),
  m('full-organ', 'Full organ', 'keys', 'fullOrgan', 36, 96, 'All drawbars out, modeled.', { sustain: true, release: 0.06, attack: 0.004 }),
  m('flute-organ', 'Flute stop organ', 'keys', 'fluteOrgan', 48, 96, 'Soft, pure organ stop, modeled.', { sustain: true, release: 0.08, attack: 0.01 }),
  m('hollow-organ', 'Hollow reed organ', 'keys', 'reedOrgan', 36, 96, 'Odd harmonics only, modeled.', { sustain: true, release: 0.08, attack: 0.008 }),

  // Strings
  s('violin', 'Violin', 'strings', 'violin', 55, 100, 'bowed', 'Solo bowed violin.', { ...held, attack: 0.03 }),
  s('viola', 'Viola', 'strings', 'viola', 48, 88, 'bowed', 'Darker alto of the string family.', { ...held, attack: 0.03 }),
  s('cello', 'Cello', 'strings', 'cello', 36, 81, 'bowed', 'Rich tenor-bass strings.', { ...held, attack: 0.03 }),
  s('double-bass', 'Double bass', 'strings', 'contrabass', 28, 67, 'bowed', 'Bowed orchestral bass.', { ...held, attack: 0.04 }),
  s('harp', 'Harp', 'strings', 'orchestral_harp', 24, 103, 'pluck', 'Concert harp.'),
  s('acoustic-guitar', 'Acoustic guitar', 'strings', 'acoustic_guitar_steel', 40, 83, 'pluck', 'Steel-string acoustic.'),
  s('classical-guitar', 'Classical guitar', 'strings', 'acoustic_guitar_nylon', 40, 83, 'pluck', 'Nylon-string guitar.'),
  s('electric-guitar', 'Electric guitar', 'strings', 'electric_guitar_clean', 40, 86, 'pluck', 'Clean electric guitar.'),
  s('overdrive-guitar', 'Overdriven guitar', 'strings', 'overdriven_guitar', 40, 86, 'brass', 'Crunchy lead guitar.', held),
  s('distortion-guitar', 'Distortion guitar', 'strings', 'distortion_guitar', 40, 86, 'brass', 'High-gain rock guitar.', held),
  s('ukulele', 'Ukulele', 'strings', 'acoustic_guitar_nylon', 60, 81, 'pluck', 'Bright four-string ukulele.', { approx: 'Uses nylon-string samples in the ukulele register.' }),
  s('banjo', 'Banjo', 'strings', 'banjo', 48, 84, 'pluck', 'Bright five-string banjo.'),
  s('electric-bass', 'Electric bass', 'strings', 'electric_bass_finger', 28, 67, 'bass', 'Fingered bass guitar.'),
  s('pizzicato', 'Pizzicato strings', 'strings', 'pizzicato_strings', 36, 96, 'pluck', 'Plucked string section.'),
  s('jazz-guitar', 'Jazz guitar', 'strings', 'electric_guitar_jazz', 40, 86, 'pluck', 'Warm hollow-body electric.'),
  s('muted-guitar', 'Muted guitar', 'strings', 'electric_guitar_muted', 40, 86, 'pluck', 'Palm-muted electric.'),
  s('guitar-harmonics', 'Guitar harmonics', 'strings', 'guitar_harmonics', 52, 88, 'mallet', 'Chiming natural harmonics.'),
  s('upright-bass', 'Upright bass', 'strings', 'acoustic_bass', 28, 67, 'bass', 'Plucked jazz double bass.'),
  s('picked-bass', 'Picked bass', 'strings', 'electric_bass_pick', 28, 67, 'bass', 'Bass guitar played with a pick.'),
  s('fretless-bass', 'Fretless bass', 'strings', 'fretless_bass', 28, 67, 'bass', 'Singing fretless bass.'),
  s('slap-bass', 'Slap bass', 'strings', 'slap_bass_1', 28, 67, 'bass', 'Funk thumb and pop.'),
  m('modeled-nylon', 'Nylon string', 'strings', 'nylon', 40, 84, 'Soft plucked string, modeled.', { release: 0.3 }),
  m('modeled-steel', 'Steel string', 'strings', 'steel', 40, 88, 'Bright ringing string, modeled.', { release: 0.35 }),
  m('plucked-wire', 'Plucked wire', 'strings', 'wire', 36, 96, 'Thin, glassy string, modeled.', { release: 0.3 }),
  m('muted-pluck', 'Muted pluck', 'strings', 'muted', 36, 84, 'Short damped string, modeled.', { release: 0.1 }),
  m('pluck-bass', 'Pluck bass', 'strings', 'pluckBass', 28, 60, 'Round plucked bass string, modeled.', { release: 0.2 }),

  // Woodwinds
  s('flute', 'Flute', 'woodwinds', 'flute', 60, 96, 'wind', 'Concert flute.', { ...held, attack: 0.02 }),
  s('piccolo', 'Piccolo', 'woodwinds', 'piccolo', 74, 108, 'wind', 'An octave above the flute.', { ...held, attack: 0.02 }),
  s('clarinet', 'Clarinet', 'woodwinds', 'clarinet', 50, 94, 'wind', 'Smooth single reed.', { ...held, attack: 0.02 }),
  s('oboe', 'Oboe', 'woodwinds', 'oboe', 58, 93, 'wind', 'Nasal double reed.', { ...held, attack: 0.02 }),
  s('english-horn', 'English horn', 'woodwinds', 'english_horn', 52, 81, 'wind', 'Mellow tenor oboe.', { ...held, attack: 0.02 }),
  s('bassoon', 'Bassoon', 'woodwinds', 'bassoon', 34, 76, 'wind', 'Bass double reed.', { ...held, attack: 0.02 }),
  s('soprano-sax', 'Soprano saxophone', 'woodwinds', 'soprano_sax', 56, 88, 'wind', 'Bright straight sax.', { ...held, attack: 0.02 }),
  s('alto-sax', 'Alto saxophone', 'woodwinds', 'alto_sax', 49, 80, 'wind', 'Expressive alto sax.', { ...held, attack: 0.02 }),
  s('tenor-sax', 'Tenor saxophone', 'woodwinds', 'tenor_sax', 44, 76, 'wind', 'Husky tenor sax.', { ...held, attack: 0.02 }),
  s('baritone-sax', 'Baritone saxophone', 'woodwinds', 'baritone_sax', 36, 69, 'wind', 'Low growling sax.', { ...held, attack: 0.02 }),
  s('recorder', 'Recorder', 'woodwinds', 'recorder', 72, 98, 'wind', 'Simple fipple flute.', { ...held, attack: 0.02 }),
  s('harmonica', 'Harmonica', 'woodwinds', 'harmonica', 60, 96, 'wind', 'Blues harp.', held),
  s('blown-bottle', 'Blown bottle', 'woodwinds', 'blown_bottle', 60, 96, 'wind', 'Breathy jug tone.', held),
  s('whistle', 'Whistle', 'woodwinds', 'whistle', 72, 96, 'wind', 'Human whistling.', held),

  // Brass
  s('trumpet', 'Trumpet', 'brass', 'trumpet', 54, 86, 'brass', 'Bright lead brass.', { ...held, attack: 0.015 }),
  s('muted-trumpet', 'Muted trumpet', 'brass', 'muted_trumpet', 54, 86, 'brass', 'Harmon-mute jazz trumpet.', { ...held, attack: 0.015 }),
  s('trombone', 'Trombone', 'brass', 'trombone', 40, 77, 'brass', 'Slide trombone.', { ...held, attack: 0.02 }),
  s('french-horn', 'French horn', 'brass', 'french_horn', 35, 77, 'brass', 'Round, noble horn.', { ...held, attack: 0.03 }),
  s('tuba', 'Tuba', 'brass', 'tuba', 26, 65, 'brass', 'Bass of the brass family.', { ...held, attack: 0.03 }),
  s('brass-section', 'Brass section', 'brass', 'brass_section', 36, 84, 'brass', 'Ensemble brass stabs and swells.', { ...held, attack: 0.02 }),

  // Percussion
  { id: 'studio-kit', name: 'Studio drum kit', category: 'percussion', engine: 'drums', kit: 'studio', range: [35, 81], desc: 'Kick, snare, hi-hats, toms and cymbals.' },
  { id: 'latin-kit', name: 'Latin percussion', category: 'percussion', engine: 'drums', kit: 'latin', range: [35, 81], desc: 'Bongos, congas, claves, cowbell and shakers.' },
  s('xylophone', 'Xylophone', 'percussion', 'xylophone', 65, 108, 'mallet', 'Dry wooden bars.'),
  s('marimba', 'Marimba', 'percussion', 'marimba', 45, 96, 'mallet', 'Warm resonant bars.'),
  s('vibraphone', 'Vibraphone', 'percussion', 'vibraphone', 53, 89, 'mallet', 'Metal bars with motor vibrato.'),
  s('glockenspiel', 'Glockenspiel', 'percussion', 'glockenspiel', 79, 108, 'mallet', 'High steel bars.'),
  s('timpani', 'Timpani', 'percussion', 'timpani', 38, 57, 'mallet', 'Tuned orchestral kettle drums.'),
  s('steel-drums', 'Steel drums', 'percussion', 'steel_drums', 60, 88, 'mallet', 'Caribbean steel pan.'),
  s('tubular-bells', 'Tubular bells', 'percussion', 'tubular_bells', 60, 77, 'mallet', 'Orchestral chimes.'),
  s('taiko', 'Taiko drum', 'percussion', 'taiko_drum', 36, 60, 'mallet', 'Large Japanese drum.'),
  kit('rock-kit', 'Rock drum kit', 'percussion', 'rock', 'Fat kick, long snare and deep toms.'),
  kit('brush-kit', 'Jazz brush kit', 'percussion', 'brush', 'Swished snare, soft kick and a long ride.'),
  kit('lofi-kit', 'Lo-fi drum kit', 'percussion', 'lofi', 'Dusty, band-limited drums.'),
  s('melodic-tom', 'Melodic toms', 'percussion', 'melodic_tom', 36, 72, 'mallet', 'Tuned concert toms.'),
  s('synth-drum', 'Synth toms', 'percussion', 'synth_drum', 36, 72, 'mallet', 'Electronic disco toms.'),
  s('agogo', 'Agogo bells', 'percussion', 'agogo', 60, 84, 'mallet', 'Brazilian double bell.'),
  s('woodblock', 'Woodblock', 'percussion', 'woodblock', 60, 84, 'mallet', 'Dry wooden knock.'),
  m('wood-bars', 'Wooden bars', 'percussion', 'woodBars', 48, 96, 'Short, woody mallet bars, modeled.'),

  // Electronic
  y('saw-lead', 'Saw lead', 'sawLead', 36, 96, 'Classic bright sawtooth lead.'),
  y('square-lead', 'Square lead', 'squareLead', 36, 96, 'Hollow square-wave lead.'),
  y('supersaw', 'Supersaw', 'supersaw', 36, 96, 'Stacked detuned saws for big chords.'),
  y('pluck', 'Arp pluck', 'pluck', 36, 96, 'Short pluck made for arpeggios.'),
  y('chip-lead', 'Chip lead', 'chip', 48, 96, 'Pulse-wave game console lead.'),
  y('warm-pad', 'Warm pad', 'warmPad', 36, 84, 'Slow, soft analog pad.'),
  y('glass-pad', 'Glass pad', 'glassPad', 48, 96, 'Shimmering FM pad.'),
  y('sub-bass', 'Sub bass', 'subBass', 24, 60, 'Pure sine sub.'),
  y('acid-bass', 'Acid bass', 'acidBass', 24, 60, 'Resonant filter-sweep bass.'),
  y('fm-bass', 'FM bass', 'fmBass', 24, 60, 'Punchy digital bass.'),
  y('fm-bell', 'FM bell', 'fmBell', 48, 96, 'Metallic bell tones.'),
  { id: 'electro-kit', name: 'Electronic drums', category: 'electronic', engine: 'drums', kit: 'electro', range: [35, 81], desc: 'Analog-style drum machine.' },
  s('scifi-fx', 'Sci-fi sweep', 'electronic', 'fx_8_scifi', 36, 96, 'pad', 'Evolving effect texture.', held),
  s('crystal-fx', 'Crystal', 'electronic', 'fx_3_crystal', 48, 96, 'mallet', 'Glittering effect tone.'),
  y('pwm-pad', 'PWM pad', 'pwmPad', 36, 84, 'Slowly shifting pulse-width pad.'),
  y('string-machine', 'String machine', 'stringMachine', 36, 96, 'Seventies ensemble strings.'),
  y('analog-brass', 'Analog brass', 'synthBrass', 36, 84, 'Filter-swept brass stabs.'),
  y('bell-pad', 'Bell pad', 'bellPad', 48, 96, 'Chiming pad that blooms.'),
  y('dx-piano', 'DX electric piano', 'dxPiano', 36, 96, 'Eighties FM electric piano.'),
  y('am-keys', 'AM keys', 'amKeys', 36, 96, 'Hollow, ringing keys.'),
  y('square-pluck', 'Square pluck', 'squarePluck', 36, 96, 'Short hollow pluck.'),
  y('sine-lead', 'Sine lead', 'sineLead', 48, 96, 'Pure whistle-like lead.'),
  y('vibrato-lead', 'Vibrato lead', 'vibratoLead', 48, 96, 'Two-oscillator lead with vibrato.'),
  y('bass-808', '808 bass', 'bass808', 24, 60, 'Long sub with a pitch drop.'),
  y('reese-bass', 'Reese bass', 'reeseBass', 24, 60, 'Detuned growling bass.'),
  y('wobble-bass', 'Wobble bass', 'wobbleBass', 24, 60, 'Bass with a rhythmic filter sweep.'),
  kit('house-kit', 'House drum machine', 'electronic', 'house', 'Clicky kick, bright snare and hats.'),
  kit('trap-kit', 'Trap drum machine', 'electronic', 'trap', 'Very long sub kick, tight hats, cracking snare.'),
  s('synth-bass-1', 'Sampled synth bass', 'electronic', 'synth_bass_1', 24, 72, 'bass', 'Punchy classic synth bass.'),
  s('rubber-bass', 'Rubber bass', 'electronic', 'synth_bass_2', 24, 72, 'bass', 'Rounder, bouncy synth bass.'),
  s('synth-strings', 'Synth strings', 'electronic', 'synth_strings_1', 36, 96, 'pad', 'Bright sampled string synth.', held),
  s('soft-synth-strings', 'Soft synth strings', 'electronic', 'synth_strings_2', 36, 96, 'pad', 'Slow, mellow string synth.', { ...held, attack: 0.1 }),
  s('synth-brass', 'Synth brass', 'electronic', 'synth_brass_1', 36, 96, 'brass', 'Big polysynth brass.', held),
  s('soft-synth-brass', 'Soft synth brass', 'electronic', 'synth_brass_2', 36, 96, 'brass', 'Rounder synth brass.', held),
  s('synth-choir', 'Synth choir', 'electronic', 'synth_choir', 48, 84, 'pad', 'Sampled vocoder-like voices.', held),
  s('calliope-lead', 'Calliope lead', 'electronic', 'lead_3_calliope', 48, 96, 'wind', 'Steam-organ lead.', held),
  s('chiff-lead', 'Chiff lead', 'electronic', 'lead_4_chiff', 48, 96, 'wind', 'Breathy attack lead.', held),
  s('charang-lead', 'Charang lead', 'electronic', 'lead_5_charang', 48, 96, 'brass', 'Guitar-like distorted lead.', held),
  s('voice-lead', 'Voice lead', 'electronic', 'lead_6_voice', 48, 96, 'wind', 'Vocal synth lead.', held),
  s('fifths-lead', 'Fifths lead', 'electronic', 'lead_7_fifths', 48, 96, 'brass', 'Lead stacked in fifths.', held),
  s('bass-lead', 'Bass and lead', 'electronic', 'lead_8_bass__lead', 36, 96, 'brass', 'Thick layered lead.', held),
  s('new-age-pad', 'New age pad', 'electronic', 'pad_1_new_age', 36, 96, 'pad', 'Glassy bell pad.', { ...held, release: 0.8 }),
  s('polysynth-pad', 'Polysynth pad', 'electronic', 'pad_3_polysynth', 36, 96, 'pad', 'Bright analog poly pad.', { ...held, release: 0.6 }),
  s('choir-pad', 'Choir pad', 'electronic', 'pad_4_choir', 36, 96, 'pad', 'Breathy sampled voices.', { ...held, attack: 0.1, release: 0.8 }),
  s('metallic-pad', 'Metallic pad', 'electronic', 'pad_6_metallic', 36, 96, 'pad', 'Cold, ringing pad.', { ...held, release: 0.8 }),
  s('sweep-pad', 'Sweep pad', 'electronic', 'pad_8_sweep', 36, 96, 'pad', 'Slow filter-sweep pad.', { ...held, attack: 0.15, release: 1 }),
  m('hollow-pad', 'Hollow pad', 'electronic', 'hollowPad', 36, 84, 'Wide, woody pad, modeled.', { sustain: true, attack: 0.35, release: 1.4, gain: 0.8 }),
  m('dark-pad', 'Dark pad', 'electronic', 'darkPad', 28, 72, 'Deep, soft-edged pad, modeled.', { sustain: true, attack: 0.5, release: 1.6, gain: 0.9 }),
  m('shimmer-pad', 'Shimmer pad', 'electronic', 'shimmerPad', 48, 96, 'Bright, airy pad, modeled.', { sustain: true, attack: 0.4, release: 1.8, gain: 0.7 }),

  // World
  s('erhu', 'Erhu', 'world', 'fiddle', 62, 98, 'bowed', 'Chinese two-string fiddle.', { ...held, attack: 0.04, approx: 'Modeled with a solo fiddle sample in the erhu register.' }),
  s('guzheng', 'Guzheng', 'world', 'koto', 38, 86, 'pluck', 'Chinese plucked zither.', { approx: 'Modeled with a koto sample, its closest relative in the sound set.' }),
  s('pipa', 'Pipa', 'world', 'banjo', 45, 86, 'pluck', 'Chinese four-string lute.', { approx: 'Modeled with a bright plucked-lute sample.' }),
  s('sitar', 'Sitar', 'world', 'sitar', 48, 84, 'pluck', 'Indian long-necked lute with buzzing bridge.'),
  s('shamisen', 'Shamisen', 'world', 'shamisen', 50, 84, 'pluck', 'Japanese three-string lute.'),
  s('koto', 'Koto', 'world', 'koto', 43, 84, 'pluck', 'Japanese thirteen-string zither.'),
  s('kalimba', 'Kalimba', 'world', 'kalimba', 60, 96, 'mallet', 'African thumb piano.'),
  s('pan-flute', 'Pan flute', 'world', 'pan_flute', 60, 96, 'wind', 'Breathy Andean pipes.', { ...held, attack: 0.03 }),
  s('shakuhachi', 'Shakuhachi', 'world', 'shakuhachi', 62, 98, 'wind', 'Japanese bamboo flute.', { ...held, attack: 0.03 }),
  s('bagpipe', 'Bagpipe', 'world', 'bagpipe', 58, 82, 'wind', 'Highland pipes with drone.', held),
  s('shanai', 'Shehnai', 'world', 'shanai', 60, 84, 'wind', 'North Indian double reed.', held),
  s('ocarina', 'Ocarina', 'world', 'ocarina', 72, 96, 'wind', 'Clay vessel flute.', held),
  s('dulcimer', 'Hammered dulcimer', 'world', 'dulcimer', 48, 96, 'pluck', 'Shimmering struck strings.'),
  m('handpan', 'Handpan', 'world', 'handpan', 50, 86, 'Steel hand drum with a soft bloom, modeled.'),
  m('singing-bowl', 'Singing bowl', 'world', 'bowl', 48, 84, 'Slowly beating metal bowl, modeled.', { release: 1.5 }),
  m('gamelan', 'Gamelan', 'world', 'gamelan', 48, 96, 'Bronze metallophone with shimmer, modeled.', { release: 0.8 }),

  // Orchestral & Ambient
  s('choir', 'Choir aahs', 'orchestral', 'choir_aahs', 48, 84, 'pad', 'Mixed choir on an open vowel.', { ...held, attack: 0.08, release: 0.5 }),
  s('voice-oohs', 'Voice oohs', 'orchestral', 'voice_oohs', 48, 84, 'pad', 'Soft vocal oohs.', { ...held, attack: 0.08, release: 0.5 }),
  s('cinematic-strings', 'Cinematic strings', 'orchestral', 'string_ensemble_1', 28, 100, 'bowed', 'Full string section.', { ...held, attack: 0.06, release: 0.5 }),
  s('slow-strings', 'Slow strings', 'orchestral', 'string_ensemble_2', 28, 100, 'bowed', 'Gentle swelling strings.', { ...held, attack: 0.25, release: 0.8 }),
  s('tremolo-strings', 'Tremolo strings', 'orchestral', 'tremolo_strings', 36, 96, 'bowed', 'Tense shimmering bows.', { ...held, attack: 0.04 }),
  s('orchestra-hit', 'Orchestra hit', 'orchestral', 'orchestra_hit', 48, 72, 'brass', 'Full-orchestra stab.'),
  s('bells', 'Bells', 'orchestral', 'tinkle_bell', 72, 108, 'mallet', 'Small bright bells.'),
  s('atmosphere', 'Atmosphere', 'orchestral', 'fx_4_atmosphere', 36, 96, 'pad', 'Airy plucked texture with a long tail.', { release: 1.2 }),
  s('halo-pad', 'Halo pad', 'orchestral', 'pad_7_halo', 36, 96, 'pad', 'Choral, glowing pad.', { ...held, attack: 0.15, release: 1 }),
  s('warm-texture', 'Warm texture', 'orchestral', 'pad_2_warm', 36, 96, 'pad', 'Soft sustained bed.', { ...held, attack: 0.15, release: 1 }),
  s('bowed-glass', 'Bowed glass', 'orchestral', 'pad_5_bowed', 36, 96, 'pad', 'Glassy bowed texture.', { ...held, attack: 0.1, release: 1 }),
  s('soundtrack', 'Soundtrack', 'orchestral', 'fx_2_soundtrack', 36, 96, 'pad', 'Wide cinematic drone.', { ...held, attack: 0.2, release: 1.2 }),
  s('rain-pad', 'Rain', 'orchestral', 'fx_1_rain', 36, 96, 'pad', 'Dripping, tonal rain texture.', { release: 1 }),
  s('brightness', 'Brightness', 'orchestral', 'fx_5_brightness', 36, 96, 'pad', 'Sparkling choral shimmer.', { ...held, release: 1 }),
  s('goblins', 'Goblins', 'orchestral', 'fx_6_goblins', 36, 96, 'pad', 'Eerie evolving drone.', { ...held, attack: 0.2, release: 1.2 }),
  s('echoes', 'Echoes', 'orchestral', 'fx_7_echoes', 36, 96, 'pad', 'Repeating, fading drops.', { release: 1.2 }),
  m('glass-bells', 'Glass bells', 'orchestral', 'glassBells', 60, 108, 'Clear inharmonic bells, modeled.', { release: 1 }),
  m('ensemble-pad', 'Ensemble pad', 'orchestral', 'ensemblePad', 36, 84, 'Thick string-section wash, modeled.', { sustain: true, attack: 0.3, release: 1.4, gain: 0.8 }),
  m('vocal-pad', 'Vocal pad', 'orchestral', 'vocalPad', 43, 79, 'Many voices on an open vowel, modeled.', { sustain: true, attack: 0.3, release: 1.4, gain: 0.9 }),

  // Sound effects
  m('wind', 'Wind', 'fx', 'wind', 36, 84, 'Gusting wind. Low keys are slow and dark, high keys thin.', { sustain: true, attack: 0.8, release: 1.5, gain: 2 }),
  m('vinyl', 'Vinyl crackle', 'fx', 'vinyl', 48, 72, 'Record surface noise to lay under a track.', { sustain: true, attack: 0.1, release: 0.4 }),
  m('riser', 'Riser', 'fx', 'riser', 48, 72, 'Four-second build into a drop.', { release: 0.1 }),
  m('downlifter', 'Downlifter', 'fx', 'downlifter', 48, 72, 'Falling sweep out of a drop.', { release: 0.3 }),
  m('impact', 'Impact', 'fx', 'impact', 36, 72, 'Cinematic boom.', { release: 0.5 }),
  m('sub-drop', 'Sub drop', 'fx', 'subdrop', 36, 72, 'Sinking bass tone.', { release: 0.4 }),
  m('laser-zap', 'Laser zap', 'fx', 'zap', 48, 84, 'Quick falling zap.', { release: 0.1 }),
  s('reverse-cymbal', 'Reverse cymbal', 'fx', 'reverse_cymbal', 48, 72, 'mallet', 'Swelling cymbal.'),
  s('seashore', 'Seashore', 'fx', 'seashore', 48, 72, 'pad', 'Waves on a beach.', held),
  s('birds', 'Birds', 'fx', 'bird_tweet', 60, 84, 'wind', 'Birdsong.', held),
  s('applause', 'Applause', 'fx', 'applause', 48, 72, 'pad', 'A clapping crowd.', held),
  s('helicopter', 'Helicopter', 'fx', 'helicopter', 48, 72, 'pad', 'Rotor blades.', held),
  s('telephone', 'Telephone', 'fx', 'telephone_ring', 60, 84, 'mallet', 'Ringing phone.', held),
  s('gunshot', 'Gunshot', 'fx', 'gunshot', 48, 72, 'mallet', 'Single shot.'),
  s('breath', 'Breath noise', 'fx', 'breath_noise', 48, 84, 'wind', 'Airy breath.', held),
  s('fret-noise', 'Fret noise', 'fx', 'guitar_fret_noise', 48, 84, 'pluck', 'Fingers sliding on guitar strings.'),
];

const byId = new Map(INSTRUMENTS.map((i) => [i.id, i]));
export const getInstrument = (id: string | null | undefined): InstrumentDef | undefined => (id ? byId.get(id) : undefined);
export const isDrums = (id: string | null | undefined): boolean => getInstrument(id)?.engine === 'drums';

export function searchInstruments(query: string, category?: Category | 'all'): InstrumentDef[] {
  const q = query.trim().toLowerCase();
  return INSTRUMENTS.filter((i) => {
    if (category && category !== 'all' && i.category !== category) return false;
    if (!q) return true;
    const cat = CATEGORIES.find((c) => c.id === i.category)!.name.toLowerCase();
    return i.name.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q) || cat.includes(q) || (i.gm ?? '').includes(q);
  });
}

// ---- drums ---------------------------------------------------------------

export interface DrumSound { midi: number; name: string; short: string; key: string }

export const DRUM_SOUNDS: DrumSound[] = [
  { midi: 36, name: 'Kick', short: 'Kick', key: 'kick' },
  { midi: 38, name: 'Snare', short: 'Snare', key: 'snare' },
  { midi: 37, name: 'Rimshot', short: 'Rim', key: 'rim' },
  { midi: 39, name: 'Clap', short: 'Clap', key: 'clap' },
  { midi: 42, name: 'Closed hi-hat', short: 'Hat', key: 'hatClosed' },
  { midi: 46, name: 'Open hi-hat', short: 'Open', key: 'hatOpen' },
  { midi: 44, name: 'Pedal hi-hat', short: 'Pedal', key: 'hatPedal' },
  { midi: 41, name: 'Low tom', short: 'Tom L', key: 'tomLow' },
  { midi: 45, name: 'Mid tom', short: 'Tom M', key: 'tomMid' },
  { midi: 48, name: 'High tom', short: 'Tom H', key: 'tomHigh' },
  { midi: 49, name: 'Crash cymbal', short: 'Crash', key: 'crash' },
  { midi: 51, name: 'Ride cymbal', short: 'Ride', key: 'ride' },
  { midi: 54, name: 'Tambourine', short: 'Tamb', key: 'tambourine' },
  { midi: 56, name: 'Cowbell', short: 'Bell', key: 'cowbell' },
  { midi: 70, name: 'Shaker', short: 'Shake', key: 'shaker' },
  { midi: 75, name: 'Claves', short: 'Clave', key: 'claves' },
  { midi: 60, name: 'High bongo', short: 'Bongo H', key: 'bongoHigh' },
  { midi: 61, name: 'Low bongo', short: 'Bongo L', key: 'bongoLow' },
  { midi: 62, name: 'Muted conga', short: 'Conga M', key: 'congaMute' },
  { midi: 63, name: 'High conga', short: 'Conga H', key: 'congaHigh' },
  { midi: 64, name: 'Low conga', short: 'Conga L', key: 'congaLow' },
];

export const drumSound = (midi: number): DrumSound | undefined => DRUM_SOUNDS.find((d) => d.midi === midi);

const STANDARD_PADS = [36, 38, 37, 39, 42, 46, 44, 41, 45, 48, 49, 51, 54, 56, 70, 75];
const LATIN_PADS = [60, 61, 63, 64, 62, 75, 56, 70, 54, 36, 38, 37, 42, 46, 39, 49];

/** Pad / step-sequencer row order for a drum kit instrument. */
export const kitPads = (instrumentId: string | null | undefined): number[] =>
  getInstrument(instrumentId)?.kit === 'latin' ? LATIN_PADS : STANDARD_PADS;
