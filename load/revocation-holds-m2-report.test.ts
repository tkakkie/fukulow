import assert from 'node:assert/strict';
import { test } from 'node:test';
import { permitFaultEvidence } from './revocation-holds-m2-report.ts';
import type { NoticePermitSample } from './revocation-holds-permits.ts';

const counters = {
  waiting: 0, holding: 0, holding_checked_out: 0, granted: 0, wait_abandoned: 0, wait_count: 0,
  wait_granted_us_total: 0, wait_abandoned_us_total: 0, hold_us_total: 0, pool_wait_us_total: 0, statement_us_total: 0,
  wait_le_1_ms: 0, wait_le_5_ms: 0, wait_le_10_ms: 0, wait_le_50_ms: 0, wait_le_100_ms: 0, wait_le_250_ms: 0,
  wait_le_500_ms: 0, wait_le_1000_ms: 0, wait_le_2500_ms: 0, wait_le_5000_ms: 0,
};
const deadlines = { deadline_exits_before_attempt: 0, deadline_exits_after_attempt: 0 };
const sample = (serverMs: number, holding: number, waiting = 0, permits_total = 9): NoticePermitSample => ({
  serverMs, permits_total, all_pass_in_flight: 1, all_pass_statements: 0, all_pass_us_total: 0,
  retry: { ...counters, ...deadlines, holding, waiting }, handoff: { ...counters, ...deadlines },
  revoked: counters, publish: counters, scoped: counters,
});

test('M2 B1 uses 80% permit occupancy and reports relay observations separately', () => {
  const permits = [
    sample(0, 9), sample(200, 9, 1), sample(400, 8), sample(600, 9), sample(800, 9), sample(900, 9),
    sample(950, 0, 0, 0), sample(1000, 9),
  ];
  permits[2].publish = { ...counters, holding: 1 };
  permits[5].retry = { ...permits[5].retry, wait_abandoned: 2, hold_us_total: 4_500_000, pool_wait_us_total: 1_000_000, statement_us_total: 3_500_000 };
  permits[5].revoked = { ...counters, holding: 1 };
  const run = {
    kind: 'fault', duration: 'short', times: { gateOn: [10, 20], gateOff: [1020, 1030] },
    sendTiming: { offsetBoundsMs: [10, 30], uncertaintyMs: 20, records: [] },
    permits, statements: [{ at: 210, ms: 20, fallback: false, recheck: true, error: false }],
  } satisfies Parameters<typeof permitFaultEvidence>[0];
  const report = permitFaultEvidence(run, 1000)!;
  assert.deepEqual(report.b1, {
    samples: 5, permitsTotal: [9], saturatedSamples: 4, met: true, occupancyTimeFraction: 0.5,
    relayInFlight: { samplesAtNine: 0, max: 1 },
  });
  assert.deepEqual(report.b2, { preAttemptDeadlines: 0, waitAbandoned: 2, nonDeadlineDrops: 2, saturatedSamplesWithRetryWaiting: 1, met: true });
  assert.deepEqual(report.b3.callerTiming.retry, { holdUs: 4_500_000, poolWaitUs: 1_000_000, statementUs: 3_500_000 });
  assert.equal(report.b3.retryAttemptsPerSecond, 1000);
  assert.equal(report.b3.expectedAttemptsPerSecond, 450);
  assert.equal(report.shortFaultRetryBandFlag, true);
  permits[2].publish = counters;
  permits[5].retry.deadline_exits_before_attempt = 1;
  permits[1].retry.waiting = 0;
  const unsaturated = permitFaultEvidence(run, 1115)!;
  assert.equal(unsaturated.b1.met, false);
  assert.equal(unsaturated.b2.met, true);
  assert.equal(unsaturated.b2.nonDeadlineDrops, 1);
  assert.equal(unsaturated.shortFaultRetryBandFlag, false);
});
