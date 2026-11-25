// Execute the nine preflight slots and preserve setup aborts separately from runs.
import type { HoldsRun } from './revocation-holds-judgment.ts';
import { setupQueue } from './revocation-holds-plan.ts';
import { preflightPlan, preflightResult, preflightTrialEvidence, type PreflightRow, type PreflightTrial, type SessionIdentity } from './revocation-holds-preflight.ts';
import { SetupAbort } from './revocation-holds-setup.ts';

export async function preflightSession(
  identity: SessionIdentity, measure: (trial: PreflightTrial, attemptId: string) => Promise<HoldsRun>,
  save: (result: ReturnType<typeof preflightResult> & { setupAborts: { id: string; message: string }[] }) => void,
) {
  const queue = setupQueue(preflightPlan(), trial => trial.id);
  const runs: PreflightRow[] = [];
  const setupAborts: { id: string; message: string }[] = [];
  for (const { run: trial, id } of queue.attempts()) {
    const base = { id: trial.id, attemptId: id, volume: trial.volume, repeat: trial.run.repeat };
    try {
      runs.push({ ...base, ...preflightTrialEvidence(trial, await measure(trial, id)) });
    } catch (error) {
      const message = (error as Error).message;
      if (error instanceof SetupAbort) {
        setupAborts.push({ id, message });
        queue.abort();
      } else runs.push({ ...base, passed: false, error: message });
    }
    save({ ...preflightResult(identity, runs), setupAborts });
  }
  return preflightResult(identity, runs);
}
