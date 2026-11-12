import { positiveInteger } from './delivery.ts';

export type Step = { name: string; rate: number; seconds: number; startSeconds: number };
export function throughputPlan(rates: string | undefined, seconds: string | undefined, drainSeconds: number): Step[] {
  const duration = positiveInteger(seconds, 60);
  return (rates ?? '50,100,250,500,1000,2000,4000').split(',').map((rate, index) => ({
    name: `step_${index + 1}`, rate: positiveInteger(rate, 0), seconds: duration,
    startSeconds: index * (duration + drainSeconds + 1),
  }));
}

export function classifySend(status: number, retryAfter?: string): {
  outcome: 'accepted' | 'rejected429' | 'rejected503' | 'other'; invalidRetryAfter: boolean;
} {
  return { outcome: status >= 200 && status < 300 ? 'accepted' : status === 429 ? 'rejected429' : status === 503 ? 'rejected503' : 'other',
    invalidRetryAfter: (status === 429 || status === 503) && !/^[1-9]\d*$/.test(retryAfter ?? '') };
}

export function selectSender(index: number, members: number, channels: number) {
  return { member: index % members, channel: Math.floor(index / members) % channels };
}

type Metrics = Record<string, { values: Record<string, number> }>;
export function throughputReport(data: unknown, steps: Step[]) {
  const metrics = (data as { metrics: Metrics }).metrics;
  const value = (metric: string, step: Step, stat = 'count') =>
    metrics[`${metric}{scenario:${step.name}}`]?.values[stat] ?? null;
  const rows = steps.map(step => {
    const attempted = value('throughput_attempted', step) ?? 0;
    const accepted = value('throughput_accepted', step) ?? 0;
    const inWindow = value('throughput_accepted_in_window', step) ?? 0;
    const rejected429 = value('throughput_429', step) ?? 0;
    const rejected503 = value('throughput_503', step) ?? 0;
    const otherErrors = value('throughput_other', step) ?? 0;
    return { ...step, attempted, accepted, acceptedInWindow: inWindow, acceptedTail: accepted - inWindow,
      offeredSendsPerSecond: attempted / step.seconds,
      acceptedSendsPerSecond: inWindow / step.seconds,
      // Attribute the drain to this step too, so queued completions cannot inflate its rate.
      acceptedIncludingDrainPerSecond: accepted / Math.max(step.seconds, (value('throughput_completion_ms', step, 'max') ?? 0) / 1000),
      acceptedLatencyMs: Object.fromEntries(['med', 'p(95)', 'p(99)'].map(stat => [stat === 'med' ? 'p50' : stat === 'p(95)' ? 'p95' : 'p99', accepted ? value('throughput_accepted_ms', step, stat) : null])),
      rejected429, rejected429Rate: attempted ? rejected429 / attempted : null,
      rejected503, rejected503Rate: attempted ? rejected503 / attempted : null,
      otherErrors, otherErrorRate: attempted ? otherErrors / attempted : null,
      invalidRetryAfter: value('throughput_invalid_retry_after', step) ?? 0,
      retryAfterSeconds: { min: rejected429 + rejected503 ? value('throughput_retry_after', step, 'min') : null,
        max: rejected429 + rejected503 ? value('throughput_retry_after', step, 'max') : null },
      droppedIterations: value('dropped_iterations', step) ?? 0,
      incomplete: attempted - accepted - rejected429 - rejected503 - otherErrors,
    };
  });
  return { steps: rows, offered: rows.reduce((n, step) => n + step.attempted, 0),
    accepted: rows.reduce((n, step) => n + step.accepted, 0),
    duration: rows.reduce((n, step) => n + step.seconds, 0) };
}

export type ResourceSample = { at: string; rows: { Name: string; CPUPerc: string }[]; rss: unknown[] };
export function sampledCpuPeaks(samples: ResourceSample[], names: Record<string, string>): Record<string, number | null> {
  return Object.fromEntries(Object.entries(names).map(([role, name]) => {
    const values = samples.flatMap(sample => sample.rows.filter(row => row.Name === name)
      .map(row => Number.parseFloat(row.CPUPerc)).filter(Number.isFinite));
    return [role, values.length ? Math.max(...values) : null];
  }));
}
