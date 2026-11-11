import type { Project } from '../types';
import { getAsset, type StoredAsset } from './db';

// A single-file project container (.rnb): a small binary header, the project JSON,
// then every audio asset's original bytes. Lets a full editable project be moved
// between browsers or backed up.

const MAGIC = 'RNB1';

export async function exportProjectFile(p: Project): Promise<Blob> {
  const assets: StoredAsset[] = [];
  for (const meta of p.assets) {
    const a = await getAsset(meta.id);
    if (a) assets.push(a);
  }
  const manifest = { project: p, assets: assets.map((a) => ({ id: a.id, name: a.name, type: a.blob.type, size: a.blob.size })) };
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const header = new ArrayBuffer(8);
  const view = new DataView(header);
  for (let i = 0; i < 4; i++) view.setUint8(i, MAGIC.charCodeAt(i));
  view.setUint32(4, json.length, true);
  return new Blob([header, json, ...assets.map((a) => a.blob)], { type: 'application/octet-stream' });
}

export async function importProjectFile(file: Blob): Promise<{ project: Project; assets: StoredAsset[] }> {
  const head = new DataView(await file.slice(0, 8).arrayBuffer());
  const magic = String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3));
  if (magic !== MAGIC) throw new Error('This is not an R&B project file.');
  const jsonLen = head.getUint32(4, true);
  const manifest = JSON.parse(await file.slice(8, 8 + jsonLen).text()) as {
    project: Project; assets: { id: string; name: string; type: string; size: number }[];
  };
  if (!manifest.project?.tracks || !Array.isArray(manifest.project.clips)) throw new Error('The project file is damaged.');
  let offset = 8 + jsonLen;
  const assets: StoredAsset[] = [];
  for (const a of manifest.assets) {
    assets.push({ id: a.id, name: a.name, blob: file.slice(offset, offset + a.size, a.type) });
    offset += a.size;
  }
  if (offset > file.size) throw new Error('The project file is incomplete.');
  return { project: manifest.project, assets };
}
