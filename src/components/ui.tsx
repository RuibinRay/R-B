import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Info, TriangleAlert } from 'lucide-react';
import { beginGesture, endGesture, useStore } from '../store/store';

/** Range input whose drag is one undo step: pair it with actions called in "live" mode. */
export function Slider(props: {
  value: number; min: number; max: number; step?: number; onChange: (v: number) => void;
  vertical?: boolean; disabled?: boolean; label: string; reset?: number; className?: string; plain?: boolean;
}) {
  const { value, min, max, step = 1, onChange, vertical, disabled, label, reset, className, plain } = props;
  const start = plain ? undefined : beginGesture;
  const end = plain ? undefined : endGesture;
  return (
    <input
      type="range" aria-label={label} title={reset !== undefined ? `${label} (double-click to reset)` : label}
      className={`${vertical ? 'vertical' : ''} ${className ?? ''}`} min={min} max={max} step={step} value={value} disabled={disabled}
      onPointerDown={start} onPointerUp={end} onKeyDown={start} onKeyUp={end} onBlur={end}
      onChange={(e) => onChange(Number(e.target.value))}
      onDoubleClick={() => { if (reset !== undefined) { start?.(); onChange(reset); end?.(); } }}
    />
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />;
}

export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog glass" role="dialog" aria-modal="true" aria-label={title} style={wide ? { width: 'min(720px, 100%)' } : undefined}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** A button that opens a small floating menu. Children receive a `close` callback. */
export function Menu({ button, children, align = 'left' }: { button: (toggle: () => void, open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      {button(() => setOpen((o) => !o), open)}
      {open && <div className="menu glass" style={{ top: 'calc(100% + 6px)', [align]: 0 }}>{children(() => setOpen(false))}</div>}
    </span>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast glass ${t.kind}`}>
          {t.kind === 'error' ? <TriangleAlert /> : t.kind === 'success' ? <Check /> : <Info />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Explanations shown only in Beginner mode. */
export function Hint({ children }: { children: ReactNode }) {
  const beginner = useStore((s) => s.ui.mode === 'beginner');
  return beginner ? <p className="hint">{children}</p> : null;
}

/** Observe an element's size. */
export function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/** Run a callback every animation frame while mounted. */
export function useFrame(fn: () => void): void {
  const cb = useRef(fn);
  cb.current = fn;
  useEffect(() => {
    let id = 0;
    const loop = () => { cb.current(); id = requestAnimationFrame(loop); };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, []);
}

export const fmtDb = (db: number): string => (db <= -59.5 ? '-inf' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`);
