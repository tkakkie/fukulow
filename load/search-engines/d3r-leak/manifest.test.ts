import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { productionPath } from '../d3r/path.ts';
import { hash } from '../manifest.ts';
import { loadManifest, schemaCommit, verifyPinnedSchema } from './manifest.ts';

test('the leak manifest freezes this harness separately from the pinned migration and d3r source commit', () => {
  const {frozen} = loadManifest();
  assert.equal(frozen.schemaCommit, schemaCommit);
  assert.match(frozen.postgres.image, /^postgres:18\.6@sha256:[0-9a-f]{64}$/);
  assert.equal(frozen.postgres.settings.autovacuum, 'off');
  assert.deepEqual(verifyPinnedSchema(), productionPath());
  assert.deepEqual(frozen.freeze.formal, {blocksPerArm: 10, clients: 5, measuredPerClient: 20, messages: 24_000, many: 1_000});
  assert.equal(frozen.freeze.bootstrap.resamples, 10_000);
});

function pinnedV21(): ReturnType<typeof loadManifest>['frozen'] {
  const text = readFileSync(new URL('../manifest-d3r-leak-v21.json', import.meta.url), 'utf8');
  assert.equal(hash(text), '8bffd030943db4f5cdcd3032b3e1df363452255c6e27b75458540217e60674a1');
  const v21 = JSON.parse(text);
  assert.equal(v21.sha256, hash(JSON.stringify(v21.frozen)));
  return v21.frozen;
}

test('leak v21 keeps the v20 schema and conditions while the live d3r manifest advances', () => {
  const text = readFileSync(new URL('../manifest-d3r-leak-v20.json', import.meta.url), 'utf8');
  assert.equal(hash(text), 'aea77d19f6783c15ba9c3d11b4e789745e8bf5a8dd3a04502fcd3a3de1432ce5');
  const v20 = JSON.parse(text);
  assert.equal(v20.sha256, hash(JSON.stringify(v20.frozen)));
  const {version, sourceHashes, ...conditions} = pinnedV21();
  const {version: previousVersion, sourceHashes: previousSources, ...previousConditions} =
    v20.frozen as ReturnType<typeof loadManifest>['frozen'];
  assert.equal(version, previousVersion + 1);
  assert.deepEqual(conditions, previousConditions);
  assert.deepEqual(sourceHashes.map(source => source.path), previousSources.map(source => source.path));
  const before = new Map(previousSources.map(source => [source.path, source.sha256]));
  assert.deepEqual(sourceHashes.filter(source => before.get(source.path) !== source.sha256).map(source => source.path),
    ['load/search-engines/d3r-leak/manifest.ts', 'load/search-engines/d3r/manifest.ts']);
});

function pinnedV22(): ReturnType<typeof loadManifest>['frozen'] {
  const text = readFileSync(new URL('../manifest-d3r-leak-v22.json', import.meta.url), 'utf8');
  assert.equal(hash(text), '3570ae8df61fcb212ae6a7afb01d2256ede76cba490040c53701b0c82b8723c6');
  const v22 = JSON.parse(text);
  assert.equal(v22.sha256, hash(JSON.stringify(v22.frozen)));
  return v22.frozen;
}

test('leak v22 records the database context refactor with v21 schema and conditions', () => {
  const {version, sourceHashes, ...conditions} = pinnedV22();
  const {version: previousVersion, sourceHashes: previousSources, ...previousConditions} = pinnedV21();
  assert.equal(version, previousVersion + 1);
  assert.deepEqual(conditions, previousConditions);
  assert.deepEqual(sourceHashes.map(source => source.path), previousSources.map(source => source.path));
  const before = new Map(previousSources.map(source => [source.path, source.sha256]));
  assert.deepEqual(sourceHashes.filter(source => before.get(source.path) !== source.sha256).map(source => source.path),
    ['load/search-engines/d3r-leak/manifest.ts', 'load/search-engines/d3r/manifest.ts', 'server/src/database/context.rs']);
});

test('leak v24 records the ServeOptions refactor with v22 schema and conditions', () => {
  const {version, sourceHashes, ...conditions} = loadManifest().frozen;
  const {version: previousVersion, sourceHashes: previousSources, ...previousConditions} = pinnedV22();
  assert.deepEqual([previousVersion, version], [22, 24]); // PR #905 reserves leak v23.
  assert.deepEqual(conditions, previousConditions);
  assert.deepEqual(sourceHashes.map(source => source.path), previousSources.map(source => source.path));
  const before = new Map(previousSources.map(source => [source.path, source.sha256]));
  assert.deepEqual(sourceHashes.filter(source => before.get(source.path) !== source.sha256).map(source => source.path),
    ['load/search-engines/d3r-leak/manifest.ts', 'load/search-engines/d3r/manifest.ts', 'server/src/auth.rs']);
});
