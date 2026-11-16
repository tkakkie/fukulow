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
test('throughput capacity requires ALL offered arrivals accepted and completed without drops', () => {
  const step = { rate: 50, seconds: 60, attempted: 3000, accepted: 3000, acceptedInWindow: 3000, droppedIterations: 0, incomplete: 0 };
  const capacity = (steps: NonNullable<RunResult['throughput']>['steps']) => metricsFor('nginx', 2, { exitCode: 0, throughput: { steps } }).throughput_sends_per_second.observation.value;
  assert.equal(capacity([step]), 50);
  for (const change of [{ attempted: 2999 }, { accepted: 2999 }, { droppedIterations: 1 }, { incomplete: 1 }]) {
    assert.equal(capacity([{ ...step, ...change }]), 0);
    assert.equal(capacity([step, { ...step, rate: 100, ...change }]), 50);
  }
  assert.equal(capacity([{ ...step, acceptedInWindow: 2999 }]), 50); // bounded drain remains part of the existing method
  assert.equal(capacity([{ ...step, attempted: 3001, accepted: 3001 }]), 50); // arrival boundary is not an invented count gate
  assert.equal(capacity([{ ...step, attempted: 0, accepted: 0, acceptedInWindow: 0 }]), 0);
  assert.equal(capacity([]), 0);
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
  const { connectionMetric } = await import('./proxy-results.ts');
  const ok: RunResult = { exitCode: 0, summary: {}, tls: [{ protocol: 'TLSv1.3', cipher: 'AES', alpn: 'http/1.1' }], cpuPeakPercent: { generator: 20 }, resources: [{ rows: [] }] };
  const capacity = { ...ok, exitCode: 1, generatorExitCode: 99, measurementError: 'Error: Invalid measurement: generator exited with code 99; failed thresholds: load_errors' };
  const metric = connectionMetric('caddy', [ok, capacity], [1000,2000]);
  assert.equal(metric.observation.value, 1000);
  assert.equal(metric.observation.error, undefined);
  assert.ok(connectionMetric('caddy', [ok, { ...capacity, measurementError: 'SQL snapshot failed' }], [1000,2000]).observation.error);
  assert.ok(connectionMetric('caddy', [ok, { ...capacity, generatorExitCode: 1 }], [1000,2000]).observation.error);
  assert.ok(connectionMetric('caddy', [ok, { ...ok, tls: [] }], [1000,2000]).observation.error);
  assert.equal(connectionMetric('caddy', [{ ...ok, cpuPeakPercent: {} }], [1000]).observation.generatorCpu, null);
});
