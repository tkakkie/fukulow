import assert from 'node:assert/strict';
import test from 'node:test';
import { block, evidence, floors, session, sets796 } from './frequency-fixture.ts';
import { judgeFrequency } from './frequency-judge.ts';
import { countingAllowanceNs } from './frequency-evidence.ts';
import { below, restore, type StoredRatio } from './frequency-ratios.ts';
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

test('F1 allows counting time to differ from the read clock by 1 ms plus 500 ppm, and no more', () => {
  const shifted = (sign: bigint, extra: bigint) => {
    const b = block(2);
    const open = b.counters.open.reads[15], close = b.counters.close.reads[15];
    const allowance = countingAllowanceNs(BigInt(close.monoNs) - BigInt(open.monoNs));
    close.enabled = close.running = String(BigInt(close.enabled) + sign * (allowance + extra));
    return judge([block(1), b]).reasons.join();
  };
  for (const sign of [1n, -1n]) {
    assert.doesNotMatch(shifted(sign, 0n), /F1 CPU 15/);
    assert.match(shifted(sign, 1n), /block 2: F1 CPU 15: counter identity or counting time changed/);
  }
  // The #796 control on Ubuntu: chrony 14.9 ppm fast gave +1.92 ms over 130.1 s, which the old 1 ms bound rejected.
  assert.ok(countingAllowanceNs(130_100_000_000n) > 1_925_000n);
  assert.equal(countingAllowanceNs(130_000_000_000n), 66_000_000n);
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
  const c = block(1, { control: true, idleMperf: cpu => cpu === 0 || (cpu < 8 && cpu % 2 === 1) ? 10_000_000n : 0n });
  const got = judgeFrequency([c], sets796, evidence, session, null, true);
  const idle = got.blocks[0].idle!;
  assert.deepEqual(idle.cpusAtFloor, [0, 1, 3, 5, 7]);
  assert.deepEqual(idle.couldQualify, { server: false, client: true });
  const { c0Ns, projectedC0Ns, blockSpanNs, idleSpanNs, qualifies, projectedQualifies } = idle.perCpu[1];
  const preTailSpan = BigInt(c.counters.idle!.reads[1].monoNs) - BigInt(c.counters.open.reads[1].monoNs);
  assert.equal(BigInt(blockSpanNs), preTailSpan);
  assert.equal(idleSpanNs, '10000000000');
  assert.equal(BigInt(c0Ns[0]), 5_000_000n * BigInt(c0Ns[1]));
  assert.equal(BigInt(projectedC0Ns[0]) * BigInt(idleSpanNs), 5_000_000n * preTailSpan * BigInt(projectedC0Ns[1]));
  assert.equal(qualifies, false);
  assert.equal(projectedQualifies, true);
  assert.match(got.reasons.join(), /projected idle-only C0 reached 20 ms/);
});

test('control flags projected idle-only C0 at 20 ms but excludes 1 ns below', () => {
  const host = structuredClone(evidence);
  for (const [cpu, close] of host.calibration.close.entries()) {
    close.count = String(BigInt(host.calibration.open[cpu].count) + 3_000_500_000n);
  }
  const c = block(1, { control: true, idleMperf: cpu => cpu < 2 ? 5_000_000n : 0n });
  // At 3.0005 GHz over the 10 s tail, 5 million ticks project to 1 ns per 6,001 ns of pre-tail span.
  for (const open of c.counters.open.reads.slice(1)) {
    open.monoNs = String(BigInt(open.monoNs) + 6_000n);
  }
  const got = judgeFrequency([c], sets796, host, session, null, true);
  const idle = got.blocks[0].idle;
  assert.ok(idle, got.reasons.join(', '));
  for (const [cpu, expectedNs] of [20_000_000n, 19_999_999n].entries()) {
    const [numerator, denominator]: StoredRatio = idle.perCpu[cpu].projectedC0Ns;
    assert.equal(BigInt(numerator), expectedNs * BigInt(denominator));
  }
  assert.deepEqual(idle.perCpu.slice(0, 2).map(cpu => cpu.projectedQualifies), [true, false]);
  assert.deepEqual(idle.cpusAtFloor, [0]);
  assert.deepEqual(got.reasons, ['block 1: projected idle-only C0 reached 20 ms on CPUs 0']);
});

test('control server housekeeping could qualify at 4 of 8 CPUs but fails at 3 of 8', () => {
  for (const count of [3, 4]) {
    const voters = sets796.server.slice(0, count);
    const c = block(1, { control: true, idleMperf: cpu => voters.includes(cpu) ? 10_000_000n : 0n });
    const got = judgeFrequency([c], sets796, evidence, session, null, true);
    const idle = got.blocks[0].idle;
    assert.ok(idle, got.reasons.join(', '));
    assert.deepEqual(idle.cpusAtFloor, voters);
    assert.deepEqual(idle.couldQualify, { server: count === 4, client: false }, `${count} of 8 server CPUs`);
  }
});

test('control clears housekeeping below the projected floor on all CPUs', () => {
  const c = block(1, { control: true, idleMperf: () => 2_000_000n });
  const got = judgeFrequency([c], sets796, evidence, session, null, true);
  assert.deepEqual(got.reasons, []);
  assert.deepEqual(got.blocks[0].idle?.cpusAtFloor, []);
  assert.deepEqual(got.blocks[0].idle?.couldQualify, { server: false, client: false });
});
