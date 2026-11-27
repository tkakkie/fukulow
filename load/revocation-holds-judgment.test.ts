import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelId, GATE_OFF, GATE_ON, holdsFixture, TIMES, timeoutsFrom } from './revocation-holds-fixture.ts';
import { floors, stallReasons } from './revocation-holds-floors.ts';
import { faultWindowReasons, holdsEndReasons, informational, judgeHolds, passBarEvidence, recoveryGateReasons, verdictByCell, type HoldsRun } from './revocation-holds-judgment.ts';
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
    assert.equal(verdictByCell(results)[`H512/${duration}`], duration === 'short' ? 'NOT EVALUATED' : 'PASS');
    assert.equal(verdictByCell([{ ...replacement, duration, verdict: 'FAIL' }, ...results])[`H512/${duration}`], 'FAIL');
  }
  assert.deepEqual(passBarEvidence(results), [{ id: attempt.id, cell: 'H512', duration: 'short', gates: ['1 bystander sockets closed during the run'] }]);

  run.bystanderCloses = [];
  run.metrics = { revocation_retired_timeout: 2 };
  const partial = judgeHolds(run);
  assert.ok(partial.missingGateInputs.some(input => input.startsWith('hold residual: missing input:')));
  assert.deepEqual(partial.independentFailures, ['2 holds retired by timeout']);
});

test('V6 a floor-INVALID short fault leaves three valid long passes eligible for PASS', () => {
  const short = { kind: 'fault', cell: 'H512', duration: 'short', verdict: 'INVALID', floorInvalid: true,
    independentFailures: ['1 bystander sockets closed during the run'] } satisfies Parameters<typeof verdictByCell>[0][number];
  const long = { kind: 'fault', cell: 'H512', duration: 'long', verdict: 'PASS' } as const;
  const control = { kind: 'control', cell: 'H512', verdict: 'CONTROL' } as const;
  const verdicts = verdictByCell([short, long, long, long, control]);
  assert.equal(verdicts['H512/long'], 'PASS');
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
