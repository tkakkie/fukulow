// One #621 diagnostic window with injected I/O, so the order of its steps is testable without Docker.
// Every window, base included, takes an explicit CHECKPOINT after warm-up and right before the measured
// window. In the 2026-11-23 run only the overlay arms dropped their seed database after the clone, which
// likely forced a checkpoint for them alone. A failed or unproven checkpoint, or a checkpoint that
// completes inside the measured window, makes the window INVALID (fail-closed); it is never measured or paired.
import type { Window } from './plan.ts';

export type Sql = (query: string, operation: string) => string;

// pg_control_checkpoint() is written before CHECKPOINT returns; pg_stat_checkpointer counters may be
// reported later, so they are not used to prove completion.
export const controlSQL = `SELECT json_build_object('lsn',pg_current_wal_insert_lsn()::text,
  'redo',c.redo_lsn::text,'checkpoint',c.checkpoint_lsn::text,'time',c.checkpoint_time) FROM pg_control_checkpoint() c;`;
export type Control = { lsn: string; redo: string; checkpoint: string; time: string };
const coversSQL = (redo: string, before: string) => `SELECT pg_wal_lsn_diff('${redo}','${before}') >= 0;`;
const lsn = /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/;

export type CheckpointRecord = { ok: true; startedAt: string; ms: number; before: Control; after: Control }
  | { ok: false; startedAt: string; ms: number; reason: string };

export function checkpoint(sql: Sql, now = () => performance.now(), clock = () => new Date().toISOString()): CheckpointRecord {
  const startedAt = clock(), t0 = now();
  try {
    const before = JSON.parse(sql(controlSQL, 'read control before checkpoint')) as Control;
    sql('CHECKPOINT;', 'checkpoint before measured window');
    const after = JSON.parse(sql(controlSQL, 'read control after checkpoint')) as Control;
    const ms = now() - t0;
    if (![before.lsn, after.redo, after.checkpoint].every(v => lsn.test(v))) return { ok: false, startedAt, ms, reason: 'unreadable checkpoint LSN' };
    // The checkpoint's redo point must not precede the insert position read before it was requested.
    if (sql(coversSQL(after.redo, before.lsn), 'prove checkpoint completed') !== 't') return { ok: false, startedAt, ms, reason: 'checkpoint not proven complete' };
    return { ok: true, startedAt, ms, before, after };
  } catch (error) {
    return { ok: false, startedAt, ms: now() - t0, reason: error instanceof Error ? error.message : 'checkpoint failed' };
  }
}

export type Measured = { accepted: number; controlBefore: Control; controlAfter: Control };
export type WindowOps<M extends Measured, V> = {
  prepare(w: Window): Promise<void>;
  warm(w: Window): Promise<unknown>;
  checkpoint(w: Window): CheckpointRecord;
  measure(w: Window): Promise<M>;
  verify(w: Window, measured: M): V & { verified: boolean };
  cleanup(w: Window): void;
  record(w: Window, result: WindowResult<M, V>): void;
};
export type WindowResult<M, V> = { id: string; valid: boolean; reasons: string[]; checkpoint: CheckpointRecord | null;
  measured: M | null; verification: (V & { verified: boolean }) | null };

export function reasons(cp: CheckpointRecord, measured: Measured | null, verified: boolean | null): string[] {
  const out: string[] = [];
  if (!cp.ok) out.push(`checkpoint: ${cp.reason}`);
  if (measured && measured.controlBefore.checkpoint !== measured.controlAfter.checkpoint) out.push('checkpoint completed inside the measured window');
  if (cp.ok && measured && measured.controlBefore.checkpoint !== cp.after.checkpoint) out.push('checkpoint between the explicit checkpoint and the window');
  if (verified === false) out.push('integrity verification failed');
  return out;
}

export async function runWindow<M extends Measured, V>(w: Window, ops: WindowOps<M, V>): Promise<WindowResult<M, V>> {
  await ops.prepare(w);
  let result: WindowResult<M, V>;
  try {
    await ops.warm(w);
    const cp = ops.checkpoint(w);
    if (!cp.ok) {
      result = { id: w.id, valid: false, reasons: reasons(cp, null, null), checkpoint: cp, measured: null, verification: null };
    } else {
      const measured = await ops.measure(w);
      const verification = ops.verify(w, measured);
      const why = reasons(cp, measured, verification.verified);
      result = { id: w.id, valid: why.length === 0, reasons: why, checkpoint: cp, measured, verification };
    }
  } finally {
    ops.cleanup(w);
  }
  ops.record(w, result);
  return result;
}
