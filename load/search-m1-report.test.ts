import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collect } from './search-m1-results.ts';
import {
  classify, countKeys, limiter, orders, rates, report, workload,
  type Arm, type Batch, type Counts, type Metadata, type Run, type Step,
} from './search-m1-report.ts';

const bodyHash = 'bodies';
const expected = { commit: 'main', appImage: 'app', migrateImage: 'app', dbImage: 'db', k6Image: 'k6',
  limiter, bodySha256: bodyHash, bodySeed: 153202611, dbSettings: { 'pgroonga.enable_crash_safe': 'on' },
  overlay: { storedBody: true, pgroongaIndex: false } };
const resources = { acceptedPerSecond: 50, appCpuPeakPercent: 5, dbCpuPeakPercent: 10, walBytesPerSend: 300, dbSizeGrowthBytes: 1000 };
const sendMs = (p95: number) => ({ p50: 1, p95, p99: p95 + 1 });
function step(rate: number, seconds = 60): Step {
  return { rate, seconds, offered: rate * seconds, accepted: rate * seconds, droppedIterations: 0,
    rejected429: 0, rejected503: 0, otherHttpErrors: 0, clientTimeouts: 0, transportErrors: 0,
    sendMs: sendMs(10), resources };
}

function fixture(smoke = false) {
  const runs: Run[] = [];
  const metadata: Metadata = { smoke, expected };
  const batch: Batch = { runs, imageCleanupVerified: true, errors: [] };
  const runOrders = smoke ? [['B']] as const : orders;
  for (const [index, arms] of runOrders.entries()) for (const arm of arms) {
    const config = workload('many', smoke);
    const { bodySha256, bodySeed, k6Image, ...stack } = expected;
    stack.overlay = { storedBody: true, pgroongaIndex: arm === 'A' };
    runs.push({ scenario: 'many', pair: index + 1, arm, cleanupVerified: true, errors: [],
      identity: { ...stack, bodySha256, bodySeed, k6Image, workload: config }, finalStack: structuredClone(stack),
      steps: config.rates.map(rate => step(rate, config.seconds)) });
  }
  function judge(hash: string | null = bodyHash) {
    for (const run of runs) {
      const totals = Object.fromEntries(countKeys.map(key => [key, run.steps.reduce((n, row) => n + row[key], 0)])) as Counts;
      run.totals = { ...totals, sendMs: sendMs(10), resources };
    }
    return report(metadata, batch, hash).scenarios[0];
  }
  const run = (arm: Arm, pair: number) => runs.find(row => row.arm === arm && row.pair === pair)!;
  const at = (arm: Arm, pair: number, rate: number) => run(arm, pair).steps.find(row => row.rate === rate)!;
  const shortfall = (arm: Arm, pair: number, rate: number) => {
    at(arm, pair, rate).accepted--;
    at(arm, pair, rate).rejected503++;
  };
  return { judge, batch, run, at, shortfall };
}

test('sustained uses 99% inclusive and requires zero drops and complete counts and latencies', () => {
  const row = step(50);
  row.offered = row.accepted = 2970;
  assert.equal(classify(row, true), 'sustained');
  row.offered = row.accepted = 2969;
  assert.equal(classify(row, true), 'generator-side shortfall INVALID');
  row.offered = row.accepted = 3000;
  row.droppedIterations++;
  assert.equal(classify(row, true), 'generator-side shortfall INVALID');
  assert.equal(classify({ ...row, accepted: 2999 }, true), 'INVALID run');
  assert.equal(classify({ ...row, sendMs: { ...row.sendMs, p95: null } }, true), 'INVALID run');
  assert.equal(classify(row, false), 'INVALID run');
});

test('each app-side outcome takes precedence over generator shortfall', () => {
  for (const key of ['rejected429', 'rejected503', 'otherHttpErrors', 'clientTimeouts', 'transportErrors'] as const) {
    const row = { ...step(50), offered: 2000, accepted: 1999, droppedIterations: 1000, [key]: 1 };
    assert.equal(classify(row, true), 'app-side shortfall', key);
  }
});

