// #668 memory verdict, separate from PASS/FAIL: fault runs against same-shape no-fault controls.
import { within } from './revocation-burst-judgment.ts';
import { CELL_NAMES, GLOBAL_CAP, REPEATS, TIMELINE, type Cell, type Duration } from './revocation-holds-plan.ts';
import type { HoldsRun, HoldsVerdict } from './revocation-holds-judgment.ts';

const BOUND_KB_PER_CAP = 8 * 1024; // documented 8 MiB per 4,096 holds

/** The true median: the mean of the two middle values for an even count. */
export function median(values: number[]) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Peak RSS in [fault, recovery + 10 s) minus the median RSS in the 10 s before the stall, in KiB.
 * The fault starts when the gate-on statement was sent; `recovery` is the latest release bound.
 */
export function rssDeltaKb(run: Pick<HoldsRun, 'rss' | 'times'>, recovery: number) {
  const baseline = within(run.rss, run.times.stall - TIMELINE.baselineMs, run.times.stall).map(s => s.kb);
  const peak = within(run.rss, run.times.gateOn[0], recovery + TIMELINE.holdsEndAfterRecovery).map(s => s.kb);
  return baseline.length && peak.length ? Math.max(...peak) - median(baseline) : NaN;
}

export type MemoryResult = { result: 'FAIL' | 'measured within bound' | 'upper bound only (never PASS)' | 'NOT EVALUATED'; dKb?: number; nKb?: number; bKb?: number; upperBoundKb?: number };
/** D, N and B as pre-registered, over exactly three valid fault runs and three valid controls. */
export function memoryVerdict(faults: { deltaKb: number; hwm: number }[], controlDeltasKb: number[]): MemoryResult {
  if (faults.length !== REPEATS || controlDeltasKb.length !== REPEATS || [...faults.flatMap(f => [f.deltaKb, f.hwm]), ...controlDeltasKb].some(v => !Number.isFinite(v))) return { result: 'NOT EVALUATED' };
  const dKb = median(faults.map(f => f.deltaKb)) - median(controlDeltasKb);
  const nKb = Math.max(...controlDeltasKb) - Math.min(...controlDeltasKb);
  const bKb = BOUND_KB_PER_CAP * Math.min(...faults.map(f => f.hwm)) / GLOBAL_CAP;
  if (dKb - nKb > bKb) return { result: 'FAIL', dKb, nKb, bKb };
  if (dKb > nKb && dKb + nKb <= bKb) return { result: 'measured within bound', dKb, nKb, bKb };
  return { result: 'upper bound only (never PASS)', dKb, nKb, bKb, upperBoundKb: Math.max(0, dKb + nKb) };
}

export type MemoryEntry = { kind: 'fault' | 'control'; cell: Cell; duration?: Duration; verdict: HoldsVerdict; hwm: number | undefined; deltaKb: Partial<Record<Duration, number>> };
/** RSS deltas of one run: a fault run for its own duration, a control for each nominal recovery. */
export function memoryEntry(run: HoldsRun, verdict: HoldsVerdict, hwm: number | undefined): MemoryEntry {
  const recoveries: Partial<Record<Duration, number>> = run.kind === 'fault' && run.duration ? { [run.duration]: run.times.gateOff[1] } : run.times.nominalRecovery;
  const deltaKb = Object.fromEntries(Object.entries(recoveries).map(([duration, recovery]) => [duration, rssDeltaKb(run, recovery)]));
  return { kind: run.kind, cell: run.cell, duration: run.duration, verdict, hwm, deltaKb };
}

/** Groups per cell x duration: the first three valid fault runs against the first three valid controls of the cell. */
export function memoryByCell(entries: MemoryEntry[]) {
  const groups: Record<string, MemoryResult> = {};
  for (const cell of CELL_NAMES) for (const duration of ['short', 'long'] as Duration[]) {
    const valid = entries.filter(e => e.cell === cell && e.verdict !== 'INVALID');
    const faults = valid.filter(e => e.kind === 'fault' && e.duration === duration).slice(0, REPEATS).map(e => ({ deltaKb: e.deltaKb[duration] ?? NaN, hwm: e.hwm ?? NaN }));
    const controls = valid.filter(e => e.kind === 'control').slice(0, REPEATS).map(e => e.deltaKb[duration] ?? NaN);
    groups[`${cell}/${duration}`] = memoryVerdict(faults, controls);
  }
  return groups;
}
