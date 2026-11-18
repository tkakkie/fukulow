import assert from 'node:assert/strict';
import test from 'node:test';
import { distribution, judgePartA, poolAcquireTimeoutInLog, requests, resourceSample, summarize,
  type Attempt, type Sample } from './signin-summary.ts';
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

function partASummary({
  readStatus = 200, readMs = 12.8, extraStatus = 401, peak = 19, correctSuccesses = 3, correctMs = 306,
} = {}) {
  const attempts: Attempt[] = [
    { kind: 'organization_b', status: readStatus, ms: readMs },
    { kind: 'wrong_known', status: extraStatus, ms: 10 },
    { kind: 'unknown', status: 429, ms: 1 },
    ...Array.from({ length: 4 }, (_, index): Attempt => index < correctSuccesses
      ? { kind: 'correct', status: 200, ms: correctMs }
      : { kind: 'correct', status: 503, ms: 1 }),
  ];
  const sample: Sample = { at: 'sample', cpuPercent: 0, rssKiB: 0, rssAnonKiB: 0, threads: 1, connections: peak, active: 0 };
  return summarize(attempts, [sample]);
}

test('Part A passes all four conditions at the inclusive latency and rate boundaries', () => {
  const judgment = judgePartA(partASummary(), 20, false);
  assert.deepEqual(judgment.checks, { A1: 'pass', A2: 'pass', A3: 'pass', A4: 'pass' });
  assert.equal(judgment.passed, true);
});

test('Part A rejects a failed or slow Organization B read', () => {
  assert.equal(judgePartA(partASummary({ readStatus: 500 }), 20, false).checks.A1, 'fail');
  assert.equal(judgePartA(partASummary({ readMs: 12.81 }), 20, false).checks.A1, 'fail');
});

test('Part A rejects unexpected sign-in responses, transport failures and logged pool timeouts', () => {
  for (const status of [0, 204, 500]) {
    assert.equal(judgePartA(partASummary({ extraStatus: status }), 20, false).checks.A2, 'fail');
  }
  assert.equal(judgePartA(partASummary(), 20, true).checks.A2, 'fail');
});

test('Part A requires the sampled peak to stay strictly below the app pool maximum', () => {
  for (const peak of [20, 21]) {
    assert.equal(judgePartA(partASummary({ peak }), 20, false).checks.A3, 'fail');
  }
});

test('Part A rejects low correct-sign-in success rates or slow successful sign-ins', () => {
  assert.equal(judgePartA(partASummary({ correctSuccesses: 2 }), 20, false).checks.A4, 'fail');
  assert.equal(judgePartA(partASummary({ correctMs: 306.01 }), 20, false).checks.A4, 'fail');
  assert.equal(judgePartA(partASummary({ correctSuccesses: 0 }), 20, false).checks.A4, 'fail');
});

test('Part A reports missing results, missing logs or an unknown pool maximum as ambiguous', () => {
  assert.deepEqual(judgePartA(summarize([], []), null, null).checks,
    { A1: 'ambiguous', A2: 'ambiguous', A3: 'ambiguous', A4: 'ambiguous' });
  assert.equal(judgePartA(partASummary(), null, null).passed, false);
});

test('pool timeout evidence recognizes current structured logs and legacy SQLx logging', () => {
  const log = (fields: object) => JSON.stringify({ target: 'fukulow', fields });
  assert.equal(poolAcquireTimeoutInLog(log({ event: 'database_failure', kind: 'pool_timeout' })), true);
  assert.equal(poolAcquireTimeoutInLog(log({ event: 'pool_stats', version: 1, acquire_timeout: 1 })), true);
  assert.equal(poolAcquireTimeoutInLog(log({ event: 'pool_stats', version: 1, acquire_timeout: 0 })), false);
  assert.equal(poolAcquireTimeoutInLog('database operation failed: pool timed out while waiting for an open connection'), true);
  assert.equal(poolAcquireTimeoutInLog(log({ event: 'database_failure', kind: 'deadline' })), false);
  assert.equal(poolAcquireTimeoutInLog(''), null);
  assert.equal(poolAcquireTimeoutInLog('{'), null);
});
