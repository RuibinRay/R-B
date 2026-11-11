import { useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import { engine } from '../audio/engine';
import { renderProject } from '../audio/render';
import { analyzeLoudness, applyGain, limitPeaks, type LoudnessStats } from '../lib/loudness';
import { projectToMidi } from '../lib/midi';
import { formatTime } from '../lib/music';
import { exportProjectFile } from '../lib/projectFile';
import { downloadBlob, encodeMp3, encodeWav, safeName, type Pcm } from '../lib/wav';
import { setUI, useStore } from '../store/store';
import { Dialog, Hint } from './ui';

type What = 'mix' | 'stems' | 'midi' | 'project';
type Format = 'wav16' | 'wav24' | 'mp3-192' | 'mp3-320';
interface Result { name: string; blob: Blob; before?: LoudnessStats; after?: LoudnessStats; reduction?: number }

/** Copy a rendered buffer to editable PCM and drop the silent tail left for reverb to ring out. */
function toEditable(buffer: AudioBuffer): Pcm {
  let end = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    let i = d.length - 1;
    while (i > end && Math.abs(d[i]) < 0.0002) i--;
    end = Math.max(end, i);
  }
  const length = Math.min(buffer.length, end + Math.round(buffer.sampleRate * 0.15));
  const channels = [0, 1].map((c) => buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)).slice(0, length));
  return { channels, sampleRate: buffer.sampleRate };
}

async function encode(pcm: Pcm, format: Format, onProgress: (f: number) => void): Promise<Blob> {
  if (format === 'wav16') return encodeWav(pcm, 16);
  if (format === 'wav24') return encodeWav(pcm, 24);
  return encodeMp3(pcm, format === 'mp3-192' ? 192 : 320, onProgress);
}

