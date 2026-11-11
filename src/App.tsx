import { useEffect, useState } from 'react';
import { Clapperboard, FolderOpen, House, Layers, Library as LibraryIcon, Menu as MenuIcon, Mic, Piano, SlidersHorizontal, X } from 'lucide-react';
import { engine } from './audio/engine';
import { putProject } from './lib/db';
import { clipEnd } from './lib/music';
import { beatsToSec } from './lib/music';
import { A, navigate, setUI, toast, useStore, type Page } from './store/store';
import { ExportDialog } from './components/ExportDialog';
import { typingKeySet } from './components/Keys';
import { Toasts } from './components/ui';
import { Composer } from './pages/Composer';
import { Home } from './pages/Home';
import { Library } from './pages/Library';
import { Projects } from './pages/Projects';
import { Stems } from './pages/Stems';
import { Studio } from './pages/Studio';
import { Video } from './pages/Video';
import { Voice } from './pages/Voice';

const NAV: { page: Page; label: string; icon: typeof House }[] = [
  { page: 'home', label: 'Home', icon: House },
  { page: 'composer', label: 'Music Composer', icon: Piano },
  { page: 'voice', label: 'Voice to Instrument', icon: Mic },
  { page: 'stems', label: 'AI Stem Separator', icon: Layers },
  { page: 'studio', label: 'Production Studio', icon: SlidersHorizontal },
  { page: 'video', label: 'Video Editor', icon: Clapperboard },
  { page: 'projects', label: 'My Projects', icon: FolderOpen },
  { page: 'library', label: 'Instrument Library', icon: LibraryIcon },
];

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="#1b1b1e" />
      <path d="M6 20.5v-9M11 24V8M16 19v-6M21 23V9M26 20v-8" stroke="#8f7cf7" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M16 19v-6" stroke="#4fc3e8" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

const isTextField = (el: EventTarget | null): boolean => {
  const t = el as HTMLElement | null;
  if (!t || !t.tagName) return false;
  if (t.tagName === 'INPUT') return !['range', 'checkbox', 'button'].includes((t as HTMLInputElement).type);
  return t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
};

