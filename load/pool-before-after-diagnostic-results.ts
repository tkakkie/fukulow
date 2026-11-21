import { spawnSync } from 'node:child_process';
import { appEvidence, unparseableAppLineCount } from './app-evidence.ts';
import type { generatorWindow } from './pool-before-after-sampling.ts';
import type { Counts, Evidence } from './pool-before-after-summary.ts';

export const diagnosticRule = {
  sendRate: 250, seconds: 60, offeredTolerance: 0.01, cpuLimitFraction: 0.90, maxHostLoad: 3,
  maxSampleGapMs: 2500, maxInteriorGapMs: 1500, slowP95Ms: 100, healthyP95Multiplier: 2, baselineP95FloorMs: 10, collapsedP95Ms: 1000,
  collapsed: '2026-11-21 (#519 bisection): With valid B, an A whose only invalidity is dropped iterations (any amount), an offered-send mismatch or an unparseable app event line yields collapsed when its send p95 >= 1000 ms and it has an HTTP 5xx or a client timeout. Checked after slow_with_drops; the bisection counts collapsed as bad.',
  slowWithDrops: '2026-11-20: With valid B and invalid A, allow only dropped iterations and an offered-send mismatch reconciled by send-lane drops within 1% of schedule. A send p95 >= 100 ms or an app failure yields slow_with_drops; otherwise ambiguous. Other invalid pairs yield null. Valid pairs use classification.',
} as const;

export type Validity = { valid: boolean; reasons: string[] };
export const validityResult = (reasons: string[]): Validity => ({ valid: reasons.length === 0, reasons });
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function poolStatsCapability(commit: string, cwd?: string) {
  const grep = spawnSync('git', ['grep', '-q', '-F', '"pool_stats"', commit, '--', 'server/src'], { cwd });
  if (grep.status === 0) return { emitsPoolStats: true };
  if (grep.status === 1) return { emitsPoolStats: false, poolStats: 'not emitted by this commit' as const };
  throw new Error('Unable to determine pool_stats capability');
}

type LegacyLogRead = { startedAt: number; uninterrupted: boolean };

export function diagnosticAppEvidence(log: string, from: number, to: number, error?: string, legacyRead?: LegacyLogRead) {
  let hasPreWindowLog = false;
  if (legacyRead) {
    log = log.replace(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) /gm, (_, timestamp: string) => {
      if (Date.parse(timestamp) <= from) hasPreWindowLog = true;
      return '';
    });
  }
  const { complete, reasons, databaseFailures, http5xx, panics: structuredPanics, unknownEvents } = appEvidence(log, from, to, error);
  const panics = structuredPanics + [...log.matchAll(/^thread '[^'\r\n]+'(?: \(\d+\))? panicked at /gm)].length;
  const unparseableLineCount = unparseableAppLineCount(log);
  if (!legacyRead) return { complete, reasons, databaseFailures, http5xx, panics, unknownEvents, unparseableLineCount };

  const legacyReasons = reasons.filter(reason => reason !== 'missing pool_stats');
  // A quiet app need not log at the end. A full read started after the window
  // covers it if retained logs reach its start and the same process is still running.
  if (!hasPreWindowLog || !(legacyRead.startedAt >= to) || !legacyRead.uninterrupted) {
    legacyReasons.push('app log does not cover the generator window');
  }
  return { complete: legacyReasons.length === 0, reasons: legacyReasons, databaseFailures, http5xx, panics, unknownEvents, unparseableLineCount };
}

export function appFailures(lanes: Counts[], http5xx: number | undefined, app: ReturnType<typeof diagnosticAppEvidence>) {
  const total = (key: 'rejected429' | 'rejected503' | 'clientTimeouts' | 'transportErrors' | 'otherErrors') =>
    lanes.reduce((sum, lane) => sum + lane[key], 0);
  return { http429: total('rejected429'), http503: total('rejected503'), clientHttp5xx: http5xx,
    serverHttp5xx: app.http5xx, clientTimeouts: total('clientTimeouts'), transportErrors: total('transportErrors'),
    otherErrors: total('otherErrors'), panics: app.panics, databaseFailures: app.databaseFailures };
}

