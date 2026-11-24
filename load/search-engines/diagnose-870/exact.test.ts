import assert from 'node:assert/strict';
import test from 'node:test';
import { atLeast, below, compare, floorRoot, geometric, q, rational, ratio, rhoAtLeast, sumAtLeast } from './exact.ts';

test('a double converts to its exact dyadic rational', () => {
  assert.deepEqual(rational(1.5), q(3, 2));
  assert.deepEqual(rational(130), q(130));
  const x = rational(0.1);
  assert.equal(Number(x.n) / Number(x.d), 0.1);
  assert.throws(() => rational(NaN));
});

test('floorRoot is the exact integer k-th root', () => {
  assert.equal(floorRoot(27n, 3n), 3n);
  assert.equal(floorRoot(26n, 3n), 2n);
  const big = 123456789012345678901234567890n;
  for (const k of [2n, 5n, 23n]) {
    const r = floorRoot(big ** k + 1n, k);
    assert.equal(r, big);
    assert.equal(floorRoot(big ** k - 1n, k), big - 1n);
  }
});

test('G95 ratios compare exactly against rational thresholds', () => {
  const flat = (v: number) => geometric(Array.from({length: 23}, () => v));
  assert.equal(compare(ratio(flat(130), flat(100)), q(13, 10)), 0);
  assert.ok(atLeast(ratio(flat(130), flat(100)), q(13, 10)));
  const sub = geometric([129.999, 130.001, ...Array.from({length: 21}, () => 130)]);
  assert.ok(below(ratio(sub, flat(100)), q(13, 10)));
  // Different query counts cross-multiply on the powers.
  assert.equal(compare(ratio(geometric([4, 9]), geometric([6])), q(1)), 0);
  assert.ok(atLeast(flat(1), q(-1)));
});

test('sumAtLeast decides a + x >= b y from rigorous bounds, exact roots included', () => {
  const r = (v: number) => geometric([v, v, v]);
  assert.equal(sumAtLeast(ratio(r(64), r(40)), q(2), q(3), ratio(r(48), r(40))), true);
  assert.equal(sumAtLeast(ratio(r(63.999), r(40)), q(2), q(3), ratio(r(48), r(40))), false);
  // sqrt(2) + 0 >= 1 x sqrt(2) is an exact equality of irrational roots: undecidable, so null.
  const two = geometric([2, 1]);
  assert.equal(sumAtLeast(two, q(0), q(1), two), null);
});

test('rhoAtLeast is Spearman rho >= t exactly, ties averaged', () => {
  assert.equal(rhoAtLeast([1, 2, 3, 4], [1, 2, 3, 4], q(4, 5)), true);
  assert.equal(rhoAtLeast([1, 2, 3, 4], [4, 3, 2, 1], q(4, 5)), false);
  // rho = 0.8 exactly for ranks (1,2,3,4,5) vs (2,1,3,4,5)? 1 - 6*2/120 = 0.9; (1,3,2,5,4): 1 - 6*4/120 = 0.8.
  assert.equal(rhoAtLeast([1, 2, 3, 4, 5], [1, 3, 2, 5, 4], q(4, 5)), true);
  assert.equal(rhoAtLeast([1, 2, 3, 4, 5], [1, 3, 2, 5, 4], q(801, 1000)), false);
  assert.equal(rhoAtLeast([1, 2, 3], [2, 2, 2], q(4, 5)), false);
});
