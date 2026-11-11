import { useEffect, useState } from 'react';
import { Circle, PanelLeft, Plus } from 'lucide-react';
import type { MidiClip } from '../types';
import { barBeats, clipEnd, formatBars } from '../lib/music';
import { trackSound } from '../lib/templates';
import { A, selectedTrack, setUI, useStore } from '../store/store';
import { ChordPanel } from '../components/ChordPanel';
import { ClipEditor } from '../components/ClipEditor';
import { InstrumentBrowser } from '../components/InstrumentBrowser';
import { Keyboard } from '../components/Keys';
import { TransportBar } from '../components/TransportBar';
import { SnapSelect } from './Studio';

// The composer: pick an instrument, write notes in the piano roll or step grid,
// and play along on the keyboard. It edits the same project as the studio.

export function Composer() {
  const tracks = useStore((s) => s.project.tracks);
  const clips = useStore((s) => s.project.clips);
  const bpm = useStore((s) => s.project.bpm);
  const timeSig = useStore((s) => s.project.timeSig);
  const track = useStore(selectedTrack);
  const editClipId = useStore((s) => s.ui.editClipId);
  const midiRecord = useStore((s) => s.ui.midiRecord);
  const browserOpen = useStore((s) => s.ui.browserOpen);
  const playing = useStore((s) => s.playing);
  const [tab, setTab] = useState<'keys' | 'chords'>('keys');
  const instruments = tracks.filter((t) => t.kind === 'instrument');
  const trackClips = clips.filter((c): c is MidiClip => c.type === 'midi' && c.trackId === track?.id).sort((a, b) => a.start - b.start);

  // Always have an instrument track selected and one of its clips open.
  useEffect(() => {
    if (!track || track.kind !== 'instrument') {
      const first = instruments[0];
      if (first) A.selectTrack(first.id);
      return;
    }
    A.ensureEditClip();
  }, [track?.id, track?.kind, instruments.length, editClipId]); // eslint-disable-line react-hooks/exhaustive-deps

  const newClip = () => {
    if (!track) return;
    const bar = barBeats(timeSig);
    const end = trackClips.length ? Math.max(...trackClips.map((c) => clipEnd(c, bpm))) : 0;
    const id = A.addMidiClip(track.id, Math.ceil(end / bar) * bar);
    setUI({ editClipId: id });
    A.seek(Math.ceil(end / bar) * bar);
  };

  return (
    <>
      <TransportBar />
      <div className="workspace">
        <InstrumentBrowser open={browserOpen && window.innerWidth < 860} onClose={() => setUI({ browserOpen: false })} />
        <div className="stage">
          <div className="toolbar" role="toolbar" aria-label="Composer tools">
            <button className="icon-btn" style={{ display: window.innerWidth < 860 ? 'inline-flex' : 'none' }} aria-label="Instrument library" onClick={() => setUI({ browserOpen: !browserOpen })}><PanelLeft /></button>
            <label className="t-field">
              Track
              <select className="select" aria-label="Instrument track" value={track?.id ?? ''} onChange={(e) => A.selectTrack(e.target.value)} style={{ maxWidth: 220 }}>
                {instruments.length === 0 && <option value="">No instrument tracks</option>}
                {instruments.map((t) => <option key={t.id} value={t.id}>{t.name}{t.name !== trackSound(t) ? ` (${trackSound(t)})` : ''}</option>)}
              </select>
            </label>
            <button className="btn sm" title="Add another instrument track" onClick={() => { const id = A.addTrack('instrument', 'grand-piano'); A.addMidiClip(id, 0); }}><Plus />Track</button>
            <div className="t-div" />
            <label className="t-field">
              Clip
              <select className="select num" aria-label="Clip to edit" value={editClipId ?? ''} onChange={(e) => { setUI({ editClipId: e.target.value }); const c = clips.find((x) => x.id === e.target.value); if (c) A.seek(c.start); }}>
                {trackClips.map((c) => <option key={c.id} value={c.id}>Bar {formatBars(c.start, timeSig).split('.')[0]} · {c.notes.length} notes</option>)}
              </select>
            </label>
            <button className="btn sm" title="Add an empty clip after the last one on this track" disabled={!track} onClick={newClip}><Plus />Clip</button>
            <SnapSelect />
            <div className="grow" />
            <button
              className={`btn sm ${midiRecord ? 'danger' : ''}`} aria-pressed={midiRecord}
              title="When on, notes you play on the keyboard while the song is playing are written into the clip"
              onClick={() => setUI({ midiRecord: !midiRecord })}
            ><Circle fill={midiRecord ? 'currentColor' : 'none'} />{midiRecord ? (playing ? 'Recording notes' : 'Press play to record notes') : 'Record what I play'}</button>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            {instruments.length === 0
              ? <div style={{ padding: 20 }}><div className="empty">This project has no instrument tracks. Pick an instrument on the left and press its + button to add one.</div></div>
              : <ClipEditor notesOnly emptyText="Pick an instrument track above to start writing notes." />}
          </div>
          <div className="dock" style={{ height: tab === 'chords' ? 236 : 196 }}>
            <div className="dock-tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'keys'} className={`tab ${tab === 'keys' ? 'on' : ''}`} onClick={() => setTab('keys')}>Keyboard and pads</button>
              <button role="tab" aria-selected={tab === 'chords'} className={`tab ${tab === 'chords' ? 'on' : ''}`} onClick={() => setTab('chords')}>Chords and scale</button>
            </div>
            <div className="dock-body">
              {tab === 'keys' ? <Keyboard /> : <ChordPanel />}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
