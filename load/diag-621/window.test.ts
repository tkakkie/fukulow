import assert from 'node:assert/strict';
import test from 'node:test';
import { windows, type Window } from './plan.ts';
import { checkpoint, checkpointRecordsSQL, controlSQL, flushedSQL, runWindow, walCheckpoints, type CheckpointRecord, type Control, type Measured,
  type Sql, type WalCheckpoints, type WalRecord, type WindowOps } from './window.ts';

const control = (checkpointLsn: string, lsn = '0/5000000'): Control => ({ lsn, redo: checkpointLsn, checkpoint: checkpointLsn, time: 't' });

// Fake psql: control before -> CHECKPOINT -> control after -> coverage proof.
function fakeSql(o: { fail?: 'CHECKPOINT' | 'control'; covers?: 't' | 'f'; redo?: string } = {}) {
  const calls: string[] = [];
  let reads = 0;
  const sql: Sql = query => {
    calls.push(query === controlSQL ? 'control' : query.startsWith('SELECT pg_wal_lsn_diff') ? 'covers' : query);
    if (query === controlSQL) {
      if (o.fail === 'control') throw new Error('read control failed');
      return JSON.stringify(reads++ === 0 ? control('0/1000000', '0/2000000') : control(o.redo ?? '0/2000028', '0/2000100'));
    }
    if (query === 'CHECKPOINT;' && o.fail === 'CHECKPOINT') throw new Error('checkpoint before measured window failed (Docker 1)');
    if (query.startsWith('SELECT pg_wal_lsn_diff')) return o.covers ?? 't';
    return '';
  };
  return { sql, calls };
}

test('checkpoint: reads control, runs CHECKPOINT, proves the redo point covers the earlier insert position', () => {
  const { sql, calls } = fakeSql();
  const r = checkpoint(sql);
  assert.deepEqual(calls, ['control', 'CHECKPOINT;', 'control', 'covers']);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.after.redo, '0/2000028');
  assert.equal(typeof r.ms, 'number');
});

test('checkpoint fails closed: SQL error, failed read, unproven completion, unreadable LSN', () => {
  for (const [o, reason] of [[{ fail: 'CHECKPOINT' }, /checkpoint before measured window failed/], [{ fail: 'control' }, /read control failed/],
    [{ covers: 'f' }, /not proven complete/], [{ redo: 'garbage' }, /unreadable/]] as const) {
    const r = checkpoint(fakeSql(o).sql);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, reason);
  }
});

type M = Measured & { tag: string };
// The explicit checkpoint of fakeOps: redo record at 0/2 and completion record at 0/3; the window ends at 0/5000000.
const explicit: WalRecord[] = [{ lsn: '0/2', type: 'CHECKPOINT_REDO' }, { lsn: '0/3', type: 'CHECKPOINT_ONLINE' }];
const after = (): Control => ({ lsn: '0/1', redo: '0/2', checkpoint: '0/3', time: 't' });
function fakeOps(o: { checkpoint?: (w: Window) => CheckpointRecord; measured?: (cp: string) => M; verified?: boolean;
  wal?: (from: string, to: string) => WalCheckpoints } = {}) {
  const log: string[] = [], records: unknown[] = [];
  const ok = (): CheckpointRecord => ({ ok: true, startedAt: 's', ms: 1, before: control('0/1'), after: after() });
  const ops: WindowOps<M, { note: string }> = {
    async prepare(w) { log.push(`prepare ${w.id}`); },
    async warm(w) { log.push(`warm ${w.id}`); },
    checkpoint(w) { log.push(`checkpoint ${w.id}`); return (o.checkpoint ?? ok)(w); },
    async measure(w) { log.push(`measure ${w.id}`); return o.measured?.('0/3') ?? { accepted: 2001, controlBefore: control('0/3'), controlAfter: control('0/3'), tag: 'm' }; },
    verify(w) { log.push(`verify ${w.id}`); return { note: 'v', verified: o.verified ?? true }; },
    walCheckpoints(w, from, to) { log.push(`wal ${w.id}`); return o.wal?.(from, to) ?? { ok: true, from, to, records: explicit }; },
    cleanup(w) { log.push(`cleanup ${w.id}`); },
    record(w, r) { log.push(`record ${w.id}`); records.push(r); },
  };
  return { ops, log, records };
}

test('every window of the plan, base included, takes the checkpoint after warm-up and right before its measured window', async () => {
  const plan = windows(false);
  const { ops, log } = fakeOps();
  for (const w of plan) assert.equal((await runWindow(w, ops)).valid, true);
  for (const w of plan) {
    const i = log.indexOf(`measure ${w.id}`);
    assert.deepEqual(log.slice(i - 3, i + 5), [`prepare ${w.id}`, `warm ${w.id}`, `checkpoint ${w.id}`, `measure ${w.id}`,
      `verify ${w.id}`, `wal ${w.id}`, `cleanup ${w.id}`, `record ${w.id}`]);
  }
  assert.equal(log.filter(l => l.startsWith('checkpoint ')).length, plan.length);
});

test('a failed checkpoint makes the window INVALID: not measured or verified, cleaned up and recorded; later windows still run', async () => {
  const [first, second] = windows(false);
  const { ops, log, records } = fakeOps({ checkpoint: w => w === first ? { ok: false, startedAt: 's', ms: 3, reason: 'boom' }
    : { ok: true, startedAt: 's', ms: 1, before: control('0/1'), after: after() } });
  const r = await runWindow(first, ops);
  assert.equal(r.valid, false);
  assert.deepEqual(r.reasons, ['checkpoint: boom']);
  assert.equal(r.measured, null);
  assert.deepEqual(log, [`prepare ${first.id}`, `warm ${first.id}`, `checkpoint ${first.id}`, `cleanup ${first.id}`, `record ${first.id}`]);
  assert.deepEqual(records, [r]);
  assert.equal((await runWindow(second, ops)).valid, true);
});

