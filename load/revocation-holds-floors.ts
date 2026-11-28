// #668 validity floor. A run below it is INVALID, never PASS or FAIL. A missing input never
// clears a floor or a gate: it fails the floor here.
import { THRESHOLDS, within } from './revocation-burst-judgment.ts';
import { bytesBetween } from './revocation-holds-stall.ts';
import { holdsEndSamples, poolBrackets, retriesWithin, timedSamples, wallInterval } from './revocation-holds-samples.ts';
import { baselineWindow, BYSTANDERS, CELLS, edges, GLOBAL_CAP, potentialHolds, restoreAccount, SOCKETS_PER_ACCOUNT, targetSockets, TIMELINE } from './revocation-holds-plan.ts';
import { REQUIRED_COUNTERS, type HoldsRun } from './revocation-holds-judgment.ts';

function restoreReasons(run: HoldsRun) {
  const restored = restoreAccount(run.cell);
  if (restored === undefined) return [];
  const a = run.accounts[restored];
  if (a?.restoreStatus !== 200 || a.restoredAt === undefined || a.restoreStartedAt === undefined) return ['the restore mutation failed'];
  const reasons: string[] = [];
  if (a.restoredAt > run.times.pass + TIMELINE.restoreDeadline) reasons.push('the restore did not complete by P + 2.5 s');
  if (run.kind === 'fault' && a.restoreStartedAt < edges(run.times).certainFrom) reasons.push('the restore started before the fault was certainly on');
  return reasons;
}

/** Floor 1: sockets, mutations, baseline probes, clock calibrations, samples, counters, pool brackets. */
export function setupReasons(run: HoldsRun) {
  const reasons: string[] = [];
  const e = edges(run.times);
  reasons.push(...(run.setup.gateErrors ?? []));
  if (run.setup.targetsReadyAtStall < targetSockets(run.cell) || run.setup.bystandersReadyAtStall < BYSTANDERS) reasons.push('not every socket was ready when the stall started');
  if (run.accounts.length !== CELLS[run.cell].accounts || run.accounts.some(a => a.revokeStatus !== 200 || a.revokeStartedAt === undefined || a.revokedAt === undefined || !(a.revokedAt < e.healthFrom))) reasons.push('a revoke mutation failed or completed after the fault started');
  reasons.push(...restoreReasons(run));
  const [from, to] = baselineWindow(run);
  // At least one successful probe of each kind keeps the baseline p99 finite.
  if (!within(run.dbProbe, from, to).some(p => p.ok) || !within(run.httpProbe, from, to).some(p => p.ok)) reasons.push('missing successful baseline probes');
  if (run.setup.calibrationErrors.length || !run.sendTiming || !run.wallOffsetBoundsMs) reasons.push('a clock calibration is invalid');
  const samples = timedSamples(run);
  const windows: [string, number, number][] = [['baseline', from, to], ['fault', e.certainFrom, e.certainTo], ['recovery', e.recoveryEarliest, e.recoveryEarliest + TIMELINE.holdsEndAfterRecovery]];
  for (const [name, start, end] of windows) if (!samples.some(s => s.at >= start && s.at < end)) reasons.push(`no holds sample in the ${name} window`);
  if (!holdsEndSamples(samples, e.recoveryEarliest, e.recoveryLatest).length) reasons.push('no holds sample at or after recovery + 10 s');
  if (run.kind === 'fault') {
    const m = run.metrics;
    if (!m) reasons.push('no metrics event after the drain');
    else for (const key of REQUIRED_COUNTERS) if (!Number.isFinite(m[key])) reasons.push(`missing counter ${key}`);
    const recoveryEnd = e.recoveryLatest + THRESHOLDS.recoveryWindowSeconds * 1000;
    // By server sample time: a sample is a bracket only if it is certainly on its side.
    if (!poolBrackets(run, e.healthFrom, e.healthTo).length) reasons.push('pool samples do not bracket the fault window');
    if (!poolBrackets(run, e.recoveryEarliest, recoveryEnd).length) reasons.push('pool samples do not bracket the recovery window');
  }
  return reasons;
}

/**
 * Floor 2, made measurable:
 * (a) after its resume, every target socket's proxy read server bytes and the client then
 *     received at least one stall Message, so a backlog existed through the pause;
 * (b) no revoked-Channel send record lies certainly before the gate-on statement: an unblocked
 *     socket loop would have sent the queued notice right after the revoke;
 * (c) no target close before its resume + 1.5 s. Server closes use the earlier of actual and
 *     scheduled resume, unless a bystander close takes precedence at the scored gate.
 */
