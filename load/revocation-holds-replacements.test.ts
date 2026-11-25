import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planRuns, replacementQueue, runId } from './revocation-holds-plan.ts';

test('V4 appends only INVALID replacements up to r6 without replacing a valid FAIL', () => {
  const initial = planRuns(['H512'], ['short'], 3, true);
  const queue = replacementQueue(initial);
  for (const run of queue.runs) queue.record(run, run.kind === 'control' ? 'CONTROL' : run.repeat === 1 ? 'FAIL' : 'INVALID');
  assert.deepEqual(queue.runs.slice(0, initial.length).map(runId), initial.map(runId));
  assert.deepEqual(queue.runs.slice(initial.length).map(runId), ['H512-short-r4', 'H512-short-r5', 'H512-short-r6']);
});

test('V4 two setup aborts for a shape stop the session, with another shape interleaved', () => {
  const queue = replacementQueue(planRuns(['H512'], ['short'], 3, true));
  const [fault, control, , secondFault] = queue.runs;
  assert.equal(queue.record(fault, 'setup abort'), true);
  assert.equal(queue.record(control, 'CONTROL'), true);
  assert.equal(queue.record(secondFault, 'setup abort'), false);

  const retried = replacementQueue(planRuns(['H512'], ['short'], 3, false));
  const [first, next, third] = retried.runs;
  assert.equal(retried.record(first, 'setup abort'), true);
  assert.equal(retried.record(next, 'INVALID'), true);
  assert.equal(retried.record(third, 'setup abort'), true);
});
