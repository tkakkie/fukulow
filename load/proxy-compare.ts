// #469 part 3: sequential single-host comparison. No result is a default-proxy decision.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { abba, judge, type Proxy } from './proxy-judgment.ts';
import { connectionMetric, metricsFor, type Metric, type RunResult } from './proxy-results.ts';
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
const tlsDirectory = createCertificate();
function save() {
  writeFileSync(`${output}/summary.json`, JSON.stringify({ preset, purpose: smoke ? 'harness-validation' : 'comparison',
    gateEligible: !smoke && repeats === 5 && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Linux',
    repetitions: repeats, warmupsPerProxyPerScenario: 1, order: abba(repeats), scenarios, settings, stepSizes,
    resourceScope: 'sampled whole generator lifetime including provisioning and teardown; 100% CPU is one core',
    throughputDeliveryScope: 'existing #309 many: zero subscribers; acceptance and completion of every offered send',
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
  if (scenario === 1) {
    const results: RunResult[] = [];
    for (const sockets of stepSizes) {
      const result = await record(`${directory}/step-${sockets}`, proxy, { SUBSCRIBERS: String(sockets), LOAD_CONNECTIONS_ONLY: '1' });
      results.push(result);
      if (result.exitCode !== 0) break;
    }
    const metric = connectionMetric(proxy, results, stepSizes);
    if (metric.observation.error) Object.assign(entry, { error: metric.observation.error });
    metrics = { connections: metric };
  } else {
    const extra: Record<string, string> = scenario === 2 ? {
      LOAD_SCRIPT: 'load/throughput.ts', THROUGHPUT_SCENARIO: 'many', CHANNELS: '200',
      THROUGHPUT_RATES: smoke ? '2,4' : '50,100,250,500,1000,2000,4000', THROUGHPUT_STEP_SECONDS: smoke ? '3' : '60',
      THROUGHPUT_VUS: '20', THROUGHPUT_MAX_VUS: '100', REQUEST_TIMEOUT_SECONDS: '3',
    } : scenario === 4 ? { SUBSCRIBERS: smoke ? '4' : '5000', LOAD_RECONNECT_STORM: '1', DURATION_SECONDS: '3', PUBLISH_INTERVAL_MS: '500' }
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
