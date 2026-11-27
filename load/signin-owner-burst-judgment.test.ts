import test from 'node:test';
import assert from 'node:assert/strict';
import { a0, aggregate, judgeBurst, workloadGaps, type BurstOwnerOp, type BurstRun } from './signin-owner-burst-judgment.ts';
import { readRuns } from './signin-owner-burst-aggregate.ts';
import { report } from './signin-owner-burst-report.ts';
import { OFFSET, SENDS, brackets, run, reattribute, shiftWaits, setMs, moveTo, writeRun, threeRuns, wastedRun } from './signin-owner-burst-fixture.ts';

const failing = (r: BurstRun) => Object.entries(judgeBurst(r).checks).filter(([, c]) => !c.pass).map(([k]) => k);
const b1Auth = (r: BurstRun) => r.owner.find(o => o.kind === 'password' && o.sentMs > 60_000 && o.sentMs < 241_700 && o.burst === undefined)!;

test('a run within every bound holds; A0 passes; C2 bounds use the B0 p95 of the same kind', () => {
  const result = judgeBurst(run());
  assert.deepEqual([result.verdict, result.reasons, failing(run())], ['holds', [], []]);
  assert.equal(result.a0.pass, true);
  assert.deepEqual(result.c2.bounds, { password: 330, revoke: 330 });
  assert.deepEqual(result.waiters, { log: 3, sampler: 2 });
  assert.equal(result.sampler.medianMs, 20);
  const r = report(run());
  assert.deepEqual(r.bursts.map(b => [b.counted401, b.refused429, b.lockLog.owner]), [[5, 11, [140]], [5, 11, [140]], [5, 11, [140]]]);
  assert.equal(r.phases.B1.sampler.waitingShareAtPeak, 2 / 7);
});

test('C1, C2 and B1-B5 failures in a valid run are `fails`', () => {
  const cases: [string, (r: BurstRun) => void][] = [
    ['C1', r => { b1Auth(r).status = 429; }],
    ['C1', r => { r.owner.find(o => o.burst === 2)!.status = 503; }],
    ['C2', r => { setMs(b1Auth(r), 331); }],
    ['C2', r => { setMs(r.owner.find(o => o.burst === 1)!, 331); }],
    ['B3', r => { for (const pid of [104, 105, 106, 107, 108]) r.waits.push({ ...r.waits[0], pid }); reattribute(r); }],
    ['B3', r => { r.samples[3_100].connections = 20; }],
    ['B4', r => { r.reads[300].status = 500; }],
  ];
  for (const [check, mutate] of cases) {
    const r = run(); mutate(r);
    const result = judgeBurst(r);
    assert.equal(result.verdict, 'fails', check);
    assert.ok(failing(r).includes(check), `${check}: ${failing(r)}`);
  }
});

test('A0, sample-count and evidence gaps are inconclusive, and a bad sampler is invalid: never holds', () => {
  const cases: [string, (r: BurstRun) => void][] = [
    ['four counted attempts', r => { r.attack.find(a => a.burst === 2 && a.status === 401)!.status = 429; }],
    ['owner op skipped', r => { r.bursts[1].ownerOp = 'skipped'; }],
    ['owner op on a refused send', r => { r.bursts[2].ownerOpSend = 0; r.bursts[2].admittedSend = 1; }],
    ['two bursts only', r => { r.bursts.pop(); }],
    ['overlap in one burst only', r => { r.waits = r.waits.filter(w => w.startMs < 100_000 || w.pid === 101); }],
    ['lock log incomplete', r => { r.lockLog = { complete: false, reasons: ['1 unmatched waits'] }; }],
    ['three B0 revoke successes', r => { for (const o of r.owner.filter(o => o.kind === 'revoke' && o.sentMs < 60_000).slice(0, 3)) o.status = 429; }],
    ['server evidence incomplete', r => { r.server.complete = false; }],
  ];
  for (const [name, mutate] of cases) {
    const r = run(); mutate(r);
    assert.equal(judgeBurst(r).verdict, 'inconclusive', name);
  }
  // An A0 failure is never upgraded to a fail by an outcome failure either.
  const both = run(); both.bursts[0].ownerOp = 'skipped'; b1Auth(both).status = 429;
  assert.equal(judgeBurst(both).verdict, 'inconclusive');
  const slow = run(); slow.samples = slow.samples.filter((_, i) => i % 2 === 0);
  assert.deepEqual([judgeBurst(slow).verdict, judgeBurst(slow).sampler.medianMs], ['invalid', 40]);
});

