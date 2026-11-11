import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, Play, RefreshCw, Square, Upload } from 'lucide-react';
import { engine } from '../audio/engine';
import { TRACK_COLORS, clamp, formatTime } from '../lib/music';
import { drawWaveform, fitCanvas } from '../lib/peaks';
import { downloadBlob, safeName } from '../lib/wav';
import { A, importAudio, navigate, toast, useStore } from '../store/store';
import { Hint, Slider, useFrame, useSize } from '../components/ui';

// AI stem separation. The model (Demucs) runs in the Python backend in /server;
// this page uploads the song, follows the job, then plays and remixes the stems.

const API_KEY = 'rnb.api';
const DEFAULT_API = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8000';
const MAX_BYTES = 100 * 1024 * 1024;
const TYPES = /\.(mp3|wav|flac|ogg|oga|m4a|aac|aiff?|wma|opus)$/i;

interface Health { ok: boolean; demucs: boolean; device: string; ffmpeg: boolean; max_minutes: number; detail?: string }
interface Job { id: string; status: 'queued' | 'running' | 'done' | 'error'; progress: number; message: string; error?: string; stems?: { name: string; url: string }[] }
interface Stem { name: string; buffer: AudioBuffer; blob: Blob; volume: number; pan: number; mute: boolean; solo: boolean; color: string }

const LABELS: Record<string, string> = { vocals: 'Vocals', no_vocals: 'Instrumental', drums: 'Drums', bass: 'Bass', other: 'Other', guitar: 'Guitar', piano: 'Piano' };

/** Plays several buffers in lock-step with per-stem gain and pan. */
class StemPlayer {
  playing = false;
  duration = 0;
  private raw = engine.rawContext;
  private gains: GainNode[] = [];
  private pans: StereoPannerNode[] = [];
  private sources: AudioBufferSourceNode[] = [];
  private startedAt = 0;
  private offset = 0;
  onEnd: (() => void) | null = null;

  constructor(private buffers: AudioBuffer[]) {
    this.duration = Math.max(0, ...buffers.map((b) => b.duration));
    for (let i = 0; i < buffers.length; i++) {
      const g = this.raw.createGain();
      const p = this.raw.createStereoPanner();
      g.connect(p);
      p.connect(this.raw.destination);
      this.gains.push(g);
      this.pans.push(p);
    }
  }
  position(): number { return this.playing ? clamp(this.raw.currentTime - this.startedAt, 0, this.duration) : this.offset; }
  setMix(i: number, gain: number, pan: number): void {
    this.gains[i]?.gain.setTargetAtTime(gain, this.raw.currentTime, 0.015);
    this.pans[i]?.pan.setTargetAtTime(pan, this.raw.currentTime, 0.015);
  }
  play(): void {
    if (this.playing) return;
    if (this.offset >= this.duration - 0.05) this.offset = 0;
    const t = this.raw.currentTime + 0.06;
    this.sources = this.buffers.map((b, i) => {
      const s = this.raw.createBufferSource();
      s.buffer = b;
      s.connect(this.gains[i]);
      s.start(t, this.offset);
      return s;
    });
    this.startedAt = t - this.offset;
    this.playing = true;
    const first = this.sources[0];
    if (first) first.onended = () => { if (this.playing && this.sources[0] === first) { this.haltSources(); this.playing = false; this.offset = 0; this.onEnd?.(); } };
  }
  private haltSources(): void {
    for (const s of this.sources) { s.onended = null; try { s.stop(); } catch { /* not started */ } s.disconnect(); }
    this.sources = [];
  }
  pause(): void {
    if (!this.playing) return;
    this.offset = this.position();
    this.haltSources();
    this.playing = false;
  }
  seek(sec: number): void {
    const was = this.playing;
    if (was) { this.haltSources(); this.playing = false; }
    this.offset = clamp(sec, 0, this.duration);
    if (was) this.play();
  }
  dispose(): void {
    this.haltSources();
    this.playing = false;
    for (const p of this.pans) p.disconnect();
  }
}

function StemWave({ stem, player, dim }: { stem: Stem; player: StemPlayer; dim: boolean }) {
  const [ref, size] = useSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!canvas.current || size.w < 10) return;
    const ctx = fitCanvas(canvas.current, size.w, 64);
    ctx.clearRect(0, 0, size.w, 64);
    ctx.globalAlpha = dim ? 0.3 : 1;
    drawWaveform(ctx, stem.buffer, 0, 3, size.w, 58, 0, stem.buffer.duration, stem.color);
  }, [stem.buffer, stem.color, size.w, dim]);
  useFrame(() => { if (head.current) head.current.style.transform = `translateX(${(player.position() / Math.max(0.01, player.duration)) * size.w}px)`; });
  return (
    <div ref={ref} className="wave-box" style={{ position: 'relative', cursor: 'pointer' }} onPointerDown={(e) => { const r = e.currentTarget.getBoundingClientRect(); player.seek(((e.clientX - r.left) / r.width) * player.duration); }}>
      <canvas ref={canvas} role="img" aria-label={`${LABELS[stem.name] ?? stem.name} waveform. Click to move the playhead.`} />
      <div ref={head} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: 1, background: '#fff', pointerEvents: 'none' }} />
    </div>
  );
}

