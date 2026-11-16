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
