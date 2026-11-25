import assert from 'node:assert/strict';
import test from 'node:test';
import { block, evidence, floors, session, sets796 } from './frequency-fixture.ts';
import { judgeFrequency } from './frequency-judge.ts';
import { below, restore } from './frequency-ratios.ts';
import { legacyDisagreements } from './frequency-legacy-report.ts';

const judge = (blocks: ReturnType<typeof block>[], host = evidence, min = floors) => judgeFrequency(blocks, sets796, host, session, min);
const work = (cpu: number) => cpu < 8 ? 2_800_000_000n : 0n;
test('worked examples: .92 busy client ratios fail and sparse idle-heavy 1.00 ratios clear', () => {
  const throttled = judge([block(1), block(2, { ratios: cpu => cpu % 2 ? [92n, 100n] : [1n, 1n] })]);
  assert.deepEqual(throttled.reasons, ['block 2: F5 throttled client']);
  const clean = judge([block(1), block(2, { mperf: cpu => cpu === 15 ? 2_000_000n : work(cpu) })]);
  assert.deepEqual(clean.reasons, []);
  assert.deepEqual(clean.blocks[1].sets.client.common, [1, 3, 5, 7]);
  assert.deepEqual(clean.blocks[0].sets.server.qualifying, [0, 2, 4, 6]);
  assert.equal(clean.blocks[1].cpus[15].qualifies, false);
  assert.equal(clean.blocks[0].cpus[15].busyHz, null);
  assert.deepEqual(legacyDisagreements(['block 2: too few active CPUs to judge frequency, client set 0 of 8 qualify'], clean, [1, 2])
    .map(x => [x.block, x.set]), [[2, 'client']]);
});

test('F5 uses the even median and compares exactly at and just below 19/20', () => {
  const ratios = (cpu: number): [bigint, bigint] => cpu < 4 ? [90n, 100n] : [1n, 1n];
  assert.deepEqual(judge([block(1), block(2, { ratios })]).reasons, []);
  const altered = (cpu: number) => cpu < 4 ? [2_519_999_999n, 2_800_000_000n] as [bigint, bigint] : ratios(cpu);
  assert.deepEqual(judge([block(1), block(2, { ratios: altered })]).reasons, ['block 2: F5 throttled server', 'block 2: F5 throttled client']);
});

test('F3 qualifies exactly 1,000 ms, omits below-floor CPUs, and rejects negative and inconsistent deltas', () => {
  const at = judge([block(1, { mperf: cpu => cpu < 8 ? 2_000_000_000n : 1_999_999_999n })]);
  assert.deepEqual(at.reasons, []);
  assert.equal(at.blocks[0].cpus[7].qualifies, true);
  assert.equal(at.blocks[0].cpus[8].qualifies, false);
  for (const aperf of ['0', '2']) {
    const b = block(1);
    b.counters.close.reads[15].aperf = aperf;
    assert.match(judge([b]).reasons.join(), /F3.*CPU 15.*negative or inconsistent/);
  }
});

test('F4 independently needs 4 qualifying CPUs and 4 common CPU IDs', () => {
  const sparse = judge([block(1), block(2, { mperf: cpu => cpu === 7 ? 1_999_999_999n : work(cpu) })]);
  assert.ok(sparse.reasons.includes('block 2: F4 client coverage 3/8'));
  const moved = judge([block(1), block(2, { mperf: cpu => cpu === 7 ? 0n : cpu === 9 ? work(7) : work(cpu) })]);
  assert.deepEqual(moved.reasons, ['block 2: F4 client common coverage 3/8']);
  assert.deepEqual(moved.blocks[1].sets.client.qualifying, [1, 3, 5, 9]);
});

