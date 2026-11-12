import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySend, selectSender, throughputPlan, throughputReport, sampledCpuPeaks } from './throughput-summary.ts';

test('steps hold a fixed offered rate and allow the previous step to drain', () => {
  assert.deepEqual(throughputPlan('10,100,1000', '5', 3), [
    { name: 'step_1', rate: 10, seconds: 5, startSeconds: 0 },
    { name: 'step_2', rate: 100, seconds: 5, startSeconds: 9 },
    { name: 'step_3', rate: 1000, seconds: 5, startSeconds: 18 },
  ]);
  for (const rates of ['', '1,', '0', '-1', '1.5', 'NaN', '9007199254740992']) {
    assert.throws(() => throughputPlan(rates, '5', 3));
  }
  assert.throws(() => throughputPlan('10', '0', 3));
});

test('classify mixed HTTP outcomes separately; 429 and 503 require Retry-After', () => {
  assert.deepEqual([201, 429, 503, 500].map(status => classifySend(status, '2').outcome),
    ['accepted', 'rejected429', 'rejected503', 'other']);
  for (const status of [200, 201, 299]) assert.deepEqual(classifySend(status), { outcome: 'accepted', invalidRetryAfter: false });
  for (const status of [0, 199, 300, 400, 500, 504]) assert.deepEqual(classifySend(status, '2'), { outcome: 'other', invalidRetryAfter: false });
  for (const status of [429, 503]) {
    assert.deepEqual(classifySend(status, '5'), { outcome: status === 429 ? 'rejected429' : 'rejected503', invalidRetryAfter: false });
    for (const retry of [undefined, '', '0', '-1', '1.5', 'abc']) assert.equal(classifySend(status, retry).invalidRetryAfter, true);
  }
});

for (const [channels, members] of [[1, 2], [1, 4], [200, 4], [3, 5]]) {
  test(`sender rotation covers every pair evenly with ${channels} Channels and ${members} Members`, () => {
    const counts = Array.from({ length: channels }, () => Array<number>(members).fill(0));
    for (let index = 0; index < channels * members * 2; index++) {
      const selection = selectSender(index, members, channels);
      assert.equal(selection.member, index % members);
      counts[selection.channel][selection.member]++;
      if ((index + 1) % (channels * members) === 0) {
        assert.deepEqual(counts, Array.from({ length: channels }, () => Array(members).fill((index + 1) / (channels * members))));
      }
    }
  });
}

test('per-step report uses in-window accepts, isolates percentiles, and exposes generator drops and incomplete requests', () => {
  const steps = throughputPlan('10,100', '5', 3);
  const metrics = Object.fromEntries(Object.entries({
    throughput_attempted: { count: 50 }, throughput_accepted: { count: 30 },
    throughput_accepted_in_window: { count: 20 }, throughput_429: { count: 5 }, throughput_503: { count: 10 },
    throughput_other: { count: 4 }, dropped_iterations: { count: 2 },
    throughput_completion_ms: { max: 6000 }, throughput_accepted_ms: { med: 10, 'p(95)': 50, 'p(99)': 80 },
    throughput_retry_after: { min: 1, max: 5 }, throughput_invalid_retry_after: { count: 1 },
  }).map(([key, values]) => [`${key}{scenario:step_1}`, { values }]));
  const report = throughputReport({ metrics }, steps);
  assert.equal(report.offered, 50);
  assert.equal(report.accepted, 30);
  const row = report.steps[0];
  assert.equal(row.offeredSendsPerSecond, 10);
  assert.equal(row.acceptedSendsPerSecond, 4);
  assert.equal(row.acceptedIncludingDrainPerSecond, 5);
  assert.equal(row.acceptedTail, 10);
  assert.deepEqual(row.acceptedLatencyMs, { p50: 10, p95: 50, p99: 80 });
  assert.equal(row.rejected429, 5);
  assert.equal(row.rejected429Rate, 0.1);
  assert.equal(row.rejected503, 10);
  assert.equal(row.rejected503Rate, 0.2);
  assert.equal(row.otherErrorRate, 0.08);
  assert.equal(row.invalidRetryAfter, 1);
  assert.deepEqual(row.retryAfterSeconds, { min: 1, max: 5 });
  assert.equal(row.droppedIterations, 2);
  assert.equal(row.incomplete, 1);
  assert.equal(report.steps[1].rejected429, 0);
  assert.equal(report.steps[1].rejected429Rate, null);
  assert.equal(report.steps[1].rejected503Rate, null);
  assert.deepEqual(report.steps[1].acceptedLatencyMs, { p50: null, p95: null, p99: null });
});

test('429-only steps preserve Retry-After samples and complete accounting', () => {
  const metrics = Object.fromEntries(Object.entries({
    throughput_attempted: { count: 2 }, throughput_429: { count: 2 },
    throughput_retry_after: { min: 1, max: 2 },
  }).map(([key, values]) => [`${key}{scenario:step_1}`, { values }]));
  const row = throughputReport({ metrics }, throughputPlan('10', '5', 3)).steps[0];
  assert.equal(row.rejected429Rate, 1);
  assert.equal(row.otherErrors, 0);
  assert.equal(row.incomplete, 0);
  assert.deepEqual(row.retryAfterSeconds, { min: 1, max: 2 });
});

test('sampled CPU peaks identify app, DB and generator and preserve missing samples', () => {
  assert.deepEqual(sampledCpuPeaks([{ at: 'now', rss: [], rows: [
    { Name: 'app-1', CPUPerc: '120.50%' }, { Name: 'db-1', CPUPerc: '40.0%' },
    { Name: 'unrelated', CPUPerc: '999%' },
  ] }, { at: 'later', rss: [], rows: [{ Name: 'app-1', CPUPerc: '30%' }] }],
  { app: 'app-1', db: 'db-1', generator: 'generator' }), { app: 120.5, db: 40, generator: null });
});
