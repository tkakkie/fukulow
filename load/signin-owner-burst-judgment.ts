// #756 burst-mode judgment, as pre-registered (issue #756, comment 7075307714, approved 2026-11-22):
// A0 (validity gate), B1-B5 from #359 unchanged (the legacy `judge`, fed with the burst run), C1 and C2.
// An INVALID or INCONCLUSIVE run is never a pass; only `holds` in 3 recorded runs is PASS.
import { judge, type OwnerOp, type Phase } from './signin-owner-judgment.ts';
import { distribution } from './signin-summary.ts';
import { BURST, BURST_ADMITS, EVIDENCE, RECORDED_BURSTS, SAMPLER, SCHEDULE, type Plan } from './signin-owner-burst-config.ts';
import { peakSimultaneous, samplerIntegrity, samplerIntervals, type SamplerRow, type WaitInterval } from './signin-owner-burst-locks.ts';

export type OwnerKind = 'web_signin' | 'native_signin' | 'password' | 'revoke';
// `dueMs`: the schedule slot of a periodic owner operation or a read. A burst-time owner operation has
// none; it names its burst and the send it was fired on (`burstSend`). `ms` is exactly `endMs - sentMs`.
export type BurstOwnerOp = { kind: OwnerKind; sentMs: number; endMs: number; ms: number; status: number; error?: string; burst?: number;
  burstSend?: number; dueMs?: number };
export type BurstAttackOp = { burst: number; send: number; sentMs: number; endMs: number; ms: number; status: number; error?: string };
export type BurstReadOp = { sentMs: number; status: number; ms: number; error?: string; dueMs: number };
// ownerOp `undecided`: admission was still unknown ownerLateMs after the planned offset, so nothing was sent.
// wastedOwnerOpSends: sends whose owner operation was fired but which then turned out refused (never credited).
export type Burst = { index: number; sends: { sentMs: number; statuses: number[] }[]; admittedSend: number | null;
  ownerOp: 'sent' | 'skipped' | 'missing' | 'undecided'; ownerOpSend: number | null; wastedOwnerOpSends: number[] };
// `waits` are X-row intervals with harness-clock times (`startMs`/`endMs`) next to the database times.
export type XWait = WaitInterval & { startMs: number; endMs: number; who: 'owner' | 'signin' | 'unknown';
  whoSource?: 'sampler' | 'statement' | 'conflict' | 'none' };
export type BurstRun = { owner: BurstOwnerOp[]; attack: BurstAttackOp[]; reads: BurstReadOp[]; bursts: Burst[];
  samples: SamplerRow[]; samplerMalformed: number; offsetMs: number | null; waits: XWait[]; lockLog: { complete: boolean; reasons: string[] };
  phaseStartMs: Record<Phase, number>; endMs: number; poolMax: number; plan: Pick<Plan, 'b0Ms' | 'bursts' | 'b1TailMs' | 'b2Ms'>;
  // scheduleEndMs: the end of the schedule (exclusive); every owner and read slot before it was due.
  // A completed run ends it exactly at the end of B2.
  scheduleEndMs: number; skipped: Record<'reads' | OwnerKind, number>;
  server: { poolTimeouts: number; panics: number; complete: boolean; burstPoolTimeouts?: (number | null)[] } };
type Check = { pass: boolean; detail: string };
export type Verdict = 'holds' | 'fails' | 'inconclusive' | 'invalid';

const AUTH: OwnerKind[] = ['password', 'revoke'];
const KINDS: OwnerKind[] = ['web_signin', 'native_signin', 'password', 'revoke'];
/** The pre-registered burst-time owner operation: password change on odd bursts, revoke-others on even ones. */
export const burstOwnerKind = (index: number): OwnerKind => index % 2 ? 'password' : 'revoke';
const C2_MIN_B0 = 4, A0_PIDS = 2, A0_BURSTS = 2, B3_MAX = 7;

export function phaseAt(run: Pick<BurstRun, 'phaseStartMs'>, ms: number): Phase {
  return ms < run.phaseStartMs.B1 ? 'B0' : ms < run.phaseStartMs.B2 ? 'B1' : 'B2';
}

/**
 * Burst k's padded window (harness clock, half-open): its span (below) widened by clockMs on both sides,
 * for sampler coverage and the report. No admitted send, no window.
 */
