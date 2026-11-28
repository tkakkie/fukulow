import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GATE_OFF, holdsFixture } from './revocation-holds-fixture.ts';
import { lessFavourable, median, memoryByCell, memoryEntry, memoryVerdict, rssDeltaKb } from './revocation-holds-memory.ts';

test('memory: FAIL, measured within bound, upper bound only, NOT EVALUATED', () => {
  const faults = (d: number[], hwm = 4096) => d.map(deltaKb => ({ deltaKb, hwm }));
  // B = 8192 KiB at HWM 4096.
  assert.equal(memoryVerdict(faults([10_000, 10_000, 10_000]), [0, 100, 1000]).result, 'FAIL'); // D 9900, N 1000: 8900 > 8192
  assert.equal(memoryVerdict(faults([9_292, 9_292, 9_292]), [0, 100, 1000]).result, 'upper bound only (never PASS)'); // D - N = 8192, not > B
  assert.equal(memoryVerdict(faults([5_000, 5_000, 5_000]), [0, 100, 1000]).result, 'measured within bound'); // D 4900 > N, D + N 5900 <= B
  const upper = memoryVerdict(faults([1_000, 1_100, 1_200]), [0, 100, 1000]); // D 1000 = N: not > N
  assert.deepEqual(upper, { result: 'upper bound only (never PASS)', dKb: 1000, nKb: 1000, bKb: 8192, upperBoundKb: 2000 });
  assert.equal(memoryVerdict(faults([-2000, -2000, -2000]), [0, 100, 1000]).upperBoundKb, 0);
  assert.equal(memoryVerdict(faults([7_292, 7_292, 7_292]), [0, 100, 1000]).result, 'measured within bound'); // D + N = 8192 = B
  assert.equal(memoryVerdict(faults([7_293, 7_293, 7_293]), [0, 100, 1000]).result, 'upper bound only (never PASS)');
  // B scales with the minimum HWM.
  assert.equal(memoryVerdict([{ deltaKb: 5000, hwm: 4096 }, { deltaKb: 5000, hwm: 2048 }, { deltaKb: 5000, hwm: 4096 }], [0, 0, 0]).bKb, 4096);
  assert.equal(memoryVerdict(faults([1, 1]), [0, 0, 0]).result, 'NOT EVALUATED');
  assert.equal(memoryVerdict(faults([1, 1, 1]), [0, 0, NaN]).result, 'NOT EVALUATED');
});

test('RSS delta: peak in [fault, recovery + 10 s) minus the median 10 s before the stall', () => {
  const run = holdsFixture();
  run.rss = [{ at: 30_000, kb: 100 }, { at: 31_000, kb: 300 }, { at: 32_000, kb: 200 }, { at: 37_000, kb: 9_999 }, { at: 40_000, kb: 700 }, { at: 53_499, kb: 900 }, { at: 53_500, kb: 5_000 }];
  assert.equal(rssDeltaKb(run, GATE_OFF), 700);
  assert.ok(Number.isNaN(rssDeltaKb({ ...run, rss: [] }, GATE_OFF)));
  // An even baseline count uses the mean of the two middle samples: 900 - 200.
  run.rss = [{ at: 30_000, kb: 100 }, { at: 31_000, kb: 300 }, { at: 40_000, kb: 900 }];
  assert.equal(rssDeltaKb(run, GATE_OFF), 700);
  assert.deepEqual([median([3, 1, 2]), median([4, 1, 3, 2]), median([])], [2, 2.5, NaN]);
  // The peak window opens when the gate-on statement was sent.
  run.times.gateOn = [39_000, 39_700];
  run.rss = [{ at: 30_000, kb: 100 }, { at: 39_000, kb: 2_100 }];
  assert.equal(rssDeltaKb(run, GATE_OFF), 2_000);
});

