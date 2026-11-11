import { useMemo, useState } from 'react';
import { LoaderCircle, Plus, Search, X } from 'lucide-react';
import { engine } from '../audio/engine';
import { CATEGORIES, searchInstruments, type Category, type InstrumentDef } from '../lib/instruments';
import { clamp, midiToName } from '../lib/music';
import { A, selectedTrack, useStore } from '../store/store';

export const rangeLabel = (d: InstrumentDef): string => (d.engine === 'drums' ? 'Kit' : `${midiToName(d.range[0])}–${midiToName(d.range[1])}`);

/** A representative note for auditioning an instrument: middle C if it can play it, else mid-range. */
export const auditionPitch = (d: InstrumentDef): number => (d.engine === 'drums' ? 36 : clamp(60, d.range[0], d.range[1]) === 60 ? 60 : Math.round((d.range[0] + d.range[1]) / 2));

export function InstrumentBrowser({ open, onClose }: { open?: boolean; onClose?: () => void }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category | 'all'>('all');
  const track = useStore(selectedTrack);
  const status = useStore((s) => s.instrumentStatus);
  const results = useMemo(() => searchInstruments(query, category), [query, category]);
  const groups = CATEGORIES.map((c) => ({ ...c, items: results.filter((i) => i.category === c.id) })).filter((g) => g.items.length);
  const canAssign = track?.kind === 'instrument';

  const pick = (d: InstrumentDef) => {
    if (canAssign && track) A.setInstrument(track.id, d.id);
    void engine.previewNote(d.id, auditionPitch(d), 0.9);
  };
  const add = (d: InstrumentDef) => {
    const id = A.addTrack('instrument', d.id);
    A.addMidiClip(id, 0);
    void engine.previewNote(d.id, auditionPitch(d), 0.9);
    onClose?.();
  };

  return (
    <aside className={`browser ${open ? 'open' : ''}`} aria-label="Instrument library">
      <div className="browser-head">
        {open && (
          <div className="row">
            <span className="grow" style={{ fontWeight: 600 }}>Instruments</span>
            <button className="icon-btn" aria-label="Close instrument library" onClick={onClose}><X /></button>
          </div>
        )}
        <div className="search">
          <Search />
          <input className="input" type="search" placeholder="Search instruments" aria-label="Search instruments" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <select className="select" aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value as Category | 'all')}>
          <option value="all">All categories</option>
          {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div className="browser-list">
        {groups.length === 0 && <p className="hint" style={{ padding: 10 }}>No instrument matches “{query}”.</p>}
        {groups.map((g) => (
          <div key={g.id}>
            <div className="browser-cat">{g.name}</div>
            {g.items.map((d) => (
              <div key={d.id} className={`inst ${canAssign && track?.instrumentId === d.id ? 'active' : ''}`}>
                <button
                  className="grow" style={{ all: 'unset', flex: 1, minWidth: 0, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: '30px' }}
                  title={canAssign ? `Use ${d.name} on “${track?.name}”` : `Preview ${d.name}`} onClick={() => pick(d)}
                >{d.name}</button>
                {status[d.id] === 'loading' ? <LoaderCircle className="spin" style={{ width: 13, height: 13 }} /> : <span className="range num">{rangeLabel(d)}</span>}
                <button className="icon-btn sm add" title={`Add a ${d.name} track`} aria-label={`Add a ${d.name} track`} onClick={() => add(d)}><Plus /></button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
