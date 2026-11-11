import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { engine } from '../audio/engine';
import { drumSound, getInstrument, isDrums, kitPads } from '../lib/instruments';
import { clamp, isBlackKey, midiToName } from '../lib/music';
import { A, selectedTrack, setUI, useStore } from '../store/store';
import { Switch } from './ui';

// On-screen keyboard and drum pads. Both drive the selected instrument track and
// can also be played from the computer keyboard.

const TYPING_KEYS = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j', 'k', 'o', 'l', 'p', ';'];
const PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', 'q', 'w', 'e', 'r', 't', 'y', 'u', 'i'];

const isTextField = (el: EventTarget | null): boolean => {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range' && (t as HTMLInputElement).type !== 'checkbox' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
};

/** Map computer keys to notes while `enabled`. `keyToMidi` returns undefined for unmapped keys. */
function useTyping(enabled: boolean, keyToMidi: (key: string) => number | undefined, onDown: (m: number) => void, onUp: (m: number) => void, extra?: (key: string) => boolean) {
  const fn = useRef({ keyToMidi, onDown, onUp, extra });
  fn.current = { keyToMidi, onDown, onUp, extra };
  useEffect(() => {
    if (!enabled) return;
    const held = new Map<string, number>();
    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTextField(e.target) || (e.target as HTMLElement)?.closest?.('[data-own-keys]')) return;
      const key = e.key.toLowerCase();
      if (fn.current.extra?.(key)) { e.preventDefault(); return; }
      const m = fn.current.keyToMidi(key);
      if (m === undefined) return;
      e.preventDefault();
      if (e.repeat || held.has(key)) return;
      held.set(key, m);
      fn.current.onDown(m);
    };
    const up = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const m = held.get(key);
      if (m === undefined) return;
      held.delete(key);
      fn.current.onUp(m);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      held.forEach((m) => fn.current.onUp(m));
    };
  }, [enabled]);
}

export const typingKeySet = new Set([...TYPING_KEYS, ...PAD_KEYS, 'z', 'x']);

