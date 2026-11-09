import assert from 'node:assert/strict';
import test from 'node:test';
import { summaryForReport } from './summary.ts';

test('result artifacts omit k6 setup credentials and unknown future fields', () => {
  const raw = { metrics: { delivered_messages: { count: 10 } }, options: {}, state: {},
    setup_data: { token: 'secret-bearer', tokens: ['secret-session'] }, future_field: 'secret-password' };
  const output = JSON.stringify(summaryForReport(raw));
  assert.equal(output.includes('secret'), false);
  assert.deepEqual(JSON.parse(output).metrics, raw.metrics);
});
