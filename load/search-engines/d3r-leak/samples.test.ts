import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPgbench, preBlockGuard } from './block.ts';
import { formal, judgedIds, schedule } from './design.ts';
import { armStats, bootstrap, confidenceIntervals, parseBlock, ratios, SampleCountError } from './samples.ts';
import { benchmarkScript, productionPath } from '../d3r/path.ts';

const log = (...rows: [number, number, number | string][]) =>
  rows.map(([client, tx, latency]) => `${client} ${tx} ${latency} 0 123 45`).join('\n');

test('G2 excludes each client’s first transaction in each block', () => {
  const a = parseBlock([log([0, 1, 999], [0, 2, 10]), log([1, 1, 888], [1, 2, 20])], 2, 1);
  const b = parseBlock([log([0, 1, 777], [1, 1, 666], [0, 2, 30], [1, 2, 40])], 2, 1);
  assert.deepEqual(armStats([a, b]), {n: 4, p50: 20, p95: 40, warmup: {n: 4, p50: 777, max: 999}});
  assert.deepEqual(ratios([a], [b]), {p50: 3, p95: 2, medianDifferenceUs: 20});
});

test('pgbench 18.6 smoke logs start each client at transaction 1', () => {
  const block = parseBlock([
    `0 1 2732 0 1795790370 989031
0 2 341 0 1795790370 989378
0 3 325 0 1795790370 989705
0 4 306 0 1795790370 990013
0 5 325 0 1795790370 990339
0 6 391 0 1795790370 990732
0 7 290 0 1795790370 991022
0 8 300 0 1795790370 991323
0 9 342 0 1795790370 991665
`,
    `1 1 2734 0 1795790370 989043
1 2 353 0 1795790370 989401
1 3 317 0 1795790370 989719
1 4 307 0 1795790370 990028
1 5 322 0 1795790370 990351
1 6 284 0 1795790370 990636
1 7 265 0 1795790370 990902
1 8 327 0 1795790370 991230
1 9 299 0 1795790370 991530
`,
  ], 2, 8);
  assert.equal(block.length, 18);
  assert.deepEqual(block.filter(sample => sample.warmup), [
    {client: 0, transaction: 1, us: 2732, warmup: true},
    {client: 1, transaction: 1, us: 2734, warmup: true},
  ]);
});

test('raw log parsing rejects failed, missing, duplicate or out-of-range transactions', () => {
  assert.throws(() => parseBlock([log([0, 1, 999], [0, 2, 'failed'])], 1, 1), /transaction failed/);
  assert.throws(() => parseBlock([log([0, 1, 999])], 1, 1), SampleCountError);
  for (const bad of [
    log([0, 0, 999], [0, 1, 10], [0, 2, 20]),
    log([0, 1, 999], [0, 3, 10], [0, 4, 20]),
    log([0, 1, 999], [0, 2, 10], [0, 2, 20]),
    log([0, 1, 999], [0, 3, 20], [0, 2, 10]),
    log([0, 1, 999], [0, 2, 10], [1, 1, 20]),
  ]) assert.throws(() => parseBlock([bad], 1, 2), /Unexpected pgbench client or transaction sequence/);
});

test('pgbench transcript must confirm exact completion with no failure or timeout', () => {
  const ok = 'number of transactions actually processed: 105/105\nnumber of failed transactions: 0 (0.000%)\n';
  checkPgbench(ok, 0, 105);
  assert.throws(() => checkPgbench(ok, 1, 105), /pgbench failed/);
  assert.throws(() => checkPgbench(ok.replace('105/', '104/'), 0, 105), /sample count/);
  assert.throws(() => checkPgbench(ok.replace('transactions: 0', 'transactions: 1'), 0, 105), /pgbench failed/);
  assert.throws(() => checkPgbench(ok + 'ERROR: canceling statement due to statement timeout', 0, 105), /SQLSTATE 57014/);
});

test('timed benchmark uses the d3r transaction and excludes the pre-block guard', () => {
  const script = benchmarkScript(productionPath().page, 'qvwx');
  assert.ok(!script.includes(preBlockGuard) && !script.includes('10 seconds'));
  assert.match(script, /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
  assert.match(script, /set_config\('fukulow.organization_id', .*true\)/);
  assert.match(script, /SET LOCAL plan_cache_mode = force_generic_plan/);
  assert.match(script, /SET LOCAL statement_timeout = '2s'/);
});

test('G3 gives each pair 20 ABBA blocks and exactly 1,000 measured samples per arm', () => {
  const ids = [...judgedIds, 'E', 'S', 'V', 'P', 'A/A'];
  const first = schedule(ids, 689_202_610, formal.blocksPerArm);
  assert.deepEqual(first, schedule(ids, 689_202_610, formal.blocksPerArm));
  assert.notDeepEqual(first, schedule(ids, 689_202_611, formal.blocksPerArm));
  for (const {blocks} of first) {
    const [a, b] = blocks;
    assert.notEqual(a, b);
    assert.deepEqual(blocks, Array.from({length: 5}, () => [a, b, b, a]).flat());
    for (const arm of [a, b]) assert.equal(
      blocks.filter(block => block === arm).length * formal.clients * formal.measuredPerClient, 1_000);
  }
});

test('bootstrap has 10,000 fixed-seed resamples with each block’s sample count preserved', () => {
  assert.equal(bootstrap.resamples, 10_000);
  const block = (us: number) => parseBlock([log([0, 1, 99_999], [0, 2, us], [0, 3, us])], 1, 2);
  const few = [block(10), block(1_000)];
  const many = [block(20), block(3_000)];
  assert.deepEqual(confidenceIntervals(few, many), {p50: [2, 2], p95: [3, 3]});
  assert.deepEqual(confidenceIntervals(few, many), confidenceIntervals(few, many));
});