export function ExportDialog() {
  const project = useStore((s) => s.project);
  const [what, setWhat] = useState<What>('mix');
  const [format, setFormat] = useState<Format>('wav16');
  const [target, setTarget] = useState<'none' | '-14' | '-9'>('none');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const ext = format.startsWith('wav') ? 'wav' : 'mp3';
  const base = safeName(project.name);
  const close = () => { if (!busy) setUI({ exportOpen: false }); };

  const run = async () => {
    setError(''); setResults([]); setProgress(0);
    try {
      if (what === 'midi') {
        const data = projectToMidi(project);
        const r = { name: `${base}.mid`, blob: new Blob([data as BlobPart], { type: 'audio/midi' }) };
        setResults([r]); downloadBlob(r.blob, r.name);
        return;
      }
      if (what === 'project') {
        setBusy('Packing the project and its audio…');
        const r = { name: `${base}.rnb`, blob: await exportProjectFile(project) };
        setResults([r]); downloadBlob(r.blob, r.name);
        return;
      }
      if (what === 'mix') {
        setBusy('Rendering the mix…');
        const pcm = toEditable(await renderProject(project, engine.buffers));
        const before = analyzeLoudness(pcm);
        if (target !== 'none' && Number.isFinite(before.lufs)) applyGain(pcm, Number(target) - before.lufs);
        const reduction = limitPeaks(pcm, -1);
        const after = analyzeLoudness(pcm);
        setBusy(ext === 'mp3' ? 'Encoding MP3…' : 'Writing the file…');
        const r: Result = { name: `${base}.${ext}`, blob: await encode(pcm, format, setProgress), before, after, reduction };
        setResults([r]); downloadBlob(r.blob, r.name);
        return;
      }
      const tracks = project.tracks.filter((t) => project.clips.some((c) => c.trackId === t.id && !c.muted));
      if (!tracks.length) throw new Error('There are no tracks with clips to export as stems.');
      const out: Result[] = [];
      for (let i = 0; i < tracks.length; i++) {
        setBusy(`Rendering stem ${i + 1} of ${tracks.length}: ${tracks[i].name}…`);
        setProgress(i / tracks.length);
        const pcm = toEditable(await renderProject(project, engine.buffers, { onlyTrackId: tracks[i].id }));
        const reduction = limitPeaks(pcm, -0.3);
        out.push({ name: `${base}-${String(i + 1).padStart(2, '0')}-${safeName(tracks[i].name)}.${ext}`, blob: await encode(pcm, format, () => {}), after: analyzeLoudness(pcm), reduction });
        setResults([...out]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The export failed.');
    } finally {
      setBusy('');
    }
  };

  const audio = what === 'mix' || what === 'stems';
  return (
    <Dialog title={`Export “${project.name}”`} onClose={close}>
      <div className="col" style={{ gap: 16, marginTop: 16 }}>
        <div className="field">
          <span>What to export</span>
          <div className="seg" style={{ alignSelf: 'flex-start', flexWrap: 'wrap' }}>
            {([['mix', 'Full mix'], ['stems', 'Stems'], ['midi', 'MIDI file'], ['project', 'Project file']] as const).map(([id, label]) => (
              <button key={id} className={what === id ? 'on' : ''} onClick={() => { setWhat(id); setResults([]); setError(''); }}>{label}</button>
            ))}
          </div>
          <p className="hint">
            {what === 'mix' && 'One stereo file of everything you hear: instruments, recordings, effects and master.'}
            {what === 'stems' && 'One file per track with its effects, for remixing or mixing elsewhere. Master processing is left off.'}
            {what === 'midi' && 'The notes of every instrument track as a standard MIDI file. Audio clips are not included.'}
            {what === 'project' && 'A single .rnb file with the whole editable project and its audio, to back up or open on another computer.'}
          </p>
        </div>
        {audio && (
          <div className="row wrap" style={{ gap: 16, alignItems: 'flex-start' }}>
            <label className="field"><span>Format</span>
              <select className="select" value={format} onChange={(e) => setFormat(e.target.value as Format)}>
                <option value="wav16">WAV, 16-bit</option>
                <option value="wav24">WAV, 24-bit</option>
                <option value="mp3-192">MP3, 192 kbps</option>
                <option value="mp3-320">MP3, 320 kbps</option>
              </select>
            </label>
            {what === 'mix' && (
              <label className="field"><span>Loudness</span>
                <select className="select" value={target} onChange={(e) => setTarget(e.target.value as typeof target)}>
                  <option value="none">Keep the mix level</option>
                  <option value="-14">Normalize to −14 LUFS (streaming)</option>
                  <option value="-9">Normalize to −9 LUFS (loud)</option>
                </select>
              </label>
            )}
          </div>
        )}
        {audio && <Hint>Peaks are held under −1 dBFS on export so the file never clips. Songs are capped at five minutes.</Hint>}
        {error && <div className="error-box" role="alert">{error}</div>}
        {busy && (
          <div className="col">
            <div className="row"><LoaderCircle className="spin" style={{ width: 16, height: 16 }} /><span>{busy}</span></div>
            {progress > 0 && <div className="progress"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
          </div>
        )}
        {results.length > 0 && (
          <div className="well col" style={{ gap: 10 }}>
            {results[0].after && what === 'mix' && (
              <div className="stat-strip">
                <div><b className="num">{formatTime(results[0].after.durationSec, false)}</b><span>length</span></div>
                <div><b className="num">{Number.isFinite(results[0].after.lufs) ? results[0].after.lufs.toFixed(1) : '—'}</b><span>LUFS{results[0].before && target !== 'none' ? ` (was ${results[0].before.lufs.toFixed(1)})` : ''}</span></div>
                <div><b className="num">{results[0].after.peakDb.toFixed(1)}</b><span>dBFS peak</span></div>
                <div><b className="num">{(results[0].reduction ?? 0).toFixed(1)}</b><span>dB limiting</span></div>
              </div>
            )}
            <div className="list">
              {results.map((r) => (
                <div key={r.name} className="list-row" style={{ minHeight: 40 }}>
                  <span className="grow name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                  <span className="meta num">{(r.blob.size / 1048576).toFixed(r.blob.size > 1048576 ? 1 : 2)} MB</span>
                  <button className="btn sm" onClick={() => downloadBlob(r.blob, r.name)}><Download />Download</button>
                </div>
              ))}
            </div>
            {results.length > 1 && !busy && <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => results.forEach((r, i) => window.setTimeout(() => downloadBlob(r.blob, r.name), i * 350))}>Download all {results.length}</button>}
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={close} disabled={!!busy}>Close</button>
          <button className="btn primary" onClick={run} disabled={!!busy}><Download />{results.length ? 'Export again' : 'Export'}</button>
        </div>
      </div>
    </Dialog>
  );
}
