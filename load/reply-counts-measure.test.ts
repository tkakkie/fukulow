import assert from 'node:assert/strict';
import test from 'node:test';
import { measure } from './reply-counts-measure.ts';
import { batch, inFlightCap, perTick, sizing, tickMs } from './reply-counts-model.ts';

function fixture(pilot = true) {
  const warmups = pilot ? 11 : 101;
  let calls = 0;
  const starts: number[] = [];
  const signals: AbortSignal[] = [];
  const responses: (() => void)[] = [];
  const fake = {
    now: 1000,
    hold: false,
    onSend: (_sample: number) => {},
    wait: async (ms: number) => { fake.now += ms; },
    fetch: ((_url, init) => {
      const call = calls++;
      const measured = call >= warmups;
      const sample = measured ? call - warmups : Math.max(0, call - 1);
      const response = () => new Response(JSON.stringify({
        as_of_seq: sizing('normal').messages,
        history_generation: '00000000-0000-0000-0000-000000000000',
        counts: batch('normal', sample),
      }), { headers: { 'cache-control': 'no-store' } });
      if (!measured) return Promise.resolve(response());
      starts.push(fake.now);
      signals.push(init!.signal!);
      fake.onSend(sample);
      if (!fake.hold) return Promise.resolve(response());
      return new Promise<Response>((resolve, reject) => {
        responses.push(() => resolve(response()));
        init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }) as typeof fetch,
  };
  return { fake, starts, signals, responses, run: () => measure('http://test.invalid/reply-counts', '', 'normal', 0, pilot, () => {}, {
    clock: () => fake.now, wait: ms => fake.wait(ms), fetch: fake.fetch,
  }) };
}

test('open-loop dispatch offers all requests without waiting for any response', async () => {
  const f = fixture();
  f.fake.hold = true;
  let allOffered!: () => void;
  const offered = new Promise<void>(resolve => { allOffered = resolve; });
  f.fake.onSend = sample => { if (sample === 199) allOffered(); };
  let finished = false;
  const task = f.run().then(run => { finished = true; return run; });
  await offered;
  assert.equal(f.starts.length, 200);
  assert.equal(f.responses.length, 200);
  assert.equal(finished, false);
  assert.equal(f.signals.some(signal => signal.aborted), false);
  f.responses.forEach(resolve => resolve());
  const run = await task;
  assert.equal(run.scheduledLatencies.length, 200);
  assert.equal(run.peakInFlight, 200);
  assert.equal(run.errors, 0);
});

test('open-loop dispatch rechecks an early timer wake-up', async () => {
  const f = fixture();
  const waits: number[] = [];
  let early = true;
  f.fake.wait = async ms => {
    waits.push(ms);
    f.fake.now += early ? ms / 2 : ms;
    early = !early;
  };
  const run = await f.run();
  assert.deepEqual(waits.slice(0, 2), [tickMs, tickMs / 2]);
  assert.deepEqual(f.starts, Array.from({ length: 200 }, (_, k) => 1000 + Math.floor(k / perTick) * tickMs));
  assert.equal(run.missedDeadlines, 0);
});

test('a request >= one tick late records the miss and stops without catch-up', async () => {
  for (const lag of [tickMs, tickMs + 1]) {
    const f = fixture();
    // Stall within a batch: the next request must check its own start lag.
    f.fake.onSend = sample => { if (sample === 0) f.fake.now += lag; };
    const run = await f.run();
    assert.deepEqual(f.starts, [1000]);
    assert.deepEqual(run.startLags, [0, lag]);
    assert.equal(run.missedDeadlines, 1);
    assert.equal(run.scheduledLatencies.length, 1);
    assert.equal(run.errors, 0);
  }
});

test('a timer stall >= one tick late stops at the original deadline', async () => {
  const f = fixture();
  f.fake.wait = async ms => { f.fake.now += ms + tickMs; };
  const run = await f.run();
  assert.deepEqual(f.starts, Array(perTick).fill(1000));
  assert.equal(run.startLags.at(-1), tickMs);
  assert.equal(run.missedDeadlines, 1);
});

test('exceeding the in-flight cap aborts every pending request and stops dispatch', async () => {
  const f = fixture(false);
  f.fake.hold = true;
  const run = await f.run();
  assert.equal(f.starts.length, inFlightCap);
  assert.equal(run.peakInFlight, inFlightCap + 1);
  assert.equal(f.signals.every(signal => signal.aborted), true);
  assert.equal(run.errors, inFlightCap);
  assert.equal(run.missedDeadlines, 0);
  assert.equal(run.scheduledLatencies.length, 0);
});

test('every formal request is offered at the scheduled rate', async () => {
  const f = fixture(false);
  const run = await f.run();
  assert.deepEqual(f.starts, Array.from({ length: 10_000 }, (_, k) => 1000 + Math.floor(k / 16) * 100));
  assert.equal(run.scheduledLatencies.length, 10_000);
  assert.deepEqual(run.startLags, Array(10_000).fill(0));
  assert.equal(run.missedDeadlines, 0);
  assert.equal(run.errors, 0);
});
