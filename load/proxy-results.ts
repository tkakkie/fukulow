import type { Observation, Proxy, Tls } from './proxy-judgment.ts';

export type RunResult = {
  exitCode: number; generatorExitCode?: number; tls?: Tls[]; measurementError?: string;
  cpuPeakPercent?: Record<string, number | null>;
  summary?: { metrics?: Record<string, { values: Record<string, number> }>; summaries?: {
    pathLabel: string; network: string; cache: string; timelineVisibleMs: { p50: number; p95: number }
  }[] };
  storm?: { allSubscribedMs: number };
  resources?: { rows: { Name: string; CPUPerc: string; MemUsage: string }[] }[];
  throughput?: { steps: { rate: number; seconds: number; attempted: number; accepted: number;
    acceptedInWindow: number; droppedIterations: number; incomplete: number }[] };
};
export type Metric = { kind: 'latency' | 'step' | 'descriptive'; observation: Observation };
export function memoryBytes(text: string): number {
  const match = text.match(/^([\d.]+)\s*(B|KiB|MiB|GiB|kB|MB|GB)\b/);
  if (!match) return NaN;
  return Number(match[1]) * ({ B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, kB: 1000, MB: 1e6, GB: 1e9 }[match[2]] ?? NaN);
}
export function metricsFor(proxy: Proxy, scenario: number, result: RunResult): Record<string, Metric> {
  const metrics: Record<string, Metric> = {};
  const add = (name: string, value: number | undefined, kind: Metric['kind']) => {
    metrics[name] = { kind, observation: { proxy, value: value ?? NaN, tls: result.tls ?? [],
      generatorCpu: result.cpuPeakPercent?.generator ?? null,
      error: result.exitCode !== 0 ? result.measurementError || 'runner failed' : undefined } };
  };
  if (scenario === 2) {
    const passing = result.throughput?.steps.filter(step => step.attempted > 0 &&
      step.accepted === step.attempted && step.droppedIterations === 0 && step.incomplete === 0);
    add('throughput_sends_per_second', Math.max(0, ...passing?.map(step => step.rate) ?? []), 'step');
  }
  if (scenario === 3) for (const name of ['delivery_latency', 'publish_http_response_time']) {
    for (const percentile of ['p(95)', 'p(99)']) add(`${name}_${percentile}`, result.summary?.metrics?.[name]?.values[percentile], 'latency');
  }
  if (scenario === 4) add('all_subscriptions_recovered_ms', result.storm?.allSubscribedMs, 'descriptive');
  if (scenario === 5) for (const path of ['/', '/o/:org/c/:channel']) {
    for (const network of ['unthrottled', 'throttled']) for (const cache of ['cold', 'warm']) {
      const cell = result.summary?.summaries?.find(cell => cell.pathLabel === path && cell.network === network && cell.cache === cache);
      for (const percentile of ['p50', 'p95'] as const)
        add(`timeline_visible_${path}_${network}_${cache}_${percentile}`, cell?.timelineVisibleMs[percentile], 'latency');
    }
  }
  if ([2, 3, 4].includes(scenario)) {
    const samples = result.resources?.flatMap(sample => sample.rows.filter(row => /-proxy-1$/.test(row.Name))) ?? [];
    for (const [name, values] of [ ['proxy_cpu_percent', samples.map(row => Number.parseFloat(row.CPUPerc))],
      ['proxy_memory_bytes', samples.map(row => memoryBytes(row.MemUsage))] ] as const) {
      add(`${name}_mean`, values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined, 'descriptive');
      add(`${name}_peak`, values.length ? Math.max(...values) : undefined, 'descriptive');
    }
  }
  return metrics;
}

export function connectionMetric(proxy: Proxy, results: RunResult[], steps: number[]): Metric {
  const first = results[0];
  const signature = (result: RunResult) => JSON.stringify(result.tls?.map(({ protocol, cipher }) => ({ protocol, cipher })));
  const errors = results.flatMap(result => {
    const capacityFailure = result.generatorExitCode === 99 && result.summary && result.resources?.length &&
      result.measurementError?.startsWith('Error: Invalid measurement: generator exited with code 99; failed thresholds:');
    return [
      ...(!result.summary || !result.tls ? ['missing step evidence'] : []),
      ...(result.exitCode !== 0 && !capacityFailure ? [result.measurementError || 'step harness failed'] : []),
      ...(signature(result) !== signature(first) ? ['TLS conditions changed between connection steps'] : []),
    ];
  });
  const passing = results.flatMap((result, i) => result.exitCode === 0 ? [steps[i]] : []);
  return { kind: 'step', observation: { proxy, value: Math.max(0, ...passing), tls: first?.tls ?? [],
    generatorCpu: results.some(r => r.cpuPeakPercent?.generator == null) ? null : Math.max(...results.map(r => r.cpuPeakPercent!.generator!)),
    error: errors.length ? errors.join('; ') : undefined } };
}
