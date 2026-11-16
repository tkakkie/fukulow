import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appEvidence } from './app-evidence.ts';

const t0 = Date.parse('2026-11-17T00:00:00Z');
const at = (ms: number) => new Date(t0 + ms).toISOString().replace('Z', '123Z');
const line = (ms: number, fields: Record<string, unknown>, span?: Record<string, unknown>) =>
  JSON.stringify({ timestamp: at(ms), level: 'INFO', fields, target: 'fukulow', ...(span ? { span } : {}) });
const pool = (sequence: number, extra: Record<string, number> = {}) => line(sequence * 1000 - 500, { event: 'pool_stats', version: 1,
  sample_sequence: sequence, in_use: 1, idle: 19, waiting: 0, acquire_success: sequence * 10, acquire_timeout: 0, acquire_closed: 0,
  acquire_io: 0, acquire_database: 0, acquire_other: 0, acquire_cancelled: 0, wait_le_1000000_us: sequence * 10, wait_count: sequence * 10, ...extra });
const pools = (n: number, extra: (i: number) => Record<string, number> = () => ({})) => Array.from({ length: n }, (_, i) => pool(i + 1, extra(i + 1)));

test('aggregates pool deltas, failure kinds, close codes with times and socket rates within the window', () => {
  const log = [
    ...pools(8, i => i >= 5 ? { in_use: 20, idle: 0, waiting: 40, acquire_timeout: 3, wait_count: i * 10 + 3 } : {} as Record<string, number>),
    line(500, { event: 'websocket_opened' }), // before the window: counts toward concurrency only
    ...Array.from({ length: 5 }, (_, i) => line(2000 + i * 100, { event: 'websocket_opened' })),
    line(4100, { event: 'database_failure', kind: 'pool_timeout' }),
    line(4200, { event: 'websocket_closed', code: '1011' }), line(4300, { event: 'websocket_disconnected' }),
    line(5900, { event: 'websocket_closed', code: '1011' }),
    line(4400, { event: 'http_completed' }, { status: 503, route: '/api/v1/x' }),
    line(9900, { event: 'websocket_closed', code: '1011' }), // after the window
    'not json from the runtime',
  ].join('\n');
  const evidence = appEvidence(log, t0 + 1000, t0 + 7000);
  assert.deepEqual(evidence.reasons, []);
  assert.equal(evidence.complete, true);
  assert.deepEqual({ ...evidence.pool, deltas: undefined }, { samples: 8, maxInUse: 20, minIdle: 0, maxWaiting: 40, deltas: undefined, acquireWaitsOver1s: 3 });
  assert.equal(evidence.pool?.deltas.acquire_timeout, 3);
  assert.equal(evidence.databaseFailures.pool_timeout, 1);
  assert.deepEqual(evidence.closes['1011'], { count: 2, firstMs: 3200, lastMs: 4900, perSecond: [[3, 1], [4, 1]] });
  assert.deepEqual(evidence.sockets, { opened: 5, disconnected: 1, peakConcurrent: 6, peakOpenedPerSecond: 5, openedPerSecond: 13 });
  assert.equal(evidence.http5xx, 1);
  // Only aggregates leave the module: no route, raw line or other field.
  assert.doesNotMatch(JSON.stringify(evidence), /api\/v1|not json/);
});

test('missing, rotated, restarted or late pool samples make the evidence incomplete', () => {
  const window = [t0 + 1000, t0 + 4000] as const;
  const reasons = (log: string[]) => { const e = appEvidence(log.join('\n'), ...window); assert.equal(e.complete, false); return e.reasons.join('; '); };
  assert.match(reasons([]), /missing pool_stats/);
  assert.match(reasons(pools(6).slice(1)), /does not start at sequence 1/);
  assert.match(reasons([...pools(3), pool(1), pool(2)]), /sequence gap or restart/);
  assert.match(reasons(pools(3)), /after the window/);
  assert.match(reasons([...pools(6), line(1500, { event: 'websocket_closed', code: '9999' })]), /unknown websocket_closed code/);
  assert.match(reasons([...pools(6), line(1500, { event: 'database_failure', kind: 'new' })]), /unknown database_failure kind/);
  assert.match(reasons([...pools(6), '{"fields":{"event":"websocket_closed"'] ), /unparseable/);
  assert.match(appEvidence(pools(6).join('\n'), ...window, 'docker logs exited 1').reasons.join(), /docker logs exited 1/);
  // The panic hook writes no timestamp: counted, never silently dropped.
  const panic = appEvidence([...pools(6), '{"level":"ERROR","target":"fukulow","fields":{"event":"panic"}}'].join('\n'), ...window);
  assert.equal(panic.panics, 1);
});