test('F1 binds the helper metadata, true event IDs, full counting time and CPU policy', () => {
  const changes: ((b: ReturnType<typeof block>) => void)[] = [
    b => { b.counters.close.launchSession = 'stale'; },
    b => { b.counters.close.order = 3; },
    b => { b.counters.close.identity = { ...b.counters.close.identity, bootId: 'rebooted' }; },
    b => { b.counters.close.reads[15].mperfId = '9999'; },
    b => { b.counters.close.reads[15].running = String(BigInt(b.counters.close.reads[15].enabled) - 1n); },
    b => { b.counters.policyAfter = { ...b.counters.policyAfter, policies: b.counters.policyAfter.policies.map(p => ({ ...p, min: '700000' })) }; },
  ];
  for (const mutate of changes) {
    const b = block(2);
    mutate(b);
    assert.match(judge([block(1), b]).reasons.join(), /block 2: F1/);
  }
  const different = { ...evidence, after: { ...evidence.after, online: '0-14' } };
  assert.match(judge([block(1)], different).reasons.join(), /F1 policy changed between launch and completion/);
  const jitter = structuredClone(evidence);
  jitter.calibration.open[0].afterNs = '1001000002';
  assert.match(judge([block(1)], jitter).reasons.join(), /F1 TSC calibration bracket exceeds 1 ms/);
});

test('F1 allows counting time to differ from the raw span by exactly 1 ms in either direction', () => {
  for (const [counting, passes] of [
    ['120019000500', true],
    ['120021000500', true],
    ['120019000499', false],
    ['120021000501', false],
  ] as const) {
    const b = block(2);
    const close = b.counters.close.reads[15];
    close.enabled = close.running = counting;
    const { reasons } = judge([block(1), b]);
    if (passes) assert.deepEqual(reasons, [], counting);
    else assert.ok(reasons.includes('block 2: F1 CPU 15: counter identity or counting time changed'), counting);
  }
});

test('F1 accepts a 130 s raw span matching counting time with 2 ms of monotonic slew', () => {
  const b = block(1);
  b.pgbenchWindow.endMs = 150_000;
  b.counters.startNs = '200001000000';
  b.counters.exitNs = '330001000000';
  for (const close of b.counters.close.reads) {
    close.monoNs = String(330_002_000_000n + BigInt(close.cpu));
    close.rawNs = '330000000000';
    close.enabled = close.running = '130000000500';
  }
  assert.deepEqual(judge([b]).reasons, []);
});

test('F1 requires a raw timestamp at both ends of the counting interval', () => {
  for (const phase of ['open', 'close'] as const) {
    const b = block(1);
    Reflect.deleteProperty(b.counters[phase].reads[15], 'rawNs');
    assert.ok(judge([b]).reasons.includes('block 1: invalid unsigned integer'));
  }
});

test('F1 rejects event IDs reused across otherwise valid blocks', () => {
  const first = block(1), second = block(2);
  assert.deepEqual(judge([first, second]).reasons, []);
  second.counters.open.reads[0].aperfId = second.counters.close.reads[0].aperfId = first.counters.open.reads[0].aperfId;
  assert.ok(judge([first, second]).reasons.includes('block 2: F1 reused event IDs or stale block'));
});

test('F1 rejects a block that opens before the previous block closes', () => {
  const first = block(1), second = block(2);
  const shift = BigInt(second.counters.open.reads[0].monoNs) - BigInt(first.counters.close.reads.at(-1)!.monoNs) + 1n;
  for (const read of [...second.counters.open.reads, ...second.counters.close.reads]) read.monoNs = String(BigInt(read.monoNs) - shift);
  second.counters.startNs = String(BigInt(second.counters.startNs) - shift);
  second.counters.exitNs = String(BigInt(second.counters.exitNs) - shift);
  assert.ok(judge([first, second]).reasons.includes('block 2: F1 reused event IDs or stale block'));
});

