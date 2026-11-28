import assert from 'node:assert/strict';
import test from 'node:test';
import { attributeLateBackends, markerPoolReason, preGrowReason } from './c3-pool.ts';

const pids = Array.from({ length: 20 }, (_, index) => 100 + index);

test('pre-grow is incomplete if it does not reach 20 distinct live backends', () => {
  assert.equal(preGrowReason(pids), undefined);
  assert.equal(preGrowReason(pids.slice(1)), 'pool pre-grow incomplete');
  assert.equal(preGrowReason([...pids.slice(1), pids[1]]), 'pool pre-grow incomplete');
});

test('pre-marker disconnection fails even if a replacement keeps the live count at 20', () => {
  assert.equal(markerPoolReason(pids, [...pids].reverse()), undefined);
  assert.match(markerPoolReason(pids, pids.slice(1))!, /disconnected before C3_COVERAGE_BEGIN/);
  assert.match(markerPoolReason(pids, [...pids.slice(1), 120])!, /disconnected before C3_COVERAGE_BEGIN/);
});

test('after-drain attribution decodes hexadecimal PIDs and labels absent backends unattributed', () => {
  const backend_start = '2026-11-28T00:00:00Z';
  const activity = [{ pid: 175, backend_start, state: 'idle', query: 'COMMIT' }];
  assert.deepEqual(attributeLateBackends([{ session: 'abc.af' }, { session: 'abc.b0' }], activity), [
    { session: 'abc.af', pid: 175, backend_start, state: 'idle', lastTask: 'COMMIT' },
    { session: 'abc.b0', pid: 176, backend_start: undefined, state: undefined, lastTask: 'unattributed' },
  ]);
});
