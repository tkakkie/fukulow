import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarize } from './summary.ts';

const samples = (values: number[]) => values.map((ms, i) => ({
  sample: i + 1, startedMs: 0, finishedMs: Math.ceil(ms), elapsedNs: Math.round(ms * 1e6), ok: true,
}));
const constant = (ms: number, size = 1_000) => samples(Array<number>(size).fill(ms));

test('reports nearest ranks from each state and counts samples at or above the readiness bound', () => {
  const idle = samples(Array.from({ length: 1_000 }, (_, i) => 1_000 - i));
  const result = summarize(idle, constant(200));
  assert.deepEqual(result.states.idle, {
    samples: 1_000, failed: 0, p50Ms: 500, p99Ms: 990, p999Ms: 999, maxMs: 1_000, atOrAboveReadinessBound: 801,
  });
  assert.equal(result.states.loaded.atOrAboveReadinessBound, 1_000);
  assert.equal(result.verdict, 'maintainer chooses');
});

test('both p99.9 values must be strictly below 50 ms, regardless of max', () => {
  const fast = samples([...Array<number>(999).fill(49.999999), 200]);
  const boundary = constant(50);
  assert.equal(summarize(fast, fast).verdict, 'option 3');
  assert.equal(summarize(boundary, fast).verdict, 'maintainer chooses');
  assert.equal(summarize(fast, boundary).verdict, 'maintainer chooses');
});

test('too few successes in either state or a failed acquisition makes the verdict INVALID', () => {
  const full = constant(1);
  const short = constant(1, 999);
  assert.equal(summarize(short, full).verdict, 'INVALID');
  assert.equal(summarize(full, short).verdict, 'INVALID');
  assert.equal(summarize(full, [...full, { ...full[0], ok: false }]).verdict, 'INVALID');
});
