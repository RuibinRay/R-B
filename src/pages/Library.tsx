import { useMemo, useState } from 'react';
import { LoaderCircle, Play, Plus, Search } from 'lucide-react';
import { engine } from '../audio/engine';
import { CATEGORIES, DRUM_SOUNDS, INSTRUMENTS, kitPads, searchInstruments, type Category, type InstrumentDef } from '../lib/instruments';
import { midiToName } from '../lib/music';
import { A, navigate, useStore } from '../store/store';
import { auditionPitch, rangeLabel } from '../components/InstrumentBrowser';
import { Keyboard } from '../components/Keys';

const kind = (d: InstrumentDef): string => (d.engine === 'sample' ? 'Sampled' : d.engine === 'synth' ? 'Synthesizer' : d.engine === 'model' ? 'Modeled' : 'Drum kit');

/** A short phrase across the instrument's range so its character is clear. */
async function demo(d: InstrumentDef): Promise<void> {
  await engine.resume();
  if (d.engine === 'drums') {
    const pads = kitPads(d.id);
    const pattern = [pads[0], pads[4], pads[1], pads[4], pads[0], pads[0], pads[1], pads[5]];
    pattern.forEach((p, i) => window.setTimeout(() => void engine.previewNote(d.id, p, 0.3, 0.9), i * 170));
    return;
  }
  const root = auditionPitch(d);
  const steps = [0, 4, 7, 12, 7, 4, 0].map((s) => root + s).filter((m) => m <= d.range[1]);
  steps.forEach((m, i) => window.setTimeout(() => void engine.previewNote(d.id, m, i === steps.length - 1 ? 1.4 : 0.34, 0.8), i * 260));
}

export function Library() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category | 'all'>('all');
  const [selectedId, setSelectedId] = useState('violin');
  const status = useStore((s) => s.instrumentStatus);
  const results = useMemo(() => searchInstruments(query, category), [query, category]);
  const selected = INSTRUMENTS.find((i) => i.id === selectedId);

  const add = (d: InstrumentDef) => {
    const id = A.addTrack('instrument', d.id);
    A.addMidiClip(id, 0);
    navigate('composer');
  };

  return (
    <div className="page" style={{ paddingBottom: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="page-inner" style={{ flex: 1, minHeight: 0, width: '100%' }}>
        <div className="page-head">
          <div className="grow">
            <h1 className="title">Instrument library</h1>
            <p className="sub">{INSTRUMENTS.length} instruments, each limited to its real playable range. Select one to try it on the keyboard, or add it to your song.</p>
          </div>
          <div className="search" style={{ width: 260 }}>
            <Search />
            <input className="input" type="search" placeholder="Search by name or family" aria-label="Search instruments" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>
        <div className="row wrap" role="group" aria-label="Category" style={{ gap: 4 }}>
          {[{ id: 'all' as const, name: 'All' }, ...CATEGORIES].map((c) => (
            <button key={c.id} className={`tab ${category === c.id ? 'on' : ''}`} onClick={() => setCategory(c.id)}>{c.name}</button>
          ))}
        </div>

        <section className="panel pad" aria-label="Instruments" style={{ paddingTop: 8 }}>
          {results.length === 0 ? (
            <div className="empty" style={{ marginTop: 10 }}>No instrument matches “{query}”. Try a family such as strings, brass or world.</div>
          ) : (
            <table className="table">
              <thead><tr><th>Instrument</th><th className="desktop-only">Family</th><th className="desktop-only">Sound source</th><th>Range</th><th /></tr></thead>
              <tbody>
                {results.map((d) => (
                  <tr key={d.id} className={d.id === selectedId ? 'sel' : ''} onClick={() => { setSelectedId(d.id); void engine.previewNote(d.id, auditionPitch(d), 0.9); }} style={{ cursor: 'pointer' }}>
                    <td style={{ paddingLeft: 10 }}>
                      <div style={{ fontWeight: 500 }}>{d.name}</div>
                      <div className="faint" style={{ fontSize: 12, lineHeight: '16px' }}>{d.approx ?? d.desc}</div>
                    </td>
                    <td className="muted desktop-only">{CATEGORIES.find((c) => c.id === d.category)?.name}</td>
                    <td className="muted desktop-only">{kind(d)}{status[d.id] === 'fallback' ? ' (offline stand-in)' : ''}</td>
                    <td className="num muted" style={{ whiteSpace: 'nowrap' }}>{d.engine === 'drums' ? `${kitPads(d.id).length} pads` : rangeLabel(d)}</td>
                    <td className="right" style={{ whiteSpace: 'nowrap' }}>
                      <button className="icon-btn" title={`Hear ${d.name}`} aria-label={`Hear ${d.name}`} onClick={(e) => { e.stopPropagation(); setSelectedId(d.id); void demo(d); }}>
                        {status[d.id] === 'loading' ? <LoaderCircle className="spin" /> : <Play />}
                      </button>
                      <button className="btn sm" onClick={(e) => { e.stopPropagation(); add(d); }}><Plus />Add to song</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="hint" style={{ marginTop: 14 }}>
            Sampled instruments use the FluidR3 GM sound set by Frank Wen (CC BY 3.0), pre-rendered by the midi-js-soundfonts project. Synthesizers, drum kits and modeled instruments are generated in your browser and work offline.
          </p>
        </section>
      </div>
      {selected && (
        <div style={{ position: 'sticky', bottom: 0, margin: '16px -28px 0', background: 'var(--ground)', borderTop: '1px solid var(--rule)' }}>
          <div style={{ maxWidth: 1180, margin: '0 auto' }}>
            <Keyboard previewId={selected.id} />
            {selected.engine === 'drums' && <p className="faint" style={{ fontSize: 12, padding: '0 12px 10px' }}>Sounds: {DRUM_SOUNDS.filter((s) => kitPads(selected.id).includes(s.midi)).map((s) => s.name).join(', ')}</p>}
            {selected.engine !== 'drums' && <p className="faint sr-only">Range {midiToName(selected.range[0])} to {midiToName(selected.range[1])}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
