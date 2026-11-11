import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Combine, MousePointer2, Pencil, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import type { Note } from '../types';
import { drawWaveform, fitCanvas } from '../lib/peaks';
import { NOTE_NAMES, SCALES, barBeats, clamp, floorBeat, inScale, isBlackKey, midiToName, snapBeat, snapToScale, uid, type Key } from '../lib/music';
import { useFrame, useSize } from './ui';

// A canvas piano roll. It is fully controlled: the parent owns the notes, so the same
// editor works on a project clip and on a not-yet-inserted transcription.

export interface PianoRollProps {
  viewKey: string; // changes when a different clip is shown (resets scroll and selection)
  notes: Note[];
  length: number; // beats
  color: string;
  snap: number; // beats, 0 = free
  timeSig: [number, number];
  musicKey: Key;
  onChange: (notes: Note[], live: boolean) => void;
  onGestureStart: () => void;
  onGestureEnd: () => void;
  onAudition: (pitch: number, velocity: number) => void;
  onLength?: (length: number, live: boolean) => void;
  range?: [number, number];
  drumRows?: { pitch: number; label: string }[];
  getPlayhead?: () => number | null;
  onSeek?: (beat: number) => void;
  backdrop?: { buffer: AudioBuffer; offsetSec: number; bpm: number } | null;
  advanced?: boolean;
  toolbar?: ReactNode;
}

type Drag =
  | { kind: 'move'; beat0: number; row0: number; anchor: Note; base: Note[]; ids: Set<string>; moved: boolean; isolate: string | null; lastPitch: number }
  | { kind: 'resize'; beat0: number; base: Note[]; ids: Set<string> }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; keep: Set<string> }
  | { kind: 'velocity' }
  | { kind: 'seek' }
  | { kind: 'length' }
  | { kind: 'keys'; last: number };

let noteClipboard: Note[] = [];
const TOP = 108, BOTTOM = 21;