export function burstWindows(run: Pick<BurstRun, 'bursts' | 'attack' | 'owner'>) {
  return run.bursts.map(b => {
    const span = burstSpan(run, b);
    return { burst: b.index, window: span && { startMs: span.startMs - EVIDENCE.clockMs, endMs: span.endMs + EVIDENCE.clockMs } };
  });
}
const inWindow = (w: { startMs: number; endMs: number } | null, ms: number) => w !== null && ms >= w.startMs && ms < w.endMs;
export const samplesIn = (run: Pick<BurstRun, 'samples' | 'offsetMs'>, w: { startMs: number; endMs: number } | null) =>
  run.offsetMs === null ? [] : run.samples.filter(s => inWindow(w, s.dbMs + run.offsetMs!));

/** Burst k's own span (harness clock, half-open, unpadded): its admitted send to the last answer of that send or its owner operation. */
export function burstSpan(run: Pick<BurstRun, 'bursts' | 'attack' | 'owner'>, b: Burst) {
  if (b.admittedSend === null || !b.sends[b.admittedSend]) return null;
  const sentMs = b.sends[b.admittedSend].sentMs;
  const ends = [...run.attack.filter(a => a.burst === b.index && a.send === b.admittedSend).map(a => a.endMs),
    ...run.owner.filter(o => o.burst === b.index && o.burstSend === b.admittedSend).map(o => o.endMs)];
  return { startMs: sentMs, endMs: Math.max(sentMs, ...ends) };
}

type Request = { sentMs: number; endMs: number };
const SIGNIN_KINDS: OwnerKind[] = ['web_signin', 'native_signin'];
/**
 * The requests that can wait on X's row with a sign-in statement or an owner (password change /
 * revoke-others) statement: this burst's own requests (its admitted send's 401 answers; its credited
 * owner operation) and every other X request of the run (periodic owner operations, other sends and bursts).
 */
function requestsOf(run: BurstRun, b: Burst) {
  const own = (a: BurstAttackOp) => a.burst === b.index && a.send === b.admittedSend;
  const ownOp = (o: BurstOwnerOp) => o.burst === b.index && o.burstSend === b.admittedSend;
  return {
    signin: { own: run.attack.filter(a => own(a) && a.status === 401) as Request[],
      other: [...run.attack.filter(a => !own(a)), ...run.owner.filter(o => SIGNIN_KINDS.includes(o.kind))] as Request[] },
    owner: { own: run.owner.filter(o => ownOp(o) && AUTH.includes(o.kind)) as Request[],
      other: run.owner.filter(o => !ownOp(o) && AUTH.includes(o.kind)) as Request[] },
  };
}
/**
 * A0 overlap evidence. A wait counts for burst k only through a recorded link to one of k's own
 * requests: it is attributed (`who` exactly 'signin' or 'owner'), it lies inside the lifetime of a
 * request of k that issues that statement, and no other X request issuing that statement is in flight
 * at any point of the wait (else it is ambiguous). Missing or unknown attribution, a wait merely near
 * the burst, or one that a request outside the burst could explain is never evidence for A0. The
 * simultaneous waiters at the peak must be explained by as many distinct requests of k.
 */
function waitsByBurst(run: BurstRun) {
  return run.bursts.map(b => {
    const span = burstSpan(run, b), reqs = span ? requestsOf(run, b) : null;
    const linked = !reqs ? [] : run.waits.flatMap(w => {
      if (w.who !== 'signin' && w.who !== 'owner') return [];
      const { own, other } = reqs[w.who];
      const links = own.filter(r => w.startMs >= r.sentMs && w.endMs <= r.endMs);
      if (!links.length || other.some(r => r.sentMs < w.endMs && r.endMs > w.startMs)) return [];
      return [{ wait: w, links }];
    });
    const peak = peakSimultaneous(linked.map(l => ({ pid: l.wait.pid, startDbMs: l.wait.startMs, endDbMs: l.wait.endMs })));
    const atPeak = linked.filter(l => peak.atDbMs !== null && l.wait.startMs <= peak.atDbMs && l.wait.endMs > peak.atDbMs && peak.pids.includes(l.wait.pid));
    const distinct = new Set(atPeak.flatMap(l => l.links)).size;
    const waits = linked.map(l => l.wait);
    return { burst: b.index, span, count: waits.length, peakPids: Math.min(peak.peak, distinct), peakAtMs: peak.atDbMs, pids: peak.pids,
      maxWaitMs: waits.length ? Math.max(...waits.map(w => w.waitedMs)) : null,
      ownerWaits: waits.filter(w => w.who === 'owner').map(w => w.waitedMs), waitsMs: waits.map(w => w.waitedMs) };
  });
}

