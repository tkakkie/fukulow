import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sha256 } from './search-m1-bodies.ts';
import { collect, type Boundary } from './search-m1-results.ts';
import {
  classify, countKeys, limiter, orders, rates, report, workload,
  type Arm, type Batch, type Counts, type Metadata, type Run, type Step,
} from './search-m1-report.ts';

const bodyHash = 'bodies';
const expected = { commit: 'main', appImage: 'app', migrateImage: 'app', dbImage: 'db', k6Image: 'k6',
  limiter: { LOAD_SEND_BURST: '1000000', LOAD_SEND_REFILL_PER_SECOND: '1000000' },
  bodySha256: bodyHash, bodySeed: 153202611, dbSettings: {
    shared_preload_libraries: 'pg_stat_statements,pgroonga_wal_resource_manager,pgroonga_crash_safer',
    'pg_stat_statements.track': 'all', 'pgroonga.enable_wal_resource_manager': 'on', 'pgroonga.enable_crash_safe': 'on',
    'pgroonga.enable_wal': 'off', fsync: 'on', wal_level: 'replica', synchronous_commit: 'on',
  },
  overlay: { storedBody: true, pgroongaIndex: false } };
const resources = { acceptedPerSecond: 50, appCpuPeakPercent: 5, dbCpuPeakPercent: 10, walBytesPerSend: 300, dbSizeGrowthBytes: 1000 };
const sendMs = (p95: number) => ({ p50: 1, p95, p99: p95 + 1 });
function step(rate: number, seconds = 60): Step {
  return { rate, seconds, offered: rate * seconds, accepted: rate * seconds, droppedIterations: 0,
    rejected429: 0, rejected503: 0, otherHttpErrors: 0, clientTimeouts: 0, transportErrors: 0,
    sendMs: sendMs(10), sendSamples: rate * seconds, resources };
}

function fixture(smoke = false) {
  const runs: Run[] = [];
  const metadata: Metadata = { smoke, expected: structuredClone(expected) };
  const batch: Batch = { runs, imageCleanupVerified: true, errors: [] };
  const runOrders = smoke ? [['B']] as const : orders;
  for (const [index, arms] of runOrders.entries()) for (const arm of arms) {
    const config = { mode: 'many' as const, channels: 200, members: 4, subscribers: 0,
      preAllocatedVUs: 20, maxVUs: 100, requestTimeoutSeconds: 3,
      rates: smoke ? [50] : [50, 100, 250, 500, 1000, 2000, 4000], seconds: smoke ? 10 : 60 };
    const { bodySha256, bodySeed, k6Image, ...stack } = structuredClone(metadata.expected);
    stack.overlay = { storedBody: true, pgroongaIndex: arm === 'A' };
    runs.push({ scenario: 'many', pair: index + 1, arm, sequence: runs.length + 1, cleanupVerified: true, errors: [],
      identity: { ...stack, bodySha256, bodySeed, k6Image, workload: config }, finalStack: structuredClone(stack),
      steps: config.rates.map(rate => step(rate, config.seconds)) });
  }
  function judge(hash: string | null = bodyHash) {
    for (const run of runs) {
      const totals = Object.fromEntries(countKeys.map(key => [key, run.steps.reduce((n, row) => n + row[key], 0)])) as Counts;
      run.totals = { ...totals, sendMs: sendMs(10), sendSamples: totals.offered, resources };
    }
    return report(metadata, batch, hash).scenarios[0];
  }
  const run = (arm: Arm, pair: number) => runs.find(row => row.arm === arm && row.pair === pair)!;
  const at = (arm: Arm, pair: number, rate: number) => run(arm, pair).steps.find(row => row.rate === rate)!;
  const shortfall = (arm: Arm, pair: number, rate: number) => {
    at(arm, pair, rate).accepted--;
    at(arm, pair, rate).rejected503++;
  };
  return { judge, metadata, batch, run, at, shortfall };
}

test('report CLI reads artifacts from the supplied directory and requires its bodies.json', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'search-m1-report-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const dir = join(cwd, 'artifacts');
  mkdirSync(dir);
  const bodies = '["test body"]\n';
  const f = fixture();
  f.metadata.expected.bodySha256 = sha256(bodies);
  for (const run of f.batch.runs) run.identity!.bodySha256 = f.metadata.expected.bodySha256;
  assert.equal(f.judge(f.metadata.expected.bodySha256).judgement, 'No material impact');
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify(f.metadata));
  writeFileSync(join(dir, 'runs.json'), JSON.stringify(f.batch));
  writeFileSync(join(cwd, 'bodies.json'), bodies);
  const cli = fileURLToPath(new URL('./search-m1-report.ts', import.meta.url));
  const regenerate = (arg: string, from: string) =>
    execFileSync(process.execPath, [cli, arg], { cwd: from, encoding: 'utf8' });

  assert.match(regenerate('artifacts', cwd), /^many NOT EVALUATED$/m);
  const invalid = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assert.ok(invalid.scenarios[0].runs.every((run: { steps: { classification: string }[] }) =>
    run.steps.every(row => row.classification === 'INVALID run')));

  writeFileSync(join(dir, 'bodies.json'), bodies);
  assert.match(regenerate('artifacts', cwd), /^many No material impact$/m);
  assert.match(regenerate('.', dir), /^many No material impact$/m);
});

