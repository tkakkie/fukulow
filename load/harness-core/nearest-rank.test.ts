import assert from 'node:assert/strict';
import test from 'node:test';
import { nearestRank } from './nearest-rank.ts';

test('nearest rank is the smallest sample with at least the fraction at or below it', () => {
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepEqual([0.01, 0.1, 0.11, 0.5, 0.95, 0.99, 1].map(f => nearestRank(ten, f)), [1, 1, 2, 5, 10, 10, 10]);
  assert.equal(nearestRank([7], 0.5), 7);
  assert.equal(nearestRank([1, 2], 0.5), 1);
  assert.equal(nearestRank([1, 2, 2, 9], 0.75), 2);
});

test('nearest rank over 100 samples picks the p-th sample on both scales', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  for (const p of [1, 29, 50, 95, 99, 100]) assert.equal(nearestRank(hundred, p / 100), p);
  // With 101 samples p99 is the 100th; with 99 samples it is the slowest.
  assert.equal(nearestRank(Array.from({ length: 101 }, (_, i) => i), 0.99), 99);
  assert.equal(nearestRank(Array.from({ length: 99 }, (_, i) => i), 0.99), 98);
});

test('nearest rank equals the inline formula harnesses use today on the same input', () => {
  for (let n = 1; n <= 257; n++) {
    const sorted = Array.from({ length: n }, (_, i) => i * 7 + (i % 3));
    for (const fraction of [0.001, 0.05, 0.25, 0.29, 0.5, 0.57, 0.9, 0.95, 0.99, 0.999, 1]) {
      const clamped = sorted[Math.min(n - 1, Math.max(0, Math.ceil(fraction * n) - 1))];
      assert.equal(nearestRank(sorted, fraction), clamped, `n=${n} fraction=${fraction}`);
    }
    for (const p of [5, 29, 50, 95, 99]) {
      const percentScale = sorted[Math.min(n - 1, Math.ceil((p / 100) * n) - 1)];
      assert.equal(nearestRank(sorted, p / 100), percentScale, `n=${n} p=${p}`);
    }
  }
});

test('empty input is undefined so each harness wrapper chooses its own empty result', () => {
  assert.equal(nearestRank([], 0.5), undefined);
  assert.equal(nearestRank([], 1), undefined);
});

test('a fraction outside (0, 1] or unsorted input throws', () => {
  for (const bad of [0, -0.1, 1.01, 99, Number.NaN]) assert.throws(() => nearestRank([1, 2], bad), RangeError);
  assert.throws(() => nearestRank([], 0), RangeError);
  assert.throws(() => nearestRank([2, 1], 0.5), /not sorted ascending/);
  assert.throws(() => nearestRank([1, 3, 2, 4], 1), /not sorted ascending/);
});
