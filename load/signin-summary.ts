export type Attempt = { kind: 'wrong_known' | 'unknown' | 'correct' | 'organization_b'; status: number; ms: number };
export type Sample = { at: string; cpuPercent: number; rssKiB: number; rssAnonKiB: number; threads: number;
  connections: number; active: number };

export function resourceSample(at: string, cpu: string, status: string, connections: string): Sample {
  const field = (name: string, unit: string) => {
    const value = status.match(new RegExp(`^${name}:\\s+(\\d+)${unit}\\s*$`, 'm'))?.[1];
    if (value === undefined) throw new Error('Invalid resource sample');
    return Number(value);
  };
  const cpuValue = cpu.trim().match(/^(\d+(?:\.\d+)?)%$/)?.[1];
  const counts = connections.trim().match(/^(\d+)\|(\d+)$/);
  if (cpuValue === undefined || !counts) throw new Error('Invalid resource sample');
  const sample = {at, cpuPercent:Number(cpuValue), rssKiB:field('VmRSS', '\\s+kB'),
    rssAnonKiB:field('RssAnon', '\\s+kB'), threads:field('Threads', ''), connections:Number(counts[1]), active:Number(counts[2])};
  if (![sample.cpuPercent, sample.rssKiB, sample.rssAnonKiB, sample.threads, sample.connections, sample.active]
      .every(Number.isFinite)) throw new Error('Invalid resource sample');
  return sample;
}

// Nearest-rank percentiles; empty populations stay null (including pre-admission 503s).
export function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
  return { count: sorted.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) };
}
export function requests(attempts: readonly Attempt[]) {
  const successes = attempts.filter(a => a.status >= 200 && a.status < 300);
  const count = (status: number) => attempts.filter(a => a.status === status).length;
  return { total: attempts.length, success: successes.length,
    successRate: attempts.length ? successes.length / attempts.length : null,
    rejections: { passwordAdmission503: count(503), throttle429: count(429), unauthorized401: count(401),
      other: attempts.length - successes.length - count(503) - count(429) - count(401) },
    statusCounts: Object.fromEntries([...new Set(attempts.map(a => a.status))].sort((a,b) => a-b)
      .map(status => [status, count(status)])),
    latencyMs: distribution(attempts.map(a => a.ms)), successLatencyMs: distribution(successes.map(a => a.ms)),
    latencyByStatusMs: Object.fromEntries([...new Set(attempts.map(a => a.status))].map(status =>
      [status, distribution(attempts.filter(a => a.status === status).map(a => a.ms))])) };
}
export function summarize(attempts: readonly Attempt[], samples: readonly Sample[], postIdleSample: Sample | null = null) {
  const metric = (values: number[]) => ({ mean: values.length ? values.reduce((a,b) => a+b, 0) / values.length : null,
    peak: values.length ? Math.max(...values) : null });
  return { signin: requests(attempts.filter(a => a.kind !== 'organization_b')),
    byKind: Object.fromEntries(['wrong_known', 'unknown', 'correct', 'organization_b'].map(kind =>
      [kind, requests(attempts.filter(a => a.kind === kind))])),
    resources: { samples: samples.length, cpuPercent: metric(samples.map(s => s.cpuPercent)),
      rssKiB: metric(samples.map(s => s.rssKiB)), rssAnonKiB: metric(samples.map(s => s.rssAnonKiB)),
      threads: metric(samples.map(s => s.threads)), dbConnectionsInUse: metric(samples.map(s => s.connections)),
      dbActiveConnections: metric(samples.map(s => s.active)) }, postIdleSample };
}

export type Judgment = 'pass' | 'fail' | 'ambiguous';

export function judgePartA(summary: ReturnType<typeof summarize>, poolMaximum: number | null,
  poolAcquireTimeout: boolean | null) {
  const reads = summary.byKind.organization_b;
  const correct = summary.byKind.correct;
  const peak = summary.resources.dbConnectionsInUse.peak;
  const badStatus = Object.keys(summary.signin.statusCounts).some(status => ![200, 401, 429, 503].includes(Number(status)));
  const checks: Record<'A1' | 'A2' | 'A3' | 'A4', Judgment> = {
    A1: reads.successRate === null || reads.latencyMs.p95 === null ? 'ambiguous'
      : reads.successRate === 1 && reads.latencyMs.p95 <= 12.8 ? 'pass' : 'fail',
    A2: badStatus || poolAcquireTimeout === true ? 'fail'
      : summary.signin.total === 0 || poolAcquireTimeout === null ? 'ambiguous' : 'pass',
    A3: peak === null || poolMaximum === null ? 'ambiguous' : peak < poolMaximum ? 'pass' : 'fail',
    A4: correct.successRate === null ? 'ambiguous' : correct.successRate >= .75 &&
      correct.successLatencyMs.p95 !== null && correct.successLatencyMs.p95 <= 306 ? 'pass' : 'fail',
  };
  return { passed: Object.values(checks).every(check => check === 'pass'), checks, poolMaximum, poolAcquireTimeout };
}

export function poolAcquireTimeoutInLog(log: string): boolean | null {
  let observed = false;
  let incomplete = false;
  for (const line of log.split('\n')) {
    if (line.includes('database operation failed: pool timed out while waiting for an open connection')) return true;
    if (!line.trim()) continue;
    observed = true;
    if (!line.startsWith('{')) continue;
    try {
      const row = JSON.parse(line);
      const fields = row?.fields;
      if (row?.target === 'fukulow' && (
        (fields?.event === 'database_failure' && fields.kind === 'pool_timeout') ||
        (fields?.event === 'pool_stats' && fields.version === 1 && fields.acquire_timeout > 0)
      )) return true;
    } catch { incomplete = true; }
  }
  return observed && !incomplete ? false : null;
}