/** Global keyboard shortcuts for the two editing pages. */
function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const page = s.ui.page;
      if (page !== 'studio' && page !== 'composer' && page !== 'home' && page !== 'video') return;
      if (isTextField(e.target) || s.ui.exportOpen) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const done = () => e.preventDefault();
      if (e.code === 'Space') { done(); A.toggle(); return; }
      if (page === 'home') return;
      if (mod && key === 'z') { done(); if (e.shiftKey) A.redo(); else A.undo(); return; }
      if (mod && key === 'y') { done(); A.redo(); return; }
      if (mod && key === 's') {
        done();
        void putProject({ ...s.project, updatedAt: Date.now() }).then(() => toast('Project saved.', 'success'), () => toast('The project could not be saved.', 'error'));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Home') { done(); A.toStart(); return; }
      if (page === 'video') {
        // video mode has its own, smaller set of editing keys
        const sel = s.ui.videoSel;
        if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { done(); A.removeVideoItem(sel); }
        else if (key === 's' && !mod) {
          const t = beatsToSec(engine.beat, s.project.bpm);
          const clip = s.project.video?.clips.find((c) => t > c.start + 0.05 && t < c.start + c.length - 0.05);
          if (clip) { A.splitVideoClip(clip.id, t); done(); }
        } else if (key === 'l' && !mod) { A.setLoop({ on: !s.project.loop.on }); done(); }
        return;
      }
      // The piano roll handles its own editing keys while it has focus.
      if ((e.target as HTMLElement | null)?.closest?.('[data-own-keys]')) return;
      const sel = s.ui.selectedClipIds;
      if (e.key === 'Delete' || e.key === 'Backspace') { if (sel.length && page === 'studio') { done(); A.removeClips(sel); } return; }
      if (mod && page === 'studio') {
        if (key === 'c') { A.copyClips(sel); done(); }
        else if (key === 'x') { A.copyClips(sel); A.removeClips(sel); done(); }
        else if (key === 'v') { A.pasteClips(engine.beat); done(); }
        else if (key === 'd') { if (sel.length) A.duplicateClips(sel); done(); }
        else if (key === 'a') { setUI({ selectedClipIds: s.project.clips.map((c) => c.id) }); done(); }
        return;
      }
      if (mod || e.altKey) return;
      // Letter shortcuts give way to musical typing in the composer.
      if (page === 'composer' && s.ui.typing && typingKeySet.has(key)) return;
      if (key === 'l') { A.setLoop({ on: !s.project.loop.on }); done(); }
      else if (key === 'k') { A.setMetronome(!s.ui.metronome); done(); }
      else if (key === 'r') { if (s.recording) void A.stopRecording(); else void A.startRecording(); done(); }
      else if (key === 'm') { A.addMarker(engine.beat); done(); }
      else if (key === 's' && page === 'studio') {
        const beat = engine.beat;
        const pool = sel.length ? s.project.clips.filter((c) => sel.includes(c.id)) : s.project.clips.filter((c) => c.trackId === s.ui.selectedTrackId);
        const ids = pool.filter((c) => beat > c.start + 0.01 && beat < clipEnd(c, s.project.bpm) - 0.01).map((c) => c.id);
        if (ids.length) A.splitClips(ids, beat);
        done();
      } else if (key === '=' || key === '+') { setUI({ pxPerBeat: Math.min(2400, s.ui.pxPerBeat * 1.4) }); done(); }
      else if (key === '-') { setUI({ pxPerBeat: Math.max(1, s.ui.pxPerBeat / 1.4) }); done(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export default function App() {
  const page = useStore((s) => s.ui.page);
  const mode = useStore((s) => s.ui.mode);
  const ready = useStore((s) => s.ready);
  const exportOpen = useStore((s) => s.ui.exportOpen);
  const projectName = useStore((s) => s.project.name);
  const [menu, setMenu] = useState(false);
  useShortcuts();

  // Browsers only allow audio after a user gesture.
  useEffect(() => {
    const wake = () => void engine.resume();
    window.addEventListener('pointerdown', wake, { once: true });
    window.addEventListener('keydown', wake, { once: true });
    return () => { window.removeEventListener('pointerdown', wake); window.removeEventListener('keydown', wake); };
  }, []);

  // Stop the transport when leaving the pages that own it.
  useEffect(() => { if (page === 'voice' || page === 'stems') A.stop(); }, [page]);

  const go = (p: Page) => { navigate(p); setMenu(false); };
  const title = NAV.find((n) => n.page === page)?.label ?? 'R&B';

  return (
    <div className="app">
      <header className="mobile-bar">
        <button className="icon-btn" aria-label="Open menu" onClick={() => setMenu(true)}><MenuIcon /></button>
        <BrandMark />
        <span style={{ fontWeight: 600 }}>{title}</span>
      </header>
      <nav className={`sidebar ${menu ? 'open' : ''}`} aria-label="Main">
        <div className="row">
          <a className="brand grow" href="#/home" onClick={() => setMenu(false)}>
            <BrandMark />
            <span><span className="brand-name" style={{ display: 'block' }}>R&amp;B</span><span className="brand-sub">Ray and Beat</span></span>
          </a>
          {menu && <button className="icon-btn" aria-label="Close menu" onClick={() => setMenu(false)}><X /></button>}
        </div>
        <div className="nav">
          {NAV.map(({ page: p, label, icon: Icon }) => (
            <button key={p} className={`nav-item ${page === p ? 'active' : ''}`} aria-current={page === p ? 'page' : undefined} onClick={() => go(p)}>
              <Icon />{label}
            </button>
          ))}
        </div>
        <div className="sidebar-foot">
          <div>
            <div className="label">Open project</div>
            <div className="session-name" title={projectName}>{projectName}</div>
          </div>
          <div className="seg" role="group" aria-label="Interface mode" style={{ alignSelf: 'stretch' }}>
            <button className={mode === 'beginner' ? 'on' : ''} style={{ flex: 1, justifyContent: 'center' }} onClick={() => setUI({ mode: 'beginner' })} title="Plain explanations and the essential controls">Beginner</button>
            <button className={mode === 'advanced' ? 'on' : ''} style={{ flex: 1, justifyContent: 'center' }} onClick={() => setUI({ mode: 'advanced' })} title="Every control: compressor, gate, fades, latency, finer grids">Advanced</button>
          </div>
        </div>
      </nav>
      <main className="main">
        {!ready ? (
          <div className="page"><p className="sub">Opening your last project…</p></div>
        ) : (
          <>
            {page === 'home' && <Home />}
            {page === 'composer' && <Composer />}
            {page === 'voice' && <Voice />}
            {page === 'stems' && <Stems />}
            {page === 'studio' && <Studio />}
            {page === 'video' && <Video />}
            {page === 'projects' && <Projects />}
            {page === 'library' && <Library />}
          </>
        )}
      </main>
      {exportOpen && <ExportDialog />}
      <Toasts />
    </div>
  );
}