test('aggregate: PASS only for 3 distinct valid runs that hold; fewer than 3 valid is INCONCLUSIVE even with a fail', () => {
  const run = (id: string, verdict: 'holds' | 'fails' | 'inconclusive' | 'invalid' | null, evidence = true) => ({ id, evidence, verdict });
  assert.equal(aggregate([run('a', 'holds'), run('b', 'holds'), run('c', 'holds')]).outcome, 'PASS');
  assert.deepEqual(aggregate([run('a', 'holds'), run('b', 'holds'), run('c', 'fails')]), { outcome: 'FAIL', valid: 3, failures: ['c'],
    verdicts: ['holds', 'holds', 'fails'] });
  // The approved rule: fewer than 3 valid runs is INCONCLUSIVE; the individual failure stays listed.
  const mixed = aggregate([run('a', 'fails'), run('b', 'holds'), run('c', 'invalid')]);
  assert.deepEqual([mixed.outcome, mixed.valid, mixed.failures], ['INCONCLUSIVE', 2, ['a']]);
  assert.equal(aggregate([run('a', 'holds'), run('b', 'holds'), run('c', 'inconclusive')]).outcome, 'INCONCLUSIVE');
  assert.equal(aggregate([run('a', 'holds'), run('b', 'holds'), run('c', 'holds', false)]).outcome, 'INCONCLUSIVE');
  assert.equal(aggregate([run('a', 'holds'), run('b', 'holds'), run('c', null)]).outcome, 'INCONCLUSIVE');
  // One run three times is one run.
  const same = aggregate([run('a', 'holds'), run('a', 'holds'), run('a', 'holds')]);
  assert.deepEqual([same.outcome, same.valid], ['INCONCLUSIVE', 1]);
  assert.equal(aggregate([{ id: null, evidence: true, verdict: 'holds' }, run('b', 'holds'), run('c', 'holds')]).outcome, 'INCONCLUSIVE');
  assert.throws(() => aggregate([run('a', 'holds'), run('b', 'holds')]));
  assert.throws(() => aggregate([run('a', 'holds'), run('b', 'holds'), run('c', 'holds'), run('d', 'holds')]));
});

test('burst timing: the owner operation belongs to the admitted send after a 429 retry, and must leave on time', () => {
  const retried = () => run({ retry: 2 });
  assert.equal(judgeBurst(retried()).verdict, 'holds');
  assert.deepEqual(retried().owner.filter(o => o.burst === 2).map(o => o.burstSend), [1]);
  const late = retried();
  moveTo(late.owner.find(o => o.burst === 2)!, SENDS[1] + 250 + 40);
  const result = judgeBurst(late);
  assert.equal(result.verdict, 'inconclusive');
  assert.equal(result.evidence.checks.ownerOpTiming.pass, false);
  // +14 ms is inside the approved 5 ms owner lateness (maintainer, 2026-11-22); +16 ms is not.
  const at14 = run(); moveTo(at14.owner.find(o => o.burst === 1)!, SENDS[0] + 14);
  assert.equal(judgeBurst(at14).verdict, 'holds');
  const at16 = run(); moveTo(at16.owner.find(o => o.burst === 1)!, SENDS[0] + 16);
  assert.equal(judgeBurst(at16).verdict, 'inconclusive');
  const early = run(); moveTo(early.owner.find(o => o.burst === 1)!, SENDS[0] + 5);
  assert.equal(judgeBurst(early).verdict, 'inconclusive');
  const undecided = run(); undecided.bursts[0].ownerOp = 'undecided';
  assert.equal(judgeBurst(undecided).verdict, 'inconclusive');
});

