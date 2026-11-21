// Pure judgement for #592. Thresholds were pre-registered on the Issue before formal runs;
// change them only with the maintainer, never after seeing results.
export const THRESHOLDS = {
  drainSeconds: 10,
  recoveryWindowSeconds: 10,
  dbProbeP99Factor: 5,
  dbProbeP99FloorMs: 25,
  httpProbeP99Factor: 5,
  httpProbeP99FloorMs: 100,
  httpFirstSuccessSeconds: 5,
  repeats: 3,
} as const;
export const SIZES = [256, 1024, 4096] as const;
export const KINDS = ['recheck', 'outage'] as const;
export type Kind = (typeof KINDS)[number];
// The two approved 2026-11-19 boundary arrivals were 0.0 and 2.0 ms after fault start.
export const BOUNDARY_EXCEPTION_MS = 2;

export type Statement = { at: number; ms: number; recheck: boolean; fallback: boolean; error: boolean };
export type Probe = { at: number; ms: number; ok: boolean; status?: number };
export type PoolSample = { at: number; fields: Record<string, number> };
// Successful request completion bounds COMMIT from above for a tracked Member's removal or restore.
export type Member = { channelId: string; removeStartedAt?: number; removedAt?: number; restoredAt?: number; resets: number[]; close?: { at: number; code: number } };
export type Revocation = { socketIndex: number; channelId: string | null; at: number };
export type SendRecord = { channelId: string; beforeMs: number; afterMs: number; afterHold?: boolean };
export type SendTiming = {
  // Add this offset to the server's monotonic clock to express it on the harness clock.
  offsetBoundsMs: [number, number];
  uncertaintyMs: number;
  records: SendRecord[];
};
export type Run = {
  kind: Kind | 'control'; size: number; repeat: number;
  // pass: expected start of the fallback recheck pass the fault is aligned to.
  times: { pass: number; burst: number; fault: number; mutationsDone: number; recovery: number; end: number };
  removals: number[]; // completion time of each successful removal
  mutationFailures: number;
  statements: Statement[]; connections: number[]; refused: number[];
  dbProbe: Probe[]; httpProbe: Probe[]; pool: PoolSample[];
  rss: { at: number; kb: number }[];
  metrics: Record<string, number> | undefined;
  members: Member[]; revocations: Revocation[];
  sendTiming?: SendTiming; // Absent in archived runs, which use the original arrival rule.
  serverCloses: number; // sockets of any Member closed by the server during the run
};

export const percentile = (values: number[], p: number) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const within = <T extends { at: number }>(items: T[], from: number, to: number) => items.filter(i => i.at >= from && i.at < to);

/** Peak statements per second: the largest 100 ms bucket x10 and the largest sliding 1 s count. */
export function peaks(times: number[]) {
  if (!times.length) return { bucketPerSecond: 0, slidingSecond: 0 };
  const sorted = [...times].sort((a, b) => a - b);
  const buckets = new Map<number, number>();
  for (const t of sorted) buckets.set(Math.floor(t / 100), (buckets.get(Math.floor(t / 100)) ?? 0) + 1);
  let sliding = 0;
  for (let start = 0, end = 0; end < sorted.length; end++) {
    while (sorted[end] - sorted[start] >= 1000) start++;
    sliding = Math.max(sliding, end - start + 1);
  }
  return { bucketPerSecond: Math.max(...buckets.values()) * 10, slidingSecond: sliding };
}

const WAIT_EDGES_US = [100, 500, 1000, 5000, 10000, 25000, 50000, 100000, 500000, 1000000, 5000000];
/** Pool acquire wait percentile (bucket upper edge, ms) and timeouts between the samples bracketing a window. */
export function poolWindow(samples: PoolSample[], from: number, to: number) {
  const before = [...samples].reverse().find(s => s.at <= from) ?? samples[0];
  const after = samples.find(s => s.at >= to) ?? samples.at(-1);
  if (!before || !after || before.at >= after.at) return null;
  const timeouts = after.fields.acquire_timeout - before.fields.acquire_timeout;
  if (!Number.isFinite(timeouts) || timeouts < 0) return null;
  const delta = (key: string) => (after.fields[key] ?? 0) - (before.fields[key] ?? 0);
  const keys = [...WAIT_EDGES_US.map(e => `wait_le_${e}_us`), 'wait_count'];
  const cumulative = keys.map(delta);
  const total = cumulative.at(-1)!;
  const edge = (p: number) => {
    if (!total) return 0;
    const index = cumulative.findIndex(c => c >= (p / 100) * total);
    return index < WAIT_EDGES_US.length ? WAIT_EDGES_US[index] / 1000 : Infinity;
  };
  const waiting = samples.filter(s => s.at >= from && s.at <= to).map(s => s.fields.waiting ?? 0);
  return { p95Ms: edge(95), p99Ms: edge(99), timeouts, acquisitions: total, maxWaiting: waiting.length ? Math.max(...waiting) : 0 };
}

