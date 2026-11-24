import assert from 'node:assert/strict';
import test from 'node:test';
import { windows, type Window } from './plan.ts';
import { checkpoint, controlSQL, runWindow, type CheckpointRecord, type Control, type Measured, type Sql, type WindowOps } from './window.ts';

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
function fakeOps(o: { checkpoint?: (w: Window) => CheckpointRecord; measured?: (cp: string) => M; verified?: boolean } = {}) {
  const log: string[] = [], records: unknown[] = [];
  const ok = (): CheckpointRecord => ({ ok: true, startedAt: 's', ms: 1, before: control('0/1'), after: control('0/2') });
  const ops: WindowOps<M, { note: string }> = {
    async prepare(w) { log.push(`prepare ${w.id}`); },
    async warm(w) { log.push(`warm ${w.id}`); },
    checkpoint(w) { log.push(`checkpoint ${w.id}`); return (o.checkpoint ?? ok)(w); },
    async measure(w) { log.push(`measure ${w.id}`); return o.measured?.('0/2') ?? { accepted: 2001, controlBefore: control('0/2'), controlAfter: control('0/2'), tag: 'm' }; },
    verify(w) { log.push(`verify ${w.id}`); return { note: 'v', verified: o.verified ?? true }; },
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
    assert.deepEqual(log.slice(i - 3, i + 4), [`prepare ${w.id}`, `warm ${w.id}`, `checkpoint ${w.id}`, `measure ${w.id}`,
      `verify ${w.id}`, `cleanup ${w.id}`, `record ${w.id}`]);
  }
  assert.equal(log.filter(l => l.startsWith('checkpoint ')).length, plan.length);
});

test('a failed checkpoint makes the window INVALID: not measured or verified, cleaned up and recorded; later windows still run', async () => {
  const [first, second] = windows(false);
  const { ops, log, records } = fakeOps({ checkpoint: w => w === first ? { ok: false, startedAt: 's', ms: 3, reason: 'boom' }
    : { ok: true, startedAt: 's', ms: 1, before: control('0/1'), after: control('0/2') } });
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
  const inside = fakeOps({ measured: () => ({ accepted: 1, controlBefore: control('0/2'), controlAfter: control('0/3'), tag: 'm' }) });
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
