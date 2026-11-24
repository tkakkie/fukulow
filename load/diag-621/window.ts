// One #621 diagnostic window with injected I/O, so the order of its steps is testable without Docker.
// Every window, base included, takes an explicit CHECKPOINT after warm-up and right before the measured
// window. In the 2026-11-23 run only the overlay arms dropped their seed database after the clone, which
// likely forced a checkpoint for them alone. A failed or unproven checkpoint, or a checkpoint that
// completes inside the measured window, makes the window INVALID. So does any other checkpoint that starts or
// completes in WAL from the insert position before CHECKPOINT to the end of the window, or unreadable WAL evidence.
import type { Window } from './plan.ts';

export type Sql = (query: string, operation: string) => string;

// pg_control_checkpoint() is written before CHECKPOINT returns; pg_stat_checkpointer counters may be
// reported later, so they are not used to prove completion.
export const controlSQL = `SELECT json_build_object('lsn',pg_current_wal_insert_lsn()::text,
  'redo',c.redo_lsn::text,'checkpoint',c.checkpoint_lsn::text,'time',c.checkpoint_time) FROM pg_control_checkpoint() c;`;
export type Control = { lsn: string; redo: string; checkpoint: string; time: string };
const coversSQL = (redo: string, before: string) => `SELECT pg_wal_lsn_diff('${redo}','${before}') >= 0;`;
const lsn = /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/;
const isLsn = (value: unknown): value is string => typeof value === 'string' && lsn.test(value);
const isControl = (control: Control | null | undefined): control is Control =>
  isLsn(control?.lsn) && isLsn(control.redo) && isLsn(control.checkpoint)
  && typeof control.time === 'string' && control.time.length > 0;

export type CheckpointRecord = { ok: true; startedAt: string; ms: number; before: Control; after: Control }
  | { ok: false; startedAt: string; ms: number; reason: string };

export function checkpoint(sql: Sql, now = () => performance.now(), clock = () => new Date().toISOString()): CheckpointRecord {
  const startedAt = clock(), t0 = now();
  try {
    const before = JSON.parse(sql(controlSQL, 'read control before checkpoint')) as Control;
    sql('CHECKPOINT;', 'checkpoint before measured window');
    const after = JSON.parse(sql(controlSQL, 'read control after checkpoint')) as Control;
    const ms = now() - t0;
    if (!isControl(before) || !isControl(after)) return { ok: false, startedAt, ms, reason: 'unreadable checkpoint control data' };
    // The checkpoint's redo point must not precede the insert position read before it was requested.
    if (sql(coversSQL(after.redo, before.lsn), 'prove checkpoint completed') !== 't') return { ok: false, startedAt, ms, reason: 'checkpoint not proven complete' };
    return { ok: true, startedAt, ms, before, after };
  } catch (error) {
    return { ok: false, startedAt, ms: now() - t0, reason: error instanceof Error ? error.message : 'checkpoint failed' };
  }
}

// PostgreSQL 18 CreateCheckPoint (xlog.c): an online checkpoint starts by inserting XLOG CHECKPOINT_REDO,
// whose start LSN becomes its redo pointer (pg_control redo_lsn), and completes with CHECKPOINT_ONLINE at
// pg_control checkpoint_lsn; a shutdown checkpoint writes only CHECKPOINT_SHUTDOWN. pg_walinspect reads
// records only up to the flush LSN and only those ending at or before end_lsn, so the window's end must be
// flushed first. Needs the pg_walinspect extension in the database the query runs in.
export const flushedSQL = (to: string) => `SELECT pg_current_wal_flush_lsn() >= '${to}'::pg_lsn;`;
export const checkpointRecordsSQL = (from: string, to: string) => `SELECT coalesce(json_agg(json_build_object(
  'lsn',start_lsn::text,'type',record_type) ORDER BY start_lsn),'[]') FROM pg_get_wal_records_info('${from}','${to}')
  WHERE resource_manager='XLOG' AND record_type LIKE 'CHECKPOINT%';`;
export type WalRecord = { lsn: string; type: string };
export type WalCheckpoints = { ok: true; from: string; to: string; records: WalRecord[] } | { ok: false; reason: string };

// Every checkpoint record from the insert position before CHECKPOINT to the insert position after the window.
export function walCheckpoints(sql: Sql, from: string, to: string): WalCheckpoints {
  try {
    if (![from, to].every(isLsn)) return { ok: false, reason: 'unreadable WAL range' };
    if (sql(flushedSQL(to), 'check window WAL is flushed') !== 't') return { ok: false, reason: 'window WAL not flushed' };
    const records = JSON.parse(sql(checkpointRecordsSQL(from, to), 'read checkpoint records from WAL')) as WalRecord[];
    if (!Array.isArray(records)) return { ok: false, reason: 'unreadable checkpoint records' };
    return { ok: true, from, to, records };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'WAL read failed' };
  }
}