test('overlap evidence is bound to each burst window; recovery waits never count', () => {
  const r = run();
  // Burst 2 loses its overlap; burst 3's overlapping waits move into B2 recovery.
  r.waits = r.waits.filter(w => !(w.startMs > 100_000 && w.startMs < 130_000 && w.pid !== 101));
  shiftWaits(r, 65_000, w => w.startMs > 170_000);
  const result = judgeBurst(r);
  assert.deepEqual([result.verdict, result.a0.checks.lockOverlap.pass, result.a0.locks.map(l => l.peakPids)], ['inconclusive', false, [3, 1, 0]]);
});

test('sampler loss around the bursts, malformed rows, bad timestamps and skipped reads are inconclusive', () => {
  const cases: [string, (r: BurstRun) => void][] = [
    ['no samples within 2 s of any burst', r => { r.samples = r.samples.filter(s => SENDS.every(b => Math.abs(s.dbMs + OFFSET - b) > 2_000)); }],
    ['a 300 ms hole inside a burst', r => { r.samples = r.samples.filter(s => !(s.dbMs + OFFSET > SENDS[0] && s.dbMs + OFFSET < SENDS[0] + 300)); }],
    ['malformed sampler rows', r => { r.samplerMalformed = 1; }],
    ['duplicate database timestamp', r => { r.samples[5].dbMs = r.samples[4].dbMs; }],
    ['backward database timestamp', r => { r.samples[5].dbMs = r.samples[4].dbMs - 1; }],
    ['skipped Organization B reads', r => { r.skipped.reads = 1; }],
  ];
  for (const [name, mutate] of cases) {
    const r = run(); mutate(r);
    const result = judgeBurst(r);
    assert.equal(result.verdict, 'inconclusive', name);
    assert.ok(result.sampler.valid, name);
  }
  // The legacy B4 calculation itself is unchanged by skipped reads.
  const skipped = run(); skipped.skipped.reads = 1;
  assert.equal(judgeBurst(skipped).checks.B4.pass, true);
});

test('invalid takes precedence over inconclusive and fails together', () => {
  const r = run();
  r.samples = r.samples.filter((_, i) => i % 2 === 0);
  r.bursts[0].ownerOp = 'skipped';
  b1Auth(r).status = 429;
  assert.equal(judgeBurst(r).verdict, 'invalid');
});

test('condition a: a lock wait unrelated to the burst inside the +-1 s window is never A0 evidence', () => {
  // The sol fixture: every interval 500 ms later, so all begin after the last attack and owner answers.
  const shifted = run();
  shiftWaits(shifted, 500);
  const result = judgeBurst(shifted);
  assert.notEqual(result.verdict, 'holds');
  assert.deepEqual([result.a0.checks.lockOverlap.pass, result.a0.locks.map(l => l.peakPids)], [false, [0, 0, 0]]);
  // Overlapping waits just before the admitted send, inside the padded window, are not evidence either.
  const before = run();
  shiftWaits(before, -300);
  assert.equal(judgeBurst(before).a0.checks.lockOverlap.pass, false);
  // Inside the span but with unknown attribution (no sampler row, no STATEMENT kind): not evidence.
  const unknown = run();
  for (const w of unknown.waits) delete w.statementKind;
  for (const s of unknown.samples) s.waiting = [];
  reattribute(unknown);
  assert.equal(judgeBurst(unknown).a0.checks.lockOverlap.pass, false);
  // A wait that runs past the end of every request of the burst has no link to one: it never counts.
  const edge = run();
  edge.waits = edge.waits.filter(w => w.pid !== 103);
  shiftWaits(edge, 300, w => w.pid === 102);
  assert.deepEqual(judgeBurst(edge).a0.locks.map(l => l.peakPids), [1, 1, 1]);
});

