import assert from 'node:assert/strict';
import test from 'node:test';
import { diffSnapshots, mapMetrics, parseWalInspection, statementKeys, walWindowBytes, type Snapshot } from './attribution.ts';
import { inspectWal, parseBoundary, walDiskPreflight } from './attribution-sql.ts';

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  statements: [], functions: [], deallocations: 0, statsReset: null, ...over,
});
const stmt = (queryId: string, calls: number, execMs: number, over: { topLevel?: boolean; statsSince?: string } = {}) => ({
  identity: { queryId, query: 'SELECT proto_send($1, $2, $3, $4)', topLevel: true, statsSince: 'same', ...over },
  counters: { ...mapMetrics(statementKeys, () => 0), calls, execMs, rows: calls, sharedBlksHit: calls * 2, walBytes: calls * 10 },
});
const fn = (calls: number, totalMs: number, selfMs: number) => ({ identity: { oid: '123', name: 'public.proto_send(integer)' },
  counters: { calls, totalMs, selfMs } });

test('snapshot deltas isolate the measured calls and normalize by committed sends', () => {
  const id = '9223372036854775807';
  const before = snapshot({ statements: [stmt(id, 100, 610), stmt(id, 50, 150, { topLevel: false })], functions: [fn(100, 800, 500)] });
  const after = snapshot({ statements: [stmt(id, 110, 650), stmt(id, 55, 155, { topLevel: false })], functions: [fn(110, 850, 530)] });
  const delta = diffSnapshots(before, after, 10);
  assert.deepEqual(delta.issues, []);
  const [top, nested] = delta.statements;
  assert.equal(top.queryId, id);
  assert.equal(top.meanExecMs, 4);
  assert.equal(top.perSend.execMs, 4);
  assert.equal(top.perSend.sharedBlksHit, 2);
  assert.equal(top.perSend.walBytes, 10);
  assert.equal(nested.topLevel, false);
  assert.equal(nested.meanExecMs, 1);
  assert.equal(nested.perSend.execMs, 0.5);
  assert.deepEqual(delta.functions[0].perSend, { calls: 1, totalMs: 5, selfMs: 3 });
});

test('new entries start at zero, vanished entries stay unknown, and reused IDs report their new generation', () => {
  const before = snapshot({ statements: [stmt('-2', 20, 150), stmt('7', 500, 600), stmt('8', 4, 40)] });
  const after = snapshot({ deallocations: 2, statements: [
    stmt('2', 4, 10), stmt('7', 5, 20, { statsSince: 'new' }), stmt('8', 4, 40),
  ] });
  const got = diffSnapshots(before, after, 5);
  assert.deepEqual(got.statements.map(s => [s.queryId, s.total.calls, s.perSend.calls]), [['2', 4, 0.8], ['7', 5, 1]]);
  assert.match(got.issues.join('\n'), /reset or eviction/);
  assert.match(got.issues.join('\n'), /recreated for query 7/);
  assert.match(got.issues.join('\n'), /disappeared for query -2/);
  assert.deepEqual(diffSnapshots(snapshot(), snapshot({ statements: [stmt('2', 1, 2)] }), 1).issues, []);
});

test('regressed counters are flagged instead of reporting negative work', () => {
  const got = diffSnapshots(snapshot({ functions: [fn(10, 10, 10)] }), snapshot({ functions: [fn(9, 10, 10)] }), 10);
  assert.deepEqual(got.functions, []);
  assert.match(got.issues[0], /Counters regressed/);
  assert.throws(() => diffSnapshots(snapshot(), snapshot({ functions: [fn(1, 1, 1)] }), 0), /Invalid committed send count/);
});

test('snapshot output preserves large IDs and escaped query text', () => {
  const source = snapshot({ statements: [stmt('9223372036854775807', 1, 6)] });
  source.statements[0].identity.query = 'SELECT 1\n-- query on two lines';
  assert.deepEqual(parseBoundary('{"lsn":"1/12"}\n' + JSON.stringify(source) + '\n'),
    { lsn: '1/12', snapshot: source });
});

test('WAL byte totals use the inspected LSNs even when their absolute positions exceed JS integer precision', () => {
  assert.equal(walWindowBytes('FFFFFFFE/FFFFFFFC', 'FFFFFFFF/1'), 5);
});

const wal = { label: 'Heap/INSERT+INIT', records: 100, recordBytes: 5000, fpiCount: 2, fpiBytes: 1000, countedFpiBytes: 1000 };

test('walinspect combines record bytes and FPI bytes without double counting and keeps both components', () => {
  assert.deepEqual(parseWalInspection(JSON.stringify([
    wal, { label: 'Transaction/COMMIT', records: 50, recordBytes: 1000, fpiCount: 0, fpiBytes: 0, countedFpiBytes: null },
  ]), 50), { complete: true, records: [
    { resourceManager: 'Heap', recordType: 'INSERT+INIT',
      total: { records: 100, recordBytes: 5000, fpiCount: 2, fpiBytes: 1000, walBytes: 6000 },
      perSend: { records: 2, recordBytes: 100, fpiCount: 0.04, fpiBytes: 20, walBytes: 120 } },
    { resourceManager: 'Transaction', recordType: 'COMMIT',
      total: { records: 50, recordBytes: 1000, fpiCount: 0, fpiBytes: 0, walBytes: 1000 },
      perSend: { records: 1, recordBytes: 20, fpiCount: 0, fpiBytes: 0, walBytes: 20 } },
  ] });
});

test('a recycled WAL segment or inconsistent scan records an incomplete inspection', () => {
  const missing = 'Measured WAL segment 00000001000000010000000A is missing';
  const got = inspectWal(sql => {
    assert.match(sql, /pg_ls_waldir\(\)/);
    assert.match(sql, /pg_get_wal_stats\('1\/AFF0000'::pg_lsn, '1\/B010000'::pg_lsn, per_record => true\)/);
    assert.match(sql, /pg_get_wal_block_info\(.*show_data => false\)/);
    throw new Error(missing);
  }, '1/AFF0000', '1/B010000', 50);
  assert.deepEqual(got, { complete: false, reason: missing });
  assert.deepEqual(inspectWal(() => JSON.stringify([{ ...wal, countedFpiBytes: 999 }]), '1/A', '1/B', 50),
    { complete: false, reason: 'Invalid WAL counts or inconsistent FPI bytes for Heap/INSERT+INIT' });
});

test('disk preflight reads available space on the WAL filesystem and fails closed', () => {
  const df = (available: string) => `Filesystem 1024-blocks Used Available Capacity Mounted on\nvolume 100000000 100 ${available} 1% /var/lib/postgresql\n`;
  assert.deepEqual(walDiskPreflight(df(String(40 * 1024 ** 2)), 40), { freeBytes: 40 * 1024 ** 3, minFreeGiB: 40 });
  assert.throws(() => walDiskPreflight(df('10000'), 40), /needs 40 GiB free/);
  assert.throws(() => walDiskPreflight(df('?'), 40), /unreadable/);
});