const latency = (statements: Statement[]) => ({ count: statements.length, p95Ms: percentile(statements.map(s => s.ms), 95), p99Ms: percentile(statements.map(s => s.ms), 99) });

type MemberNotices = Member & { revoked: number[] };

function summarize(run: Run, members: MemberNotices[]) {
  const { fault, mutationsDone, recovery, end } = run.times;
  const windowEnd = recovery + THRESHOLDS.recoveryWindowSeconds * 1000;
  // Baseline: the quiet 10 s before the removal burst starts.
  const baselineFrom = run.times.burst - 10_000;
  const rechecks = run.statements.filter(s => s.recheck);
  const windows = {
    baseline: [baselineFrom, run.times.burst], fault: [fault, recovery], recovery: [recovery, windowEnd],
  } as const;
  const statementWindows = Object.fromEntries(Object.entries(windows).map(([name, [from, to]]) => [name, {
    all: latency(within(run.statements, from, to)), recheck: latency(within(rechecks, from, to)),
  }]));
  const sortedRemovals = [...run.removals].sort((a, b) => a - b);
  const baselineRss = percentile(within(run.rss, baselineFrom, run.times.burst).map(s => s.kb), 50);
  const peakRss = Math.max(...within(run.rss, fault, windowEnd).map(s => s.kb), -Infinity);
  const m = run.metrics ?? {};
  // Cap refusals never become holds; the other reasons end a hold. A hold whose frame
  // is no longer valid can also end uncounted, so the residual is reported, not required to be zero.
  const ended = ['revocation_retired_timeout', 'revocation_retired_retries', 'revocation_retired_fenced'].reduce((sum, key) => sum + (m[key] ?? 0), 0);
  const refusedHolds = (m.revocation_retired_registration_cap ?? 0) + (m.revocation_retired_global_cap ?? 0);
  const afterRecovery = members.reduce((sum, member) => sum + member.revoked.filter(at => at >= recovery).length, 0);
  const removedMembers = members.filter(member => member.removedAt !== undefined);
  const lost = removedMembers.filter(member => member.restoredAt === undefined);
  return {
    removalSpreadMs: sortedRemovals.length ? sortedRemovals.at(-1)! - sortedRemovals[0] : NaN,
    removalsBeforeFault: sortedRemovals.filter(at => at < fault).length,
    faultAfterPassMs: fault - run.times.pass,
    // Session-pass statements issued around the aligned pass (none reach the database during an outage).
    observedPassMs: within(run.statements.filter(st => st.fallback), run.times.pass - 5_000, run.times.pass + 5_000).map(st => st.at - run.times.pass),
    recoveryAfterPassMs: recovery - run.times.pass,
    recoveryAfterMutationsMs: recovery - mutationsDone,
    notices: {
      removed: removedMembers.length, accessLost: lost.length,
      lostWithNotice: lost.filter(member => member.revoked.length).length,
      lostWithoutNotice: lost.filter(member => !member.revoked.length).length, // REST reconciliation recovers these (spec O5)
      receivedAfterRecovery: afterRecovery,
      resets: run.members.reduce((sum, member) => sum + member.resets.length, 0),
      serverCloses: run.serverCloses,
    },
    peaks: {
      all: peaks(within(run.statements, fault, windowEnd).map(s => s.at)),
      recheck: peaks(within(rechecks, fault, recovery).map(s => s.at)),
      recheckRecovery: peaks(within(rechecks, recovery, windowEnd).map(s => s.at)),
      connections: peaks(within(run.connections.map(at => ({ at })), recovery, windowEnd).map(c => c.at)),
    },
    recheckErrors: within(rechecks, fault, end).filter(s => s.error).length,
    statements: statementWindows,
    dbProbe: Object.fromEntries(Object.entries(windows).map(([name, [from, to]]) => {
      const probes = within(run.dbProbe, from, to);
      return [name, { count: probes.length, failures: probes.filter(p => !p.ok).length, p95Ms: percentile(probes.filter(p => p.ok).map(p => p.ms), 95), p99Ms: percentile(probes.filter(p => p.ok).map(p => p.ms), 99) }];
    })),
    httpProbe: Object.fromEntries(Object.entries(windows).map(([name, [from, to]]) => {
      const probes = within(run.httpProbe, from, to);
      return [name, { count: probes.length, failures: probes.filter(p => !p.ok).length, status5xx: probes.filter(p => (p.status ?? 0) >= 500).length, p95Ms: percentile(probes.filter(p => p.ok).map(p => p.ms), 95), p99Ms: percentile(probes.filter(p => p.ok).map(p => p.ms), 99) }];
    })),
    pool: Object.fromEntries(Object.entries(windows).map(([name, [from, to]]) => [name, poolWindow(run.pool, from, to)])),
    // The delta includes the removal burst itself; compare with the control run, not per hold.
    memory: { baselineKb: baselineRss, peakKb: peakRss, deltaKb: peakRss - baselineRss },
    counters: { ...m, hold_endings: ended, hold_refusals: refusedHolds, hold_residual: (m.revocation_held ?? 0) - (m.revocation_delivered_after_hold ?? 0) - ended },
  };
}