export function a0(run: BurstRun) {
  const counted = run.bursts.map(b => run.attack.filter(a => a.burst === b.index && a.status === 401).length);
  const locks = waitsByBurst(run);
  const overlapping = locks.filter(l => l.peakPids >= A0_PIDS).length;
  const checks: Record<'bursts' | 'ownerOps' | 'lockOverlap', Check> = {
    bursts: { pass: run.bursts.length === RECORDED_BURSTS && counted.every(c => c === BURST_ADMITS),
      detail: `${run.bursts.length}/${RECORDED_BURSTS} bursts; counted (401) per burst ${counted.join(', ')}; resends ${run.bursts.map(b => b.sends.length - 1).join(', ')}` },
    ownerOps: { pass: run.bursts.length === RECORDED_BURSTS
        && run.bursts.every(b => b.ownerOp === 'sent' && b.ownerOpSend !== null && b.ownerOpSend === b.admittedSend
          && Array.isArray(b.wastedOwnerOpSends) && b.wastedOwnerOpSends.length === 0),
      detail: run.bursts.map(b => `burst ${b.index}: ${b.ownerOp} on send ${b.ownerOpSend} (admitted ${b.admittedSend}; owner operations on refused sends ${b.wastedOwnerOpSends?.join(', ') || 'none'})`).join('; ') },
    lockOverlap: { pass: run.lockLog.complete && run.bursts.length === RECORDED_BURSTS && overlapping >= A0_BURSTS,
      detail: `${overlapping} of ${run.bursts.length} bursts with >= ${A0_PIDS} attributed pids waiting at once inside the burst's own span (peaks ${locks.map(l => l.peakPids).join(', ')}); lock log ${run.lockLog.complete ? 'complete' : 'incomplete: ' + run.lockLog.reasons.join(', ')}` },
  };
  return { pass: Object.values(checks).every(c => c.pass), checks, locks };
}

const slots = (first: number, every: number, end: number) => {
  const out: number[] = [];
  for (let t = first; t < end; t += every) out.push(t);
  return out;
};
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const status = (x: unknown) => Number.isInteger(x) && (x as number) >= 0;
const errorOk = (x: unknown) => x === undefined || typeof x === 'string';
/**
 * Every field that C1, C2 and B1-B5 read is present and consistent: kind, sentMs, endMs, status and
 * `ms === endMs - sentMs` (the harness records it so; any other value is a rewritten record).
 */
function fieldGaps(run: BurstRun) {
  const gaps: string[] = [];
  const timed = (o: { sentMs: unknown; endMs: unknown; ms: unknown; status: unknown; error?: unknown }) =>
    num(o.sentMs) && num(o.endMs) && num(o.ms) && o.ms === o.endMs - o.sentMs && status(o.status) && errorOk(o.error);
  const bad = (label: string, n: number) => { if (n) gaps.push(`${n} ${label} records missing or inconsistent fields`); };
  bad('owner', run.owner.filter(o => !KINDS.includes(o.kind) || !timed(o)).length);
  bad('attack', run.attack.filter(a => !timed(a) || !Number.isInteger(a.burst) || !Number.isInteger(a.send)).length);
  bad('read', run.reads.filter(r => !num(r.sentMs) || !num(r.ms) || r.ms < 0 || !status(r.status) || !num(r.dueMs) || !errorOk(r.error)).length);
  return gaps;
}
/**
 * The artifact holds the whole planned workload: all 16 answers of every burst send (matching the
 * send's own status list, re-sends only after an all-429 send), exactly one burst-time owner operation
 * per `sent` burst, and every owner and Organization B read slot up to the last scheduler tick either
 * recorded once with the scheduled kind or counted as skipped. A stripped artifact never holds.
 */
