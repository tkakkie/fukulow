import test from 'node:test';
import assert from 'node:assert/strict';
import { PLANS } from './signin-owner-burst-config.ts';
import { judgeBurst, workloadGaps, type BurstRun, type OwnerKind } from './signin-owner-burst-judgment.ts';
import { runWorkload, type Answer, type WorkloadIo } from './signin-owner-burst-workload.ts';
import { report } from './signin-owner-burst-report.ts';
import { OFFSET, SENDS, run, shiftWaits, moveTo, threeRuns, wastedRun } from './signin-owner-burst-fixture.ts';

// Round 3. A virtual clock drives the real scheduler loop (runWorkload): timers fire in time order, and
// every promise chain settles before the clock moves on.
type Reply = { status: number; ms: number };
function virtual(script: { attack?: (call: number) => Reply; owner?: (kind: OwnerKind, t: number) => Reply; stopAt?: number;
  stall?: { from: number; until: number } }) {
  let t = 0, seq = 0, calls = 0;
  const timers: { at: number; seq: number; fire: () => void }[] = [];
  const after = <T>(ms: number, value: () => T) => new Promise<T>(resolve => timers.push({ at: t + ms, seq: seq++, fire: () => resolve(value()) }));
  const reply = ({ status, ms }: Reply) => { const start = t; return after<Answer>(ms, () => ({ status, start, end: start + ms })); };
  const io: WorkloadIo = {
    // A stall holds the scheduler (not the requests in flight) until `until`.
    now: () => t, sleep: ms => after(script.stall && t >= script.stall.from && t < script.stall.until ? script.stall.until - t : ms, () => undefined),
    aborted: () => script.stopAt !== undefined && t >= script.stopAt,
    attack: () => reply(script.attack?.(calls++) ?? (calls++ % 16 < 5 ? { status: 401, ms: 300 } : { status: 429, ms: 2 })),
    owner: kind => reply(script.owner?.(kind, t) ?? { status: kind === 'web_signin' || kind === 'native_signin' ? 200 : 204, ms: 50 }),
    read: () => reply({ status: 200, ms: 5 }),
    sampler: () => ({ exited: false, medianMs: 20 }),
    bracket: () => { const start = t; return after(1, () => ({ nodeSentMs: start, dbMs: start + 0.5 - OFFSET, nodeReceivedMs: start + 1 })); },
  };
  const drive = async <T>(work: Promise<T>) => {
    let done = false;
    void work.finally(() => { done = true; });
    for (;;) {
      await new Promise(resolve => setImmediate(resolve));
      if (done) return work;
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      if (!timers.length) throw new Error('scheduler stalled');
      t = timers[0].at;
      while (timers.length && timers[0].at === t) timers.shift()!.fire();
    }
  };
  return { io, drive };
}
const asRun = (w: Awaited<ReturnType<typeof runWorkload>>): BurstRun => ({ ...w, samples: [], samplerMalformed: 0, offsetMs: null, waits: [],
  lockLog: { complete: true, reasons: [] }, poolMax: 20, server: { poolTimeouts: 0, panics: 0, complete: true },
  plan: { b0Ms: PLANS.recorded.b0Ms, bursts: PLANS.recorded.bursts, b1TailMs: PLANS.recorded.b1TailMs, b2Ms: PLANS.recorded.b2Ms } });

