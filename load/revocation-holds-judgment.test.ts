import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHANNELS, holdsFixture, sample, target, TIMES } from './revocation-holds-fixture.ts';
import { floors, holdsReasons, holdsValues, setupReasons, stallReasons } from './revocation-holds-floors.ts';
import { faultWindowReasons, holdsEndReasons, judgeHolds, verdictByCell, type HoldsRun } from './revocation-holds-judgment.ts';
import { memoryByCell, memoryEntry, memoryVerdict, rssDeltaKb } from './revocation-holds-memory.ts';
import { noticeCorrectness } from './revocation-holds-notices.ts';

const reasons = (run: HoldsRun) => { const j = judgeHolds(run); return [...j.floorReasons, ...j.reasons]; };

test('a clean H512 short run passes every floor and gate', () => {
  const judged = judgeHolds(holdsFixture());
  assert.deepEqual(judged.floorReasons, []);
  assert.deepEqual(judged.reasons, []);
  assert.equal(judged.verdict, 'PASS');
  assert.equal(judged.floors.hwm, 512);
  assert.equal(judged.floors.retriesInFault, 1536);
});

test('floor 1: sockets, mutations, restore, baseline probes, calibrations and samples', () => {
  const cases: [string, (run: HoldsRun) => void][] = [
    ['not every socket was ready', run => { run.targets[3].subscribed = false; }],
    ['not every socket was ready', run => { run.setup.bystandersReady = 1023; }],
    ['a revoke mutation failed or completed after the fault started', run => { run.accounts[0].revokeStatus = 409; }],
    ['a revoke mutation failed or completed after the fault started', run => { run.accounts[0].revokedAt = TIMES.fault; }],
    ['missing baseline probes', run => { run.httpProbe = run.httpProbe.filter(p => p.at < 26_000 || p.at >= 36_000); }],
    ['a clock calibration is invalid', run => { run.setup.calibrationErrors = ['missing or ambiguous server clock sample']; }],
    ['no holds sample in the baseline window', run => { run.samples = run.samples.filter(s => s.serverMs < 26_000 || s.serverMs >= 36_000); }],
    ['no holds sample in the fault window', run => { run.samples = run.samples.filter(s => s.serverMs < 39_700 || s.serverMs >= 43_500); }],
    ['no holds sample in the recovery window', run => { run.samples = run.samples.filter(s => s.serverMs < 43_500 || s.serverMs >= 53_500); }],
    ['no holds sample at or after recovery + 10 s', run => { run.samples = run.samples.filter(s => s.serverMs < 53_500); }],
  ];
  for (const [reason, mutate] of cases) {
    const run = holdsFixture(); mutate(run);
    assert.ok(setupReasons(run).includes(reason), reason);
    assert.equal(judgeHolds(run).verdict, 'INVALID');
  }
  const edge = holdsFixture(); edge.accounts[0].revokedAt = TIMES.fault - 0.001;
  assert.deepEqual(setupReasons(edge), []);
  const fence = holdsFence();
  assert.deepEqual(setupReasons(fence), []);
  fence.accounts[1].restoreStatus = 0;
  assert.ok(setupReasons(fence).includes('the restore mutation failed'));
});

test('floor 2: backlog after resume, no send before the fault, no close before resume', () => {
  assert.deepEqual(stallReasons(holdsFixture()), []);
  const noBytes = holdsFixture(); noBytes.targets[5].stall.reads = [{ at: 1_000, bytes: 200 }];
  assert.deepEqual(stallReasons(noBytes), ['a target socket shows no stalled backlog']);
  const noMessage = holdsFixture(); noMessage.targets[5].stallMessagesAt = [TIMES.resume - 1];
  assert.deepEqual(stallReasons(noMessage), ['a target socket shows no stalled backlog']);
  const neverPaused = holdsFixture(); neverPaused.targets[0].stall.pausedAt = [];
  assert.deepEqual(stallReasons(neverPaused), ['a target socket shows no stalled backlog']);
  const atResume = holdsFixture(); atResume.targets[5].stallMessagesAt = [TIMES.resume];
  assert.deepEqual(stallReasons(atResume), []);
  // offset 0 ± 1, U = 2: a send at 39_697 is certainly before the fault at 39_700; 39_698 is not.
  const early = holdsFixture(); early.sendTiming!.records[0] = { channelId: 'c0', beforeMs: 39_696, afterMs: 39_696.99 };
  assert.deepEqual(stallReasons(early), ['1 revoked-Channel sends before the fault (socket loop not blocked)']);
  const edge = holdsFixture(); edge.sendTiming!.records[0] = { channelId: 'c0', beforeMs: 39_698, afterMs: 39_698 };
  assert.deepEqual(stallReasons(edge), []);
  const closed = holdsFixture(); closed.targets[2].close = { at: TIMES.resume - 1, code: 1008 };
  assert.deepEqual(stallReasons(closed), ['a target socket closed before resume']);
  const proxyClosed = holdsFixture(); proxyClosed.targets[2].stall.closes = [{ at: TIMES.resume - 1, side: 'upstream' }];
  assert.deepEqual(stallReasons(proxyClosed), ['a target socket closed before resume']);
  const closedAfter = holdsFixture(); closedAfter.targets[2].close = { at: TIMES.resume, code: 1008 };
  assert.deepEqual(stallReasons(closedAfter), []);
});

