// Prepare the public H8 checkpoint inside this workspace; never read HF tokens.
// GPU benchmark: python tools/ardy-horizon-compare.py --help (coordinate GPU use first).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(workspace, 'release', 'ardy-horizon-comparison');
const name = 'ARDY-Core-RP-20FPS-Horizon8';
const repo = `nvidia/${name}`;
const checkpoint = path.join(root, 'checkpoints', name);
const cache = path.join(homedir(), '.cache', 'huggingface', 'hub');
const prepare = process.argv.includes('--prepare');
const sha256 = async filename => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
};
const candidates = [];
for (const model of [name, 'ARDY-Core-RP-20FPS-Horizon40']) {
  const snapshots = path.join(cache, `models--nvidia--${model}`, 'snapshots');
  for (const revision of await readdir(snapshots).catch(() => [])) candidates.push(path.join(snapshots, revision));
}
const response = await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`);
if (!response.ok) throw Error(`Public model metadata failed: HTTP ${response.status}`);
const metadata = await response.json();
if (metadata.gated !== false || !/^[a-f\d]{40}$/.test(metadata.sha)) throw Error('Expected an ungated, revision-pinned public model');
const files = metadata.siblings.filter(file => /^(?:config\.yaml|LICENSE|README\.md|(?:denoiser|tokenizer)\.safetensors|stats\/(?:motion|pre_quantization|post_quantization)\/(?:mean|std)\.npy)$/.test(file.rfilename));
const report = { repo, revision: metadata.sha, recordedAt: new Date().toISOString(), checkpoint,
  publicBytes: files.reduce((sum, file) => sum + file.size, 0), downloadBytes: 0, copiedBytes: 0, files: [] };
await mkdir(root, { recursive: true });
for (const file of files) {
  const destination = path.join(checkpoint, ...file.rfilename.split('/'));
  const expectedHash = file.lfs?.sha256;
  const matches = async filename => (await stat(filename).catch(() => null))?.size === file.size
    && (!expectedHash || await sha256(filename) === expectedHash);
  const item = { name: file.rfilename, size: file.size, sha256: expectedHash, source: 'download-required' };
  if (await matches(destination)) item.source = 'workspace';
  else if (expectedHash) {
    for (const base of candidates) {
      const source = path.join(base, ...file.rfilename.split('/'));
      if (!await matches(source)) continue;
      item.source = 'local-copy';
      if (prepare) { await mkdir(path.dirname(destination), { recursive: true }); await copyFile(source, destination); }
      report.copiedBytes += file.size;
      break;
    }
  }
  if (item.source === 'download-required') {
    report.downloadBytes += file.size;
    if (prepare) {
      await mkdir(path.dirname(destination), { recursive: true });
      const download = await fetch(`https://huggingface.co/${repo}/resolve/${metadata.sha}/${file.rfilename}`);
      if (!download.ok || !download.body) throw Error(`Checkpoint download failed: ${file.rfilename}, HTTP ${download.status}`);
      const temporary = destination + '.partial';
      await pipeline(Readable.fromWeb(download.body), createWriteStream(temporary));
      if (!await matches(temporary)) throw Error(`Checkpoint checksum/size mismatch: ${file.rfilename}`);
      await rename(temporary, destination);
      item.source = 'downloaded';
    }
  }
  report.files.push(item);
  console.log(JSON.stringify(item));
  await writeFile(path.join(root, 'checkpoint-manifest.json'), JSON.stringify(report, null, 2));
}
report.prepared = prepare || report.files.every(file => file.source === 'workspace');
await writeFile(path.join(root, 'checkpoint-manifest.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ repo, revision: report.revision, prepared: report.prepared,
  downloadBytes: report.downloadBytes, copiedBytes: report.copiedBytes, publicBytes: report.publicBytes }));
