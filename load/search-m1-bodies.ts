import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { epoch, generate, seed } from './search-engines/seed.ts';

export const manifestPath = 'load/search-engines/manifest-v2.json';
// Manifest paths are repository-relative; resolve them from this file so tests run from any directory (CI uses load/).
export const repoPath = (path: string) => isAbsolute(path) ? path : resolve(import.meta.dirname, '..', path);
export const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const fileSha256 = (path: string) => sha256(readFileSync(repoPath(path)));

type SourceHashes = { path: string; sha256: string }[];

function pinnedHashes(sourceHashes: SourceHashes, names: string[]) {
  return Object.fromEntries(names.map(name => {
    const path = `load/search-engines/${name}`;
    const hash = sourceHashes.find(entry => entry.path === path)?.sha256;
    assert.ok(hash && /^[a-f0-9]{64}$/.test(hash), `Missing manifest v2 source hash: ${path}`);
    return [path, hash];
  }));
}

export const overlayHashes = (sourceHashes: SourceHashes) => pinnedHashes(sourceHashes, ['schema.sql', 'pgroonga.sql']);
export const dbImageHashes = (sourceHashes: SourceHashes) => pinnedHashes(sourceHashes, ['Dockerfile', 'seed.ts']);

export function verifyDbImageInputs(dir: string, hashes: Record<string, string>) {
  for (const [path, hash] of Object.entries(hashes)) {
    assert.equal(sha256(readFileSync(join(dir, basename(path)))), hash, `DB image input changed: ${path}`);
  }
}

export function frozenManifest() {
  const { sha256: hash, frozen } = JSON.parse(readFileSync(repoPath(manifestPath), 'utf8')) as {
    sha256: string;
    frozen: {
      node: string;
      generator: { version: number; seed: number; clock: string };
      sourceHashes: SourceHashes;
      image: { extensions: { pgroonga: string } };
    };
  };
  assert.equal(sha256(JSON.stringify(frozen)), hash, 'Manifest v2 hash mismatch');
  const inputs = { ...overlayHashes(frozen.sourceHashes), ...dbImageHashes(frozen.sourceHashes) };
  for (const [path, expected] of Object.entries(inputs)) assert.equal(fileSha256(path), expected, path);
  assert.deepEqual(frozen.generator, { version: 1, seed, clock: new Date(epoch).toISOString() });
  return { hash, frozen };
}

// A fixed prefix preserves the required percentiles and fits in k6's shared array.
const count = 50_000;

export async function writeBodies(path: string) {
  const scratch = mkdtempSync(`${tmpdir()}/search-m1-bodies-`);
  const tsv = `${scratch}/corpus.tsv`;
  const bodies: string[] = [];
  try {
    generate(tsv, count);
    for await (const line of createInterface({ input: createReadStream(tsv, 'utf8'), crlfDelay: Infinity })) {
      const escaped = line.split('\t')[6];
      assert.ok(escaped, 'Missing body in corpus row');
      bodies.push(escaped.replace(/\\([\\nt])/g, (_, char: string) => char === 'n' ? '\n' : char === 't' ? '\t' : '\\'));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  assert.equal(bodies.length, count);
  const lengths = bodies.map(body => [...body].length).sort((a, b) => a - b);
  const bodyScalars = { p50: lengths[Math.floor(count * .5)], p95: lengths[Math.floor(count * .95)] };
  assert.deepEqual(bodyScalars, { p50: 155, p95: 676 }, 'Body scalar lengths differ from manifest v2');
  const json = JSON.stringify(bodies) + '\n';
  writeFileSync(path, json, { flag: 'wx' });
  return { seed, count, bodyScalars, sha256: sha256(json) };
}

if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error('Usage: node load/search-m1-bodies.ts <new JSON path>');
  const { frozen } = frozenManifest();
  assert.equal(process.version, `v${frozen.node}`);
  console.log(JSON.stringify(await writeBodies(process.argv[2])));
}
