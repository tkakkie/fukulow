// #668 holds samples on the harness clock. Each 250 ms sample carries the server's monotonic
// time; the calibrated offset bounds turn it into [low, high] on the harness clock.
import type { PoolSample } from './revocation-burst-judgment.ts';
import { TIMELINE } from './revocation-holds-plan.ts';
import type { HoldsRun, HoldsSample } from './revocation-holds-judgment.ts';

export type TimedSample = HoldsSample & { low: number; at: number; high: number };

export function timedSamples(run: Pick<HoldsRun, 'samples' | 'sendTiming'>): TimedSample[] {
  if (!run.sendTiming) return [];
  const [low, high] = run.sendTiming.offsetBoundsMs;
  return run.samples.map(s => ({ ...s, low: s.serverMs + low, at: s.serverMs + (low + high) / 2, high: s.serverMs + high }))
    .sort((a, b) => a.serverMs - b.serverMs);
}

/**
 * Every sample that may be the first at or after recovery + 10 s, for a release anywhere in
 * [earliest, latest]: from the first that may lie after earliest + 10 s through the first that
 * certainly lies after latest + 10 s. Empty when no sample certainly lies after it.
 */
export function holdsEndSamples(samples: TimedSample[], earliest: number, latest: number) {
  const last = samples.findIndex(s => s.low >= latest + TIMELINE.holdsEndAfterRecovery);
  if (last < 0) return [];
  const first = samples.findIndex(s => s.high >= earliest + TIMELINE.holdsEndAfterRecovery);
  return samples.slice(first, last + 1);
}

/**
 * Started retry rechecks inside [from, to), as a lower bound: the difference between the first
 * sample certainly at or after `from` and the last sample certainly at or before `to`.
 */
export function retriesWithin(samples: TimedSample[], from: number, to: number) {
  const start = samples.find(s => s.low >= from);
  const end = [...samples].reverse().find(s => s.high <= to);
  if (!start || !end || end.serverMs < start.serverMs) return { retries: 0, start, end };
  return { retries: end.retryAttempts - start.retryAttempts, start, end };
}

/** Largest increase of the retry counter between samples at most 1 s apart, inside [from, to). */
export function retryPeakPerSecond(samples: TimedSample[], from: number, to: number) {
  const inside = samples.filter(s => s.at >= from && s.at < to);
  let peak = 0;
  for (let i = 0, j = 0; j < inside.length; j++) {
    while (inside[j].serverMs - inside[i].serverMs > 1000) i++;
    peak = Math.max(peak, inside[j].retryAttempts - inside[i].retryAttempts);
  }
  return peak;
}

/** A server tracing timestamp as [low, high] on the harness clock; undefined without calibration. */
export function wallInterval(run: Pick<HoldsRun, 'wallOffsetBoundsMs'>, wallMs: number | undefined): [number, number] | undefined {
  if (!run.wallOffsetBoundsMs || wallMs === undefined || !Number.isFinite(wallMs)) return undefined;
  return [wallMs + run.wallOffsetBoundsMs[0], wallMs + run.wallOffsetBoundsMs[1]];
}

/**
 * The pool samples that certainly bracket [from, to] by server sample time: the last certainly at
 * or before `from` and the first certainly at or after `to`. They are returned re-timed to `from`
 * and `to`, so the #592 poolWindow over them gives exactly this delta. Empty when either is missing.
 */
export function poolBrackets(run: Pick<HoldsRun, 'pool' | 'wallOffsetBoundsMs'>, from: number, to: number): PoolSample[] {
  const timed = run.pool.map(s => ({ s, t: wallInterval(run, s.wallMs) })).filter(x => x.t && Number.isFinite(x.s.fields.acquire_timeout));
  const before = timed.filter(x => x.t![1] <= from).at(-1), after = timed.find(x => x.t![0] >= to);
  if (!before || !after || !(from < to)) return [];
  return [{ at: from, fields: before.s.fields }, { at: to, fields: after.s.fields }];
}