test('A generator shortfall at a comparison rate yields NOT EVALUATED even with material impact elsewhere', () => {
  const f = fixture();
  f.at('A', 1, 50).droppedIterations = 1;
  f.shortfall('A', 2, 500);
  assert.equal(f.judge().judgement, 'NOT EVALUATED');
});

test('A 503 at a comparison rate is Material impact even with dropped iterations', () => {
  const f = fixture();
  f.shortfall('A', 1, 250);
  f.at('A', 1, 250).droppedIterations = 1;
  const result = f.judge();
  assert.equal(result.judgement, 'Material impact');
  assert.deepEqual(result.reasons, ['A app-side shortfall at 250/s']);
});

test('above B highest, invalid and app-side steps are reported without affecting judgement', () => {
  const f = fixture();
  f.shortfall('B', 1, 4000);
  f.shortfall('A', 1, 4000);
  f.at('A', 2, 4000).droppedIterations++;
  f.at('B', 3, 4000).droppedIterations++;
  const result = f.judge();
  assert.equal(result.bHighest, 2000);
  assert.equal(result.judgement, 'No material impact');
  assert.deepEqual(result.runs.map(run => run.steps.at(-1)?.classification), [
    'app-side shortfall', 'app-side shortfall', 'generator-side shortfall INVALID',
    'sustained', 'generator-side shortfall INVALID', 'sustained',
  ]);
});

test('B generator shortfall below its highest sustained rate yields NOT EVALUATED', () => {
  const f = fixture();
  f.at('B', 2, 100).droppedIterations++;
  const result = f.judge();
  assert.equal(result.bHighest, 4000);
  assert.equal(result.judgement, 'NOT EVALUATED');
});

test('B sustains nothing in all pairs', () => {
  const f = fixture();
  for (const rate of rates) f.shortfall('B', 1, rate);
  assert.equal(f.judge().judgement, 'NOT EVALUATED');
});

test('both strict latency limits must be exceeded', () => {
  const f = fixture();
  for (const pair of [1, 2, 3]) {
    f.at('A', pair, 50).sendMs = sendMs(15);
    f.at('A', pair, 100).sendMs = sendMs(14.99);
    f.at('B', pair, 250).sendMs = sendMs(24);
    f.at('A', pair, 250).sendMs = sendMs(30);
  }
  assert.equal(f.judge().judgement, 'No material impact');
});

test('criterion 2 uses paired p95 ratios and differences, with median over three pairs', () => {
  const f = fixture();
  f.at('A', 1, 50).sendMs = sendMs(50);
  assert.equal(f.judge().judgement, 'No material impact');
  f.at('B', 2, 50).sendMs = sendMs(20);
  f.at('A', 2, 50).sendMs = sendMs(26.25);
  const result = f.judge();
  assert.equal(result.judgement, 'Material impact');
  assert.ok('latency' in result);
  assert.equal(result.latency?.[0]?.medianRatio, 1.3125);
  assert.equal(result.latency?.[0]?.medianAbsoluteDifferenceMs, 6.25);
});

test('criterion 2 applies through 1000/s and skips non-comparison rates', () => {
  const f = fixture();
  f.shortfall('B', 1, 500);
  for (const pair of [1, 2, 3]) for (const rate of [500, 2000, 4000]) f.at('A', pair, rate).sendMs = sendMs(60);
  assert.equal(f.judge().judgement, 'No material impact');
  for (const pair of [1, 2, 3]) f.at('A', pair, 1000).sendMs = sendMs(20);
  assert.deepEqual(f.judge().reasons, ['A send p95 exceeds both limits at 1000/s']);
});

test('A highest sustained rate below B is Material impact', () => {
  const f = fixture();
  f.shortfall('A', 1, 4000);
  const result = f.judge();
  assert.equal(result.aHighest, 2000);
  assert.equal(result.bHighest, 4000);
  assert.ok(result.reasons.includes('A highest sustained rate is below B'));
  assert.equal(result.judgement, 'Material impact');
});

