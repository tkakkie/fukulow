import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindStatement, FALLBACK_MARKER, frame, Framer, gateQuery, RECHECK_MARKER, rewriteParse } from './revocation-burst-relay.ts';
import { judge, peaks, percentile, poolWindow, verdictBySize, type Run } from './revocation-burst-judgment.ts';

const z = (s: string) => Buffer.from(`${s}\0`, 'utf8');
const parseBody = (name: string, query: string) => Buffer.concat([z(name), z(query), Buffer.from([0, 1, 0, 0, 0, 25])]);

test('rewriteParse gates only the recheck statement and keeps parameter types', () => {
  const recheck = `SELECT x FROM unnest($2::uuid[]) ${RECHECK_MARKER} ORDER BY r.n`;
  const out = rewriteParse(parseBody('sqlx_s_7', recheck));
  assert.equal(out.recheck, true);
  assert.equal(out.name, 'sqlx_s_7');
  assert.deepEqual(out.body, parseBody('sqlx_s_7', gateQuery(recheck)));
  const other = parseBody('sqlx_s_8', 'SELECT 1');
  assert.deepEqual(rewriteParse(other), { body: other, name: 'sqlx_s_8', recheck: false, fallback: false });
  const pass = parseBody('sqlx_s_9', `SELECT 1 FROM unnest($1::uuid[]) ${FALLBACK_MARKER}`);
  assert.deepEqual(rewriteParse(pass), { body: pass, name: 'sqlx_s_9', recheck: false, fallback: true });
});

test('bindStatement reads the statement after the portal', () => {
  assert.equal(bindStatement(Buffer.concat([z(''), z('sqlx_s_7'), Buffer.from([0, 0])])), 'sqlx_s_7');
});

test('Framer splits a startup message then typed messages across chunks', () => {
  const startup = Buffer.alloc(8); startup.writeInt32BE(8, 0); startup.writeInt32BE(196608, 4);
  const stream = Buffer.concat([startup, frame(0x50, parseBody('a', 'SELECT 1')), frame(0x53, Buffer.alloc(0))]);
  const seen: (number | null)[] = [];
  const framer = new Framer(true);
  for (let i = 0; i < stream.length; i += 3) framer.push(stream.subarray(i, i + 3), type => seen.push(type));
  assert.deepEqual(seen, [null, 0x50, 0x53]);
});

test('peaks counts 100 ms buckets and a sliding second', () => {
  assert.deepEqual(peaks([0, 10, 20, 150, 900, 1100]), { bucketPerSecond: 30, slidingSecond: 5 });
  assert.equal(percentile([5, 1, 3, 2, 4], 99), 5);
});

test('poolWindow takes bucket edges from bracketing cumulative samples', () => {
  const sample = (at: number, le100: number, le500: number, total: number, timeout = 0) => ({ at, fields: {
    wait_le_100_us: le100, wait_le_500_us: le500, ...Object.fromEntries([1000, 5000, 10000, 25000, 50000, 100000, 500000, 1000000, 5000000].map(e => [`wait_le_${e}_us`, total])), wait_count: total, acquire_timeout: timeout } });
  const w = poolWindow([sample(0, 10, 10, 10), sample(1000, 100, 108, 110, 2)], 0, 1000);
  assert.equal(w.p95Ms, 0.5); assert.equal(w.p99Ms, 1); assert.equal(w.timeouts, 2); assert.equal(w.acquisitions, 100);
});

const fixture = (): Run => {
  const statements = [];
  for (let t = 0; t < 40_000; t += 50) statements.push({ at: t, ms: 1, recheck: t % 100 === 0, fallback: false, error: false });
  const probes = (ms: number) => Array.from({ length: 800 }, (_, i) => ({ at: i * 50, ms, ok: true, status: 200 }));
  const counters = { revocation_held: 2, revocation_delivered_after_hold: 1, revocation_retired_fenced: 1, revocation_retired_registration_cap: 0, revocation_retired_global_cap: 0, revocation_retired_timeout: 0, revocation_retired_retries: 0 };
  return {
    kind: 'recheck', size: 2, repeat: 1, times: { pass: 12_300, burst: 11_300, fault: 12_000, mutationsDone: 13_000, recovery: 16_500, end: 40_000 },
    removals: [12_100, 12_200], mutationFailures: 0, statements, connections: [], refused: [],
    dbProbe: probes(1), httpProbe: probes(5), pool: [{ at: 0, fields: { wait_count: 0 } }, { at: 39_000, fields: { wait_count: 0 } }],
    rss: Array.from({ length: 80 }, (_, i) => ({ at: i * 500, kb: 1000 })), metrics: counters,
    members: [{ removeStartedAt: 11_400, removedAt: 12_100, restoredAt: 12_500, revoked: [], resets: [] }, { removeStartedAt: 11_500, removedAt: 12_200, revoked: [17_000], resets: [] }],
    serverCloses: 0,
  };
};

