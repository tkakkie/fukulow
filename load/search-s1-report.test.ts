import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sha256 } from './search-m1-bodies.ts';
import { countKeys, limiter, type Batch, type Step } from './search-m1-report.ts';
import { bodyCount, bodySeed, frozenPool, poolSha256, termsPerBody } from './search-s1-bodies.ts';
import { originalTermsSha256, overlaySource, s1ArmDirectory } from './search-s1-evidence.ts';
import {
  expectedS1DbSettings, productCommit, s1Node, s1Orders, s1Report, s1Scenarios, s1Workload, writeS1Report,
  type S1Metadata, type S1Mode, type S1Run,
} from './search-s1-report.ts';

const overlay = overlaySource();
const metadata = (mode: S1Mode): S1Metadata => ({
  mode, node: s1Node, k6Version: 'k6 v2.4.0', bodySize: bodyCount, overlay,
  expected: {
    commit: productCommit, appImage: 'sha256:' + 'a'.repeat(64), migrateImage: 'sha256:' + 'a'.repeat(64),
    dbImage: 'sha256:' + 'b'.repeat(64), k6Image: 'sha256:' + 'c'.repeat(64),
    limiter, dbSettings: expectedS1DbSettings, bodySha256: poolSha256, bodySeed,
  },
  originalTermsSha256, overlaidTermsSha256: 'e'.repeat(64),
});

type Cell = Pick<S1Run, 'arm' | 'scenario' | 'pair'> & { rate: number };
type ChangeStep = (cell: Cell, step: Step) => void;

function fixture(mode: S1Mode, change: ChangeStep = () => {}) {
  const meta = metadata(mode);
  const { k6Image, bodySha256, bodySeed, ...images } = meta.expected;
  const runs: S1Run[] = [];
  for (const scenario of s1Scenarios(mode)) {
    const workload = s1Workload(scenario, mode);
    for (const [index, order] of s1Orders(mode).entries()) {
      for (const arm of order) {
        const pair = index + 1;
        const finalStack = { ...images, overlay: { arm, searchEngine: 'disabled', overlaySha256: overlay.sha256,
          originalSha256: meta.originalTermsSha256!, definitionSha256: arm === 'A' ? meta.originalTermsSha256! : meta.overlaidTermsSha256! } };
        const resources = { acceptedPerSecond: 50, walBytesPerSend: 100, appCpuPeakPercent: 4,
          dbCpuPeakPercent: 5, dbSizeGrowthBytes: 1000 };
        const steps = workload.rates.map(rate => {
          const offered = rate * workload.seconds;
          const step: Step = { rate, seconds: workload.seconds, offered, accepted: offered, droppedIterations: 0, rejected429: 0,
            rejected503: 0, otherHttpErrors: 0, clientTimeouts: 0, transportErrors: 0, sendSamples: offered,
            sendMs: { p50: 2, p95: 20, p99: 120 }, resources };
          change({ arm, pair, scenario, rate }, step);
          return step;
        });
        const totals = { ...steps[0] };
        for (const key of countKeys) totals[key] = steps.reduce((sum, step) => sum + step[key], 0);
        totals.sendSamples = steps.reduce((sum, step) => sum + step.sendSamples, 0);
        const expectedPerMessage = arm === 'A' ? termsPerBody : 0;
        const rowsPerMessage = { [expectedPerMessage]: totals.accepted };
        runs.push({ scenario, pair, arm, sequence: runs.length + 1, identity: { ...finalStack, workload, bodySeed, bodySha256, k6Image },
          finalStack, cleanupVerified: true, errors: [], steps, totals, normalizedBodies: bodyCount,
          termCheck: { expectedPerMessage, rowsPerMessage, checked: totals.accepted } });
      }
    }
  }
  const batch: Batch<S1Run> = { runs, imageCleanupVerified: true, errors: [] };
  return { meta, batch };
}

function judge(change?: ChangeStep) {
  const { meta, batch } = fixture('formal', change);
  return s1Report(meta, batch, poolSha256);
}

test('formal uses the registered workload and order, and both scenarios must pass', () => {
  const result = judge();
  assert.equal(result.judgement, 'PASS');
  assert.equal(result.evidence, true);
  for (const scenario of result.scenarios) {
    assert.deepEqual(scenario.comparisonRates, [50, 100, 250]);
    assert.deepEqual(scenario.runs.map(run => run.arm), ['B', 'A', 'A', 'B', 'B', 'A']);
    const conditions = scenario.runs[0].identity?.workload;
    assert.deepEqual(conditions, { mode: scenario.scenario, channels: scenario.scenario === 'many' ? 200 : 1,
      members: 4, subscribers: 0, preAllocatedVUs: 20, maxVUs: 100, requestTimeoutSeconds: 3,
      rates: [50, 100, 250], seconds: 60 });
  }
});

