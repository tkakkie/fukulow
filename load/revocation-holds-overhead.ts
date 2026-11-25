// Rehearsal-only screen for the effect of S1–S4 on worker timing and peak RSS.
import { evidence, stallMessagesAfterResume } from './revocation-holds-evidence.ts';
import { holdsValues } from './revocation-holds-floors.ts';
import type { HoldsRun } from './revocation-holds-judgment.ts';
import { median, memoryVerdict, rssDeltaKb, type MemoryResult } from './revocation-holds-memory.ts';
import { BYSTANDERS, DURATIONS, REPEATS, STALL_MESSAGES, targetSockets, type PlannedRun } from './revocation-holds-plan.ts';
import { TRACE_EVENTS } from './revocation-holds-trace.ts';

export type TraceMode = 'on' | 'off';
export function overheadPlan() {
  return Array.from({ length: 2 * REPEATS }, (_, index) => ({
    mode: (index % 2 ? 'off' : 'on') as TraceMode,
    runs: [
      { kind: 'fault', cell: 'Hcap', duration: 'short', repeat: index + 1 },
      { kind: 'control', cell: 'Hcap', repeat: index + 1 },
    ] satisfies PlannedRun[],
  }));
}

export function workerTiming(run: HoldsRun) {
  const bounds = run.sendTiming?.offsetBoundsMs;
  if (!bounds || !run.trace || run.trace.timingErrors.length) return undefined;
  const offset = (bounds[0] + bounds[1]) / 2;
  const near = run.trace.timing.filter(t => Math.abs(t.started + offset - run.times.pass) <= 1_000);
  if (near.length !== 1) return undefined;
  const [tick] = near;
  if (run.kind === 'fault' && tick.admission === undefined) return undefined;
  const passes = run.trace.events.filter(event => event.name === 'subscription_fallback_pass').filter(event => event.tick === tick.tick);
  if (run.trace.events.length && (passes.length !== 1 || passes[0].started !== tick.started ||
    passes[0].session !== tick.session || passes[0].completed > tick.completed)) return undefined;
  return {
    tick: tick.tick,
    completionMs: tick.completed - tick.started,
    admissionMs: tick.admission === undefined ? undefined : tick.admission - tick.started,
  };
}

const TRACE_BYTES = 64 * 1024;
const TRACE_LAG_MS = 50;
const RSS_MARGIN_KB = 64;

export function overheadSample(run: HoldsRun, mode: TraceMode) {
  const problems = [...new Set([
    ...(run.trace?.evidenceErrors ?? ['missing trace']), ...(run.trace?.timingErrors ?? []), ...(run.setup.gateErrors ?? []),
  ])];
  const targets = targetSockets(run.cell);
  if (run.setup.targetsReadyAtStall !== targets || run.setup.bystandersReadyAtStall !== BYSTANDERS ||
    run.targets.length !== targets || run.targets.some(t => stallMessagesAfterResume(t) !== STALL_MESSAGES)) {
    problems.push('incomplete stall fixture');
  }
  const events = run.trace?.events ?? [];
  const bytes = events.reduce((sum, event) => sum + event.bytes, 0);
  if (bytes > TRACE_BYTES) problems.push('S1–S4 exceed 64 KiB');
  const timing = workerTiming(run);
  if (!timing) problems.push('missing or ambiguous worker timing near P');
  const low = run.sendTiming?.offsetBoundsMs[0];
  const counts = Object.fromEntries(TRACE_EVENTS.map(name => {
    const matching = events.filter(event => event.name === name);
    const lags = matching.map(event => {
      if (event.receivedAt === undefined || low === undefined) return undefined;
      const time = 'at' in event ? event.at : 'finished' in event ? event.finished : event.completed;
      // Use the earliest mapped server time for the upper bound on lag.
      return event.receivedAt - (time + low);
    });
    if (lags.some(lag => lag === undefined || lag > TRACE_LAG_MS)) problems.push(`${name} arrival lag is missing or exceeds 50 ms`);
    return [name, { lines: matching.length, bytes: matching.reduce((sum, event) => sum + event.bytes, 0), lags }];
  }));
  const v4 = mode === 'on' ? evidence(run) : undefined;
  const passCounts = mode === 'on' && v4 && !v4.issues.length
    ? [1, 1, 1, 1] : undefined;
  if (mode === 'on' && !passCounts) problems.push('missing or incomplete S1–S4 for the worker pass near P');
  if (mode === 'off' && events.length) problems.push('tracing-off run emitted S1–S4');
  return {
    mode, kind: run.kind, repeat: run.repeat, timing, counts, passCounts, problems, watermark: run.trace?.watermark, evidence: v4,
    deltaKb: rssDeltaKb(run, run.times.pass + DURATIONS.short), hwm: holdsValues(run).hwmLowest,
  };
}
type Sample = ReturnType<typeof overheadSample>;

