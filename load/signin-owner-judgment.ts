// #359 Part B, alternative method (maintainer, 2026-11-21): the pre-registered B1–B5 criteria,
// unchanged, applied to one run. The workload deviates (one attacker IP, under 50 offered/s),
// so a pass here is never a formal Part B PASS; `formal` stays false.
import { distribution } from './signin-summary.ts';
import type { ErrorBody } from '../web/src/api-schema.d.ts';

export type Phase = 'B0' | 'B1' | 'B2';
// `error` is the response's ErrorBody code for a non-2xx answer (a server constant, never data), else absent.
export type OwnerOp = { kind: 'signin' | 'password'; phase: Phase; status: number; ms: number; endMs: number; error?: string };
export type AttackOp = { phase: Phase; status: number; ms: number; endMs: number; error?: string };
export type ReadOp = { phase: Phase; status: number; ms: number; error?: string };
export type LockSample = { atMs: number; waiters: number; maxWaitMs: number; connections: number };
export type ServerEvidence = { poolTimeouts: number; panics: number; complete: boolean };
export type Run = { owner: OwnerOp[]; attack: AttackOp[]; reads: ReadOp[]; locks: LockSample[];
  phaseStartMs: Record<Phase, number>; endMs: number; poolMax: number; server: ServerEvidence };
type Check = { pass: boolean; detail: string };

const ok = (status: number) => status === 200 || status === 204;
const inPhase = <T extends { phase: Phase }>(items: readonly T[], phase: Phase) => items.filter(i => i.phase === phase);
const samplesIn = (run: Run, phase: Phase) => {
  const order: Phase[] = ['B0', 'B1', 'B2'];
  const next = order[order.indexOf(phase) + 1];
  const end = next ? run.phaseStartMs[next] : run.endMs;
  return run.locks.filter(s => s.atMs >= run.phaseStartMs[phase] && s.atMs < end);
};
const peak = (values: number[]) => values.length ? Math.max(...values) : null;

export function phaseStats(run: Run, phase: Phase) {
  const owner = inPhase(run.owner, phase), locks = samplesIn(run, phase);
  const statuses = (items: readonly { status: number }[]) => Object.fromEntries(
    [...new Set(items.map(i => i.status))].sort((a, b) => a - b).map(s => [s, items.filter(i => i.status === s).length]));
  return {
    owner: { statuses: statuses(owner), latencyMs: distribution(owner.filter(o => ok(o.status)).map(o => o.ms)),
      signin: distribution(owner.filter(o => o.kind === 'signin' && ok(o.status)).map(o => o.ms)),
      password: distribution(owner.filter(o => o.kind === 'password' && ok(o.status)).map(o => o.ms)),
      maxMs: peak(owner.map(o => o.ms)) },
    attack: { statuses: statuses(inPhase(run.attack, phase)) },
    reads: { statuses: statuses(inPhase(run.reads, phase)),
      latencyMs: distribution(inPhase(run.reads, phase).filter(r => r.status === 200).map(r => r.ms)) },
    peakWaiters: peak(locks.map(s => s.waiters)), peakWaitMs: peak(locks.map(s => s.maxWaitMs)),
    peakConnections: peak(locks.map(s => s.connections)), samples: locks.length,
  };
}

/** Non-success answers per phase and route, keyed `<status> <ErrorBody code>`, so each 503 has a cause. */
export function causes(run: Run) {
  const routes = { owner_signin: run.owner.filter(o => o.kind === 'signin'), owner_password: run.owner.filter(o => o.kind === 'password'),
    attack: run.attack, reads: run.reads };
  const result: Record<string, Record<string, Record<string, number>>> = {};
  for (const [route, ops] of Object.entries(routes)) for (const op of ops as readonly { phase: Phase; status: number; error?: string }[]) {
    if (ok(op.status)) continue;
    const key = `${op.status} ${op.status === 0 ? 'client_timeout_or_transport' : op.error ?? 'no_error_body'}`;
    const phase = (result[op.phase] ??= {}), byRoute = (phase[route] ??= {});
    byRoute[key] = (byRoute[key] ?? 0) + 1;
  }
  return result;
}

