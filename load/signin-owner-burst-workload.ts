// #756 burst-mode scheduler: the pre-registered workload (issue #756, comment 7075307714) as one loop
// over an injected clock and request functions, so the real loop runs under unit tests on a virtual
// clock. load/signin-owner-burst.ts supplies the HTTP requests, the sampler state and the abort signal.
import { BURST, SAMPLER, SCHEDULE, burstAdmission, ownerDecision, type Plan } from './signin-owner-burst-config.ts';
import { burstOwnerKind, type Burst, type BurstAttackOp, type BurstOwnerOp, type BurstReadOp, type BurstRun, type OwnerKind,
  type SendDecision, type SkippedSlot } from './signin-owner-burst-judgment.ts';
import type { ClockBracket } from './signin-owner-burst-locks.ts';
import type { Phase } from './signin-owner-judgment.ts';

// Times are harness milliseconds (the same clock as `now`).
export type Answer = { status: number; start: number; end: number; error?: string };
export type WorkloadIo = {
  now(): number; sleep(ms: number): Promise<void>; aborted(): boolean;
  attack(): Promise<Answer>; owner(kind: OwnerKind): Promise<Answer>; read(): Promise<Answer>;
  sampler(): { exited: boolean; medianMs: number | null };
  // One database clock read bracketed by harness clock reads; null when the clock session is busy or broken.
  bracket(): Promise<ClockBracket | null>;
};
// The harness scheduler polls every 2 ms (a decision timing, not an evidence threshold).
const TICK_MS = 2;
const C2_MIN_B0 = 4;