export function workloadGaps(run: BurstRun) {
  const gaps: string[] = fieldGaps(run);
  const sorted = (a: readonly number[]) => [...a].sort((x, y) => x - y).join(',');
  for (const b of run.bursts) {
    b.sends.forEach((send, j) => {
      const answers = run.attack.filter(a => a.burst === b.index && a.send === j).map(a => a.status);
      if (answers.length !== BURST.size || sorted(answers) !== sorted(send.statuses)) gaps.push(`burst ${b.index} send ${j}: ${answers.length}/${BURST.size} answers recorded`);
      const last = j === b.sends.length - 1;
      if (!last && !(send.statuses.length === BURST.size && send.statuses.every(s => s === 429))) gaps.push(`burst ${b.index} send ${j} re-sent without being refused`);
    });
    if (b.admittedSend !== null && b.admittedSend !== b.sends.length - 1) gaps.push(`burst ${b.index}: sends after the admitted send`);
    // The credited operation (on ownerOpSend) plus one per refused send it was wasted on, each once, of the burst's kind.
    const ops = run.owner.filter(o => o.burst === b.index);
    const wasted = Array.isArray(b.wastedOwnerOpSends) ? b.wastedOwnerOpSends : [];
    const expected = [...wasted, ...(b.ownerOp === 'sent' && b.ownerOpSend !== null ? [b.ownerOpSend] : [])];
    if (!Array.isArray(b.wastedOwnerOpSends) || ops.length !== expected.length || sorted(ops.map(o => o.burstSend ?? -1)) !== sorted(expected))
      gaps.push(`burst ${b.index}: ${ops.length} burst-time owner operations for state ${b.ownerOp} (refused sends ${wasted.join(', ') || 'none'})`);
    if (ops.some(o => o.kind !== burstOwnerKind(b.index))) gaps.push(`burst ${b.index}: burst-time owner operation of the wrong kind`);
  }
  if (run.attack.some(a => !run.bursts.some(b => b.index === a.burst && a.send >= 0 && a.send < b.sends.length))) gaps.push('attack answers outside any burst send');
  const family = (due: number[], kinds: [OwnerKind, OwnerKind], label: string) => {
    const ops = run.owner.filter(o => o.burst === undefined && kinds.includes(o.kind));
    const expected = new Map(due.map((t, k) => [t, kinds[k % 2]]));
    const seen = new Set<number>();
    for (const o of ops) {
      if (o.dueMs === undefined || expected.get(o.dueMs) !== o.kind || seen.has(o.dueMs)) { gaps.push(`${label}: unscheduled or repeated operation`); return; }
      seen.add(o.dueMs);
    }
    const skipped = run.skipped[kinds[0]] + run.skipped[kinds[1]];
    if (seen.size + skipped !== due.length) gaps.push(`${label}: ${seen.size} recorded + ${skipped} skipped of ${due.length} slots`);
  };
  family(slots(SCHEDULE.signinFirstMs, SCHEDULE.signinEveryMs, run.scheduleEndMs), ['web_signin', 'native_signin'], 'owner sign-ins');
  family(slots(SCHEDULE.authFirstMs, SCHEDULE.authEveryMs, run.scheduleEndMs), ['password', 'revoke'], 'owner authenticated operations');
  if (run.owner.some(o => o.burst !== undefined && o.dueMs !== undefined)) gaps.push('burst-time owner operation with a schedule slot');
  const readSlots = new Set(slots(0, SCHEDULE.readEveryMs, run.scheduleEndMs)), readSeen = new Set<number>();
  for (const r of run.reads) {
    if (!readSlots.has(r.dueMs) || readSeen.has(r.dueMs)) { gaps.push('Organization B reads: unscheduled or repeated read'); break; }
    readSeen.add(r.dueMs);
  }
  if (readSeen.size + run.skipped.reads !== readSlots.size) gaps.push(`Organization B reads: ${readSeen.size} recorded + ${run.skipped.reads} skipped of ${readSlots.size} slots`);
  // The whole plan ran: B1 starts at the end of B0, B2 b1TailMs after the last counted failure of the
  // last burst, and the schedule (owner operations, reads) and the run (answers, sampler) reach the end of B2.
  const plan = run.plan, last = run.bursts.at(-1);
  const lastCounted = last ? run.attack.filter(a => a.burst === last.index && a.status === 401).map(a => a.endMs) : [];
  if (!plan || !num(plan.b0Ms) || !num(plan.b1TailMs) || !num(plan.b2Ms) || !Number.isInteger(plan.bursts)) gaps.push('no plan recorded');
  else {
    if (run.phaseStartMs.B0 !== 0 || run.phaseStartMs.B1 !== plan.b0Ms) gaps.push('B1 does not start at the end of B0');
    if (run.bursts.length !== plan.bursts || run.bursts.some((b, i) => b.index !== i + 1)) gaps.push(`${run.bursts.length} of ${plan.bursts} planned bursts`);
    if (!lastCounted.length || run.phaseStartMs.B2 !== Math.max(...lastCounted) + plan.b1TailMs) gaps.push(`B2 does not start ${plan.b1TailMs} ms after the last counted failure`);
    if (run.scheduleEndMs !== run.phaseStartMs.B2 + plan.b2Ms || !(run.endMs >= run.scheduleEndMs))
      gaps.push(`schedule ended at ${run.scheduleEndMs} ms, not at the end of B2 (${run.phaseStartMs.B2 + plan.b2Ms} ms)`);
  }
  return gaps;
}