export function judge(run: Run) {
  const b0 = phaseStats(run, 'B0'), b1 = phaseStats(run, 'B1'), b2 = phaseStats(run, 'B2');
  const b0p95 = b0.owner.latencyMs.p95, v = b0.owner.signin.p50;
  const b1Attack = inPhase(run.attack, 'B1');
  const readsBy = (phase: Phase) => inPhase(run.reads, phase);
  const incomplete = b0p95 === null || v === null || !b0.samples || !b1.samples || !b2.samples || !run.server.complete
    || !b1Attack.length || !readsBy('B0').length || !readsBy('B1').length || !readsBy('B2').length;
  const bound = b0p95 !== null && v !== null ? b0p95 + 5 * v : null;
  const b1Owner = inPhase(run.owner, 'B1');
  const interference = b1Owner.filter(o => ok(o.status) ? bound === null || o.ms > bound : o.status !== 429 && o.status !== 503);
  const b2Owner = inPhase(run.owner, 'B2');
  const lastCounted = peak(run.attack.filter(a => a.status === 401).map(a => a.endMs));
  // A 429 within 60 s of the last counted attacker failure is the window still closing (throttle-allowed);
  // a later one, or any other non-success, fails B2. The strict reading (every B2 operation 200/204) is
  // reported alongside because the pre-registered wording admits both.
  const late = (o: OwnerOp) => lastCounted === null || o.endMs > lastCounted + 60_000;
  const late429 = b2Owner.filter(o => o.status === 429 && late(o));
  const b2Failures = b2Owner.filter(o => !ok(o.status) && !(o.status === 429 && !late(o)));
  const b0Reads = b0.reads.latencyMs.p95;
  const readBound = b0Reads === null ? null : Math.max(2 * b0Reads, 12.8);
  const readP95 = { B1: b1.reads.latencyMs.p95, B2: b2.reads.latencyMs.p95 };
  const peakWaiters = Math.max(b0.peakWaiters ?? Infinity, b1.peakWaiters ?? Infinity, b2.peakWaiters ?? Infinity);
  const all = [...run.owner, ...run.attack, ...run.reads];
  const checks: Record<'B1' | 'B2' | 'B3' | 'B4' | 'B5', Check> = {
    B1: { pass: !incomplete && b1Owner.length > 0 && interference.length === 0,
      detail: `${interference.length} of ${b1Owner.length} B1 owner operations interfered; bound ${bound?.toFixed(1)} ms` },
    B2: { pass: !incomplete && b2Owner.some(o => ok(o.status)) && b2Failures.length === 0 && late429.length === 0
        && b2.owner.latencyMs.p95 !== null && b0p95 !== null && b2.owner.latencyMs.p95 <= 2 * b0p95,
      detail: `${b2Owner.filter(o => ok(o.status)).length}/${b2Owner.length} succeeded; ${b2Owner.length - b2Failures.length - b2Owner.filter(o => ok(o.status)).length} in-window 429; ${late429.length} late 429; p95 ${b2.owner.latencyMs.p95} vs ${b0p95} ms` },
    B3: { pass: !incomplete && peakWaiters <= 7 && b0.peakConnections !== null
        && Math.max(b1.peakConnections ?? Infinity, b2.peakConnections ?? Infinity) <= b0.peakConnections + 7
        && Math.max(b0.peakConnections, b1.peakConnections ?? Infinity, b2.peakConnections ?? Infinity) < run.poolMax,
      detail: `waiters B0 ${b0.peakWaiters} B1 ${b1.peakWaiters} B2 ${b2.peakWaiters}; connections B0 ${b0.peakConnections} B1 ${b1.peakConnections} B2 ${b2.peakConnections}; pool ${run.poolMax}` },
    B4: { pass: !incomplete && run.reads.every(r => r.status === 200) && readBound !== null
        && (readP95.B1 ?? Infinity) <= readBound && (readP95.B2 ?? Infinity) <= readBound,
      detail: `${run.reads.filter(r => r.status === 200).length}/${run.reads.length}; p95 B1 ${readP95.B1} B2 ${readP95.B2} vs ${readBound} ms` },
    B5: { pass: !incomplete && all.every(o => o.status !== 0 && (o.status < 500 || o.status === 503))
        && run.server.poolTimeouts === 0 && run.server.panics === 0,
      detail: `client timeouts ${all.filter(o => o.status === 0).length}; 5xx other than 503 ${all.filter(o => o.status >= 500 && o.status !== 503).length}; pool timeouts ${run.server.poolTimeouts}; panics ${run.server.panics}` },
  };
  const b2Strict = !incomplete && b2Owner.length > 0 && b2Owner.every(o => ok(o.status));
  return { formal: false, incomplete, bounds: { ownerMs: bound, readMs: readBound, lastCountedAttackMs: lastCounted }, b2Strict,
    phases: { B0: b0, B1: b1, B2: b2 }, causes: causes(run), checks,
    allPass: !incomplete && Object.values(checks).every(c => c.pass) };
}

/** The ErrorBody code of a non-2xx body (server constants such as "too many sign-in attempts"); never other text. */
export function errorCode(text: string) {
  if (!text) return 'no_error_body';
  try {
    const code = (JSON.parse(text) as Partial<ErrorBody> | null)?.error;
    return typeof code === 'string' && /^[a-z0-9_ .-]{1,64}$/.test(code) ? code : 'unrecognised_error_body';
  } catch { return 'unrecognised_error_body'; }
}

/**
 * observability::report logs cumulative admission rejections per kind every 60 s; keep the last report per
 * kind as a server-side cross-check of the client's 503 codes (it can trail the run by up to 60 s). A line
 * that mentions the event but does not parse marks the result incomplete instead of being skipped.
 */
export function admissionRejected(log: string) {
  const last: Record<string, { count: number; at: string }> = {};
  let unparsed = 0;
  for (const line of log.split('\n')) {
    if (!line.includes('admission_rejected')) continue;
    try {
      const row = JSON.parse(line), kind = row?.fields?.kind, count = row?.fields?.count;
      if (row?.target === 'fukulow' && row?.fields?.event === 'admission_rejected' && typeof kind === 'string'
        && /^[a-z_]{1,32}$/.test(kind) && Number.isSafeInteger(count) && count >= 0
        && typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp)))
        last[kind] = { count, at: row.timestamp };
      else unparsed++;
    } catch { unparsed++; }
  }
  return { complete: unparsed === 0, unparsed, last };
}