test('round 2: a stripped workload record never holds, also through the aggregate reader', () => {
  const cases: [string, (r: BurstRun) => void][] = [
    ['refused attack answers removed', r => { r.attack = r.attack.filter(a => a.status !== 429); }],
    ['one Organization B read per phase', r => { r.reads = [r.reads[0], r.reads[200], r.reads[500]]; }],
    ['one owner sign-in slot missing', r => { r.owner.splice(r.owner.findIndex(o => o.kind === 'web_signin' && o.sentMs === 5_000), 1); }],
    ['a read recorded twice', r => { r.reads[1] = { ...r.reads[0] }; }],
    ['wrong kind in an authenticated slot', r => { r.owner.find(o => o.kind === 'password' && o.dueMs === 2_500)!.kind = 'revoke'; }],
    ['burst-time owner operation missing', r => { r.owner = r.owner.filter(o => o.burst !== 2); }],
    ['schedule ended before B2', r => { r.scheduleEndMs = 200_000; }],
  ];
  for (const [name, mutate] of cases) {
    const r = run(); mutate(r);
    const result = judgeBurst(r);
    assert.equal(result.verdict, 'inconclusive', name);
    assert.equal(result.evidence.checks.workloadComplete.pass, false, name);
  }
});

test('round 2: sampler gaps anywhere in the run are inconclusive', () => {
  const r = run();
  r.samples = r.samples.filter(s => !(s.dbMs + OFFSET > 250_000 && s.dbMs + OFFSET < 306_000));
  const result = judgeBurst(r);
  assert.deepEqual([result.verdict, result.sampler.valid, result.evidence.checks.samplerCoverage.pass,
    result.evidence.checks.samplerRunCoverage.pass], ['inconclusive', true, true, false]);
  const b0 = run(); b0.samples = b0.samples.filter(s => !(s.dbMs + OFFSET > 10_000 && s.dbMs + OFFSET < 10_200));
  assert.equal(judgeBurst(b0).verdict, 'inconclusive');
  // The approved 100 ms bound itself: a 100 ms gap is accepted.
  const edge = run(); edge.samples = edge.samples.filter(s => !(s.dbMs + OFFSET > 10_000 && s.dbMs + OFFSET < 10_100));
  assert.equal(judgeBurst(edge).verdict, 'holds');
});

test('round 3: A0 needs a recorded link to a request of that burst; unrelated or unattributed waits never hold A0', () => {
  // The sol case: two unrelated sign-in waits from -25 ms to +5 ms around each admitted send.
  const early = run();
  early.waits = SENDS.flatMap(s => [201, 202].map(pid => ({ ...early.waits[0], pid, startMs: s - 25, endMs: s + 5,
    startDbMs: s - 25 - OFFSET, endDbMs: s + 5 - OFFSET, waitedMs: 30, who: 'signin' as const })));
  reattribute(early);
  const unlinked = judgeBurst(early);
  assert.deepEqual([unlinked.verdict, unlinked.a0.checks.lockOverlap.pass, unlinked.a0.locks.map(l => l.peakPids)], ['inconclusive', false, [0, 0, 0]]);
  // A missing `who` contradicts the stored evidence: never holds.
  const missing = run();
  for (const w of missing.waits) delete (w as Partial<typeof w>).who;
  assert.deepEqual([judgeBurst(missing).verdict, judgeBurst(missing).evidence.checks.lockEvidence.pass], ['inconclusive', false]);
  // A sign-in wait that an owner sign-in outside the burst could explain is ambiguous: not counted.
  const ambiguous = run();
  const signin = ambiguous.owner.find(o => o.kind === 'web_signin' && o.dueMs === 61_000)!;
  moveTo(signin, SENDS[0] + 20); setMs(signin, 200);
  assert.deepEqual(a0(ambiguous).locks.map(l => l.peakPids), [1, 3, 3]);
  // Through the aggregate reader: three such runs are never PASS.
  for (const r of [early, missing]) assert.equal(aggregate(readRuns(['x', 'y', 'z'].map(n => writeRun(n, r)))).outcome, 'INCONCLUSIVE');
});

