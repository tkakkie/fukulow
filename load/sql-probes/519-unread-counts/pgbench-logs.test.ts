import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { clientLatencies, parsePgbenchLine, threadLogs, writeThreadLogs } from './pgbench-logs.ts';
import { logLatenciesMs } from './probe.ts';

test('pgbench raw log parser preserves transaction identity and epoch', () => {
  assert.deepEqual(parsePgbenchLine('4 12 1100 0 1700000000 500000'), {
    clientId: 4, transactionNo: 12, latencyUs: 1100, epochSeconds: 1700000000, epochMicros: 500000,
  });
  assert.throws(() => parsePgbenchLine('who 12 1100 0 1700000000 500000'), /bad pgbench log line/);
  assert.throws(() => parsePgbenchLine('4 12 1100 0 1700000000 1000000'), /bad pgbench log line/);
});

test('pgbench keeps thread bytes and legacy latency order and summarizes each client', () => {
  const a = '2 1 3000 0 1700000000 500000\n4 1 1100 0 1700000000 600000\n2 2 1000 0 1700000000 700000\n';
  const b = '0 1 3400 0 1700000000 900000\n';
  const threads = threadLogs(['pgb-block1.123', a, 'pgb-block1.123.1', b, ''].join('\0'), 'pgb-block1');
  assert.equal(logLatenciesMs([...threads.values()].join('')).join('\n') + '\n', '3\n1.1\n1\n3.4\n');
  assert.deepEqual(clientLatencies(threads), [
    { clientId: 0, count: 1, meanMs: 3.4, p50Ms: 3.4, p99Ms: 3.4 },
    { clientId: 2, count: 2, meanMs: 2, p50Ms: 1, p99Ms: 3 },
    { clientId: 4, count: 1, meanMs: 1.1, p50Ms: 1.1, p99Ms: 1.1 },
  ]);
  const archive = new Map<string, string>();
  writeThreadLogs(threads, (name, contents) => archive.set(name, gunzipSync(contents).toString()));
  assert.deepEqual([...archive], [['pgb-block1.123.gz', a], ['pgb-block1.123.1.gz', b]]);
  assert.throws(() => threadLogs('pgb-block1.123\0partial', 'pgb-block1'), /incomplete/);
});
