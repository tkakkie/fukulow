import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyLog, readLogLine } from './revocation-holds-log.ts';

test('notice permit logs preserve fixed caller counters and ignore malformed or off-target events', () => {
  const log = emptyLog();
  const fields: Record<string, unknown> = {
    event: 'notice_permit_sample', server_ms: 250.5, permits_total: 0,
    all_pass_in_flight: 0, all_pass_statements: 0, all_pass_us_total: 0,
  };
  for (const tag of ['retry', 'handoff', 'publish', 'revoked', 'scoped']) {
    for (const field of ['waiting', 'holding', 'holding_checked_out', 'granted', 'wait_abandoned', 'wait_count',
      'wait_granted_us_total', 'wait_abandoned_us_total', 'hold_us_total', 'pool_wait_us_total', 'statement_us_total']) {
      fields[`${tag}.${field}`] = 0;
    }
    for (const ms of [1, 5, 10, 50, 100, 250, 500, 1000, 2500, 5000]) fields[`${tag}.wait_le_${ms}_ms`] = 0;
  }
  for (const tag of ['retry', 'handoff']) {
    fields[`${tag}.deadline_exits_before_attempt`] = 0;
    fields[`${tag}.deadline_exits_after_attempt`] = 0;
  }

  const line = (fields: object, target = 'fukulow_revocation_measurement') => JSON.stringify({ target, fields });
  readLogLine(log, line(fields), 500);
  assert.equal(log.permits[0].permits_total, 0);
  Object.assign(fields, {
    server_ms: 500.5, permits_total: 9, all_pass_in_flight: 1, 'retry.holding': 8,
    'publish.holding': 1, 'retry.wait_abandoned': 2, 'retry.deadline_exits_before_attempt': 1,
  });
  readLogLine(log, line(fields), 501);
  assert.equal(log.permits[1].retry.holding, 8);
  assert.equal(log.permits[1].publish.holding, 1);
  assert.equal(log.permits[1].retry.wait_abandoned, 2);
  assert.equal(log.permits[1].retry.deadline_exits_before_attempt, 1);
  assert.equal(log.permits[1].all_pass_in_flight, 1);
  for (const malformed of ['null', '{', line(fields, 'fukulow'), line({ ...fields, server_ms: '500' }),
    line({ ...fields, 'retry.holding': -1 }), line({ ...fields, 'retry.wait_le_1_ms': undefined })]) {
    readLogLine(log, malformed, 502);
  }
  assert.equal(log.permits.length, 2);
  readLogLine(log, line({ event: 'revocation_holds_sample', server_ms: 501, active_holds: 3, high_water_mark: 4, retry_attempts: 12 }), 503);
  assert.deepEqual(log.holds, [{ serverMs: 501, activeHolds: 3, highWaterMark: 4, retryAttempts: 12 }]);
});
