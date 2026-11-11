import { useEffect, useRef, useState } from 'react';
import { Copy, Download, FolderOpen, Plus, Trash2, Upload } from 'lucide-react';
import { getProject, listProjects, storageEstimate, type ProjectSummary } from '../lib/db';
import { exportProjectFile } from '../lib/projectFile';
import { TEMPLATES } from '../lib/templates';
import { downloadBlob, safeName } from '../lib/wav';
import { A, navigate, toast, useStore } from '../store/store';
import { Dialog } from '../components/ui';

const when = (t: number): string => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function Projects() {
  const currentId = useStore((s) => s.project.id);
  const saveState = useStore((s) => s.saveState);
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const [confirm, setConfirm] = useState<ProjectSummary | null>(null);
  const [busy, setBusy] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const midiInput = useRef<HTMLInputElement>(null);

  const refresh = () => {
    listProjects().then(setList, () => setList([]));
    storageEstimate().then(setUsage, () => setUsage(null));
  };
  useEffect(refresh, [currentId, saveState]);

  const open = async (id: string) => { if (await A.openProject(id)) navigate('studio'); };
  const exportFile = async (s: ProjectSummary) => {
    setBusy(s.id);
    try {
      const p = await getProject(s.id);
      if (p) downloadBlob(await exportProjectFile(p), `${safeName(p.name)}.rnb`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The project could not be exported.', 'error');
    } finally { setBusy(''); }
  };
  const importFile = async (f: File) => {
    try { await A.importProject(f); toast(`Opened ${f.name}.`, 'success'); navigate('studio'); }
    catch (e) { toast(e instanceof Error ? e.message : 'That file could not be imported.', 'error'); }
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div className="grow">
            <h1 className="title">My projects</h1>
            <p className="sub">
              {list ? `${list.length} project${list.length === 1 ? '' : 's'} saved in this browser` : 'Loading…'}
              {usage && usage.quota > 0 ? ` · ${(usage.usage / 1048576).toFixed(1)} MB of ${(usage.quota / 1073741824).toFixed(1)} GB used` : ''}. Work saves itself as you go; nothing is uploaded.
            </p>
          </div>
          <button className="btn" onClick={() => fileInput.current?.click()}><Upload />Import project file</button>
          <button className="btn" onClick={() => midiInput.current?.click()}><Upload />Import MIDI</button>
          <button className="btn primary" onClick={() => { void A.newProject().then(() => navigate('composer')); }}><Plus />New project</button>
          <input ref={fileInput} type="file" accept=".rnb" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} />
          <input ref={midiInput} type="file" accept=".mid,.midi" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void A.importMidi(f).then(() => navigate('studio')); e.target.value = ''; }} />
        </div>

        <section className="panel pad" aria-label="Saved projects">
          {list && list.length === 0 ? (
            <div className="empty">No saved projects yet. Start a new one or pick a template below.</div>
          ) : (
            <table className="table">
              <thead><tr><th>Name</th><th>Last saved</th><th className="right" style={{ paddingRight: 12 }}>Tempo</th><th className="right desktop-only" style={{ paddingRight: 12 }}>Tracks</th><th className="right desktop-only" style={{ paddingRight: 12 }}>Clips</th><th /></tr></thead>
              <tbody>
                {(list ?? []).map((p) => (
                  <tr key={p.id} className={p.id === currentId ? 'sel' : ''}>
                    <td style={{ paddingLeft: 10 }}>
                      <button className="btn ghost" style={{ padding: 0, height: 'auto', color: 'var(--text)', fontSize: 14, background: 'none' }} onClick={() => void open(p.id)}>{p.name}</button>
                      {p.id === currentId && <span className="chip" style={{ marginLeft: 8 }}>Open now</span>}
                    </td>
                    <td className="muted num">{when(p.updatedAt)}</td>
                    <td className="right num" style={{ paddingRight: 12 }}>{p.bpm} <span className="faint">BPM</span></td>
                    <td className="right num desktop-only" style={{ paddingRight: 12 }}>{p.tracks}</td>
                    <td className="right num desktop-only" style={{ paddingRight: 12 }}>{p.clips}</td>
                    <td className="right" style={{ whiteSpace: 'nowrap' }}>
                      <button className="icon-btn" title="Open" aria-label={`Open ${p.name}`} onClick={() => void open(p.id)}><FolderOpen /></button>
                      <button className="icon-btn" title="Duplicate" aria-label={`Duplicate ${p.name}`} onClick={() => void A.duplicateProject(p.id).then(refresh)}><Copy /></button>
                      <button className="icon-btn" title="Download as a project file" aria-label={`Download ${p.name}`} disabled={busy === p.id} onClick={() => void exportFile(p)}><Download /></button>
                      <button className="icon-btn" title="Delete" aria-label={`Delete ${p.name}`} onClick={() => setConfirm(p)}><Trash2 /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel pad" aria-label="Templates">
          <div className="panel-head"><h2 className="section-title">Start from a template</h2></div>
          <div className="cols-3">
            {TEMPLATES.map((t) => (
              <div key={t.id} className="well col" style={{ gap: 6 }}>
                <div className="row"><span className="grow" style={{ fontWeight: 600 }}>{t.name}</span><span className="faint num" style={{ fontSize: 12 }}>{t.bpm} BPM · {t.keyLabel}</span></div>
                <p className="hint grow">{t.desc}</p>
                <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => { void A.newProject(t.id).then(() => navigate('studio')); }}>Use {t.name}</button>
              </div>
            ))}
          </div>
        </section>
      </div>

      {confirm && (
        <Dialog title={`Delete “${confirm.name}”?`} onClose={() => setConfirm(null)}>
          <p className="sub" style={{ margin: '12px 0 20px' }}>This removes the project and any recordings only it uses from this browser. It cannot be undone. Download a project file first if you want a backup.</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setConfirm(null)}>Keep it</button>
            <button className="btn danger" onClick={() => { const id = confirm.id; setConfirm(null); void A.deleteProject(id).then(refresh); }}><Trash2 />Delete project</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