test('identity, incomplete evidence and cleanup failures invalidate the entire arm-run', () => {
  const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.run('A', 1).identity!.commit = 'wrong'; },
    f => { f.run('A', 1).identity!.dbImage = 'wrong'; },
    f => { f.run('A', 1).identity!.bodySeed++; },
    f => { f.run('A', 1).identity!.bodySha256 = 'wrong'; },
    f => { f.run('A', 1).finalStack!.dbSettings = {}; },
    f => { f.run('A', 1).finalStack!.limiter = { ...limiter, LOAD_SEND_BURST: '10' }; },
    f => { f.run('A', 1).cleanupVerified = false; },
    f => { f.batch.imageCleanupVerified = false; },
    f => { f.at('A', 1, 4000).accepted--; },
    f => { delete f.at('A', 1, 4000).resources; },
    f => { f.run('A', 1).steps.pop(); },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    f.shortfall('A', 1, 50);
    mutate(f);
    const result = f.judge();
    assert.equal(result.judgement, 'NOT EVALUATED');
    const invalid = result.runs.find(run => run.arm === 'A' && run.pair === 1)!;
    assert.equal(invalid.steps.length, rates.length);
    assert.ok(invalid.steps.every(row => row.classification === 'INVALID run'));
  }
  assert.equal(fixture().judge(null).judgement, 'NOT EVALUATED');
});

test('smoke only reports its single step and is never judged', () => {
  const result = fixture(true).judge();
  assert.equal(result.judgement, 'NOT EVALUATED');
  assert.deepEqual(result.reasons, ['SMOKE / NON-EVALUATION']);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].arm, 'B');
  assert.deepEqual(result.runs[0].steps.map(row => [row.rate, row.seconds, row.classification]), [[50, 10, 'sustained']]);
});

test('k6 extraction keeps fractional send latency and separates HTTP errors, timeouts and transport errors', () => {
  const { rates, seconds, ...settings } = workload('many', true);
  const throughput = { ...settings, bodySha256: 'a'.repeat(64), offered: 498, accepted: 493, steps: [
    { name: 'step_1', rate: rates[0], seconds, startSeconds: 0, attempted: 498, accepted: 493,
      acceptedInWindow: 492, rejected429: 1, rejected503: 1, otherErrors: 3, droppedIterations: 2 },
  ] };
  const rep = (values: Record<string, number>) => ({ values });
  const trend = rep({ med: 4.125, 'p(95)': 7.75, 'p(99)': 8.875 });
  const tag = 'name:throughput_send,scenario:step_1';
  const log = `LOAD_THROUGHPUT ${JSON.stringify(throughput)}\nLOAD_SUMMARY ${JSON.stringify({ metrics: {
    dropped_iterations: rep({ count: 2 }),
    'http_req_duration{name:throughput_send}': trend, [`http_req_duration{${tag}}`]: trend,
    [`http_reqs{${tag}}`]: rep({ count: 498 }), [`http_reqs{${tag},status:0}`]: rep({ count: 2 }),
    [`http_reqs{${tag},status:0,error_code:1050}`]: rep({ count: 1 }),
  } })}\n`;
  const before = { startedMs: 400, completedMs: 500, walBytes: 200, dbBytes: 100 };
  const after = { startedMs: 11_200, completedMs: 11_300, walBytes: 300, dbBytes: 200 };
  const result = collect(log, workload('many', true), 1000, [before, after], [{ at: 2000, appCpu: 12, dbCpu: 13 }]);
  const row = result.steps[0];
  assert.deepEqual(row.sendMs, { p50: 4.125, p95: 7.75, p99: 8.875 });
  assert.deepEqual([row.otherHttpErrors, row.clientTimeouts, row.transportErrors], [1, 1, 1]);
  assert.equal(classify(row, true), 'app-side shortfall');
  assert.equal(row.resources?.acceptedPerSecond, 49.2);
  assert.equal(row.resources?.walBytesPerSend, 100 / 493);
  assert.deepEqual(result.totals.sendMs, row.sendMs);
});