test('a checkpoint completing inside the window, or between the explicit one and the window, makes it INVALID', async () => {
  const [w] = windows(false);
  const inside = fakeOps({ measured: () => ({ accepted: 1, controlBefore: control('0/3'), controlAfter: control('0/4'), tag: 'm' }),
    wal: (from, to) => ({ ok: true, from, to, records: explicit }) });
  assert.deepEqual((await runWindow(w, inside.ops)).reasons, ['checkpoint completed inside the measured window']);
  const between = fakeOps({ measured: () => ({ accepted: 1, controlBefore: control('0/9'), controlAfter: control('0/9'), tag: 'm' }) });
  assert.deepEqual((await runWindow(w, between.ops)).reasons, ['checkpoint between the explicit checkpoint and the window']);
});

test('failed integrity verification stays INVALID', async () => {
  const [w] = windows(false);
  const r = await runWindow(w, fakeOps({ verified: false }).ops);
  assert.equal(r.valid, false);
  assert.deepEqual(r.reasons, ['integrity verification failed']);
});

test('a thrown step still cleans up and is not recorded as valid', async () => {
  const [w] = windows(false);
  const { ops, log } = fakeOps();
  ops.warm = async () => { throw new Error('k6 warm failed'); };
  await assert.rejects(runWindow(w, ops), /k6 warm failed/);
  assert.deepEqual(log, [`prepare ${w.id}`, `cleanup ${w.id}`]);
});

test('checkpoint WAL evidence: proves the window end is flushed, then reads the checkpoint records of the range', () => {
  const calls: string[] = [];
  const records = JSON.stringify(explicit);
  const sql: Sql = q => { calls.push(q); return q === flushedSQL('0/5000000') ? 't' : records; };
  assert.deepEqual(walCheckpoints(sql, '0/2', '0/5000000'), { ok: true, from: '0/2', to: '0/5000000', records: explicit });
  assert.deepEqual(calls, [flushedSQL('0/5000000'), checkpointRecordsSQL('0/2', '0/5000000')]);
  assert.match(checkpointRecordsSQL('0/2', '0/5'), /pg_get_wal_records_info\('0\/2','0\/5'\)/);
  assert.match(checkpointRecordsSQL('0/2', '0/5'), /resource_manager='XLOG' AND record_type LIKE 'CHECKPOINT%'/);
});

test('checkpoint WAL evidence fails closed: unflushed window, read error, unreadable range or output', () => {
  const cases: [Sql, string, RegExp][] = [
    [q => q.startsWith('SELECT pg_current_wal_flush_lsn') ? 'f' : '[]', '0/5', /not flushed/],
    [q => { if (q.includes('pg_get_wal_records_info')) throw new Error('requested WAL segment has already been removed'); return 't'; }, '0/5', /already been removed/],
    [() => 't', 'garbage', /unreadable WAL range/],
    [q => q.startsWith('SELECT pg_current_wal_flush_lsn') ? 't' : '{}', '0/5', /unreadable checkpoint records/],
  ];
  for (const [sql, to, reason] of cases) {
    const r = walCheckpoints(sql, '0/2', to);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, reason);
  }
});

test('another checkpoint starting or completing in WAL between the explicit checkpoint and the window end makes it INVALID', async () => {
  const [w] = windows(false);
  const other = 'another checkpoint started or completed between the explicit checkpoint and the end of the window';
  const run = async (wal: (from: string, to: string) => WalCheckpoints) => (await runWindow(w, fakeOps({ wal }).ops)).reasons;
  // Started during the window, completion not yet visible in pg_control.
  assert.deepEqual(await run((from, to) => ({ ok: true, from, to, records: [...explicit, { lsn: '0/4000000', type: 'CHECKPOINT_REDO' }] })), [other]);
  assert.deepEqual(await run((from, to) => ({ ok: true, from, to, records: [...explicit, { lsn: '0/4000000', type: 'CHECKPOINT_ONLINE' }] })), [other]);
  assert.deepEqual(await run((from, to) => ({ ok: true, from, to, records: [...explicit, { lsn: '0/4000000', type: 'CHECKPOINT_SHUTDOWN' }] })), [other]);
  // The explicit checkpoint's records match by LSN and type, not by type alone.
  assert.deepEqual(await run((from, to) => ({ ok: true, from, to, records: [explicit[0], { lsn: '0/9', type: 'CHECKPOINT_ONLINE' }] })),
    ['explicit checkpoint records not found in WAL', other]);
  assert.deepEqual(await run((from, to) => ({ ok: true, from, to, records: [] })), ['explicit checkpoint records not found in WAL']);
  assert.deepEqual(await run(() => ({ ok: false, reason: 'window WAL not flushed' })), ['checkpoint WAL evidence: window WAL not flushed']);
  assert.deepEqual(await run((_from, to) => ({ ok: true, from: '0/1', to, records: explicit })), ['checkpoint WAL evidence covers the wrong range']);
  // The range runs from the explicit checkpoint's redo record to the insert position after the window.
  const seen: string[] = [];
  assert.deepEqual(await run((from, to) => { seen.push(from, to); return { ok: true, from, to, records: explicit }; }), []);
  assert.deepEqual(seen, ['0/2', '0/5000000']);
});
