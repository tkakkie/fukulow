// Pure judgement for #668 (pre-registration v3 with the 2026-11-22 approval conditions).
// Floors make a run INVALID; gates make a valid fault run FAIL. Never change either after results.
import { peaks, percentile, poolWindow, recoveryReasons, within, THRESHOLDS, type PoolSample, type Probe, type SendTiming, type Statement } from './revocation-burst-judgment.ts';
import { floors } from './revocation-holds-floors.ts';
import { noticeCorrectness } from './revocation-holds-notices.ts';
import { holdsEndSample, retryPeakPerSecond, timedSamples } from './revocation-holds-samples.ts';
import { baselineWindow, CELL_NAMES, REPEATS, type Cell, type Duration } from './revocation-holds-plan.ts';
import type { StallRecord } from './revocation-holds-stall.ts';

export type HoldsSample = { serverMs: number; activeHolds: number; highWaterMark: number; retryAttempts: number };
// Request start and successful completion, on the harness clock; status 0 means no response.
export type AccountMutations = { revokeStartedAt?: number; revokedAt?: number; revokeStatus?: number; restoreStartedAt?: number; restoredAt?: number; restoreStatus?: number };
export type TargetSocket = { account: number; ready: boolean; subscribed: boolean; stall: StallRecord; stallMessagesAt: number[]; close?: { at: number; code: number } };
export type Notice = { socket: number; channelId: string | null; at: number }; // socket indexes the target sockets
export type HoldsRun = {
  kind: 'fault' | 'control'; cell: Cell; duration?: Duration; repeat: number;
  // fault and recovery are when the gate engaged and released; a control records the nominal
  // times without a gate, and recovery is the long one. nominalRecovery serves the memory groups.
  times: { pass: number; stall: number; revoke: number; fault: number; resume: number; restore?: number; recovery: number; end: number; nominalRecovery: Partial<Record<Duration, number>> };
  setup: { bystanders: number; bystandersReady: number; calibrationErrors: string[]; stallPostFailures: number };
  revokedChannels: string[];
  accounts: AccountMutations[];
  targets: TargetSocket[];
  notices: Notice[];
  bystanderNotices: number; bystanderCloses: number;
  sendTiming?: SendTiming;
  samples: HoldsSample[];
  statements: Statement[]; refused: number[];
  dbProbe: Probe[]; httpProbe: Probe[]; pool: PoolSample[];
  rss: { at: number; kb: number }[];
  metrics?: Record<string, number>;
};
export type HoldsVerdict = 'INVALID' | 'PASS' | 'FAIL' | 'CONTROL';

const probeStats = (probes: Probe[], from: number, to: number) => {
  const inside = within(probes, from, to), ok = inside.filter(p => p.ok).map(p => p.ms);
  return { count: inside.length, failures: inside.length - ok.length, p99Ms: percentile(ok, 99) };
};

/** Every probe in the fault healthy, and every HTTP probe in the 10 s after recovery successful. */
export function faultWindowReasons(run: HoldsRun) {
  const reasons: string[] = [];
  const { fault, recovery } = run.times;
  const [from, to] = baselineWindow(run);
  const db = probeStats(run.dbProbe, fault, recovery), http = probeStats(run.httpProbe, fault, recovery);
  const dbLimit = Math.max(THRESHOLDS.dbProbeP99Factor * probeStats(run.dbProbe, from, to).p99Ms, THRESHOLDS.dbProbeP99FloorMs);
  const httpLimit = Math.max(THRESHOLDS.httpProbeP99Factor * probeStats(run.httpProbe, from, to).p99Ms, THRESHOLDS.httpProbeP99FloorMs);
  if (!db.count || !http.count) reasons.push('no database or HTTP probe in the fault window');
  if (db.failures) reasons.push(`${db.failures} database probe failures in the fault window`);
  if (db.p99Ms > dbLimit) reasons.push(`fault-window database probe p99 ${db.p99Ms.toFixed(2)} ms > ${dbLimit.toFixed(2)} ms`);
  if (http.failures) reasons.push(`${http.failures} HTTP probe failures in the fault window`);
  if (http.p99Ms > httpLimit) reasons.push(`fault-window HTTP probe p99 ${http.p99Ms.toFixed(2)} ms > ${httpLimit.toFixed(2)} ms`);
  const pool = poolWindow(run.pool, fault, recovery);
  if (!pool) reasons.push('pool acquire timeouts unavailable in the fault window');
  else if (pool.timeouts) reasons.push(`${pool.timeouts} pool acquire timeouts in the fault window`);
  const after = probeStats(run.httpProbe, recovery, recovery + THRESHOLDS.recoveryWindowSeconds * 1000);
  if (after.failures) reasons.push(`${after.failures} HTTP probe failures in the 10 s after recovery`);
  return reasons;
}