/** With `previewId` the keyboard plays that instrument directly (library preview) instead of the selected track. */
export function Keyboard({ previewId }: { previewId?: string }) {
  const track = useStore(selectedTrack);
  const typing = useStore((s) => s.ui.typing);
  const def = getInstrument(previewId ?? track?.instrumentId);
  const noteOn = (m: number, v: number) => (previewId ? void engine.previewOn(previewId, m, v) : A.noteOn(m, v));
  const noteOff = (m: number) => (previewId ? engine.previewOff(previewId, m) : A.noteOff(m));
  const [low, setLow] = useState(48);
  const [down, setDown] = useState<Set<number>>(new Set());
  const octaves = 3;

  // Move the visible octaves to where the instrument can actually play.
  useEffect(() => {
    if (!def) return;
    const center = (def.range[0] + def.range[1]) / 2;
    setLow(clamp(Math.round((center - 18) / 12) * 12, 12, 84));
  }, [def?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const held = useRef(new Set<number>());
  const press = (m: number, velocity = 0.8) => {
    if (held.current.has(m)) return;
    held.current.add(m);
    noteOn(m, velocity);
    setDown(new Set(held.current));
  };
  const release = (m: number) => {
    if (!held.current.delete(m)) return;
    noteOff(m);
    setDown(new Set(held.current));
  };
  useTyping(
    typing && !!def, (key) => { const i = TYPING_KEYS.indexOf(key); return i < 0 ? undefined : low + 12 + i; }, press, release,
    (key) => { if (key === 'z') { setLow((l) => Math.max(12, l - 12)); return true; } if (key === 'x') { setLow((l) => Math.min(84, l + 12)); return true; } return false; },
  );

  const notes = Array.from({ length: octaves * 12 + 1 }, (_, i) => low + i);
  const whites = notes.filter((m) => !isBlackKey(m));
  const inRange = (m: number) => !def || (m >= def.range[0] && m <= def.range[1]);
  const handlers = (m: number) => ({
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      const r = e.currentTarget.getBoundingClientRect();
      press(m, clamp(0.35 + 0.65 * ((e.clientY - r.top) / r.height), 0.3, 1));
    },
    onPointerEnter: (e: React.PointerEvent) => { if (e.buttons) press(m); },
    onPointerLeave: () => release(m),
    onPointerUp: () => release(m),
    onPointerCancel: () => release(m),
  });

  if (!def || (!previewId && track?.kind !== 'instrument')) return <p className="hint" style={{ padding: 14 }}>Select an instrument track to play it here.</p>;
  if (isDrums(def.id)) return <DrumPads previewId={previewId} />;

  return (
    <div className="kb-wrap">
      <div className="row wrap">
        <span style={{ fontWeight: 500 }}>{def.name}</span>
        <span className="faint num" style={{ fontSize: 12 }}>plays {midiToName(def.range[0])} to {midiToName(def.range[1])}</span>
        <div className="grow" />
        <label className="t-field"><Switch on={typing} onChange={(v) => setUI({ typing: v })} label="Play with computer keys" />Computer keys <span className="kbd">A</span>–<span className="kbd">;</span></label>
        <div className="row" style={{ gap: 2 }}>
          <button className="icon-btn sm" title="Octave down (Z)" aria-label="Octave down" onClick={() => setLow((l) => Math.max(12, l - 12))}><ChevronDown /></button>
          <span className="num faint" style={{ fontSize: 12, minWidth: 54, textAlign: 'center' }}>{midiToName(low)}–{midiToName(low + octaves * 12)}</span>
          <button className="icon-btn sm" title="Octave up (X)" aria-label="Octave up" onClick={() => setLow((l) => Math.min(84, l + 12))}><ChevronUp /></button>
        </div>
      </div>
      <div className="kb" role="group" aria-label="Piano keyboard">
        {whites.map((m) => (
          <button key={m} className={`kb-w ${down.has(m) ? 'down' : ''} ${inRange(m) ? '' : 'dim'}`} aria-label={midiToName(m)} {...handlers(m)}>
            {m % 12 === 0 && <span>{midiToName(m)}</span>}
          </button>
        ))}
        {notes.filter(isBlackKey).map((m) => {
          const before = whites.filter((w) => w < m).length;
          const w = 100 / whites.length;
          return <button key={m} className={`kb-b ${down.has(m) ? 'down' : ''} ${inRange(m) ? '' : 'dim'}`} aria-label={midiToName(m)} style={{ left: `${before * w - w * 0.3}%`, width: `${w * 0.6}%` }} {...handlers(m)} />;
        })}
      </div>
    </div>
  );
}

export function DrumPads({ previewId }: { previewId?: string }) {
  const track = useStore(selectedTrack);
  const typing = useStore((s) => s.ui.typing);
  const id = previewId ?? track?.instrumentId;
  const pads = kitPads(id);
  const [down, setDown] = useState<Set<number>>(new Set());
  const hit = (m: number, velocity = 0.9) => {
    if (previewId) void engine.previewNote(previewId, m, 0.3, velocity);
    else { A.noteOn(m, velocity); A.noteOff(m); }
    setDown((d) => new Set(d).add(m));
    window.setTimeout(() => setDown((d) => { const n = new Set(d); n.delete(m); return n; }), 110);
  };
  useTyping(typing && !!id, (key) => { const i = PAD_KEYS.indexOf(key); return i < 0 ? undefined : pads[i]; }, hit, () => {});
  return (
    <div>
      <div className="row wrap" style={{ padding: '10px 12px 0' }}>
        <span style={{ fontWeight: 500 }}>{getInstrument(id)?.name}</span>
        <div className="grow" />
        <label className="t-field"><Switch on={typing} onChange={(v) => setUI({ typing: v })} label="Play with computer keys" />Computer keys <span className="kbd">1</span>–<span className="kbd">8</span> <span className="kbd">Q</span>–<span className="kbd">I</span></label>
      </div>
      <div className="pads" role="group" aria-label="Drum pads">
        {pads.map((m, i) => (
          <button
            key={m} className={`dpad ${down.has(m) ? 'down' : ''}`}
            onPointerDown={(e) => { const r = e.currentTarget.getBoundingClientRect(); hit(m, clamp(0.45 + 0.55 * (1 - (e.clientY - r.top) / r.height), 0.4, 1)); }}
          >
            {drumSound(m)?.short}
            <small>{PAD_KEYS[i]?.toUpperCase()}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
