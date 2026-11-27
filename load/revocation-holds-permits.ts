// Decode the fixed M2 event fields from the revocation measurement target.
export const PERMIT_CALLERS = ['retry', 'handoff', 'publish', 'revoked', 'scoped'] as const;
const WAIT_BUCKET_MS = [1, 5, 10, 50, 100, 250, 500, 1000, 2500, 5000] as const;
const FIELDS = [
  'waiting', 'holding', 'holding_checked_out', 'granted', 'wait_abandoned', 'wait_count',
  'wait_granted_us_total', 'wait_abandoned_us_total', 'hold_us_total', 'pool_wait_us_total',
  'statement_us_total', ...WAIT_BUCKET_MS.map(ms => `wait_le_${ms}_ms` as const),
] as const;
const DEADLINES = ['deadline_exits_before_attempt', 'deadline_exits_after_attempt'] as const;
const GLOBALS = ['permits_total', 'all_pass_in_flight', 'all_pass_statements', 'all_pass_us_total'] as const;
type Caller = typeof PERMIT_CALLERS[number];
type Counters = Record<typeof FIELDS[number], number>;
type DeadlineCounters = Record<typeof DEADLINES[number], number>;
export type NoticePermitSample = { serverMs: number } & Record<typeof GLOBALS[number], number> & {
  retry: Counters & DeadlineCounters; handoff: Counters & DeadlineCounters;
} & Record<Exclude<Caller, 'retry' | 'handoff'>, Counters>;

function counters<K extends string>(f: Record<string, unknown>, names: readonly K[], prefix = ''): Record<K, number> | undefined {
  const record = {} as Record<K, number>;
  for (const name of names) {
    const value = f[prefix + name];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return;
    record[name] = value;
  }
  return record;
}

export function parsePermitSample(f: Record<string, unknown>): NoticePermitSample | undefined {
  if (typeof f.server_ms !== 'number' || !Number.isFinite(f.server_ms) || f.server_ms < 0) return;
  const globals = counters(f, GLOBALS);
  const [retry, handoff, publish, revoked, scoped] = PERMIT_CALLERS.map(caller => counters(f, FIELDS, caller + '.'));
  const retryDeadlines = counters(f, DEADLINES, 'retry.');
  const handoffDeadlines = counters(f, DEADLINES, 'handoff.');
  if (!globals || !retry || !handoff || !publish || !revoked || !scoped || !retryDeadlines || !handoffDeadlines) return;
  return { serverMs: f.server_ms, ...globals, retry: { ...retry, ...retryDeadlines },
    handoff: { ...handoff, ...handoffDeadlines }, publish, revoked, scoped };
}