export function hasAppFailure(failures: ReturnType<typeof appFailures>) {
  return failures.http503 > 0 || (failures.clientHttp5xx ?? 0) > 0 || failures.serverHttp5xx > 0 ||
    failures.clientTimeouts > 0 || failures.transportErrors > 0 || failures.otherErrors > 0 || failures.panics > 0 ||
    Object.values(failures.databaseFailures).some(n => n > 0);
}

type DiagnosticEvidence = {
  hostLoad: number | undefined;
  approvedSchedule: boolean;
  scheduledSendAttempts: number;
  send?: Counts;
  lanes: (Counts & { name: string })[];
  expectedLanes: string[];
  resources: Evidence & { maxInteriorGapMs: number };
  generator: ReturnType<typeof generatorWindow>;
  generatorRun: ReturnType<typeof generatorWindow>;
  cpuLimit: number;
  vusLimit: number;
  vusPeak: number | undefined;
  droppedIterations: number | undefined;
  generatorExitCode: number;
  http5xx: number | undefined;
  app: ReturnType<typeof diagnosticAppEvidence>;
  statementsCaptured: boolean;
};

export function diagnosticValidity(evidence: DiagnosticEvidence): Validity {
  const { send, scheduledSendAttempts, lanes, generator, generatorRun, resources, app } = evidence;
  const reasons: string[] = [];
  if (!evidence.approvedSchedule) reasons.push('requires one mixed 250/s step for 60 s');
  if (evidence.generatorExitCode !== 0) reasons.push('generator exited unsuccessfully');
  if (!nonnegative(evidence.hostLoad)) reasons.push('missing pair-start host load');
  else if (evidence.hostLoad >= diagnosticRule.maxHostLoad) reasons.push('pair-start host load reached 3');
  if (!send || !count(send.attempted) || !nonnegative(scheduledSendAttempts) || scheduledSendAttempts === 0) {
    reasons.push('missing offered send count');
  } else if (Math.abs(send.attempted - scheduledSendAttempts) > scheduledSendAttempts * diagnosticRule.offeredTolerance) {
    reasons.push('offered sends differ from schedule by more than 1%');
  }
  if (lanes.length !== evidence.expectedLanes.length ||
      evidence.expectedLanes.some(name => lanes.filter(lane => lane.name === name).length !== 1)) {
    reasons.push('missing or duplicate generator lanes');
  }
  for (const lane of lanes) {
    const { attempted, droppedIterations, accepted, rejected429, rejected503, clientTimeouts, otherErrors, transportErrors } = lane;
    const outcomes = [accepted, rejected429, rejected503, clientTimeouts, otherErrors, transportErrors];
    if (![attempted, droppedIterations, ...outcomes].every(count) ||
        attempted !== outcomes.reduce((sum, n) => sum + n, 0)) reasons.push(`${lane.name}: incomplete outcomes`);
  }
  if (!count(evidence.droppedIterations) ||
      lanes.reduce((sum, lane) => sum + lane.droppedIterations, 0) !== evidence.droppedIterations) reasons.push('incomplete dropped iterations evidence');
  if ((evidence.droppedIterations ?? 0) > 0 || lanes.some(lane => lane.droppedIterations > 0)) reasons.push('dropped iterations');
  if (send?.accepted && !nonnegative(send.p95)) reasons.push('missing send p95');
  if (!count(evidence.http5xx)) reasons.push('missing HTTP 5xx count');
  if (!app.complete) reasons.push(...app.reasons.map(reason => `app log: ${reason}`));
  if (!evidence.statementsCaptured) reasons.push('missing pg_stat_statements');
  const covered = (series: { samples: number; maxSampleGapMs: number; maxInteriorGapMs: number }) =>
    count(series.samples) && series.samples > 0 &&
    nonnegative(series.maxSampleGapMs) && series.maxSampleGapMs <= diagnosticRule.maxSampleGapMs &&
    nonnegative(series.maxInteriorGapMs) && series.maxInteriorGapMs <= diagnosticRule.maxInteriorGapMs;
  if (!resources.complete || !covered(resources) || resources.samplingErrors !== 0) reasons.push('missing app/DB resource evidence');
  if (generator.samplingErrors !== 0 || !covered(generatorRun.cpuPercent) || !covered(generatorRun.vus) || !covered(generatorRun.vus_max) ||
      !nonnegative(generator.cpuPercent.peak) || !count(generator.vus.peak) || !count(generator.vus_max.peak) ||
      generator.vus_max.peak === 0 || !nonnegative(evidence.cpuLimit) || evidence.cpuLimit === 0 ||
      !count(evidence.vusPeak)) reasons.push('missing generator CPU/VU evidence');
  const peakCPU = generatorRun.cpuPercent.peak;
  if (peakCPU !== null && peakCPU >= evidence.cpuLimit * 100 * diagnosticRule.cpuLimitFraction) reasons.push('generator CPU saturated');
  if (generatorRun.reachedMaxVUs || (evidence.vusPeak ?? 0) >= evidence.vusLimit) reasons.push('generator reached maxVUs');
  return validityResult(reasons);
}