test('matching identities must still use the approved seed, DB settings, limiter and images', () => {
  assert.equal(fixture().judge().judgement, 'No material impact', 'literal approved identity');
  const cases = [
    ['body seed', { bodySeed: 1 }],
    ...Object.keys(expected.dbSettings).map(key =>
      [key, { dbSettings: { ...expected.dbSettings, [key]: key === 'pgroonga.enable_crash_safe' ? 'off' : 'wrong' } }] as const),
    ['extra DB setting', { dbSettings: { ...expected.dbSettings, jit: 'off' } }],
    ['limiter', { limiter: { ...expected.limiter, LOAD_SEND_BURST: '10' } }],
    ['migration image', { migrateImage: 'other-app' }],
  ] as const;
  for (const [label, change] of cases) {
    const f = fixture();
    Object.assign(f.metadata.expected, change);
    for (const run of f.batch.runs) {
      Object.assign(run.identity!, change);
      if (!('bodySeed' in change)) Object.assign(run.finalStack!, change);
    }
    const result = f.judge();
    assert.equal(result.judgement, 'NOT EVALUATED', label);
    assert.ok(result.runs.every(run => run.problems.includes('Run identity mismatch') &&
      run.steps.every(row => row.classification === 'INVALID run')), label);
  }
});

test('sustained uses 99% inclusive and requires zero drops and complete counts and latencies', () => {
  const row = step(50);
  row.offered = row.accepted = row.sendSamples = 2970;
  assert.equal(classify(row, true), 'sustained');
  row.offered = row.accepted = row.sendSamples = 2969;
  assert.equal(classify(row, true), 'generator-side shortfall INVALID');
  row.offered = row.accepted = row.sendSamples = 3000;
  row.droppedIterations++;
  assert.equal(classify(row, true), 'generator-side shortfall INVALID');
  assert.equal(classify({ ...row, accepted: 2999 }, true), 'INVALID run');
  assert.equal(classify({ ...row, sendMs: { ...row.sendMs, p95: null } }, true), 'INVALID run');
  assert.equal(classify(row, false), 'INVALID run');
});

