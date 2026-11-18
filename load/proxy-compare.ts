// #469 part 3: sequential single-host comparison. No result is a default-proxy decision.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { abba, judge, type Proxy } from './proxy-judgment.ts';
import { metricsFor, offeredShortfall, stepMetric, type Metric, type RunResult } from './proxy-results.ts';
import { createCertificate, outsideCheckout } from './proxy-target.ts';
import { deadlineSkip, dockerCleanup, jobDeadlineMs, runBudgetMs, runBounded, timeoutReason } from './proxy-run.ts';
import { accountAllocation, accountCount } from './scheduler.ts';

const preset = process.env.PROXY_PRESET ?? 'full';
assert.ok(['smoke', 'preflight', 'full'].includes(preset), 'PROXY_PRESET must be smoke, preflight or full');
const smoke = preset === 'smoke';
// #469 C: full-size settings, one discarded warm-up per proxy per scenario, nothing measured; stops at the first failure.
const preflight = preset === 'preflight';
const repeats = preflight ? 0 : Number(process.env.PROXY_RUNS ?? (smoke ? 1 : 5));
assert.ok(preflight || (Number.isInteger(repeats) && repeats > 0 && (smoke || repeats === 5)), 'full comparisons require five measured runs per proxy');
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
  CHANNELS: '1', SUBSCRIBERS: smoke ? '4' : '1000',
  // #469 A: separate Accounts within the product's per-Account socket cap (#196 A, 32; not changed here).
  // Smoke uses 2 so its few sockets still exercise more than one invited Account.
  SOCKETS_PER_ACCOUNT: smoke ? '2' : '32', SOCKETS_PER_SESSION: smoke ? '2' : '32',
  CONNECT_BATCH: '100', CONNECT_INTERVAL_MS: '100', READY_TIMEOUT_SECONDS: '120', DRAIN_TIMEOUT_SECONDS: '30',
  REQUEST_TIMEOUT_SECONDS: '45', PUBLISHERS: '1', PUBLISH_MEMBERS: '1', PUBLISH_INTERVAL_MS: smoke ? '200' : '20',
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
const socketsPerAccount = Number(settings.SOCKETS_PER_ACCOUNT);
const tlsDirectory = createCertificate();
function save() {
  writeFileSync(`${output}/summary.json`, JSON.stringify({ preset,
    purpose: smoke ? 'harness-validation' : preflight ? 'full-size preflight; never a measured run' : 'comparison',
    gateEligible: preset === 'full' && repeats === 5 && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Linux',
    repetitions: repeats, warmupsPerProxyPerScenario: 1, order: preflight ? [] : abba(repeats), scenarios, settings, stepSizes,
    accounts: { socketsPerAccount, allocation: accountAllocation, sameForBothProxies: true },
    hardTimeout: 'per record run: k6 setup + scenario + teardown limits + Compose allowance; on expiry SIGTERM, SIGKILL after grace, Docker cleanup, run invalid',
    jobDeadline: jobDeadline === undefined ? null : { at: new Date(jobDeadline).toISOString(),
      rule: 'a run whose budget + grace would end after the job limit minus a reserve is not started and is invalid' },
    resourceScope: 'sampled whole generator lifetime including provisioning and teardown; 100% CPU is one core',
    throughputDeliveryScope: 'load/scenario.ts steps: every offered send accepted (201) and delivered to every subscriber of its Channel within the drain; no unexpected close or gap',
    sendSettings, sendRates,
    runs, conditions, metrics: Object.fromEntries(Object.entries(collected).map(([name, metric]) => [name,
      { ...judge(metric.rows, metric.kind, name.startsWith('1/') || name.startsWith('2/')), observations: metric.rows }])) }, null, 2));
}
let stopActive: (() => void) | undefined;
let interrupted = false;
const stop = () => { interrupted = true; process.exitCode = 1; stopActive?.(); };
const graceMs = 180_000;
const jobDeadline = jobDeadlineMs(process.env);
process.on('SIGINT', stop); process.on('SIGTERM', stop);
async function record(directory: string, proxy: Proxy, extra: Record<string, string>): Promise<RunResult> {
  if (interrupted) throw new Error('Comparison interrupted');
  mkdirSync(directory, { recursive: true });
  const project = `fukulow-load-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const env = { ...process.env, ...settings, ...extra, LOAD_PROJECT_NAME: project,
    LOAD_PROXY: proxy, LOAD_TLS_DIR: tlsDirectory, LOAD_RESULT_DIR: directory };
  const budgetMs = runBudgetMs(env);
  const accounts = env.LOAD_FIRST_PAINT === '1' ? undefined
    : accountCount(Number(env.CHANNELS) * Number(env.SUBSCRIBERS), socketsPerAccount);
  const skipped = deadlineSkip(Date.now(), budgetMs, graceMs, jobDeadline);
  if (skipped) {
    conditions.push({ directory, accounts, socketsPerAccount: accounts === undefined ? undefined : socketsPerAccount,
      budgetSeconds: budgetMs / 1000, elapsedSeconds: 0, timedOut: false, skipped });
    return { exitCode: 1, measurementError: skipped };
  }
  const bounded = await runBounded({ command: process.execPath, args: ['load/record.ts'], env, timeoutMs: budgetMs, graceMs,
    cleanup: () => dockerCleanup(project), onStart: terminate => { stopActive = terminate; } });
  stopActive = undefined;
  const reason = timeoutReason(bounded, budgetMs);
  let result: RunResult;
  try { result = JSON.parse(readFileSync(`${directory}/results.json`, 'utf8')); }
  catch { result = { exitCode: bounded.code || 1, measurementError: 'runner did not produce results' }; }
  if (reason) result = { ...result, exitCode: result.exitCode || 1, measurementError: [reason, result.measurementError].filter(Boolean).join('; ') };
  // results.json is written before teardown: a later failure (cleanup, signal) still invalidates the run.
  else if (bounded.code !== 0 && result.exitCode === 0) result = { ...result, exitCode: bounded.code,
    measurementError: `record runner exited ${bounded.code} after writing results (teardown or signal)` };
  conditions.push({ directory, accounts, socketsPerAccount: accounts === undefined ? undefined : socketsPerAccount,
    budgetSeconds: budgetMs / 1000, elapsedSeconds: Math.round(bounded.elapsedMs / 1000), timedOut: bounded.timedOut });
  return result;
}
const conditions: { directory: string; accounts?: number; socketsPerAccount?: number; budgetSeconds: number; elapsedSeconds: number; timedOut: boolean; skipped?: string }[] = [];
async function run(scenario: number, proxy: Proxy, warmup: boolean) {
  const directory = `${output}/${runs.length + 1}-${scenario}-${proxy}-${warmup ? 'warmup' : 'measured'}`;
  const entry: (typeof runs)[number] = { scenario, proxy, warmup, directory };
  runs.push(entry);
  console.log(`Proxy comparison: scenario ${scenario}, ${proxy}, ${warmup ? 'discarded warm-up' : 'measured'}; ${directory}`);
  let metrics: Record<string, Metric>;
  const stepped = async (sizes: number[], step: (size: number) => Record<string, string>, validate?: (r: RunResult) => string | undefined,
    attributeCeiling = false) => {
    const results: RunResult[] = [];
    for (const size of sizes) {
      const result = await record(`${directory}/step-${size}`, proxy, step(size));
      results.push(result);
      if (result.exitCode !== 0 || validate?.(result)) break;
    }
    const metric = stepMetric(proxy, results, sizes, validate, attributeCeiling);
    if (metric.observation.error) Object.assign(entry, { error: metric.observation.error });
    return { metric, results };
  };
  if (scenario === 1) {
    const { metric, results } = await stepped(stepSizes, sockets => ({ SUBSCRIBERS: String(sockets), LOAD_CONNECTIONS_ONLY: '1' }), undefined, true);
    // #469: app-side evidence per connection step; aggregates only (load/app-evidence.ts).
    Object.assign(entry, { ceiling: metric.observation.ceiling, steps: results.map((result, i) => ({ sockets: stepSizes[i],
      exitCode: result.exitCode, generatorExitCode: result.generatorExitCode, measurementError: result.measurementError,
      clientCloses: Object.fromEntries(Object.entries(result.summary?.metrics ?? {}).flatMap(([name, metric]) => {
        const code = name.match(/^socket_closes\{code:(\d+)\}$/)?.[1];
        return code ? [[code, metric.values.count]] : [];
      })), appEvidence: result.appEvidence })) });
    metrics = { connections: metric };
  } else if (scenario === 2) {
    const { metric, results } = await stepped(sendRates, rate =>
      ({ ...sendSettings, PUBLISHERS: String(rate * sendInterval / 1000) }), offeredShortfall);
    Object.assign(entry, { steps: results.map((result, i) => ({ rate: sendRates[i], exitCode: result.exitCode,
      offeredSendRate: result.rate?.offeredSendRate, measurementError: result.measurementError,
      ...Object.fromEntries(['published_messages', 'delivered_messages', 'missing_deliveries'].map(name =>
        [name, result.summary?.metrics?.[name]?.values.count])),
      deliveryLatency: result.summary?.metrics?.delivery_latency?.values, appEvidence: result.appEvidence })) });
    // Proxy resources come from the highest passing step (the first step when none passed).
    const passed = results.filter((result, i) => sendRates[i] <= metric.observation.value && result.exitCode === 0);
    const resources = metricsFor(proxy, 2, passed.at(-1) ?? results[0] ?? { exitCode: 1, measurementError: 'no throughput step ran' });
    // An invalid ladder invalidates its resource observations too.
    for (const resource of Object.values(resources)) resource.observation.error ??= metric.observation.error;
    metrics = { throughput_sends_per_second: metric, ...resources };
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
  // A full-size preflight passes only if every observation passes judge()'s per-run validity checks
  // (metric present, TLS 1.3 evidence, generator CPU below 90% for scenarios 1-2) and each ladder's first step passes.
  if (preflight && !entry.error) {
    const reasons = Object.entries(metrics).flatMap(([name, metric]) => [
      ...judge([metric.observation], metric.kind, scenario <= 2).invalid.flatMap(row => row.reasons.map(reason => `${name}: ${reason}`)),
      ...(metric.kind === 'step' && !(metric.observation.value > 0) ? [`${name}: the first step did not pass`] : []),
    ]);
    if (reasons.length) Object.assign(entry, { error: `preflight: ${reasons.join('; ')}` });
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
  plan: for (const scenario of scenarios) {
    for (const proxy of ['caddy', 'nginx'] as const) {
      await run(scenario, proxy, true);
      if (preflight && runs.at(-1)?.error) {
        console.error(`Preflight stopped: scenario ${scenario}, ${proxy}: ${runs.at(-1)?.error}`);
        break plan;
      }
    }
    if (!preflight) for (const proxy of abba(repeats)) await run(scenario, proxy, false);
  }
  // Failure evidence stays available, but a harness error fails the dispatch.
  if (runs.some(run => run.error)) process.exitCode = 1;
} finally {
  try { save(); } finally {
    rmSync(tlsDirectory, { recursive: true, force: true });
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}
