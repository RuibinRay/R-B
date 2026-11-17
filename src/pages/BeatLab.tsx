import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Download, FlaskConical, LoaderCircle, Play, RefreshCw, Square, ThumbsDown, ThumbsUp, Wand2 } from 'lucide-react';
import { engine, type SeqHandle } from '../audio/engine';
import { renderProject } from '../audio/render';
import { compose, toProject, type Length } from '../lib/beatmaker/compose';
import type { Candidate, GenreMemory } from '../lib/beatmaker/learn';
import { bestPairs, lessons, rate } from '../lib/beatmaker/learn';
import { FAMILY_NAMES, GENRES, GENRE_LIST, type Family, type GenreId, type Role } from '../lib/beatmaker/knowledge';
import { TRAINED_AT, forgetLocal, loadMemory, runLab, saveMemory, shippedMemory, type LabJob } from '../lib/beatmaker/lab';
import * as db from '../lib/db';
import { getInstrument } from '../lib/instruments';
import { NOTE_NAMES, SCALES, formatTime } from '../lib/music';
import { downloadBlob, encodeWav, safeName, toPcm } from '../lib/wav';
import { applyGain, limitPeaks } from '../lib/loudness';
import { listen, type Hearing } from '../lib/beatmaker/listen';
import { A, navigate, toast } from '../store/store';
import { Hint } from '../components/ui';

const ROLE_NAMES: Record<Role, string> = { drums: 'Drums', bass: 'Bass', chords: 'Chords', lead: 'Melody', pad: 'Pad', arp: 'Arpeggio', texture: 'Texture' };
const instName = (id?: string) => (id ? getInstrument(id)?.name ?? id : '—');
const pct = (v: number) => `${Math.round(v * 100)}`;

interface Result { candidate: Candidate; name: string; rating?: 1 | -1; audio?: AudioBuffer; rendering?: boolean; heard?: Hearing }

function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values), hi = Math.max(...values);
  const W = 220, H = 44;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - 4 - ((v - lo) / Math.max(0.001, hi - lo)) * (H - 8)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke="var(--cyan)" strokeWidth="1.75" strokeLinejoin="round" />
    </svg>
  );
}

function Lessons({ genre, mem }: { genre: GenreId; mem: GenreMemory }) {
  const g = GENRES[genre];
  const ls = lessons(genre, mem, 6).filter((l) => l.best.length > 1);
  const pairs = bestPairs(mem, 4, 6);
  const hist = mem.history;
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 18, alignItems: 'flex-end' }}>
        <div className="col" style={{ gap: 2 }}>
          <span className="label">Beats tried for {g.name}</span>
          <b className="num" style={{ fontSize: 22 }}>{mem.evaluated.toLocaleString()}</b>
        </div>
        {hist.length > 1 && (
          <div className="col" style={{ gap: 2 }}>
            <span className="label">Average score of each round's first attempts</span>
            <Sparkline values={hist.map((h) => h.firstMean)} label="Score of the first attempts in each training round" />
            <span className="faint num" style={{ fontSize: 12 }}>{pct(hist[0].firstMean)} → {pct(hist[hist.length - 1].firstMean)} over {hist.length} rounds</span>
          </div>
        )}
      </div>
      {ls.length ? (
        <div className="lab-lessons">
          {ls.map((l) => (
            <div key={l.role} className="lab-lesson">
              <span className="label">{ROLE_NAMES[l.role]}</span>
              {l.best.slice(0, 3).map((b, i) => (
                <span key={b.id} className={`lab-pick ${i === 0 ? 'top' : ''}`} title={`${b.n} experiments`}>
                  {instName(b.id)} <span className="num">{b.mean >= 0 ? '+' : ''}{(b.mean * 100).toFixed(1)}</span>
                </span>
              ))}
            </div>
          ))}
        </div>
      ) : <p className="hint">Nothing measured yet for this style. Generate or train and the results of its experiments will appear here.</p>}
      {pairs.length > 0 && (
        <div className="col" style={{ gap: 4 }}>
          <span className="label">Combinations that measured best</span>
          {pairs.map((p) => (
            <span key={p.pair} style={{ fontSize: 13 }}>
              {p.pair.split('|').map((x) => { const [role, id] = x.split(':'); return `${instName(id)} (${ROLE_NAMES[role as Role].toLowerCase()})`; }).join(' + ')}
              <span className="faint num"> {p.mean >= 0 ? '+' : ''}{(p.mean * 100).toFixed(1)}</span>
            </span>
          ))}
        </div>
      )}
      <p className="hint">Numbers are how many points (out of 100) a choice gained or lost against the alternatives, measured by swapping only that choice in otherwise identical beats. Numbers near zero mean the critics could not hear a clear difference.</p>
    </div>
  );
}

