// The one validity decision of a #621 diagnostic window, used for result.json and the manifest by run.ts and
// again by summary.ts, so a window has one recorded status. A window the runner already marked INVALID keeps
// its reasons; a window it marked valid must also carry checkpoint, warm-up, measurement, integrity and
// statement evidence, reconciled k6 counts and captured statistics (the 2026-11-23 summary checks).
import { reasons as windowReasons, type CheckpointRecord, type Control, type WalCheckpoints } from './window.ts';

export type Statement = { toplevel: boolean; queryid: string | number; calls: number; total_exec_time: number;
  wal_records: number; wal_bytes: number | string; wal_fpi: number; query: string };
export type Load = { accepted: number; attempts: number; iterations: number; errors: number; dropped: number };
export type Result = { id: string; valid: boolean; reasons: string[]; checkpoint: CheckpointRecord | null; warmup: Load | null;
  walCheckpoints?: WalCheckpoints | null;
  measured: null | { accepted: number; load: Load; controlBefore: Control; controlAfter: Control; cpuUsec: number; walBytes: number;
    statWal: { records: number; fpi: number; bytes: number }; statementInfo: { dealloc: number } };
  verification: null | { verified: boolean; shapeAfter: { heap_bytes: number; index_bytes: number } } };
type Evidence = Pick<Result, 'valid' | 'reasons' | 'checkpoint' | 'warmup' | 'walCheckpoints'> & {
  measured: Pick<NonNullable<Result['measured']>, 'accepted' | 'load' | 'controlBefore' | 'controlAfter' | 'cpuUsec' | 'walBytes'> | null;
  verification: { verified: boolean } | null };

// Top-level statements of the app, without the readiness probe.
export const topLevel = (statements: readonly Statement[]) => statements.filter(s => s.toplevel && s.query.trim() !== 'SELECT 1');

export function decide(r: Evidence, statements: readonly Statement[]): { valid: boolean; reasons: string[] } {
  if (!r.valid || r.reasons.length) return { valid: false, reasons: r.reasons.length ? [...r.reasons] : ['not valid'] };
  const out: string[] = [];
  const m = r.measured;
  if (!r.checkpoint) out.push('checkpoint evidence missing');
  if (!r.warmup) out.push('warm-up evidence missing');
  if (!m) out.push('measurement missing');
  if (!r.verification) out.push('integrity evidence missing');
  if (r.checkpoint) out.push(...windowReasons(r.checkpoint, m, r.verification?.verified ?? null, r.walCheckpoints ?? null));
  if (m && r.warmup && ![r.warmup, m.load].every(l => l.iterations === l.attempts)) out.push('k6 counts do not reconcile');
  if (!topLevel(statements).length) out.push('statement evidence missing');
  if (m && !(m.accepted && m.cpuUsec > 0 && m.walBytes > 0)) out.push('statistics not captured');
  return { valid: out.length === 0, reasons: [...new Set(out)] };
}