/**
 * Evidence completeness beyond A0 (each failure is INCONCLUSIVE, never a fail or a pass): the
 * burst-time owner operation left on time after the admitted send; sampler rows are well-formed and
 * strictly increasing, and cover every burst window; no Organization B read was skipped.
 */
export function evidence(run: BurstRun) {
  const timing = run.bursts.map(b => {
    const op = run.owner.find(o => o.burst === b.index && o.burstSend === b.admittedSend);
    const admitted = b.admittedSend === null ? undefined : b.sends[b.admittedSend];
    return { burst: b.index, offsetMs: op && admitted ? op.sentMs - admitted.sentMs : null };
  });
  const lateMax = BURST.ownerOffsetMs + EVIDENCE.ownerLateMs;
  const integrity = samplerIntegrity(run.samples, run.samplerMalformed);
  const coverage = burstWindows(run).map(({ burst, window }) => {
    const rows = samplesIn(run, window), local = samplerIntervals(rows);
    const times = window ? [window.startMs, ...rows.map(r => r.dbMs + run.offsetMs!), window.endMs] : [];
    const maxGapMs = times.length > 2 ? Math.max(...times.slice(1).map((t, i) => t - times[i])) : null;
    return { burst, samples: rows.length, medianMs: local.medianMs, maxGapMs,
      ok: local.medianMs !== null && local.medianMs <= SAMPLER.medianMaxMs && maxGapMs !== null && maxGapMs <= EVIDENCE.burstMaxGapMs };
  });
  const runTimes = run.offsetMs === null ? [] : [0, ...run.samples.map(s => s.dbMs + run.offsetMs!).filter(t => t >= 0 && t < run.endMs), run.endMs];
  const runMaxGapMs = runTimes.length > 2 ? Math.max(...runTimes.slice(1).map((t, i) => t - runTimes[i])) : null;
  const workload = workloadGaps(run);
  const checks: Record<'ownerOpTiming' | 'samplerIntegrity' | 'samplerCoverage' | 'samplerRunCoverage' | 'readsComplete' | 'workloadComplete', Check> = {
    ownerOpTiming: { pass: timing.length > 0 && timing.every(t => t.offsetMs !== null && t.offsetMs >= BURST.ownerOffsetMs && t.offsetMs <= lateMax),
      detail: `burst-time owner operation after the admitted send: ${timing.map(t => `burst ${t.burst} ${t.offsetMs === null ? 'none' : t.offsetMs.toFixed(1) + ' ms'}`).join(', ')} (planned ${BURST.ownerOffsetMs}, at most ${lateMax} ms)` },
    samplerIntegrity: { pass: integrity.ok,
      detail: `malformed rows ${integrity.malformed}; duplicate database timestamps ${integrity.duplicate}; backward ${integrity.backward}` },
    samplerCoverage: { pass: coverage.length > 0 && coverage.every(c => c.ok),
      detail: coverage.map(c => `burst ${c.burst}: ${c.samples} samples, median ${c.medianMs} ms, max gap ${c.maxGapMs} ms`).join('; ') + ` (median <= ${SAMPLER.medianMaxMs}, gap <= ${EVIDENCE.burstMaxGapMs} ms)` },
    samplerRunCoverage: { pass: runMaxGapMs !== null && runMaxGapMs <= EVIDENCE.burstMaxGapMs,
      detail: `largest sampler gap over the whole run (B0-B2) ${runMaxGapMs} ms (<= ${EVIDENCE.burstMaxGapMs} ms)` },
    readsComplete: { pass: run.skipped.reads === 0, detail: `${run.skipped.reads} scheduled Organization B reads skipped` },
    workloadComplete: { pass: workload.length === 0, detail: workload.length ? workload.join('; ') : 'every scheduled operation and every answer is recorded' },
  };
  return { pass: Object.values(checks).every(c => c.pass), checks, coverage, timing };
}

