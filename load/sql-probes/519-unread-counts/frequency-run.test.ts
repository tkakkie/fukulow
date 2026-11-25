import assert from 'node:assert/strict';
import test from 'node:test';
import { runFrequencyBlock } from './frequency-run.ts';
import { withCap } from './frequency-policy.ts';
import { referenceWindow } from './frequency-fixture.ts';

async function stagePlan(control: boolean, seen: string[], fault?: 'reference' | 'cooldown') {
  const saved = { policy0: '2000000' };
  let scope = saved.policy0;
  for (const order of [1, 2, 3]) {
    const window = referenceWindow(order, { control });
    await runFrequencyBlock(order, control, {
      checkpoint() {
        seen.push(`${order}: checkpoint base @${scope}`);
        return 123n;
      },
      async settle(deadline) {
        assert.equal(deadline, 30_000_000_123n);
        seen.push(`${order}: settle`);
      },
      async reference(checkpointNs) {
        assert.equal(checkpointNs, 123n);
        seen.push(`${order}: reference @${scope}`);
        if (fault === 'reference' && order === 2) throw new Error('reference STOP');
        return window;
      },
      clone() {
        seen.push(`${order}: clone @${scope}`);
        return order;
      },
      async coolBaseline() {
        seen.push(`${order}: cool baseline`);
        if (fault === 'cooldown') throw new Error('cooldown STOP');
      },
      async work(clone, reference) {
        assert.equal(clone, order);
        assert.equal(reference, control || order === 1 ? window : undefined);
        seen.push(`${order}: checkpoint clone`, `${order}: warm`,
          `${order}: ${control && order === 2 ? 'turbostat + ' : ''}measure`, `${order}: close checkpoint @${scope}`);
      },
      cap: body => withCap(saved, body, {
        async write(values) {
          scope = values.policy0;
          seen.push(scope === '1700000' ? 'apply cap' : 'restore');
        },
        verify(values) {
          assert.equal(scope, values.policy0);
          seen.push(scope === '1700000' ? 'verify cap' : 'verify restore');
        },
        pending: () => {}, restored: () => {},
      }),
    });
  }
}

test('control settles a reference inside each policy before its clone and outside turbostat', async () => {
  const seen: string[] = [];
  await stagePlan(true, seen);
  assert.deepEqual(seen, [
    '1: checkpoint base @2000000', '1: settle', '1: reference @2000000', '1: clone @2000000',
    '1: cool baseline', '1: checkpoint clone', '1: warm', '1: measure', '1: close checkpoint @2000000',
    'apply cap', 'verify cap', '2: checkpoint base @1700000', '2: settle', '2: reference @1700000',
    '2: clone @1700000', '2: checkpoint clone', '2: warm', '2: turbostat + measure', '2: close checkpoint @1700000',
    'verify cap', 'restore', 'verify restore',
    '3: checkpoint base @2000000', '3: settle', '3: reference @2000000', '3: clone @2000000',
    '3: checkpoint clone', '3: warm', '3: measure', '3: close checkpoint @2000000',
  ]);
});

test('Rehearsal 2 and formal schedule one settled reference before block 1', async () => {
  const seen: string[] = [];
  await stagePlan(false, seen);
  assert.deepEqual(seen.slice(0, 4), ['1: checkpoint base @2000000', '1: settle', '1: reference @2000000', '1: clone @2000000']);
  assert.deepEqual(seen.filter(step => /reference|settle|cap|restore/.test(step)), ['1: settle', '1: reference @2000000']);
});

test('a capped reference STOP restores policy before any second clone or subsequent block', async () => {
  const seen: string[] = [];
  await assert.rejects(stagePlan(true, seen, 'reference'), /reference STOP/);
  assert.deepEqual(seen.slice(-3), ['2: reference @1700000', 'restore', 'verify restore']);
  assert.ok(!seen.some(step => /2: clone|^3:/.test(step)));
});

test('control stops on a failed cool-baseline recheck before checkpointing the clone', async () => {
  const seen: string[] = [];
  await assert.rejects(stagePlan(true, seen, 'cooldown'), /cooldown STOP/);
  assert.deepEqual(seen.slice(-3), ['1: reference @2000000', '1: clone @2000000', '1: cool baseline']);
});