test('round 3: the real scheduler loop runs the pre-registered cadence once per slot and passes workloadComplete', async () => {
  const { io, drive } = virtual({});
  const w = await drive(runWorkload(PLANS.recorded, io));
  assert.deepEqual([w.completed, w.stoppedEarly, w.b0Checkpoint], [true, null, 'complete']);
  assert.deepEqual([w.phaseStartMs.B2, w.scheduleEndMs], [241_700, 311_700]);
  assert.deepEqual(workloadGaps(asRun(w)), []);
  assert.deepEqual(w.skipped, { web_signin: 0, native_signin: 0, password: 0, revoke: 0, reads: 0 });
  const periodic = (kinds: OwnerKind[]) => w.owner.filter(o => o.burst === undefined && kinds.includes(o.kind)).sort((a, b) => a.dueMs! - b.dueMs!);
  const signins = periodic(['web_signin', 'native_signin']), auth = periodic(['password', 'revoke']);
  // Every 2 s from 1 s and every 5 s from 2.5 s up to the end of B2, alternating kinds, each sent at its slot.
  assert.deepEqual(signins.map(o => o.dueMs), Array.from({ length: 156 }, (_, i) => 1_000 + i * 2_000));
  assert.deepEqual(signins.map(o => o.kind), signins.map((_, i) => i % 2 ? 'native_signin' : 'web_signin'));
  assert.deepEqual(auth.map(o => o.dueMs), Array.from({ length: 62 }, (_, i) => 2_500 + i * 5_000));
  assert.deepEqual(auth.map(o => o.kind), auth.map((_, i) => i % 2 ? 'revoke' : 'password'));
  assert.ok([...signins, ...auth].every(o => o.sentMs >= o.dueMs! && o.sentMs - o.dueMs! <= 2));
  assert.deepEqual(w.reads.map(r => r.dueMs).sort((a, b) => a - b), Array.from({ length: 624 }, (_, i) => i * 500));
  // Three admitted bursts 60.2 s apart, each with its owner operation inside +10..+15 ms of the admitted send.
  assert.deepEqual(w.bursts.map(b => [b.sends.map(x => x.sentMs), b.admittedSend, b.ownerOp, b.ownerOpSend]),
    [[[60_000], 0, 'sent', 0], [[120_200], 0, 'sent', 0], [[180_400], 0, 'sent', 0]]);
  assert.deepEqual(w.owner.filter(o => o.burst !== undefined).map(o => [o.kind, o.sentMs - SENDS[o.burst! - 1], o.burstSend]),
    [['password', 13, 0], ['revoke', 13, 0], ['password', 13, 0]]);
});

test('round 3: a send refused after its owner operation fired never credits it; the retry decides afresh', async () => {
  // The sol case on burst 1: 11 x 429 at +13 ms (provisional: the owner operation fires), the last five 429s at +14 ms.
  const { io, drive } = virtual({ stopAt: 70_000, attack: n => n < 16 ? { status: 429, ms: n < 11 ? 13 : 14 }
    : (n - 16) % 16 < 5 ? { status: 401, ms: 300 } : { status: 429, ms: 2 } });
  const w = await drive(runWorkload(PLANS.recorded, io));
  const b = w.bursts[0];
  assert.deepEqual([b.sends.length, b.admittedSend, b.wastedOwnerOpSends, b.ownerOp, b.ownerOpSend], [2, 1, [0], 'sent', 1]);
  assert.deepEqual(w.owner.filter(o => o.burst === 1).map(o => [o.burstSend, o.sentMs - b.sends[o.burstSend!].sentMs]), [[0, 13], [1, 13]]);
  // The judgment: never credited, A0 fails, so the run can only be INCONCLUSIVE (never PASS).
  const r = wastedRun();
  const result = judgeBurst(r);
  assert.deepEqual([result.verdict, result.a0.checks.ownerOps.pass, result.evidence.checks.workloadComplete.pass], ['inconclusive', false, true]);
  assert.equal(report(r).bursts[0].ownerOp?.afterAdmittedSendMs, 13);
  // Dropping the wasted list, or claiming the wasted operation as the credited one, is a workload gap.
  const stripped = structuredClone(r); stripped.bursts[0].wastedOwnerOpSends = [];
  assert.equal(judgeBurst(stripped).evidence.checks.workloadComplete.pass, false);
});