test('rejects a reference whose checkpoint precedes the previous block closing sweep', () => {
  const first = block(1, { control: true });
  const second = block(2, { control: true, ratios: () => [17n, 20n] });
  const judgeControl = () => judgeFrequency([first, second], sets796, evidence, session, null, true).reasons;
  const expected = ['block 2: F5 throttled server', 'block 2: F5 throttled client'];
  assert.deepEqual(judgeControl(), expected);

  const closingSweep = BigInt(first.counters.close.reads.at(-1)!.monoNs);
  second.counters.reference!.checkpointNs = String(closingSweep - 1n);
  assert.deepEqual(judgeControl(), ['reference 2: stale reference or overlap with measured block', ...expected]);
});

test('F2 bounds perf slack and requires opening before launch and closing after exit', () => {
  assert.deepEqual(judge([block(1, { slack: 2_979_999_985n })]).reasons, []); // exactly 3 s total
  assert.match(judge([block(1, { slack: 2_979_999_986n })]).reasons.join(), /F2.*3 s slack/);
  const b = block(1);
  b.counters.startNs = b.counters.open.reads[0].monoNs;
  assert.match(judge([b]).reasons.join(), /F2.*boundaries/);
  const close = block(1);
  close.counters.exitNs = String(BigInt(close.counters.close.reads[0].monoNs) + 1n);
  assert.match(judge([close]).reasons.join(), /F2.*boundaries/);
});

test('F6 rejects even one missing pair when both sets still have their four voters', () => {
  const b = block(1);
  b.counters.close.reads.pop();
  assert.match(judge([b]).reasons.join(), /F6 missing.*CPU pair/);
});

test('F7 hardware at the policy endpoint can vote and block 1 uses the exact absolute floor', () => {
  const at = judge([block(1, { ratios: () => [19n, 20n] })]);
  assert.deepEqual(at.reasons, []);
  assert.equal(at.blocks[0].sets.server.floorMet, true);
  const baseline = judge([block(1)]);
  const proposed = restore(baseline.floorProposal!.server);
  assert.ok(!below(proposed, [1_900_000_000n, 1n]) && !below([1_900_000_000n, 1n], proposed));
  assert.deepEqual(judge([block(1, { ratios: () => [2_659_999_999n, 2_800_000_000n] })]).reasons,
    ['block 1: floor server below reviewed minimum', 'block 1: floor client below reviewed minimum']);
  assert.match(judgeFrequency([block(1)], sets796, evidence, session, null).reasons.join(), /floors missing/);
});

function checkBound(stored: NonNullable<typeof floors.server> | null, n: bigint, d: bigint) {
  assert.ok(stored);
  const [a, b] = restore(stored);
  assert.equal(a * d, b * n);
}
const all = () => 2_800_000_000n;
const fiveSlow = (cpu: number): [bigint, bigint] => cpu < 10 ? [94n, 100n] : [1n, 1n];

test('F5 eight cohort votes give a throttled median of 0.94', () => {
  const got = judge([block(1, { mperf: all }), block(2, { mperf: all, ratios: fiveSlow })]);
  const { f5 } = got.blocks[1].sets.client;
  assert.equal(f5?.verdict, 'throttled');
  checkBound(f5!.lower, 94n, 100n);
  checkBound(f5!.upper, 94n, 100n);
  assert.ok(got.reasons.includes('block 2: F5 throttled client'));
});

test('F5 two missing slow votes yield [0.94, 1.00] and invalidate the block', () => {
  const got = judge([block(1, { mperf: all }),
    block(2, { mperf: cpu => cpu === 1 || cpu === 3 ? 0n : all(), ratios: fiveSlow })]);
  const { f5 } = got.blocks[1].sets.client;
  assert.equal(f5?.verdict, 'invalid');
  checkBound(f5!.lower, 94n, 100n);
  checkBound(f5!.upper, 1n, 1n);
  assert.ok(got.reasons.includes('block 2: F5 client median bounds straddle 19/20'));
});

