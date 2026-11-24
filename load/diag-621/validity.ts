// The one validity decision of a #621 diagnostic window, used for result.json and the manifest by run.ts and
// again by summary.ts, so a window has one recorded status. A window the runner already marked INVALID keeps
// its reasons; a window it marked valid must also carry checkpoint, warm-up, measurement, integrity and
// statement evidence, reconciled k6 counts and captured statistics (the 2026-11-23 summary checks).
import { reasons as windowReasons, type CheckpointRecord, type Control, type WalCheckpoints } from './window.ts';

export type Statement = { toplevel: boolean; queryid: string | number; calls: number; total_exec_time: number;
  wal_records: number; wal_bytes: number | string; wal_fpi: number; query: string };
export type Load = { accepted: number; attempts: number; iterations: number; errors: number; dropped: number };
export type Decision = { id: string; valid: boolean; reasons: string[] };
export type Result = Decision & { checkpoint: CheckpointRecord | null; warmup: Load | null;
  walCheckpoints?: WalCheckpoints | null;
  measured: null | { accepted: number; load: Load; controlBefore: Control; controlAfter: Control; cpuUsec: number; walBytes: number;
    statWal: { records: number; fpi: number; bytes: number }; statementInfo: { dealloc: number } };
  verification: null | { verified: boolean; shapeAfter: { heap_bytes: number; index_bytes: number } } };

export const isDecision = (decision: Decision | null | undefined): decision is Decision =>
  typeof decision?.id === 'string' && typeof decision.valid === 'boolean'
  && Array.isArray(decision.reasons) && decision.reasons.every(reason => typeof reason === 'string');

const count = (value: number) => Number.isSafeInteger(value) && value >= 0;
export const hasLoadCounts = (load: Load | null | undefined): load is Load =>
  !!load && [load.accepted, load.attempts, load.iterations, load.errors, load.dropped].every(count);

export const hasMeasurementStats = (m: Result['measured']): m is NonNullable<Result['measured']> =>
  !!m && hasLoadCounts(m.load) && count(m.accepted)
  && [m.cpuUsec, m.walBytes, m.statWal?.records, m.statWal?.fpi, m.statWal?.bytes, m.statementInfo?.dealloc].every(Number.isFinite);

export const hasVerificationShape = (v: Result['verification']): v is NonNullable<Result['verification']> =>
  !!v?.shapeAfter && [v.shapeAfter.heap_bytes, v.shapeAfter.index_bytes].every(count);

export const hasStatementFields = (statements: readonly Statement[]) => Array.isArray(statements) && statements.every(s =>
  typeof s?.toplevel === 'boolean' && typeof s.query === 'string'
  && (typeof s.queryid === 'string' ? s.queryid.length > 0 : Number.isFinite(s.queryid))
  && [s.calls, s.total_exec_time, s.wal_records, s.wal_fpi].every(Number.isFinite)
  && (typeof s.wal_bytes === 'string' ? /^\d+$/.test(s.wal_bytes) && Number.isFinite(Number(s.wal_bytes)) : Number.isFinite(s.wal_bytes)));

// Top-level statements of the app, without the readiness probe.
export const topLevel = (statements: readonly Statement[]) => statements.filter(s => s.toplevel && s.query.trim() !== 'SELECT 1');

export function decide(r: Result, statements: readonly Statement[]): { valid: boolean; reasons: string[] } {
  if (!isDecision(r)) return { valid: false, reasons: ['result decision malformed'] };
  if (r.valid !== true || r.reasons.length) return { valid: false, reasons: r.reasons.length ? [...r.reasons] : ['not valid'] };
  const out: string[] = [];
  const m = r.measured;
  const warmup = r.warmup;
  if (!r.checkpoint) out.push('checkpoint evidence missing');
  else if (typeof r.checkpoint.startedAt !== 'string' || !r.checkpoint.startedAt || !Number.isFinite(r.checkpoint.ms) || r.checkpoint.ms < 0) {
    out.push('checkpoint timing malformed');
  }
  if (!hasLoadCounts(warmup)) out.push('warm-up evidence missing or malformed');
  if (!m) out.push('measurement missing');
  else if (!hasMeasurementStats(m)) out.push('measurement counters or statistics missing or malformed');
  if (!hasVerificationShape(r.verification)) out.push('integrity evidence missing or malformed');
  if (r.checkpoint) out.push(...windowReasons(r.checkpoint, m, r.verification?.verified ?? null, r.walCheckpoints ?? null));
  if (hasLoadCounts(warmup) && hasLoadCounts(m?.load) && ![warmup, m.load].every(l => l.iterations === l.attempts)) {
    out.push('k6 counts do not reconcile');
  }
  if (!hasStatementFields(statements)) out.push('statement evidence malformed');
  else if (!topLevel(statements).length) out.push('statement evidence missing');
  if (hasMeasurementStats(m) && !(m.accepted > 0 && m.cpuUsec > 0 && m.walBytes > 0)) out.push('statistics not captured');
  return { valid: out.length === 0, reasons: [...new Set(out)] };
}
