import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Play, Square } from 'lucide-react';
import { engine } from '../audio/engine';
import { listProjects, type ProjectSummary } from '../lib/db';
import { INSTRUMENTS } from '../lib/instruments';
import { NOTE_NAMES, SCALES, barBeats, beatsToSec, clipLengthBeats, formatTime, projectEndBeats } from '../lib/music';
import { fitCanvas } from '../lib/peaks';
import { TEMPLATES } from '../lib/templates';
import { A, navigate, toast, useStore, type Page } from '../store/store';
import { useFrame, useSize } from '../components/ui';

const ago = (t: number): string => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

/** The arrangement of the open project, drawn from its real clips. Click to move the playhead. */
function Overview() {
  const project = useStore((s) => s.project);
  const [ref, size] = useSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const last = useRef(-1);
  const total = Math.max(barBeats(project.timeSig) * 4, projectEndBeats(project));
  useFrame(() => {
    const cv = canvas.current;
    if (!cv || size.w < 10) return;
    const beat = engine.beat;
    const W = size.w, H = 190;
    const key = beat + W * 1e6 + project.updatedAt + project.clips.length * 13 + project.tracks.length;
    if (key === last.current) return;
    last.current = key;
    const ctx = fitCanvas(cv, W, H);
    ctx.clearRect(0, 0, W, H);
    const rows = Math.max(4, project.tracks.length);
    const rh = (H - 16) / rows;
    project.tracks.forEach((t, i) => {
      const y = 8 + i * rh;
      ctx.fillStyle = '#121214';
      ctx.fillRect(12, y + 1, W - 24, rh - 3);
      for (const c of project.clips) {
        if (c.trackId !== t.id) continue;
        const x = 12 + (c.start / total) * (W - 24), w = Math.max(2, (clipLengthBeats(c, project.bpm) / total) * (W - 24));
        ctx.globalAlpha = t.mute ? 0.3 : 0.32;
        ctx.fillStyle = t.color;
        ctx.beginPath(); ctx.roundRect(x, y + 1, w - 1, rh - 3, 3); ctx.fill();
        ctx.globalAlpha = t.mute ? 0.4 : 1;
        if (c.type === 'midi' && c.notes.length) {
          let lo = 127, hi = 0;
          for (const n of c.notes) { if (n.pitch < lo) lo = n.pitch; if (n.pitch > hi) hi = n.pitch; }
          const span = Math.max(12, hi - lo);
          for (const n of c.notes) {
            if (n.start < 0 || n.start >= c.length) continue;
            ctx.fillRect(x + (n.start / c.length) * w, y + 3 + (1 - (n.pitch - lo) / span) * (rh - 9), Math.max(1.5, (n.duration / c.length) * w - 0.5), 2);
          }
        } else if (c.type === 'audio') {
          ctx.fillRect(x + 2, y + rh / 2 - 1, w - 5, 2);
        }
        ctx.globalAlpha = 1;
      }
    });
    const px = 12 + Math.min(1, beat / total) * (W - 24);
    ctx.fillStyle = '#fff';
    ctx.fillRect(Math.round(px), 4, 1, H - 8);
  });
  return (
    <div ref={ref}>
      <canvas
        ref={canvas} className="overview" role="img" aria-label="Arrangement overview of the open project. Click to move the playhead."
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); A.seek(Math.max(0, ((e.clientX - r.left - 12) / (r.width - 24)) * total)); }}
      />
    </div>
  );
}

const JOBS: { page: Page; name: string; desc: string }[] = [
  { page: 'composer', name: 'Compose with instruments', desc: `Pick from ${INSTRUMENTS.length} instruments and write notes in the piano roll or drum grid.` },
  { page: 'voice', name: 'Hum a melody', desc: 'Sing or tap an idea and turn it into notes for a violin, piano or synth.' },
  { page: 'stems', name: 'Separate a song into stems', desc: 'Split a track into vocals, drums, bass and more, then remix them.' },
  { page: 'studio', name: 'Record and arrange', desc: 'Record vocals, edit clips on the timeline, mix and master.' },
  { page: 'library', name: 'Browse the instruments', desc: 'Hear every instrument and try it on the keyboard.' },
];

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play or stop'],
  ['R', 'Record from the microphone'],
  ['S', 'Split the clip at the playhead'],
  ['L', 'Loop the marked region'],
  ['Ctrl/Cmd + Z', 'Undo'],
  ['Ctrl/Cmd + scroll', 'Zoom the timeline'],
];