test('floor 3: the high-water mark reaches 0.75 x min(T, 4096)', () => {
  const at = (hwm: number) => { const run = holdsFixture(); run.samples = run.samples.map(s => ({ ...s, highWaterMark: s.serverMs >= 39_750 ? hwm : 0 })); return run; };
  assert.deepEqual(holdsReasons(at(384), holdsValues(at(384))).filter(r => r.startsWith('high')), []);
  assert.deepEqual(holdsReasons(at(383), holdsValues(at(383))).filter(r => r.startsWith('high')), ['high-water mark 383 < 384']);
  const hcap = holdsFixture(); hcap.cell = 'Hcap';
  const values = holdsValues(hcap);
  assert.equal(values.potentialHolds, 6144);
  assert.equal(values.hwmFloor, 3072);
  assert.equal(values.globalCapFloor, 1024);
  hcap.samples = hcap.samples.map(s => ({ ...s, highWaterMark: s.serverMs >= 39_750 ? 4096 : 0, retryAttempts: s.serverMs >= 41_800 ? 8192 : 0 }));
  hcap.metrics!.revocation_retired_global_cap = 1024;
  assert.deepEqual(holdsReasons(hcap, holdsValues(hcap)), []);
  hcap.metrics!.revocation_retired_global_cap = 1023;
  assert.deepEqual(holdsReasons(hcap, holdsValues(hcap)), ['global-cap refusals 1023 < 1024']);
  delete hcap.metrics!.revocation_retired_global_cap;
  assert.deepEqual(holdsReasons(hcap, holdsValues(hcap)), ['global-cap refusals missing < 1024']);
});

function holdsFence(duration: 'short' | 'long' = 'short') {
  const run = holdsFixture();
  run.cell = 'Hfence'; run.duration = duration;
  run.revokedChannels = Array.from({ length: 64 }, (_, i) => `c${i}`);
  run.targets = Array.from({ length: 64 }, (_, i) => target(i));
  run.accounts = [run.accounts[0], { revokeStartedAt: 37_000, revokedAt: 37_200, revokeStatus: 200, restoreStartedAt: 42_000, restoredAt: 42_050, restoreStatus: 200 }];
  run.notices = []; run.sendTiming!.records = [];
  run.samples = run.samples.map(s => ({ ...s, highWaterMark: s.serverMs >= 39_750 ? 4096 : 0, retryAttempts: s.serverMs >= 41_800 ? 3 * 4096 : 0 }));
  run.metrics = { ...run.metrics!, revocation_held: 4096, revocation_delivered_after_hold: 0, revocation_retired_fenced: 2048, revocation_retired_retries: 1536 };
  return run;
}

test('floor 3 for Hfence needs half of Account 2 fenced; floor 5 uses L = HWM - fenced', () => {
  const run = holdsFence();
  assert.equal(holdsValues(run).fencedFloor, 1024);
  run.metrics!.revocation_retired_fenced = 1024;
  assert.deepEqual(holdsReasons(run, holdsValues(run)), []);
  run.metrics!.revocation_retired_fenced = 1023;
  assert.deepEqual(holdsReasons(run, holdsValues(run)), ['fenced holds 1023 < 1024']);
  const long = holdsFence('long');
  // L = 4096 - 2048; 0.75 x L = 1536.
  assert.equal(holdsValues(long).longHolds, 2048);
  assert.deepEqual(holdsReasons(long, holdsValues(long)), []);
  long.metrics!.revocation_retired_retries = 1535;
  assert.deepEqual(holdsReasons(long, holdsValues(long)), ['retired by retries 1535 < 1536']);
});

