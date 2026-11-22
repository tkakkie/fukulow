// #668 rehearsal: counts only. It never computes a verdict, a floor, a gate or a memory result,
// so a rehearsal cannot be read as a measurement.
import { bytesBetween } from './revocation-holds-stall.ts';
import { holdsEndSamples, retriesWithin, timedSamples } from './revocation-holds-samples.ts';
import { edges } from './revocation-holds-plan.ts';
import { median } from './revocation-holds-memory.ts';
import type { HoldsRun } from './revocation-holds-judgment.ts';

const spread = (values: number[]) => values.length ? { min: Math.min(...values), median: median(values), max: Math.max(...values) } : null;
const span = (from: number | undefined, to: number | undefined) => from === undefined || to === undefined ? null : to - from;

export function rehearsalCounts(run: HoldsRun) {
  const e = edges(run.times);
  const samples = timedSamples(run);
  const resumed = (t: HoldsRun['targets'][number]) => t.stall.resumedAt[0] ?? Infinity;
  const end = holdsEndSamples(samples, e.recoveryEarliest, e.recoveryLatest);
  const counters = Object.fromEntries(Object.entries(run.metrics ?? {}).filter(([key]) => key.startsWith('revocation_')));
  return {
    kind: run.kind, cell: run.cell, duration: run.duration, repeat: run.repeat,
    readyAtStall: { targets: run.setup.targetsReadyAtStall, bystanders: run.setup.bystandersReadyAtStall },
    stallBytesAfterResume: spread(run.targets.map(t => bytesBetween(t.stall, resumed(t), Infinity))),
    stallMessagesAfterResume: spread(run.targets.map(t => t.stallMessagesAt.filter(at => at >= resumed(t)).length)),
    closes: {
      targetClient: run.targets.filter(t => t.close).length,
      proxy: run.targets.reduce((sum, t) => sum + t.stall.closes.length, 0),
      bystander: run.bystanderCloses,
      server: run.serverCloses.length,
    },
    highWaterMarkAtHoldsEnd: end[0]?.highWaterMark ?? null,
    retriesInFault: retriesWithin(samples, e.certainFrom, e.certainTo).retries,
    counters,
    gate: { on: run.times.gateOn, off: run.times.gateOff, onMs: run.times.gateOn[1] - run.times.gateOn[0], offMs: run.times.gateOff[1] - run.times.gateOff[0] },
    timings: { pass: run.times.pass, stall: run.times.stall, revoke: run.times.revoke, resume: run.times.resume, restore: run.times.restore ?? null, end: run.times.end },
    mutationsMs: {
      revoke: spread(run.accounts.map(a => span(a.revokeStartedAt, a.revokedAt)).filter((v): v is number => v !== null)),
      restore: spread(run.accounts.map(a => span(a.restoreStartedAt, a.restoredAt)).filter((v): v is number => v !== null)),
    },
  };
}