const ENDINGS = ['revocation_retired_timeout', 'revocation_retired_retries', 'revocation_retired_fenced'] as const;
export const holdResidual = (m: Record<string, number>) =>
  (m.revocation_held ?? 0) - (m.revocation_delivered_after_hold ?? 0) - ENDINGS.reduce((sum, key) => sum + (m[key] ?? 0), 0);

/** The approved #592 judge() rules that carry over, plus the v3 holds-end rules. */
export function holdsEndReasons(run: HoldsRun) {
  const reasons: string[] = [];
  const { recovery } = run.times;
  const m = run.metrics;
  if (!m) reasons.push('no metrics event after the holds resolved');
  else {
    const afterRecovery = run.notices.filter(n => n.at >= recovery).length;
    if (m.revocation_delivered_after_hold > afterRecovery) reasons.push(`delivered_after_hold ${m.revocation_delivered_after_hold} > client revocations after recovery ${afterRecovery}`);
    if (holdResidual(m) < 0) reasons.push(`hold residual ${holdResidual(m)} < 0`);
    if (m.revocation_retired_timeout) reasons.push(`${m.revocation_retired_timeout} holds retired by timeout`);
  }
  const end = holdsEndSample(timedSamples(run), recovery);
  if (!end) reasons.push('no holds sample at or after recovery + 10 s');
  else if (end.activeHolds) reasons.push(`${end.activeHolds} active holds at recovery + 10 s`);
  if (run.bystanderCloses) reasons.push(`${run.bystanderCloses} bystander sockets closed during the run`);
  if (run.notices.some(n => n.at > recovery + THRESHOLDS.drainSeconds * 1000)) reasons.push('a revocation arrived after the drain limit');
  return reasons;
}

export function informational(run: HoldsRun) {
  const { fault, recovery } = run.times;
  const windowEnd = recovery + THRESHOLDS.recoveryWindowSeconds * 1000;
  const rechecks = run.statements.filter(s => s.recheck);
  const m = run.metrics ?? {};
  return {
    recheckPeaks: { fault: peaks(within(rechecks, fault, recovery).map(s => s.at)), recovery: peaks(within(rechecks, recovery, windowEnd).map(s => s.at)) },
    retryAttemptPeakPerSecond: retryPeakPerSecond(timedSamples(run), fault, windowEnd),
    relayRefusals: run.refused.length,
    holdEndings: Object.fromEntries(Object.entries(m).filter(([key]) => key.startsWith('revocation_'))),
    holdResidual: run.metrics ? holdResidual(run.metrics) : null,
    pool: { fault: poolWindow(run.pool, fault, recovery), recovery: poolWindow(run.pool, recovery, windowEnd) },
  };
}

export function judgeHolds(run: HoldsRun) {
  const floor = floors(run);
  const info = informational(run);
  if (floor.reasons.length) return { verdict: 'INVALID' as HoldsVerdict, floorReasons: floor.reasons, reasons: [], floors: floor.values, informational: info };
  if (run.kind === 'control') return { verdict: 'CONTROL' as HoldsVerdict, floorReasons: [], reasons: [], floors: floor.values, informational: info };
  const [from, to] = baselineWindow(run);
  const reasons = [
    ...recoveryReasons({
      recovery: run.times.recovery, dbProbe: run.dbProbe, httpProbe: run.httpProbe, pool: run.pool,
      dbBaselineP99Ms: probeStats(run.dbProbe, from, to).p99Ms, httpBaselineP99Ms: probeStats(run.httpProbe, from, to).p99Ms,
    }),
    ...faultWindowReasons(run),
    ...noticeCorrectness(run).reasons,
    ...holdsEndReasons(run),
  ];
  return { verdict: (reasons.length ? 'FAIL' : 'PASS') as HoldsVerdict, floorReasons: [], reasons, floors: floor.values, informational: info };
}

export type CellVerdict = 'PASS' | 'FAIL' | 'NOT EVALUATED';
/** PASS only with at least three valid repeats, all PASS; any FAIL fails; INVALID never counts. */
export function verdictByCell(results: { kind: 'fault' | 'control'; cell: Cell; duration?: Duration; verdict: HoldsVerdict }[]) {
  const verdicts: Record<string, CellVerdict> = {};
  for (const cell of CELL_NAMES) for (const duration of ['short', 'long'] as const) {
    const valid = results.filter(r => r.kind === 'fault' && r.cell === cell && r.duration === duration && r.verdict !== 'INVALID');
    verdicts[`${cell}/${duration}`] = valid.some(r => r.verdict === 'FAIL') ? 'FAIL'
      : valid.length >= REPEATS && valid.every(r => r.verdict === 'PASS') ? 'PASS' : 'NOT EVALUATED';
  }
  return verdicts;
}