export function Stems() {
  const [api, setApi] = useState(() => localStorage.getItem(API_KEY) ?? DEFAULT_API);
  const [apiText, setApiText] = useState(api);
  const [health, setHealth] = useState<Health | null | 'checking'>('checking');
  const [file, setFile] = useState<File | null>(null);
  const [count, setCount] = useState<2 | 4 | 6>(4);
  const [job, setJob] = useState<Job | null>(null);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [stems, setStems] = useState<Stem[]>([]);
  const [player, setPlayer] = useState<StemPlayer | null>(null);
  const [playing, setPlaying] = useState(false);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const cancelled = useRef(false);
  const projectName = useStore((s) => s.project.name);

  const check = async (base = api) => {
    setHealth('checking');
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(4000) });
      setHealth(res.ok ? ((await res.json()) as Health) : null);
    } catch {
      setHealth(null);
    }
  };
  useEffect(() => { void check(); return () => { cancelled.current = true; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => player?.dispose(), [player]);

  // keep the audible mix in step with the controls
  useEffect(() => {
    if (!player) return;
    const anySolo = stems.some((s) => s.solo);
    stems.forEach((s, i) => player.setMix(i, s.mute || (anySolo && !s.solo) ? 0 : Math.pow(10, s.volume / 20), s.pan));
  }, [stems, player]);

  useFrame(() => { if (time.current && player) time.current.textContent = `${formatTime(player.position(), false)} / ${formatTime(player.duration, false)}`; });

  const choose = (f: File | undefined) => {
    setError('');
    if (!f) return;
    if (!f.type.startsWith('audio/') && !TYPES.test(f.name)) { setError('That does not look like an audio file. Use MP3, WAV, FLAC, OGG or M4A.'); return; }
    if (f.size > MAX_BYTES) { setError(`That file is ${(f.size / 1048576).toFixed(0)} MB. The limit is 100 MB.`); return; }
    setFile(f);
  };

  const separate = async () => {
    if (!file) return;
    setError(''); setStems([]); player?.dispose(); setPlayer(null); setPlaying(false);
    cancelled.current = false;
    A.stop();
    try {
      setStage('Uploading…');
      const form = new FormData();
      form.append('file', file);
      form.append('stems', String(count));
      const res = await fetch(`${api}/api/separate`, { method: 'POST', body: form });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? `The server refused the upload (${res.status}).`);
      let j = (await res.json()) as Job;
      setJob(j);
      setStage('');
      while (j.status === 'queued' || j.status === 'running') {
        await new Promise((r) => setTimeout(r, 1000));
        if (cancelled.current) return;
        const poll = await fetch(`${api}/api/jobs/${j.id}`);
        if (!poll.ok) throw new Error('The server lost track of this job. Try again.');
        j = (await poll.json()) as Job;
        setJob(j);
      }
      if (j.status === 'error') throw new Error(j.error || 'Separation failed on the server.');
      setStage('Downloading stems…');
      await engine.resume();
      const out: Stem[] = [];
      for (const [i, s] of (j.stems ?? []).entries()) {
        const blob = await (await fetch(`${api}${s.url}`)).blob();
        const buffer = await engine.decode(await blob.arrayBuffer());
        out.push({ name: s.name, buffer, blob, volume: 0, pan: 0, mute: false, solo: false, color: TRACK_COLORS[i % TRACK_COLORS.length] });
      }
      void fetch(`${api}/api/jobs/${j.id}`, { method: 'DELETE' }).catch(() => {});
      const p = new StemPlayer(out.map((s) => s.buffer));
      p.onEnd = () => setPlaying(false);
      setStems(out);
      setPlayer(p);
    } catch (e) {
      setError(e instanceof TypeError ? 'The separation server could not be reached. Check that it is running, then try again.' : e instanceof Error ? e.message : 'Separation failed.');
      void check();
    } finally {
      setStage('');
      setJob(null);
    }
  };

  const patch = (i: number, p: Partial<Stem>) => setStems((list) => list.map((s, k) => (k === i ? { ...s, ...p } : s)));
  const toggle = async () => {
    if (!player) return;
    await engine.resume();
    A.stop();
    if (player.playing) { player.pause(); setPlaying(false); } else { player.play(); setPlaying(true); }
  };
  const baseName = safeName(file?.name.replace(/\.[^.]+$/, '') ?? 'song');
  const send = async (list: Stem[], fresh: boolean) => {
    try {
      player?.pause(); setPlaying(false);
      if (fresh) {
        await A.newProject(undefined, `${baseName} remix`);
        useStore.getState().project.tracks.forEach((t) => A.removeTrack(t.id));
      }
      for (const s of list) {
        const label = LABELS[s.name] ?? s.name;
        const meta = await importAudio(s.blob, `${baseName} ${label.toLowerCase()}`);
        const id = A.addTrack('audio', null, label);
        A.updateTrack(id, { volume: s.volume, pan: s.pan, mute: s.mute, color: s.color });
        A.addAudioClip(id, meta, 0);
      }
      toast(`${list.length} stem${list.length === 1 ? '' : 's'} added to ${fresh ? 'a new project' : `“${projectName}”`}.`, 'success');
      navigate('studio');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The stems could not be added to the studio.', 'error');
    }
  };

  const online = health !== null && health !== 'checking';
  const ready = online && health.demucs;
  const working = !!stage || !!job;

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div className="grow">
            <h1 className="title">AI stem separator</h1>
            <p className="sub">Split a finished song into its parts with the Demucs model, listen to each one, then remix them or pull them into your own project.</p>
          </div>
          {health === 'checking' ? <span className="chip"><LoaderCircle className="spin" style={{ width: 12, height: 12 }} />Checking server</span>
            : ready ? <span className="chip ok"><span className="dot" />Server ready · {health.device}</span>
            : online ? <span className="chip warn"><span className="dot" />Server running, Demucs missing</span>
            : <span className="chip bad"><span className="dot" />Server not running</span>}
        </div>

        <div className="cols-2">
          <section className="panel pad col" style={{ gap: 14 }} aria-label="Upload a song">
            <h2 className="section-title">1. Choose a song</h2>
            <div
              className={`dropzone ${over ? 'over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); choose(e.dataTransfer.files[0]); }}
            >
              {file ? <span style={{ color: 'var(--text)', fontWeight: 500 }}>{file.name} <span className="faint num">· {(file.size / 1048576).toFixed(1)} MB</span></span> : <span>Drop an audio file here</span>}
              <button className="btn" onClick={() => fileInput.current?.click()} disabled={working}><Upload />{file ? 'Choose another file' : 'Choose a file'}</button>
              <span className="faint" style={{ fontSize: 12 }}>MP3, WAV, FLAC, OGG or M4A · up to 100 MB and {online ? health.max_minutes : 10} minutes</span>
              <input ref={fileInput} type="file" accept="audio/*,.mp3,.wav,.flac,.ogg,.m4a,.aac,.aiff" hidden onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
            <div className="field">
              <span>2. How many parts?</span>
              <div className="seg" style={{ alignSelf: 'flex-start' }}>
                {([[2, '2 stems'], [4, '4 stems'], [6, '6 stems']] as const).map(([n, label]) => <button key={n} className={count === n ? 'on' : ''} onClick={() => setCount(n)}>{label}</button>)}
              </div>
              <p className="hint">{count === 2 ? 'Vocals and instrumental.' : count === 4 ? 'Vocals, drums, bass and everything else.' : 'Vocals, drums, bass, guitar, piano and everything else. Guitar and piano are the least reliable parts.'}</p>
            </div>
            <button className="btn primary lg" style={{ alignSelf: 'flex-start' }} disabled={!file || !ready || working} onClick={() => void separate()}>
              {working ? <LoaderCircle className="spin" /> : null}{working ? 'Separating…' : 'Separate'}
            </button>
            {working && (
              <div className="col" role="status">
                <span>{stage || job?.message || 'Waiting in the queue…'}</span>
                <div className="progress"><i style={{ width: `${Math.round((job?.progress ?? 0) * 100)}%` }} /></div>
                <span className="faint" style={{ fontSize: 12 }}>On a laptop processor a four-minute song takes a few minutes. Keep this page open.</span>
              </div>
            )}
            {error && <div className="error-box" role="alert">{error}</div>}
            <div className="notice">Separation is an estimate made by a model. Expect artifacts: faint bleed of other instruments, watery cymbals or thin reverb tails, most of all in dense mixes. Only separate music you have the right to use.</div>
          </section>

          <section className="panel pad col" style={{ gap: 12 }} aria-label="Separation server">
            <div className="panel-head" style={{ marginBottom: 0 }}><h2 className="section-title grow">Separation server</h2><button className="btn sm" onClick={() => void check()}><RefreshCw />Check again</button></div>
            <p className="hint">The Demucs model is too large to run in a browser tab, so it runs in the small Python server that ships with R&amp;B (the <b>server</b> folder). Your audio only goes to the address below.</p>
            <label className="field"><span>Server address</span>
              <div className="row">
                <input className="input grow" value={apiText} onChange={(e) => setApiText(e.target.value)} aria-label="Server address" spellCheck={false} />
                <button className="btn" onClick={() => { const v = apiText.trim().replace(/\/+$/, ''); setApi(v); localStorage.setItem(API_KEY, v); void check(v); }}>Use</button>
              </div>
            </label>
            {ready ? (
              <div className="stat-strip" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }}>
                <div><b>{health.device.toUpperCase()}</b><span>processing on</span></div>
                <div><b>{health.ffmpeg ? 'Yes' : 'No'}</b><span>ffmpeg for MP3/M4A</span></div>
                <div><b className="num">{health.max_minutes} min</b><span>longest song</span></div>
              </div>
            ) : health === 'checking' ? (
              <div className="empty">Looking for the server at {api}…</div>
            ) : (
              <>
                <div className={online ? 'notice' : 'error-box'}>{online ? `The server is running but Demucs is not installed in it${health.detail ? ` (${health.detail})` : ''}.` : `Nothing answered at ${api}. Start the server, then press “Check again”.`}</div>
                <span className="label">Start it from the project folder (first run downloads the model, about 80 MB)</span>
                <pre className="code">{`cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --port 8000`}</pre>
              </>
            )}
          </section>
        </div>

        {player && stems.length > 0 && (
          <section className="panel pad" aria-label="Stems">
            <div className="panel-head">
              <button className="play-btn" aria-label={playing ? 'Pause' : 'Play all stems'} onClick={() => void toggle()}>{playing ? <Square fill="currentColor" /> : <Play fill="currentColor" style={{ marginLeft: 2 }} />}</button>
              <div className="grow">
                <h2 className="section-title">{file?.name ?? 'Stems'}</h2>
                <span ref={time} className="faint num" style={{ fontSize: 12 }}>0:00</span>
              </div>
              <button className="btn" onClick={() => void send(stems.filter((s) => !s.mute), false)}>Add to the open project</button>
              <button className="btn primary" onClick={() => void send(stems, true)}>New remix project</button>
            </div>
            <Hint>Mute the vocals to hear the instrumental, or solo one part to hear it alone. Volume and pan here carry over when you send the stems to the studio, where you can replace the drums, add instruments or record over them.</Hint>
            <div style={{ marginTop: 8 }}>
              {stems.map((s, i) => {
                const anySolo = stems.some((x) => x.solo);
                return (
                  <div key={s.name} className="stem">
                    <div className="col" style={{ gap: 6 }}>
                      <div className="row" style={{ gap: 6 }}>
                        <span style={{ width: 4, height: 18, borderRadius: 2, background: s.color }} />
                        <span className="grow" style={{ fontWeight: 500 }}>{LABELS[s.name] ?? s.name}</span>
                        <button className={`ms m ${s.mute ? 'on' : ''}`} aria-label={`Mute ${s.name}`} aria-pressed={s.mute} onClick={() => patch(i, { mute: !s.mute })}>M</button>
                        <button className={`ms s ${s.solo ? 'on' : ''}`} aria-label={`Solo ${s.name}`} aria-pressed={s.solo} onClick={() => patch(i, { solo: !s.solo })}>S</button>
                      </div>
                      <div className="fx-param" style={{ gridTemplateColumns: '30px minmax(0,1fr) 46px' }}><span>Vol</span><Slider plain label={`${s.name} volume`} min={-40} max={6} step={0.5} value={s.volume} reset={0} onChange={(v) => patch(i, { volume: v })} /><output className="num">{s.volume.toFixed(1)}</output></div>
                      <div className="fx-param" style={{ gridTemplateColumns: '30px minmax(0,1fr) 46px' }}><span>Pan</span><Slider plain label={`${s.name} pan`} min={-1} max={1} step={0.02} value={s.pan} reset={0} onChange={(v) => patch(i, { pan: v })} /><output className="num">{Math.abs(s.pan) < 0.02 ? 'C' : `${Math.round(Math.abs(s.pan) * 100)}${s.pan < 0 ? 'L' : 'R'}`}</output></div>
                    </div>
                    <StemWave stem={s} player={player} dim={s.mute || (anySolo && !s.solo)} />
                    <div className="row">
                      <button className="icon-btn" title={`Download ${s.name} (WAV)`} aria-label={`Download ${s.name}`} onClick={() => downloadBlob(s.blob, `${baseName}-${s.name}.wav`)}><Download /></button>
                      <button className="btn sm" onClick={() => void send([s], false)}>To studio</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
