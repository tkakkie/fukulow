import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelId, GATE_ON, holdsFence, holdsFixture, poolSample, TIMES, timeoutsFrom } from './revocation-holds-fixture.ts';
import { holdsReasons, holdsValues, setupReasons, stallReasons } from './revocation-holds-floors.ts';
import { faultWindowReasons, judgeHolds, type HoldsRun } from './revocation-holds-judgment.ts';

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