export async function runWorkload(plan: Plan, io: WorkloadIo) {
  const owner: BurstOwnerOp[] = [], attack: BurstAttackOp[] = [], reads: BurstReadOp[] = [], bursts: Burst[] = [];
  const skipped: BurstRun['skipped'] = { web_signin: 0, native_signin: 0, password: 0, revoke: 0, reads: 0 };
  const skippedSlots: SkippedSlot[] = [], clockBrackets: ClockBracket[] = [];
  const skip = (kind: SkippedSlot['kind'], dueMs: number) => { skipped[kind]++; skippedSlots.push({ kind, dueMs, atMs: now() }); };
  // Clock brackets go one at a time, at every Organization B read slot (so every burst has one before and
  // after it), and are never awaited by the schedule: a stuck clock session only leaves bursts unbounded.
  let bracketing = false;
  const bracket = () => {
    if (bracketing) return;
    bracketing = true;
    void io.bracket().then(b => { if (b) clockBrackets.push(b); }, () => undefined).finally(() => { bracketing = false; });
  };
  const { now, sleep } = io;
  const until = async (ms: number) => { while (now() < ms && !io.aborted()) await sleep(Math.min(TICK_MS, Math.max(0, ms - now()))); };
  const pending = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>) => { pending.add(task); void task.finally(() => pending.delete(task)); return task; };
  let inFlight: { kind: OwnerKind; sentMs: number } | null = null, readActive = 0;
  const ownerOp = (kind: OwnerKind, extra: Pick<BurstOwnerOp, 'burst' | 'burstSend' | 'dueMs'>) => {
    inFlight = { kind, sentMs: now() };
    track(io.owner(kind).then(r => {
      owner.push({ kind, sentMs: r.start, endMs: r.end, ms: r.end - r.start, status: r.status, error: r.error, ...extra });
    }).finally(() => { inFlight = null; }));
  };

  const sendBurst = async (index: number) => {
    const burst: Burst = { index, sends: [], admittedSend: null, ownerOp: 'missing', ownerOpSend: null, wastedOwnerOpSends: [] };
    bursts.push(burst);
    for (let send = 0; send <= BURST.maxResends && !io.aborted(); send++) {
      if (send) await until(burst.sends[send - 1].sentMs + BURST.resendMs);
      const sentMs = now(), statuses: number[] = [], owner: SendDecision = { decision: 'none', atMs: null };
      burst.sends.push({ sentMs, statuses, owner });
      const responses = Array.from({ length: BURST.size }, () => io.attack().then(r => {
        statuses.push(r.status);
        attack.push({ burst: index, send, sentMs: r.start, endMs: r.end, ms: r.end - r.start, status: r.status, error: r.error });
      }));
      if (burst.ownerOp === 'missing' || burst.ownerOp === 'undecided') {
        // Fire on the admitted send only (ownerDecision): a 401 fires at once from +10 ms; 11 refusals with
        // 5 still out fire only at the last poll inside the approved +10..+15 ms; 16 refusals never fire.
        await until(sentMs + BURST.ownerOffsetMs);
        // The decision and the harness time it was taken on are recorded per send (judged against the answers).
        let atMs = now(), decision = ownerDecision(burstAdmission(statuses), atMs - sentMs);
        while (decision === 'wait' && !io.aborted()) { await sleep(1); atMs = now(); decision = ownerDecision(burstAdmission(statuses), atMs - sentMs); }
        if (decision !== 'wait') { owner.atMs = atMs; owner.decision = decision === 'fire' && inFlight ? 'skipped' : decision; }
        if (decision === 'fire') {
          burst.ownerOpSend = send;
          if (inFlight) burst.ownerOp = 'skipped';
          else { burst.ownerOp = 'sent'; ownerOp(burstOwnerKind(index), { burst: index, burstSend: send }); }
        } else if (decision === 'undecided') burst.ownerOp = 'undecided';
      }
      await Promise.all(responses);
      // Admission is a 401 (pre-registration). Only an all-429 send is re-sent; anything else ends the burst.
      if (statuses.includes(401)) { burst.admittedSend = send; return sentMs; }
      // An owner operation already sent on a send that turned out refused is never credited: it is
      // recorded (wastedOwnerOpSends) and the retry decides afresh; the judgment makes the run INCONCLUSIVE.
      if (burst.ownerOpSend === send) {
        if (burst.ownerOp === 'sent') burst.wastedOwnerOpSends.push(send);
        burst.ownerOp = 'missing'; burst.ownerOpSend = null;
      }
      if (!statuses.every(s => s === 429)) break;
    }
    return burst.sends.at(-1)?.sentMs ?? now();
  };

  const phaseStartMs: Record<Phase, number> = { B0: 0, B1: plan.b0Ms, B2: Infinity };
  let nextSignin: number = SCHEDULE.signinFirstMs, signins = 0, nextAuth: number = SCHEDULE.authFirstMs, auths = 0, nextRead = 0;
  let nextBurst: number | null = plan.b0Ms, burstsSent = 0, burstRunning = false, endAt = Infinity, b0Checked = !plan.failFast;
  let stoppedEarly: string | null = null, b0Checkpoint: string | null = null, b0CheckAtMs: number | null = null;
  /** Dispatches every owner and read slot for which `isDue(slot)` holds, each exactly once. */
  const schedule = (isDue: (slot: number) => boolean) => {
    for (const due of ['signin', 'auth'] as const) {
      while (isDue(due === 'signin' ? nextSignin : nextAuth)) {
        const dueMs = due === 'signin' ? nextSignin : nextAuth;
        const kind: OwnerKind = due === 'signin' ? (signins++ % 2 ? 'native_signin' : 'web_signin') : (auths++ % 2 ? 'revoke' : 'password');
        if (due === 'signin') nextSignin += SCHEDULE.signinEveryMs; else nextAuth += SCHEDULE.authEveryMs;
        if (inFlight) { skip(kind, dueMs); continue; }
        ownerOp(kind, { dueMs });
      }
    }
    while (isDue(nextRead)) {
      const dueMs = nextRead;
      nextRead += SCHEDULE.readEveryMs;
      bracket();
      if (readActive >= SCHEDULE.readInFlight) { skip('reads', dueMs); continue; }
      readActive++;
      track(io.read().then(r => { reads.push({ sentMs: r.start, status: r.status, ms: r.end - r.start, error: r.error, dueMs }); })
        .finally(() => { readActive--; }));
    }
  };
  /**
   * Fail fast after B0 on the pre-registered INVALID/INCONCLUSIVE conditions, always before burst 1 is
   * offered. A B0 owner operation still in flight can add at most one success of its own kind: a count
   * it cannot complete stops the run now; a count it could complete is left to the final judgment.
   */
  const checkpoint = (t: number) => {
    b0Checked = true; b0CheckAtMs = t;
    const pendingKind = inFlight && inFlight.sentMs < plan.b0Ms ? inFlight.kind : null;
    const ok = (k: OwnerKind, status: number) => owner.filter(o => o.kind === k && o.sentMs < plan.b0Ms && o.status === status).length;
    const counts = { password: ok('password', 204), revoke: ok('revoke', 204), signin: ok('web_signin', 200) + ok('native_signin', 200) };
    const reachable = { password: counts.password + (pendingKind === 'password' ? 1 : 0), revoke: counts.revoke + (pendingKind === 'revoke' ? 1 : 0),
      signin: counts.signin + (pendingKind === 'web_signin' || pendingKind === 'native_signin' ? 1 : 0) };
    const sampler = io.sampler();
    if (sampler.exited || sampler.medianMs === null || sampler.medianMs > SAMPLER.medianMaxMs) stoppedEarly = `invalid: sampler median ${sampler.medianMs} ms`;
    else if (reachable.password < C2_MIN_B0 || reachable.revoke < C2_MIN_B0)
      stoppedEarly = `inconclusive: B0 cannot reach ${C2_MIN_B0} successes (password ${counts.password}, revoke ${counts.revoke}, in flight ${pendingKind ?? 'none'})`;
    else if (reachable.signin === 0) stoppedEarly = 'inconclusive: no B0 owner sign-in success (V undefined)';
    const decided = counts.password >= C2_MIN_B0 && counts.revoke >= C2_MIN_B0 && counts.signin > 0;
    b0Checkpoint = stoppedEarly ? 'stopped' : decided ? 'complete' : `B0 counts left to the final judgment (${pendingKind} in flight)`;
  };

  let completed = false;
  while (!io.aborted()) {
    const t = now();
    if (t >= endAt) { completed = true; break; }
    if (!b0Checked && t >= plan.b0Ms) { checkpoint(t); if (stoppedEarly) break; }
    if (nextBurst !== null && t >= nextBurst && !burstRunning && b0Checked) {
      const index = ++burstsSent;
      nextBurst = null; burstRunning = true;
      track(sendBurst(index).then(admittedAt => {
        burstRunning = false;
        if (index < plan.bursts) { nextBurst = admittedAt + BURST.gapMs; return; }
        const last = attack.filter(a => a.burst === index && a.status === 401).map(a => a.endMs);
        const all = attack.filter(a => a.burst === index).map(a => a.endMs);
        phaseStartMs.B2 = Math.max(...(last.length ? last : all.length ? all : [now()])) + plan.b1TailMs;
        endAt = phaseStartMs.B2 + plan.b2Ms;
      }));
    }
    schedule(slot => slot <= t);
    await sleep(TICK_MS);
  }
  // Slots due in the last tick before the end of B2 are still dispatched, so the schedule covers [0, endAt).
  if (completed) schedule(slot => slot < endAt);
  while (pending.size) await Promise.all([...pending]);
  return { owner, attack, reads, bursts, skipped, skippedSlots, clockBrackets, phaseStartMs, scheduleEndMs: completed ? endAt : now(), endMs: now(),
    stoppedEarly, b0Checkpoint, b0CheckAtMs, completed };
}