test('F5 six capped votes in a seven-CPU cohort bound the upper median at 0.86', () => {
  const got = judge([block(1, { mperf: cpu => cpu === 15 ? 0n : all() }),
    block(2, { mperf: cpu => cpu === 5 ? 0n : all(), ratios: cpu => cpu === 15 ? [3n, 1n] : [86n, 100n] })]);
  const { f5, qualifying, common } = got.blocks[1].sets.client;
  assert.equal(f5?.verdict, 'throttled');
  checkBound(f5!.upper, 86n, 100n);
  assert.ok(qualifying.includes(15));
  assert.ok(!common.includes(15));
});

test('F5 seven restored votes in an eight-CPU cohort bound the lower median at 1.00', () => {
  const got = judge([block(1, { mperf: all }), block(2, { mperf: cpu => cpu === 5 ? 0n : all() })]);
  const { f5 } = got.blocks[1].sets.client;
  assert.equal(f5?.verdict, 'clear');
  checkBound(f5!.lower, 1n, 1n);
  assert.deepEqual(got.reasons, []);
});

test('F5 applies the exact even median when missing votes shift both middle ranks', () => {
  const got = judge([block(1, { mperf: all }),
    block(2, { mperf: cpu => cpu < 2 ? 0n : all(), ratios: cpu => cpu < 8 ? [9n, 10n] : [1n, 1n] })]);
  const { f5 } = got.blocks[1].sets.client;
  checkBound(f5!.lower, 95n, 100n);
  checkBound(f5!.upper, 1n, 1n);
  assert.deepEqual(got.reasons, []);
});

test('F5 represents a missing middle rank as an open bound', () => {
  const got = judge([block(1, { mperf: all }), block(2)]);
  const { f5 } = got.blocks[1].sets.client;
  assert.deepEqual(f5, { lower: null, upper: null, verdict: 'invalid' });
});

test('control qualification and the Hz floors use work before the idle tail', () => {
  const b = block(1, {
    control: true, idleMperf: () => 2_800_000_000n, idleRatios: () => [8n, 10n],
  });
  const got = judgeFrequency([b], sets796, evidence, session, floors, true);
  assert.deepEqual(got.reasons, []);
  assert.equal(got.blocks[0].sets.server.floorMet, true);
  assert.equal(got.blocks[0].cpus[8].qualifies, false);
  assert.equal(got.blocks[0].fullSpanCpus[8].qualifies, true);
  assert.deepEqual(got.blocks[0].sets.server.cohort, [0, 2, 4, 6]);
  const short = block(1, { control: true, mperf: cpu => cpu < 6 ? all() : 0n, idleMperf: all });
  assert.match(judgeFrequency([short], sets796, evidence, session, null, true).reasons.join(), /F4 server coverage 3\/8/);
});

test('capped control requires work and stale-after-work throttling with work-only votes', () => {
  const base = block(1, { control: true, mperf: all });
  const capped = block(2, { control: true, mperf: cpu => cpu === 5 ? 0n : all(),
    ratios: () => [9n, 10n], idleMperf: all, idleRatios: () => [1n, 1n] });
  const assess = () => judgeFrequency([base, capped], sets796, evidence, session, null, true);
  const got = assess();
  assert.equal(got.blocks[1].sets.client.f5?.verdict, 'throttled');
  assert.equal(got.blocks[1].sets.client.fullSpanF5?.verdict, 'clear');
  assert.ok(!got.blocks[1].sets.client.common.includes(5));
  assert.ok(got.blocks[1].fullSpanCpus[5].qualifies);
  assert.match(got.reasons.join(), /client full span must show throttling/);
  const clearWork = block(2, { control: true, mperf: all, idleMperf: all, idleRatios: () => [7n, 10n] });
  const clear = judgeFrequency([base, clearWork], sets796, evidence, session, null, true);
  assert.equal(clear.blocks[1].sets.client.f5?.verdict, 'clear');
  assert.equal(clear.blocks[1].sets.client.fullSpanF5?.verdict, 'throttled');
  assert.match(clear.reasons.join(), /client work interval must show throttling/);
});
