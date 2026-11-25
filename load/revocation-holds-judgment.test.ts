import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelId, CHANNELS, GATE_OFF, GATE_ON, holdsFixture, poolSample, sample, target, TIMES, timeoutsFrom } from './revocation-holds-fixture.ts';
import { floors, holdsReasons, holdsValues, setupReasons, stallReasons } from './revocation-holds-floors.ts';
import { faultWindowReasons, holdsEndReasons, informational, judgeHolds, passBarEvidence, recoveryGateReasons, verdictByCell, type HoldsRun } from './revocation-holds-judgment.ts';
import { lessFavourable, median, memoryByCell, memoryEntry, memoryVerdict, rssDeltaKb } from './revocation-holds-memory.ts';
import { noticeCorrectness } from './revocation-holds-notices.ts';
import { rehearsalCounts } from './revocation-holds-rehearsal.ts';

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
    ['not every socket was ready when the stall started', run => { run.setup.targetsReadyAtStall = 31; }],
    ['not every socket was ready when the stall started', run => { run.setup.bystandersReadyAtStall = 1023; }],
    ['a revoke mutation failed or completed after the fault started', run => { run.accounts[0].revokeStatus = 409; }],
    ['a revoke mutation failed or completed after the fault started', run => { run.accounts[0].revokedAt = GATE_ON; }],
    ['missing successful baseline probes', run => { run.httpProbe = run.httpProbe.filter(p => p.at < 26_000 || p.at >= 36_000); }],
    ['missing successful baseline probes', run => { run.dbProbe = run.dbProbe.map(p => p.at >= 26_000 && p.at < 36_000 ? { ...p, ok: false } : p); }],
    ['missing successful baseline probes', run => { run.httpProbe = run.httpProbe.map(p => p.at >= 26_000 && p.at < 36_000 ? { ...p, ok: false, status: 503 } : p); }],
    ['no metrics event after the drain', run => { delete run.metrics; }],
    ['missing counter revocation_retired_timeout', run => { delete run.metrics!.revocation_retired_timeout; }],
    ['missing counter revocation_delivered_after_hold', run => { delete run.metrics!.revocation_delivered_after_hold; }],
    ['pool samples do not bracket the fault window', run => { run.pool = run.pool.slice(2); }],
    ['pool samples do not bracket the recovery window', run => { run.pool = run.pool.slice(0, 5); }],
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
  const edge = holdsFixture(); edge.accounts[0].revokedAt = GATE_ON - 0.001;
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
  const noMessage = holdsFixture(); noMessage.targets[5].stallMessages = [{ id: 'early', at: TIMES.resume - 1 }];
  assert.deepEqual(stallReasons(noMessage), ['a target socket shows no stalled backlog']);
  const neverPaused = holdsFixture(); neverPaused.targets[0].stall.pausedAt = [];
  assert.deepEqual(stallReasons(neverPaused), ['a target socket shows no stalled backlog']);
  const atResume = holdsFixture(); atResume.targets[5].stallMessages = [{ id: 'edge', at: TIMES.resume }];
  assert.deepEqual(stallReasons(atResume), []);
  // offset 0 ± 1, U = 2: a send at 39_697 is certainly before the fault at 39_700; 39_698 is not.
  const early = holdsFixture(); early.sendTiming!.records[0] = { channelId: channelId(0), beforeMs: 39_696, afterMs: 39_696.99 };
  assert.deepEqual(stallReasons(early), ['1 revoked-Channel sends before the fault (socket loop not blocked)']);
  const edge = holdsFixture(); edge.sendTiming!.records[0] = { channelId: channelId(0), beforeMs: 39_698, afterMs: 39_698 };
  assert.deepEqual(stallReasons(edge), []);
});

