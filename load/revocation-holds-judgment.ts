// Pure judgement for #668 (pre-registration v3 with the 2026-11-22 approval conditions).
// Floors make a run INVALID; gates make a valid fault run FAIL. Never change either after results.
import { peaks, percentile, poolWindow, recoveryReasons, within, THRESHOLDS, type Probe, type SendTiming, type Statement } from './revocation-burst-judgment.ts';
import { floors } from './revocation-holds-floors.ts';
import { evidence } from './revocation-holds-evidence.ts';
import { noticeCorrectness } from './revocation-holds-notices.ts';
import { holdsEndSamples, poolBrackets, retryPeakPerSecond, timedSamples } from './revocation-holds-samples.ts';
import { baselineWindow, CELL_NAMES, edges, REPEATS, type Cell, type Duration, type GateTimes } from './revocation-holds-plan.ts';
import type { StallRecord } from './revocation-holds-stall.ts';
import type { ServerPoolSample, Stamped } from './revocation-holds-log.ts';
import type { HoldsTrace } from './revocation-holds-trace.ts';

export type HoldsSample = { serverMs: number; activeHolds: number; highWaterMark: number; retryAttempts: number };
// Request start and successful completion, on the harness clock; status 0 means no response.
export type AccountMutations = { memberId?: string; revokeStartedAt?: number; revokedAt?: number; revokeStatus?: number; restoreStartedAt?: number; restoredAt?: number; restoreStatus?: number };
export type TargetSocket = { account: number; ready: boolean; subscribed: boolean; stall: StallRecord; stallMessages: { id: string; at: number }[]; close?: { at: number; code: number } };
export type Notice = { socket: number; channelId: string | null; at: number }; // socket indexes the target sockets
export type HoldsRun = {
  kind: 'fault' | 'control'; cell: Cell; duration?: Duration; repeat: number;
  // gateOn and gateOff bound each gate change: [statement sent, acknowledged]. A control has no
  // gate and records [t, t] at the nominal times; its gateOff is the long recovery.
  // nominalRecovery serves the memory groups.
  times: GateTimes & { pass: number; stall: number; revoke: number; resume: number; restore?: number; end: number; nominalRecovery: Partial<Record<Duration, number>> };
  // Readiness is counted when the stall starts, so a late socket cannot satisfy floor 1.
  setup: { bystanders: number; bystandersReadyAtStall: number; targetsReadyAtStall: number; calibrationErrors: string[]; stallPostFailures: number; gateErrors?: string[] };
  revokedChannels: string[];
  accounts: AccountMutations[];
  targets: TargetSocket[];
  notices: Notice[];
  bystanderNotices: number; bystanderCloses: number[];
  serverCloses: Stamped[]; // each server `websocket_closed` log event (any socket)
  wallOffsetBoundsMs?: [number, number]; // server tracing timestamp to harness clock
  sendTiming?: SendTiming;
  samples: HoldsSample[];
  statements: Statement[]; refused: number[];
  dbProbe: Probe[]; httpProbe: Probe[]; pool: ServerPoolSample[];
  rss: { at: number; kb: number }[];
  metrics?: Record<string, number>;
  trace?: HoldsTrace;
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

/**
 * Every point in [lo, hi] where the set of probes in a window edge can change, plus the midpoints
 * between them, so each distinct window over a transition band is evaluated once.
 */
export function candidates(lo: number, hi: number, points: number[]) {
  const inside = [...new Set([lo, hi, ...points.filter(t => t > lo && t < hi)])].sort((a, b) => a - b);
  return [...inside, ...inside.slice(1).map((t, i) => (inside[i] + t) / 2)];
}
const probeTimes = (run: HoldsRun) => [...run.dbProbe, ...run.httpProbe].map(p => p.at);

/** The worst p99 over every candidate fault window [a, b): a in the gate-on band, b in the gate-off band. */
export function worstFaultP99(run: HoldsRun, probes: Probe[]) {
  const [onBefore, onAfter] = run.times.gateOn, [offBefore, offAfter] = run.times.gateOff;
  const times = probeTimes(run);
  let worst = -Infinity;
  for (const a of candidates(onBefore, onAfter, times)) for (const b of candidates(offBefore, offAfter, times)) {
    const p99 = probeStats(probes, a, b).p99Ms;
    if (Number.isFinite(p99)) worst = Math.max(worst, p99);
  }
  return worst;
}

/** Every probe in the fault healthy, and every HTTP probe in the 10 s after recovery successful. */
export function faultWindowReasons(run: HoldsRun) {
  const reasons: string[] = [];
  const e = edges(run.times);
  const baseline = baselineP99(run);
  // Counts and failures use the widest window; the p99 limits hold in every candidate window.
  const db = probeStats(run.dbProbe, e.healthFrom, e.healthTo), http = probeStats(run.httpProbe, e.healthFrom, e.healthTo);
  const dbP99 = worstFaultP99(run, run.dbProbe), httpP99 = worstFaultP99(run, run.httpProbe);
  const dbLimit = Math.max(THRESHOLDS.dbProbeP99Factor * baseline.db, THRESHOLDS.dbProbeP99FloorMs);
  const httpLimit = Math.max(THRESHOLDS.httpProbeP99Factor * baseline.http, THRESHOLDS.httpProbeP99FloorMs);
  if (!db.count || !http.count) reasons.push('no database or HTTP probe in the fault window');
  if (db.failures) reasons.push(`${db.failures} database probe failures in the fault window`);
  if (dbP99 > dbLimit) reasons.push(`fault-window database probe p99 ${dbP99.toFixed(2)} ms > ${dbLimit.toFixed(2)} ms`);
  if (http.failures) reasons.push(`${http.failures} HTTP probe failures in the fault window`);
  if (httpP99 > httpLimit) reasons.push(`fault-window HTTP probe p99 ${httpP99.toFixed(2)} ms > ${httpLimit.toFixed(2)} ms`);
  // Floor 1 requires both brackets by server sample time, so the window delta is defined here.
  const pool = poolWindow(poolBrackets(run, e.healthFrom, e.healthTo), e.healthFrom, e.healthTo);
  if (pool?.timeouts) reasons.push(`${pool.timeouts} pool acquire timeouts in the fault window`);
  const after = probeStats(run.httpProbe, e.recoveryEarliest, e.recoveryLatest + THRESHOLDS.recoveryWindowSeconds * 1000);
  if (after.failures) reasons.push(`${after.failures} HTTP probe failures in the 10 s after recovery`);
  return reasons;
}

/**
 * The approved #592 recovery rules at every candidate release in [offBefore, offAfter]: each point
 * where a probe enters or leaves the 10 s window, and the midpoints between them.
 */
export function recoveryGateReasons(run: HoldsRun) {
  const e = edges(run.times);
  const baseline = baselineP99(run);
  const span = THRESHOLDS.recoveryWindowSeconds * 1000;
  const pool = poolBrackets(run, e.recoveryEarliest, e.recoveryLatest + span);
  const times = probeTimes(run);
  const releases = candidates(e.recoveryEarliest, e.recoveryLatest, [...times, ...times.map(t => t - span)]);
  const at = (recovery: number) => recoveryReasons({ recovery, dbProbe: run.dbProbe, httpProbe: run.httpProbe, pool, dbBaselineP99Ms: baseline.db, httpBaselineP99Ms: baseline.http });
  return [...new Set(releases.flatMap(at))];
}

const ENDINGS = ['revocation_retired_timeout', 'revocation_retired_retries', 'revocation_retired_fenced'] as const;
// Floor 1 requires these counters, so a missing one can never read as zero.
const RESIDUAL_COUNTERS = ['revocation_held', 'revocation_delivered_after_hold', ...ENDINGS] as const;
export const REQUIRED_COUNTERS = [...RESIDUAL_COUNTERS, 'revocation_retired_global_cap'] as const;
export const holdResidual = (m: Record<string, number>) =>
  m.revocation_held - m.revocation_delivered_after_hold - ENDINGS.reduce((sum, key) => sum + m[key], 0);

/** The approved #592 judge() rules that carry over, plus the v3 holds-end rules. */
function holdsEndGates(run: HoldsRun) {
  const reasons: string[] = [];
  const missing: string[] = [];
  const independent: string[] = [];
  const e = edges(run.times);
  const m = run.metrics ?? {};
  // Counting from the latest release can only lower the client count.
  const afterRecovery = run.notices.filter(n => n.at >= e.recoveryLatest).length;
  if (!Number.isFinite(m.revocation_delivered_after_hold)) missing.push('delivered after hold: missing input: revocation_delivered_after_hold');
  else if (m.revocation_delivered_after_hold > afterRecovery) reasons.push(`delivered_after_hold ${m.revocation_delivered_after_hold} > client revocations after recovery ${afterRecovery}`);
  const residualMissing = RESIDUAL_COUNTERS.filter(key => !Number.isFinite(m[key]));
  if (residualMissing.length) missing.push(`hold residual: missing input: ${residualMissing.join(', ')}`);
  else if (holdResidual(m) < 0) independent.push(`hold residual ${holdResidual(m)} < 0`);
  if (!Number.isFinite(m.revocation_retired_timeout)) missing.push('timeout retirement: missing input: revocation_retired_timeout');
  else if (m.revocation_retired_timeout) independent.push(`${m.revocation_retired_timeout} holds retired by timeout`);
  const samples = holdsEndSamples(timedSamples(run), e.recoveryEarliest, e.recoveryLatest);
  const active = Math.max(0, ...samples.map(s => s.activeHolds));
  if (!samples.length) missing.push('active holds: missing input: calibrated holds-end sample');
  if (active) reasons.push(`${active} active holds at recovery + 10 s`);
  if (run.bystanderCloses.length) independent.push(`${run.bystanderCloses.length} bystander sockets closed during the run`);
  if (run.notices.some(n => n.at > e.recoveryEarliest + THRESHOLDS.drainSeconds * 1000)) reasons.push('a revocation arrived after the drain limit');
  return { reasons: [...reasons, ...independent], missing, independent };
}

export const holdsEndReasons = (run: HoldsRun) => holdsEndGates(run).reasons;

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
    pool: { fault: poolWindow(poolBrackets(run, e.healthFrom, e.healthTo), e.healthFrom, e.healthTo), recovery: poolWindow(poolBrackets(run, e.recoveryEarliest, windowEnd), e.recoveryEarliest, windowEnd) },
  };
}

