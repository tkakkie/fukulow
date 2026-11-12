import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logLatenciesMs, percentile, statementAveragesMs } from './hot-latency.ts';

test('percentile uses the nearest rank', () => {
  const samples = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(samples, 50), 50);
  assert.equal(percentile(samples, 95), 95);
  assert.equal(percentile(samples, 99), 99);
  assert.equal(percentile([7], 95), 7);
  assert.throws(() => percentile([], 95));
});

test('pgbench log latencies are microseconds in the third field', () => {
  assert.deepEqual(logLatenciesMs('0 1 172 0 1763000000 123\n0 2 95 0 1763000000 456\n'), [0.172, 0.095]);
  assert.throws(() => logLatenciesMs('0 1 abc 0 1 2'));
  assert.throws(() => logLatenciesMs('0 1 172'));
});

test('statement averages skip meta-commands', () => {
  const report = [
    'latency average = 0.172 ms',
    '         0.000           0 \\set before random(52, 100000)',
    '         0.026           0 BEGIN;',
    '         0.092           0 SELECT id FROM messages',
  ].join('\n');
  assert.deepEqual(statementAveragesMs(report), [
    { ms: 0.026, command: 'BEGIN;' },
    { ms: 0.092, command: 'SELECT id FROM messages' },
  ]);
});