test('round 3: relabelled or stripped operation records never hold', () => {
  const cases: [string, (r: BurstRun) => void][] = [
    // The sol cases: a 429 password change relabelled as a sign-in (C1 would not see it), and a password change without `ms`.
    ['burst-time 429 password change relabelled native_signin', r => { const o = r.owner.find(o => o.burst === 1)!; o.status = 429; o.kind = 'native_signin'; }],
    ['periodic 429 password change relabelled native_signin', r => { const o = r.owner.find(o => o.kind === 'password' && o.dueMs === 62_500)!; o.status = 429; o.kind = 'native_signin'; }],
    ['password change without ms', r => { delete (r.owner.find(o => o.burst === 1)! as Partial<BurstOwnerOp>).ms; }],
    ['periodic password change without ms', r => { delete (r.owner.find(o => o.kind === 'password' && o.dueMs === 62_500)! as Partial<BurstOwnerOp>).ms; }],
    ['ms rewritten below endMs - sentMs', r => { r.owner.find(o => o.burst === 2)!.ms = 1; }],
    ['owner record without status', r => { delete (r.owner[3] as Partial<BurstOwnerOp>).status; }],
    ['unknown kind', r => { (r.owner[3] as { kind: string }).kind = 'signin'; }],
    ['attack answer without endMs', r => { delete (r.attack[0] as Partial<BurstRun['attack'][number]>).endMs; }],
    ['read without ms', r => { delete (r.reads[10] as Partial<BurstRun['reads'][number]>).ms; }],
  ];
  for (const [name, mutate] of cases) {
    const r = run(); mutate(r);
    const result = judgeBurst(r);
    assert.equal(result.verdict, 'inconclusive', name);
    assert.equal(result.evidence.checks.workloadComplete.pass, false, name);
  }
});

/**
 * sol's round-4 fixture, from raw database times plus clock brackets. The sampler rows arrive 30 ms after
 * their database time, so the point offset (and the stored harness times) are 30 ms late. In bursts 1 and
 * 2 a periodic owner sign-in ran from -40 to +12 ms and waited from -11 to +1 ms; a burst sign-in waited
 * from +0 to +22 ms. Shifted 30 ms late, both waits look as if they lay inside the burst's own requests.
 */
function biasedRun() {
  const r = run(), bias = 30;
  for (const s of r.samples) s.nodeMs += bias;
  r.offsetMs = OFFSET + bias;
  ([[0, 59_000], [1, 119_000]] as const).forEach(([i, due]) => {
    const s = SENDS[i], signin = r.owner.find(o => o.burst === undefined && o.dueMs === due)!;
    moveTo(signin, s - 40); setMs(signin, 52);
    r.waits = r.waits.filter(w => !(w.startDbMs > s - OFFSET && w.startDbMs < s + 1_000 - OFFSET));
    for (const [pid, a, b] of [[301, -11, 1], [302, 0, 22]]) r.waits.push({ pid, startDbMs: s + a - OFFSET, endDbMs: s + b - OFFSET, waitedMs: b - a,
      parts: ['transaction'], tuples: ['(0,1)'], outcome: 'acquired', statementKind: 'signin', startMs: 0, endMs: 0, who: 'signin', whoSource: 'statement' });
  });
  // The stored harness times, converted with the late point offset as the runner does.
  for (const w of r.waits) { w.startMs = w.startDbMs + r.offsetMs; w.endMs = w.endDbMs + r.offsetMs; }
  reattribute(r);
  return r;
}