export function Home() {
  const project = useStore((s) => s.project);
  const playing = useStore((s) => s.playing);
  const saveState = useStore((s) => s.saveState);
  const [recent, setRecent] = useState<ProjectSummary[]>([]);
  useEffect(() => { listProjects().then(setRecent, () => setRecent([])); }, [project.id, saveState]);
  const length = beatsToSec(projectEndBeats(project), project.bpm);
  const others = recent.filter((r) => r.id !== project.id).slice(0, 5);

  const useTemplate = async (id: string) => {
    await A.newProject(id);
    toast('Template opened. Press play to hear it.', 'success');
    navigate('studio');
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div className="grow">
            <h1 className="title">Home</h1>
            <p className="sub">Make a song in your browser: play instruments, hum a tune into notes, pull a track apart, record, mix and export.</p>
          </div>
          <button className="btn primary lg" onClick={() => navigate('studio')}>Open the studio<ArrowRight /></button>
        </div>

        <div className="split">
          <section className="panel pad col" style={{ gap: 14 }} aria-label="Current project">
            <div className="row">
              <button className="play-btn" aria-label={playing ? 'Stop' : 'Play the open project'} onClick={A.toggle}>
                {playing ? <Square fill="currentColor" /> : <Play fill="currentColor" style={{ marginLeft: 2 }} />}
              </button>
              <div className="grow">
                <h2 className="section-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</h2>
                <span className="faint" style={{ fontSize: 12 }}>Open project · {saveState === 'saving' ? 'saving…' : saveState === 'error' ? 'not saved' : `saved ${ago(project.updatedAt)}`}</span>
              </div>
              <button className="btn" onClick={() => navigate('composer')}>Edit notes</button>
            </div>
            <Overview />
            <div className="stat-strip">
              <div><b className="num">{project.bpm}</b><span>beats per minute</span></div>
              <div><b>{NOTE_NAMES[project.key.root]} {SCALES[project.key.scale].name.toLowerCase()}</b><span>key</span></div>
              <div><b className="num">{project.tracks.length}</b><span>track{project.tracks.length === 1 ? '' : 's'}</span></div>
              <div><b className="num">{formatTime(length, false)}</b><span>of 5:00 used</span></div>
            </div>
          </section>

          <section className="panel pad" aria-label="Start something">
            <h2 className="section-title" style={{ marginBottom: 6 }}>Start something</h2>
            <div className="list">
              {JOBS.map((j) => (
                <button key={j.page} className="list-row arrow-row" onClick={() => navigate(j.page)}>
                  <span className="grow">
                    <span className="name" style={{ display: 'block' }}>{j.name}</span>
                    <span className="meta" style={{ display: 'block', lineHeight: '17px' }}>{j.desc}</span>
                  </span>
                  <ArrowRight className="go" />
                </button>
              ))}
            </div>
          </section>
        </div>

        <div className="split">
          <section className="panel pad" aria-label="Templates">
            <div className="panel-head"><h2 className="section-title grow">New song from a template</h2><button className="btn sm" onClick={() => { void A.newProject().then(() => navigate('composer')); }}>Blank song</button></div>
            <table className="table">
              <thead><tr><th>Style</th><th className="desktop-only">Parts</th><th className="right" style={{ paddingRight: 12 }}>Tempo</th><th>Key</th><th /></tr></thead>
              <tbody>
                {TEMPLATES.map((t) => (
                  <tr key={t.id}>
                    <td style={{ fontWeight: 500 }}>{t.name}</td>
                    <td className="muted desktop-only" style={{ fontSize: 13 }}>{t.parts}</td>
                    <td className="right num" style={{ paddingRight: 12 }}>{t.bpm} <span className="faint">BPM</span></td>
                    <td className="muted">{t.keyLabel}</td>
                    <td className="right"><button className="btn sm" onClick={() => void useTemplate(t.id)}>Use</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="panel pad col" aria-label="Recent projects" style={{ gap: 0 }}>
            <div className="panel-head"><h2 className="section-title grow">Other projects</h2><button className="btn sm ghost" onClick={() => navigate('projects')}>View all {recent.length}</button></div>
            {others.length === 0 ? (
              <div className="empty">Nothing else saved yet. Projects save themselves in this browser as you work.</div>
            ) : (
              <div className="list">
                {others.map((r) => (
                  <button key={r.id} className="list-row arrow-row" onClick={() => { void A.openProject(r.id).then((ok) => ok && navigate('studio')); }}>
                    <span className="grow">
                      <span className="name" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                      <span className="meta num">{r.tracks} tracks · {r.bpm} BPM · {ago(r.updatedAt)}</span>
                    </span>
                    <ArrowRight className="go" />
                  </button>
                ))}
              </div>
            )}
            {others.length < 3 && (
              <div style={{ marginTop: 'auto', paddingTop: 16 }}>
                <h3 className="label" style={{ marginBottom: 2 }}>Studio shortcuts</h3>
                <div className="list">
                  {SHORTCUTS.slice(0, 6 - others.length * 2).map(([k, what]) => (
                    <div key={k} className="list-row" style={{ minHeight: 34, padding: '5px 0' }}>
                      <span className="grow muted" style={{ fontSize: 13 }}>{what}</span>
                      <span className="kbd">{k}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
