// Pure judgement for #668 (pre-registration v3 with the 2026-11-22 approval conditions).
// Floors make a run INVALID; gates make a valid fault run FAIL. Never change either after results.
import { peaks, percentile, poolWindow, recoveryReasons, within, THRESHOLDS, type PoolSample, type Probe, type SendTiming, type Statement } from './revocation-burst-judgment.ts';
import { floors } from './revocation-holds-floors.ts';
import { noticeCorrectness } from './revocation-holds-notices.ts';
import { holdsEndSamples, retryPeakPerSecond, timedSamples } from './revocation-holds-samples.ts';
import { baselineWindow, CELL_NAMES, edges, REPEATS, type Cell, type Duration, type GateTimes } from './revocation-holds-plan.ts';
import type { StallRecord } from './revocation-holds-stall.ts';

export type HoldsSample = { serverMs: number; activeHolds: number; highWaterMark: number; retryAttempts: number };
// Request start and successful completion, on the harness clock; status 0 means no response.
export type AccountMutations = { revokeStartedAt?: number; revokedAt?: number; revokeStatus?: number; restoreStartedAt?: number; restoredAt?: number; restoreStatus?: number };
export type TargetSocket = { account: number; ready: boolean; subscribed: boolean; stall: StallRecord; stallMessagesAt: number[]; close?: { at: number; code: number } };
export type Notice = { socket: number; channelId: string | null; at: number }; // socket indexes the target sockets
export type HoldsRun = {
  kind: 'fault' | 'control'; cell: Cell; duration?: Duration; repeat: number;
  // gateOn and gateOff bound each gate change: [statement sent, acknowledged]. A control has no
  // gate and records [t, t] at the nominal times; its gateOff is the long recovery.
  // nominalRecovery serves the memory groups.
  times: GateTimes & { pass: number; stall: number; revoke: number; resume: number; restore?: number; end: number; nominalRecovery: Partial<Record<Duration, number>> };
  // Readiness is counted when the stall starts, so a late socket cannot satisfy floor 1.
  setup: { bystanders: number; bystandersReadyAtStall: number; targetsReadyAtStall: number; calibrationErrors: string[]; stallPostFailures: number };
  revokedChannels: string[];
  accounts: AccountMutations[];
  targets: TargetSocket[];
  notices: Notice[];
  bystanderNotices: number; bystanderCloses: number;
  serverCloses: number[]; // arrival of each server `websocket_closed` log event (any socket)
  sendTiming?: SendTiming;
  samples: HoldsSample[];
  statements: Statement[]; refused: number[];
  dbProbe: Probe[]; httpProbe: Probe[]; pool: PoolSample[];
  rss: { at: number; kb: number }[];
  metrics?: Record<string, number>;
};
export type HoldsVerdict = 'INVALID' | 'PASS' | 'FAIL' | 'CONTROL';

export const probeStats = (probes: Probe[], from: number, to: number) => {
  const inside = within(probes, from, to), ok = inside.filter(p => p.ok).map(p => p.ms);
  return { count: inside.length, failures: inside.length - ok.length, p99Ms: percentile(ok, 99) };
};
const baselineP99 = (run: HoldsRun) => {
  const [from, to] = baselineWindow(run);
  return { db: probeStats(run.dbProbe, from, to).p99Ms, http: probeStats(run.httpProbe, from, to).p99Ms };
};

/** Every probe in the fault healthy, and every HTTP probe in the 10 s after recovery successful. */
export function faultWindowReasons(run: HoldsRun) {
  const reasons: string[] = [];
  const e = edges(run.times);
  const baseline = baselineP99(run);
  const db = probeStats(run.dbProbe, e.healthFrom, e.healthTo), http = probeStats(run.httpProbe, e.healthFrom, e.healthTo);
  const dbLimit = Math.max(THRESHOLDS.dbProbeP99Factor * baseline.db, THRESHOLDS.dbProbeP99FloorMs);
  const httpLimit = Math.max(THRESHOLDS.httpProbeP99Factor * baseline.http, THRESHOLDS.httpProbeP99FloorMs);
  if (!db.count || !http.count) reasons.push('no database or HTTP probe in the fault window');
  if (db.failures) reasons.push(`${db.failures} database probe failures in the fault window`);
  if (db.p99Ms > dbLimit) reasons.push(`fault-window database probe p99 ${db.p99Ms.toFixed(2)} ms > ${dbLimit.toFixed(2)} ms`);
  if (http.failures) reasons.push(`${http.failures} HTTP probe failures in the fault window`);
  if (http.p99Ms > httpLimit) reasons.push(`fault-window HTTP probe p99 ${http.p99Ms.toFixed(2)} ms > ${httpLimit.toFixed(2)} ms`);
  // Floor 1 requires both brackets, so the window delta is defined here.
  const pool = poolWindow(run.pool, e.healthFrom, e.healthTo);
  if (pool?.timeouts) reasons.push(`${pool.timeouts} pool acquire timeouts in the fault window`);
  const after = probeStats(run.httpProbe, e.recoveryEarliest, e.recoveryLatest + THRESHOLDS.recoveryWindowSeconds * 1000);
  if (after.failures) reasons.push(`${after.failures} HTTP probe failures in the 10 s after recovery`);
  return reasons;
}