test('smoke and rehearsal each run B/A on many at 50/s and are never evidence', () => {
  for (const mode of ['smoke', 'rehearsal'] as const) {
    const { meta, batch } = fixture(mode);
    const result = s1Report(meta, batch, poolSha256);
    assert.equal(result.evidence, false);
    assert.equal(result.judgement, 'NOT EVALUATED');
    assert.equal(result.scenarios.length, 1);
    assert.deepEqual(result.scenarios[0].runs.map(run => [run.scenario, run.arm, run.steps[0].rate, run.steps[0].seconds]),
      [['many', 'B', 50, 10], ['many', 'A', 50, 10]]);
  }
});

test('formal mode refuses an existing output directory', t => {
  const out = mkdtempSync(join(tmpdir(), 'search-s1-existing-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const sentinel = join(out, 'report.json');
  writeFileSync(sentinel, 'existing evidence');
  const runner = fileURLToPath(new URL('./search-m1.ts', import.meta.url));
  const result = spawnSync(process.execPath, [runner, '--s1', '--out', out], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /output already exists/);
  assert.equal(readFileSync(sentinel, 'utf8'), 'existing evidence');
});

test('inclusive boundaries, either limit alone, and signed differences use paired medians', () => {
  for (const [a, b, expected] of [
    [25, 20, 'PASS'], [10, 8, 'PASS'], [105, 100, 'PASS'], [11, 8, 'FAIL'], [106, 100, 'FAIL'], [20, 100, 'PASS'],
  ] as const) {
    const result = judge((cell, step) => {
      if (cell.scenario === 'many' && cell.rate === 50) {
        step.sendMs.p95 = cell.arm === 'B' ? b : cell.pair === 1 ? 120 : a;
      }
    });
    assert.equal(result.judgement, expected, `${a} versus ${b}`);
    const comparison = result.scenarios[0].comparisons[0];
    assert.ok('medianRatio' in comparison);
    assert.equal(comparison.medianRatio, a / b);
    assert.equal(comparison.medianDifferenceMs, a - b);
    assert.equal(result.scenarios[1].judgement, 'PASS');
  }
});

test('429, 503, other HTTP errors and timeouts in A each fail a comparison step', () => {
  for (const outcome of ['rejected429', 'rejected503', 'otherHttpErrors', 'clientTimeouts'] as const) {
    const result = judge((cell, step) => {
      if (cell.arm === 'A' && cell.scenario === 'hot' && cell.rate === 100 && cell.pair === 2) {
        step.accepted--;
        step[outcome]++;
        step.droppedIterations++;
      }
    });
    assert.equal(result.judgement, 'FAIL', outcome);
    assert.equal(result.scenarios[0].judgement, 'PASS');
    assert.equal(result.scenarios[1].comparisons[1].judgement, 'FAIL');
  }
});

test('only B-sustained comparison steps are judged', () => {
  const result = judge((cell, step) => {
    if (cell.rate === 50) return;
    if (cell.arm === 'B' && cell.pair === 3) step.droppedIterations++;
    if (cell.arm === 'A') step.sendMs.p95 = 100;
  });
  assert.equal(result.judgement, 'PASS');
  for (const scenario of result.scenarios) assert.deepEqual(scenario.comparisonRates, [50]);

  const noComparisons = judge((cell, step) => { if (cell.arm === 'B') step.droppedIterations++; });
  assert.equal(noComparisons.judgement, 'NOT EVALUATED');
  assert.equal(noComparisons.evidence, true);
});

test('A generator-only shortfall is not evaluated and the offer boundary is 99%', () => {
  for (const [loss, dropped, expected] of [[0, 1, 'NOT EVALUATED'], [31, 0, 'NOT EVALUATED'], [30, 0, 'PASS']] as const) {
    const result = judge((cell, step) => {
      if (cell.arm === 'A' && cell.rate === 50 && cell.scenario === 'many') {
        step.offered -= loss;
        step.accepted -= loss;
        step.sendSamples -= loss;
        step.droppedIterations = dropped;
      }
    });
    assert.equal(result.judgement, expected);
    assert.equal(result.scenarios[0].reason, expected === 'NOT EVALUATED' ?
      'A had a generator-side shortfall at a comparison step' : undefined);
    assert.deepEqual(result.scenarios[0].comparisonRates, [50, 100, 250]);
    assert.equal(result.scenarios[1].judgement, 'PASS');
  }
});

test('a failed comparison takes precedence over a generator shortfall at another rate', () => {
  const result = judge((cell, step) => {
    if (cell.arm !== 'A' || cell.scenario !== 'many') return;
    if (cell.rate === 50) step.droppedIterations++;
    if (cell.rate === 100) step.sendMs.p95 = 30;
  });
  assert.deepEqual(result.scenarios[0].comparisons.map(step => step.judgement), ['NOT EVALUATED', 'FAIL', 'PASS']);
  assert.equal(result.scenarios[0].reason, undefined);
  assert.equal(result.scenarios[0].judgement, 'FAIL');
  assert.equal(result.judgement, 'FAIL');
});

test('an unavailable recorded-only resource sample leaves the judgement unchanged', () => {
  const { meta, batch } = fixture('formal');
  const step = batch.runs[1].steps[0];
  delete step.resources;
  step.resourcesMissing = 'CPU samples missing';
  const result = s1Report(meta, batch, poolSha256);
  assert.equal(result.judgement, 'PASS');
  assert.equal(result.scenarios[0].runs[1].steps[0].resourcesMissing, 'CPU samples missing');
});

test('incomplete, mismatched, unclean or failed term evidence is invalid', () => {
  const mutations: ((batch: Batch<S1Run>) => void)[] = [
    batch => { batch.runs.pop(); },
    batch => { batch.runs[1].identity!.overlay.overlaySha256 = 'bad'; },
    batch => { batch.runs[1].finalStack!.overlay.definitionSha256 = batch.runs[0].finalStack!.overlay.definitionSha256; },
    batch => { batch.runs[1].cleanupVerified = false; },
    batch => { batch.imageCleanupVerified = false; },
    batch => { batch.runs[1].termCheck!.rowsPerMessage = { 7996: batch.runs[1].totals!.accepted }; },
    batch => { batch.runs[1].steps[0].sendSamples--; },
  ];
  for (const mutate of mutations) {
    const { meta, batch } = fixture('formal');
    mutate(batch);
    const result = s1Report(meta, batch, poolSha256);
    assert.equal(result.judgement, 'NOT EVALUATED');
    assert.equal(result.evidence, false);
  }
  const { meta, batch } = fixture('formal');
  assert.equal(s1Report(meta, batch, 'bad').judgement, 'NOT EVALUATED');
});

test('a matching but unpinned definition in metadata and every stack is invalid', () => {
  const { meta, batch } = fixture('formal');
  meta.originalTermsSha256 = 'a'.repeat(64);
  for (const run of batch.runs) {
    for (const stack of [run.identity!, run.finalStack!]) {
      stack.overlay.originalSha256 = meta.originalTermsSha256;
      if (run.arm === 'A') stack.overlay.definitionSha256 = meta.originalTermsSha256;
    }
  }
  const result = s1Report(meta, batch, poolSha256);
  assert.equal(result.judgement, 'NOT EVALUATED');
  assert.equal(result.evidence, false);
});

test('report regeneration requires matching accepted IDs and term counts for each arm', t => {
  const dir = mkdtempSync(join(tmpdir(), 'search-s1-report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { meta, batch } = fixture('smoke');
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify(meta));
  writeFileSync(join(dir, 'bodies.json'), frozenPool().json);
  const evidence = batch.runs.map(run => {
    const armDir = join(dir, s1ArmDirectory(run.scenario, run.pair, run.arm));
    mkdirSync(armDir);
    const log = join(armDir, 'k6.log');
    const counts = join(armDir, 'term-counts.tsv');
    const ids = Array.from({ length: run.totals!.accepted }, (_, i) =>
      `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`);
    const accepted = 'LOAD_S1_ORGANIZATION 22222222-2222-4222-8222-222222222222\n' +
      ids.map(id => `LOAD_S1_ACCEPTED ${id}\n`).join('');
    const rows = ids.map(id => `${id}\t${id}\t${run.termCheck!.expectedPerMessage}\n`).join('');
    writeFileSync(log, accepted);
    writeFileSync(counts, rows);
    run.termEvidence = { acceptedLogSha256: sha256(accepted), termCountsSha256: sha256(rows) };
    return { log, counts, accepted, rows };
  });
  const regenerate = () => {
    writeFileSync(join(dir, 'runs.json'), JSON.stringify(batch));
    return writeS1Report(dir).scenarios[0];
  };
  assert.deepEqual(regenerate().runs.map(run => run.problems), [[], []]);
  for (const [i, { log, counts, accepted, rows }] of evidence.entries()) {
    for (const [file, text] of [[log, accepted], [counts, rows]]) {
      rmSync(file);
      assert.match(regenerate().runs[i].problems[0], /Invalid per-Message evidence/);
      writeFileSync(file, text.replace('11111111', '33333333'));
      assert.match(regenerate().runs[i].problems[0], /differ from runs.json/);
      writeFileSync(file, text);
    }
  }
  const { counts, rows } = evidence[0];
  const changedRows = rows.replace('11111111', '33333333');
  writeFileSync(counts, changedRows);
  batch.runs[0].termEvidence!.termCountsSha256 = sha256(changedRows);
  assert.match(regenerate().runs[0].problems[0], /Unexpected or duplicate Message term count/);
});
