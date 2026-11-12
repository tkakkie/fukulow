import assert from 'node:assert/strict';
import test from 'node:test';
import { distribution, requests, resourceSample, summarize, type Attempt, type Sample } from './signin-summary.ts';
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
    [{at:'a',cpuPercent:10,rssKiB:100,rssAnonKiB:80,threads:8,connections:3,active:1},
      {at:'b',cpuPercent:30,rssKiB:200,rssAnonKiB:180,threads:12,connections:5,active:2}]);
  assert.equal(result.signin.total, 1);
  assert.equal(result.byKind.organization_b.successRate, 1);
  assert.deepEqual(result.resources.cpuPercent, {mean:20,peak:30});
  assert.deepEqual(result.resources.dbConnectionsInUse, {mean:4,peak:5});
  assert.deepEqual(result.resources.rssAnonKiB, {mean:130,peak:180});
  assert.deepEqual(result.resources.threads, {mean:10,peak:12});
  assert.equal(summarize([], []).resources.rssKiB.peak, null);
  assert.equal(summarize([], []).resources.rssAnonKiB.mean, null);
  assert.equal(summarize([], []).resources.threads.peak, null);
  assert.equal(summarize([], []).postIdleSample, null);
});
test('post-drain idle sample is reported separately from workload means and peaks', () => {
  const busy: Sample = {at:'busy',cpuPercent:200,rssKiB:500,rssAnonKiB:450,threads:20,connections:10,active:4};
  const idle: Sample = {at:'idle',cpuPercent:0,rssKiB:600,rssAnonKiB:550,threads:6,connections:2,active:0};
  const result = summarize([], [busy], idle);
  assert.equal(result.resources.samples, 1);
  assert.deepEqual(result.resources.rssKiB, {mean:500,peak:500});
  assert.deepEqual(result.resources.rssAnonKiB, {mean:450,peak:450});
  assert.deepEqual(result.resources.threads, {mean:20,peak:20});
  assert.deepEqual(result.postIdleSample, idle);
});
test('resource sampler reads Linux status fields and rejects missing or malformed metrics', () => {
  const status = 'Name:\tfukulow-server\nVmRSS:\t 123456 kB\nRssAnon:\t 120000 kB\nThreads:\t24\n';
  assert.deepEqual(resourceSample('now',' 123.45%\n',status,'8|3\n'),
    {at:'now',cpuPercent:123.45,rssKiB:123456,rssAnonKiB:120000,threads:24,connections:8,active:3});
  for (const field of ['VmRSS', 'RssAnon', 'Threads']) {
    assert.throws(() => resourceSample('now','0%',status.replace(new RegExp(`^${field}:.*\\n`, 'm'), ''),'0|0'));
    assert.throws(() => resourceSample('now','0%',status.replace(new RegExp(`(${field}:\\s+)\\d+`), '$1invalid'),'0|0'));
  }
  for (const [cpu, connections] of [['','0|0'], ['oops','0|0'], ['0%',''], ['0%','1|invalid']]) {
    assert.throws(() => resourceSample('now',cpu,status,connections));
  }
});