test('floor 4: short-fault retries inside the fault reach 2 x HWM, counted conservatively', () => {
  const run = holdsFixture();
  run.samples = run.samples.map(s => ({ ...s, retryAttempts: s.serverMs >= 41_800 ? 1024 : 0 }));
  assert.deepEqual(holdsReasons(run, holdsValues(run)), []);
  run.samples = run.samples.map(s => ({ ...s, retryAttempts: s.serverMs >= 41_800 ? 1023 : 0 }));
  assert.deepEqual(holdsReasons(run, holdsValues(run)), ['retry attempts in the fault 1023 < 1024']);
  // Retries counted only after the last sample certainly inside the fault do not count.
  const late = holdsFixture();
  late.samples = late.samples.map(s => ({ ...s, retryAttempts: s.serverMs >= 43_500 ? 5000 : 0 }));
  assert.equal(holdsValues(late).retriesInFault, 0);
  assert.deepEqual(holdsValues(late).retryWindowServerMs, [39_750, 43_250]);
  // A long run is held to floor 5 instead.
  const long = holdsFixture(); long.duration = 'long';
  long.samples = long.samples.map(s => ({ ...s, retryAttempts: 0 }));
  long.metrics!.revocation_retired_retries = 384;
  assert.deepEqual(holdsReasons(long, holdsValues(long)), []);
  long.metrics!.revocation_retired_retries = 383;
  assert.deepEqual(holdsReasons(long, holdsValues(long)), ['retired by retries 383 < 384']);
  delete long.metrics!.revocation_retired_retries;
  assert.deepEqual(holdsReasons(long, holdsValues(long)), ['retired by retries missing < 384']);
});

test('INVALID wins over FAIL, and controls never PASS or FAIL', () => {
  const run = holdsFixture();
  run.targets[0].close = { at: 1, code: 1008 };
  run.bystanderCloses = 3;
  const judged = judgeHolds(run);
  assert.equal(judged.verdict, 'INVALID');
  assert.deepEqual(judged.reasons, []);
  const control = holdsFixture(); control.kind = 'control'; control.duration = undefined;
  control.samples = control.samples.map(s => ({ ...s, highWaterMark: 0, activeHolds: 0, retryAttempts: 0 }));
  control.bystanderCloses = 3;
  assert.equal(judgeHolds(control).verdict, 'CONTROL');
  control.accounts[0].revokeStatus = 500;
  assert.equal(judgeHolds(control).verdict, 'INVALID');
  assert.deepEqual(floors(control).reasons, ['a revoke mutation failed or completed after the fault started']);
});

test('fault-window gates: probes healthy, HTTP all successful, no pool timeouts', () => {
  assert.deepEqual(faultWindowReasons(holdsFixture()), []);
  const dbFail = holdsFixture(); dbFail.dbProbe[800] = { ...dbFail.dbProbe[800], ok: false };
  assert.deepEqual(faultWindowReasons(dbFail), ['1 database probe failures in the fault window']);
  // Baseline p99 1 ms -> limit max(5, 25) = 25 ms.
  const slow = (ms: number) => { const run = holdsFixture(); run.dbProbe = run.dbProbe.map(p => p.at >= 39_700 && p.at < 43_500 ? { ...p, ms } : p); return run; };
  assert.deepEqual(faultWindowReasons(slow(25)), []);
  assert.deepEqual(faultWindowReasons(slow(25.5)), ['fault-window database probe p99 25.50 ms > 25.00 ms']);
  const httpSlow = holdsFixture(); httpSlow.httpProbe = httpSlow.httpProbe.map(p => p.at >= 39_700 && p.at < 43_500 ? { ...p, ms: 101 } : p);
  assert.deepEqual(faultWindowReasons(httpSlow), ['fault-window HTTP probe p99 101.00 ms > 100.00 ms']);
  const httpFail = holdsFixture(); httpFail.httpProbe[800] = { ...httpFail.httpProbe[800], ok: false, status: 503 };
  assert.deepEqual(faultWindowReasons(httpFail), ['1 HTTP probe failures in the fault window']);
  const after = holdsFixture(); after.httpProbe[1000] = { ...after.httpProbe[1000], ok: false, status: 503 }; // at 50_000
  assert.deepEqual(faultWindowReasons(after), ['1 HTTP probe failures in the 10 s after recovery']);
  const late = holdsFixture(); late.httpProbe[1070] = { ...late.httpProbe[1070], ok: false, status: 503 }; // at 53_500
  assert.deepEqual(faultWindowReasons(late), []);
  const pool = holdsFixture(); pool.pool[2].fields.acquire_timeout = 2;
  assert.ok(faultWindowReasons(pool).includes('2 pool acquire timeouts in the fault window'));
  const noPool = holdsFixture(); noPool.pool = [];
  assert.ok(faultWindowReasons(noPool).includes('pool acquire timeouts unavailable in the fault window'));
  const none = holdsFixture(); none.dbProbe = none.dbProbe.filter(p => p.at < 39_700 || p.at >= 43_500);
  assert.deepEqual(faultWindowReasons(none), ['no database or HTTP probe in the fault window']);
});

