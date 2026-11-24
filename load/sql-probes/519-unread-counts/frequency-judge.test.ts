import assert from 'node:assert/strict';
import test from 'node:test';
import { block, evidence, floors, session, sets796 } from './frequency-fixture.ts';
import { judgeFrequency } from './frequency-judge.ts';
import { below, restore } from './frequency-ratios.ts';
import { legacyDisagreements } from './frequency-report.ts';

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

test('F3 qualifies exactly 20 ms, omits below-floor CPUs, and rejects negative and inconsistent deltas', () => {
  const at = judge([block(1, { mperf: cpu => cpu < 8 ? 40_000_000n : 39_999_999n })]);
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
  const sparse = judge([block(1), block(2, { mperf: cpu => cpu === 7 ? 39_999_999n : work(cpu) })]);
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

test('control flags every idle-only voter and 4/8 housekeeping coverage independently', () => {
  const c = block(1, { control: true, idleMperf: cpu => cpu < 7 ? 40_000_000n : 39_999_999n });
  const got = judgeFrequency([c], sets796, evidence, session, null, true);
  assert.deepEqual(got.blocks[0].idle?.cpusAtFloor, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(got.blocks[0].idle?.couldQualify, { server: true, client: false });
  assert.match(got.reasons.join(), /idle-only C0 reached 20 ms/);
});
