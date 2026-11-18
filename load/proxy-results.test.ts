import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryBytes, metricsFor, type RunResult } from './proxy-results.ts';
import { judge } from './proxy-judgment.ts';
test('memory parsing uses actual Docker units, rejects missing/unknown values', () => {
  assert.equal(memoryBytes('1.5MiB / 1GiB'), 1.5 * 1024 ** 2);
  assert.equal(memoryBytes('2GiB / 4GiB'), 2 * 1024 ** 3);
  assert.equal(memoryBytes('300kB / 4GB'), 300000);
  assert.ok(Number.isNaN(memoryBytes('unknown')));
});
test('throughput steps pass only with every send delivered at the offered rate', async () => {
  const { stepMetric, offeredShortfall } = await import('./proxy-results.ts');
  const ok: RunResult = { exitCode: 0, summary: {}, tls: [{ protocol: 'TLSv1.3', cipher: 'AES', alpn: 'http/1.1' }],
    cpuPeakPercent: { generator: 20 }, resources: [{ rows: [] }], rate: { offeredSendRate: 99.9, configuredSendRate: 100 },
    setupComplete: { sessions: 7, accounts: 7 } };
  // Every send accepted (201) but one delivery missing: scenario.ts exits 99 on missing_deliveries, so the step fails.
  const undelivered = { ...ok, exitCode: 1, generatorExitCode: 99,
    measurementError: 'Error: Invalid measurement: generator exited with code 99; failed thresholds: missing_deliveries, checks' };
  const capacity = (results: RunResult[]) => stepMetric('nginx', results, [50, 100], offeredShortfall).observation;
  assert.deepEqual([capacity([ok, ok]).value, capacity([ok, ok]).error], [100, undefined]);
  assert.deepEqual([capacity([ok, undelivered]).value, capacity([ok, undelivered]).error], [50, undefined]);
  assert.equal(capacity([undelivered]).value, 0);
  // Below 95% of the configured rate the generator, not the proxy, set the limit: invalid, not a pass.
  const short = capacity([ok, { ...ok, rate: { offeredSendRate: 94, configuredSendRate: 100 } }]);
  assert.equal(short.value, 50); assert.match(short.error ?? '', /below 95% of 100\/s/);
  assert.match(capacity([{ ...ok, rate: undefined }]).error ?? '', /missing offered send rate/);
  assert.equal(capacity([{ ...ok, rate: { offeredSendRate: 95, configuredSendRate: 100 } }]).value, 50);
  assert.ok(capacity([ok, { ...undelivered, generatorExitCode: 1 }]).error);
  // A provisioning failure (invite, sign-in, Channel access) also exits 99: invalid, never a capacity limit.
  assert.ok(capacity([ok, { ...undelivered, setupComplete: undefined }]).error);
  // An exit 99 counts as capacity only with the offered rate proven; otherwise the run is inconclusive.
  for (const rate of [{ offeredSendRate: 90, configuredSendRate: 100 }, undefined]) {
    const run = capacity([ok, { ...undelivered, rate }]);
    assert.ok(run.error); assert.equal(judge([...Array(5)].map(() => run), 'step').verdict, 'inconclusive');
  }
});
test('latency, recovery and every first-display cell propagate missing evidence', () => {
  const result: RunResult = { exitCode: 0, summary: { metrics: { delivery_latency: { values: { 'p(95)': 12, 'p(99)': 15 } } } }, storm: { allSubscribedMs: 100 } };
  const latency = metricsFor('caddy', 3, result);
  assert.equal(latency['delivery_latency_p(95)'].observation.value, 12);
  assert.ok(Number.isNaN(latency['publish_http_response_time_p(99)'].observation.value));
  assert.equal(metricsFor('nginx', 4, result).all_subscriptions_recovered_ms.observation.value, 100);
  const display = metricsFor('caddy', 5, { exitCode: 0 });
  assert.equal(Object.keys(display).length, 16);
  assert.ok(Object.values(display).every(metric => Number.isNaN(metric.observation.value)));
  assert.equal(judge(Object.values(display).map(m => m.observation), 'latency').verdict, 'inconclusive');
});
test('proxy samples exclude app/generator, report mean/peak and retain failed-run reason', () => {
  const result: RunResult = { exitCode: 1, measurementError: 'failed', resources: [
    { rows: [{ Name: 'x-app-1', CPUPerc: '100%', MemUsage: '100MiB' },
      { Name: 'x-proxy-1', CPUPerc: '10%', MemUsage: '1MiB / 1GiB' }] },
    { rows: [{ Name: 'x-proxy-1', CPUPerc: '30%', MemUsage: '3MiB / 1GiB' }] },
  ] };
  const metrics = metricsFor('nginx', 3, result);
  assert.equal(metrics.proxy_cpu_percent_mean.observation.value, 20);
  assert.equal(metrics.proxy_cpu_percent_peak.observation.value, 30);
  assert.equal(metrics.proxy_memory_bytes_mean.observation.value, 2 * 1024 ** 2);
  assert.equal(metrics.proxy_memory_bytes_peak.observation.value, 3 * 1024 ** 2);
  assert.equal(metrics.proxy_cpu_percent_mean.observation.error, 'failed');
});

