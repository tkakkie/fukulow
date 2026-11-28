import { outcomes } from './metrics.ts';

export const diagnosticScenarios = ['send', 'move', 'reader', 'channels', 'topic0', 'topic1', 'topic2', 'topic3'] as const;
export const diagnosticCounters = ['attempted', ...outcomes] as const;
const metrics = ['move_scenario_start_ms', 'move_topic_reads', 'move_success_ms', 'dropped_iterations',
  'http_reqs', 'iterations', 'iteration_duration', ...diagnosticCounters.map(name => `move_${name}`)];
const measured = new RegExp(`"metric"\\s*:\\s*"(${metrics.join('|')})"`);

export function timestamp(value: unknown) {
  if (typeof value !== 'string') return NaN;
  const fraction = /\.\d{3}(\d+)Z$/.exec(value)?.[1];
  return Date.parse(value) + (fraction ? Number(`0.${fraction}`) : 0);
}

type Points = { count: number; sum: number; first: number; last: number };
export type Stream = { series: Record<string, Record<string, Points>>; invalidPoints: number;
  latencies: Record<string, { p95: number; p99: number }> };

function percentile(sorted: number[], fraction: 0.95 | 0.99, fusedRank: boolean) {
  // k6 TrendSink.P uses linear interpolation between adjacent ranks.
  const span = sorted.length - 1;
  const rank = fraction * span;
  const lower = Math.floor(rank);
  // ARM64 Go fuses fraction * span - lower. Both fractions are exact multiples of 2^-53.
  const scale = 2 ** 53;
  const weight = fusedRank
    ? Number(BigInt(fraction * scale) * BigInt(span) - BigInt(lower) * BigInt(scale)) / scale
    : rank - lower;
  return sorted[lower] + (sorted[Math.ceil(rank)] - sorted[lower]) * weight;
}

export function diagnosticStream(fusedRank: boolean) {
  const result: Stream = { series: {}, invalidPoints: 0, latencies: {} };
  const latencySamples: Record<string, number[]> = {};
  return { finish() {
    for (const [lane, samples] of Object.entries(latencySamples)) {
      samples.sort((a, b) => a - b);
      result.latencies[lane] = { p95: percentile(samples, 0.95, fusedRank), p99: percentile(samples, 0.99, fusedRank) };
    }
    return result;
  }, add(line: string) {
    if (!measured.test(line)) return;
    const { type, metric, data } = JSON.parse(line);
    if (type === 'Metric') return;
    const { scenario, status } = data?.tags ?? {};
    const at = timestamp(data?.time);
    const value = data?.value;
    const validValue = Number.isFinite(value) && value >= 0 &&
      (metric === 'move_success_ms' || metric === 'iteration_duration' || Number.isSafeInteger(value));
    if (type !== 'Point' || !Number.isFinite(at) || !validValue ||
        !(diagnosticScenarios.some(name => name === scenario) || scenario === 'topics') ||
        (metric === 'http_reqs' && (typeof status !== 'string' || !/^\d{1,3}$/.test(status))) ||
        (metric === 'iteration_duration' && value === 0)) {
      result.invalidPoints++;
      return;
    }
    if (metric === 'move_success_ms') (latencySamples[scenario] ??= []).push(value);
    const key = metric === 'http_reqs' ? `http_${status}` : metric;
    const series = result.series[scenario] ??= {};
    const points = series[key] ??= { count: 0, sum: 0, first: at, last: at };
    points.count++;
    points.sum += value;
    points.first = Math.min(points.first, at);
    points.last = Math.max(points.last, at);
  } };
}
