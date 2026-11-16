import type { Ceiling, Observation, Proxy, Tls } from './proxy-judgment.ts';
import type { AppEvidence } from './app-evidence.ts';

export type RunResult = {
  exitCode: number; generatorExitCode?: number; tls?: Tls[]; measurementError?: string;
  /** load/scenario.ts provisioned every Account and Channel (`LOAD_SETUP_COMPLETE`). */
  setupComplete?: { sessions: number; accounts: number };
  /** load/app-evidence.ts aggregates for the generator window (proxy runs only). */
  appEvidence?: AppEvidence;
  cpuPeakPercent?: Record<string, number | null>;
  summary?: { metrics?: Record<string, { values: Record<string, number> }>; summaries?: {
    pathLabel: string; network: string; cache: string; timelineVisibleMs: { p50: number; p95: number }
  }[] };
  storm?: { allSubscribedMs: number };
  rate?: { offeredSendRate?: number; configuredSendRate?: number };
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

// Every step, including a k6 exit 99, needs offered-rate evidence: below 95% of the configured rate
// (or no evidence) the generator, not the proxy, set the limit, so the run is inconclusive, never a capacity result.
export function offeredShortfall(result: RunResult): string | undefined {
  const { offeredSendRate: offered, configuredSendRate: configured } = result.rate ?? {};
  if (!(typeof offered === 'number' && typeof configured === 'number' && configured > 0)) return 'missing offered send rate';
  return offered < configured * 0.95 ? `generator offered ${offered.toFixed(1)}/s, below 95% of ${configured}/s` : undefined;
}

// #469: where a failed connection step's limit was. A 1011 the client saw is app-side only if the app itself
// sent at least as many 1011 closes in the window; 'proxy' needs complete app evidence with no app-side failure.
// Anything else, including missing evidence or app failures not tied to the client's failure, is 'unknown'.
export function ceilingCause(result: RunResult): Pick<Ceiling, 'cause' | 'reasons'> {
  const evidence = result.appEvidence;
  if (!evidence) return { cause: 'unknown', reasons: ['missing app evidence'] };
  if (!evidence.complete) return { cause: 'unknown', reasons: evidence.reasons.map(reason => `incomplete app evidence: ${reason}`) };
  const client1011 = result.summary?.metrics?.['socket_closes{code:1011}']?.values.count;
  if (!Number.isSafeInteger(client1011)) return { cause: 'unknown', reasons: ['missing client close code counts'] };
  const app1011 = evidence.closes['1011'].count;
  const signals = [
    ...Object.entries(evidence.closes).filter(([code, close]) => code !== 'peer_or_transport' && code !== '1001' && close.count)
      .map(([code, close]) => `app sent ${close.count} closes with ${code}`),
    ...Object.entries(evidence.databaseFailures).filter(([, n]) => n).map(([kind, n]) => `database_failure ${kind}: ${n}`),
    ...(['acquire_timeout', 'acquire_closed', 'acquire_io', 'acquire_database', 'acquire_other'] as const)
      .filter(key => evidence.pool?.deltas[key]).map(key => `pool ${key}: ${evidence.pool!.deltas[key]}`),
    ...(evidence.pool?.acquireWaitsOver1s ? [`pool acquire waits over 1 s: ${evidence.pool.acquireWaitsOver1s}`] : []),
    ...(evidence.http5xx ? [`app HTTP 5xx: ${evidence.http5xx}`] : []),
  ];
  if (client1011! > app1011) return { cause: 'unknown', reasons: [`client saw ${client1011} closes with 1011, app sent ${app1011}`, ...signals] };
  if (client1011! > 0) return { cause: 'app', reasons: [...signals, ...(signals.some(signal => /database_failure|pool /.test(signal)) ? []
    : ['no database_failure or pool failure in the window: the app-side cause is not identified'])] };
  if (signals.length) return { cause: 'unknown', reasons: ['app-side failures present, but no client 1011 ties them to the failure', ...signals] };
  return { cause: 'proxy', reasons: ['complete app evidence shows no app-side failure'] };
}

// Highest passing step. Exit 99 (k6 thresholds, e.g. missing_deliveries) is capacity; anything else is a harness error.
export function stepMetric(proxy: Proxy, results: RunResult[], steps: number[], validate: (result: RunResult) => string | undefined = () => undefined,
  attributeCeiling = false): Metric {
  const first = results[0];
  const signature = (result: RunResult) => JSON.stringify(result.tls?.map(({ protocol, cipher }) => ({ protocol, cipher })));
  // A failed provisioning check also exits 99; only a run past setup can show a capacity limit.
  const capacityFailure = (result: RunResult) => result.generatorExitCode === 99 && !!result.setupComplete && !!result.summary &&
    !!result.resources?.length && !!result.measurementError?.startsWith('Error: Invalid measurement: generator exited with code 99; failed thresholds:');
  const errors = results.flatMap(result => {
    return [
      ...(!result.summary || !result.tls ? ['missing step evidence'] : []),
      ...(result.exitCode !== 0 && !capacityFailure(result) ? [result.measurementError || 'step harness failed'] : []),
      ...[validate(result)].filter((error): error is string => !!error),
      ...(signature(result) !== signature(first) ? ['TLS conditions changed between connection steps'] : []),
    ];
  });
  const passing = results.flatMap((result, i) => result.exitCode === 0 && !validate(result) ? [steps[i]] : []);
  const failed = results.findIndex(result => result.exitCode !== 0);
  const ceiling = attributeCeiling && failed >= 0 && capacityFailure(results[failed])
    ? { failedStep: steps[failed], ...ceilingCause(results[failed]) } : undefined;
  return { kind: 'step', observation: { proxy, value: Math.max(0, ...passing), tls: first?.tls ?? [], ...(ceiling ? { ceiling } : {}),
    generatorCpu: results.some(r => r.cpuPeakPercent?.generator == null) ? null : Math.max(...results.map(r => r.cpuPeakPercent!.generator!)),
    error: errors.length ? errors.join('; ') : undefined } };
}
