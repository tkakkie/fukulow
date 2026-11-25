import assert from 'node:assert/strict';
import test from 'node:test';
import { assessReference } from './frequency-reference.ts';
import { referenceRates, type ReferenceWindow } from './frequency-evidence.ts';
import { block, evidence, floors, policy, referenceWindow, session, sets796 } from './frequency-fixture.ts';
import { judgeFrequency } from './frequency-judge.ts';

const rates = referenceRates(evidence.calibration);
const assess = (window: ReferenceWindow) => assessReference(window, 1, session, evidence.calibration.identity, policy, rates);
// The fixture's 120.12 s elapsed span normalizes these ticks to exactly 500 and 1,000 ms at 2 GHz.
const normalized = (mperf: (cpu: number) => bigint) => referenceWindow(1, { mperf, slack: 100_000_000n });

test('references stop at exactly 500 ms normalized and accept one tick below', () => {
  const window = normalized(cpu => cpu === 13 ? 1_001_000_000n : 0n);
  const at = assess(window);
  assert.deepEqual(at.reasons, ['reference 1: client CPU 13 reached 500 ms C0 normalized to 120 s']);
  assert.equal(at.sets.client.maxCpu, 13);
  assert.equal(at.sets.client.n_F, 0);
  const [n, d] = at.sets.client.maxC0Ns.map(BigInt);
  assert.equal(n, 500_000_000n * d);
  const [mn, md] = at.sets.client.floorMargin!.map(BigInt);
  assert.equal(mn, 2n * md);
  const [hn, hd] = at.sets.client.halfFloorMargin!.map(BigInt);
  assert.equal(hn, hd);
  assert.deepEqual(assess(normalized(cpu => cpu === 13 ? 1_000_999_999n : 0n)).reasons, []);
});

test('references flag exactly 1,000 ms normalized on three of six CPUs in either set', () => {
  for (const set of ['client', 'server'] as const) {
    for (const count of [2, 3]) {
      const voters = sets796[set];
      const got = assess(normalized(cpu => voters.slice(0, count).includes(cpu) ? 2_002_000_000n
        : cpu === voters[count] ? 2_001_999_999n : 0n));
      assert.equal(got.sets[set].n_F, count);
      assert.equal(got.reasons.includes(`reference 1: ${set} n_F=3/6 reached 3`), count === 3);
      assert.ok(got.reasons.some(r => r.includes('500 ms')));
    }
  }
});

test('references retain housekeeping C0 without giving those CPUs a STOP vote', () => {
  const got = assess(normalized(cpu => sets796.housekeeping.includes(cpu) ? 2_002_000_000n : 0n));
  assert.deepEqual(got.reasons, []);
  assert.equal(got.cpus[0].qualifies, true);
  assert.equal(got.sets.client.n_F, 0);
  assert.equal(got.sets.server.n_F, 0);
});

test('references require a settled full window with matching CPU, policy, counter and session evidence', () => {
  const cases: [RegExp, (w: ReferenceWindow) => void][] = [
    [/shorter than 120 s/, w => { w.exitNs = String(BigInt(w.exitNs) - 1n); }],
    [/before 30 s checkpoint settle/, w => { w.checkpointNs = String(BigInt(w.checkpointNs) + 1n); }],
    [/F6 missing.*CPU pair/, w => { w.close.reads.pop(); }],
    [/F1 foreign or stale/, w => { w.close.launchSession = 'foreign'; }],
    [/F1 policy changed/, w => { w.policyBefore = { ...policy, boost: '1' }; }],
    [/F1 CPU 1/, w => { w.close.reads[1].enabled = '1'; }],
  ];
  for (const [match, mutate] of cases) {
    const window = referenceWindow(1);
    mutate(window);
    assert.throws(() => assess(window), match);
  }
});

test('report rejects missing, extra, overlapping and reused reference evidence', () => {
  const judge = (blocks: ReturnType<typeof block>[], control = false) =>
    judgeFrequency(blocks, sets796, evidence, session, control ? null : floors, control);
  const first = block(1);
  const second = block(2);
  assert.deepEqual(judge([first, second]).reasons, []);
  const extra = structuredClone(second);
  extra.counters.reference = referenceWindow(2);
  assert.match(judge([first, extra]).reasons.join(), /reference 2: unexpected/);
  const missing = structuredClone(first);
  delete missing.counters.reference;
  assert.match(judge([missing]).reasons.join(), /reference 1: missing/);
  const overlap = structuredClone(first);
  const window = overlap.counters.reference!;
  const shift = (value: string) => String(BigInt(value) + 40_000_000_000n);
  for (const r of [...window.open.reads, ...window.close.reads]) r.monoNs = shift(r.monoNs);
  window.checkpointNs = shift(window.checkpointNs);
  window.startNs = shift(window.startNs);
  window.exitNs = shift(window.exitNs);
  assert.deepEqual(assess(window).reasons, []);
  assert.match(judge([overlap]).reasons.join(), /reference 1: stale reference or overlap/);
  const busy = structuredClone(first);
  busy.counters.reference = normalized(cpu => cpu === 13 ? 1_001_000_000n : 0n);
  assert.match(judge([busy]).reasons.join(), /reference 1: client CPU 13 reached 500 ms/);
  const duplicate = structuredClone(first);
  for (const phase of ['open', 'close'] as const) {
    duplicate.counters.reference![phase].reads[0].aperfId = duplicate.counters[phase].reads[0].aperfId;
  }
  assert.match(judge([duplicate]).reasons.join(), /reference 1: F1 reused event IDs/);
  const controls = [block(1, { control: true }), block(2, { control: true, ratios: () => [17n, 20n] }), block(3, { control: true })];
  assert.deepEqual(judge(controls, true).reasons, ['block 2: F5 throttled server', 'block 2: F5 throttled client']);
  delete controls[2].counters.reference;
  assert.match(judge(controls, true).reasons.join(), /reference 3: missing/);
});

test('report retains the first F1 block failure when old reference evidence is absent', () => {
  const first = block(1, { control: true });
  delete first.counters.reference;
  first.counters.close.reads[0].enabled = '1000';
  const result = judgeFrequency([first], sets796, evidence, session, null, true);
  assert.equal(result.reasons[0], 'block 1: F1 CPU 0: counter identity or counting time changed');
  assert.ok(result.reasons.includes('reference 1: missing settled reference'));
});
