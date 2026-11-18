import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { epoch, generate, seed } from './search-engines/seed.ts';

export const manifestPath = 'load/search-engines/manifest-v2.json';
export const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const fileSha256 = (path: string) => sha256(readFileSync(path));

export function overlayHashes(sourceHashes: { path: string; sha256: string }[]) {
  return Object.fromEntries(['schema.sql', 'pgroonga.sql'].map(name => {
    const path = `load/search-engines/${name}`;
    const hash = sourceHashes.find(entry => entry.path === path)?.sha256;
    assert.ok(hash && /^[a-f0-9]{64}$/.test(hash), `Missing manifest v2 overlay hash: ${path}`);
    return [path, hash];
  }));
}

export function frozenManifest() {
  const { sha256: hash, frozen } = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    sha256: string;
    frozen: {
      node: string;
      generator: { version: number; seed: number; clock: string };
      sourceHashes: { path: string; sha256: string }[];
      settings: Record<string, string>;
      image: { extensions: { pgroonga: string } };
    };
  };
  assert.equal(sha256(JSON.stringify(frozen)), hash, 'Manifest v2 hash mismatch');
  for (const path of ['seed.ts', 'schema.sql', 'pgroonga.sql', 'Dockerfile']) {
    const source = `load/search-engines/${path}`;
    assert.equal(fileSha256(source), frozen.sourceHashes.find(entry => entry.path === source)?.sha256, source);
  }
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