export function stallReasons(run: HoldsRun) {
  const reasons: string[] = [];
  const backlog = run.targets.length === targetSockets(run.cell) && run.targets.every(t => {
    const resumed = t.stall.resumedAt[0];
    return t.stall.pausedAt.length > 0 && resumed !== undefined &&
      bytesBetween(t.stall, resumed, Infinity) > 0 && t.stallMessages.some(message => message.at >= resumed);
  });
  if (!backlog) reasons.push('a target socket shows no stalled backlog');
  const timing = run.sendTiming;
  if (timing) {
    const offset = (timing.offsetBoundsMs[0] + timing.offsetBoundsMs[1]) / 2;
    const revoked = new Set(run.revokedChannels);
    const early = timing.records.filter(r => revoked.has(r.channelId) && offset + (r.beforeMs + r.afterMs) / 2 + timing.uncertaintyMs < edges(run.times).sendFrom);
    if (early.length) reasons.push(`${early.length} revoked-Channel sends before the fault (socket loop not blocked)`);
  }
  const targetClosed = run.targets.some(t => {
    const before = (t.stall.resumedAt[0] ?? Infinity) + TIMELINE.closeMargin;
    return (t.close && t.close.at < before) || t.stall.closes.some(c => c.at < before);
  });
  if (targetClosed) reasons.push('a target socket closed before resume + 1.5 s');
  const serverLimit = Math.min(run.times.resume, run.times.pass + TIMELINE.resume) + TIMELINE.closeMargin;
  if (!run.bystanderCloses.length && run.serverCloses.some(c => { const t = wallInterval(run, c.wallMs); return !t || t[0] < serverLimit; })) reasons.push('the server closed a socket before resume + 1.5 s');
  return reasons;
}

export function holdsValues(run: HoldsRun) {
  const samples = timedSamples(run);
  const e = edges(run.times);
  const m = run.metrics;
  const restored = restoreAccount(run.cell);
  const T = potentialHolds(run.cell);
  // The retry floors and L use the highest candidate holds-end HWM; floor 3's minimum and the
  // memory bound use the lowest. HWM is monotone, so these are the last and first candidates.
  const ends = holdsEndSamples(samples, e.recoveryEarliest, e.recoveryLatest);
  const hwm: number | undefined = ends.at(-1)?.highWaterMark, hwmLowest: number | undefined = ends[0]?.highWaterMark;
  const retries = retriesWithin(samples, e.certainFrom, e.certainTo);
  const fenced = m?.revocation_retired_fenced;
  return {
    potentialHolds: T, hwm, hwmLowest, hwmFloor: 0.75 * Math.min(T, GLOBAL_CAP),
    globalCapFloor: T > GLOBAL_CAP ? 0.5 * (T - GLOBAL_CAP) : undefined, globalCap: m?.revocation_retired_global_cap,
    fencedFloor: restored === undefined ? undefined : 0.5 * SOCKETS_PER_ACCOUNT * CELLS[run.cell].channels, fenced,
    retriesInFault: retries.retries, retryWindowServerMs: retries.start && retries.end ? [retries.start.serverMs, retries.end.serverMs] : null,
    retiredRetries: m?.revocation_retired_retries,
    // Floor 5's L: holds that can only end by retries.
    longHolds: hwm === undefined ? undefined : restored === undefined ? hwm : fenced === undefined ? undefined : hwm - fenced,
  };
}

const below = (value: number | undefined, floor: number) => value === undefined || !Number.isFinite(value) || !(value >= floor);
const show = (value: number | undefined) => value ?? 'missing';

/** Floors 3 to 5: holds and retries exercised. Missing inputs fail. */
export function holdsReasons(run: HoldsRun, v: ReturnType<typeof holdsValues>) {
  const reasons: string[] = [];
  // Floor 3 is a minimum, so the lowest candidate; the retry floors and L use the highest.
  if (below(v.hwmLowest, v.hwmFloor)) reasons.push(`high-water mark ${show(v.hwmLowest)} < ${v.hwmFloor}`);
  if (v.globalCapFloor !== undefined && below(v.globalCap, v.globalCapFloor)) reasons.push(`global-cap refusals ${show(v.globalCap)} < ${v.globalCapFloor}`);
  if (v.fencedFloor !== undefined && below(v.fenced, v.fencedFloor)) reasons.push(`fenced holds ${show(v.fenced)} < ${v.fencedFloor}`);
  const retryFloor = v.hwm === undefined ? undefined : 2 * v.hwm;
  if (run.duration === 'short' && (retryFloor === undefined || below(v.retriesInFault, retryFloor))) reasons.push(`retry attempts in the fault ${v.retriesInFault} < ${show(retryFloor)}`);
  const retiredFloor = v.longHolds === undefined ? undefined : 0.75 * v.longHolds;
  if (run.duration === 'long' && (retiredFloor === undefined || below(v.retiredRetries, retiredFloor))) reasons.push(`retired by retries ${show(v.retiredRetries)} < ${show(retiredFloor)}`);
  return reasons;
}

export function floors(run: HoldsRun) {
  const values = holdsValues(run);
  const reasons = [...setupReasons(run), ...stallReasons(run), ...(run.kind === 'fault' ? holdsReasons(run, values) : [])];
  return { reasons, values };
}