test('the #592 recovery rules still apply', () => {
  const slow = holdsFixture(); slow.dbProbe = slow.dbProbe.map(p => p.at >= 43_500 && p.at < 53_500 ? { ...p, ms: 40 } : p);
  assert.ok(reasons(slow).some(r => r.startsWith('database probe p99')));
  const pool = holdsFixture(); pool.pool[3].fields.acquire_timeout = 1;
  assert.ok(reasons(pool).includes('1 pool acquire timeouts after recovery'));
});

test('holds end: zero active holds, no timeouts, no bystander closes, residual >= 0', () => {
  assert.deepEqual(holdsEndReasons(holdsFixture()), []);
  // The first sample certainly at or after 53_500 is 53_750 (low 53_749); 53_500 (low 53_499) is not.
  const before = holdsFixture(); before.samples = before.samples.map(s => s.serverMs === 53_500 ? { ...s, activeHolds: 7 } : s);
  assert.deepEqual(holdsEndReasons(before), []);
  const active = holdsFixture(); active.samples = active.samples.map(s => s.serverMs === 53_750 ? { ...s, activeHolds: 1 } : s);
  assert.deepEqual(holdsEndReasons(active), ['1 active holds at recovery + 10 s']);
  const timeout = holdsFixture(); timeout.metrics!.revocation_retired_timeout = 1;
  assert.ok(holdsEndReasons(timeout).includes('1 holds retired by timeout'));
  const bystander = holdsFixture(); bystander.bystanderCloses = 1;
  assert.deepEqual(holdsEndReasons(bystander), ['1 bystander sockets closed during the run']);
  const residual = holdsFixture(); residual.metrics!.revocation_held = 511;
  assert.ok(holdsEndReasons(residual).includes('hold residual -1 < 0'));
  const missing = holdsFixture(); delete missing.metrics;
  assert.deepEqual(holdsEndReasons(missing), ['no metrics event after the holds resolved']);
  const drain = holdsFixture(); drain.notices[0].at = 53_501;
  assert.ok(holdsEndReasons(drain).includes('a revocation arrived after the drain limit'));
  const delivered = holdsFixture(); delivered.notices[0].at = 43_000; delivered.sendTiming!.records[0] = { channelId: 'c0', beforeMs: 43_600, afterMs: 43_600 };
  assert.ok(holdsEndReasons(delivered).includes('delivered_after_hold 512 > client revocations after recovery 511'));
});

test('several send records per Channel match client notices by count', () => {
  const run = holdsFixture();
  assert.deepEqual(noticeCorrectness(run).reasons, []);
  assert.equal(noticeCorrectness(run).details.serverSends.c3, 32);
  const lost = holdsFixture(); // a notice lost on both sides is allowed (spec O5)
  lost.notices = lost.notices.filter(n => !(n.socket === 4 && n.channelId === 'c3'));
  lost.sendTiming!.records.pop();
  assert.equal(lost.sendTiming!.records.filter(r => r.channelId === 'c15').length, 31);
  assert.ok(noticeCorrectness(lost).reasons.includes('2 Channels whose server send count differs from the client notice count'));
  lost.sendTiming!.records = lost.notices.map(n => ({ channelId: n.channelId!, beforeMs: 44_000, afterMs: 44_002 }));
  assert.deepEqual(noticeCorrectness(lost).reasons, []);
  const extra = holdsFixture(); extra.sendTiming!.records.push({ channelId: 'c0', beforeMs: 44_000, afterMs: 44_002 });
  assert.deepEqual(noticeCorrectness(extra).details.mismatched, ['c0']);
});

test('duplicates are per (socket, Channel), not per Channel', () => {
  const run = holdsFixture();
  run.notices.push({ socket: 1, channelId: 'c0', at: 44_500 });
  run.sendTiming!.records.push({ channelId: 'c0', beforeMs: 44_000, afterMs: 44_002 });
  assert.deepEqual(noticeCorrectness(run).reasons, ['duplicate revocation on a (socket, Channel)']);
});