test('each app-side outcome takes precedence over generator shortfall', () => {
  for (const key of ['rejected429', 'rejected503', 'otherHttpErrors', 'clientTimeouts', 'transportErrors'] as const) {
    const row = { ...step(50), offered: 2000, sendSamples: 2000, accepted: 1999, droppedIterations: 1000, [key]: 1 };
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
  assert.equal(result.latency?.[0]?.medianDifferenceMs, 6.25);
});

test('criterion 2 uses the signed A − B difference, so a faster A never counts', () => {
  const f = fixture();
  const pairs: [number, number][] = [[12, 6], [3, 10], [6, 3]];
  pairs.forEach(([a, b], index) => {
    f.at('A', index + 1, 50).sendMs = sendMs(a);
    f.at('B', index + 1, 50).sendMs = sendMs(b);
  });
  const result = f.judge();
  assert.ok('latency' in result);
  assert.equal(result.latency?.[0]?.medianRatio, 2);
  assert.equal(result.latency?.[0]?.medianDifferenceMs, 3);
  assert.equal(result.judgement, 'No material impact');
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
  const trend = rep({ count: 498, med: 4.125, 'p(95)': 7.75, 'p(99)': 8.875 });
  const tag = 'name:throughput_send,scenario:step_1';
  const log = `LOAD_THROUGHPUT ${JSON.stringify(throughput)}\nLOAD_SUMMARY ${JSON.stringify({ metrics: {
    dropped_iterations: rep({ count: 2 }),
    'dropped_iterations{scenario:step_1}': rep({ count: 2 }),
    'throughput_attempted{scenario:step_1}': rep({ count: 498 }),
    'throughput_accepted{scenario:step_1}': rep({ count: 493 }),
    'throughput_accepted_in_window{scenario:step_1}': rep({ count: 492 }),
    'throughput_429{scenario:step_1}': rep({ count: 1 }),
    'throughput_503{scenario:step_1}': rep({ count: 1 }),
    'throughput_other{scenario:step_1}': rep({ count: 3 }),
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

function rawK6(offered = 3000, drops = 0, failures = 0, timeouts = 0, twoSteps = false) {
  const conditions = { ...workload('many', false), rates: [50] };
  const { rates, seconds, ...settings } = conditions;
  const row = { name: 'step_1', rate: rates[0], seconds, startSeconds: 0, attempted: offered, accepted: offered - failures,
    acceptedInWindow: offered - failures, rejected429: 0, rejected503: 0, otherErrors: failures, droppedIterations: drops };
  const tag = 'name:throughput_send,scenario:step_1';
  const trend = { count: offered, med: 10, 'p(95)': 10, 'p(99)': 10 };
  const metrics: Record<string, { values: Record<string, number> }> = Object.fromEntries(Object.entries({
    dropped_iterations: { count: drops },
    'dropped_iterations{scenario:step_1}': { count: drops },
    'throughput_attempted{scenario:step_1}': { count: offered },
    'throughput_accepted{scenario:step_1}': { count: row.accepted },
    'throughput_accepted_in_window{scenario:step_1}': { count: row.acceptedInWindow },
    'throughput_429{scenario:step_1}': { count: 0 },
    'throughput_503{scenario:step_1}': { count: 0 },
    'throughput_other{scenario:step_1}': { count: failures },
    'http_req_duration{name:throughput_send}': { ...trend },
    [`http_req_duration{${tag}}`]: trend,
    [`http_reqs{${tag}}`]: { count: offered },
    [`http_reqs{${tag},status:0}`]: { count: failures },
    [`http_reqs{${tag},status:0,error_code:1050}`]: { count: timeouts },
  }).map(([key, values]) => [key, { values }]));
  const rows = [row];
  if (twoSteps) {
    conditions.rates.push(50);
    rows.push({ ...row, name: 'step_2', startSeconds: 64 });
    for (const [key, metric] of Object.entries(metrics)) {
      if (key.includes('step_1')) metrics[key.replace('step_1', 'step_2')] = structuredClone(metric);
    }
    metrics.dropped_iterations.values.count *= 2;
    metrics['http_req_duration{name:throughput_send}'].values.count *= 2;
  }
  function extract(boundaries: Boundary[] = [], startMs: number | undefined = 1000) {
    const throughput = { ...settings, bodySha256: 'a'.repeat(64), offered: offered * rows.length,
      accepted: row.accepted * rows.length, steps: rows };
    const log = `LOAD_THROUGHPUT ${JSON.stringify(throughput)}\nLOAD_SUMMARY ${JSON.stringify({ metrics })}\n`;
    return collect(log, conditions, startMs, boundaries, []);
  }
  return { tag, metrics, extract };
}

test('Astra 1: missing dropped-iteration counts cannot make 2999 of 3000 sends sustained', () => {
  for (const key of ['dropped_iterations{scenario:step_1}', 'dropped_iterations']) {
    const { metrics, extract } = rawK6(2999);
    delete metrics[key];
    assert.throws(extract, new RegExp(key.replace(/[{}]/g, '\\$&')), key);
  }
});

test('Astra 1: every per-step request and outcome counter must be present', () => {
  for (const key of ['http_reqs', 'throughput_attempted', 'throughput_accepted',
    'throughput_429', 'throughput_503', 'throughput_other']) {
    const { tag, metrics, extract } = rawK6();
    const metric = key === 'http_reqs' ? `${key}{${tag}}` : `${key}{scenario:step_1}`;
    delete metrics[metric];
    assert.throws(extract, new RegExp(metric.replace(/[{}]/g, '\\$&')), metric);
  }
});

test('Astra 1 / Opus 3: a missing status:0 or timeout submetric cannot relabel a timeout', () => {
  for (const suffix of [',status:0', ',status:0,error_code:1050']) {
    const { tag, metrics, extract } = rawK6(3000, 0, 1, 1);
    delete metrics[`http_reqs{${tag}${suffix}}`];
    assert.throws(extract, new RegExp(suffix), suffix);
  }
});

test('Astra 2: absent or partial send trends invalidate the run', () => {
  for (const suffix of [',scenario:step_1', '']) {
    const key = `http_req_duration{name:throughput_send${suffix}}`;
    const partial = rawK6();
    partial.metrics[key].values.count = 1;
    assert.throws(partial.extract, /latency sample count/i, key);
    const missing = rawK6();
    delete missing.metrics[key];
    assert.throws(missing.extract, /latency/i, key);
  }
});

test('Astra 2: a regenerated report rejects partial latency evidence anywhere in an arm-run', () => {
  const f = fixture();
  f.at('A', 1, 4000).sendSamples = 1;
  const result = f.judge();
  assert.equal(result.judgement, 'NOT EVALUATED');
  assert.ok(result.runs.find(run => run.arm === 'A' && run.pair === 1)!.steps.every(step => step.classification === 'INVALID run'));
});

test('Astra 4: identity fields missing or empty throughout the batch invalidate every run', () => {
  for (const [key, value] of [['commit', undefined], ['appImage', ' '], ['migrateImage', ''], ['dbImage', undefined],
    ['k6Image', ''], ['bodySeed', undefined], ['setting', undefined], ['setting', '']] as const) {
    const f = fixture();
    const identities = [f.metadata.expected, ...f.batch.runs.flatMap(run => [run.identity!, run.finalStack!])];
    // A field lost from both sides must still be detected.
    for (const identity of identities) {
      if (!Object.hasOwn(identity, key) && key !== 'setting') continue;
      const target = key === 'setting' ? identity.dbSettings : identity as unknown as Record<string, unknown>;
      const field = key === 'setting' ? 'pgroonga.enable_crash_safe' : key;
      if (value === undefined) delete target[field];
      else target[field] = value;
    }
    const result = f.judge();
    assert.equal(result.judgement, 'NOT EVALUATED', key);
    assert.ok(result.runs.every(run => run.steps.every(row => row.classification === 'INVALID run')), key);
  }
});

test('Astra 5: cleanup evidence requires boolean true for both run and images', () => {
  for (const field of ['cleanupVerified', 'imageCleanupVerified'] as const) {
    const f = fixture();
    const target = field === 'cleanupVerified' ? f.run('A', 1) : f.batch;
    Object.assign(target, { [field]: 'false' });
    const result = f.judge();
    assert.equal(result.judgement, 'NOT EVALUATED', field);
    assert.match(result.runs.find(run => run.arm === 'A' && run.pair === 1)!.problems.join(' '), /Cleanup unverified/);
  }
});

test('Astra 6: recorded chronological order must alternate B/A, A/B, B/A', () => {
  const f = fixture();
  const [firstA, firstB] = [f.run('A', 2), f.run('B', 2)];
  Object.assign(firstA, { sequence: 4 });
  Object.assign(firstB, { sequence: 3 });
  [f.batch.runs[2], f.batch.runs[3]] = [firstB, firstA];
  const result = f.judge();
  assert.equal(result.judgement, 'NOT EVALUATED');
  assert.ok(result.runs.every(run => run.steps.every(row => row.classification === 'INVALID run')));
});

test('Astra 6: a missing or duplicate arm-run sequence invalidates the scenario', () => {
  for (const sequence of [undefined, 1]) {
    const f = fixture();
    Object.assign(f.run('A', 1), { sequence });
    assert.equal(f.judge().judgement, 'NOT EVALUATED');
  }
  const f = fixture();
  f.batch.runs.reverse();
  assert.equal(f.judge().judgement, 'No material impact');
});

test('Opus 2: unavailable recorded-only resources never turn a sustained step into an invalid run', () => {
  const f = fixture();
  delete f.at('A', 1, 50).resources;
  Object.assign(f.at('A', 1, 50), { resourcesMissing: 'snapshot late by 200 ms' });
  const result = f.judge();
  assert.equal(result.judgement, 'No material impact');
  assert.equal(result.runs.find(run => run.arm === 'A' && run.pair === 1)!.steps[0].classification, 'sustained');
  assert.equal(rawK6().extract().steps[0].resourcesMissing, 'snapshot 0 missing');
});

test('Opus 2: late, missing and failed between-step SQL snapshots flag both adjacent steps', () => {
  const start = { startedMs: 400, completedMs: 500, walBytes: 200, dbBytes: 100 };
  const end = { startedMs: 125_000, completedMs: 125_100, walBytes: 400, dbBytes: 200 };
  const late = { startedMs: 64_500, completedMs: 65_200, walBytes: 300, dbBytes: 150 };
  for (const [boundary, reason] of [[late, 'snapshot late by 200 ms'],
    [undefined, 'snapshot 1 missing'], [{ missing: 'snapshot 1 failed' }, 'snapshot 1 failed']] as const) {
    const { steps } = rawK6(3000, 0, 0, 0, true).extract([start, boundary, end]);
    assert.deepEqual(steps.map(step => step.resourcesMissing), [reason, reason]);
    assert.ok(steps.every(step => classify(step, true) === 'sustained'));
  }
});
