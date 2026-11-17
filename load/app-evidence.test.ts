import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appEvidence, proxyEvidence } from './app-evidence.ts';

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
    line(4200, { event: 'websocket_closed', code: '1011', cause: 'notification' }), line(4300, { event: 'websocket_disconnected' }),
    line(5900, { event: 'websocket_closed', code: '1011', cause: 'connection' }),
    line(4400, { event: 'http_completed' }, { status: 503, route: '/api/v1/x' }),
    line(9900, { event: 'websocket_closed', code: '1011', cause: 'notification' }), // after the window
    'not json from the runtime',
  ].join('\n');
  const evidence = appEvidence(log, t0 + 1000, t0 + 7000);
  assert.deepEqual(evidence.reasons, []);
  assert.equal(evidence.complete, true);
  assert.deepEqual({ ...evidence.pool, deltas: undefined }, { samples: 8, maxInUse: 20, minIdle: 0, maxWaiting: 40, deltas: undefined, acquireWaitsOver1s: 3 });
  assert.equal(evidence.pool?.deltas.acquire_timeout, 3);
  assert.equal(evidence.databaseFailures.pool_timeout, 1);
  assert.deepEqual(evidence.closes['1011'], { count: 2, firstMs: 3200, lastMs: 4900, perSecond: [[3, 1], [4, 1]] });
  assert.deepEqual(evidence.causes1011, { shutdown: 0, session: 0, overflow: 0, notification: 1, connection: 1, peer: 0 });
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
  // A 1011 without a known close site cannot be attributed: incomplete, not silently uncounted.
  assert.match(reasons([...pools(6), line(1500, { event: 'websocket_closed', code: '1011' })]), /unknown websocket_closed cause/);
  assert.match(reasons([...pools(6), line(1500, { event: 'websocket_closed', code: '1011', cause: 'pool' })]), /unknown websocket_closed cause/);
  assert.match(reasons([...pools(6), '{"fields":{"event":"websocket_closed"'] ), /unparseable/);
  assert.match(appEvidence(pools(6).join('\n'), ...window, 'docker logs exited 1').reasons.join(), /docker logs exited 1/);
  // The panic hook writes no timestamp: counted, never silently dropped.
  const panic = appEvidence([...pools(6), '{"level":"ERROR","target":"fukulow","fields":{"event":"panic"}}'].join('\n'), ...window);
  assert.equal(panic.panics, 1);
});

test('out-of-order lines, pre-window sockets, teardown and other app warnings', () => {
  const log = [
    ...pools(8),
    line(200, { event: 'websocket_opened' }), line(300, { event: 'websocket_opened' }), line(400, { event: 'websocket_opened' }),
    line(1500, { event: 'websocket_disconnected' }),
    // Threads format timestamps before the stderr lock: 2999 is written after 3000.
    line(3000, { event: 'websocket_closed', code: '1011', cause: 'notification' }), line(2999, { event: 'websocket_closed', code: '1011', cause: 'notification' }),
    line(3001, { event: 'websocket_closed', code: '1011', cause: 'notification' }),
    line(2100, { event: 'websocket_opened' }), line(2000, { event: 'websocket_opened' }),
    { ...JSON.parse(line(2500, { event: 'work_deadline_expired' })), level: 'WARN' },
  ].map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n');
  const evidence = appEvidence(log, t0 + 1000, t0 + 6000);
  assert.deepEqual(evidence.reasons, []);
  assert.deepEqual(evidence.closes['1011'], { count: 3, firstMs: 1999, lastMs: 2001, perSecond: [[1, 1], [2, 2]] });
  // Three sockets were open before the window; one closed inside it, two more opened.
  assert.equal(evidence.sockets.peakConcurrent, 4);
  assert.equal(evidence.sockets.peakOpenedPerSecond, 2);
  assert.deepEqual(evidence.otherWarnings, { work_deadline_expired: 1 });
  // Two samples in the same millisecond keep their sequence order and are not a restart.
  const same = [pool(1), pool(2), line(1500, { ...JSON.parse(pool(3)).fields }), ...pools(6).slice(3)];
  assert.equal(appEvidence(same.join('\n'), t0 + 1000, t0 + 4000).reasons.includes('pool_stats sequence gap or restart'), false);
  // A restart reports every missing edge and keeps no cross-process deltas.
  const restarted = appEvidence([...pools(3), pool(1)].join('\n'), t0 + 1000, t0 + 9000);
  assert.equal(restarted.pool, null);
  assert.match(restarted.reasons.join(), /sequence gap or restart/);
  assert.match(restarted.reasons.join(), /after the window/);
});

test('proxy evidence keeps only level counts in the window', () => {
  const nginx = ['2026/11/17 00:00:00 [warn] 1#1: startup', '2026/11/17 00:00:02 [error] 7#7: *1 upstream timed out, request: "GET /api/v1/x"',
    '2026/11/17 00:00:03 [alert] 7#7: 1024 worker_connections are not enough', 'entrypoint text', '2026/11/17 00:00:09 [error] late'].join('\n');
  const n = proxyEvidence(nginx, 'nginx', t0 + 1000, t0 + 5000);
  assert.deepEqual(n, { complete: true, reasons: [], levels: { error: 1, alert: 1 }, errorLines: 2 });
  assert.doesNotMatch(JSON.stringify(n), /api|upstream/);
  const caddy = [JSON.stringify({ level: 'info', ts: (t0 + 2000) / 1000, msg: 'x' }), JSON.stringify({ level: 'error', ts: (t0 + 3000) / 1000, msg: '/api/v1/y' })].join('\n');
  assert.deepEqual(proxyEvidence(caddy, 'caddy', t0 + 1000, t0 + 5000).errorLines, 1);
  assert.equal(proxyEvidence('', 'caddy', t0, t0 + 1, 'docker logs exited 1').complete, false);
});
