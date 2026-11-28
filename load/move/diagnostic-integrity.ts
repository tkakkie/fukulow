import type { Measurement } from './judge.ts';
import { diagnosticCounters, type Stream } from './diagnostic-stream.ts';
import { moveInterval, type Plan, type Step } from './plan.ts';
import type { ReadLanes } from './diagnostic-mode.ts';
import { outcomes } from './metrics.ts';

export type DiagnosticLane = 'send' | 'move' | 'reader' | 'channels' | 'topics';
export type DiagnosticSummary = Measurement & { started?: number; scenarioDrops?: Record<string, number | null>; committedMoves?: number };
export type DiagnosticSelection = { readLanes: ReadLanes; readTimingSampleEvery: number | null; sendBreakdown?: boolean };

export function expectedDiagnosticLanes(step: Step, readLanes: ReadLanes): DiagnosticLane[] {
  return ['send', 'reader', ...(step.arm === 'move' ? ['move' as const] : []),
    ...(readLanes !== 'topics' ? ['channels' as const] : []), ...(readLanes !== 'channels' ? ['topics' as const] : [])];
}

export function laneScenarios(lane: DiagnosticLane, p: Plan) {
  return lane === 'topics' ? Array.from({ length: p.topicReaders }, (_, i) => `topic${i}`) : [lane];
}

export const laneSeconds = (p: Plan, lane: string) => p.seconds + (lane === 'reader' ? p.drain : 0);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const duration = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function usablePhase(timing: { count: number; p50: number | null; p95: number | null; p99: number | null; max: number | null } | undefined) {
  return Boolean(timing && count(timing.count) && timing.count > 0 &&
    [timing.p50, timing.p95, timing.p99, timing.max].every(duration));
}

export function diagnosticIntegrity(p: Plan, step: Step, readLanes: ReadLanes, summary: DiagnosticSummary | undefined,
  stream: Stream | undefined, moveTimed: boolean, explainedRead503: Partial<Record<DiagnosticLane, number>>) {
  if (!summary?.lanes) return ['missing workload summary'];
  const lanes = expectedDiagnosticLanes(step, readLanes);
  const problems: string[] = [];
  if (Object.keys(summary.lanes).length !== lanes.length || lanes.some(lane => !summary.lanes[lane])) problems.push('unexpected workload lanes');
  if (!duration(summary.started) || !summary.started) problems.push('missing workload start');
  const scenarios = lanes.flatMap(lane => laneScenarios(lane, p));
  if (!summary.scenarioDrops || Object.keys(summary.scenarioDrops).length !== scenarios.length ||
      scenarios.some(name => !Object.hasOwn(summary.scenarioDrops!, name))) problems.push('missing k6 drop counters');
  const readers = summary.topicReaders;
  if (!Array.isArray(readers) || readers.length !== (lanes.includes('topics') ? p.topicReaders : 0) ||
      readers.some((n, i) => !count(n) || n === 0 || n !== stream?.series[`topic${i}`]?.move_topic_reads?.sum) ||
      (lanes.includes('topics') && readers.reduce((sum, n) => sum + n, 0) !== summary.lanes.topics?.attempted))
    problems.push('Topic-list VUs or iteration counts');
  for (const lane of lanes) {
    const row = summary.lanes[lane];
    if (!row) continue;
    const names = laneScenarios(lane, p);
    const observed = (metric: string) => names.reduce((sum, name) => sum + (stream?.series[name]?.[metric]?.sum ?? 0), 0);
    const drops = names.map(name => summary.scenarioDrops?.[name]);
    // k6's existing thresholds materialize a real zero in the summary even when no drop point was emitted.
    const reconciledDrops = names.every((name, i) => {
      const fromStream = stream?.series[name]?.dropped_iterations;
      return count(drops[i]) && drops[i] === (fromStream?.sum ?? 0);
    });
    const scheduled = observed('iterations') + observed('dropped_iterations');
    const rate = lane === 'send' ? p.sendRate : lane === 'channels' ? p.channelRate : lane === 'reader' ? p.readerRate : 1 / moveInterval(step.size);
    const ideal = laneSeconds(p, lane) * rate;
    // The arrival timer starts at offset zero and races the duration timer at the final tick.
    // Allow the observed endpoint race (up to two extra ticks in the earlier D0 record).
    const scheduledInModel = lane === 'topics' ? row.droppedIterations === 0
      : scheduled >= Math.ceil(ideal) - 1 && scheduled <= Math.ceil(ideal) + 2;
    const series = stream?.series[lane];
    if (!stream || !reconciledDrops || !count(row.droppedIterations) || !scheduledInModel ||
        row.droppedIterations !== observed('dropped_iterations') || scheduled !== row.attempted + row.droppedIterations ||
        diagnosticCounters.some(name => !count(row[name]) || row[name] !== series?.[`move_${name}`]?.sum ||
          series?.[`move_${name}`]?.count !== row.attempted) ||
        row.attempted !== outcomes.reduce((sum, name) => sum + row[name], 0))
      problems.push(`${lane}: unreconciled k6 counters or schedule`);
    if (!count(row.accepted) || !row.accepted || series?.move_success_ms?.count !== row.accepted ||
        !duration(row.p95) || !duration(row.p99) || row.p99 < row.p95)
      problems.push(`${lane}: missing usable latency samples`);
    if ((lane === 'channels' || lane === 'topics' || lane === 'reader') &&
        (row.attempted - row.accepted !== row.rejected503 || row.rejected503 !== (explainedRead503[lane] ?? 0)))
      problems.push(`${lane}: unexplained read failures`);
  }
  if (step.arm === 'move' && (summary.moveVerified !== true || !count(summary.committedMoves) || summary.committedMoves === 0 ||
      summary.committedMoves !== summary.lanes.move?.accepted || !moveTimed))
    problems.push('missing verified committed Moves or Move timings');
  return problems;
}
