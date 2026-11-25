import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planRuns, replacementQueue, runId } from './revocation-holds-plan.ts';

test('V4 appends only INVALID replacements up to r6 without replacing a valid FAIL', () => {
  const initial = planRuns(['H512'], ['short'], 3, true);
  const queue = replacementQueue(initial);
  const ids = [];
  for (const { run, id } of queue.attempts()) {
    ids.push(id);
    queue.record(run, run.kind === 'control' ? 'CONTROL' : run.repeat === 1 ? 'FAIL' : 'INVALID');
  }
  assert.deepEqual(ids, [...initial.map(runId), 'H512-short-r4', 'H512-short-r5', 'H512-short-r6']);
});

test('V4 a setup abort retries the same slot without spending a replacement', () => {
  const initial = planRuns(['H512'], ['short'], 3, true);
  const queue = replacementQueue(initial);
  const attempts = queue.attempts();
  const first = attempts.next().value!;
  assert.equal(queue.record(first.run, 'setup abort'), true);
  const retry = attempts.next().value!;
  assert.deepEqual(retry, { run: first.run, id: 'H512-short-r1-setup-retry' });
  assert.equal(queue.record(retry.run, 'PASS'), true);
  assert.deepEqual(Array.from(attempts, attempt => attempt.id), initial.slice(1).map(runId));
});

test('V4 two consecutive setup aborts for one slot stop the session', () => {
  const queue = replacementQueue(planRuns(['H512'], ['short'], 3, true));
  const attempts = queue.attempts();
  assert.equal(queue.record(attempts.next().value!.run, 'setup abort'), true);
  assert.equal(queue.record(attempts.next().value!.run, 'setup abort'), false);
  assert.equal(attempts.next().done, true);
});
