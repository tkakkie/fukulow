import assert from 'node:assert/strict';
import test from 'node:test';
import { judgedIds } from './design.ts';
import { flagged, invalidChecks, judge, type PairEvidence } from './judge.ts';

function evidence() {
  const pairs: PairEvidence[] = [...judgedIds, 'E', 'S', 'V', 'P', 'A/A'].map(id => ({
    id, few: {n: 1_000, shape: 'few-shape'}, many: {n: 1_000, shape: 'few-shape'},
    ratios: id === 'P' ? {p50: 1.5, p95: 1.6} : {p50: 1, p95: 1},
  }));
  return {pairs, checks: Object.fromEntries(invalidChecks.map(check => [check, true]))};
}

test('flag requires both quantiles to cross the same inclusive boundary', () => {
  for (const [a, b, expected] of [
    [1.10, 1.10, true], [.91, .91, true], [1.11, 1.09, false], [.90, .92, false],
    [.90, 1.11, false], [1.09, .92, false], [1, 1, false],
  ] as const) assert.equal(flagged(a, b), expected, `${a}, ${b}`);
});

test('PASS needs the complete clean matrix including both controls', () => {
  assert.deepEqual(judge(evidence()), {validity: 'VALID', verdict: 'PASS', failures: []});
  for (const id of [...judgedIds, 'E', 'S', 'V', 'P', 'A/A']) {
    const data = evidence();
    data.pairs = data.pairs.filter(pair => pair.id !== id);
    assert.equal(judge(data).verdict, 'NOT EVALUATED', id);
  }
  const missingPlan = evidence();
  delete missingPlan.pairs[0].many!.shape;
  assert.equal(judge(missingPlan).verdict, 'NOT EVALUATED');
});

test('any judged flag or changed plan fails, even when the other pairs are clear', () => {
  for (const id of judgedIds) {
    const data = evidence();
    const pair = data.pairs.find(entry => entry.id === id)!;
    pair.ratios = {p50: .91, p95: .91};
    assert.deepEqual(judge(data), {validity: 'VALID', verdict: 'FAIL', failures: [id]});
    pair.ratios = {p50: 1, p95: 1};
    pair.many!.shape = 'changed';
    assert.deepEqual(judge(data), {validity: 'VALID', verdict: 'FAIL', failures: [id]});
  }
});

test('reported-only flags and plan differences have no effect on the verdict', () => {
  const data = evidence();
  for (const pair of data.pairs.filter(pair => ['E', 'S', 'V'].includes(pair.id))) {
    pair.ratios = {p50: 1.8, p95: 1.9};
    pair.many!.shape = 'changed';
  }
  assert.equal(judge(data).verdict, 'PASS');
});

test('every explicit invalidation takes precedence over a judged failure', () => {
  for (const check of invalidChecks) {
    const data = evidence();
    data.pairs[0].ratios = {p50: 5, p95: 5};
    data.checks[check] = false;
    assert.deepEqual(judge(data), {validity: 'INVALID', verdict: 'NOT EVALUATED', invalid: [check]});
  }
});

test('the exact sample size applies to every arm including diagnostics and controls', () => {
  for (const {id} of evidence().pairs) {
    for (const arm of ['few', 'many'] as const) {
      const data = evidence();
      data.pairs.find(pair => pair.id === id)![arm]!.n = 999;
      assert.deepEqual(judge(data), {validity: 'INVALID', verdict: 'NOT EVALUATED', invalid: [`sampleCount:${id}`]});
    }
  }
});

test('a quiet P or a flagged A/A invalidates the run', () => {
  const data = evidence();
  data.pairs.find(pair => pair.id === 'P')!.ratios = {p50: 1.49, p95: 1.10};
  assert.equal(judge(data).verdict, 'PASS'); // 1.5 is a smoke selection target, not the formal positive-control gate.
  data.pairs.find(pair => pair.id === 'P')!.ratios = {p50: 1.10, p95: 1.09};
  assert.deepEqual(judge(data), {validity: 'INVALID', verdict: 'NOT EVALUATED', invalid: ['positiveControl']});
  data.pairs.find(pair => pair.id === 'A/A')!.ratios = {p50: .91, p95: .91};
  assert.deepEqual(judge(data), {validity: 'INVALID', verdict: 'NOT EVALUATED', invalid: ['positiveControl', 'negativeControl']});
});

test('missing validity evidence and unusable ratios cannot pass', () => {
  const data = evidence();
  delete data.checks.cleanup;
  assert.equal(judge(data).verdict, 'NOT EVALUATED');
  data.checks.cleanup = true;
  data.pairs[0].ratios = {p50: Infinity, p95: 1.11};
  assert.equal(judge(data).verdict, 'NOT EVALUATED');
});