test('connection capacity failures are distinct from instrumentation/setup failures and TLS drift', async () => {
  const { stepMetric: connectionMetric } = await import('./proxy-results.ts');
  const ok: RunResult = { exitCode: 0, summary: {}, tls: [{ protocol: 'TLSv1.3', cipher: 'AES', alpn: 'http/1.1' }], cpuPeakPercent: { generator: 20 }, resources: [{ rows: [] }],
    setupComplete: { sessions: 63, accounts: 63 } };
  const capacity = { ...ok, exitCode: 1, generatorExitCode: 99, measurementError: 'Error: Invalid measurement: generator exited with code 99; failed thresholds: load_errors' };
  const metric = connectionMetric('caddy', [ok, capacity], [1000,2000]);
  assert.equal(metric.observation.value, 1000);
  assert.equal(metric.observation.error, undefined);
  assert.ok(connectionMetric('caddy', [ok, { ...capacity, measurementError: 'SQL snapshot failed' }], [1000,2000]).observation.error);
  assert.ok(connectionMetric('caddy', [ok, { ...capacity, generatorExitCode: 1 }], [1000,2000]).observation.error);
  // Exit 99 from a failed invite/sign-in/Channel-access check during provisioning is a setup failure.
  assert.ok(connectionMetric('caddy', [ok, { ...capacity, setupComplete: undefined }], [1000,2000]).observation.error);
  assert.ok(connectionMetric('caddy', [ok, { ...ok, tls: [] }], [1000,2000]).observation.error);
  assert.equal(connectionMetric('caddy', [{ ...ok, cpuPeakPercent: {} }], [1000]).observation.generatorCpu, null);
});

test('a make-converted exit 2 is never a capacity result', async () => {
  const { stepMetric } = await import('./proxy-results.ts');
  const ok: RunResult = { exitCode: 0, summary: {}, tls: [{ protocol: 'TLSv1.3', cipher: 'AES', alpn: 'http/1.1' }], cpuPeakPercent: { generator: 20 },
    resources: [{ rows: [] }], setupComplete: { sessions: 63, accounts: 63 } };
  const made = { ...ok, exitCode: 1, generatorExitCode: 2, measurementError: 'Error: Invalid measurement: generator exited with code 2; failed thresholds: load_errors' };
  assert.match(stepMetric('caddy', [ok, made], [1000, 2000]).observation.error ?? '', /code 2/);
});

