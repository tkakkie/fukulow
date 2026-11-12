import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySend, throughputPlan, throughputReport, sampledCpuPeaks } from './throughput-summary.ts';

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

test('classify every HTTP outcome without retrying; only 503 requires Retry-After', () => {
  for (const status of [200, 201, 299]) assert.deepEqual(classifySend(status), { outcome: 'accepted', invalidRetryAfter: false });
  for (const status of [0, 199, 300, 400, 429, 500, 504]) assert.deepEqual(classifySend(status, '2'), { outcome: 'other', invalidRetryAfter: false });
  assert.deepEqual(classifySend(503, '5'), { outcome: 'rejected503', invalidRetryAfter: false });
  for (const retry of [undefined, '', '0', '-1', '1.5', 'abc']) assert.equal(classifySend(503, retry).invalidRetryAfter, true);
});

test('per-step report uses in-window accepts, isolates percentiles, and exposes generator drops and incomplete requests', () => {
  const steps = throughputPlan('10,100', '5', 3);
  const metrics = Object.fromEntries(Object.entries({
    throughput_attempted: { count: 50 }, throughput_accepted: { count: 30 },
    throughput_accepted_in_window: { count: 20 }, throughput_503: { count: 15 },
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
  assert.equal(row.rejected503Rate, 0.3);
  assert.equal(row.otherErrorRate, 0.08);
  assert.equal(row.invalidRetryAfter, 1);
  assert.deepEqual(row.retryAfterSeconds, { min: 1, max: 5 });
  assert.equal(row.droppedIterations, 2);
  assert.equal(row.incomplete, 1);
  assert.equal(report.steps[1].rejected503Rate, null);
  assert.deepEqual(report.steps[1].acceptedLatencyMs, { p50: null, p95: null, p99: null });
});

test('sampled CPU peaks identify app, DB and generator and preserve missing samples', () => {
  assert.deepEqual(sampledCpuPeaks([{ at: 'now', rss: [], rows: [
    { Name: 'app-1', CPUPerc: '120.50%' }, { Name: 'db-1', CPUPerc: '40.0%' },
    { Name: 'unrelated', CPUPerc: '999%' },
  ] }, { at: 'later', rss: [], rows: [{ Name: 'app-1', CPUPerc: '30%' }] }],
  { app: 'app-1', db: 'db-1', generator: 'generator' }), { app: 120.5, db: 40, generator: null });
});
