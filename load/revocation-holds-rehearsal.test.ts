import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GATE_OFF, GATE_ON, holdsFixture } from './revocation-holds-fixture.ts';
import { rehearsalCounts } from './revocation-holds-rehearsal.ts';

test('a rehearsal reports counts only, with no verdict', () => {
  const run = holdsFixture(); run.serverCloses = [{ at: 1, wallMs: 1 }]; run.targets[0].close = { at: 70_000, code: 1000 };
  const counts = rehearsalCounts(run);
  assert.deepEqual(counts.stallBytesAfterResume, { min: 64_000, median: 64_000, max: 64_000 });
  assert.deepEqual(counts.stallMessagesAfterResume, { min: 120, median: 120, max: 120 });
  assert.deepEqual(counts.closes, { targetClient: 1, proxy: 0, bystander: 0, server: 1 });
  assert.deepEqual(counts.highWaterMarkAtHoldsEnd, { lowest: 512, highest: 512 });
  assert.equal(counts.retriesInFault, 1536);
  assert.deepEqual(counts.gate, { on: [GATE_ON, GATE_ON], off: [GATE_OFF, GATE_OFF], onMs: 0, offMs: 0 });
  assert.deepEqual(counts.mutationsMs.revoke, { min: 100, median: 100, max: 100 });
  assert.equal(counts.mutationsMs.restore, null);
  const text = JSON.stringify(counts);
  for (const word of ['verdict', 'PASS', 'FAIL', 'INVALID', 'CONTROL', 'reasons', 'result']) assert.ok(!text.includes(word), word);
});