test('round 4 B1: A0 converts database times through guaranteed clock brackets, never the late point offset', () => {
  const biased = biasedRun();
  const result = judgeBurst(biased);
  // Bursts 1 and 2 lose their waits (the first overlaps the periodic sign-in, the second may start before the request); burst 3 keeps 3.
  assert.deepEqual([result.verdict, result.a0.checks.lockOverlap.pass, result.a0.locks.map(l => l.peakPids)], ['inconclusive', false, [0, 0, 3]]);
  assert.deepEqual(result.a0.locks.map(l => l.clock?.uncertaintyMs), [0.5, 0.5, 0.5]);
  assert.deepEqual(result.evidence.checks.lockEvidence.pass, true);
  assert.equal(threeRuns(biased), 'INCONCLUSIVE');
  // The same bias with the true waits inside the burst requests still holds: the brackets, not the sampler arrival, place them.
  const honest = run();
  for (const s of honest.samples) s.nodeMs += 30;
  honest.offsetMs = OFFSET + 30;
  for (const w of honest.waits) { w.startMs = w.startDbMs + honest.offsetMs; w.endMs = w.endDbMs + honest.offsetMs; }
  assert.equal(judgeBurst(honest).verdict, 'holds');
  // No bracket before burst 1 (the clock session answered late): burst 1 is unbounded, A0 is INCONCLUSIVE although bursts 2 and 3 overlap.
  const unbracketed = run();
  unbracketed.clockBrackets = unbracketed.clockBrackets.filter(b => b.nodeReceivedMs > 60_000);
  const gap = judgeBurst(unbracketed);
  assert.deepEqual([gap.verdict, gap.a0.locks.map(l => l.clock === null), gap.a0.locks.map(l => l.peakPids)], ['inconclusive', [true, false, false], [0, 3, 3]]);
  assert.equal(threeRuns(unbracketed), 'INCONCLUSIVE');
  // A wide bound (400 ms round trips): no wait fits inside a request, A0 simply fails.
  const wide = run(); wide.clockBrackets = brackets(wide.endMs, OFFSET, 400);
  assert.deepEqual([judgeBurst(wide).verdict, judgeBurst(wide).a0.locks.map(l => l.peakPids)], ['inconclusive', [0, 0, 0]]);
  // Brackets missing, malformed or going backwards (a clock step) are never evidence.
  for (const mutate of [(r: BurstRun) => { delete (r as Partial<BurstRun>).clockBrackets; },
    (r: BurstRun) => { r.clockBrackets[300].dbMs = r.clockBrackets[299].dbMs - 1; },
    (r: BurstRun) => { r.clockBrackets[300].nodeReceivedMs = r.clockBrackets[300].nodeSentMs - 1; }]) {
    const r = run(); mutate(r);
    assert.deepEqual([judgeBurst(r).verdict, judgeBurst(r).evidence.checks.lockEvidence.pass], ['inconclusive', false]);
  }
});

test('round 4 B3: owner operations are bound to their slot, skips to slots of their kind, and sends to the operations they fired', () => {
  const slot = (r: BurstRun) => r.owner.find(o => o.burst === undefined && o.kind === 'password' && o.dueMs === 62_500)!;
  const control = run(); slot(control).status = 429;
  assert.equal(judgeBurst(control).verdict, 'fails');
  const cases: [string, (r: BurstRun) => void][] = [
    // sol: the 429 password change moved into B0 with its B1 slot and duration kept.
    ['429 moved into B0', r => { const o = slot(r); o.status = 429; moveTo(o, 57_000); }],
    // sol: the 429 password change deleted and counted as a skipped revoke-others.
    ['deleted, counted as a skipped revoke', r => { const o = slot(r); o.status = 429; r.owner.splice(r.owner.indexOf(o), 1); r.skipped.revoke++; }],
    ['deleted, a revoke slot claimed skipped', r => { const o = slot(r); r.owner.splice(r.owner.indexOf(o), 1); r.skipped.revoke++;
      r.skippedSlots.push({ kind: 'revoke', dueMs: 62_500, atMs: 62_500 }); }],
    ['deleted, a password skip with nothing in flight', r => { const o = slot(r); r.owner.splice(r.owner.indexOf(o), 1); r.skipped.password++;
      r.skippedSlots.push({ kind: 'password', dueMs: 62_500, atMs: 62_500 }); }],
    // sol (and Neon round 4): negative owner latency.
    ['negative owner latency', r => { const o = slot(r); o.endMs = o.sentMs - 5; o.ms = -5; }],
    ['negative attack latency', r => { const a = r.attack[0]; a.endMs = a.sentMs - 1; a.ms = -1; }],
  ];
  for (const [name, mutate] of cases) {
    const r = run(); mutate(r);
    assert.deepEqual([judgeBurst(r).verdict, judgeBurst(r).evidence.checks.workloadComplete.pass], ['inconclusive', false], name);
    assert.equal(threeRuns(r), 'INCONCLUSIVE', name);
  }
  // A real skip, bound to its slot and kind, with an owner operation in flight, is complete.
  const skipped = run(); const o = slot(skipped);
  skipped.owner.splice(skipped.owner.indexOf(o), 1); skipped.skipped.password++;
  skipped.skippedSlots.push({ kind: 'password', dueMs: 62_500, atMs: 62_501 });
  skipped.owner.push({ kind: 'web_signin', sentMs: 62_400, endMs: 62_700, ms: 300, status: 429, dueMs: 61_000 });
  skipped.owner.splice(skipped.owner.findIndex(x => x.dueMs === 61_000 && x.sentMs === 61_000), 1);
  assert.equal(judgeBurst(skipped).evidence.checks.workloadComplete.pass, true, workloadGaps(skipped).join('; '));
  // sol: the refused-send retry with both the wasted operation and its wastedOwnerOpSends entry removed.
  const stripped = wastedRun();
  stripped.owner = stripped.owner.filter(x => !(x.burst === 1 && x.burstSend === 0)); stripped.bursts[0].wastedOwnerOpSends = [];
  assert.deepEqual([judgeBurst(stripped).verdict, judgeBurst(stripped).evidence.checks.workloadComplete.pass], ['inconclusive', false]);
  assert.equal(threeRuns(stripped), 'INCONCLUSIVE');
  // A decision the send's answers contradict: `refused` at +12 ms when only 11 refusals were back.
  const contradicted = wastedRun();
  contradicted.owner = contradicted.owner.filter(x => !(x.burst === 1 && x.burstSend === 0)); contradicted.bursts[0].wastedOwnerOpSends = [];
  contradicted.bursts[0].sends[0].owner = { decision: 'refused', atMs: SENDS[0] + 13 };
  assert.ok(workloadGaps(contradicted).some(g => /contradicts the answers/.test(g)));
  // A send without a decision record, or an operation on a send that did not fire.
  const noDecision = run(); delete (noDecision.bursts[1].sends[0] as Partial<BurstRun['bursts'][number]['sends'][number]>).owner;
  assert.equal(judgeBurst(noDecision).evidence.checks.workloadComplete.pass, false);
});