type ArmResult = {
  validity: Validity;
  sendP95Ms: number | null;
  hasAppFailure: boolean;
  failures?: Pick<ReturnType<typeof appFailures>, 'http503' | 'clientHttp5xx' | 'serverHttp5xx' | 'clientTimeouts'>;
  sendSchedule?: Pick<Counts, 'attempted' | 'droppedIterations'> & { scheduledSendAttempts: number };
};

function sendDropsExplainMismatch({ sendSchedule }: ArmResult) {
  if (!sendSchedule) return false;
  const { attempted, droppedIterations, scheduledSendAttempts } = sendSchedule;
  return count(attempted) && count(droppedIterations) && nonnegative(scheduledSendAttempts) && scheduledSendAttempts > 0 &&
    Math.abs(attempted + droppedIterations - scheduledSendAttempts) <= scheduledSendAttempts * diagnosticRule.offeredTolerance;
}

const collapseReasons = new Set(['dropped iterations', 'offered sends differ from schedule by more than 1%', 'app log: unparseable app event line']);

function collapsed(b: ArmResult, a: ArmResult) {
  const f = a.failures;
  return b.validity.valid && a.validity.reasons.length > 0 && a.validity.reasons.every(reason => collapseReasons.has(reason)) &&
    a.sendP95Ms !== null && a.sendP95Ms >= diagnosticRule.collapsedP95Ms && f !== undefined &&
    (f.http503 > 0 || (f.clientHttp5xx ?? 0) > 0 || f.serverHttp5xx > 0 || f.clientTimeouts > 0);
}

export function classifyPair(b: ArmResult, a: ArmResult) {
  const validity = validityResult([...b.validity.reasons.map(reason => `B: ${reason}`), ...a.validity.reasons.map(reason => `A: ${reason}`)]);
  const { slowP95Ms, healthyP95Multiplier, baselineP95FloorMs } = diagnosticRule;
  const slow = (a.sendP95Ms !== null && a.sendP95Ms >= slowP95Ms) || a.hasAppFailure;
  if (!b.validity.valid || !a.validity.valid) {
    const dropLimited = b.validity.valid && a.validity.reasons.length > 0 && a.validity.reasons.every(reason =>
      reason === 'dropped iterations' ||
      (reason === 'offered sends differ from schedule by more than 1%' && sendDropsExplainMismatch(a)));
    const diagnosticClassification = dropLimited ? (slow ? 'slow_with_drops' as const : 'ambiguous' as const)
      : collapsed(b, a) ? 'collapsed' as const : null;
    return { validity: { ...validity, valid: false }, classification: null, diagnosticClassification };
  }
  if (slow) {
    return { validity, classification: 'slow' as const, diagnosticClassification: 'slow' as const };
  }
  if (a.sendP95Ms !== null && b.sendP95Ms !== null && !a.hasAppFailure &&
      a.sendP95Ms <= healthyP95Multiplier * Math.max(b.sendP95Ms, baselineP95FloorMs)) {
    return { validity, classification: 'healthy' as const, diagnosticClassification: 'healthy' as const };
  }
  return { validity, classification: 'ambiguous' as const, diagnosticClassification: 'ambiguous' as const };
}
