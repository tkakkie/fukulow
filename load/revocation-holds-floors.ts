// #668 validity floor. A run below it is INVALID, never PASS or FAIL.
import { within } from './revocation-burst-judgment.ts';
import { bytesBetween } from './revocation-holds-stall.ts';
import { holdsEndSample, retriesWithin, timedSamples } from './revocation-holds-samples.ts';
import { baselineWindow, CELLS, GLOBAL_CAP, potentialHolds, restoreAccount, SOCKETS_PER_ACCOUNT, TIMELINE } from './revocation-holds-plan.ts';
import type { HoldsRun } from './revocation-holds-judgment.ts';

/** Floor 1: sockets, mutations, baseline probes, clock calibrations and holds samples. */
export function setupReasons(run: HoldsRun) {
  const reasons: string[] = [];
  const { fault, recovery } = run.times;
  if (!run.targets.every(t => t.ready && t.subscribed) || run.setup.bystandersReady < run.setup.bystanders) reasons.push('not every socket was ready');
  if (run.accounts.some(a => a.revokeStatus !== 200 || a.revokedAt === undefined || !(a.revokedAt < fault))) reasons.push('a revoke mutation failed or completed after the fault started');
  const restored = restoreAccount(run.cell);
  if (restored !== undefined && run.accounts[restored]?.restoreStatus !== 200) reasons.push('the restore mutation failed');
  const [from, to] = baselineWindow(run);
  if (!within(run.dbProbe, from, to).length || !within(run.httpProbe, from, to).length) reasons.push('missing baseline probes');
  if (run.setup.calibrationErrors.length || !run.sendTiming) reasons.push('a clock calibration is invalid');
  const samples = timedSamples(run);
  const windows: [string, number, number][] = [['baseline', from, to], ['fault', fault, recovery], ['recovery', recovery, recovery + TIMELINE.holdsEndAfterRecovery]];
  for (const [name, start, end] of windows) if (!samples.some(s => s.at >= start && s.at < end)) reasons.push(`no holds sample in the ${name} window`);
  if (!holdsEndSample(samples, recovery)) reasons.push('no holds sample at or after recovery + 10 s');
  return reasons;
}

/**
 * Floor 2, made measurable:
 * (a) after its resume, every target socket's proxy read server bytes and the client then
 *     received at least one stall Message, so a backlog existed through the pause;
 * (b) no revoked-Channel send record lies certainly before the fault: an unblocked socket loop
 *     would have sent the queued notice right after the revoke;
 * (c) no target socket (client or proxy side) closed before its resume.
 */
export function stallReasons(run: HoldsRun) {
  const reasons: string[] = [];
  const backlog = run.targets.every(t => {
    const resumed = t.stall.resumedAt[0];
    return t.stall.pausedAt.length > 0 && resumed !== undefined &&
      bytesBetween(t.stall, resumed, Infinity) > 0 && t.stallMessagesAt.some(at => at >= resumed);
  });
  if (!backlog) reasons.push('a target socket shows no stalled backlog');
  const timing = run.sendTiming;
  if (timing) {
    const offset = (timing.offsetBoundsMs[0] + timing.offsetBoundsMs[1]) / 2;
    const revoked = new Set(run.revokedChannels);
    const early = timing.records.filter(r => revoked.has(r.channelId) && offset + (r.beforeMs + r.afterMs) / 2 + timing.uncertaintyMs < run.times.fault);
    if (early.length) reasons.push(`${early.length} revoked-Channel sends before the fault (socket loop not blocked)`);
  }
  const closedEarly = run.targets.some(t => {
    const resumed = t.stall.resumedAt[0] ?? Infinity;
    return (t.close && t.close.at < resumed) || t.stall.closes.some(c => c.at < resumed);
  });
  if (closedEarly) reasons.push('a target socket closed before resume');
  return reasons;
}

export function holdsValues(run: HoldsRun) {
  const samples = timedSamples(run);
  const m = run.metrics;
  const restored = restoreAccount(run.cell);
  const T = potentialHolds(run.cell);
  const hwm = holdsEndSample(samples, run.times.recovery)?.highWaterMark ?? 0;
  const retries = retriesWithin(samples, run.times.fault, run.times.recovery);
  const fenced = m?.revocation_retired_fenced;
  return {
    potentialHolds: T, hwm, hwmFloor: 0.75 * Math.min(T, GLOBAL_CAP),
    globalCapFloor: T > GLOBAL_CAP ? 0.5 * (T - GLOBAL_CAP) : undefined, globalCap: m?.revocation_retired_global_cap,
    fencedFloor: restored === undefined ? undefined : 0.5 * SOCKETS_PER_ACCOUNT * CELLS[run.cell].channels, fenced,
    retriesInFault: retries.retries, retryWindowServerMs: retries.start && retries.end ? [retries.start.serverMs, retries.end.serverMs] : null,
    retiredRetries: m?.revocation_retired_retries,
    // Floor 5's L: holds that can only end by retries.
    longHolds: restored === undefined ? hwm : hwm - (fenced ?? 0),
  };
}

/** Floors 3 to 5: holds and retries exercised. */
export function holdsReasons(run: HoldsRun, v: ReturnType<typeof holdsValues>) {
  const reasons: string[] = [];
  if (!(v.hwm >= v.hwmFloor)) reasons.push(`high-water mark ${v.hwm} < ${v.hwmFloor}`);
  if (v.globalCapFloor !== undefined && !((v.globalCap ?? -1) >= v.globalCapFloor)) reasons.push(`global-cap refusals ${v.globalCap ?? 'missing'} < ${v.globalCapFloor}`);
  if (v.fencedFloor !== undefined && !((v.fenced ?? -1) >= v.fencedFloor)) reasons.push(`fenced holds ${v.fenced ?? 'missing'} < ${v.fencedFloor}`);
  if (run.duration === 'short' && !(v.retriesInFault >= 2 * v.hwm)) reasons.push(`retry attempts in the fault ${v.retriesInFault} < ${2 * v.hwm}`);
  if (run.duration === 'long' && !((v.retiredRetries ?? -1) >= 0.75 * v.longHolds)) reasons.push(`retired by retries ${v.retiredRetries ?? 'missing'} < ${0.75 * v.longHolds}`);
  return reasons;
}

export function floors(run: HoldsRun) {
  const values = holdsValues(run);
  const reasons = [...setupReasons(run), ...stallReasons(run), ...(run.kind === 'fault' ? holdsReasons(run, values) : [])];
  return { reasons, values };
}
