import test from 'node:test';
import assert from 'node:assert/strict';
import { batch, id, sizing, scheduleTime, startLag, perTick, tickMs, inFlightCap, stats, judgement, ranges, type Run } from './reply-counts-model.ts';
test('nearest rank percentiles, boundaries, invalid and immutable inputs', () => {
  const a = [5, 1, 3, 2, 4];
  assert.deepEqual(stats(a), { n: 5, p50: 3, p95: 5, p99: 5, max: 5 });
  assert.deepEqual(a, [5, 1, 3, 2, 4]);
  assert.equal(stats(Array.from({ length: 100 }, (_, i) => i + 1)).p95, 95);
  for (const v of [[], [NaN], [Infinity], [-1]]) assert.throws(() => stats(v));
});
test('fixed seed sizing and 100 distinct mixed anchors with exact root totals', () => {
  assert.deepEqual(sizing('normal'), { roots: 25000, normalReplies: 74997, normalMessages: 99997, longReplies: 0, messages: 99997 });
  assert.equal(sizing('long10000').messages, 109998);
  assert.equal(sizing('long100000').messages, 199998);
  for (const s of ['normal', 'long10000', 'long100000'] as const) {
    for (const sample of [0, 1, 9999]) {
      const b = batch(s, sample);
      assert.equal(b.length, 100); assert.equal(new Set(b.map(a => a.message_id)).size, 100);
      assert.ok(b.some(a => a.message_id !== a.root_id));
      assert.deepEqual(batch(s, sample), b);
      if (s !== 'normal') {
        const long = b.filter(a => a.reply_count === sizing(s).longReplies);
        assert.equal(long.length, 50); assert.ok(long.some(a => a.message_id === a.root_id));
      }
    }
  }
  let seq = 25000;
  const lastReply = new Map<string, string>();
  for (let r = 1; r <= 25000; r++) {
    seq += r % 7;
    lastReply.set(id(r), id(seq));
  }
  // Verify descendant arithmetic against an independent cumulative oracle.
  for (let sample = 0; sample < 100; sample++) {
    for (const a of batch('normal', sample).filter(a => a.message_id !== a.root_id)) {
      assert.equal(a.message_id, lastReply.get(a.root_id));
    }
  }
});
const run = (repeat: number, ms = 50): Run => ({ scenario: 'normal', repeat, errors: 0, scheduledLatencies: Array(10000).fill(ms), sendLatencies: Array(10000).fill(1), startLags: Array(10000).fill(0), missedDeadlines: 0, peakInFlight: 2, firstMs: 1, seconds: 1 });
test('fixed targets cannot pass pilot, incomplete, missing, errors or target miss', () => {
  const rows = [run(0), run(1), run(2)];
  assert.equal(judgement('normal', rows, true, true), 'PASS');
  assert.equal(judgement('normal', rows, false, true), 'NOT EVALUATED');
  // Setup/interrupt failures leave completion false.
  assert.equal(judgement('normal', rows, true, false), 'NOT EVALUATED');
  assert.equal(judgement('normal', [], true, false), 'NOT EVALUATED');
  assert.equal(judgement('normal', rows.slice(1), true, true), 'NOT EVALUATED');
  assert.equal(judgement('normal', [run(0), run(0), run(2)], true, true), 'NOT EVALUATED');
  assert.equal(judgement('normal', [run(0, 50.001)], true, true), 'FAIL');
  assert.equal(judgement('normal', [{ ...run(0), errors: 1 }], true, true), 'FAIL');
  assert.equal(judgement('normal', rows.map(r => ({ ...r, seconds: 0 })), true, true), 'NOT EVALUATED');
  const long = rows.map(r => ({ ...r, scenario: 'long100000' as const, scheduledLatencies: Array(10000).fill(200) }));
  assert.equal(judgement('long100000', long, true, true), 'PASS');
  long[0].scheduledLatencies.fill(200.01);
  assert.equal(judgement('long100000', long, true, true), 'FAIL');
  assert.deepEqual(ranges([run(0, 10), run(1, 20)]).p95, [10, 20]);
});

test('absolute open-loop schedule never depends on response completion', () => {
  assert.equal(perTick, 16);
  assert.equal(tickMs, 100);
  for (const k of [0, 1, 15]) assert.equal(scheduleTime(123, k), 123);
  assert.equal(scheduleTime(123, 16), 223);
  assert.equal(scheduleTime(123, 9999), 123 + 624 * 100);
  // 10,000 requests span 624 ticks: 160/s offered, independent of responses.
  assert.equal(scheduleTime(0, 9999) - scheduleTime(0, 0), 62400);
});
test('start lag misses only strictly beyond one interval', () => {
  assert.deepEqual(startLag(100, 99), { lagMs: 0, missed: false });
  assert.deepEqual(startLag(100, 100), { lagMs: 0, missed: false });
  assert.deepEqual(startLag(100, 199.999), { lagMs: 99.999, missed: false });
  assert.deepEqual(startLag(100, 200), { lagMs: 100, missed: true });
  assert.equal(startLag(100, 1000).missed, true);
});
test('missed deadlines invalidate even a low p95; overload and scheduled latency fail', () => {
  const rows = [run(0), run(1), run(2)];
  assert.equal(judgement('normal', [{ ...run(0), missedDeadlines: 1 }, ...rows.slice(1)], true, true), 'NOT EVALUATED');
  assert.equal(judgement('normal', [{ ...run(0, 100), missedDeadlines: 1 }], true, false), 'NOT EVALUATED');
  assert.equal(judgement('normal', [{ ...run(0), peakInFlight: inFlightCap + 1 }], true, false), 'FAIL');
  assert.equal(judgement('normal', [{ ...run(0), peakInFlight: inFlightCap + 1, missedDeadlines: 1 }], true, false), 'FAIL');
  assert.equal(judgement('normal', rows.map(r => ({ ...r, peakInFlight: inFlightCap })), true, true), 'PASS');
  assert.equal(judgement('normal', [run(0, 50.001)], true, true), 'FAIL');
  assert.equal(judgement('normal', rows.map(r => ({ ...r, sendLatencies: Array(10000).fill(999) })), true, true), 'PASS');
});