test('memory groups use valid runs and each control at the matching nominal recovery', () => {
  const fault = (kb: number) => { const run = holdsFixture(); run.rss = [{ at: 30_000, kb: 0 }, { at: 41_000, kb }]; return run; };
  const control = (shortKb: number, longKb: number) => {
    const run = holdsFixture(); run.kind = 'control'; run.duration = undefined;
    run.times.nominalRecovery = { short: 43_500, long: 55_000 };
    run.rss = [{ at: 30_000, kb: 0 }, { at: 41_000, kb: shortKb }, { at: 60_000, kb: longKb }];
    return run;
  };
  const entries = [
    memoryEntry(fault(5000), 'PASS', 4096), memoryEntry(fault(5000), 'FAIL', 4096), memoryEntry(fault(5000), 'PASS', 4096),
    memoryEntry(fault(1), 'INVALID', 1), ...[0, 0, 0].map(() => memoryEntry(control(1000, 50_000), 'CONTROL', 0)),
  ];
  assert.deepEqual(entries[3].deltaKb, { short: [1, 1] });
  assert.deepEqual(entries[4].deltaKb, { short: [1000, 1000], long: [50_000, 50_000] });
  const groups = memoryByCell(entries);
  assert.deepEqual(groups['H512/short'], { result: 'measured within bound', dKb: 4000, nKb: 0, bKb: 8192 });
  assert.equal(groups['H512/long'].result, 'NOT EVALUATED');
  assert.equal(memoryByCell(entries.slice(0, 6))['H512/short'].result, 'NOT EVALUATED');
  // Exactly three of each: a fourth valid fault or control is ignored.
  const extra = [...entries, memoryEntry(fault(100_000), 'PASS', 4096), memoryEntry(control(90_000, 0), 'CONTROL', 0)];
  assert.deepEqual(memoryByCell(extra)['H512/short'], groups['H512/short']);
  // A valid fault without a holds-end HWM cannot be evaluated.
  const noHwm = [memoryEntry(fault(5000), 'PASS', undefined), ...entries.slice(1)];
  assert.equal(memoryByCell(noHwm)['H512/short'].result, 'NOT EVALUATED');
});

test('memory uses both cutoffs of the gate-off band and reports the less favourable verdict', () => {
  // Sol's case: HWM 512 (B = 1024 KiB), identical controls; fault and control deltas equal, plus a
  // 500 KiB spike after the earliest cutoff (53_500) but before the latest (53_600).
  const fault = (spikeAt: number) => {
    const run = holdsFixture(); run.times.gateOff = [43_500, 43_600];
    run.rss = [{ at: 30_000, kb: 0 }, { at: 41_000, kb: 1000 }, { at: spikeAt, kb: 1500 }];
    return memoryEntry(run, 'PASS', 512);
  };
  const control = () => {
    const run = holdsFixture(); run.kind = 'control'; run.duration = undefined;
    run.times.nominalRecovery = { short: 43_500, long: 55_000 };
    run.rss = [{ at: 30_000, kb: 0 }, { at: 41_000, kb: 1000 }];
    return memoryEntry(run, 'CONTROL', 0);
  };
  assert.deepEqual(fault(53_550).deltaKb, { short: [1000, 1500] });
  const late = [fault(53_550), fault(53_550), fault(53_550), control(), control(), control()];
  assert.deepEqual(memoryByCell(late)['H512/short'], { result: 'upper bound only (never PASS)', dKb: 0, nKb: 0, bKb: 1024, upperBoundKb: 0 });
  // A spike inside both cutoffs is measured.
  const inside = [fault(53_000), fault(53_000), fault(53_000), control(), control(), control()];
  assert.equal(memoryByCell(inside)['H512/short'].result, 'measured within bound');
  // Order: FAIL, NOT EVALUATED, then the larger upper bound.
  const upper = (upperBoundKb: number) => ({ result: 'upper bound only (never PASS)' as const, upperBoundKb });
  assert.equal(lessFavourable({ result: 'measured within bound' }, upper(1)).result, 'upper bound only (never PASS)');
  assert.equal(lessFavourable(upper(9), { result: 'FAIL' }).result, 'FAIL');
  assert.equal(lessFavourable(upper(5), upper(9)).upperBoundKb, 9);
  assert.equal(lessFavourable({ result: 'FAIL' }, { result: 'NOT EVALUATED' }).result, 'FAIL');
});