test('floor 2c: no close evidence before resume + 1.5 s from the client, the proxy or the server', () => {
  const margin = TIMES.resume + 1_500;
  const client = (at: number) => { const run = holdsFixture(); run.targets[2].close = { at, code: 1008 }; return stallReasons(run); };
  assert.deepEqual(client(TIMES.resume), ['a target socket closed before resume + 1.5 s']);
  assert.deepEqual(client(margin - 1), ['a target socket closed before resume + 1.5 s']);
  assert.deepEqual(client(margin), []);
  const proxy = (at: number) => { const run = holdsFixture(); run.targets[2].stall.closes = [{ at, side: 'upstream' }]; return stallReasons(run); };
  assert.deepEqual(proxy(margin - 1), ['a target socket closed before resume + 1.5 s']);
  assert.deepEqual(proxy(margin), []);
  // Server closes are timed by the server's own timestamp (offset ±1), not by log receipt.
  const server = (wallMs: number | undefined, at = 70_000) => { const run = holdsFixture(); run.serverCloses = [{ at, wallMs }]; return stallReasons(run); };
  assert.deepEqual(server(margin + 0.999), ['the server closed a socket before resume + 1.5 s']);
  assert.deepEqual(server(margin + 1), []);
  // Logged before the margin, received late (a descheduled harness): still INVALID.
  assert.deepEqual(server(margin - 1, margin + 5_000), ['the server closed a socket before resume + 1.5 s']);
  // Received early does not matter either: the server time decides.
  assert.deepEqual(server(margin + 10, margin - 100), []);
  assert.deepEqual(server(undefined), ['the server closed a socket before resume + 1.5 s']);
  const uncalibrated = holdsFixture(); uncalibrated.serverCloses = [{ at: 70_000, wallMs: 70_000 }]; delete uncalibrated.wallOffsetBoundsMs;
  assert.ok(stallReasons(uncalibrated).includes('the server closed a socket before resume + 1.5 s'));
  assert.ok(setupReasons(uncalibrated).includes('a clock calibration is invalid'));
  const judged = holdsFixture(); judged.serverCloses = [{ at: 70_000, wallMs: margin - 1 }];
  assert.equal(judgeHolds(judged).verdict, 'INVALID');
});

test('floor 1: readiness counts at the stall, not later', () => {
  const late = holdsFixture();
  late.setup.targetsReadyAtStall = 31; // the 32nd subscribed only after the stall started
  assert.ok(late.targets.every(t => t.subscribed));
  assert.deepEqual(setupReasons(late), ['not every socket was ready when the stall started']);
  const ready = holdsFixture(); ready.targets[3].subscribed = false; // the final flag alone does not count
  assert.deepEqual(setupReasons(ready), []);
});