export function judge(run: Run) {
  const reasons: string[] = [];
  const { fault, recovery } = run.times;
  const timing = run.sendTiming;
  const clockOffset = timing ? (timing.offsetBoundsMs[0] + timing.offsetBoundsMs[1]) / 2 : 0;
  const sends = new Map<string, SendRecord | undefined>();
  for (const record of timing?.records ?? []) {
    // The fixture has one removed Member and one socket for each tracked Channel.
    // Multiple records for a Channel cannot be matched unambiguously.
    sends.set(record.channelId, sends.has(record.channelId) ? undefined : record);
  }
  const indeterminate: (Revocation & { sentAt: number })[] = [];
  const missingSendRecords: Revocation[] = [];
  let matchedSendRecords = 0;
  let faultSend = false;
  // The relay measures Sync-to-ReadyForQuery. A successful completion in the removal
  // window is run-level corroboration only. It carries no Member or Channel identity.
  let lastPreFaultRecheck = -Infinity;
  for (const statement of run.statements) {
    const completed = statement.at + statement.ms;
    if (statement.recheck && !statement.error && completed < fault) {
      lastPreFaultRecheck = Math.max(lastPreFaultRecheck, completed);
    }
  }
  const boundaryExceptions = [];
  const members: MemberNotices[] = run.members.map(member => ({ ...member, revoked: [] }));
  let unexpected = false;
  let faultArrival = false;
  for (const notice of run.revocations) {
    const duringFault = notice.at >= fault && notice.at < recovery;
    if (timing) {
      const record = notice.channelId === null ? undefined : sends.get(notice.channelId);
      if (!record) missingSendRecords.push(notice);
      else {
        sends.delete(record.channelId);
        matchedSendRecords++;
        if (duringFault) {
          const sentAt = clockOffset + (record.beforeMs + record.afterMs) / 2;
          if (sentAt - timing.uncertaintyMs >= fault) faultSend = true;
          else if (sentAt + timing.uncertaintyMs >= fault) indeterminate.push({ ...notice, sentAt });
        }
      }
    }
    const member = members[notice.socketIndex];
    if (!member || member.channelId !== notice.channelId) {
      unexpected = true;
      continue;
    }
    member.revoked.push(notice.at);
    if (!timing && duringFault) {
      const arrivalAfterFaultMs = notice.at - fault;
      if (run.kind !== 'control' && arrivalAfterFaultMs <= BOUNDARY_EXCEPTION_MS &&
        member.removedAt !== undefined && member.removedAt < fault &&
        member.removeStartedAt !== undefined && lastPreFaultRecheck >= member.removeStartedAt) {
        boundaryExceptions.push({
          ...notice, arrivalAfterFaultMs, removalConfirmedBeforeFaultMs: fault - member.removedAt,
          lastSuccessfulRecheckCompletedBeforeFaultMs: fault - lastPreFaultRecheck,
        });
      } else faultArrival = true;
    }
  }
  if (unexpected) reasons.push('a revocation reached a socket or Channel outside the successful removal set');
  const s = summarize(run, members);
  const m = run.metrics;
  // Notice correctness: never wrong, early or repeated; losses are allowed (REST reconciliation, spec O5).
  if (!m) reasons.push('no metrics event after the holds resolved');
  if (run.mutationFailures && run.kind !== 'outage') reasons.push(`${run.mutationFailures} removal/restore requests failed`);
  if (faultArrival) reasons.push('a revocation was delivered while the failure was active');
  if (faultSend) reasons.push('a revocation was sent while the failure was active');
  if (indeterminate.length) reasons.push('a revocation send time is indeterminate at fault start');
  if (missingSendRecords.length) reasons.push('a revocation has no matching server send record');
  if (members.some(member => member.revoked.some(at => member.removedAt === undefined || at < member.removeStartedAt!))) reasons.push('a revocation reached a Member without a successful removal or before it');
  if (members.some(member => member.restoredAt !== undefined && member.revoked.some(at => at >= member.restoredAt!))) reasons.push('a restored registration received a revocation');
  if (members.some(member => member.revoked.length > 1)) reasons.push('duplicate revocation');
  if (m) {
    if (m.revocation_delivered_after_hold > s.notices.receivedAfterRecovery) reasons.push(`delivered_after_hold ${m.revocation_delivered_after_hold} > client revocations after recovery ${s.notices.receivedAfterRecovery}`);
    if (s.counters.hold_residual < 0) reasons.push(`held ${m.revocation_held} < delivered ${m.revocation_delivered_after_hold} + ended ${s.counters.hold_endings}`);
  }
  // Recovery.
  const drainLimit = recovery + THRESHOLDS.drainSeconds * 1000;
  if (members.some(member => member.revoked.some(at => at > drainLimit))) reasons.push('a revocation arrived after the drain limit');
  const db = s.dbProbe;
  const dbLimit = Math.max(THRESHOLDS.dbProbeP99Factor * db.baseline.p99Ms, THRESHOLDS.dbProbeP99FloorMs);
  if (!(db.recovery.count > 0)) reasons.push('no database probe in the recovery window');
  if (db.recovery.failures) reasons.push(`${db.recovery.failures} database probe failures after recovery`);
  if (db.recovery.p99Ms > dbLimit) reasons.push(`database probe p99 ${db.recovery.p99Ms.toFixed(2)} ms > ${dbLimit.toFixed(2)} ms`);
  const http = run.httpProbe.filter(p => p.at >= recovery);
  const firstOk = http.find(p => p.ok);
  if (!firstOk || firstOk.at > recovery + THRESHOLDS.httpFirstSuccessSeconds * 1000) reasons.push('no successful HTTP probe within the first-success limit');
  else {
    const after = http.filter(p => p.at >= firstOk.at && p.at < recovery + THRESHOLDS.recoveryWindowSeconds * 1000);
    const httpLimit = Math.max(THRESHOLDS.httpProbeP99Factor * s.httpProbe.baseline.p99Ms, THRESHOLDS.httpProbeP99FloorMs);
    const p99 = percentile(after.filter(p => p.ok).map(p => p.ms), 99);
    if (after.some(p => !p.ok)) reasons.push(`${after.filter(p => !p.ok).length} HTTP probe failures after the first recovery success`);
    if (p99 > httpLimit) reasons.push(`HTTP probe p99 ${p99.toFixed(2)} ms > ${httpLimit.toFixed(2)} ms`);
  }
  if (!s.pool.recovery) reasons.push('pool acquire timeouts unavailable in the recovery window');
  else if (s.pool.recovery.timeouts) reasons.push(`${s.pool.recovery.timeouts} pool acquire timeouts after recovery`);
  if (!(s.httpProbe.baseline.count > 0) || !(db.baseline.count > 0)) reasons.push('missing baseline probes');
  const verdict: RunVerdict = reasons.length ? 'FAIL' : boundaryExceptions.length ? 'PASS_WITH_BOUNDARY_EXCEPTION' : 'PASS';
  // pass means a clean PASS; read verdict for the boundary exception.
  const sendTiming = timing && {
    uncertaintyMs: timing.uncertaintyMs, serverSendRecords: timing.records.length, matchedSendRecords,
    indeterminate, missingSendRecords,
  };
  return { pass: verdict === 'PASS', verdict, reasons, summary: { ...s, boundaryExceptions, ...(sendTiming && { sendTiming }) } };
}

export type RunVerdict = 'PASS' | 'PASS_WITH_BOUNDARY_EXCEPTION' | 'FAIL';
export type Verdict = RunVerdict | 'NOT EVALUATED';
/** A size passes only with all repeats of both kinds valid and passing. */
export function verdictBySize(results: { kind: Kind; size: number; verdict: RunVerdict }[]) {
  return Object.fromEntries(SIZES.map(size => {
    const runs = results.filter(r => r.size === size);
    const complete = KINDS.every(kind => runs.filter(r => r.kind === kind).length >= THRESHOLDS.repeats);
    let verdict: Verdict = 'NOT EVALUATED';
    if (runs.some(r => r.verdict === 'FAIL')) verdict = 'FAIL';
    else if (complete) verdict = runs.some(r => r.verdict === 'PASS_WITH_BOUNDARY_EXCEPTION') ? 'PASS_WITH_BOUNDARY_EXCEPTION' : 'PASS';
    return [size, verdict];
  }));
}
