import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readSource } from '../d3r/path.ts';
import { hash } from '../manifest.ts';
import { loadArchive } from './archive.ts';
import { full, sourceCommit } from './design.ts';
import { loadManifest, manifestFile } from './manifest.ts';
import { options } from './options.ts';

test('the independent Phase A manifest pins sources, settings and registered workloads', () => {
  const {frozen} = loadManifest();
  assert.equal(frozen.postgres.required.autovacuum, 'on');
  assert.deepEqual(frozen.postgres.settings, {});
  assert.equal(frozen.queries.length, 23);
  assert.equal(full.clients * full.transactions, 100);
  for (const path of ['load/throughput.ts', 'load/search-m1.ts', 'load/search-m1-results.ts',
    'load/search-engines/manifest-v18.json', 'load/search-engines/d3r/backfill.ts', 'load/dms-storage.ts',
    'load/search-engines/d3r-churn/run.ts', 'server/migrations/202611260620_create_from_messages.sql']) {
    assert.ok(frozen.sourceHashes.some(source => source.path === path), path);
  }
  const tampered = JSON.parse(readSource(manifestFile));
  tampered.frozen.phases.seed++;
  assert.throws(() => loadManifest(JSON.stringify(tampered)), /content hash mismatch/);
  tampered.sha256 = hash(JSON.stringify(tampered.frozen));
  assert.throws(() => loadManifest(JSON.stringify(tampered)), /source hashes differ/);
});

test('full-size modes refuse --messages and formal refuses without the launcher', () => {
  const out = resolve(tmpdir(), 'churn-formal-no-launch');
  const args = ['--formal', `--out=${out}`, '--app-image=sha256:' + '0'.repeat(64)];
  assert.throws(() => options([...args, '--messages=100']), /smoke only/);
  const env = {...process.env};
  for (const name of ['FUKULOW_HOST_BUSY', 'FUKULOW_LAUNCH_JOB', 'FUKULOW_LAUNCH_SESSION']) delete env[name];
  const run = spawnSync(process.execPath, ['load/search-engines/d3r-churn/run.ts', ...args], {cwd: fileURLToPath(new URL('../../../', import.meta.url)), env, encoding: 'utf8'});
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Phase A INVALID: Caller must hold runs\/HOST-BUSY/);
});

test('v18 physical backup receipts are rejected before starting a cluster', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'd3r-churn-archive-test-'));
  try {
    writeFileSync(join(dir, 'preserved-backfill.json'), JSON.stringify({manifestHash: 'v18'}));
    await assert.rejects(loadArchive(dir, dir, {manifest: 'v20', image: 'pg', rows: full.rows, seed: full.seed,
      productCommit: sourceCommit}), /production migrate command.*v18/);
  } finally {
    rmSync(dir, {recursive: true});
  }
});