const legacyKind = (k: OwnerKind): OwnerOp['kind'] => k === 'web_signin' || k === 'native_signin' ? 'signin' : 'password';
const ok = (s: number) => s === 200 || s === 204;

/** B1-B5 exactly as #359's `judge`; B3's waiter count is the higher of the log's simultaneous pids and the sampler. */
export function b1to5(run: BurstRun) {
  const at = (ms: number) => phaseAt(run, ms);
  const legacy = judge({
    owner: run.owner.map(o => ({ kind: legacyKind(o.kind), phase: at(o.sentMs), status: o.status, ms: o.ms, endMs: o.endMs, error: o.error })),
    attack: run.attack.map(a => ({ phase: at(a.sentMs), status: a.status, ms: a.ms, endMs: a.endMs, error: a.error })),
    reads: run.reads.map(r => ({ phase: at(r.sentMs), status: r.status, ms: r.ms, error: r.error })),
    locks: run.offsetMs === null ? [] : run.samples.map(s => ({ atMs: s.dbMs + run.offsetMs!, waiters: s.waiting.length,
      maxWaitMs: s.maxWaitMs, connections: s.connections })),
    phaseStartMs: run.phaseStartMs, endMs: run.endMs, poolMax: run.poolMax, server: run.server });
  const logPeak = peakSimultaneous(run.waits.filter(w => w.startMs >= 0)).peak;
  const samplerPeak = Math.max(0, ...run.samples.filter(s => run.offsetMs !== null && s.dbMs + run.offsetMs >= 0).map(s => s.waiting.length));
  const waiters = Math.max(logPeak, samplerPeak);
  const checks = { ...legacy.checks, B3: { pass: legacy.checks.B3.pass && run.lockLog.complete && waiters <= B3_MAX,
    detail: `waiters ${waiters} (log ${logPeak}, sampler ${samplerPeak}) <= ${B3_MAX}; ${legacy.checks.B3.detail}` } };
  return { legacy, checks, waiters: { log: logPeak, sampler: samplerPeak },
    incomplete: legacy.incomplete, v: legacy.phases.B0.owner.signin.p50 };
}

export function c1c2(run: BurstRun, v: number | null) {
  const at = (ms: number) => phaseAt(run, ms);
  const b0 = Object.fromEntries(AUTH.map(kind => [kind, distribution(run.owner
    .filter(o => o.kind === kind && at(o.sentMs) === 'B0' && o.status === 204).map(o => o.ms))])) as Record<OwnerKind, ReturnType<typeof distribution>>;
  const b1 = run.owner.filter(o => AUTH.includes(o.kind) && at(o.sentMs) === 'B1');
  const enough = AUTH.every(k => b0[k].count >= C2_MIN_B0);
  const bound = (k: OwnerKind) => b0[k].p95 !== null && v !== null ? b0[k].p95! + 5 * v : null;
  const late = b1.filter(o => { const b = bound(o.kind); return o.status === 0 || b === null || o.ms > b; });
  const not204 = b1.filter(o => o.status !== 204);
  const delays = b1.map(o => ({ kind: o.kind, burst: o.burst ?? null, status: o.status, ms: o.ms,
    totalQueuingDelayMs: b0[o.kind].p50 === null ? null : o.ms - b0[o.kind].p50! }));
  return {
    sampleCountsOk: enough, b0, bounds: { password: bound('password'), revoke: bound('revoke') }, delays,
    checks: {
      C1: { pass: b1.length > 0 && not204.length === 0,
        detail: `${b1.length - not204.length}/${b1.length} B1 password change/revoke-others returned 204; others ${not204.map(o => `${o.kind} ${o.status} ${o.error ?? ''}`.trim()).join(', ') || 'none'}` },
      C2: { pass: enough && b1.length > 0 && late.length === 0,
        detail: `${late.length} of ${b1.length} over bound (password ${bound('password')?.toFixed(1)} ms, revoke ${bound('revoke')?.toFixed(1)} ms); B0 successes password ${b0.password.count}, revoke ${b0.revoke.count} (need >= ${C2_MIN_B0})` },
    } satisfies Record<'C1' | 'C2', Check>,
  };
}