export function judgeHolds(run: HoldsRun) {
  const floor = floors(run);
  const info = informational(run);
  const v4 = evidence(run);
  const base = { floors: floor.values, informational: info, evidence: v4, evidenceOnly: false, independentFailures: [] as string[], missingGateInputs: [] as string[] };
  if (!floor.reasons.length && run.kind === 'control' && !v4.issues.length) {
    return { ...base, verdict: 'CONTROL' as HoldsVerdict, floorReasons: [], reasons: [] };
  }
  const notices = noticeCorrectness(run);
  const end = holdsEndGates(run);
  const recovery = recoveryGateReasons(run);
  const missing = [...end.missing];
  const baseline = baselineP99(run);
  const fault = faultWindowReasons(run);
  const independentFailures = [...end.independent];
  for (const [phase, pool] of Object.entries(info.pool)) {
    if (!pool) missing.push(`${phase} pool timeouts: missing input: pool brackets`);
    else if (pool.timeouts) independentFailures.push(`${pool.timeouts} pool acquire timeouts in the ${phase} window`);
  }
  for (const kind of ['db', 'http'] as const) {
    if (!Number.isFinite(baseline[kind])) missing.push(`${kind} fault and recovery p99: missing input: baseline probes`);
  }
  const e = edges(run.times);
  const recoveryEnd = e.recoveryLatest + THRESHOLDS.recoveryWindowSeconds * 1000;
  for (const [name, probes] of [['database', run.dbProbe], ['HTTP', run.httpProbe]] as const) {
    if (!within(probes, e.healthFrom, e.healthTo).length) missing.push(`${name} fault health: missing input: fault probes`);
    if (!within(probes, e.recoveryEarliest, recoveryEnd).length) missing.push(`${name} recovery health: missing input: recovery probes`);
  }
  missing.push(...notices.missing);
  const reasons = [...(floor.reasons.length ? recovery.filter(reason => reason !== 'pool acquire timeouts unavailable in the recovery window') : recovery),
    ...fault, ...notices.reasons, ...end.reasons];
  if (floor.reasons.length) return { ...base, verdict: 'INVALID' as HoldsVerdict, floorReasons: floor.reasons, reasons, independentFailures, missingGateInputs: missing };
  if (run.kind === 'control') return { ...base, verdict: 'INVALID' as HoldsVerdict, floorReasons: [], reasons, evidenceOnly: true, missingGateInputs: missing };
  // Only a run that would otherwise PASS becomes INVALID here, so this never hides a FAIL.
  if (!reasons.length && notices.details.ambiguous.length) {
    return { ...base, verdict: 'INVALID' as HoldsVerdict, floorReasons: [`${notices.details.ambiguous.length} revoked-Channel sends indeterminate at a gate edge`], reasons, missingGateInputs: missing };
  }
  const evidenceOnly = !reasons.length && !missing.length && v4.issues.length > 0;
  return { ...base, verdict: (reasons.length ? 'FAIL' : v4.issues.length || missing.length ? 'INVALID' : 'PASS') as HoldsVerdict,
    floorReasons: [], reasons, evidenceOnly, missingGateInputs: missing };
}

export type CellVerdict = 'PASS' | 'FAIL' | 'NOT EVALUATED';
/**
 * Uses exactly the first three valid repeats in run order; INVALID never counts. PASS needs
 * three, all PASS; any FAIL among them fails; fewer is NOT EVALUATED.
 */
export function verdictByCell(results: { kind: 'fault' | 'control'; cell: Cell; duration?: Duration; verdict: HoldsVerdict; independentFailures?: string[] }[]) {
  const verdicts: Record<string, CellVerdict> = {};
  for (const cell of CELL_NAMES) for (const duration of ['short', 'long'] as const) {
    const valid = results.filter(r => r.kind === 'fault' && r.cell === cell && r.duration === duration && r.verdict !== 'INVALID').slice(0, REPEATS);
    const barred = results.some(r => r.cell === cell && (r.kind === 'control' || r.duration === duration) && r.verdict === 'INVALID' && r.independentFailures?.length);
    verdicts[`${cell}/${duration}`] = valid.some(r => r.verdict === 'FAIL') ? 'FAIL'
      : !barred && valid.length === REPEATS && valid.every(r => r.verdict === 'PASS') ? 'PASS' : 'NOT EVALUATED';
  }
  return verdicts;
}
