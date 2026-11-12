export type Attempt = { kind: 'wrong_known' | 'unknown' | 'correct' | 'organization_b'; status: number; ms: number };
export type Sample = { at: string; cpuPercent: number; rssKiB: number; connections: number; active: number };

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
export function summarize(attempts: readonly Attempt[], samples: readonly Sample[]) {
  const metric = (values: number[]) => ({ mean: values.length ? values.reduce((a,b) => a+b, 0) / values.length : null,
    peak: values.length ? Math.max(...values) : null });
  return { signin: requests(attempts.filter(a => a.kind !== 'organization_b')),
    byKind: Object.fromEntries(['wrong_known', 'unknown', 'correct', 'organization_b'].map(kind =>
      [kind, requests(attempts.filter(a => a.kind === kind))])),
    resources: { samples: samples.length, cpuPercent: metric(samples.map(s => s.cpuPercent)),
      rssKiB: metric(samples.map(s => s.rssKiB)), dbConnectionsInUse: metric(samples.map(s => s.connections)),
      dbActiveConnections: metric(samples.map(s => s.active)) } };
}