function compare(on: (number | undefined)[], off: (number | undefined)[], limit: (off: number[]) => number) {
  if (on.length !== REPEATS || off.length !== REPEATS || !on.every(finite) || !off.every(finite)) return undefined;
  const onMedian = median(on), offMedian = median(off), change = onMedian - offMedian, bound = limit(off);
  return { onMedian, offMedian, change, bound, within: change <= bound };
}
const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);
const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
const timingBound = (off: number[]) => Math.max(2, 0.1 * median(off));

type FourArms = { faultOn: Sample[]; faultOff: Sample[]; controlOn: Sample[]; controlOff: Sample[] };
function rssScreen(arms: FourArms) {
  const fOn = arms.faultOn.map(s => s.deltaKb), fOff = arms.faultOff.map(s => s.deltaKb);
  const cOn = arms.controlOn.map(s => s.deltaKb), cOff = arms.controlOff.map(s => s.deltaKb);
  const on = memoryVerdict(arms.faultOn.map(s => ({ deltaKb: s.deltaKb, hwm: s.hwm ?? NaN })), cOn);
  const off = memoryVerdict(arms.faultOff.map(s => ({ deltaKb: s.deltaKb, hwm: s.hwm ?? NaN })), cOff);
  const fault = compare(fOn, fOff, off => spread(off) + RSS_MARGIN_KB);
  const control = compare(cOn, cOff, off => spread(off) + RSS_MARGIN_KB);
  if (!fault || !control || on.dKb === undefined || off.dKb === undefined || off.nKb === undefined || off.bKb === undefined) {
    return { fault, control, on, off, verdict: 'inconclusive' as const };
  }
  const changeKb = on.dKb - off.dKb;
  // Envelope of observed fault-minus-control differences in each mode, then difference of envelopes.
  const correctionKb: [number, number] = [
    Math.min(...fOn) - Math.max(...cOn) - (Math.max(...fOff) - Math.min(...cOff)),
    Math.max(...fOn) - Math.min(...cOn) - (Math.min(...fOff) - Math.max(...cOff)),
  ];
  const corrected: [number, number] = [on.dKb - correctionKb[1], on.dKb - correctionKb[0]];
  const stable = on.result === off.result && stableMemoryVerdict(on.result, corrected, off.nKb, off.bKb);
  return { fault, control, on, off, changeKb, correctionKb, verdict: stable ? 'stable' as const : 'inconclusive' as const };
}

function stableMemoryVerdict(result: MemoryResult['result'], [low, high]: [number, number], noise: number, bound: number) {
  if (result === 'FAIL') return low - noise > bound;
  if (result === 'measured within bound') return low > noise && high + noise <= bound;
  const couldMeasure = bound - noise > noise && high > noise && low <= bound - noise;
  return result === 'upper bound only (never PASS)' && high - noise <= bound && !couldMeasure;
}

export function overheadReport(samples: Sample[]) {
  const by = (kind: HoldsRun['kind'], mode: TraceMode) => samples.filter(s => s.kind === kind && s.mode === mode);
  const arms = { faultOn: by('fault', 'on'), faultOff: by('fault', 'off'), controlOn: by('control', 'on'), controlOff: by('control', 'off') };
  const spans = (on: Sample[], off: Sample[], endpoint: 'completionMs' | 'admissionMs') =>
    compare(on.map(s => s.timing?.[endpoint]), off.map(s => s.timing?.[endpoint]), timingBound);
  const timing = {
    fault: spans(arms.faultOn, arms.faultOff, 'completionMs'),
    finalAdmission: spans(arms.faultOn, arms.faultOff, 'admissionMs'),
    control: spans(arms.controlOn, arms.controlOff, 'completionMs'),
  };
  const counts = [...arms.faultOn, ...arms.controlOn].map(s => s.passCounts?.join(','));
  const equalCounts = counts.length === 2 * REPEATS && counts.every(count => count !== undefined && count === counts[0]);
  const rss = rssScreen(arms);
  const withinBounds = equalCounts && samples.every(s => !s.problems.length) && Object.values(timing).every(t => t?.within) &&
    rss.fault?.within === true && rss.control?.within === true && rss.verdict === 'stable';
  return { withinBounds, equalCounts, timing, rss, samples };
}
