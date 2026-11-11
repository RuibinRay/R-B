// Time-stretching without changing pitch (WSOLA: waveform-similarity overlap-add).
//
// The sound is cut into overlapping 50 ms windows. To make it longer or shorter the
// windows are laid back down at the normal spacing but *taken* from the input at a
// slower or faster rate. Each window is nudged by up to 12 ms to the spot where it
// lines up best with the audio that would naturally have followed the previous one,
// which is what keeps the result free of the flutter a naive overlap would cause.

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** `ratio` is new length / old length: 2 = twice as long (half speed), 0.5 = half as long. */
export async function stretchAudio(channels: Float32Array[], sampleRate: number, ratio: number, onProgress?: (fraction: number) => void): Promise<Float32Array[]> {
  const n = channels[0]?.length ?? 0;
  const r = Math.min(4, Math.max(0.25, ratio));
  const outLen = Math.max(1, Math.round(n * r));
  if (!n || Math.abs(r - 1) < 0.0005) return channels.map((c) => c.slice());

  const N = Math.round((sampleRate * 0.05) / 2) * 2; // window
  const Hs = N / 2; // spacing of windows in the output
  const tol = Math.round(sampleRate * 0.012); // how far a window may be nudged
  const D = 4; // the coarse search runs on a 4x decimated copy
  // Which point of a window is kept exactly on time. A note or drum hit first becomes
  // audible in the later part of the window that reaches it, so when slowing down that
  // is the part to pin; pinning the start instead makes every hit arrive early.
  const pin = N * (r > 1 ? 0.815 - 0.25 / r : 0.5);
  const lastPos = Math.max(0, n - N);
  // Each window prefers to carry straight on from the one before, which when slowing
  // down lies ahead of where it should be (and behind when speeding up). Left alone the
  // windows would sit at that end of the search range all the time and shift the whole
  // clip by several milliseconds, so the range is offset the other way to balance it.
  const ahead = Math.floor((tol * (r > 1 ? 0.4 : 1.6)) / D), behind = Math.floor((tol * (r > 1 ? 1.6 : 0.4)) / D);

  const mono = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length;
  const lo = new Float32Array(Math.floor(n / D));
  for (let i = 0; i < lo.length; i++) lo[i] = (mono[i * D] + mono[i * D + 1] + mono[i * D + 2] + mono[i * D + 3]) / 4;

  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const out = channels.map(() => new Float32Array(outLen + N));

  /** How alike the input at `a` and at `b` are over one window (normalised correlation). */
  const alike = (x: Float32Array, a: number, b: number, len: number, step: number): number => {
    let ab = 0, aa = 0;
    for (let i = 0; i < len; i += step) { const u = x[a + i] ?? 0, v = x[b + i] ?? 0; ab += u * v; aa += u * u; }
    return aa > 1e-9 ? ab / Math.sqrt(aa) : 0;
  };

  let prev = 0;
  const frames = Math.ceil(outLen / Hs);
  for (let k = 0; k < frames; k++) {
    let pos = 0;
    if (k > 0) {
      const ideal = Math.min(lastPos, Math.max(0, (k * Hs + pin) / r - pin));
      const target = prev + Hs; // where the previous window's audio naturally continues
      // coarse: best offset on the decimated signal
      const cl = Math.floor(N / D), tc = Math.round(target / D);
      let best = 0, bestScore = -Infinity;
      for (let d = -behind; d <= ahead; d++) {
        const cand = Math.round(ideal / D) + d;
        if (cand < 0 || cand + cl > lo.length) continue;
        const score = alike(lo, cand, tc, cl, 1);
        if (score > bestScore) { bestScore = score; best = cand * D; }
      }
      // fine: a few samples either side at full resolution
      pos = best;
      bestScore = -Infinity;
      for (let d = -D; d <= D; d++) {
        const cand = best + d;
        if (cand < 0 || cand >= n) continue;
        const score = alike(mono, cand, target, N, 2);
        if (score > bestScore) { bestScore = score; pos = cand; }
      }
      // if the search found nothing usable (silence), just follow the ideal position
      if (!Number.isFinite(bestScore) || bestScore <= 0) pos = Math.round(ideal);
      pos = Math.min(n - 1, Math.max(0, pos));
    }
    const at = k * Hs;
    for (let c = 0; c < channels.length; c++) {
      const x = channels[c], o = out[c];
      for (let i = 0; i < N; i++) {
        const s = pos + i < n ? x[pos + i] : 0;
        // the very first half-window has nothing before it to overlap with
        o[at + i] += s * (k === 0 && i < Hs ? 1 : win[i]);
      }
    }
    prev = pos;
    if (k % 200 === 0) { onProgress?.(k / frames); await tick(); }
  }
  onProgress?.(1);
  return out.map((o) => o.subarray(0, outLen).slice());
}