test('floor 1: the restore completes by P + 2.5 s and starts after the fault is certainly on', () => {
  const restore = (kind: 'fault' | 'control', startedAt: number, doneAt: number, gateOn: [number, number] = [GATE_ON, GATE_ON]) => {
    const run = holdsFence(); run.kind = kind; if (kind === 'control') run.duration = undefined;
    run.times.gateOn = gateOn;
    Object.assign(run.accounts[1], { restoreStartedAt: startedAt, restoredAt: doneAt });
    return setupReasons(run);
  };
  assert.deepEqual(restore('fault', 42_000, 42_500), []);
  assert.deepEqual(restore('fault', 42_000, 42_501), ['the restore did not complete by P + 2.5 s']);
  assert.deepEqual(restore('control', 42_000, 42_500), []);
  assert.deepEqual(restore('control', 42_000, 42_501), ['the restore did not complete by P + 2.5 s']);
  // The gate-on acknowledgement bounds the certain fault: a restore before it is INVALID.
  assert.deepEqual(restore('fault', 39_800, 40_000, [39_700, 39_800]), []);
  assert.deepEqual(restore('fault', 39_799, 40_000, [39_700, 39_800]), ['the restore started before the fault was certainly on']);
  assert.deepEqual(restore('control', 39_000, 40_000), []);
  const missing = holdsFence(); delete missing.accounts[1].restoredAt;
  assert.deepEqual(setupReasons(missing), ['the restore mutation failed']);
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
  run.revokedChannels = Array.from({ length: 64 }, (_, i) => channelId(i));
  run.targets = Array.from({ length: 64 }, (_, i) => target(i));
  run.setup.targetsReadyAtStall = 64;
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

test('floor-INVALID reports gate failures, and controls never PASS or FAIL', () => {
  const run = holdsFixture();
  run.targets[0].close = { at: 1, code: 1008 };
  run.bystanderCloses = [1, 2, 3];
  const judged = judgeHolds(run);
  assert.equal(judged.verdict, 'INVALID');
  assert.deepEqual(judged.reasons, ['3 bystander sockets closed during the run']);
  const control = holdsFixture('control');
  control.samples = control.samples.map(s => ({ ...s, highWaterMark: 0, activeHolds: 0, retryAttempts: 0 }));
  control.bystanderCloses = [1, 2, 3];
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
  const pool = holdsFixture(); timeoutsFrom(pool, 45_000, 2);
  assert.ok(faultWindowReasons(pool).includes('2 pool acquire timeouts in the fault window'));
  // Missing pool brackets are floor 1 (INVALID), never a gate that silently passes.
  const noPool = holdsFixture(); noPool.pool = [];
  assert.equal(judgeHolds(noPool).verdict, 'INVALID');
  assert.ok(judgeHolds(noPool).floorReasons.includes('pool samples do not bracket the fault window'));
  const none = holdsFixture(); none.dbProbe = none.dbProbe.filter(p => p.at < 39_700 || p.at >= 43_500);
  assert.deepEqual(faultWindowReasons(none), ['no database or HTTP probe in the fault window']);
});

test('the #592 recovery rules still apply', () => {
  const slow = holdsFixture(); slow.dbProbe = slow.dbProbe.map(p => p.at >= 43_500 && p.at < 53_500 ? { ...p, ms: 40 } : p);
  assert.ok(reasons(slow).some(r => r.startsWith('database probe p99')));
  const pool = holdsFixture(); timeoutsFrom(pool, 81_000, 1);
  assert.ok(reasons(pool).includes('1 pool acquire timeouts after recovery'));
  assert.ok(!faultWindowReasons(pool).some(r => r.includes('pool')));
});

test('holds end: zero active holds, no timeouts, no bystander closes, residual >= 0', () => {
  assert.deepEqual(holdsEndReasons(holdsFixture()), []);
  // Offset ±1: 53_250 (high 53_251) is certainly before 53_500 and never counts; 53_500 (high 53_501)
  // may be the first sample after it, so it counts; 53_750 is the first certainly after it.
  const before = holdsFixture(); before.samples = before.samples.map(s => s.serverMs === 53_250 ? { ...s, activeHolds: 7 } : s);
  assert.deepEqual(holdsEndReasons(before), []);
  const maybe = holdsFixture(); maybe.samples = maybe.samples.map(s => s.serverMs === 53_500 ? { ...s, activeHolds: 7 } : s);
  assert.deepEqual(holdsEndReasons(maybe), ['7 active holds at recovery + 10 s']);
  const later = holdsFixture(); later.samples = later.samples.map(s => s.serverMs === 54_000 ? { ...s, activeHolds: 7 } : s);
  assert.deepEqual(holdsEndReasons(later), []);
  const active = holdsFixture(); active.samples = active.samples.map(s => s.serverMs === 53_750 ? { ...s, activeHolds: 1 } : s);
  assert.deepEqual(holdsEndReasons(active), ['1 active holds at recovery + 10 s']);
  const timeout = holdsFixture(); timeout.metrics!.revocation_retired_timeout = 1;
  assert.ok(holdsEndReasons(timeout).includes('1 holds retired by timeout'));
  const bystander = holdsFixture(); bystander.bystanderCloses = [1];
  assert.deepEqual(holdsEndReasons(bystander), ['1 bystander sockets closed during the run']);
  const residual = holdsFixture(); residual.metrics!.revocation_held = 511;
  assert.ok(holdsEndReasons(residual).includes('hold residual -1 < 0'));
  const drain = holdsFixture(); drain.notices[0].at = 53_501;
  assert.ok(holdsEndReasons(drain).includes('a revocation arrived after the drain limit'));
  const delivered = holdsFixture(); delivered.notices[0].at = 43_000; delivered.sendTiming!.records[0] = { channelId: channelId(0), beforeMs: 43_600, afterMs: 43_600 };
  assert.ok(holdsEndReasons(delivered).includes('delivered_after_hold 512 > client revocations after recovery 511'));
});

test('several send records per Channel match client notices by count', () => {
  const run = holdsFixture();
  assert.deepEqual(noticeCorrectness(run).reasons, []);
  assert.equal(noticeCorrectness(run).details.serverSends[channelId(3)], 32);
  const lost = holdsFixture(); // a notice lost on both sides is allowed (spec O5)
  lost.notices = lost.notices.filter(n => !(n.socket === 4 && n.channelId === channelId(3)));
  lost.sendTiming!.records.pop();
  assert.equal(lost.sendTiming!.records.filter(r => r.channelId === channelId(15)).length, 31);
  assert.ok(noticeCorrectness(lost).reasons.includes('2 Channels whose server send count differs from the client notice count'));
  lost.sendTiming!.records = lost.notices.map(n => ({ channelId: n.channelId!, beforeMs: 44_000, afterMs: 44_002 }));
  assert.deepEqual(noticeCorrectness(lost).reasons, []);
  const extra = holdsFixture(); extra.sendTiming!.records.push({ channelId: channelId(0), beforeMs: 44_000, afterMs: 44_002 });
  assert.deepEqual(noticeCorrectness(extra).details.mismatched, [channelId(0)]);
});

test('duplicates are per (socket, Channel), not per Channel', () => {
  const run = holdsFixture();
  run.notices.push({ socket: 1, channelId: channelId(0), at: 44_500 });
  run.sendTiming!.records.push({ channelId: channelId(0), beforeMs: 44_000, afterMs: 44_002 });
  assert.deepEqual(noticeCorrectness(run).reasons, ['duplicate revocation on a (socket, Channel)']);
});

const EDGE = '1 revoked-Channel sends indeterminate at a gate edge';
/** The verdict and its reasons for the fixture with one send record moved to `ms`. */
function sendAt(ms: number, gates?: { gateOn: [number, number]; gateOff: [number, number] }) {
  const run = holdsFixture(); if (gates) Object.assign(run.times, gates);
  run.sendTiming!.records[0] = { channelId: channelId(0), beforeMs: ms, afterMs: ms };
  const judged = judgeHolds(run);
  return [judged.verdict, ...judged.floorReasons, ...judged.reasons];
}
const FAULT_SEND = ['FAIL', 'a revocation was sent while the failure was active'];

test('every revoked-Channel send lies outside the fault with the run-level uncertainty', () => {
  // gate on 39_700, gate off 43_500 (zero-width bands), U = 2, offset 0.
  assert.deepEqual(sendAt(39_697.9), ['INVALID', '1 revoked-Channel sends before the fault (socket loop not blocked)']); // floor 2b
  assert.deepEqual(sendAt(39_698), ['INVALID', EDGE]);
  assert.deepEqual(sendAt(39_702), FAULT_SEND);
  assert.deepEqual(sendAt(40_000), FAULT_SEND);
  assert.deepEqual(sendAt(43_497.9), FAULT_SEND);
  assert.deepEqual(sendAt(43_501.9), ['INVALID', EDGE]);
  assert.deepEqual(sendAt(43_502), ['PASS']);
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
  fence.notices = [{ socket: 40, channelId: channelId(1), at: 42_049 }, { socket: 0, channelId: channelId(1), at: 50_000 }];
  fence.sendTiming!.records = [{ channelId: channelId(1), beforeMs: 39_000, afterMs: 39_000 }, { channelId: channelId(1), beforeMs: 45_000, afterMs: 45_000 }];
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
  // Exactly the first three valid repeats count: a fourth FAIL is ignored.
  assert.equal(verdictByCell([r('PASS'), r('INVALID'), r('PASS'), r('PASS'), r('FAIL')])['H512/short'], 'PASS');
  assert.equal(verdictByCell([r('PASS'), r('PASS'), r('FAIL'), r('PASS')])['H512/short'], 'FAIL');
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

test('the fixture uses every revoked Channel on every target socket', () => {
  const run = holdsFixture();
  assert.equal(run.notices.length, 32 * CHANNELS.length);
  assert.equal(sample(0).highWaterMark, 0);
});

test('gate bounds: health spans the widest interval, sends are judged against the certain one', () => {
  const widened = () => { const run = holdsFixture(); run.times.gateOn = [39_700, 39_800]; run.times.gateOff = [43_500, 43_600]; return run; };
  assert.equal(judgeHolds(widened()).verdict, 'PASS');
  // A probe failure while the gate-on statement is in flight counts as a fault-window failure.
  const onFlight = widened(); onFlight.dbProbe[795] = { ...onFlight.dbProbe[795], ok: false }; // at 39_750
  assert.deepEqual(faultWindowReasons(onFlight), ['1 database probe failures in the fault window']);
  const offFlight = widened(); offFlight.httpProbe[871] = { ...offFlight.httpProbe[871], ok: false, status: 503 }; // at 43_550
  assert.ok(faultWindowReasons(offFlight).includes('1 HTTP probe failures in the fault window'));
  // Sends are a FAIL only when certainly in [39_800, 43_500); overlapping a band is ambiguous.
  const gates = { gateOn: [39_700, 39_800] as [number, number], gateOff: [43_500, 43_600] as [number, number] };
  assert.deepEqual(sendAt(43_000, gates), FAULT_SEND);
  assert.deepEqual(sendAt(43_499, gates), ['INVALID', EDGE]);
  assert.deepEqual(sendAt(39_699, gates), ['INVALID', EDGE]);
  // A send before the gate-on statement was sent is a stall failure (floor 2b), not a gate.
  const early = widened(); early.sendTiming!.records[0] = { channelId: channelId(0), beforeMs: 39_697, afterMs: 39_697 };
  assert.deepEqual(stallReasons(early), ['1 revoked-Channel sends before the fault (socket loop not blocked)']);
  // The recovery rules hold at both release ends: [43_500, 53_500) and [43_600, 53_600).
  const failAt = (index: number) => { const run = widened(); run.dbProbe[index] = { ...run.dbProbe[index], ok: false }; return recoveryGateReasons(run); };
  assert.deepEqual(failAt(1071), ['1 database probe failures after recovery']); // 53_550: latest end only
  assert.deepEqual(failAt(871), ['1 database probe failures after recovery']); // 43_550: earliest end only
  assert.deepEqual(failAt(1073), []); // 53_650: neither
});

test('a send overlapping the gate-off band makes an otherwise PASS run INVALID', () => {
  const gateOff: [number, number] = [43_500, 43_600], gates = { gateOn: [GATE_ON, GATE_ON] as [number, number], gateOff };
  // Sol's cases: 43_550 ± 2 and 43_500 ± 2, with gate off sent at 43_500 and acknowledged at 43_600.
  assert.deepEqual(sendAt(43_550, gates), ['INVALID', EDGE]);
  assert.deepEqual(sendAt(43_500, gates), ['INVALID', EDGE]);
  assert.deepEqual(sendAt(43_597.9, gates), ['INVALID', EDGE]); // low 43_595.9 < 43_600
  // Both sides: certainly before the gate-off statement is a FAIL; certainly after the ack is legal.
  assert.deepEqual(sendAt(43_497.9, gates), FAULT_SEND);
  assert.deepEqual(sendAt(43_602, gates), ['PASS']);
  const ambiguous = holdsFixture(); Object.assign(ambiguous.times, gates);
  ambiguous.sendTiming!.records[0] = { channelId: channelId(0), beforeMs: 43_500, afterMs: 43_500 };
  assert.deepEqual(noticeCorrectness(ambiguous).reasons, []);
  assert.equal(noticeCorrectness(ambiguous).details.ambiguous.length, 1);
  // A FAIL stays a FAIL: the edge rule only replaces a PASS.
  ambiguous.sendTiming!.records[1] = { channelId: channelId(1), beforeMs: 42_000, afterMs: 42_000 };
  assert.equal(judgeHolds(ambiguous).verdict, 'FAIL');
});

test('a send overlapping the gate-on band makes an otherwise PASS run INVALID', () => {
  const gates = { gateOn: [39_700, 39_800] as [number, number], gateOff: [GATE_OFF, GATE_OFF] as [number, number] };
  // Sol's case: 39_750 ± 2 with gate on sent at 39_700 and acknowledged at 39_800.
  assert.deepEqual(sendAt(39_750, gates), ['INVALID', EDGE]);
  assert.deepEqual(sendAt(39_801.9, gates), ['INVALID', EDGE]); // low 39_799.9 < 39_800
  // Both sides: certainly after the ack is a FAIL; certainly before the statement is floor 2b.
  assert.deepEqual(sendAt(39_802, gates), FAULT_SEND);
  assert.deepEqual(sendAt(39_697, gates), ['INVALID', '1 revoked-Channel sends before the fault (socket loop not blocked)']);
});

test('pool brackets use the server sample time, not log receipt', () => {
  const base = [poolSample(0), poolSample(39_000), poolSample(44_000), poolSample(45_000)];
  // Sol's round-2 case: a sample taken 20 ms before the recovery window ends (53_500), received 10 ms after.
  const late = holdsFixture(); late.pool = [...base, poolSample(53_480, 30)];
  assert.ok(setupReasons(late).includes('pool samples do not bracket the recovery window'));
  assert.equal(judgeHolds(late).verdict, 'INVALID');
  // Sol's round-3 case: logged 10 ms after the end, its counters may have been read before it (a
  // stale read). It never closes the bracket; only the next sample does.
  const stale = holdsFixture(); stale.pool = [...base, poolSample(53_510)];
  assert.ok(setupReasons(stale).includes('pool samples do not bracket the recovery window'));
  const next = holdsFixture(); next.pool = [...base, poolSample(53_510), poolSample(54_510)];
  timeoutsFrom(next, 54_510, 1); // the timeout in the final 20 ms shows only in the next read
  assert.deepEqual(setupReasons(next), []);
  assert.ok(judgeHolds(next).reasons.includes('1 pool acquire timeouts after recovery'));
  const clean = holdsFixture(); clean.pool = [...base, poolSample(53_510), poolSample(54_510)];
  assert.equal(judgeHolds(clean).verdict, 'PASS');
  // 53_501 (low 53_500) is the first logged certainly after the end; 53_500 (low 53_499) is not.
  const edge = (at: number) => { const run = holdsFixture(); run.pool = [...base, poolSample(at), poolSample(60_000)]; return setupReasons(run); };
  assert.deepEqual(edge(53_501), []);
  assert.deepEqual(edge(53_500), ['pool samples do not bracket the recovery window']);
  // The fault window [39_700, 43_500]: 39_700 (high 39_701) cannot open it; 39_699 (high 39_700) can.
  const opener = (at: number) => { const run = holdsFixture(); run.pool = [poolSample(at), ...holdsFixture().pool.slice(2)]; return setupReasons(run); };
  assert.deepEqual(opener(39_700), ['pool samples do not bracket the fault window']);
  assert.deepEqual(opener(39_699), []);
  // 43_500 (low 43_499) is not logged certainly after the fault, so 44_000 is the first and the
  // closing bracket is the read after it: a timeout first seen there counts against the fault.
  const closer = holdsFixture(); closer.pool = [poolSample(39_699), poolSample(43_500), poolSample(44_000), poolSample(45_000), poolSample(80_000), poolSample(81_000)];
  timeoutsFrom(closer, 45_000, 1);
  assert.deepEqual(setupReasons(closer), []);
  assert.ok(faultWindowReasons(closer).includes('1 pool acquire timeouts in the fault window'));
  // An untimed sample never brackets.
  const untimed = holdsFixture(); untimed.pool = untimed.pool.map(p => ({ ...p, wallMs: undefined }));
  assert.ok(setupReasons(untimed).includes('pool samples do not bracket the fault window'));
});

test('fault-window p99 holds in every candidate window across the gate bands', () => {
  // Sol's case: 99 probes certainly inside the fault with one slow; a fast probe in each band.
  const run = (slowMs: number) => {
    const r = holdsFixture(); r.times.gateOn = [39_700, 39_800]; r.times.gateOff = [43_500, 43_600];
    const inside = Array.from({ length: 99 }, (_, i) => ({ at: 39_800 + i * 37, ms: i === 50 ? slowMs : 1, ok: true }));
    r.dbProbe = [...r.dbProbe.filter(p => p.at < 39_700 || p.at >= 43_600), { at: 39_750, ms: 1, ok: true }, ...inside, { at: 43_550, ms: 1, ok: true }].sort((a, b) => a.at - b.at);
    return r;
  };
  // The widest window has 101 probes, so its nearest-rank p99 is a fast one; the certain window has 99.
  assert.deepEqual(faultWindowReasons(run(30)), ['fault-window database probe p99 30.00 ms > 25.00 ms']);
  assert.deepEqual(faultWindowReasons(run(25)), []);
});

test('recovery p99 holds at every candidate release in the gate-off band', () => {
  // Sol's case: releasing at 43_550 puts 99 probes with one slow in the window; each band end adds
  // one fast probe (43_520 for 43_500, 53_580 for 43_600).
  const run = (slowMs: number) => {
    const r = holdsFixture(); r.times.gateOff = [43_500, 43_600];
    const main = Array.from({ length: 99 }, (_, i) => ({ at: 43_600 + i * 100, ms: i === 40 ? slowMs : 1, ok: true }));
    r.dbProbe = [...r.dbProbe.filter(p => p.at < 43_500 || p.at >= 53_700), { at: 43_520, ms: 1, ok: true }, ...main, { at: 53_580, ms: 1, ok: true }].sort((a, b) => a.at - b.at);
    return r;
  };
  assert.deepEqual(recoveryGateReasons(run(40)), ['database probe p99 40.00 ms > 25.00 ms']);
  assert.deepEqual(recoveryGateReasons(run(25)), []);
});

test('floor 3 uses the lowest candidate holds-end HWM; floors 4, 5 and L the highest', () => {
  // Sol's case: the earliest candidate reads 400, the actual holds-end sample 500, 900 retries.
  const run = (retries: number) => {
    const r = holdsFixture(); r.times.gateOff = [43_500, 43_600];
    r.samples = r.samples.map(s => ({ ...s, highWaterMark: s.serverMs >= 53_750 ? 500 : s.serverMs >= 39_750 ? 400 : 0, retryAttempts: s.serverMs >= 41_800 ? retries : 0 }));
    return r;
  };
  const values = holdsValues(run(900));
  assert.deepEqual([values.hwm, values.hwmLowest], [500, 400]);
  assert.deepEqual(holdsReasons(run(900), values), ['retry attempts in the fault 900 < 1000']);
  assert.deepEqual(holdsReasons(run(1000), holdsValues(run(1000))), []);
  // Sol's round-3 case: H512 actual 380, later candidate 400, 900 retries (>= 2 x 400).
  const floor3 = (actual: number) => {
    const r = holdsFixture(); r.times.gateOff = [43_500, 43_600];
    r.samples = r.samples.map(s => ({ ...s, highWaterMark: s.serverMs >= 53_750 ? 400 : s.serverMs >= 39_750 ? actual : 0, retryAttempts: s.serverMs >= 41_800 ? 900 : 0 }));
    return r;
  };
  assert.deepEqual(holdsReasons(floor3(380), holdsValues(floor3(380))), ['high-water mark 380 < 384']);
  assert.equal(judgeHolds(floor3(380)).verdict, 'INVALID');
  assert.deepEqual(holdsReasons(floor3(384), holdsValues(floor3(384))), []);
  assert.equal(judgeHolds(floor3(384)).verdict, 'PASS');
});

test('an HTTP failure at the release instant is caught only by the after-recovery rule', () => {
  const run = holdsFixture();
  run.httpProbe[870] = { ...run.httpProbe[870], ok: false, status: 503 }; // at 43_500, before the first recovery success
  assert.deepEqual(recoveryGateReasons(run), []);
  assert.deepEqual(faultWindowReasons(run), ['1 HTTP probe failures in the 10 s after recovery']);
  assert.deepEqual(judgeHolds(run).reasons, ['1 HTTP probe failures in the 10 s after recovery']);
});

test('the retry peak is reported per phase as a sampled lower bound', () => {
  const run = holdsFixture();
  // Fault: 0 at 40_000 to 1024 at 41_000, 1 s apart. Recovery: +300 between 50_000 and 50_250.
  run.samples = run.samples.map(s => ({ ...s, retryAttempts: s.serverMs >= 50_250 ? 1836 : s.serverMs >= 41_800 ? 1536 : s.serverMs >= 40_800 ? 1024 : s.serverMs >= 40_300 ? 512 : 0 }));
  assert.deepEqual(informational(run).retryAttemptPeakPerSecondLowerBound, { fault: 1024, recovery: 300 });
});

test('a rehearsal reports counts only, with no verdict', () => {
  const run = holdsFixture(); run.serverCloses = [{ at: 1, wallMs: 1 }]; run.targets[0].close = { at: 70_000, code: 1000 };
  const counts = rehearsalCounts(run);
  assert.deepEqual(counts.stallBytesAfterResume, { min: 64_000, median: 64_000, max: 64_000 });
  assert.deepEqual(counts.stallMessagesAfterResume, { min: 120, median: 120, max: 120 });
  assert.deepEqual(counts.closes, { targetClient: 1, proxy: 0, bystander: 0, server: 1 });
  assert.deepEqual(counts.highWaterMarkAtHoldsEnd, { lowest: 512, highest: 512 });
  assert.equal(counts.retriesInFault, 1536);
  assert.deepEqual(counts.gate, { on: [GATE_ON, GATE_ON], off: [GATE_OFF, GATE_OFF], onMs: 0, offMs: 0 });
  assert.deepEqual(counts.mutationsMs.revoke, { min: 100, median: 100, max: 100 });
  assert.equal(counts.mutationsMs.restore, null);
  const text = JSON.stringify(counts);
  for (const word of ['verdict', 'PASS', 'FAIL', 'INVALID', 'CONTROL', 'reasons', 'result']) assert.ok(!text.includes(word), word);
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

test('V3a anchors a late close cutoff and gives an evidenced bystander close to the scored gate', () => {
  const run = holdsFixture();
  run.times.resume += 250;
  run.targets.forEach(t => {
    t.stall.resumedAt[0] += 250;
    t.stall.reads[1].at += 250;
    t.stallMessages.forEach(message => { message.at += 250; });
  });
  const cutoff = TIMES.resume + 1500;
  run.serverCloses = [{ at: cutoff + 5, wallMs: cutoff + 1 }];
  assert.deepEqual(stallReasons(run), []);
  run.serverCloses[0].wallMs = cutoff - 5;
  assert.equal(judgeHolds(run).verdict, 'INVALID');
  run.bystanderCloses = [cutoff + 5];
  assert.equal(judgeHolds(run).verdict, 'FAIL');
  run.targets[0].close = { at: cutoff - 1, code: 1008 };
  assert.equal(judgeHolds(run).verdict, 'INVALID'); // independent target evidence still fails floor 2(c)
});

test('V6 a floor-INVALID attempt evaluates accessible gates and blocks PASS permanently', () => {
  const run = holdsFixture();
  delete run.metrics;
  run.bystanderCloses = [run.times.resume + 20];
  run.pool = run.pool.filter(sample => sample.wallMs! < GATE_OFF);
  run.notices[0].at = 60_000;
  run.samples = run.samples.map(s => s.serverMs === 53_750 ? { ...s, activeHolds: 7 } : s);
  const judged = judgeHolds(run);
  assert.equal(judged.verdict, 'INVALID');
  assert.ok(judged.floorReasons.includes('no metrics event after the drain'));
  assert.ok(judged.missingGateInputs.some(input => input.startsWith('timeout retirement: missing input:')));
  assert.ok(judged.missingGateInputs.some(input => input.startsWith('fault pool timeouts: missing input:')));
  assert.ok(judged.reasons.includes('7 active holds at recovery + 10 s'));
  assert.ok(judged.reasons.includes('a revocation arrived after the drain limit'));
  assert.deepEqual(judged.independentFailures, ['1 bystander sockets closed during the run']);
  const attempt = { id: 'H512-short-r1', kind: run.kind, cell: run.cell, duration: run.duration, ...judged };
  const replacement = { ...attempt, verdict: 'PASS' as const, independentFailures: [] };
  const long = { ...replacement, duration: 'long' as const };
  const passes = [replacement, replacement, replacement, long, long, long];
  const results = [attempt, ...passes];
  for (const duration of ['short', 'long'] as const) {
    assert.equal(verdictByCell(passes)[`H512/${duration}`], 'PASS');
    assert.equal(verdictByCell(results)[`H512/${duration}`], 'NOT EVALUATED');
    assert.equal(verdictByCell([{ ...replacement, duration, verdict: 'FAIL' }, ...results])[`H512/${duration}`], 'FAIL');
  }
  assert.deepEqual(passBarEvidence(results), [{ id: attempt.id, cell: 'H512', duration: 'short', gates: ['1 bystander sockets closed during the run'] }]);

  run.bystanderCloses = [];
  run.metrics = { revocation_retired_timeout: 2 };
  const partial = judgeHolds(run);
  assert.ok(partial.missingGateInputs.some(input => input.startsWith('hold residual: missing input:')));
  assert.deepEqual(partial.independentFailures, ['2 holds retired by timeout']);
});

test('V6 each independent gate applies to both a valid and an INVALID control', () => {
  const observations: [string, (run: HoldsRun) => void][] = [
    ['1 bystander sockets closed during the run', run => { run.bystanderCloses = [run.times.resume + 1_600]; }],
    ['2 holds retired by timeout', run => { run.metrics!.revocation_retired_timeout = 2; run.metrics!.revocation_held += 2; }],
    ['hold residual -1 < 0', run => { run.metrics!.revocation_held -= 1; }],
    ['1 pool acquire timeouts in the fault window', run => { timeoutsFrom(run, 44_000, 1); }],
    ['1 pool acquire timeouts in the recovery window', run => { timeoutsFrom(run, 80_000, 1); }],
  ];
  const replacements = (['short', 'long'] as const).flatMap(duration =>
    Array.from({ length: 3 }, () => ({ kind: 'fault', cell: 'H512', duration, verdict: 'PASS' }) as const));
  for (const [gate, mutate] of observations) for (const invalid of [false, true]) {
    const run = holdsFixture('control');
    if (invalid) run.trace!.evidenceErrors.push('trace lost');
    mutate(run);
    const judged = judgeHolds(run);
    assert.equal(judged.verdict, invalid ? 'INVALID' : 'CONTROL', gate);
    assert.ok(judged.independentFailures.includes(gate), gate);
    const id = 'H512-control-r1';
    const results = [{ id, kind: run.kind, cell: run.cell, ...judged }, ...replacements.map(r => ({ ...r, id: 'replacement' }))];
    const verdicts = verdictByCell(results);
    assert.equal(verdicts['H512/short'], 'NOT EVALUATED');
    assert.equal(verdicts['H512/long'], 'NOT EVALUATED');
    assert.deepEqual(passBarEvidence(results), [{ id, cell: 'H512', duration: undefined, gates: judged.independentFailures }]);
  }
});

test('V6 reports evidenced residual and pool timeout failures even with missing timing', () => {
  const run = holdsFixture();
  delete run.sendTiming;
  run.metrics!.revocation_held = 511;
  timeoutsFrom(run, 44_000, 1);
  const judged = judgeHolds(run);
  assert.equal(judged.verdict, 'INVALID');
  assert.ok(judged.missingGateInputs.some(input => input.startsWith('active holds: missing input:')));
  assert.ok(judged.missingGateInputs.some(input => input.startsWith('send timing and send counts: missing input:')));
  assert.deepEqual(judged.independentFailures, [
    'hold residual -1 < 0', '1 pool acquire timeouts in the fault window', '1 pool acquire timeouts in the recovery window',
  ]);
});

test('V6 a fault with a missing gate input never gives PASS or an evidence-only exclusion', () => {
  const run = holdsFixture();
  // The notice's socket exists, but its Account association has no revoke timestamp.
  run.targets[0].account = run.accounts.length;
  const judged = judgeHolds(run);
  assert.deepEqual(judged.floorReasons, []);
  assert.deepEqual(judged.reasons, []);
  assert.deepEqual(judged.evidence.issues, []);
  assert.deepEqual(judged.missingGateInputs, ['client revocation order: missing input: revoke start time']);
  assert.equal(judged.verdict, 'INVALID');
  assert.equal(judged.evidenceOnly, false);
});