// Only the explicit checkpoint's own two records, matched by LSN, may appear.
function walReasons(cp: CheckpointRecord & { ok: true }, measured: Measured, wal: WalCheckpoints | null): string[] {
  if (!wal) return ['checkpoint WAL evidence missing'];
  if (wal.ok === false && typeof wal.reason === 'string') return [`checkpoint WAL evidence: ${wal.reason}`];
  if (wal.ok !== true || !Array.isArray(wal.records) || !wal.records.every(r => isLsn(r?.lsn) && typeof r.type === 'string')) {
    return ['checkpoint WAL evidence malformed'];
  }
  if (wal.from !== cp.before.lsn || wal.to !== measured.controlAfter.lsn) return ['checkpoint WAL evidence covers the wrong range'];
  const redo = (r: WalRecord) => r.lsn === cp.after.redo && r.type === 'CHECKPOINT_REDO';
  const completion = (r: WalRecord) => r.lsn === cp.after.checkpoint && r.type === 'CHECKPOINT_ONLINE';
  const out: string[] = [];
  if (wal.records.filter(redo).length !== 1 || wal.records.filter(completion).length !== 1) out.push('explicit checkpoint records not found exactly once in WAL');
  if (wal.records.some(r => !redo(r) && !completion(r))) out.push('another checkpoint started or completed between the explicit checkpoint and the end of the window');
  return out;
}

export type Measured = { accepted: number; controlBefore: Control; controlAfter: Control };
export type WindowOps<M extends Measured, V> = {
  prepare(w: Window): Promise<void>;
  warm(w: Window): Promise<unknown>;
  checkpoint(w: Window): CheckpointRecord;
  measure(w: Window): Promise<M>;
  verify(w: Window, measured: M): V & { verified: boolean };
  walCheckpoints(w: Window, from: string, to: string): WalCheckpoints;
  cleanup(w: Window): void;
  record(w: Window, result: WindowResult<M, V>): void;
};
export type WindowResult<M, V> = { id: string; valid: boolean; reasons: string[]; checkpoint: CheckpointRecord | null;
  measured: M | null; verification: (V & { verified: boolean }) | null; walCheckpoints: WalCheckpoints | null };

export function reasons(cp: CheckpointRecord, measured: Measured | null, verified: boolean | null, wal: WalCheckpoints | null): string[] {
  const out: string[] = [];
  const checkpointCaptured = cp.ok === true && isControl(cp.before) && isControl(cp.after);
  if (cp.ok === false && typeof cp.reason === 'string') out.push(`checkpoint: ${cp.reason}`);
  else if (!checkpointCaptured) out.push('checkpoint evidence malformed');
  if (measured) {
    if (!isControl(measured.controlBefore) || !isControl(measured.controlAfter)) out.push('measured checkpoint control data malformed');
    else {
      if (measured.controlBefore.checkpoint !== measured.controlAfter.checkpoint) out.push('checkpoint completed inside the measured window');
      if (checkpointCaptured) {
        if (measured.controlBefore.checkpoint !== cp.after.checkpoint) out.push('checkpoint between the explicit checkpoint and the window');
        out.push(...walReasons(cp, measured, wal));
      }
    }
    if (verified !== true) out.push('integrity verification failed');
  }
  return out;
}

export async function runWindow<M extends Measured, V>(w: Window, ops: WindowOps<M, V>): Promise<WindowResult<M, V>> {
  await ops.prepare(w);
  let result: WindowResult<M, V>;
  try {
    await ops.warm(w);
    const cp = ops.checkpoint(w);
    if (!cp.ok) {
      result = { id: w.id, valid: false, reasons: reasons(cp, null, null, null), checkpoint: cp, measured: null, verification: null,
        walCheckpoints: null };
    } else {
      const measured = await ops.measure(w);
      const verification = ops.verify(w, measured);
      const wal = ops.walCheckpoints(w, cp.before?.lsn, measured.controlAfter?.lsn);
      const why = reasons(cp, measured, verification?.verified ?? null, wal);
      result = { id: w.id, valid: why.length === 0, reasons: why, checkpoint: cp, measured, verification, walCheckpoints: wal };
    }
  } finally {
    ops.cleanup(w);
  }
  ops.record(w, result);
  return result;
}