test('every revoked-Channel send lies outside the fault with the run-level uncertainty', () => {
  const send = (ms: number) => { const run = holdsFixture(); run.sendTiming!.records[0] = { channelId: 'c0', beforeMs: ms, afterMs: ms }; return noticeCorrectness(run).reasons; };
  // fault 39_700, recovery 43_500, U = 2, offset 0.
  assert.deepEqual(send(39_697.9), []);
  assert.deepEqual(send(39_698), ['a revocation send time is indeterminate at a fault edge']);
  assert.deepEqual(send(40_000), ['a revocation was sent while the failure was active']);
  assert.deepEqual(send(43_501.9), ['a revocation send time is indeterminate at a fault edge']);
  assert.deepEqual(send(43_502), []);
});

test('wrong, early and restored-registration notices fail', () => {
  const wrong = holdsFixture(); wrong.notices[0].channelId = 'stall';
  assert.ok(noticeCorrectness(wrong).reasons.includes('a revocation reached a bystander or a Channel that was not revoked'));
  const bystander = holdsFixture(); bystander.bystanderNotices = 1;
  assert.ok(noticeCorrectness(bystander).reasons.includes('a revocation reached a bystander or a Channel that was not revoked'));
  const record = holdsFixture(); record.sendTiming!.records.push({ channelId: 'stall', beforeMs: 44_000, afterMs: 44_000 });
  assert.ok(noticeCorrectness(record).reasons.includes('a revocation send record names a Channel that was not revoked'));
  const early = holdsFixture(); early.notices[0].at = 36_999;
  assert.ok(noticeCorrectness(early).reasons.includes('a revocation arrived before its revoke started'));
  const onTime = holdsFixture(); onTime.notices[0].at = 37_000;
  assert.deepEqual(noticeCorrectness(onTime).reasons, []);
  const fence = holdsFence();
  fence.notices = [{ socket: 40, channelId: 'c1', at: 42_049 }, { socket: 0, channelId: 'c1', at: 50_000 }];
  fence.sendTiming!.records = [{ channelId: 'c1', beforeMs: 39_000, afterMs: 39_000 }, { channelId: 'c1', beforeMs: 45_000, afterMs: 45_000 }];
  assert.deepEqual(noticeCorrectness(fence).reasons, []);
  fence.notices[0].at = 42_050;
  assert.deepEqual(noticeCorrectness(fence).reasons, ['a restored registration received a revocation']);
});

test('cell x duration verdict: three valid PASS repeats; any FAIL fails; INVALID never counts', () => {
  const r = (verdict: 'PASS' | 'FAIL' | 'INVALID') => ({ kind: 'fault' as const, cell: 'H512' as const, duration: 'short' as const, verdict });
  assert.equal(verdictByCell([r('PASS'), r('PASS'), r('PASS')])['H512/short'], 'PASS');
  assert.equal(verdictByCell([r('PASS'), r('PASS'), r('INVALID')])['H512/short'], 'NOT EVALUATED');
  assert.equal(verdictByCell([r('PASS'), r('PASS'), r('INVALID'), r('PASS')])['H512/short'], 'PASS');
  assert.equal(verdictByCell([r('PASS'), r('FAIL')])['H512/short'], 'FAIL');
  assert.equal(verdictByCell([r('PASS'), r('PASS'), r('PASS')])['H512/long'], 'NOT EVALUATED');
  assert.equal(verdictByCell([{ ...r('PASS'), kind: 'control' as const }])['H512/short'], 'NOT EVALUATED');
});

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
  assert.equal(rssDeltaKb(run, run.times.recovery), 700);
  assert.ok(Number.isNaN(rssDeltaKb({ ...run, rss: [] }, run.times.recovery)));
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
  assert.deepEqual(entries[3].deltaKb, { short: 1 });
  assert.deepEqual(entries[4].deltaKb, { short: 1000, long: 50_000 });
  const groups = memoryByCell(entries);
  assert.deepEqual(groups['H512/short'], { result: 'measured within bound', dKb: 4000, nKb: 0, bKb: 8192 });
  assert.equal(groups['H512/long'].result, 'NOT EVALUATED');
  assert.equal(memoryByCell(entries.slice(0, 6))['H512/short'].result, 'NOT EVALUATED');
});

test('the fixture uses every revoked Channel on every target socket', () => {
  const run = holdsFixture();
  assert.equal(run.notices.length, 32 * CHANNELS.length);
  assert.equal(sample(0).highWaterMark, 0);
});