test('round 3: the B0 checkpoint stops before burst 1 when B0 provably cannot reach the counts', async () => {
  // Revoke-others in B0 at 7.5, 17.5, ... 57.5 s; the one at 57.5 s is still in flight at 60 s.
  const b0 = (ok: number[]) => virtual({ stopAt: 61_000, owner: (kind, t) => kind !== 'revoke' || t >= 60_000 ? { status: kind.endsWith('signin') ? 200 : 204, ms: 50 }
    : t >= 57_500 ? { status: 204, ms: 5_000 } : { status: ok.includes(t) ? 204 : 429, ms: 50 } });
  // 3 successes + 1 in flight can still reach 4: left to the final judgment, the bursts go on.
  const reachable = b0([7_500, 17_500, 27_500]);
  const go = await reachable.drive(runWorkload(PLANS.recorded, reachable.io));
  assert.equal(go.stoppedEarly, null);
  assert.match(String(go.b0Checkpoint), /left to the final judgment \(revoke in flight\)/);
  assert.ok(go.attack.length > 0);
  // 2 successes + 1 in flight can reach at most 3: stopped at the checkpoint, burst 1 never sent.
  const short = b0([7_500, 17_500]);
  const stop = await short.drive(runWorkload(PLANS.recorded, short.io));
  assert.match(String(stop.stoppedEarly), /^inconclusive: B0 cannot reach 4 successes .*in flight revoke/);
  assert.deepEqual([stop.attack.length, stop.bursts.length, stop.b0CheckAtMs], [0, 0, 60_000]);
  // No sign-in success and none in flight: V is undefined, stopped.
  const noV = virtual({ owner: kind => ({ status: kind.endsWith('signin') ? 401 : 204, ms: 50 }) });
  const v = await noV.drive(runWorkload(PLANS.recorded, noV.io));
  assert.deepEqual([v.stoppedEarly, v.attack.length], ['inconclusive: no B0 owner sign-in success (V undefined)', 0]);
});

test('round 4 B2: operations dispatched at or after their next slot are missed slots, in the real loop and in stored runs', async () => {
  // sol's case: a 1.5 s scheduler stall at 90 s; the reads due before 91.5 s go out together at 91.5 s with nothing skipped.
  const { io, drive } = virtual({ stall: { from: 90_000, until: 91_500 } });
  const w = await drive(runWorkload(PLANS.recorded, io));
  assert.equal(w.skipped.reads, 0);
  assert.ok(w.reads.some(r => r.dueMs === 90_500 && r.sentMs === 91_500));
  assert.ok(workloadGaps(asRun(w)).some(g => /^Organization B reads: \d+ sent off their slot$/.test(g)), workloadGaps(asRun(w)).join('; '));
  // The same in a stored run, through the aggregate reader.
  const stalled = run();
  for (const r of stalled.reads.filter(r => r.dueMs >= 90_000 && r.dueMs <= 91_500)) r.sentMs = 91_500;
  assert.deepEqual([judgeBurst(stalled).verdict, threeRuns(stalled)], ['inconclusive', 'INCONCLUSIVE']);
  // A periodic owner operation at its next slot is late too; one inside its own period is on time.
  const signinLate = run(); moveTo(signinLate.owner.find(o => o.dueMs === 61_000)!, 63_000);
  assert.equal(judgeBurst(signinLate).evidence.checks.workloadComplete.pass, false);
  const signinOk = run(); moveTo(signinOk.owner.find(o => o.dueMs === 61_000)!, 62_999);
  assert.equal(judgeBurst(signinOk).verdict, 'holds');
  // Burst 2 sent 5 s late (with everything of it moved along): off the pre-registered burst time.
  const late = run();
  const b2 = late.bursts[1];
  for (const send of b2.sends) { send.sentMs += 5_000; send.owner.atMs! += 5_000; }
  for (const a of late.attack.filter(a => a.burst === 2)) moveTo(a, a.sentMs + 5_000);
  moveTo(late.owner.find(o => o.burst === 2)!, SENDS[1] + 13 + 5_000);
  shiftWaits(late, 5_000, w => w.startMs > 120_000 && w.startMs < 121_000);
  assert.ok(workloadGaps(late).includes('burst 2 send 0 at 125200 ms, due at 120200 ms'), workloadGaps(late).join('; '));
  assert.deepEqual([judgeBurst(late).verdict, threeRuns(late)], ['inconclusive', 'INCONCLUSIVE']);
  // A re-send at or after 250 ms past its due time is late as well.
  const resend = run({ retry: 2 });
  resend.bursts[1].sends[1].sentMs += 250;
  assert.equal(judgeBurst(resend).evidence.checks.workloadComplete.pass, false);
});
