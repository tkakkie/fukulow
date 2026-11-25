// The #668 preflight plan and its positive acceptance rule.
import { evidence } from './revocation-holds-evidence.ts';
import { REPEATS, runId, targetSockets, type PlannedRun } from './revocation-holds-plan.ts';
import type { HoldsRun } from './revocation-holds-judgment.ts';
import { sameSessionIdentity, type SessionIdentity } from './revocation-holds-provenance.ts';

export const PREFLIGHT_VOLUMES = [20, 40, 60] as const;
const ACCEPTANCE_VOLUME = 60;
const SNAPSHOT_RECORDS = targetSockets('Hcap');
const requiredRules = new Set(['E2', 'E4c', 'E6', 'E8']);
type Volume = typeof PREFLIGHT_VOLUMES[number];

export type PreflightTrial = {
  volume: Volume;
  run: Extract<PlannedRun, { kind: 'control' }>;
  id: string;
};

export const preflightPlan = (): PreflightTrial[] => PREFLIGHT_VOLUMES.flatMap(volume =>
  Array.from({ length: REPEATS }, (_, index) => {
    const run = { kind: 'control', cell: 'Hcap', repeat: index + 1 } as const;
    return { volume, run, id: `k${volume}-${runId(run)}` };
  }));

/** Keep all 12 sender Members and use exactly k Messages in total. */
export const messagesForSender = (total: number, senders: number, index: number) =>
  Math.floor(total / senders) + Number(index < total % senders);

export function preflightTrialEvidence(trial: PreflightTrial, run: HoldsRun) {
  const proof = evidence(run, trial.volume);
  const issues = proof.issues.filter(issue => requiredRules.has(issue.rule));
  const readback = run.stallReadbacks?.[0]?.after;
  const passed = run.kind === trial.run.kind && run.cell === trial.run.cell && run.repeat === trial.run.repeat &&
    issues.length === 0 && typeof readback === 'number' && Number.isSafeInteger(readback) && readback > 0;
  return { passed, issues, snapshotRecords: proof.snapshotRecords, readback };
}

export type PreflightRow = {
  id: string; volume: Volume; repeat: number; passed: boolean; readback?: number;
  attemptId?: string; issues?: ReturnType<typeof preflightTrialEvidence>['issues']; snapshotRecords?: number; error?: string;
};

export function preflightResult(identity: SessionIdentity, runs: readonly PreflightRow[]) {
  const complete = preflightPlan().every(trial =>
    runs.filter(row => row?.id === trial.id && row.volume === trial.volume && row.repeat === trial.run.repeat).length === 1);
  const acceptance = runs.filter(row => row.volume === ACCEPTANCE_VOLUME);
  const readback = acceptance[0]?.readback;
  const passed = identity.gitClean === true && complete && runs.length === PREFLIGHT_VOLUMES.length * REPEATS && acceptance.length === REPEATS &&
    typeof readback === 'number' && Number.isSafeInteger(readback) && readback > 0 &&
    acceptance.every(row => row.passed === true && row.snapshotRecords === SNAPSHOT_RECORDS && row.readback === readback);
  return { identity, passed, readback: passed ? readback : null, runs };
}

export function preflightReadback(value: unknown, current: SessionIdentity): number | undefined {
  const result = value as Partial<ReturnType<typeof preflightResult>> | null;
  const identity = result?.identity;
  if (!identity || result.passed !== true || !Array.isArray(result.runs) || result.runs.some(row => !row)) return;
  if (!sameSessionIdentity(identity, current)) return;
  const verified = preflightResult(current, result.runs);
  if (verified.passed && verified.readback === result.readback) return verified.readback ?? undefined;
}