export function BeatLab() {
  const [family, setFamily] = useState<Family>('rap');
  const [genre, setGenre] = useState<GenreId>('trap');
  const [length, setLength] = useState<Length>('loop');
  const [effort, setEffort] = useState<'quick' | 'careful'>('quick');
  const [bpm, setBpm] = useState('');
  const [keyRoot, setKeyRoot] = useState<string>('');
  const [mem, setMem] = useState<GenreMemory>(() => loadMemory('trap'));
  const [busy, setBusy] = useState<{ text: string; progress: number; best: number } | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);
  const job = useRef<LabJob | null>(null);
  const handle = useRef<SeqHandle | null>(null);

  useEffect(() => { setMem(loadMemory(genre)); }, [genre]);
  useEffect(() => () => { job.current?.cancel(); handle.current?.stop(); }, []);
  const g = GENRES[genre];
  const genres = useMemo(() => GENRE_LIST.filter((x) => x.family === family), [family]);

  const stopPlay = () => { handle.current?.stop(); handle.current = null; setPlaying(null); };

  const start = async (opts: { train?: boolean; like?: Candidate } = {}) => {
    stopPlay();
    job.current?.cancel();
    const rounds = opts.train ? 2 : effort === 'careful' ? 2 : 1;
    const generations = opts.train ? 24 : effort === 'careful' ? 24 : 10;
    const len: Length = opts.train ? 'loop' : length;
    const fixBpm = Number(bpm);
    setBusy({ text: opts.train ? 'Training…' : 'Trying ideas…', progress: 0, best: 0 });
    const total = 3 * rounds * generations;
    const req = {
      genre, memory: JSON.parse(JSON.stringify(mem)) as GenreMemory, length: len, population: 32, generations, rounds,
      seed: Math.floor(Math.random() * 1e9), tasteWeight: 0.15, seedGenome: opts.like?.genome,
      fix: { ...(fixBpm >= 40 && fixBpm <= 240 ? { bpm: Math.round(fixBpm) } : {}), ...(keyRoot !== '' ? { root: Number(keyRoot) } : {}) },
    };
    const j = runLab(req, (m) => setBusy({ text: opts.train ? `Training round ${m.round + 1} of ${3 * rounds}` : `Generation ${m.round * generations + m.gen + 1} of ${total}`, progress: (m.round * generations + m.gen + 1) / total, best: m.best }));
    job.current = j;
    try {
      const { candidates, memory } = await j.result;
      setMem(memory);
      saveMemory(genre, memory);
      if (!opts.train) {
        setResults(candidates.map((c, i) => ({ candidate: c, name: nameOf(c, i) })));
        setOpen(0);
      } else toast(`Trained for ${3 * rounds} more rounds. Ideas for ${g.name} now start from what that taught it.`, 'success');
    } catch (e) {
      if (e instanceof Error && e.message !== 'cancelled') toast(e.message, 'error');
    } finally {
      if (job.current === j) { job.current = null; setBusy(null); }
    }
  };

  const nameOf = (c: Candidate, i: number) => `${GENRES[c.genome.genre].name} idea ${String.fromCharCode(65 + i)}`;

  const render = async (i: number): Promise<AudioBuffer | null> => {
    const r = results[i];
    if (r.audio) return r.audio;
    setResults((rs) => rs.map((x, k) => (k === i ? { ...x, rendering: true } : x)));
    try {
      const p = toProject(compose(r.candidate.genome, length), r.name);
      const audio = await renderProject(p, engine.buffers);
      const heard = listen(audio, r.candidate.genome.genre);
      // bring the preview and the WAV to a normal listening level (-14 LUFS, like streaming services), never clipping
      if (Number.isFinite(heard.lufs)) applyGain(toPcm(audio), Math.min(18, -14 - heard.lufs));
      limitPeaks(toPcm(audio), -1);
      setResults((rs) => rs.map((x, k) => (k === i ? { ...x, audio, heard, rendering: false } : x)));
      return audio;
    } catch (e) {
      setResults((rs) => rs.map((x, k) => (k === i ? { ...x, rendering: false } : x)));
      toast(e instanceof Error ? e.message : 'The beat could not be mixed.', 'error');
      return null;
    }
  };

  const play = async (i: number) => {
    if (playing === i) { stopPlay(); return; }
    stopPlay();
    const audio = await render(i);
    if (!audio) return;
    A.stop();
    const h = await engine.playSequence([], { buffer: audio, gain: 1 }, 0, () => { if (handle.current === h) { handle.current = null; setPlaying(null); } });
    handle.current = h;
    setPlaying(i);
  };

  const onRate = (i: number, value: 1 | -1) => {
    const r = results[i];
    const next = JSON.parse(JSON.stringify(mem)) as GenreMemory;
    rate(next, r.candidate.genome, value);
    setMem(next);
    saveMemory(genre, next);
    setResults((rs) => rs.map((x, k) => (k === i ? { ...x, rating: value } : x)));
  };

  const openInStudio = async (i: number) => {
    stopPlay();
    const r = results[i];
    const p = toProject(compose(r.candidate.genome, length), r.name);
    await db.putProject(p);
    await A.openProject(p.id);
    toast(`“${r.name}” is a new project: every part is a normal track you can edit.`, 'success');
    navigate('studio');
  };

  const download = async (i: number) => {
    const audio = await render(i);
    if (audio) downloadBlob(encodeWav(toPcm(audio), 16), `${safeName(results[i].name)}.wav`);
  };

  const reset = () => {
    forgetLocal(genre);
    setMem(shippedMemory(genre));
    toast(`This browser's training and ratings for ${g.name} were cleared.`, 'info');
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div className="grow">
            <h1 className="title">AI Beat Lab</h1>
            <p className="sub">Pick a style and it writes beats for you: it tries hundreds of ideas, judges each one the way a producer would, and keeps improving the best. Rate what you hear and it learns your taste.</p>
          </div>
        </div>

        <div className="cols-2">
          <section className="panel pad col" style={{ gap: 14 }} aria-label="What to make">
            <h2 className="section-title">1. What to make</h2>
            <div className="seg" role="group" aria-label="Kind of music" style={{ alignSelf: 'flex-start', flexWrap: 'wrap' }}>
              {(Object.keys(FAMILY_NAMES) as Family[]).map((f) => (
                <button key={f} className={family === f ? 'on' : ''} onClick={() => { setFamily(f); const first = GENRE_LIST.find((x) => x.family === f)!; setGenre(first.id); setResults([]); }}>{FAMILY_NAMES[f]}</button>
              ))}
            </div>
            <div className="lab-genres" role="radiogroup" aria-label="Style">
              {genres.map((x) => (
                <button key={x.id} role="radio" aria-checked={genre === x.id} className={`voice-mode ${genre === x.id ? 'on' : ''}`} onClick={() => { setGenre(x.id); setResults([]); }}>
                  <span className="name">{x.name} <span className="faint num" style={{ fontWeight: 400 }}>{x.bpm[0]}-{x.bpm[1]} BPM</span></span>
                  <span className="meta">{x.hint}</span>
                </button>
              ))}
            </div>
            <div className="row wrap" style={{ gap: 14 }}>
              <label className="t-field">Length
                <select className="select" value={length} onChange={(e) => setLength(e.target.value as Length)}>
                  <option value="loop">8-bar loop</option>
                  <option value="song">Full song with sections</option>
                </select>
              </label>
              <label className="t-field">Tempo
                <input className="input t-num num" inputMode="numeric" placeholder="auto" aria-label="Tempo (leave empty to let it choose)" value={bpm} onChange={(e) => setBpm(e.target.value.replace(/[^0-9]/g, ''))} />
              </label>
              <label className="t-field">Key
                <select className="select" value={keyRoot} onChange={(e) => setKeyRoot(e.target.value)}>
                  <option value="">Any</option>
                  {NOTE_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}
                </select>
              </label>
              <label className="t-field">Search
                <select className="select" value={effort} onChange={(e) => setEffort(e.target.value as 'quick' | 'careful')}>
                  <option value="quick">Quick (about 1,000 ideas)</option>
                  <option value="careful">Careful (about 5,000 ideas)</option>
                </select>
              </label>
            </div>
            {busy ? (
              <div className="col" role="status" style={{ gap: 6 }}>
                <div className="row"><LoaderCircle className="spin" style={{ width: 16, height: 16 }} /><span className="grow">{busy.text}</span>
                  {busy.best > 0 && <span className="num faint">best so far {pct(busy.best)}</span>}
                  <button className="btn sm ghost" onClick={() => { job.current?.cancel(); job.current = null; setBusy(null); }}>Cancel</button></div>
                <div className="progress"><i style={{ width: `${Math.round(busy.progress * 100)}%` }} /></div>
              </div>
            ) : (
              <div className="row wrap">
                <button className="btn lg primary" onClick={() => void start()}><Wand2 />Make {g.name} beats</button>
              </div>
            )}
          </section>

          <section className="panel pad col" style={{ gap: 12 }} aria-label="What it has learned">
            <div className="row"><h2 className="section-title grow">What it has learned</h2>
              <button className="btn sm" disabled={!!busy} onClick={() => void start({ train: true })} title="Six more training rounds for this style, in this browser (about 4,000 beats)"><FlaskConical />Train more</button>
            </div>
            <Lessons genre={genre} mem={mem} />
            <div className="row wrap" style={{ gap: 8 }}>
              <span className="faint" style={{ fontSize: 12 }}>{TRAINED_AT ? `Shipped training: ${new Date(TRAINED_AT).toLocaleDateString()}. ` : ''}Training and ratings you add stay in this browser.</span>
              <button className="btn sm ghost" onClick={reset}>Reset this style</button>
            </div>
          </section>
        </div>

        {results.length > 0 && (
          <section className="panel" aria-label="Results">
            <div className="row" style={{ padding: '14px 16px 6px' }}><h2 className="section-title grow">2. Listen, rate and keep</h2>
              <button className="btn sm" disabled={!!busy} onClick={() => void start()}><RefreshCw />Try again</button></div>
            {results.map((r, i) => {
              const c = r.candidate, gn = c.genome;
              const sc = SCALES[gn.scale]?.name ?? gn.scale;
              const comp = compose(gn, length);
              const secs = (comp.lengthBars * 4 * 60) / gn.bpm;
              return (
                <div key={i} className="lab-result">
                  <div className="lab-result-head">
                    <button className="play-btn" aria-label={playing === i ? `Stop ${r.name}` : `Play ${r.name}`} onClick={() => void play(i)} disabled={r.rendering}>
                      {r.rendering ? <LoaderCircle className="spin" /> : playing === i ? <Square fill="currentColor" /> : <Play fill="currentColor" style={{ marginLeft: 2 }} />}
                    </button>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="row" style={{ gap: 8 }}><b>{r.name}</b><span className="chip" title="How well it does on the critics' craft checks; not a measure of how good it feels">craft {pct(c.review.total)}</span></div>
                      <span className="faint num" style={{ fontSize: 12 }}>{gn.bpm} BPM · {NOTE_NAMES[gn.root]} {sc.toLowerCase()} · {formatTime(secs, false)} · {comp.parts.map((p) => instName(p.instrumentId)).join(', ')}</span>
                    </div>
                    <div className="row wrap" style={{ gap: 4 }}>
                      <button className={`icon-btn ${r.rating === 1 ? 'on' : ''}`} aria-pressed={r.rating === 1} aria-label="I like this" title="I like this: use more of what it is made of" onClick={() => onRate(i, 1)}><ThumbsUp /></button>
                      <button className={`icon-btn ${r.rating === -1 ? 'on' : ''}`} aria-pressed={r.rating === -1} aria-label="Not for me" title="Not for me: use less of what it is made of" onClick={() => onRate(i, -1)}><ThumbsDown /></button>
                      <button className="btn sm" disabled={!!busy} onClick={() => void start({ like: c })} title="Breed new beats from this one">More like this</button>
                      <button className="btn sm" onClick={() => void download(i)}><Download />WAV</button>
                      <button className="btn sm primary" onClick={() => void openInStudio(i)}>Open in studio</button>
                      <button className="icon-btn" aria-expanded={open === i} aria-label="Why it scored this" onClick={() => setOpen(open === i ? null : i)}><ChevronDown style={{ transform: open === i ? 'rotate(180deg)' : undefined }} /></button>
                    </div>
                  </div>
                  {open === i && (
                    <div className="lab-why">
                      {c.review.verdicts.map((v) => (
                        <div key={v.id} className="lab-verdict">
                          <span>{v.name}</span>
                          <div className="lab-bar" aria-hidden><i style={{ width: `${Math.round(v.score * 100)}%` }} className={v.score < 0.6 ? 'low' : ''} /></div>
                          <span className="num">{pct(v.score)}</span>
                          <span className="faint">{v.note}</span>
                        </div>
                      ))}
                      <div className="lab-verdict">
                        <span>Heard in the real audio</span>
                        {r.heard ? (
                          <>
                            <div className="lab-bar" aria-hidden><i style={{ width: `${Math.round(r.heard.spectrumMatch * 100)}%` }} className={r.heard.spectrumMatch < 0.6 ? 'low' : ''} /></div>
                            <span className="num">{pct(r.heard.spectrumMatch)}</span>
                            <span className="faint">{r.heard.worst}; mixed at {r.heard.lufs.toFixed(1)} LUFS (played and saved at -14)</span>
                          </>
                        ) : <span className="faint" style={{ gridColumn: '2 / -1' }}>press play: the rendered audio is then measured too</span>}
                      </div>
                      <div className="lab-parts">
                        {comp.parts.map((p) => <span key={p.role} className="chip">{ROLE_NAMES[p.role]}: {instName(p.instrumentId)}</span>)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            <Hint>Play renders the beat exactly as it will sound in the studio, with its effects. A thumbs-up or thumbs-down changes which instruments and patterns it reaches for next time in this style.</Hint>
          </section>
        )}

        <section className="panel pad col" style={{ gap: 8 }} aria-label="How it works">
          <h2 className="section-title">How it works, honestly</h2>
          <p className="hint" style={{ color: 'var(--muted)' }}>
            This is not a neural network trained on recordings. It writes beats from what producers teach about each style (tempo, drum placement, swing, typical instruments, song structure),
            judges every attempt with fifteen critics (tempo, groove, drum dynamics, kick and bass, harmony, clashing notes, melody shape, catchy hook, repetition, frequency balance, room for every part, mix balance, register, arrangement, transitions)
            that use measurements of how each of the app's instruments really sounds, and keeps the best. It learns by experiment: it swaps one choice at a time in its best beats and records which options scored better. It also listens: it has rendered the parts of 132 of its own beats, compared what it heard with what it had predicted and corrected itself, and it measures the real audio of every beat you play.
            The critics check craft, not feeling; whether a beat moves you is for you to decide, and your ratings are how it learns that.
          </p>
        </section>
      </div>
    </div>
  );
}
