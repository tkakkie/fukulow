// #469 part 3: sequential single-host comparison. No result is a default-proxy decision.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { abba, judge, type Proxy } from './proxy-judgment.ts';
import { metricsFor, offeredShortfall, stepMetric, type Metric, type RunResult } from './proxy-results.ts';
import { createCertificate, outsideCheckout } from './proxy-target.ts';

const preset = process.env.PROXY_PRESET ?? 'full';
assert.ok(['smoke', 'full'].includes(preset), 'PROXY_PRESET must be smoke or full');
const smoke = preset === 'smoke';
const repeats = Number(process.env.PROXY_RUNS ?? (smoke ? 1 : 5));
assert.ok(Number.isInteger(repeats) && repeats > 0 && (smoke || repeats === 5), 'full comparisons require five measured runs per proxy');
const selected = (process.env.PROXY_SCENARIOS ?? '1,2,3,4,5,6').split(',').map(Number);
assert.ok(selected.length && selected.every(n => Number.isInteger(n) && n >= 1 && n <= 6), 'PROXY_SCENARIOS must be comma-separated 1..6');
const scenarios = [...new Set(selected.flatMap(n => n === 6 ? [2, 3, 4] : [n]))];
const output = outsideCheckout(resolve(process.env.PROXY_RESULT_DIR ?? `${tmpdir()}/fukulow-proxy-${randomUUID()}`));
assert.ok(!existsSync(output) || readdirSync(output).length === 0, 'PROXY_RESULT_DIR must be a new or empty directory');
mkdirSync(output, { recursive: true });
assert.ok(process.env.LOAD_APP_IMAGE, 'Build one app image first and set LOAD_APP_IMAGE; every run must share it');
const collected: Record<string, { kind: Metric['kind']; rows: Metric['observation'][] }> = {};
const runs: { scenario: number; proxy: Proxy; warmup: boolean; directory: string; error?: string }[] = [];
const settings = {
  LOAD_LEGACY: '0', LOAD_ALLOW_REJECTIONS: '0', CHANNEL_VISIBILITY: 'public', THROUGHPUT_MEMBERS: '4', LOAD_NOFILE: '65536',
  LOAD_SEND_BURST: '1000000', LOAD_SEND_REFILL_PER_SECOND: '1000000',
  CHANNELS: '1', SUBSCRIBERS: smoke ? '4' : '1000', SOCKETS_PER_SESSION: '500',
  CONNECT_BATCH: '100', CONNECT_INTERVAL_MS: '100', READY_TIMEOUT_SECONDS: '120', DRAIN_TIMEOUT_SECONDS: '30',
  REQUEST_TIMEOUT_SECONDS: '45', PUBLISHERS: '1', PUBLISH_INTERVAL_MS: smoke ? '200' : '20',
  DURATION_SECONDS: smoke ? '3' : '60', LOAD_RECONNECT: '0', LOAD_RECONNECT_STORM: '0',
  LOAD_CONNECTIONS_ONLY: '0', LOAD_FIRST_PAINT: '0', LOAD_SCRIPT: 'load/scenario.ts',
  FIRST_PAINT_RUNS: smoke ? '1' : '10', FIRST_PAINT_WARMUP: smoke ? '1' : '12',
};
const stepSizes = (process.env.PROXY_CONNECTION_STEPS ?? (smoke ? '2,4' : '1000,2000,4000,6000,8000,10000')).split(',').map(Number);
assert.ok(stepSizes.every((n, i) => Number.isInteger(n) && n > 0 && (i === 0 || n > stepSizes[i - 1])), 'connection steps must increase');
if (!smoke) assert.deepEqual(stepSizes, [1000, 2000, 4000, 6000, 8000, 10000], 'full connection steps are fixed');
// Scenario 2: offered sends/s per step = PUBLISHERS * 1000 / PUBLISH_INTERVAL_MS, delivered to every subscriber.
const sendInterval = smoke ? 500 : 20;
const sendRates = smoke ? [2, 4] : [50, 100, 200, 400, 800];
const sendSettings = { CHANNELS: '4', SUBSCRIBERS: smoke ? '2' : '50', PUBLISH_INTERVAL_MS: String(sendInterval),
  DURATION_SECONDS: smoke ? '3' : '30', DRAIN_TIMEOUT_SECONDS: '15' };