test('round 4 B4: re-judging re-derives lock-wait attribution from the stored evidence and rejects contradictions', () => {
  // sol: every wait's STATEMENT kind `other`, source `statement`, the sampler's waiting lists cleared, the derived `who` kept.
  const relabelled = run();
  for (const w of relabelled.waits) { w.statementKind = 'other'; w.whoSource = 'statement'; }
  for (const s of relabelled.samples) s.waiting = [];
  const result = judgeBurst(relabelled);
  assert.deepEqual([result.verdict, result.evidence.checks.lockEvidence.pass, result.a0.checks.lockOverlap.pass], ['inconclusive', false, false]);
  assert.equal(threeRuns(relabelled), 'INCONCLUSIVE');
  // sol: waits stripped to pid, harness times and who.
  const stripped = run();
  stripped.waits = stripped.waits.map(w => ({ pid: w.pid, startMs: w.startMs, endMs: w.endMs, who: w.who }) as BurstRun['waits'][number]);
  assert.deepEqual([judgeBurst(stripped).verdict, judgeBurst(stripped).evidence.checks.lockEvidence.pass], ['inconclusive', false]);
  assert.equal(threeRuns(stripped), 'INCONCLUSIVE');
  // Harness times that are not the database times plus the stored offset, or a source the evidence does not give.
  const moved = run(); moved.waits[0].startMs -= 40;
  assert.equal(judgeBurst(moved).evidence.checks.lockEvidence.pass, false);
  const source = run(); source.waits[0].whoSource = 'statement';
  assert.equal(judgeBurst(source).evidence.checks.lockEvidence.pass, false);
});

test('round 4 n1: the per-phase sampler statement age is labelled as an upper bound, not a lock wait', () => {
  const phases = judgeBurst(run()).phases;
  for (const phase of ['B0', 'B1', 'B2'] as const) {
    assert.equal('peakWaitMs' in phases[phase], false, phase);
    assert.equal(phases[phase].samplerStatementAgeUpperBoundMs, 0, phase);
  }
});
