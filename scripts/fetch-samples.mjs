// Optional: copy the instrument samples the app uses into public/samples so the
// site is fully self-hosted (no CDN). Run with:  npm run fetch-samples
// Source: FluidR3_GM by Frank Wen (CC BY 3.0), pre-rendered by gleitz/midi-js-soundfonts.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';

const CDN = 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/';
const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const src = readFileSync('src/lib/instruments.ts', 'utf8');
// s('id', 'Name', 'category', 'gm_patch', low, high, ...
const patches = new Map();
for (const m of src.matchAll(/\bs\('[^']+',\s*'[^']+',\s*'[^']+',\s*'([a-z0-9_]+)',\s*(\d+),\s*(\d+)/g)) {
  const [, gm, lo, hi] = m;
  const cur = patches.get(gm) ?? [127, 0];
  patches.set(gm, [Math.min(cur[0], Number(lo)), Math.max(cur[1], Number(hi))]);
}
let done = 0, failed = 0;
for (const [gm, [lo, hi]] of patches) {
  mkdirSync(`public/samples/${gm}-mp3`, { recursive: true });
  for (let midi = 21; midi <= 108; midi++) {
    if (midi % 3 !== 0 || midi < lo - 2 || midi > hi + 2) continue;
    const file = `${gm}-mp3/${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}.mp3`;
    if (existsSync(`public/samples/${file}`)) { done++; continue; }
    const res = await fetch(CDN + file);
    if (!res.ok) { failed++; console.warn(`missing ${file} (${res.status})`); continue; }
    writeFileSync(`public/samples/${file}`, Buffer.from(await res.arrayBuffer()));
    done++;
  }
  console.log(`${gm}: ok`);
}
writeFileSync('public/samples/manifest.json', JSON.stringify({ source: 'FluidR3_GM (CC BY 3.0)', patches: [...patches.keys()] }, null, 2));
console.log(`\n${done} samples in public/samples (${failed} failed). The app now loads them locally.`);
