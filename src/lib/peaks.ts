// Waveform drawing from real sample data. Min/max peaks are computed once per
// buffer at a fixed resolution and cached; very close zooms read samples directly.

const BLOCK = 256;
interface Peaks { min: Float32Array; max: Float32Array }
const cache = new WeakMap<AudioBuffer, Peaks>();

function peaksOf(buffer: AudioBuffer): Peaks {
  let p = cache.get(buffer);
  if (p) return p;
  const n = Math.ceil(buffer.length / BLOCK);
  const min = new Float32Array(n), max = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let b = 0; b < n; b++) {
      let lo = 1, hi = -1;
      const end = Math.min(d.length, (b + 1) * BLOCK);
      for (let i = b * BLOCK; i < end; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (c === 0 || lo < min[b]) min[b] = lo;
      if (c === 0 || hi > max[b]) max[b] = hi;
    }
  }
  p = { min, max };
  cache.set(buffer, p);
  return p;
}

/**
 * Draw the section [startSec, endSec] of a buffer into the rectangle (x, y, w, h).
 * Pixels outside the canvas clip rectangle [clipL, clipR] are skipped.
 */
export function drawWaveform(
  ctx: CanvasRenderingContext2D, buffer: AudioBuffer, x: number, y: number, w: number, h: number,
  startSec: number, endSec: number, color: string, clipL = -Infinity, clipR = Infinity, gain = 1,
): void {
  if (w <= 0 || endSec <= startSec) return;
  const sr = buffer.sampleRate;
  const spp = ((endSec - startSec) * sr) / w; // samples per pixel
  const mid = y + h / 2;
  const amp = (h / 2) * 0.92 * gain;
  const x0 = Math.max(0, Math.floor(clipL - x));
  const x1 = Math.min(Math.ceil(w), Math.ceil(clipR - x));
  ctx.fillStyle = color;
  if (spp >= BLOCK) {
    const { min, max } = peaksOf(buffer);
    for (let px = x0; px < x1; px++) {
      const a = Math.floor((startSec * sr + px * spp) / BLOCK);
      const b = Math.max(a + 1, Math.floor((startSec * sr + (px + 1) * spp) / BLOCK));
      let lo = 1, hi = -1;
      for (let i = Math.max(0, a); i < b && i < min.length; i++) { if (min[i] < lo) lo = min[i]; if (max[i] > hi) hi = max[i]; }
      if (hi < lo) continue;
      const top = mid - Math.min(1, hi) * amp, bottom = mid - Math.max(-1, lo) * amp;
      ctx.fillRect(x + px, top, 1, Math.max(1, bottom - top));
    }
  } else {
    const d = buffer.getChannelData(0);
    for (let px = x0; px < x1; px++) {
      const a = Math.floor(startSec * sr + px * spp);
      const b = Math.max(a + 1, Math.floor(startSec * sr + (px + 1) * spp));
      let lo = 1, hi = -1;
      for (let i = Math.max(0, a); i < b && i < d.length; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (hi < lo) continue;
      const top = mid - Math.min(1, hi) * amp, bottom = mid - Math.max(-1, lo) * amp;
      ctx.fillRect(x + px, top, 1, Math.max(1, bottom - top));
    }
  }
}

/** Size a canvas for the device pixel ratio and return a context scaled to CSS pixels. */
export function fitCanvas(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.floor(width)), h = Math.max(1, Math.floor(height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