const tlsDirectory = createCertificate();
function save() {
  writeFileSync(`${output}/summary.json`, JSON.stringify({ preset, purpose: smoke ? 'harness-validation' : 'comparison',
    gateEligible: !smoke && repeats === 5 && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Linux',
    repetitions: repeats, warmupsPerProxyPerScenario: 1, order: abba(repeats), scenarios, settings, stepSizes,
    resourceScope: 'sampled whole generator lifetime including provisioning and teardown; 100% CPU is one core',
    throughputDeliveryScope: 'load/scenario.ts steps: every offered send accepted (201) and delivered to every subscriber of its Channel within the drain; no unexpected close or gap',
    sendSettings, sendRates,
    runs, metrics: Object.fromEntries(Object.entries(collected).map(([name, metric]) => [name,
      { ...judge(metric.rows, metric.kind, name.startsWith('1/') || name.startsWith('2/')), observations: metric.rows }])) }, null, 2));
}
let active: ReturnType<typeof spawn> | undefined;
let interrupted = false;
const stop = () => { interrupted = true; process.exitCode = 1; active?.kill('SIGTERM'); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
async function record(directory: string, proxy: Proxy, extra: Record<string, string>): Promise<RunResult> {
  if (interrupted) throw new Error('Comparison interrupted');
  mkdirSync(directory, { recursive: true });
  const code = await new Promise<number>((done, reject) => {
    active = spawn(process.execPath, ['load/record.ts'], { env: { ...process.env, ...settings, ...extra,
      LOAD_PROXY: proxy, LOAD_TLS_DIR: tlsDirectory, LOAD_RESULT_DIR: directory }, stdio: ['ignore', 'inherit', 'inherit'] });
    active.on('error', reject); active.on('close', code => done(code ?? 1));
  });
  active = undefined;
  try { return JSON.parse(readFileSync(`${directory}/results.json`, 'utf8')); }
  catch { return { exitCode: code || 1, measurementError: 'runner did not produce results' }; }
}
async function run(scenario: number, proxy: Proxy, warmup: boolean) {
  const directory = `${output}/${runs.length + 1}-${scenario}-${proxy}-${warmup ? 'warmup' : 'measured'}`;
  const entry = { scenario, proxy, warmup, directory };
  runs.push(entry);
  console.log(`Proxy comparison: scenario ${scenario}, ${proxy}, ${warmup ? 'discarded warm-up' : 'measured'}; ${directory}`);
  let metrics: Record<string, Metric>;
  const stepped = async (sizes: number[], step: (size: number) => Record<string, string>, validate?: (r: RunResult) => string | undefined) => {
    const results: RunResult[] = [];
    for (const size of sizes) {
      const result = await record(`${directory}/step-${size}`, proxy, step(size));
      results.push(result);
      if (result.exitCode !== 0 || validate?.(result)) break;
    }
    const metric = stepMetric(proxy, results, sizes, validate);
    if (metric.observation.error) Object.assign(entry, { error: metric.observation.error });
    return { metric, results };
  };
  if (scenario === 1) {
    const { metric } = await stepped(stepSizes, sockets => ({ SUBSCRIBERS: String(sockets), LOAD_CONNECTIONS_ONLY: '1' }));
    metrics = { connections: metric };
  } else if (scenario === 2) {
    const { metric, results } = await stepped(sendRates, rate =>
      ({ ...sendSettings, PUBLISHERS: String(rate * sendInterval / 1000) }), offeredShortfall);
    Object.assign(entry, { steps: results.map((result, i) => ({ rate: sendRates[i], exitCode: result.exitCode,
      offeredSendRate: result.rate?.offeredSendRate, measurementError: result.measurementError,
      ...Object.fromEntries(['published_messages', 'delivered_messages', 'missing_deliveries'].map(name =>
        [name, result.summary?.metrics?.[name]?.values.count])),
      deliveryLatency: result.summary?.metrics?.delivery_latency?.values })) });
    // Proxy resources come from the highest passing step (the first step when none passed).
    const passed = results.filter((result, i) => sendRates[i] <= metric.observation.value && result.exitCode === 0);
    metrics = { throughput_sends_per_second: metric,
      ...metricsFor(proxy, 2, passed.at(-1) ?? results[0] ?? { exitCode: 1, measurementError: 'no throughput step ran' }) };
  } else {
    const extra: Record<string, string> = scenario === 4 ? { SUBSCRIBERS: smoke ? '4' : '5000', LOAD_RECONNECT_STORM: '1', DURATION_SECONDS: '3', PUBLISH_INTERVAL_MS: '500' }
      : scenario === 5 ? { LOAD_FIRST_PAINT: '1' } : {};
    const result = await record(directory, proxy, extra);
    metrics = metricsFor(proxy, scenario, result);
    if (result.exitCode !== 0) Object.assign(entry, { error: result.measurementError || 'runner failed' });
    // A missing report must be visible even if the cell list itself is absent.
    if (!Object.keys(metrics).length) metrics.missing = { kind: 'latency', observation: {
      proxy, value: NaN, tls: result.tls ?? [], generatorCpu: null, error: 'missing scenario metrics' } };
  }
  if (!warmup) for (const [name, metric] of Object.entries(metrics)) {
    const key = `${scenario}/${name}`;
    collected[key] ??= { kind: metric.kind, rows: [] };
    collected[key].rows.push(metric.observation);
  }
  save();
}
try {
  console.log(`Comparison artifacts: ${output}`);
  for (const scenario of scenarios) {
    for (const proxy of ['caddy', 'nginx'] as const) await run(scenario, proxy, true);
    for (const proxy of abba(repeats)) await run(scenario, proxy, false);
  }
  // Failure evidence stays available, but a harness error fails the dispatch.
  if (runs.some(run => run.error)) process.exitCode = 1;
} finally {
  try { save(); } finally {
    rmSync(tlsDirectory, { recursive: true, force: true });
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}
