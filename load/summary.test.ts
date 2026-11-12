import assert from 'node:assert/strict';
import test from 'node:test';
import { requireSuccessfulRun, summaryForReport } from './summary.ts';

test('result artifacts omit k6 setup credentials and unknown future fields', () => {
  const raw = { metrics: { delivered_messages: { count: 10 } }, options: {}, state: {},
    setup_data: { token: 'secret-bearer', tokens: ['secret-session'] }, future_field: 'secret-password' };
  const output = JSON.stringify(summaryForReport(raw));
  assert.equal(output.includes('secret'), false);
  assert.deepEqual(JSON.parse(output).metrics, raw.metrics);
});

test('nonzero generator exit rejects a complete summary and names failed conditions without setup secrets', () => {
  const summary = { metrics: {
    checks: { thresholds: { 'rate==1': { ok: false } } },
    throughput_other: { thresholds: { 'count==0': { ok: false } } },
    throughput_accepted: { thresholds: { 'count>=0': { ok: true } } },
  }, setup_data: { token: 'secret-bearer' }, future_field: 'secret-password' };
  assert.throws(() => requireSuccessfulRun(2, summary), (error: Error) => {
    assert.match(error.message, /Invalid measurement: generator exited with code 2/);
    assert.match(error.message, /checks: rate==1/);
    assert.match(error.message, /throughput_other: count==0/);
    assert.doesNotMatch(error.message, /secret|throughput_accepted/);
    return true;
  });
});

test('nonzero exit without threshold details still rejects the measurement', () => {
  for (const summary of [undefined, { metrics: {} }]) {
    assert.throws(() => requireSuccessfulRun(1, summary), /code 1; no failed threshold details available/);
  }
  assert.doesNotThrow(() => requireSuccessfulRun(0, { metrics: {} }));
});
