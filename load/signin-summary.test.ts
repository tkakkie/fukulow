import assert from 'node:assert/strict';
import test from 'node:test';
import { distribution, requests, summarize, type Attempt } from './signin-summary.ts';
test('nearest rank percentiles, unordered input, empty and singleton', () => {
  assert.deepEqual(distribution([]), { count: 0, p50: null, p95: null, p99: null });
  assert.deepEqual(distribution([7]), { count: 1, p50: 7, p95: 7, p99: 7 });
  assert.deepEqual(distribution(Array.from({length:100}, (_,i) => 100-i)), { count:100, p50:50, p95:95, p99:99 });
});
test('all statuses partition attempts; before builds need no 503', () => {
  const attempts: Attempt[] = [200, 401, 429, 503, 500, 0].map((status,i) => ({kind:'correct', status, ms:i+1}));
  const result = requests(attempts);
  assert.equal(result.successRate, 1/6);
  assert.deepEqual(result.rejections, {passwordAdmission503:1, throttle429:1, unauthorized401:1, other:2});
  assert.equal(result.successLatencyMs.p99, 1);
  assert.equal(requests(attempts.filter(a => a.status !== 503)).rejections.passwordAdmission503, 0);
  assert.equal(requests([]).successRate, null);
});
test('Organization B stays separate; sampled resource mean and peak', () => {
  const result = summarize([{kind:'unknown', status:401, ms:10}, {kind:'organization_b', status:200, ms:2}],
    [{at:'a',cpuPercent:10,rssKiB:100,connections:3,active:1}, {at:'b',cpuPercent:30,rssKiB:200,connections:5,active:2}]);
  assert.equal(result.signin.total, 1);
  assert.equal(result.byKind.organization_b.successRate, 1);
  assert.deepEqual(result.resources.cpuPercent, {mean:20,peak:30});
  assert.deepEqual(result.resources.dbConnectionsInUse, {mean:4,peak:5});
  assert.equal(summarize([], []).resources.rssKiB.peak, null);
});
