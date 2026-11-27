// Fault-window observations for the #668 diagnostic report.
import type { HoldsRun } from './revocation-holds-judgment.ts';
import { median } from './revocation-holds-memory.ts';
import { PERMIT_CALLERS } from './revocation-holds-permits.ts';
import { edges, type GateTimes } from './revocation-holds-plan.ts';

const BUDGET = 9;
const OCCUPANCY_FRACTION = 0.8;

export function permitFaultEvidence(run: Pick<HoldsRun, 'kind' | 'duration' | 'sendTiming' | 'permits' | 'statements'> & { times: GateTimes }, retries: number | undefined) {
  if (run.kind !== 'fault' || !run.sendTiming || !run.permits?.length) return;
  const { certainFrom: from, certainTo: to } = edges(run.times);
  if (!(to > from)) return;
  const [low, high] = run.sendTiming.offsetBoundsMs;
  const samples = run.permits.filter(s => s.permits_total > 0 && s.serverMs + low >= from && s.serverMs + high <= to)
    .sort((a, b) => a.serverMs - b.serverMs);
  if (!samples.length) return;

  const held = (sample: typeof samples[number]) => PERMIT_CALLERS.reduce((sum, caller) => sum + sample[caller].holding, 0);
  const saturated = samples.filter(sample => held(sample) === BUDGET);
  const withWaiters = saturated.filter(sample => sample.retry.waiting > 0).length;
  const rechecks = run.statements.filter(s => s.recheck);
  const relayInFlight = samples.map(sample => {
    const at = sample.serverMs + (low + high) / 2;
    return rechecks.filter(s => s.at <= at && at < s.at + s.ms).length;
  });
  const first = samples[0], last = samples[samples.length - 1];
  const callerTiming = Object.fromEntries(PERMIT_CALLERS.map(caller => [caller, {
    holdUs: last[caller].hold_us_total - first[caller].hold_us_total,
    poolWaitUs: last[caller].pool_wait_us_total - first[caller].pool_wait_us_total,
    statementUs: last[caller].statement_us_total - first[caller].statement_us_total,
  }]));
  const preAttemptDeadlines = last.retry.deadline_exits_before_attempt - first.retry.deadline_exits_before_attempt;
  const waitAbandoned = last.retry.wait_abandoned - first.retry.wait_abandoned;
  const faultMs = to - from;
  const completedInFault = rechecks.filter(s => s.at >= from && s.at + s.ms <= to).map(s => s.ms);
  const medianStatementMs = completedInFault.length ? median(completedInFault) : null;
  return {
    b1: {
      samples: samples.length, permitsTotal: [...new Set(samples.map(sample => sample.permits_total))],
      saturatedSamples: saturated.length, met: saturated.length / samples.length >= OCCUPANCY_FRACTION,
      occupancyTimeFraction: samples.length > 1 ? Object.values(callerTiming).reduce((sum, row) => sum + row.holdUs, 0) / (BUDGET * faultMs * 1000) : null,
      relayInFlight: { samplesAtNine: relayInFlight.filter(n => n === BUDGET).length, max: Math.max(...relayInFlight) },
    },
    b2: { preAttemptDeadlines, waitAbandoned, nonDeadlineDrops: waitAbandoned - preAttemptDeadlines, saturatedSamplesWithRetryWaiting: withWaiters, met: preAttemptDeadlines > 0 || withWaiters > 0 },
    b3: { retryAttemptsPerSecond: retries === undefined ? null : retries * 1000 / faultMs, medianStatementMs, expectedAttemptsPerSecond: medianStatementMs && BUDGET * 1000 / medianStatementMs, callerTiming },
    shortFaultRetryBandFlag: run.duration === 'short' && retries !== undefined ? retries < 1115 || retries > 1363 : undefined,
    counterSpanMs: last.serverMs - first.serverMs,
  };
}
