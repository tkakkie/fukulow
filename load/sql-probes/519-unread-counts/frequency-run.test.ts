import assert from 'node:assert/strict';
import test from 'node:test';
import { blockStopReasons, runFrequencyBlock } from './frequency-run.ts';
import { withCap } from './frequency-policy.ts';
import { block, evidence, floors, primaryVoters, referenceWindow, session, sets796 } from './frequency-fixture.ts';
import { judgeFrequency } from './frequency-judge.ts';

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

for (const stage of ['rehearsal2', 'formal'] as const) {
  test(`${stage} collects all six blocks despite throttling and invalid frequency verdicts`, () => {
    const all = () => 2_800_000_000n;
    const blocks = [
      block(1, { mperf: all }),
      block(2, { mperf: all, ratios: () => [94n, 100n] }),
      block(3, { mperf: cpu => cpu === 1 || cpu === 3 ? 0n : all(),
        ratios: cpu => cpu <= 10 ? [94n, 100n] : [1n, 1n] }),
      block(4, { mperf: cpu => cpu < 5 ? all() : 0n }),
      block(5, { mperf: all }),
      block(6, { mperf: all }),
    ];
    for (const { order } of blocks) {
      assert.deepEqual(blockStopReasons(stage, order, blocks.slice(0, order), evidence, null), []);
    }
    const report = judgeFrequency(blocks, sets796, evidence, session, { ...floors, server: ['2000000001', '1'] });
    assert.deepEqual(report.blocks.map(b => b.order), [1, 2, 3, 4, 5, 6]);
    assert.ok(report.reasons.includes('block 1: floor server below reviewed minimum'));
    assert.ok(report.reasons.includes('block 2: F5 throttled client'));
    assert.ok(report.reasons.includes('block 3: F5 client median bounds straddle 19/20'));
    assert.ok(report.reasons.includes('block 4: F4 client coverage 2/6'));
  });

  test(`${stage} stops for bad counter evidence or a busy reference`, () => {
    const second = block(2);
    second.counters.close.reads.pop();
    assert.deepEqual(blockStopReasons(stage, 2, [block(1), second], evidence, null),
      ['block 2: F6 missing, duplicate or unordered CPU pair']);

    const first = block(1);
    first.counters.reference = referenceWindow(1, { mperf: cpu => cpu === 13 ? 1_002_000_000n : 0n });
    assert.deepEqual(blockStopReasons(stage, 1, [first], evidence, null),
      ['reference 1: client CPU 13 reached 500 ms C0 normalized to 120 s']);
  });
}

test('control stops when the baseline has insufficient coverage', () => {
  assert.deepEqual(blockStopReasons('control', 1, [block(1, { control: true })], evidence, null), []);
  const first = block(1, { control: true, mperf: cpu => cpu < 8 && cpu !== 5 ? 2_800_000_000n : 0n });
  assert.deepEqual(blockStopReasons('control', 1, [first], evidence, null),
    ['block 1: F4 client coverage 2/6', 'block 1: F4 client common coverage 2/6']);
});

function controlSpot(capped: ReturnType<typeof block>, aperf: number) {
  const rows = capped.counters.open.reads.map(({ cpu }) => `${cpu} 2000 ${primaryVoters.includes(cpu) ? aperf : 0} ${primaryVoters.includes(cpu) ? 2000 : 0}`);
  return { startNs: capped.counters.open.reads[0].monoNs, stopNs: capped.counters.close.reads.at(-1)!.monoNs,
    stdout: '', stderr: ['CPU TSC_MHz APERF MPERF', ...rows].join('\n') };
}

test('control requires capped work and full-span throttling plus a matching turbostat observation', () => {
  const first = block(1, { control: true });
  const capped = block(2, { control: true, ratios: () => [17n, 20n] });
  assert.deepEqual(blockStopReasons('control', 2, [first, capped], evidence, controlSpot(capped, 1700)), []);
  assert.deepEqual(blockStopReasons('control', 2, [first, capped], evidence, null),
    ['Error: no capped turbostat observation or calibrated counters']);

  const clear = block(2, { control: true });
  const clearReasons = blockStopReasons('control', 2, [first, clear], evidence, controlSpot(clear, 2000));
  assert.ok(clearReasons.includes('control failed to show block 2: F5 throttled server'));
  assert.ok(clearReasons.includes('control failed to show block 2: F5 throttled client'));

  const clearTail = block(2, { control: true, ratios: () => [9n, 10n],
    idleMperf: cpu => cpu < 8 ? 2_800_000_000n : 0n, idleRatios: () => [1n, 1n] });
  assert.deepEqual(blockStopReasons('control', 2, [first, clearTail], evidence, controlSpot(clearTail, 1900)),
    ['block 2: F5 server full span must show throttling', 'block 2: F5 client full span must show throttling']);
});

test('control accepts the prior capped result and stops if the restored phase still throttles', () => {
  const first = block(1, { control: true });
  const capped = block(2, { control: true, ratios: () => [17n, 20n] });
  const restored = block(3, { control: true });
  assert.deepEqual(blockStopReasons('control', 3, [first, capped, restored], evidence, null), []);
  const throttled = block(3, { control: true, ratios: () => [94n, 100n] });
  assert.deepEqual(blockStopReasons('control', 3, [first, capped, throttled], evidence, null),
    ['block 3: F5 throttled server', 'block 3: F5 throttled client']);
});
