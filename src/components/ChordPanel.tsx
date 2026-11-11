import { useState } from 'react';
import { Plus } from 'lucide-react';
import { engine } from '../audio/engine';
import type { MidiClip, Note } from '../types';
import { CHORDS, NOTE_NAMES, SCALES, barBeats, chordPitches, chordSuffix, diatonicChords, floorBeat, snapValue, uid } from '../lib/music';
import { A, beginGesture, endGesture, toast, useStore } from '../store/store';
import { KeySelect } from './TransportBar';
import { Hint } from './ui';

// Chord creator and scale assistant: build chords from the song's key and drop
// them (as blocks or arpeggios) into the clip that is open in the editor.

type Style = 'block' | 'up' | 'down' | 'updown';

export function ChordPanel() {
  const key = useStore((s) => s.project.key);
  const timeSig = useStore((s) => s.project.timeSig);
  const snap = useStore((s) => s.ui.snap);
  const clip = useStore((s) => s.project.clips.find((c) => c.id === s.ui.editClipId)) as MidiClip | undefined;
  const [root, setRoot] = useState(key.root);
  const [quality, setQuality] = useState('maj');
  const [inversion, setInversion] = useState(0);
  const [octave, setOctave] = useState(4);
  const [length, setLength] = useState(4);
  const [style, setStyle] = useState<Style>('block');
  const [rate, setRate] = useState(0.5);
  const chords = diatonicChords(key);
  const pitches = chordPitches(root, quality, octave, inversion);
  const label = `${NOTE_NAMES[root]}${chordSuffix[quality] ?? ''}`;

  const audition = (ps: number[]) => { if (clip) ps.forEach((p) => engine.auditionTrack(clip.trackId, p, 0.75, 0.9)); };
  const choose = (r: number, q: string) => { setRoot(r); setQuality(q); audition(chordPitches(r, q, octave, inversion)); };

  const insert = () => {
    if (!clip || clip.type !== 'midi') { toast('Open a note clip first, then add chords to it.', 'info'); return; }
    const grid = snapValue(snap, timeSig) || 0.25;
    const at = Math.max(0, floorBeat(engine.beat - clip.start + 1e-6, grid));
    const notes: Note[] = [];
    if (style === 'block') {
      for (const p of pitches) notes.push({ id: uid(), pitch: p, start: at, duration: length * 0.98, velocity: 0.75 });
    } else {
      const up = [...pitches, pitches[0] + 12];
      const order = style === 'up' ? up : style === 'down' ? [...up].reverse() : [...up, ...[...up].reverse().slice(1, -1)];
      for (let t = 0, i = 0; t < length - 1e-6; t += rate, i++) {
        notes.push({ id: uid(), pitch: order[i % order.length], start: at + t, duration: rate * 0.95, velocity: i % order.length === 0 ? 0.8 : 0.65 });
      }
    }
    const end = at + length;
    const bar = barBeats(timeSig);
    beginGesture(); // one undo step for the length change and the new notes
    if (end > clip.length) A.updateClip(clip.id, { length: Math.ceil(end / bar) * bar }, true);
    A.setNotes(clip.id, [...clip.notes, ...notes], true);
    endGesture();
    audition(pitches);
    A.seek(clip.start + end);
  };

  const scaleNotes = SCALES[key.scale].steps.map((s) => NOTE_NAMES[(key.root + s) % 12]);
  return (
    <div style={{ padding: '10px 12px 14px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 18, alignItems: 'start' }}>
      <div className="col">
        <KeySelect />
        <span className="label">Chords that fit {NOTE_NAMES[key.root]} {SCALES[key.scale].name.toLowerCase()}</span>
        <div className="row wrap" style={{ gap: 6 }}>
          {chords.map((c) => (
            <button key={c.degree} className={`btn ${root === c.rootPc && quality === c.quality ? 'primary' : ''}`} style={{ borderRadius: 7, minWidth: 54, flexDirection: 'column', height: 42, gap: 0, lineHeight: '15px' }} onClick={() => choose(c.rootPc, c.quality)} title="Click to hear and select">
              <span>{c.label}</span><span style={{ fontSize: 11, opacity: 0.65 }}>{c.roman}</span>
            </button>
          ))}
        </div>
        <span className="label" style={{ marginTop: 6 }}>Scale notes</span>
        <div className="row wrap" style={{ gap: 4 }}>{scaleNotes.map((n, i) => <span key={i} className="chip">{n}</span>)}</div>
        <Hint>Notes outside the key are shaded in the piano roll. Turn on “Stay in key” there and every note you draw lands on the scale.</Hint>
      </div>
      <div className="col">
        <span className="label">Chord to add: <b style={{ color: 'var(--text)' }}>{label}</b> <span className="num">({pitches.map((p) => NOTE_NAMES[p % 12]).join(' ')})</span></span>
        <div className="row wrap">
          <select className="select" aria-label="Chord root" value={root} onChange={(e) => choose(Number(e.target.value), quality)}>{NOTE_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}</select>
          <select className="select" aria-label="Chord type" value={quality} onChange={(e) => choose(root, e.target.value)}>{Object.entries(CHORDS).map(([id, c]) => <option key={id} value={id}>{c.name}</option>)}</select>
          <select className="select" aria-label="Inversion" value={inversion} onChange={(e) => setInversion(Number(e.target.value))}>
            <option value={0}>Root position</option><option value={1}>1st inversion</option><option value={2}>2nd inversion</option>
          </select>
          <select className="select" aria-label="Octave" value={octave} onChange={(e) => setOctave(Number(e.target.value))}>{[2, 3, 4, 5].map((o) => <option key={o} value={o}>Octave {o}</option>)}</select>
        </div>
        <div className="row wrap">
          <select className="select" aria-label="Chord length" value={length} onChange={(e) => setLength(Number(e.target.value))}>
            <option value={1}>1 beat</option><option value={2}>2 beats</option><option value={barBeats(timeSig)}>1 bar</option><option value={barBeats(timeSig) * 2}>2 bars</option>
          </select>
          <select className="select" aria-label="Chord style" value={style} onChange={(e) => setStyle(e.target.value as Style)}>
            <option value="block">Block chord</option><option value="up">Arpeggio up</option><option value="down">Arpeggio down</option><option value="updown">Arpeggio up and down</option>
          </select>
          {style !== 'block' && (
            <select className="select" aria-label="Arpeggio rate" value={rate} onChange={(e) => setRate(Number(e.target.value))}>
              <option value={1}>1/4 notes</option><option value={0.5}>1/8 notes</option><option value={0.25}>1/16 notes</option>
            </select>
          )}
          <button className="btn" onClick={() => audition(pitches)}>Hear it</button>
          <button className="btn primary" onClick={insert}><Plus />Add at playhead</button>
        </div>
        <Hint>Each chord is added where the playhead is, then the playhead moves on, so you can click out a whole progression.</Hint>
      </div>
    </div>
  );
}