export function PianoRoll(props: PianoRollProps) {
  const P = useRef(props);
  P.current = props;
  const [wrapRef, size] = useSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const selRef = useRef(sel);
  selRef.current = sel;
  const [tool, setTool] = useState<'draw' | 'select'>('draw');
  const [showScale, setShowScale] = useState(true);
  const [snapScale, setSnapScale] = useState(false);
  const view = useRef({ sx: 0, sy: 0, ppb: 56 });
  const drag = useRef<Drag | null>(null);
  const dirty = useRef(true);
  const lastPlayhead = useRef<number | null>(null);
  const lastLen = useRef(0);
  dirty.current = true;

  const drum = !!props.drumRows;
  const ROW = drum ? 22 : 16;
  const KEY_W = drum ? 96 : 54;
  const RULER = 22;
  const BACK = props.backdrop ? 46 : 0;
  const VEL = props.advanced === false ? 0 : 56;
  const gridTop = RULER + BACK;
  const rows = drum ? props.drumRows!.length : TOP - BOTTOM + 1;
  const gridH = Math.max(0, size.h - gridTop - VEL);
  const gridW = Math.max(0, size.w - KEY_W);

  const rowOf = (pitch: number): number => (drum ? props.drumRows!.findIndex((r) => r.pitch === pitch) : TOP - pitch);
  const pitchOf = (row: number): number => (drum ? props.drumRows![clamp(row, 0, rows - 1)].pitch : clamp(TOP - row, BOTTOM, TOP));
  const beatToX = (b: number) => KEY_W + b * view.current.ppb - view.current.sx;
  const xToBeat = (x: number) => (x - KEY_W + view.current.sx) / view.current.ppb;
  const rowToY = (r: number) => gridTop + r * ROW - view.current.sy;
  const yToRow = (y: number) => Math.floor((y - gridTop + view.current.sy) / ROW);
  const clampView = () => {
    const v = view.current;
    v.sx = clamp(v.sx, 0, Math.max(0, (P.current.length + 8) * v.ppb - gridW));
    v.sy = clamp(v.sy, 0, Math.max(0, rows * ROW - gridH));
  };

  // Reset the view when a different clip is opened: scroll to the notes (or around middle C).
  useEffect(() => {
    setSel(new Set());
    const ns = props.notes;
    const mid = ns.length ? ns.map((n) => n.pitch).sort((a, b) => a - b)[ns.length >> 1] : 62;
    view.current.sx = 0;
    view.current.sy = drum ? 0 : (TOP - mid) * ROW - gridH / 2;
    clampView();
    dirty.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.viewKey, gridH > 0]);

  const noteAt = (x: number, y: number): Note | null => {
    const beat = xToBeat(x), row = yToRow(y);
    const ns = P.current.notes;
    for (let i = ns.length - 1; i >= 0; i--) {
      const n = ns[i];
      if (rowOf(n.pitch) === row && beat >= n.start && beat <= n.start + Math.max(n.duration, 3 / view.current.ppb)) return n;
    }
    return null;
  };

  // ---- drawing ----
  const draw = (playhead: number | null) => {
    const canvas = canvasRef.current;
    if (!canvas || size.w < 10 || size.h < 10) return;
    const { notes, length, color, timeSig, musicKey, range, backdrop } = P.current;
    const { ppb } = view.current;
    const W = size.w, H = size.h;
    const ctx = fitCanvas(canvas, W, H);
    ctx.clearRect(0, 0, W, H);
    const selected = selRef.current;
    const r0 = Math.max(0, yToRow(gridTop)), r1 = Math.min(rows - 1, yToRow(gridTop + gridH));

    ctx.save();
    ctx.beginPath();
    ctx.rect(KEY_W, gridTop, gridW, gridH);
    ctx.clip();
    for (let r = r0; r <= r1; r++) {
      const p = pitchOf(r), y = rowToY(r);
      const scaleOn = showScale && !drum && musicKey.scale !== 'chromatic';
      const inKey = !scaleOn || inScale(p, musicKey);
      ctx.fillStyle = drum ? (r % 2 ? '#101012' : '#131315') : !inKey ? '#0b0b0c' : isBlackKey(p) ? '#101012' : '#141416';
      ctx.fillRect(KEY_W, y, gridW, ROW);
      if (scaleOn && ((p - musicKey.root) % 12 + 12) % 12 === 0) { ctx.fillStyle = 'rgba(143,124,247,0.09)'; ctx.fillRect(KEY_W, y, gridW, ROW); }
      if (range && (p < range[0] || p > range[1])) { ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(KEY_W, y, gridW, ROW); }
      ctx.fillStyle = !drum && p % 12 === 0 ? '#2a2a2f' : '#19191c';
      ctx.fillRect(KEY_W, y + ROW - 1, gridW, 1);
    }
    // vertical grid
    const bar = barBeats(timeSig), unit = 4 / timeSig[1];
    const fine = P.current.snap > 0 ? P.current.snap : unit / 4;
    const step = [fine, unit, bar, bar * 2, bar * 4].find((s) => s * ppb >= 7) ?? bar * 8;
    const b0 = Math.floor(xToBeat(KEY_W) / step) * step, b1 = xToBeat(W);
    for (let b = Math.max(0, b0); b <= b1; b += step) {
      const x = Math.round(beatToX(b));
      const isBar = Math.abs(b / bar - Math.round(b / bar)) < 1e-6;
      const isBeat = Math.abs(b / unit - Math.round(b / unit)) < 1e-6;
      ctx.fillStyle = isBar ? '#3a3a41' : isBeat ? '#242428' : '#1a1a1d';
      ctx.fillRect(x, gridTop, 1, gridH);
    }
    const xEnd = beatToX(length);
    if (xEnd < W) { ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(Math.max(KEY_W, xEnd), gridTop, W - xEnd, gridH); }
    // notes
    ctx.font = '10px Inter Variable, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const n of notes) {
      const r = rowOf(n.pitch);
      if (r < r0 || r > r1) continue;
      const x = beatToX(n.start), w = Math.max(3, n.duration * ppb - 1);
      if (x + w < KEY_W || x > W) continue;
      const y = rowToY(r) + 1, h = ROW - 2;
      const outside = n.start < 0 || n.start >= length;
      ctx.globalAlpha = (0.42 + 0.58 * n.velocity) * (outside ? 0.3 : 1);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (selected.has(n.id)) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
      if (!drum && w > 30) { ctx.fillStyle = 'rgba(0,0,0,0.72)'; ctx.fillText(midiToName(n.pitch), x + 4, y + h / 2 + 0.5); }
    }
    const d = drag.current;
    if (d?.kind === 'marquee') {
      ctx.fillStyle = 'rgba(79,195,232,0.12)'; ctx.strokeStyle = '#4fc3e8'; ctx.lineWidth = 1;
      ctx.fillRect(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0);
      ctx.strokeRect(d.x0 + 0.5, d.y0 + 0.5, d.x1 - d.x0, d.y1 - d.y0);
    }
    ctx.restore();

    // velocity lane
    if (VEL) {
      const top = H - VEL;
      ctx.fillStyle = '#0c0c0e'; ctx.fillRect(KEY_W, top, gridW, VEL);
      ctx.fillStyle = '#1d1d20'; ctx.fillRect(0, top, W, 1);
      ctx.save(); ctx.beginPath(); ctx.rect(KEY_W, top, gridW, VEL); ctx.clip();
      for (const n of notes) {
        const x = beatToX(n.start);
        if (x < KEY_W - 4 || x > W) continue;
        const h = Math.max(2, n.velocity * (VEL - 10));
        ctx.fillStyle = selected.has(n.id) ? '#fff' : color;
        ctx.fillRect(x, H - 4 - h, 3, h);
        ctx.beginPath(); ctx.arc(x + 1.5, H - 4 - h, 3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      ctx.fillStyle = '#0c0c0e'; ctx.fillRect(0, top + 1, KEY_W, VEL);
      ctx.fillStyle = '#96969c'; ctx.font = '11px Inter Variable, system-ui, sans-serif'; ctx.textBaseline = 'middle';
      ctx.fillText('Velocity', 6, top + VEL / 2);
    }

    // original recording lane
    if (backdrop && BACK) {
      ctx.fillStyle = '#0c0c0e'; ctx.fillRect(KEY_W, RULER, gridW, BACK);
      const spb = 60 / backdrop.bpm;
      const t0 = xToBeat(KEY_W) * spb + backdrop.offsetSec, t1 = xToBeat(W) * spb + backdrop.offsetSec;
      const a = Math.max(0, t0), b = Math.min(backdrop.buffer.duration, t1);
      if (b > a) {
        const xa = KEY_W + ((a - t0) / (t1 - t0)) * gridW, xb = KEY_W + ((b - t0) / (t1 - t0)) * gridW;
        drawWaveform(ctx, backdrop.buffer, xa, RULER + 3, xb - xa, BACK - 6, a, b, '#4fc3e8', KEY_W, W);
      }
      ctx.fillStyle = '#0c0c0e'; ctx.fillRect(0, RULER, KEY_W, BACK);
      ctx.fillStyle = '#96969c'; ctx.font = '11px Inter Variable, system-ui, sans-serif'; ctx.textBaseline = 'middle';
      ctx.fillText(drum ? 'Recording' : 'Audio', 6, RULER + BACK / 2);
      ctx.fillStyle = '#1d1d20'; ctx.fillRect(0, RULER + BACK - 1, W, 1);
    }

    // ruler
    ctx.fillStyle = '#0c0c0e'; ctx.fillRect(0, 0, W, RULER);
    ctx.fillStyle = '#1d1d20'; ctx.fillRect(0, RULER - 1, W, 1);
    ctx.font = '11px Inter Variable, system-ui, sans-serif'; ctx.textBaseline = 'middle';
    const labelEvery = [1, 2, 4, 8, 16].find((k) => k * bar * ppb >= 44) ?? 32;
    for (let k = Math.max(0, Math.floor(xToBeat(KEY_W) / bar)); k * bar <= b1; k++) {
      const x = beatToX(k * bar);
      if (x < KEY_W - 1) continue;
      ctx.fillStyle = '#3a3a41'; ctx.fillRect(Math.round(x), RULER - 7, 1, 6);
      if (k % labelEvery === 0) { ctx.fillStyle = '#96969c'; ctx.fillText(String(k + 1), x + 4, RULER / 2 - 1); }
    }
    if (xEnd >= KEY_W && xEnd <= W) { ctx.fillStyle = '#b6b6ba'; ctx.fillRect(Math.round(xEnd) - 1, 0, 3, RULER); }

    // keys
    ctx.save(); ctx.beginPath(); ctx.rect(0, gridTop, KEY_W, gridH); ctx.clip();
    ctx.font = '10px Inter Variable, system-ui, sans-serif';
    for (let r = r0; r <= r1; r++) {
      const p = pitchOf(r), y = rowToY(r);
      const off = range && (p < range[0] || p > range[1]);
      if (drum) {
        ctx.fillStyle = '#151517'; ctx.fillRect(0, y, KEY_W - 1, ROW - 1);
        ctx.fillStyle = '#b6b6ba'; ctx.font = '11px Inter Variable, system-ui, sans-serif';
        ctx.fillText(P.current.drumRows![r].label, 8, y + ROW / 2);
      } else {
        const black = isBlackKey(p);
        ctx.fillStyle = black ? '#17171a' : off ? '#77777e' : '#e3e3e7';
        ctx.fillRect(0, y, black ? KEY_W * 0.62 : KEY_W - 1, ROW - (black ? 0 : 1));
        if (p % 12 === 0) { ctx.fillStyle = '#3d3d44'; ctx.fillText(`C${Math.floor(p / 12) - 1}`, KEY_W - 24, y + ROW / 2 + 0.5); }
      }
    }
    ctx.restore();
    ctx.fillStyle = '#0c0c0e'; ctx.fillRect(0, 0, KEY_W, RULER);

    if (playhead !== null) {
      const x = beatToX(playhead);
      if (x >= KEY_W && x <= W) { ctx.fillStyle = '#fff'; ctx.fillRect(Math.round(x), 0, 1, H); }
    }
  };

  useFrame(() => {
    const ph = P.current.getPlayhead?.() ?? null;
    if (ph !== null && ph !== lastPlayhead.current && !drag.current) {
      const x = beatToX(ph);
      if (x > size.w - 16 || x < KEY_W - 1) { view.current.sx = Math.max(0, ph * view.current.ppb - 40); clampView(); dirty.current = true; }
    }
    if (dirty.current || ph !== lastPlayhead.current) {
      lastPlayhead.current = ph;
      dirty.current = false;
      draw(ph);
    }
  });

  // ---- editing helpers ----
  const fitPitch = (p: number): number => (snapScale && !drum ? snapToScale(p, P.current.musicKey) : p);
  const targets = (): Note[] => (selRef.current.size ? P.current.notes.filter((n) => selRef.current.has(n.id)) : P.current.notes);
  const edit = (fn: (n: Note) => Note | null, onlySelected = true): void => {
    const ids = selRef.current;
    const all = onlySelected && ids.size === 0;
    const next = P.current.notes.flatMap((n) => { if (!all && onlySelected && !ids.has(n.id)) return [n]; const r = fn(n); return r ? [r] : []; });
    P.current.onChange(next, false);
    dirty.current = true;
  };
  const removeSelected = () => { if (selRef.current.size) { edit(() => null); setSel(new Set()); } };
  const transpose = (d: number) => edit((n) => {
    if (drum) { const r = clamp(rowOf(n.pitch) - Math.sign(d), 0, rows - 1); return { ...n, pitch: pitchOf(r) }; }
    return { ...n, pitch: clamp(n.pitch + d, BOTTOM, TOP) };
  });
  const quantize = () => { const g = P.current.snap || 0.25; edit((n) => ({ ...n, start: Math.max(0, snapBeat(n.start, g)), duration: Math.max(g, snapBeat(n.duration, g)) })); };
  const toScale = () => edit((n) => ({ ...n, pitch: snapToScale(n.pitch, P.current.musicKey) }));
  const setVelocity = (v: number) => {
    const ids = selRef.current;
    P.current.onChange(P.current.notes.map((n) => (ids.has(n.id) ? { ...n, velocity: v } : n)), true);
  };
  /** Combine selected notes of the same pitch that touch or overlap into single longer notes. */
  const combine = () => {
    const ids = selRef.current;
    const chosen = P.current.notes.filter((n) => ids.has(n.id)).sort((a, b) => a.pitch - b.pitch || a.start - b.start);
    const merged: Note[] = [];
    for (const n of chosen) {
      const last = merged[merged.length - 1];
      if (last && last.pitch === n.pitch && n.start <= last.start + last.duration + 0.26) last.duration = Math.max(last.duration, n.start + n.duration - last.start);
      else merged.push({ ...n });
    }
    P.current.onChange([...P.current.notes.filter((n) => !ids.has(n.id)), ...merged], false);
    setSel(new Set(merged.map((n) => n.id)));
  };
  const zoom = (factor: number, aroundX = KEY_W + gridW / 2) => {
    const beat = xToBeat(aroundX);
    view.current.ppb = clamp(view.current.ppb * factor, 6, 640);
    view.current.sx = beat * view.current.ppb - (aroundX - KEY_W);
    clampView();
    dirty.current = true;
  };

  // ---- pointer ----
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    wrapRef.current?.focus();
    canvasRef.current?.setPointerCapture(e.pointerId);
    const p = P.current;
    const grid = p.snap;
    if (y < RULER) {
      if (p.onLength && Math.abs(x - beatToX(p.length)) < 7) { p.onGestureStart(); drag.current = { kind: 'length' }; }
      else if (x >= KEY_W && p.onSeek) { drag.current = { kind: 'seek' }; p.onSeek(Math.max(0, xToBeat(x))); }
      return;
    }
    if (y < gridTop) { if (x >= KEY_W && p.onSeek) { drag.current = { kind: 'seek' }; p.onSeek(Math.max(0, xToBeat(x))); } return; }
    if (VEL && y > size.h - VEL) { if (x >= KEY_W) { p.onGestureStart(); drag.current = { kind: 'velocity' }; onPointerMove(e); } return; }
    if (x < KEY_W) { const pitch = pitchOf(yToRow(y)); p.onAudition(pitch, 0.8); drag.current = { kind: 'keys', last: pitch }; return; }

    const hit = noteAt(x, y);
    if (hit && (e.button === 2)) {
      p.onChange(p.notes.filter((n) => n.id !== hit.id), false);
      return;
    }
    if (hit) {
      let ids = new Set(selRef.current);
      let isolate: string | null = null;
      if (e.shiftKey) { if (ids.has(hit.id)) ids.delete(hit.id); else ids.add(hit.id); }
      else if (!ids.has(hit.id)) ids = new Set([hit.id]);
      else if (ids.size > 1) isolate = hit.id;
      let base = p.notes;
      let anchor = hit;
      p.onGestureStart();
      if (e.altKey) {
        // duplicate the selection and drag the copies
        const copies = p.notes.filter((n) => ids.has(n.id)).map((n) => ({ ...n, id: uid() }));
        anchor = copies[p.notes.filter((n) => ids.has(n.id)).findIndex((n) => n.id === hit.id)] ?? copies[0];
        base = [...p.notes, ...copies];
        ids = new Set(copies.map((n) => n.id));
        isolate = null;
        p.onChange(base, true);
      }
      setSel(ids);
      const edge = beatToX(hit.start + hit.duration) - x;
      if (edge < 7 && hit.duration * view.current.ppb > 12 && !e.altKey && !drum) drag.current = { kind: 'resize', beat0: xToBeat(x), base, ids };
      else {
        drag.current = { kind: 'move', beat0: xToBeat(x), row0: yToRow(y), anchor, base, ids, moved: false, isolate, lastPitch: hit.pitch };
        p.onAudition(hit.pitch, hit.velocity);
      }
      return;
    }
    if (tool === 'select' || e.shiftKey) {
      drag.current = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y, keep: e.shiftKey ? new Set(selRef.current) : new Set() };
      if (!e.shiftKey) setSel(new Set());
      return;
    }
    // draw a new note and keep dragging to set its length
    const beat = Math.max(0, grid > 0 ? floorBeat(xToBeat(x), grid) : xToBeat(x));
    const pitch = fitPitch(pitchOf(yToRow(y)));
    const duration = drum ? Math.max(grid || 0.25, 0.125) : lastLen.current || (grid > 0 ? Math.max(grid, 0.5) : 0.5);
    const note: Note = { id: uid(), pitch, start: beat, duration, velocity: 0.8 };
    p.onGestureStart();
    const base = [...p.notes, note];
    p.onChange(base, true);
    p.onAudition(pitch, 0.8);
    setSel(new Set([note.id]));
    drag.current = drum
      ? { kind: 'move', beat0: xToBeat(x), row0: yToRow(y), anchor: note, base, ids: new Set([note.id]), moved: false, isolate: null, lastPitch: pitch }
      : { kind: 'resize', beat0: beat + duration, base, ids: new Set([note.id]) };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const { x, y } = local(e);
    const p = P.current;
    const cv = canvasRef.current;
    if (!d) {
      if (cv) {
        const hit = y > gridTop && y < size.h - VEL && x > KEY_W ? noteAt(x, y) : null;
        cv.style.cursor = y < RULER && p.onLength && Math.abs(x - beatToX(p.length)) < 7 ? 'ew-resize'
          : hit ? (!drum && beatToX(hit.start + hit.duration) - x < 7 && hit.duration * view.current.ppb > 12 ? 'ew-resize' : 'grab')
          : x > KEY_W && y > gridTop && y < size.h - VEL ? (tool === 'draw' ? 'crosshair' : 'default') : 'default';
      }
      return;
    }
    const grid = p.snap;
    dirty.current = true;
    if (d.kind === 'seek') { p.onSeek?.(Math.max(0, xToBeat(x))); return; }
    if (d.kind === 'length') { p.onLength?.(Math.max(grid || 1, snapBeat(xToBeat(x), grid || 1)), true); return; }
    if (d.kind === 'keys') { const pitch = pitchOf(yToRow(y)); if (pitch !== d.last) { d.last = pitch; p.onAudition(pitch, 0.8); } return; }
    if (d.kind === 'velocity') {
      const beat = xToBeat(x), v = clamp(1 - (y - (size.h - VEL) - 6) / (VEL - 10), 0.05, 1);
      const tol = 6 / view.current.ppb;
      const near = p.notes.filter((n) => Math.abs(n.start - beat) < tol);
      const pick = near.some((n) => selRef.current.has(n.id)) ? near.filter((n) => selRef.current.has(n.id)) : near;
      if (pick.length) { const ids = new Set(pick.map((n) => n.id)); p.onChange(p.notes.map((n) => (ids.has(n.id) ? { ...n, velocity: v } : n)), true); }
      return;
    }
    if (d.kind === 'marquee') {
      d.x1 = x; d.y1 = y;
      const bA = xToBeat(Math.min(d.x0, x)), bB = xToBeat(Math.max(d.x0, x));
      const rA = yToRow(Math.min(d.y0, y)), rB = yToRow(Math.max(d.y0, y));
      const ids = new Set(d.keep);
      for (const n of p.notes) { const r = rowOf(n.pitch); if (r >= rA && r <= rB && n.start < bB && n.start + n.duration > bA) ids.add(n.id); }
      setSel(ids);
      return;
    }
    if (d.kind === 'resize') {
      const delta = xToBeat(x) - d.beat0;
      const min = grid > 0 ? grid : 0.05;
      let len = 0;
      p.onChange(d.base.map((n) => {
        if (!d.ids.has(n.id)) return n;
        const end = n.start + n.duration + delta;
        len = Math.max(min, (grid > 0 ? snapBeat(end, grid) : end) - n.start);
        return { ...n, duration: len };
      }), true);
      if (len) lastLen.current = len;
      return;
    }
    // move
    const raw = d.anchor.start + (xToBeat(x) - d.beat0);
    const dBeat = Math.max(-Math.min(...d.base.filter((n) => d.ids.has(n.id)).map((n) => n.start)), (grid > 0 ? snapBeat(raw, grid) : raw) - d.anchor.start);
    const dRow = yToRow(y) - d.row0;
    if (dBeat !== 0 || dRow !== 0) d.moved = true;
    let anchorPitch = d.anchor.pitch;
    p.onChange(d.base.map((n) => {
      if (!d.ids.has(n.id)) return n;
      const pitch = drum ? pitchOf(clamp(rowOf(n.pitch) + dRow, 0, rows - 1)) : fitPitch(clamp(n.pitch - dRow, BOTTOM, TOP));
      if (n.id === d.anchor.id) anchorPitch = pitch;
      return { ...n, start: n.start + dBeat, pitch };
    }), true);
    if (anchorPitch !== d.lastPitch) { d.lastPitch = anchorPitch; p.onAudition(anchorPitch, d.anchor.velocity); }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    dirty.current = true;
    if (!d) return;
    if (d.kind === 'move' && !d.moved && d.isolate) setSel(new Set([d.isolate]));
    if (d.kind === 'move' || d.kind === 'resize' || d.kind === 'velocity' || d.kind === 'length') P.current.onGestureEnd();
  };

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoom(Math.exp(-e.deltaY * 0.004), e.clientX - el.getBoundingClientRect().left);
      else {
        view.current.sx += e.shiftKey ? e.deltaY : e.deltaX;
        if (!e.shiftKey) view.current.sy += e.deltaY;
        clampView();
        dirty.current = true;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const p = P.current;
    const grid = p.snap || 0.25;
    let handled = true;
    if (e.key === 'Delete' || e.key === 'Backspace') removeSelected();
    else if (e.key === 'Escape') setSel(new Set());
    else if (e.key === 'ArrowUp') transpose(e.shiftKey ? 12 : 1);
    else if (e.key === 'ArrowDown') transpose(e.shiftKey ? -12 : -1);
    else if (e.key === 'ArrowLeft') edit((n) => ({ ...n, start: Math.max(0, n.start - grid) }));
    else if (e.key === 'ArrowRight') edit((n) => ({ ...n, start: n.start + grid }));
    else if (mod && e.key.toLowerCase() === 'a') setSel(new Set(p.notes.map((n) => n.id)));
    else if (mod && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'x')) {
      noteClipboard = p.notes.filter((n) => selRef.current.has(n.id)).map((n) => ({ ...n }));
      if (e.key.toLowerCase() === 'x') removeSelected();
    } else if (mod && (e.key.toLowerCase() === 'v' || e.key.toLowerCase() === 'd')) {
      const dup = e.key.toLowerCase() === 'd';
      const src = dup ? p.notes.filter((n) => selRef.current.has(n.id)) : noteClipboard;
      if (src.length) {
        const first = Math.min(...src.map((n) => n.start));
        const end = Math.max(...src.map((n) => n.start + n.duration));
        const at = dup ? snapBeat(end, grid) : snapBeat(Math.max(0, p.getPlayhead?.() ?? xToBeat(KEY_W)), grid);
        const copies = src.map((n) => ({ ...n, id: uid(), start: n.start - first + at }));
        p.onChange([...p.notes, ...copies], false);
        setSel(new Set(copies.map((n) => n.id)));
      }
    } else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  const selNotes = props.notes.filter((n) => sel.has(n.id));
  const avgVel = selNotes.length ? selNotes.reduce((a, n) => a + n.velocity, 0) / selNotes.length : 0.8;
  const keyName = `${NOTE_NAMES[props.musicKey.root]} ${SCALES[props.musicKey.scale].name.toLowerCase()}`;

  return (
    <div className="pianoroll">
      <div className="pr-tools">
        <div className="seg" role="group" aria-label="Tool">
          <button className={tool === 'draw' ? 'on' : ''} onClick={() => setTool('draw')} title="Draw: click to add notes, drag to set length"><Pencil />Draw</button>
          <button className={tool === 'select' ? 'on' : ''} onClick={() => setTool('select')} title="Select: drag a box around notes (or hold Shift)"><MousePointer2 />Select</button>
        </div>
        <button className="btn sm" onClick={quantize} title="Snap note starts and lengths to the grid">Quantize</button>
        {!drum && (
          <div className="row" style={{ gap: 2 }}>
            <button className="btn sm ghost" onClick={() => transpose(-12)} title="Down an octave">−12</button>
            <button className="btn sm ghost" onClick={() => transpose(-1)} title="Down a semitone (↓)">−1</button>
            <button className="btn sm ghost" onClick={() => transpose(1)} title="Up a semitone (↑)">+1</button>
            <button className="btn sm ghost" onClick={() => transpose(12)} title="Up an octave">+12</button>
          </div>
        )}
        <label className="t-field" title="Velocity (how hard the selected notes are played)">
          Velocity
          <input
            type="range" min={0.05} max={1} step={0.01} value={avgVel} disabled={!selNotes.length} aria-label="Velocity of selected notes" style={{ width: 84 }}
            onPointerDown={props.onGestureStart} onPointerUp={props.onGestureEnd} onChange={(e) => setVelocity(Number(e.target.value))}
          />
        </label>
        {!drum && <button className="btn sm ghost" disabled={selNotes.length < 2} onClick={combine} title="Join selected notes of the same pitch into one"><Combine />Combine</button>}
        <button className="icon-btn sm" disabled={!selNotes.length} onClick={removeSelected} title="Delete selected notes (Delete)" aria-label="Delete selected notes"><Trash2 /></button>
        {!drum && (
          <>
            <div className="t-div" />
            <label className="t-field" title={`Shade the notes outside ${keyName}`}>
              <input type="checkbox" checked={showScale} onChange={(e) => setShowScale(e.target.checked)} /> Show {keyName}
            </label>
            <label className="t-field" title="New and moved notes stay inside the key">
              <input type="checkbox" checked={snapScale} onChange={(e) => setSnapScale(e.target.checked)} /> Stay in key
            </label>
            <button className="btn sm ghost" onClick={toScale} title={`Move ${selNotes.length ? 'selected' : 'all'} notes to the nearest note of ${keyName}`}>Fit to key</button>
          </>
        )}
        {props.toolbar}
        <div className="grow" />
        <span className="faint desktop-only" style={{ fontSize: 12 }}>{targets().length} {selNotes.length ? 'selected' : 'notes'}</span>
        <button className="icon-btn sm" onClick={() => zoom(1 / 1.4)} title="Zoom out" aria-label="Zoom out"><ZoomOut /></button>
        <button className="icon-btn sm" onClick={() => zoom(1.4)} title="Zoom in" aria-label="Zoom in"><ZoomIn /></button>
      </div>
      <div ref={wrapRef} className="pr-view" tabIndex={0} data-own-keys onKeyDown={onKeyDown} aria-label="Piano roll. Click to add a note, drag to move, drag the right edge to resize, right-click to delete.">
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
    </div>
  );
}