/** The approved #592 recovery rules, applied at both ends of the release interval. */
export function recoveryGateReasons(run: HoldsRun) {
  const e = edges(run.times);
  const baseline = baselineP99(run);
  const at = (recovery: number) => recoveryReasons({ recovery, dbProbe: run.dbProbe, httpProbe: run.httpProbe, pool: run.pool, dbBaselineP99Ms: baseline.db, httpBaselineP99Ms: baseline.http });
  return [...new Set([...at(e.recoveryEarliest), ...at(e.recoveryLatest)])];
}

const ENDINGS = ['revocation_retired_timeout', 'revocation_retired_retries', 'revocation_retired_fenced'] as const;
// Floor 1 requires these counters, so a missing one can never read as zero.
export const REQUIRED_COUNTERS = ['revocation_held', 'revocation_delivered_after_hold', ...ENDINGS, 'revocation_retired_global_cap'] as const;
export const holdResidual = (m: Record<string, number>) =>
  m.revocation_held - m.revocation_delivered_after_hold - ENDINGS.reduce((sum, key) => sum + m[key], 0);

/** The approved #592 judge() rules that carry over, plus the v3 holds-end rules. */
export function holdsEndReasons(run: HoldsRun) {
  const reasons: string[] = [];
  const e = edges(run.times);
  const m = run.metrics!; // floor 1
  // Counting from the latest release can only lower the client count.
  const afterRecovery = run.notices.filter(n => n.at >= e.recoveryLatest).length;
  if (m.revocation_delivered_after_hold > afterRecovery) reasons.push(`delivered_after_hold ${m.revocation_delivered_after_hold} > client revocations after recovery ${afterRecovery}`);
  if (holdResidual(m) < 0) reasons.push(`hold residual ${holdResidual(m)} < 0`);
  if (m.revocation_retired_timeout) reasons.push(`${m.revocation_retired_timeout} holds retired by timeout`);
  const active = Math.max(0, ...holdsEndSamples(timedSamples(run), e.recoveryEarliest, e.recoveryLatest).map(s => s.activeHolds));
  if (active) reasons.push(`${active} active holds at recovery + 10 s`);
  if (run.bystanderCloses) reasons.push(`${run.bystanderCloses} bystander sockets closed during the run`);
  if (run.notices.some(n => n.at > e.recoveryEarliest + THRESHOLDS.drainSeconds * 1000)) reasons.push('a revocation arrived after the drain limit');
  return reasons;
}

export function informational(run: HoldsRun) {
  const e = edges(run.times);
  const windowEnd = e.recoveryLatest + THRESHOLDS.recoveryWindowSeconds * 1000;
  const rechecks = run.statements.filter(s => s.recheck);
  const samples = timedSamples(run);
  const m = run.metrics ?? {};
  return {
    recheckPeaks: { fault: peaks(within(rechecks, e.certainFrom, e.certainTo).map(s => s.at)), recovery: peaks(within(rechecks, e.recoveryLatest, windowEnd).map(s => s.at)) },
    // Differences of 250 ms samples at most 1 s apart: a lower bound on the true peak.
    retryAttemptPeakPerSecondLowerBound: {
      fault: retryPeakPerSecond(samples, e.certainFrom, e.certainTo),
      recovery: retryPeakPerSecond(samples, e.recoveryLatest, windowEnd),
    },
    relayRefusals: run.refused.length,
    holdEndings: Object.fromEntries(Object.entries(m).filter(([key]) => key.startsWith('revocation_'))),
    holdResidual: REQUIRED_COUNTERS.every(key => Number.isFinite(m[key])) ? holdResidual(m) : null,
    pool: { fault: poolWindow(run.pool, e.healthFrom, e.healthTo), recovery: poolWindow(run.pool, e.recoveryEarliest, windowEnd) },
  };
}

export function judgeHolds(run: HoldsRun) {
  const floor = floors(run);
  const info = informational(run);
  if (floor.reasons.length) return { verdict: 'INVALID' as HoldsVerdict, floorReasons: floor.reasons, reasons: [] as string[], floors: floor.values, informational: info };
  if (run.kind === 'control') return { verdict: 'CONTROL' as HoldsVerdict, floorReasons: [] as string[], reasons: [] as string[], floors: floor.values, informational: info };
  const reasons = [...recoveryGateReasons(run), ...faultWindowReasons(run), ...noticeCorrectness(run).reasons, ...holdsEndReasons(run)];
  return { verdict: (reasons.length ? 'FAIL' : 'PASS') as HoldsVerdict, floorReasons: [] as string[], reasons, floors: floor.values, informational: info };
}

export type CellVerdict = 'PASS' | 'FAIL' | 'NOT EVALUATED';
/**
 * Uses exactly the first three valid repeats in run order; INVALID never counts. PASS needs
 * three, all PASS; any FAIL among them fails; fewer is NOT EVALUATED.
 */
export function verdictByCell(results: { kind: 'fault' | 'control'; cell: Cell; duration?: Duration; verdict: HoldsVerdict }[]) {
  const verdicts: Record<string, CellVerdict> = {};
  for (const cell of CELL_NAMES) for (const duration of ['short', 'long'] as const) {
    const valid = results.filter(r => r.kind === 'fault' && r.cell === cell && r.duration === duration && r.verdict !== 'INVALID').slice(0, REPEATS);
    verdicts[`${cell}/${duration}`] = valid.some(r => r.verdict === 'FAIL') ? 'FAIL'
      : valid.length >= REPEATS && valid.every(r => r.verdict === 'PASS') ? 'PASS' : 'NOT EVALUATED';
  }
  return verdicts;
}
