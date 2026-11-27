import assert from 'node:assert/strict';
import test from 'node:test';
import { productionPath } from '../d3r/path.ts';
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