test('judge passes a reconciled run', () => {
  const verdict = judge(fixture());
  assert.deepEqual(verdict.reasons, []);
});

test('judge fails each correctness violation', () => {
  const during = fixture(); during.members[1].revoked = [14_000];
  assert.ok(judge(during).reasons.includes('a revocation was delivered while the failure was active'));
  const early = fixture(); early.members[1].revoked = [11_450];
  assert.ok(judge(early).reasons.includes('a revocation reached a Member without a successful removal or before it'));
  const restored = fixture(); restored.members[0].revoked = [17_100];
  assert.ok(judge(restored).reasons.includes('a restored registration received a revocation'));
  const duplicate = fixture(); duplicate.members[1].revoked = [17_000, 17_100];
  assert.ok(judge(duplicate).reasons.includes('duplicate revocation'));
  const unseen = fixture(); unseen.members[1].revoked = [];
  assert.ok(judge(unseen).reasons.some(r => r.startsWith('delivered_after_hold 1 > client revocations after recovery 0')));
  const overcounted = fixture(); overcounted.metrics!.revocation_retired_fenced = 2;
  assert.ok(judge(overcounted).reasons.some(r => r.startsWith('held 2 < delivered 1 + ended 2')));
  const missing = fixture(); missing.metrics = undefined;
  assert.ok(judge(missing).reasons.includes('no metrics event after the holds resolved'));
  const lost = fixture(); lost.members[1].revoked = []; lost.metrics!.revocation_delivered_after_hold = 0;
  assert.deepEqual(judge(lost).reasons, [], 'a lost notice is recovered by REST reconciliation, not a failure');
  assert.equal(judge(lost).summary.notices.lostWithoutNotice, 1);
});

test('judge fails each recovery violation', () => {
  const late = fixture(); late.members[1].revoked = [27_000];
  assert.ok(judge(late).reasons.includes('a revocation arrived after the drain limit'));
  const slowDb = fixture(); slowDb.dbProbe = slowDb.dbProbe.map(p => p.at >= 16_500 ? { ...p, ms: 40 } : p);
  assert.ok(judge(slowDb).reasons.some(r => r.startsWith('database probe p99')));
  const http = fixture(); http.httpProbe = http.httpProbe.map(p => p.at >= 18_000 && p.at < 18_200 ? { ...p, ok: false, status: 503 } : p);
  assert.ok(judge(http).reasons.some(r => r.includes('HTTP probe failures')));
  const noRecovery = fixture(); noRecovery.httpProbe = noRecovery.httpProbe.map(p => p.at >= 16_500 && p.at < 22_000 ? { ...p, ok: false, status: 503 } : p);
  assert.ok(judge(noRecovery).reasons.includes('no successful HTTP probe within the first-success limit'));
  const pool = fixture(); pool.pool = [{ at: 16_000, fields: { acquire_timeout: 0 } }, { at: 27_000, fields: { acquire_timeout: 3 } }];
  assert.ok(judge(pool).reasons.includes('3 pool acquire timeouts after recovery'));
});

test('verdictBySize needs every repeat of both kinds', () => {
  const pass = (kind: 'recheck' | 'outage', size: number) => ({ kind, size, pass: true });
  const all = [256, 1024, 4096].flatMap(size => [1, 2, 3].flatMap(() => [pass('recheck', size), pass('outage', size)]));
  assert.deepEqual(verdictBySize(all), { 256: 'PASS', 1024: 'PASS', 4096: 'PASS' });
  assert.deepEqual(verdictBySize(all.slice(1)), { 256: 'NOT EVALUATED', 1024: 'PASS', 4096: 'PASS' });
  assert.equal(verdictBySize([...all, { kind: 'outage', size: 4096, pass: false }])[4096], 'FAIL');
});
