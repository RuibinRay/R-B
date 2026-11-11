import { Mp3Encoder } from '@breezystack/lamejs';

// PCM helpers: WAV and MP3 encoding, buffer slicing and downloads.

export interface Pcm { channels: Float32Array[]; sampleRate: number }

export const toPcm = (b: AudioBuffer): Pcm => ({
  channels: Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i)),
  sampleRate: b.sampleRate,
});

export function encodeWav(pcm: Pcm, bitDepth: 16 | 24 = 16): Blob {
  const { channels, sampleRate } = pcm;
  const n = channels[0]?.length ?? 0;
  const nch = channels.length;
  const bytes = bitDepth / 8;
  const dataSize = n * nch * bytes;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nch * bytes, true);
  v.setUint16(32, nch * bytes, true); v.setUint16(34, bitDepth, true);
  str(36, 'data'); v.setUint32(40, dataSize, true);
  let o = 44;
  if (bitDepth === 16) {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i]));
        v.setInt16(o, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
        o += 2;
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i]));
        const x = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        v.setUint8(o, x & 0xff); v.setUint8(o + 1, (x >> 8) & 0xff); v.setUint8(o + 2, (x >> 16) & 0xff);
        o += 3;
      }
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

const SUPPORTED_MP3_RATES = [44100, 48000, 32000, 24000, 22050, 16000];

export async function encodeMp3(pcm: Pcm, kbps = 192, onProgress?: (fraction: number) => void): Promise<Blob> {
  const { channels, sampleRate } = pcm;
  if (!SUPPORTED_MP3_RATES.includes(sampleRate)) throw new Error(`MP3 export does not support a ${sampleRate} Hz sample rate.`);
  const nch = Math.min(2, channels.length);
  const enc = new Mp3Encoder(nch, sampleRate, kbps);
  const n = channels[0].length;
  const toInt = (f: Float32Array, start: number, end: number) => {
    const out = new Int16Array(end - start);
    for (let i = start; i < end; i++) {
      const s = Math.max(-1, Math.min(1, f[i]));
      out[i - start] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
    }
    return out;
  };
  const parts: Uint8Array[] = [];
  const block = 1152 * 40;
  for (let i = 0; i < n; i += block) {
    const end = Math.min(n, i + block);
    const left = toInt(channels[0], i, end);
    const out = nch === 2 ? enc.encodeBuffer(left, toInt(channels[1], i, end)) : enc.encodeBuffer(left);
    if (out.length) parts.push(new Uint8Array(out));
    onProgress?.(end / n);
    await new Promise((r) => setTimeout(r, 0));
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  return new Blob(parts as BlobPart[], { type: 'audio/mpeg' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export const safeName = (name: string): string => name.trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-') || 'untitled';

/** Mix down to mono at a target sample rate (linear interpolation; fine for analysis). */
export function toMono(buffer: AudioBuffer, targetRate?: number): Float32Array {
  const n = buffer.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i];
  }
  if (buffer.numberOfChannels > 1) for (let i = 0; i < n; i++) mono[i] /= buffer.numberOfChannels;
  if (!targetRate || targetRate === buffer.sampleRate) return mono;
  const ratio = buffer.sampleRate / targetRate;
  const outLen = Math.floor(n / ratio);
  const out = new Float32Array(outLen);
  // Average over the source span of each output sample: a cheap anti-alias filter for downsampling.
  const span = Math.max(1, Math.floor(ratio));
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    let s = 0;
    for (let k = 0; k < span; k++) s += mono[Math.min(n - 1, start + k)];
    out[i] = s / span;
  }
  return out;
}
