// #756 burst-mode judgment, as pre-registered (issue #756, comment 7075307714, approved 2026-11-22):
// A0 (validity gate), B1-B5 from #359 unchanged (the legacy `judge`, fed with the burst run), C1 and C2.
// An INVALID or INCONCLUSIVE run is never a pass; only `holds` in 3 recorded runs is PASS.
import { judge, type OwnerOp, type Phase } from './signin-owner-judgment.ts';
import { distribution } from './signin-summary.ts';
import { BURST, BURST_ADMITS, EVIDENCE, RECORDED_BURSTS, SAMPLER } from './signin-owner-burst-config.ts';
import { peakSimultaneous, samplerIntegrity, samplerIntervals, type SamplerRow, type WaitInterval } from './signin-owner-burst-locks.ts';

export type OwnerKind = 'web_signin' | 'native_signin' | 'password' | 'revoke';
export type BurstOwnerOp = { kind: OwnerKind; sentMs: number; endMs: number; ms: number; status: number; error?: string; burst?: number };
export type BurstAttackOp = { burst: number; send: number; sentMs: number; endMs: number; ms: number; status: number; error?: string };
export type BurstReadOp = { sentMs: number; status: number; ms: number; error?: string };
// ownerOp `undecided`: admission was still unknown ownerLateMs after the planned offset, so nothing was sent.
export type Burst = { index: number; sends: { sentMs: number; statuses: number[] }[]; admittedSend: number | null;
  ownerOp: 'sent' | 'skipped' | 'missing' | 'undecided'; ownerOpSend: number | null };
// `waits` are X-row intervals with harness-clock times (`startMs`/`endMs`) next to the database times.
export type XWait = WaitInterval & { startMs: number; endMs: number; who: 'owner' | 'signin' | 'unknown' };
export type BurstRun = { owner: BurstOwnerOp[]; attack: BurstAttackOp[]; reads: BurstReadOp[]; bursts: Burst[];
  samples: SamplerRow[]; samplerMalformed: number; offsetMs: number | null; waits: XWait[]; lockLog: { complete: boolean; reasons: string[] };
  phaseStartMs: Record<Phase, number>; endMs: number; poolMax: number; skipped: { reads: number };
  server: { poolTimeouts: number; panics: number; complete: boolean } };
type Check = { pass: boolean; detail: string };
export type Verdict = 'holds' | 'fails' | 'inconclusive' | 'invalid';

const AUTH: OwnerKind[] = ['password', 'revoke'];
const C2_MIN_B0 = 4, A0_PIDS = 2, A0_BURSTS = 2, B3_MAX = 7;

export function phaseAt(run: Pick<BurstRun, 'phaseStartMs'>, ms: number): Phase {
  return ms < run.phaseStartMs.B1 ? 'B0' : ms < run.phaseStartMs.B2 ? 'B1' : 'B2';
}

/**
 * Burst k's evidence window (harness clock, half-open): from its admitted send - clockMs to the last
 * answer of that send or of its burst-time owner operation + clockMs. No admitted send, no window.
 */
export function burstWindows(run: Pick<BurstRun, 'bursts' | 'attack' | 'owner'>) {
  return run.bursts.map(b => {
    if (b.admittedSend === null || !b.sends[b.admittedSend]) return { burst: b.index, window: null };
    const ends = [...run.attack.filter(a => a.burst === b.index && a.send === b.admittedSend).map(a => a.endMs),
      ...run.owner.filter(o => o.burst === b.index).map(o => o.endMs)];
    const sentMs = b.sends[b.admittedSend].sentMs;
    return { burst: b.index, window: { startMs: sentMs - EVIDENCE.clockMs, endMs: Math.max(sentMs, ...ends) + EVIDENCE.clockMs } };
  });
}
const inWindow = (w: { startMs: number; endMs: number } | null, ms: number) => w !== null && ms >= w.startMs && ms < w.endMs;
export const samplesIn = (run: Pick<BurstRun, 'samples' | 'offsetMs'>, w: { startMs: number; endMs: number } | null) =>
  run.offsetMs === null ? [] : run.samples.filter(s => inWindow(w, s.dbMs + run.offsetMs!));

function waitsByBurst(run: BurstRun) {
  return burstWindows(run).map(({ burst, window }) => {
    const waits = run.waits.filter(w => inWindow(window, w.startMs));
    const peak = peakSimultaneous(waits);
    return { burst, window, count: waits.length, peakPids: peak.peak, peakAtDbMs: peak.atDbMs, pids: peak.pids,
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
        && run.bursts.every(b => b.ownerOp === 'sent' && b.ownerOpSend !== null && b.ownerOpSend === b.admittedSend),
      detail: run.bursts.map(b => `burst ${b.index}: ${b.ownerOp} on send ${b.ownerOpSend} (admitted ${b.admittedSend})`).join('; ') },
    lockOverlap: { pass: run.lockLog.complete && run.bursts.length === RECORDED_BURSTS && overlapping >= A0_BURSTS,
      detail: `${overlapping} of ${run.bursts.length} bursts with >= ${A0_PIDS} pids waiting at once inside the burst window (peaks ${locks.map(l => l.peakPids).join(', ')}); lock log ${run.lockLog.complete ? 'complete' : 'incomplete: ' + run.lockLog.reasons.join(', ')}` },
  };
  return { pass: Object.values(checks).every(c => c.pass), checks, locks };
}

/**
 * Evidence completeness beyond A0 (each failure is INCONCLUSIVE, never a fail or a pass): the
 * burst-time owner operation left on time after the admitted send; sampler rows are well-formed and
 * strictly increasing, and cover every burst window; no Organization B read was skipped.
 */
export function evidence(run: BurstRun) {
  const timing = run.bursts.map(b => {
    const op = run.owner.find(o => o.burst === b.index);
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
  const checks: Record<'ownerOpTiming' | 'samplerIntegrity' | 'samplerCoverage' | 'readsComplete', Check> = {
    ownerOpTiming: { pass: timing.length > 0 && timing.every(t => t.offsetMs !== null && t.offsetMs >= BURST.ownerOffsetMs && t.offsetMs <= lateMax),
      detail: `burst-time owner operation after the admitted send: ${timing.map(t => `burst ${t.burst} ${t.offsetMs === null ? 'none' : t.offsetMs.toFixed(1) + ' ms'}`).join(', ')} (planned ${BURST.ownerOffsetMs}, at most ${lateMax} ms)` },
    samplerIntegrity: { pass: integrity.ok,
      detail: `malformed rows ${integrity.malformed}; duplicate database timestamps ${integrity.duplicate}; backward ${integrity.backward}` },
    samplerCoverage: { pass: coverage.length > 0 && coverage.every(c => c.ok),
      detail: coverage.map(c => `burst ${c.burst}: ${c.samples} samples, median ${c.medianMs} ms, max gap ${c.maxGapMs} ms`).join('; ') + ` (median <= ${SAMPLER.medianMaxMs}, gap <= ${EVIDENCE.burstMaxGapMs} ms)` },
    readsComplete: { pass: run.skipped.reads === 0, detail: `${run.skipped.reads} scheduled Organization B reads skipped` },
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
