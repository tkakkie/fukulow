import assert from 'node:assert/strict';
import test from 'node:test';
import { schedule, sessionIndex } from './scheduler.ts';

test('slow HTTP neither lowers nor raises offered rate and requests overlap', async () => {
  async function run(latency: number) {
    let now = 0;
    const starts: number[] = [];
    const completions: { at: number; resolve: () => void }[] = [];
    const wait = async (ms: number) => {
      now += ms;
      for (const item of completions.filter((item) => item.at <= now)) item.resolve();
    };
    const result = await schedule(1000, 100, 2, () => now, wait, () => {
      starts.push(now);
      return new Promise<void>((resolve) => completions.push({ at: now + latency, resolve }));
    });
    return { result, starts };
  }
  const fast = await run(1);
  const slow = await run(100); // batch interval, rather than a fraction of it
  assert.deepEqual(slow, fast);
  assert.equal(slow.result.offered, 20);
  assert.equal(slow.result.elapsedMs, 1000);
  assert.deepEqual(slow.starts, Array.from({ length: 20 }, (_, i) => Math.floor(i / 2) * 100));
});

test('scheduler drains requests slower than the interval without delaying starts', async () => {
  let now = 0;
  const starts: number[] = [];
  const pending: (() => void)[] = [];
  const task = schedule(1000, 100, 1, () => now, async (ms) => { now += ms; }, () => {
    starts.push(now);
    return new Promise<void>((resolve) => pending.push(resolve));
  });
  // Let the scheduler reach its drain, with every HTTP response still blocked.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.deepEqual(starts, Array.from({ length: 10 }, (_, i) => i * 100));
  pending.forEach((resolve) => resolve());
  assert.equal((await task).offered, 10);
});

test('generator starvation fails instead of changing the offered profile', async () => {
  let now = 0;
  await assert.rejects(schedule(1000, 100, 1, () => now,
    async (ms) => { now += ms + 100; }, async () => {}), /missed a send deadline/);
});

test('sockets have independent sessions by default and configurable sharing', () => {
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => sessionIndex(i, 1)), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => sessionIndex(i, 2)), [0, 0, 1, 1, 2, 2]);
});

test('a rejected HTTP task invalidates the run even if it completes before drain', async () => {
  let now = 0;
  await assert.rejects(schedule(1000, 100, 1, () => now,
    async (ms) => { now += ms; }, async () => { throw new Error('send failed'); }), /send failed/);
});

test('early timer wakes cannot start a batch or end the window prematurely', async () => {
  let now = 0;
  let early = true;
  const starts: number[] = [];
  const result = await schedule(1000, 100, 1, () => now, async (ms) => {
    if (ms > 0 && early) { early = false; return; }
    now += ms;
    early = true;
  }, async () => { starts.push(now); });
  assert.deepEqual(starts, Array.from({ length: 10 }, (_, i) => i * 100));
  assert.equal(result.elapsedMs, 1000);
});
