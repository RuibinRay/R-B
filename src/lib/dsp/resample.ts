// Sample-rate conversion with a windowed-sinc low-pass, so that nothing above the new
// Nyquist frequency folds back into the signal. (Hi-hats and consonants have most of their
// energy above 8 kHz; with a crude averaging resampler that energy lands in the middle of
// the spectrum at 16 kHz and makes bright sounds look dull to the analysis.)

export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const ratio = from / to; // input samples per output sample
  const outLen = Math.floor(x.length / ratio);
  const out = new Float32Array(outLen);
  const cutoff = Math.min(1, to / from) * 0.92; // of the input Nyquist, leaving a little transition room
  const zeros = 10; // sinc lobes on each side
  const reach = zeros / cutoff; // in input samples
  for (let i = 0; i < outLen; i++) {
    const centre = i * ratio;
    const a = Math.max(0, Math.ceil(centre - reach)), b = Math.min(x.length - 1, Math.floor(centre + reach));
    let sum = 0, norm = 0;
    for (let j = a; j <= b; j++) {
      const d = (j - centre) * cutoff;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * (j - centre)) / reach); // Hann window
      const s = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      sum += x[j] * s * w;
      norm += s * w;
    }
    out[i] = norm !== 0 ? sum / norm : 0;
  }
  return out;
}