test('connection ceilings are attributed to the app, the proxy or unknown from app-side evidence', async () => {
  const { ceilingCause, stepMetric } = await import('./proxy-results.ts');
  const { appEvidence } = await import('./app-evidence.ts');
  const clean = appEvidence(Array.from({ length: 4 }, (_, i) => JSON.stringify({ timestamp: new Date(i * 1000).toISOString(), target: 'fukulow',
    fields: { event: 'pool_stats', sample_sequence: i + 1, in_use: 0, idle: 20, waiting: 0, acquire_success: 0, acquire_timeout: 0, acquire_closed: 0,
      acquire_io: 0, acquire_database: 0, acquire_other: 0, acquire_cancelled: 0, wait_le_1000000_us: 0, wait_count: 0 } })).join('\n'), 500, 2500);
  assert.equal(clean.complete, true);
  const app1011 = (count: number) => ({ ...clean, closes: { ...clean.closes, '1011': { count, firstMs: 0, lastMs: 0, perSecond: [] } } });
  const client = (count: number): RunResult['summary'] => ({ metrics: { 'socket_closes{code:1011}': { values: { count } } } });
  const failures = { ...clean.databaseFailures, pool_timeout: 4 };
  const proxyLog = (errorLines: number, complete = true) => ({ complete, reasons: [], levels: { error: errorLines }, errorLines });
  const cause = (summary: RunResult['summary'], appEvidence?: RunResult['appEvidence'], proxyEvidence: RunResult['proxyEvidence'] = proxyLog(0)) =>
    ceilingCause({ exitCode: 1, summary, appEvidence, proxyEvidence }, 2000);
  // Every client 1011 was sent by the app, with the database cause.
  assert.deepEqual(cause(client(499), { ...app1011(499), databaseFailures: failures }),
    { cause: 'app', reasons: ['app sent 499 closes with 1011', 'database_failure pool_timeout: 4'] });
  // App 1011 without a database failure is still app-side, with the cause left unidentified.
  assert.match(cause(client(3), app1011(3)).reasons.join(), /app-side cause is not identified/);
  assert.equal(cause(client(3), app1011(3)).cause, 'app');
  // More client 1011s than the app sent: some did not come from the app.
  assert.equal(cause(client(5), app1011(3)).cause, 'unknown');
  // App-side failures that no client 1011 ties to the failure are not decided either way.
  assert.equal(cause(client(0), { ...clean, databaseFailures: failures }).cause, 'unknown');
  // Missing or incomplete evidence is unknown, never the proxy.
  assert.equal(cause(client(0)).cause, 'unknown');
  assert.equal(cause(client(0), { ...clean, complete: false, reasons: ['missing pool_stats'] }).cause, 'unknown');
  assert.equal(cause({ metrics: {} }, clean).cause, 'unknown');
  // The proxy is named only with positive evidence: its own error-level log lines while the app logged no failure.
  assert.deepEqual(cause(client(0), clean, proxyLog(3)),
    { cause: 'proxy', reasons: ['proxy logged 3 error-level lines with no app-side failure', 'app opened 0 of 2000 requested sockets'] });
  // No failure logged on either side is not proxy evidence: an app limit can leave none.
  assert.equal(cause(client(0), clean, proxyLog(0)).cause, 'unknown');
  assert.equal(cause(client(0), clean, proxyLog(3, false)).cause, 'unknown');
  assert.equal(cause(client(0), clean, undefined).cause, 'unknown');
  // Proxy errors never override app-side failures, including server-sent 1001 and other app warnings.
  assert.equal(cause(client(0), { ...clean, closes: { ...clean.closes, '1001': { count: 2, firstMs: 0, lastMs: 0, perSecond: [] } } }, proxyLog(3)).cause, 'unknown');
  assert.equal(cause(client(0), { ...clean, otherWarnings: { work_deadline_expired: 1 } }, proxyLog(3)).cause, 'unknown');
  // A panic (no timestamp, counted over the whole log) is an app-side signal, never a proxy limit.
  assert.equal(cause(client(0), { ...clean, panics: 1 }).cause, 'unknown');

  const ok: RunResult = { exitCode: 0, summary: {}, tls: [{ protocol: 'TLSv1.3', cipher: 'AES', alpn: 'http/1.1' }], cpuPeakPercent: { generator: 20 },
    resources: [{ rows: [] }], setupComplete: { sessions: 63, accounts: 63 } };
  const capacity: RunResult = { ...ok, exitCode: 1, generatorExitCode: 99, summary: client(499), appEvidence: { ...app1011(499), databaseFailures: failures },
    measurementError: 'Error: Invalid measurement: generator exited with code 99; failed thresholds: load_errors' };
  const observation = stepMetric('caddy', [ok, capacity], [1000, 2000], undefined, true).observation;
  assert.deepEqual([observation.value, observation.error, observation.ceiling?.failedStep, observation.ceiling?.cause], [1000, undefined, 2000, 'app']);
  // Throughput ladders and passing ladders carry no ceiling.
  assert.equal(stepMetric('caddy', [ok, capacity], [1000, 2000]).observation.ceiling, undefined);
  assert.equal(stepMetric('caddy', [ok, ok], [1000, 2000], undefined, true).observation.ceiling, undefined);
});
