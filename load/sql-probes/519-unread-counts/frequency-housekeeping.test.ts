import assert from 'node:assert/strict';
import test from 'node:test';
import { cpus796 } from './frequency-evidence.ts';
import { housekeepingSampler, workloadCgroup } from './frequency-housekeeping.ts';
import { block, evidence, floors, session, sets796 } from './frequency-fixture.ts';
import { judgeFrequency } from './frequency-judge.ts';

const workload = '/fukulow796.slice';
const capture = (count: number) => housekeepingSampler(workload, 100, path => {
  if (path === '/proc/stat') return cpus796.map(cpu => `cpu${cpu} 0 0 0 0 0 ${count} ${count * 2} 0`).join('\n');
  if (path === '/proc/softirqs') return `${cpus796.map(cpu => `CPU${cpu}`).join(' ')}\nNET_RX: ${cpus796.map(() => count).join(' ')}\n`;
  const usec = path.includes(workload) ? count * 20_000_000 : count * 1000;
  return `usage_usec ${usec}\nuser_usec ${usec / 2}\nsystem_usec ${usec / 2}\n`;
}).sample();

test('housekeeping reports host-wide C0 minus workload usage, cgroups, IRQs and the aggregate burst ratio', () => {
  assert.equal(workloadCgroup('42', () => `0::${workload}\n`), workload);
  assert.equal(workloadCgroup('42', () => '0::/../invalid\n'), null);
  const first = block(1, { mperf: cpu => cpu < 8 ? 2_800_000_000n : 0n });
  const reference = first.counters.reference!;
  first.counters.housekeeping = { workload, ticksPerSecond: 100, open: capture(1), close: capture(5) };
  reference.housekeeping = { workload, ticksPerSecond: 100, open: capture(1), close: capture(2) };
  const got = judgeFrequency([first], sets796, evidence, session, floors);
  assert.deepEqual(got.reasons, []);
  const { work, aggregateBurstRatio } = got.blocks[0].housekeeping;
  assert.equal(work?.c0Usec, 11_200_000);
  assert.equal(work?.c0MinusUsageUsec, -68_800_000);
  assert.deepEqual(work?.cgroups[workload], { usage_usec: 80_000_000, user_usec: 40_000_000, system_usec: 40_000_000 });
  assert.deepEqual(work?.perCpu[15], { cpu: 15, procStatTicks: [0, 0, 0, 0, 0, 4, 8, 0],
    irqTicks: 4, softirqTicks: 8, softirqs: { NET_RX: 4 } });
  assert.equal(aggregateBurstRatio, 4);
  first.counters.housekeeping.close.cgroups[workload] = null;
  const missing = judgeFrequency([first], sets796, evidence, session, floors);
  assert.deepEqual(missing.reasons, []);
  assert.equal(missing.blocks[0].housekeeping.work?.c0MinusUsageUsec, null);
});

test('control burst ratio uses the largest of all three reference aggregates', () => {
  const blocks = [
    block(1, { control: true }), block(2, { control: true, ratios: () => [17n, 20n] }), block(3, { control: true }),
  ];
  for (const b of blocks) {
    b.counters.reference!.housekeeping = { workload, ticksPerSecond: 100, open: capture(1), close: capture(b.order + 1) };
  }
  blocks[0].counters.housekeeping = { workload, ticksPerSecond: 100, open: capture(1), idle: capture(7), close: capture(8) };
  const judge = () => judgeFrequency(blocks, sets796, evidence, session, null, true);
  const got = judge();
  assert.equal(got.blocks[0].housekeeping.aggregateBurstRatio, 2);
  assert.deepEqual(got.reasons, ['block 2: F5 throttled server', 'block 2: F5 throttled client']);
  delete blocks[2].counters.reference!.housekeeping;
  assert.equal(judge().blocks[0].housekeeping.aggregateBurstRatio, null);
  assert.deepEqual(judge().reasons, got.reasons);
});

test('control housekeeping reports the work and tail snapshots without changing F4', () => {
  const first = block(1, { control: true, mperf: cpu => cpu < 5 ? 2_800_000_000n : 0n, idleMperf: () => 2_800_000_000n });
  const run = () => judgeFrequency([first], sets796, evidence, session, null, true);
  const without = run();
  first.counters.housekeeping = { workload, ticksPerSecond: 100, open: capture(1), idle: capture(2), close: capture(5) };
  const withSnapshots = run();
  assert.deepEqual(withSnapshots.reasons, without.reasons);
  assert.match(withSnapshots.reasons.join(), /F4 client coverage 2\/6/);
  assert.equal(withSnapshots.blocks[0].housekeeping.work?.perCpu[0].irqTicks, 1);
  assert.equal(withSnapshots.blocks[0].housekeeping.tail?.perCpu[0].irqTicks, 3);
});