/**
 * Precedence: invalid (sampler median) > inconclusive (A0, too few B0 samples, incomplete evidence)
 * > fails > holds.
 */
export function judgeBurst(run: BurstRun) {
  const intervals = samplerIntervals(run.samples);
  const sampler = { ...intervals, valid: intervals.medianMs !== null && intervals.medianMs <= SAMPLER.medianMaxMs };
  const gate = a0(run), proof = evidence(run), b = b1to5(run), c = c1c2(run, b.v);
  const checks = { ...b.checks, ...c.checks };
  const reasons: string[] = [];
  if (!gate.pass) reasons.push('A0 failed');
  for (const [name, check] of Object.entries(proof.checks)) if (!check.pass) reasons.push(`evidence ${name}: ${check.detail}`);
  if (!c.sampleCountsOk) reasons.push(`fewer than ${C2_MIN_B0} B0 successes of a kind`);
  if (b.incomplete) reasons.push('B1-B5 evidence incomplete');
  if (!run.lockLog.complete) reasons.push('lock log incomplete');
  const verdict: Verdict = !sampler.valid ? 'invalid' : reasons.length ? 'inconclusive'
    : Object.values(checks).every(x => x.pass) ? 'holds' : 'fails';
  return { verdict, reasons: sampler.valid ? reasons : [`sampler median interval ${sampler.medianMs} ms > ${SAMPLER.medianMaxMs} ms`, ...reasons],
    sampler, a0: gate, evidence: proof, checks, waiters: b.waiters, c2: { bounds: c.bounds, b0: c.b0, delays: c.delays },
    bounds: b.legacy.bounds, phases: b.legacy.phases, causes: b.legacy.causes, b2Strict: b.legacy.b2Strict, v: b.v };
}

export type AggregateRun = { id: string | null; evidence: boolean; verdict: Verdict | null; problem?: string };
/**
 * The pre-registered outcome over the 3 recorded runs ("Outcome"): a run is valid when it is evidence
 * and judged `holds` or `fails`. Fewer than 3 valid runs is INCONCLUSIVE, whatever the valid ones say;
 * with 3 valid runs, any `fails` is FAIL and all `holds` is PASS. Individual failures stay listed.
 * Runs must be 3 distinct run identities; a repeated one is not evidence.
 */
export function aggregate(runs: readonly AggregateRun[]) {
  if (runs.length !== 3) throw new Error('Aggregate exactly the 3 pre-registered runs');
  const ids = runs.map(r => r.id);
  const checked = runs.map((r, i) => r.id === null ? { ...r, evidence: false, problem: r.problem ?? 'no run identity' }
    : ids.indexOf(r.id) !== i ? { ...r, evidence: false, problem: 'duplicate run identity' } : r);
  const valid = checked.filter(r => r.evidence && (r.verdict === 'holds' || r.verdict === 'fails'));
  const failures = checked.filter(r => r.evidence && r.verdict === 'fails').map(r => r.id);
  const outcome = valid.length < 3 ? 'INCONCLUSIVE' : failures.length ? 'FAIL' : 'PASS';
  return { outcome, valid: valid.length, failures,
    verdicts: checked.map(r => (r.evidence ? '' : 'not-evidence:') + (r.verdict ?? 'none') + (r.problem ? ` (${r.problem})` : '')) };
}
