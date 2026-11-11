import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, Ellipsis, FolderInput, FolderOutput, Group, Palette, Trash2, Ungroup } from 'lucide-react';
import { engine } from '../audio/engine';
import { mic } from '../audio/recorder';
import type { AutoKind, AutoPoint, Clip, ID, Project, Track, TrackGroup } from '../types';
import { effectiveFades, type ClipFades } from '../lib/mix';
import { TRACK_COLORS, autoValueAt, barBeats, beatsToSec, clamp, clipLengthBeats, formatTime, maxBeats, snapBeat, snapValue, uid } from '../lib/music';
import { drawWaveform, fitCanvas } from '../lib/peaks';
import { trackSound } from '../lib/templates';
import { A, beginGesture, endGesture, setUI, toast, useStore } from '../store/store';
import { Menu, Slider, useFrame, useSize } from './ui';

const RULER = 30;
export const TRACK_H = 74;
const LANE_H = 64; // automation lane under a track
const GROUP_H = 54; // a group's own row above its tracks
const LANE_PAD = 7;
const EDGE = 7;

const hexA = (hex: string, a: number): string => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

// ---- automation lane geometry ----------------------------------------------
// Volume is dB relative to the fader (-60 = silent, +6 at the top) on a curve that
// gives the useful top of the range more room; pan runs from left (bottom) to right (top).
const laneNorm = (kind: AutoKind, v: number): number => (kind === 'volume' ? Math.pow(clamp((v + 60) / 66, 0, 1), 2) : (clamp(v, -1, 1) + 1) / 2);
const laneValue = (kind: AutoKind, n: number): number => {
  const c = clamp(n, 0, 1);
  if (kind === 'volume') { const db = 66 * Math.sqrt(c) - 60; return Math.abs(db) < 0.45 ? 0 : Math.round(db * 10) / 10; }
  const pan = c * 2 - 1;
  return Math.abs(pan) < 0.04 ? 0 : Math.round(pan * 100) / 100;
};
export const fmtAuto = (kind: AutoKind, v: number): string =>
  kind === 'volume' ? (v <= -59.5 ? 'Silent' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`) : Math.abs(v) < 0.005 ? 'Centre' : `${Math.round(Math.abs(v) * 100)} ${v < 0 ? 'left' : 'right'}`;

interface TrackRow { kind: 'track'; track: Track; top: number; height: number; lane: AutoKind | null; group: TrackGroup | null }
interface GroupRow { kind: 'group'; group: TrackGroup; members: Track[]; top: number; height: number }
type AnyRow = TrackRow | GroupRow;
type Row = TrackRow;
interface MoveOk { up: boolean; down: boolean }
const NO_GROUPS: TrackGroup[] = [];
const nextColor = (c: string) => TRACK_COLORS[(TRACK_COLORS.indexOf(c) + 1) % TRACK_COLORS.length];

type Zone = 'body' | 'left' | 'right' | 'fadeIn' | 'fadeOut';
type Drag =
  | { kind: 'move'; x0: number; row0: number; anchor: ID; base: Map<ID, { start: number; row: number; trackId: ID }>; moved: boolean; isolate: ID | null }
  | { kind: 'trimL' | 'trimR' | 'fadeIn' | 'fadeOut'; id: ID }
  | { kind: 'ruler'; x0: number; beat0: number; moved: boolean }
  | { kind: 'lane'; x0: number; y0: number; x1: number; y1: number; moved: boolean; keep: ID[] }
  | { kind: 'auto'; trackId: ID; curve: AutoKind; pointId: ID; top: number }
  | { kind: 'scroll'; x0: number; sx0: number };

function GroupHead({ row, move }: { row: GroupRow; move: MoveOk }) {
  const { group, members } = row;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  useEffect(() => setName(group.name), [group.name]);
  return (
    <div className="head group" style={{ height: row.height }}>
      <div className="head-color" style={{ background: group.color }} />
      <div className="head-body" style={{ height: row.height }}>
        <div className="row" style={{ gap: 4 }}>
          {editing ? (
            <input
              className="input" autoFocus value={name} aria-label="Group name" style={{ height: 22, padding: '0 6px', flex: 1, minWidth: 0 }}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => { setEditing(false); if (name.trim()) A.updateGroup(group.id, { name: name.trim() }); }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setName(group.name); setEditing(false); } }}
            />
          ) : (
            <button
              className="group-toggle grow" aria-expanded={!group.collapsed}
              title={group.collapsed ? 'Show the tracks in this group' : 'Hide the tracks in this group'}
              onClick={() => A.updateGroup(group.id, { collapsed: !group.collapsed }, true)}
            >{group.collapsed ? <ChevronRight /> : <ChevronDown />}<span className="head-name">{group.name}</span></button>
          )}
          {!editing && <span className="head-count num" title={members.map((t) => t.name).join(', ')}>{members.length}</span>}
          <Menu align="left" button={(toggle) => <button className="icon-btn sm" style={{ width: 22, height: 22 }} aria-label={`Options for group ${group.name}`} title="Group options" onClick={toggle}><Ellipsis /></button>}>
            {(close) => (
              <>
                <button className="menu-item" onClick={() => { setEditing(true); close(); }}>Rename</button>
                <button className="menu-item" onClick={() => A.updateGroup(group.id, { color: nextColor(group.color) })}><Palette />Next colour</button>
                <button className="menu-item" disabled={!move.up} onClick={() => { A.moveGroup(group.id, -1); close(); }}><ArrowUp />Move up</button>
                <button className="menu-item" disabled={!move.down} onClick={() => { A.moveGroup(group.id, 1); close(); }}><ArrowDown />Move down</button>
                <button className="menu-item" onClick={() => { A.ungroup(group.id); close(); }}><Ungroup />Ungroup (keep the tracks)</button>
              </>
            )}
          </Menu>
        </div>
        <div className="head-ctl">
          <button className={`ms m ${group.mute ? 'on' : ''}`} title="Mute the whole group" aria-label={`Mute group ${group.name}`} aria-pressed={group.mute} onClick={() => A.updateGroup(group.id, { mute: !group.mute })}>M</button>
          <button className={`ms s ${group.solo ? 'on' : ''}`} title="Solo the whole group" aria-label={`Solo group ${group.name}`} aria-pressed={group.solo} onClick={() => A.updateGroup(group.id, { solo: !group.solo })}>S</button>
          <Slider className="grow" label={`${group.name} group volume`} min={-48} max={12} step={0.5} value={group.volume} reset={0} onChange={(v) => A.updateGroup(group.id, { volume: v }, true)} />
        </div>
      </div>
    </div>
  );
}

function TrackHead({ row, selected, move, groups }: { row: Row; selected: boolean; move: MoveOk; groups: TrackGroup[] }) {
  const { track, lane, group } = row;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(track.name);
  useEffect(() => setName(track.name), [track.name]);
  const points = lane ? track.automation?.[lane] ?? [] : [];
  const automated = !!(track.automation?.volume?.length || track.automation?.pan?.length);
  return (
    <div className={`head ${selected ? 'sel' : ''} ${group ? 'grouped' : ''}`} style={{ height: row.height, ...(group ? { '--g': group.color } as React.CSSProperties : null) }} onPointerDown={() => A.selectTrack(track.id)}>
      <div className="head-color" style={{ background: track.color }} />
      <div style={{ minWidth: 0 }}>
        <div className="head-body" style={{ height: TRACK_H }}>
          <div className="row" style={{ gap: 4 }}>
            {editing ? (
              <input
                className="input" autoFocus value={name} aria-label="Track name" style={{ height: 22, padding: '0 6px', flex: 1 }}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => { setEditing(false); if (name.trim()) A.updateTrack(track.id, { name: name.trim() }); }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setName(track.name); setEditing(false); } }}
              />
            ) : (
              <span className="head-name grow" title="Double-click to rename" onDoubleClick={() => setEditing(true)}>{track.name}</span>
            )}
            <Menu align="left" button={(toggle) => <button className="icon-btn sm" style={{ width: 22, height: 22 }} aria-label={`Options for ${track.name}`} title="Track options" onClick={toggle}><Ellipsis /></button>}>
              {(close) => (
                <>
                  <button className="menu-item" onClick={() => { setEditing(true); close(); }}>Rename</button>
                  <button className="menu-item" onClick={() => { A.duplicateTrack(track.id); close(); }}><Copy />Duplicate</button>
                  <button className="menu-item" onClick={() => { A.updateTrack(track.id, { color: nextColor(track.color) }); }}><Palette />Next colour</button>
                  <button className="menu-item" disabled={!move.up} onClick={() => { A.moveTrack(track.id, -1); close(); }}><ArrowUp />Move up</button>
                  <button className="menu-item" disabled={!move.down} onClick={() => { A.moveTrack(track.id, 1); close(); }}><ArrowDown />Move down</button>
                  {!group && <button className="menu-item" onClick={() => { A.createGroup(track.id); close(); }}><Group />New group from this track</button>}
                  {groups.filter((g) => g.id !== group?.id).map((g) => (
                    <button key={g.id} className="menu-item" onClick={() => { A.setTrackGroup(track.id, g.id); close(); }}><FolderInput />Move to “{g.name}”</button>
                  ))}
                  {group && <button className="menu-item" onClick={() => { A.setTrackGroup(track.id, null); close(); }}><FolderOutput />Remove from “{group.name}”</button>}
                  <button className="menu-item danger" onClick={() => { A.removeTrack(track.id); close(); }}><Trash2 />Delete track</button>
                </>
              )}
            </Menu>
          </div>
          <div className="head-sound">{trackSound(track)}</div>
          <div className="head-ctl">
            <button className={`ms m ${track.mute ? 'on' : ''}`} title="Mute" aria-label={`Mute ${track.name}`} aria-pressed={track.mute} onClick={() => A.updateTrack(track.id, { mute: !track.mute })}>M</button>
            <button className={`ms s ${track.solo ? 'on' : ''}`} title="Solo" aria-label={`Solo ${track.name}`} aria-pressed={track.solo} onClick={() => A.updateTrack(track.id, { solo: !track.solo })}>S</button>
            <button
              className={`ms a ${lane ? 'on' : ''} ${automated ? 'has' : ''}`} aria-pressed={!!lane} aria-label={`Automation for ${track.name}`}
              title={lane ? 'Hide the automation lane' : automated ? 'Show automation (this track has some)' : 'Show automation: draw volume or pan changes over time'}
              onClick={() => A.toggleAutoLane(track.id)}
            >A</button>
            <Slider className="grow" label={`${track.name} volume`} min={-48} max={6} step={0.5} value={track.volume} reset={-8} onChange={(v) => A.updateTrack(track.id, { volume: v }, true)} />
          </div>
        </div>
        {lane && (
          <div className="head-lane" style={{ height: LANE_H }}>
            <div className="seg" role="group" aria-label="Automation curve">
              <button className={lane === 'volume' ? 'on' : ''} onClick={() => A.toggleAutoLane(track.id, 'volume')}>Volume</button>
              <button className={lane === 'pan' ? 'on' : ''} onClick={() => A.toggleAutoLane(track.id, 'pan')}>Pan</button>
            </div>
            <div className="row" style={{ gap: 4 }}>
              <span className="faint grow" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {points.length ? `${points.length} point${points.length === 1 ? '' : 's'}` : lane === 'volume' ? 'On top of the fader' : 'Added to the pan knob'}
              </span>
              <button className="btn sm ghost" style={{ height: 20, padding: '0 6px', fontSize: 11 }} disabled={!points.length} onClick={() => A.setAutomation(track.id, lane, [])}>Clear</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function Timeline({ headWidth = 216 }: { headWidth?: number }) {
  const project = useStore((s) => s.project);
  const ppb = useStore((s) => s.ui.pxPerBeat);
  const snap = useStore((s) => s.ui.snap);
  const tool = useStore((s) => s.ui.tool);
  const advanced = useStore((s) => s.ui.mode === 'advanced');
  const selectedTrackId = useStore((s) => s.ui.selectedTrackId);
  const selectedClipIds = useStore((s) => s.ui.selectedClipIds);
  const autoLanes = useStore((s) => s.ui.autoLanes);
  const recording = useStore((s) => s.recording);
  const [lanesRef, size] = useSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLElement>(null);
  const scroll = useRef({ x: 0, y: 0 });
  const [scrollY, setScrollY] = useState(0);
  const [dropping, setDropping] = useState(false);
  const drag = useRef<Drag | null>(null);
  const hoverPoint = useRef<ID | null>(null);
  const dirty = useRef(true);
  dirty.current = true;

  const groups = project.groups ?? NO_GROUPS;
  // Every visible row: a group's own row comes first, then its tracks (hidden while it is collapsed).
  const allRows = useMemo<AnyRow[]>(() => {
    const out: AnyRow[] = [];
    let y = 0, last: ID | undefined;
    for (const track of project.tracks) {
      const group = (track.groupId && groups.find((g) => g.id === track.groupId)) || null;
      if (group && last !== group.id) {
        out.push({ kind: 'group', group, members: project.tracks.filter((t) => t.groupId === group.id), top: y, height: GROUP_H });
        y += GROUP_H;
      }
      last = group?.id;
      if (group?.collapsed) continue;
      const lane = autoLanes[track.id] ?? null;
      const row: TrackRow = { kind: 'track', track, top: y, height: TRACK_H + (lane ? LANE_H : 0), lane, group };
      out.push(row);
      y += row.height;
    }
    return out;
  }, [project.tracks, groups, autoLanes]);
  const rows = useMemo(() => allRows.filter((r): r is TrackRow => r.kind === 'track'), [allRows]);
  const contentH = allRows.length ? allRows[allRows.length - 1].top + allRows[allRows.length - 1].height : 0;
  /** Whether each track and group can move up or down (a grouped track only moves inside its group). */
  const moves = useMemo(() => {
    const info = new Map<ID, MoveOk>();
    const blocks: Track[][] = [];
    for (const t of project.tracks) {
      const lastBlock = blocks[blocks.length - 1];
      if (t.groupId && lastBlock && lastBlock[0].groupId === t.groupId) lastBlock.push(t);
      else blocks.push([t]);
    }
    blocks.forEach((b, bi) => {
      const block = { up: bi > 0, down: bi < blocks.length - 1 };
      if (!b[0].groupId) { info.set(b[0].id, block); return; }
      info.set(b[0].groupId, block);
      b.forEach((t, i) => info.set(t.id, { up: i > 0, down: i < b.length - 1 }));
    });
    return info;
  }, [project.tracks]);
  const fadeCache = useRef<{ project: Project | null; map: Map<ID, ClipFades> }>({ project: null, map: new Map() });

  const S = useRef({ project, ppb, snap, tool, advanced, selectedTrackId, selectedClipIds, recording, size, rows, allRows, contentH });
  S.current = { project, ppb, snap, tool, advanced, selectedTrackId, selectedClipIds, recording, size, rows, allRows, contentH };

  const grid = () => snapValue(S.current.snap, S.current.project.timeSig);
  const total = () => maxBeats(S.current.project.bpm);
  const beatAt = (x: number) => (x + scroll.current.x) / S.current.ppb;
  const xOf = (beat: number) => beat * S.current.ppb - scroll.current.x;
  const snapped = (beat: number) => { const g = grid(); return Math.max(0, g > 0 ? snapBeat(beat, g) : beat); };
  /** Index of the track row at or below a canvas y (clamped to the first/last one). */
  const rowAt = (y: number): number => {
    const cy = y - RULER + scroll.current.y;
    const rs = S.current.rows;
    for (let i = 0; i < rs.length; i++) if (cy < rs[i].top + rs[i].height) return i;
    return rs.length - 1;
  };
  /** The track row under a canvas y, and whether y is in its automation lane. */
  const hitRow = (y: number): { row: Row; inLane: boolean } | null => {
    const cy = y - RULER + scroll.current.y;
    if (y < RULER) return null;
    const row = S.current.rows.find((r) => cy >= r.top && cy < r.top + r.height);
    return row ? { row, inLane: !!row.lane && cy - row.top >= TRACK_H } : null;
  };
  const hitGroup = (y: number): GroupRow | null => {
    const cy = y - RULER + scroll.current.y;
    if (y < RULER) return null;
    return S.current.allRows.find((r): r is GroupRow => r.kind === 'group' && cy >= r.top && cy < r.top + r.height) ?? null;
  };
  const laneTop = (row: Row) => RULER + row.top + TRACK_H - scroll.current.y;
  const laneY = (kind: AutoKind, v: number, top: number) => top + LANE_PAD + (1 - laneNorm(kind, v)) * (LANE_H - LANE_PAD * 2);
  const clampScroll = () => {
    const { size: sz, ppb: z, contentH: ch } = S.current;
    scroll.current.x = clamp(scroll.current.x, 0, Math.max(0, total() * z - sz.w + 40));
    const y = clamp(scroll.current.y, 0, Math.max(0, ch + RULER + 24 - sz.h));
    scroll.current.y = y;
    setScrollY(y);
  };

  const hitClip = (x: number, y: number): { clip: Clip; zone: Zone } | null => {
    const { project: p, ppb: z, advanced: adv, selectedClipIds: selIds } = S.current;
    const hit = hitRow(y);
    if (!hit || hit.inLane) return null;
    const beat = beatAt(x);
    for (let i = p.clips.length - 1; i >= 0; i--) {
      const c = p.clips[i];
      if (c.trackId !== hit.row.track.id) continue;
      const len = clipLengthBeats(c, p.bpm);
      if (beat < c.start || beat > c.start + len) continue;
      const w = len * z, dx = (beat - c.start) * z;
      const top = RULER + hit.row.top - scroll.current.y;
      if (adv && c.type === 'audio' && selIds.includes(c.id) && y - top < 18 && w > 40) {
        const fi = (c.fadeIn * p.bpm / 60) * z, fo = (c.fadeOut * p.bpm / 60) * z;
        if (Math.abs(dx - fi) < 8) return { clip: c, zone: 'fadeIn' };
        if (Math.abs(dx - (w - fo)) < 8) return { clip: c, zone: 'fadeOut' };
      }
      if (w > 18 && dx < EDGE) return { clip: c, zone: 'left' };
      if (w > 18 && w - dx < EDGE) return { clip: c, zone: 'right' };
      return { clip: c, zone: 'body' };
    }
    return null;
  };

  const hitPoint = (row: Row, x: number, y: number): AutoPoint | null => {
    if (!row.lane) return null;
    const top = laneTop(row);
    let best: AutoPoint | null = null, bestD = 9;
    for (const p of row.track.automation?.[row.lane] ?? []) {
      const d = Math.hypot(xOf(p.beat) - x, laneY(row.lane, p.value, top) - y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  };

  // ---- drawing ----
  const drawLane = (ctx: CanvasRenderingContext2D, row: Row, W: number) => {
    const kind = row.lane!;
    const top = laneTop(row);
    const pts = row.track.automation?.[kind] ?? [];
    const color = row.track.color;
    ctx.fillStyle = '#0c0c0e';
    ctx.fillRect(0, top, W, LANE_H - 1);
    const refY = Math.round(laneY(kind, 0, top));
    ctx.fillStyle = '#26262a';
    ctx.fillRect(0, refY, W, 1);
    ctx.font = '10px Inter Variable, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#6f6f76';
    if (kind === 'volume') { ctx.fillText('0 dB', 4, refY + 7); ctx.fillText('silent', 4, top + LANE_H - LANE_PAD - 2); }
    else { ctx.fillText('right', 4, top + LANE_PAD + 1); ctx.fillText('centre', 4, refY - 6); ctx.fillText('left', 4, top + LANE_H - LANE_PAD - 2); }

    const yAt = (beat: number) => laneY(kind, pts.length ? autoValueAt(pts, beat) : 0, top);
    ctx.beginPath();
    // Volume is straight in dB but the lane's scale is curved, so the line is sampled; pan is straight.
    const step = kind === 'volume' ? 4 : W;
    const xs = new Set<number>([0, W]);
    for (const p of pts) { const x = xOf(p.beat); if (x > 0 && x < W) xs.add(x); }
    if (kind === 'volume' && pts.length > 1) for (let x = step; x < W; x += step) xs.add(x);
    const sorted = [...xs].sort((a, b) => a - b);
    sorted.forEach((x, i) => { const y = yAt(beatAt(x)); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.strokeStyle = pts.length ? color : '#3a3a40';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (pts.length) {
      const base = kind === 'volume' ? top + LANE_H - 1 : refY;
      ctx.lineTo(W, base); ctx.lineTo(0, base); ctx.closePath();
      ctx.fillStyle = hexA(color, 0.12);
      ctx.fill();
    } else {
      ctx.fillStyle = '#96969c';
      ctx.font = '11px Inter Variable, system-ui, sans-serif';
      ctx.fillText(kind === 'volume' ? 'Click to add a point, then drag it to draw volume changes' : 'Click to add a point, then drag it to move the sound left or right', 56, top + LANE_H / 2 + 10);
    }
    const d = drag.current;
    for (const p of pts) {
      const x = xOf(p.beat);
      if (x < -6 || x > W + 6) continue;
      const y = laneY(kind, p.value, top);
      const active = (d?.kind === 'auto' && d.pointId === p.id) || hoverPoint.current === p.id;
      ctx.beginPath(); ctx.arc(x, y, active ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = active ? '#fff' : color; ctx.fill();
      ctx.strokeStyle = '#09090a'; ctx.lineWidth = 1; ctx.stroke();
      if (active) {
        const label = fmtAuto(kind, p.value);
        ctx.font = '11px Inter Variable, system-ui, sans-serif';
        const tw = ctx.measureText(label).width + 10;
        const lx = clamp(x + 9, 2, W - tw - 2), ly = clamp(y - 20, top + 2, top + LANE_H - 20);
        ctx.fillStyle = '#26262a'; ctx.beginPath(); ctx.roundRect(lx, ly, tw, 17, 4); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillText(label, lx + 5, ly + 9);
      }
    }
    ctx.fillStyle = '#1d1d20';
    ctx.fillRect(0, top + LANE_H - 1, W, 1);
  };

  const draw = () => {
    const canvas = canvasRef.current;
    const { project: p, ppb: z, size: sz, selectedTrackId: selTrack, selectedClipIds: selIds, advanced: adv, recording: rec, rows: rs, allRows: all } = S.current;
    if (fadeCache.current.project !== p) fadeCache.current = { project: p, map: effectiveFades(p) };
    const fades = fadeCache.current.map;
    if (!canvas || sz.w < 10 || sz.h < 10) return;
    const W = sz.w, H = sz.h;
    const ctx = fitCanvas(canvas, W, H);
    ctx.clearRect(0, 0, W, H);
    const sy = scroll.current.y;
    const bar = barBeats(p.timeSig), unit = 4 / p.timeSig[1];
    const b0 = beatAt(0), b1 = beatAt(W);
    const rowOf = new Map(rs.map((r) => [r.track.id, r]));

    for (const r of rs) {
      const y = RULER + r.top - sy;
      if (y > H || y + r.height < RULER) continue;
      if (r.track.id === selTrack) { ctx.fillStyle = '#0f0f11'; ctx.fillRect(0, y, W, TRACK_H); }
      ctx.fillStyle = '#1d1d20'; ctx.fillRect(0, y + TRACK_H - 1, W, 1);
    }

    const step = [unit / 4, unit / 2, unit, bar, bar * 2, bar * 4, bar * 8, bar * 16].find((s) => s * z >= 9) ?? bar * 32;
    const gridLines = () => {
      for (let b = Math.max(0, Math.floor(b0 / step) * step); b <= b1; b += step) {
        const isBar = Math.abs(b / bar - Math.round(b / bar)) < 1e-6;
        ctx.fillStyle = isBar ? '#26262a' : '#161618';
        ctx.fillRect(Math.round(xOf(b)), RULER, 1, H - RULER);
      }
    };
    gridLines();

    // group rows: a tinted band with a small overview of the clips inside the group
    for (const r of all) {
      if (r.kind !== 'group') continue;
      const y = RULER + r.top - sy;
      if (y > H || y + r.height < RULER) continue;
      ctx.fillStyle = '#0b0b0d'; ctx.fillRect(0, y, W, r.height - 1);
      ctx.fillStyle = hexA(r.group.color, 0.07); ctx.fillRect(0, y, W, r.height - 1);
      ctx.fillStyle = '#1d1d20'; ctx.fillRect(0, y + r.height - 1, W, 1);
      const lh = Math.min(9, (r.height - 14) / Math.max(1, r.members.length));
      const y0 = y + (r.height - lh * r.members.length) / 2;
      const dim = r.group.mute ? 0.4 : 1;
      r.members.forEach((t, i) => {
        for (const c of p.clips) {
          if (c.trackId !== t.id) continue;
          const x = xOf(c.start), w = Math.max(2, clipLengthBeats(c, p.bpm) * z);
          if (x > W || x + w < 0) continue;
          ctx.fillStyle = hexA(t.color, (c.muted || t.mute ? 0.2 : r.group.collapsed ? 0.8 : 0.4) * dim);
          ctx.fillRect(x, y0 + i * lh, Math.max(1, w - 1), Math.max(1, lh - 1.5));
        }
      });
    }

    // loop region
    const lx0 = xOf(p.loop.start), lx1 = xOf(p.loop.end);
    if (p.loop.on && p.loop.end > p.loop.start && lx1 > 0 && lx0 < W) { ctx.fillStyle = 'rgba(79,195,232,0.05)'; ctx.fillRect(lx0, RULER, lx1 - lx0, H - RULER); }

    // clips
    ctx.textBaseline = 'middle';
    ctx.font = '11px Inter Variable, system-ui, sans-serif';
    for (const c of p.clips) {
      const r = rowOf.get(c.trackId);
      if (!r) continue;
      const track = r.track;
      const y = RULER + r.top - sy + 3, h = TRACK_H - 7;
      const len = clipLengthBeats(c, p.bpm);
      const x = xOf(c.start), w = Math.max(2, len * z);
      if (x > W || x + w < 0 || y > H || y + h < RULER) continue;
      const sel = selIds.includes(c.id);
      ctx.save();
      ctx.beginPath(); ctx.rect(0, RULER, W, H - RULER); ctx.clip();
      ctx.globalAlpha = c.muted ? 0.35 : 1;
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 5);
      ctx.fillStyle = hexA(track.color, sel ? 0.3 : 0.18); ctx.fill();
      ctx.save();
      ctx.clip();
      if (c.type === 'audio') {
        const buf = engine.buffers.get(c.assetId);
        if (buf) drawWaveform(ctx, buf, x, y + 17, w, h - 20, c.offset, c.offset + c.length, hexA(track.color, 0.95), 0, W, Math.pow(10, c.gain / 20));
        // the fades the clip is really played with: its own, or an automatic crossfade into its neighbour
        const f = fades.get(c.id);
        const pps = (z * p.bpm) / 60;
        const wedge = (dur: number, cross: boolean, dir: 1 | -1) => {
          if (dur <= 0) return;
          const fw = Math.min(w, dur * pps), ex = dir === 1 ? x : x + w;
          ctx.beginPath(); ctx.moveTo(ex, y); ctx.lineTo(ex + dir * fw, y);
          // crossfades follow the equal-power curve they are played with
          if (cross) for (let k = 11; k >= 0; k--) ctx.lineTo(ex + dir * fw * (k / 12), y + h * (1 - Math.sin((Math.PI / 2) * (k / 12))));
          else ctx.lineTo(ex, y + h);
          ctx.closePath();
          ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fill();
          if (cross) { ctx.strokeStyle = hexA(track.color, 0.9); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(ex + dir * fw, y); for (let k = 11; k >= 0; k--) ctx.lineTo(ex + dir * fw * (k / 12), y + h * (1 - Math.sin((Math.PI / 2) * (k / 12)))); ctx.stroke(); }
        };
        if (f) { wedge(f.fadeIn, f.crossIn, 1); wedge(f.fadeOut, f.crossOut, -1); }
      } else if (c.notes.length) {
        let lo = 127, hi = 0;
        for (const n of c.notes) { if (n.pitch < lo) lo = n.pitch; if (n.pitch > hi) hi = n.pitch; }
        const span = Math.max(12, hi - lo);
        ctx.fillStyle = hexA(track.color, 0.95);
        for (const n of c.notes) {
          if (n.start < 0 || n.start >= c.length) continue;
          const nx = x + n.start * z;
          if (nx > W || nx + n.duration * z < 0) continue;
          ctx.fillRect(nx, y + 18 + (1 - (n.pitch - lo) / span) * (h - 26), Math.max(2, Math.min(n.duration, c.length - n.start) * z - 1), 3);
        }
      }
      ctx.fillStyle = '#f5f5f6';
      const made = c.type === 'audio' && c.proc ? [c.proc.tune ? 'tuned' : '', c.proc.stretch ? `${Math.round(100 / c.proc.stretch)}% speed` : ''].filter(Boolean).join(', ') : '';
      ctx.fillText(made ? `${c.name} · ${made}` : c.name, Math.max(x, 0) + 7, y + 9.5);
      ctx.restore();
      if (sel) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.roundRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5, 5); ctx.stroke();
        if (adv && c.type === 'audio' && w > 40) {
          const pps = (z * p.bpm) / 60;
          ctx.fillStyle = '#fff';
          for (const hx of [x + c.fadeIn * pps, x + w - c.fadeOut * pps]) { ctx.beginPath(); ctx.arc(clamp(hx, x + 5, x + w - 5), y + 6, 3.5, 0, Math.PI * 2); ctx.fill(); }
        }
      }
      ctx.restore();
    }

    // automation lanes
    ctx.save();
    ctx.beginPath(); ctx.rect(0, RULER, W, H - RULER); ctx.clip();
    for (const r of rs) {
      if (!r.lane) continue;
      const top = laneTop(r);
      if (top > H || top + LANE_H < RULER) continue;
      drawLane(ctx, r, W);
    }
    ctx.restore();

    // live recording
    if (rec) {
      const r = rowOf.get(rec.trackId);
      const now = engine.beat;
      if (r && now > rec.startBeat) {
        const y = RULER + r.top - sy + 3, h = TRACK_H - 7;
        const x = xOf(rec.startBeat), w = (now - rec.startBeat) * z;
        ctx.fillStyle = 'rgba(240,86,106,0.2)';
        ctx.beginPath(); ctx.roundRect(x, y, w, h, 5); ctx.fill();
        const sr = engine.sampleRate, block = 2048 / sr;
        const skip = Math.max(0, Math.floor((rec.ctxStart + mic.roundTripLatency() - mic.startTime) / block));
        ctx.fillStyle = '#f0566a';
        const pxPerBlock = block * (p.bpm / 60) * z;
        for (let i = skip; i < mic.peaks.length; i++) {
          const px = x + (i - skip) * pxPerBlock;
          if (px < -2 || px > W) continue;
          const a = Math.min(1, mic.peaks[i]) * (h / 2 - 4);
          ctx.fillRect(px, y + h / 2 - a, Math.max(1, pxPerBlock - 0.5), Math.max(1, a * 2));
        }
      }
    }

    // five-minute limit
    const xMax = xOf(total());
    if (xMax < W) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(xMax, RULER, W - xMax, H - RULER);
      ctx.fillStyle = '#47474e'; ctx.fillRect(xMax, 0, 1, H);
      ctx.fillStyle = '#96969c'; ctx.fillText('5:00 limit', xMax + 8, RULER + 14);
    }

    // markers through the lanes
    for (const m of p.markers) {
      const x = Math.round(xOf(m.beat));
      if (x < 0 || x > W) continue;
      ctx.fillStyle = 'rgba(242,179,61,0.35)'; ctx.fillRect(x, RULER, 1, H - RULER);
    }

    // ruler
    ctx.fillStyle = '#09090a'; ctx.fillRect(0, 0, W, RULER);
    ctx.fillStyle = '#1d1d20'; ctx.fillRect(0, RULER - 1, W, 1);
    if (p.loop.end > p.loop.start) {
      ctx.fillStyle = p.loop.on ? 'rgba(79,195,232,0.85)' : '#3a3a40';
      ctx.fillRect(lx0, RULER - 6, Math.max(2, lx1 - lx0), 5);
    }
    ctx.font = '11px Inter Variable, system-ui, sans-serif';
    const every = [1, 2, 4, 8, 16, 32].find((k) => k * bar * z >= 56) ?? 64;
    for (let k = Math.max(0, Math.floor(b0 / bar)); k * bar <= Math.min(b1, total()); k++) {
      const x = xOf(k * bar);
      ctx.fillStyle = '#34343a'; ctx.fillRect(Math.round(x), RULER - 12, 1, k % every === 0 ? 6 : 3);
      if (k % every === 0) {
        ctx.fillStyle = '#b6b6ba'; ctx.fillText(String(k + 1), x + 4, 9);
        if (every * bar * z >= 110) { ctx.fillStyle = '#6f6f76'; ctx.fillText(formatTime(beatsToSec(k * bar, p.bpm), false), x + 4 + ctx.measureText(String(k + 1)).width + 8, 9); }
      }
    }
    for (const m of p.markers) {
      const x = Math.round(xOf(m.beat));
      if (x < -80 || x > W) continue;
      ctx.fillStyle = '#f2b33d';
      ctx.beginPath(); ctx.moveTo(x, RULER - 1); ctx.lineTo(x, 12); ctx.lineTo(x + 7, 16); ctx.lineTo(x, 20); ctx.fill();
      ctx.fillText(m.name, x + 10, 16);
    }

    const d = drag.current;
    if (d?.kind === 'lane' && d.moved) {
      ctx.fillStyle = 'rgba(79,195,232,0.1)'; ctx.strokeStyle = '#4fc3e8'; ctx.lineWidth = 1;
      ctx.fillRect(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0);
      ctx.strokeRect(d.x0 + 0.5, d.y0 + 0.5, d.x1 - d.x0, d.y1 - d.y0);
    }
  };

  useFrame(() => {
    const { ppb: z, size: sz, recording: rec } = S.current;
    const beat = engine.beat;
    let x = beat * z - scroll.current.x;
    if (engine.playing && !drag.current && (x > sz.w - 24 || x < 0)) {
      scroll.current.x = Math.max(0, beat * z - 60);
      clampScroll();
      dirty.current = true;
      x = beat * z - scroll.current.x;
    }
    if (playheadRef.current) {
      playheadRef.current.style.transform = `translateX(${Math.round(x)}px)`;
      playheadRef.current.style.display = x < 0 || x > sz.w ? 'none' : 'block';
    }
    if (thumbRef.current && sz.w > 0) {
      const content = total() * z + 40;
      const tw = Math.max(28, (sz.w / content) * sz.w);
      thumbRef.current.style.width = `${Math.min(sz.w, tw)}px`;
      thumbRef.current.style.left = `${(scroll.current.x / Math.max(1, content - sz.w)) * (sz.w - tw)}px`;
      thumbRef.current.style.display = content <= sz.w ? 'none' : 'block';
    }
    if (dirty.current || rec) { dirty.current = false; draw(); }
  });

  // ---- pointer ----
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const moveAutoPoint = (d: Extract<Drag, { kind: 'auto' }>, x: number, y: number, free: boolean) => {
    const track = S.current.project.tracks.find((t) => t.id === d.trackId);
    if (!track) return;
    const pts = track.automation?.[d.curve] ?? [];
    const beat = clamp(free ? beatAt(x) : snapped(beatAt(x)), 0, total());
    const value = laneValue(d.curve, 1 - (y - d.top - LANE_PAD) / (LANE_H - LANE_PAD * 2));
    A.setAutomation(d.trackId, d.curve, pts.map((p) => (p.id === d.pointId ? { ...p, beat, value } : p)), true);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    const { project: p, selectedClipIds: selIds, tool: tl } = S.current;
    canvasRef.current?.setPointerCapture(e.pointerId);
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (y < RULER) {
      const marker = p.markers.find((m) => { const mx = xOf(m.beat); return x >= mx - 3 && x <= mx + 12 + m.name.length * 6 && y > 10; });
      if (marker) {
        if (e.button === 2 || e.altKey) A.removeMarker(marker.id);
        else A.seek(marker.beat);
        return;
      }
      drag.current = { kind: 'ruler', x0: x, beat0: snapped(beatAt(x)), moved: false };
      return;
    }
    const at = hitRow(y);
    if (at?.inLane && at.row.lane) {
      // automation lane: grab a point, or add one and keep dragging it
      const curve = at.row.lane;
      const track = at.row.track;
      const pts = track.automation?.[curve] ?? [];
      const hit = hitPoint(at.row, x, y);
      setUI({ selectedTrackId: track.id });
      if (hit && (e.button === 2 || e.altKey)) { A.setAutomation(track.id, curve, pts.filter((q) => q.id !== hit.id)); return; }
      beginGesture();
      const d: Extract<Drag, { kind: 'auto' }> = { kind: 'auto', trackId: track.id, curve, pointId: hit?.id ?? uid(), top: laneTop(at.row) };
      if (!hit) {
        const value = laneValue(curve, 1 - (y - d.top - LANE_PAD) / (LANE_H - LANE_PAD * 2));
        A.setAutomation(track.id, curve, [...pts, { id: d.pointId, beat: snapped(beatAt(x)), value }], true);
      }
      drag.current = d;
      return;
    }
    const row = rowAt(y);
    const track = at?.row.track;
    const hit = hitClip(x, y);
    if (hit) {
      const c = hit.clip;
      if (tl === 'split') { A.splitClips([c.id], snapped(beatAt(x))); return; }
      let ids = selIds;
      let isolate: ID | null = null;
      if (e.shiftKey) ids = ids.includes(c.id) ? ids.filter((i) => i !== c.id) : [...ids, c.id];
      else if (!ids.includes(c.id)) ids = [c.id];
      else if (ids.length > 1) isolate = c.id;
      setUI({ selectedClipIds: ids, selectedTrackId: c.trackId });
      if (hit.zone === 'left' || hit.zone === 'right') { beginGesture(); drag.current = { kind: hit.zone === 'left' ? 'trimL' : 'trimR', id: c.id }; return; }
      if (hit.zone === 'fadeIn' || hit.zone === 'fadeOut') { beginGesture(); drag.current = { kind: hit.zone, id: c.id }; return; }
      beginGesture();
      let anchor = c.id;
      if (e.altKey && ids.length) {
        const copies = A.duplicateClips(ids, true);
        anchor = copies[ids.indexOf(c.id)] ?? copies[0];
        ids = copies;
        isolate = null;
        setUI({ selectedClipIds: copies });
      }
      const now = useStore.getState().project;
      const base = new Map<ID, { start: number; row: number; trackId: ID }>();
      for (const id of ids) {
        const cl = now.clips.find((k) => k.id === id);
        // rows are the visible track rows; a clip on a track hidden inside a collapsed group keeps its track
        if (cl) base.set(id, { start: cl.start, row: S.current.rows.findIndex((r) => r.track.id === cl.trackId), trackId: cl.trackId });
      }
      drag.current = { kind: 'move', x0: x, row0: row, anchor, base, moved: false, isolate };
      return;
    }
    if (track) setUI({ selectedTrackId: track.id });
    drag.current = { kind: 'lane', x0: x, y0: y, x1: x, y1: y, moved: false, keep: e.shiftKey ? selIds : [] };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    const d = drag.current;
    const cv = canvasRef.current;
    const { project: p, tool: tl } = S.current;
    if (!d) {
      const at = hitRow(y);
      const point = at?.inLane ? hitPoint(at.row, x, y) : null;
      if ((point?.id ?? null) !== hoverPoint.current) { hoverPoint.current = point?.id ?? null; dirty.current = true; }
      if (cv) {
        const hit = at?.inLane ? null : hitClip(x, y);
        cv.style.cursor = y < RULER ? 'text' : at?.inLane ? (point ? 'grab' : 'crosshair')
          : tl === 'split' && hit ? 'col-resize' : !hit ? 'default' : hit.zone === 'body' ? 'grab' : hit.zone === 'left' || hit.zone === 'right' ? 'ew-resize' : 'pointer';
      }
      return;
    }
    dirty.current = true;
    if (d.kind === 'auto') { moveAutoPoint(d, x, y, e.shiftKey); return; }
    if (d.kind === 'ruler') {
      if (Math.abs(x - d.x0) > 4 && !d.moved) { d.moved = true; beginGesture(); }
      if (d.moved) {
        const b = snapped(beatAt(x));
        const start = Math.min(d.beat0, b), end = Math.max(d.beat0, b);
        if (end - start > 0.01) A.setLoop({ start, end, on: true }, true);
      }
      return;
    }
    if (d.kind === 'lane') {
      d.x1 = x; d.y1 = y;
      if (Math.hypot(x - d.x0, y - d.y0) > 5) d.moved = true;
      if (d.moved) {
        const bA = beatAt(Math.min(d.x0, x)), bB = beatAt(Math.max(d.x0, x));
        const cyA = Math.min(d.y0, y) - RULER + scroll.current.y, cyB = Math.max(d.y0, y) - RULER + scroll.current.y;
        const inBox = new Set(S.current.rows.filter((r) => r.top < cyB && r.top + TRACK_H > cyA).map((r) => r.track.id));
        const ids = new Set(d.keep);
        for (const c of p.clips) {
          if (inBox.has(c.trackId) && c.start < bB && c.start + clipLengthBeats(c, p.bpm) > bA) ids.add(c.id);
        }
        setUI({ selectedClipIds: [...ids] });
      }
      return;
    }
    if (d.kind === 'trimL') { A.trimClipStart(d.id, snapped(beatAt(x)), true); return; }
    if (d.kind === 'trimR') { A.trimClipEnd(d.id, snapped(beatAt(x)), true); return; }
    if (d.kind === 'fadeIn' || d.kind === 'fadeOut') {
      const c = p.clips.find((k) => k.id === d.id);
      if (!c || c.type !== 'audio') return;
      const sec = beatsToSec(beatAt(x) - c.start, p.bpm);
      if (d.kind === 'fadeIn') A.updateClip(c.id, { fadeIn: clamp(sec, 0, c.length - c.fadeOut) }, true);
      else A.updateClip(c.id, { fadeOut: clamp(c.length - sec, 0, c.length - c.fadeIn) }, true);
      return;
    }
    if (d.kind === 'move') {
      const a = d.base.get(d.anchor);
      if (!a) return;
      const minStart = Math.min(...[...d.base.values()].map((v) => v.start));
      const delta = Math.max(-minStart, snapped(a.start + (x - d.x0) / S.current.ppb) - a.start);
      const dRow = rowAt(y) - d.row0;
      if (delta !== 0 || dRow !== 0) d.moved = true;
      if (!d.moved) return;
      const vis = S.current.rows;
      A.placeClips([...d.base.entries()].map(([id, v]) => ({ id, start: v.start + delta, trackId: v.row < 0 || !vis.length ? v.trackId : vis[clamp(v.row + dRow, 0, vis.length - 1)].track.id })), true);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    dirty.current = true;
    if (!d) return;
    const { x } = local(e);
    if (d.kind === 'ruler') { if (d.moved) endGesture(); else A.seek(snapped(beatAt(x))); return; }
    if (d.kind === 'lane') { if (!d.moved) { A.seek(snapped(beatAt(x))); if (!d.keep.length) setUI({ selectedClipIds: [] }); } return; }
    if (d.kind === 'scroll') return;
    if (d.kind === 'move' && !d.moved && d.isolate) setUI({ selectedClipIds: [d.isolate] });
    endGesture();
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const { x, y } = local(e);
    const at = hitRow(y);
    if (at?.inLane && at.row.lane) {
      const hit = hitPoint(at.row, x, y);
      if (hit) A.setAutomation(at.row.track.id, at.row.lane, (at.row.track.automation?.[at.row.lane] ?? []).filter((q) => q.id !== hit.id));
      return;
    }
    const hit = hitClip(x, y);
    if (hit) { A.openClip(hit.clip.id); return; }
    const band = hitGroup(y);
    if (band) { A.updateGroup(band.group.id, { collapsed: !band.group.collapsed }, true); return; }
    const p = S.current.project;
    if (at && at.row.track.kind === 'instrument') {
      const bar = barBeats(p.timeSig);
      const id = A.addMidiClip(at.row.track.id, Math.floor(beatAt(x) / bar) * bar);
      A.openClip(id);
    }
  };

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { ppb: z, size: sz } = S.current;
      if (e.ctrlKey || e.metaKey) {
        const x = e.clientX - el.getBoundingClientRect().left;
        const beat = (x + scroll.current.x) / z;
        const next = clamp(z * Math.exp(-e.deltaY * 0.004), Math.max(0.8, (sz.w - 40) / total()), 2400);
        S.current.ppb = next;
        scroll.current.x = beat * next - x;
        setUI({ pxPerBeat: next });
      } else {
        scroll.current.x += e.shiftKey ? e.deltaY : e.deltaX;
        if (!e.shiftKey) scroll.current.y += e.deltaY;
      }
      clampScroll();
      dirty.current = true;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  useEffect(() => { clampScroll(); /* keep the view valid when zoom, size or the rows change */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ppb, size.w, size.h, contentH, project.bpm]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    const { x, y } = local(e);
    const beat = snapped(beatAt(x));
    const track = hitRow(y)?.row.track;
    const audio = files.filter((f) => f.type.startsWith('audio/') || /\.(wav|mp3|flac|ogg|m4a|aac|aiff?)$/i.test(f.name));
    const midi = files.filter((f) => /\.midi?$/i.test(f.name));
    if (audio.length) void A.importAudioFiles(audio, beat, track?.kind === 'audio' ? track.id : undefined);
    midi.forEach((f) => void A.importMidi(f));
    if (!audio.length && !midi.length) toast('Drop audio (WAV, MP3, FLAC, OGG, M4A) or MIDI files here.', 'info');
  };

  const thumbDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { kind: 'scroll', x0: e.clientX, sx0: scroll.current.x };
  };
  const thumbMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d?.kind !== 'scroll') return;
    const { size: sz, ppb: z } = S.current;
    const content = total() * z + 40;
    const tw = Math.max(28, (sz.w / content) * sz.w);
    scroll.current.x = d.sx0 + ((e.clientX - d.x0) / Math.max(1, sz.w - tw)) * (content - sz.w);
    clampScroll();
    dirty.current = true;
  };

  return (
    <div className="timeline">
      <div className={`heads ${headWidth < 180 ? 'narrow' : ''}`} style={{ width: headWidth }}>
        <div className="heads-top" style={{ height: RULER }}>{project.tracks.length} track{project.tracks.length === 1 ? '' : 's'}</div>
        <div className="heads-scroll">
          <div style={{ transform: `translateY(${-scrollY}px)` }}>
            {allRows.map((r) => (r.kind === 'group'
              ? <GroupHead key={r.group.id} row={r} move={moves.get(r.group.id) ?? { up: false, down: false }} />
              : <TrackHead key={r.track.id} row={r} groups={groups} move={moves.get(r.track.id) ?? { up: false, down: false }} selected={r.track.id === selectedTrackId} />))}
          </div>
        </div>
      </div>
      <div
        ref={lanesRef} className="lanes"
        onDragOver={(e) => { e.preventDefault(); setDropping(true); }} onDragLeave={() => setDropping(false)} onDrop={onDrop}
      >
        <canvas
          ref={canvasRef} aria-label="Timeline. Drag clips to move them, drag their edges to trim, double-click a clip to edit it. In an automation lane, click to add a point and drag points to shape the curve."
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          onPointerLeave={() => { if (hoverPoint.current) { hoverPoint.current = null; dirty.current = true; } }}
          onDoubleClick={onDoubleClick} onContextMenu={(e) => e.preventDefault()}
        />
        <div ref={playheadRef} className="playhead" />
        <div className="hscroll"><i ref={thumbRef} onPointerDown={thumbDown} onPointerMove={thumbMove} onPointerUp={() => { drag.current = null; }} /></div>
        {dropping && <div className="drop-hint">Drop audio or MIDI files to import them here</div>}
        {project.tracks.length === 0 && (
          <div style={{ position: 'absolute', inset: `${RULER + 20}px 20px auto 20px` }} className="empty">
            This project has no tracks yet. Add an instrument or audio track from the toolbar, or drop an audio file here.
          </div>
        )}
      </div>
    </div>
  );
}

export function timelineContentBeats(p: Project): number { return maxBeats(p.bpm); }
