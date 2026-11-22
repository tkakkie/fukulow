// #756 exact lock waits on X's Account row: the PostgreSQL lock-wait log (log_lock_waits with
// deadlock_timeout = 10ms, prefix '%m [%p] ' in UTC) and the 20 ms pg_locks/pg_stat_activity sampler.
// FOR UPDATE waiters show up in two forms: the first waiter as `ShareLock on transaction <xid>` with a
// tuple CONTEXT such as `while locking tuple (p,i) in relation "accounts"` (or `while updating tuple`,
// `while locking updated version (p,i) of tuple`, ...), later waiters as `<mode> on tuple (p,i) of
// relation <oid> of database <oid>`. Each pid's wait is the half-open [end - waited, end); a tuple wait
// followed by the transaction wait of the same attempt (same pid, tuple and statement, acquired, within
// MERGE_GAP_MS) is merged. Anything about `accounts` that does not parse is `unparsed`, never `other`.

export type Tuple = { page: number; item: number };
export type LockTarget = { type: 'tuple'; tuple: Tuple; relation: number; database: number }
  | { type: 'transaction'; xid: number } | { type: 'other' };
// Only the derived kind of the STATEMENT line is kept: raw statement text is never persisted.
export type StatementKind = 'owner' | 'signin' | 'other';
export type LockEvent = { pid: number; kind: 'waiting' | 'acquired' | 'failed'; mode: string; target: LockTarget;
  atDbMs: number; waitedMs: number; context?: { tuple: Tuple; relation: string }; contextUnparsed?: boolean;
  statementKind?: StatementKind };
export type Wait = { pid: number; lock: 'tuple' | 'transaction'; tuple: string; startDbMs: number; endDbMs: number;
  waitedMs: number; outcome: 'acquired' | 'failed'; statementKind?: StatementKind };
export type WaitInterval = { pid: number; startDbMs: number; endDbMs: number; waitedMs: number; parts: Wait['lock'][];
  tuples: string[]; outcome: Wait['outcome']; statementKind?: StatementKind };
// maxWaitMs: the longest-running waiting X-row statement (from query_start), an upper bound on its lock wait.
export type SamplerRow = { dbMs: number; nodeMs: number; connections: number; waiting: { pid: number; kind: 'owner' | 'signin' }[];
  maxWaitMs: number; ctid: string | null };

const PREFIX = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d{3}) (\S+) \[(\d+)\] ([A-Z]+):\s+(.*)$/;
const MESSAGE = /^process (\d+) (still waiting for|acquired|failed to acquire) (\w+) on (.+) after (\d+(?:\.\d+)?) ms$/;
const TUPLE = /^tuple \((\d+),(\d+)\) of relation (\d+) of database (\d+)$/;
const TRANSACTION = /^transaction (\d+)$/;
// PostgreSQL's XactLockTableWait contexts (lmgr.c): locking, updating, deleting, rechecking updated,
// inserting index, checking uniqueness of, checking exclusion constraint on ... tuple; and the
// updated-version form used while following an update chain.
const CONTEXTS = [/^while [a-z ]+? tuple \((\d+),(\d+)\) in relation "([^"]+)"$/,
  /^while locking updated version \((\d+),(\d+)\) of tuple in relation "([^"]+)"$/];
// A LOG line that names a lock wait but does not parse must not be skipped silently.
const LOOKS_LIKE_WAIT = /\bprocess \d+ (still waiting for|acquired|failed to acquire|avoided deadlock|detected deadlock)\b/;
const MENTIONS_ACCOUNTS = /\baccounts\b/;
export const tupleKey = (t: Tuple) => `(${t.page},${t.item})`;

const OWNER_STATEMENT = /FROM accounts WHERE id = \$1 FOR UPDATE/, SIGNIN_STATEMENT = /FROM accounts WHERE email = \$1 FOR UPDATE/;
export const statementKind = (text: string): StatementKind =>
  OWNER_STATEMENT.test(text) ? 'owner' : SIGNIN_STATEMENT.test(text) ? 'signin' : 'other';

export function parseLockLog(text: string) {
  const events: LockEvent[] = [];
  const open = new Map<number, LockEvent>();
  let lines = 0, unparsed = 0, deadlockMessages = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    lines++;
    const p = PREFIX.exec(line);
    if (!p) { if (LOOKS_LIKE_WAIT.test(line)) unparsed++; continue; }
    const [, date, time, zone, pidText, level, body] = p;
    const pid = Number(pidText);
    if (level === 'LOG') {
      open.delete(pid);
      if (!LOOKS_LIKE_WAIT.test(body)) continue;
      if (/avoided deadlock|detected deadlock/.test(body)) { deadlockMessages++; continue; }
      const m = MESSAGE.exec(body), atDbMs = zone === 'UTC' ? Date.parse(`${date}T${time}Z`) : NaN;
      if (!m || Number(m[1]) !== pid || !Number.isFinite(atDbMs) || !(Number(m[5]) > 0)) { unparsed++; continue; }
      const tuple = TUPLE.exec(m[4]), xact = TRANSACTION.exec(m[4]);
      // A target that names a tuple or a transaction but does not parse is malformed, not `other`.
      if (!tuple && !xact && /^(tuple|transaction)\b/.test(m[4])) { unparsed++; continue; }
      const target: LockTarget = tuple ? { type: 'tuple', tuple: { page: Number(tuple[1]), item: Number(tuple[2]) },
        relation: Number(tuple[3]), database: Number(tuple[4]) } : xact ? { type: 'transaction', xid: Number(xact[1]) } : { type: 'other' };
      const kind = m[2] === 'still waiting for' ? 'waiting' : m[2] === 'acquired' ? 'acquired' : 'failed';
      const event: LockEvent = { pid, kind, mode: m[3], target, atDbMs, waitedMs: Number(m[5]) };
      events.push(event); open.set(pid, event);
    } else if (level === 'CONTEXT' || level === 'STATEMENT') {
      const event = open.get(pid);
      if (!event) continue;
      if (level === 'STATEMENT') { event.statementKind = statementKind(body); continue; }
      const c = CONTEXTS.map(r => r.exec(body)).find(Boolean);
      if (c) event.context = { tuple: { page: Number(c[1]), item: Number(c[2]) }, relation: c[3] };
      else if (MENTIONS_ACCOUNTS.test(body)) { event.contextUnparsed = true; unparsed++; }
    } else if (level !== 'DETAIL') open.delete(pid);
  }
  return { events, lines, unparsed, deadlockMessages };
}

export type Target = { accountsOid: number; databaseOid: number; ctids: ReadonlySet<string> };
type Kind = 'x' | 'foreign' | 'other' | 'unparsed';

/**
 * Which waits are on X's Account row. An accounts-row wait on a tuple not known to be X's is `foreign`.
 * A transaction wait without a parsed tuple context cannot be placed (it may be X's row) and is `unparsed`.
 */
function classify(e: LockEvent, x: Target): { kind: Kind; lock?: Wait['lock']; tuple?: string } {
  if (e.contextUnparsed) return { kind: 'unparsed' };
  if (e.target.type === 'tuple') {
    if (e.target.relation !== x.accountsOid || e.target.database !== x.databaseOid) return { kind: 'other' };
    const tuple = tupleKey(e.target.tuple);
    return x.ctids.has(tuple) ? { kind: 'x', lock: 'tuple', tuple } : { kind: 'foreign' };
  }
  if (e.target.type === 'transaction') {
    if (!e.context) return { kind: 'unparsed' };
    if (e.context.relation !== 'accounts') return { kind: 'other' };
    if (e.mode !== 'ShareLock') return { kind: 'unparsed' };
    const tuple = tupleKey(e.context.tuple);
    return x.ctids.has(tuple) ? { kind: 'x', lock: 'transaction', tuple } : { kind: 'foreign' };
  }
  return { kind: 'other' };
}

export function xWaits(events: readonly LockEvent[], x: Target) {
  const waits: Wait[] = [];
  let foreign = 0, other = 0, unmatched = 0, unparsed = 0;
  const pending = new Map<string, LockEvent>();
  const key = (e: LockEvent) => `${e.pid}|${e.mode}|${JSON.stringify(e.target)}`;
  for (const e of events) {
    if (e.kind === 'waiting') { if (pending.has(key(e))) unmatched++; pending.set(key(e), e); continue; }
    const start = pending.get(key(e));
    pending.delete(key(e));
    // The start and the completion of one wait must agree on where it waited; otherwise it cannot be placed.
    if (start?.context && e.context && (start.context.relation !== e.context.relation
      || tupleKey(start.context.tuple) !== tupleKey(e.context.tuple))) { unparsed++; continue; }
    const withContext: LockEvent = { ...e, context: e.context ?? start?.context,
      contextUnparsed: e.contextUnparsed || start?.contextUnparsed, statementKind: e.statementKind ?? start?.statementKind };
    const c = classify(withContext, x);
    if (c.kind === 'unparsed') { unparsed++; continue; }
    if (c.kind === 'foreign') { foreign++; continue; }
    if (c.kind === 'other') { other++; continue; }
    waits.push({ pid: e.pid, lock: c.lock!, tuple: c.tuple!, startDbMs: e.atDbMs - e.waitedMs, endDbMs: e.atDbMs,
      waitedMs: e.waitedMs, outcome: e.kind === 'acquired' ? 'acquired' : 'failed', statementKind: withContext.statementKind });
  }
  for (const e of pending.values()) {
    const kind = classify(e, x).kind;
    if (kind === 'unparsed') unparsed++; else if (kind !== 'other') unmatched++;
  }
  return { waits, foreign, other, unmatched, unparsed };
}

// The log timestamp has 1 ms resolution, so a transaction wait that starts as the tuple wait ends can
// appear up to ~1 ms early or late.
export const MERGE_GAP_MS = 2;
/**
 * Same lock attempt: the tuple wait was acquired, then the same pid waited on the holder for that tuple,
 * running the same known statement kind. A missing statement kind never merges.
 */
function sameAttempt(last: WaitInterval, w: Wait) {
  return last.parts.at(-1) === 'tuple' && last.outcome === 'acquired' && w.lock === 'transaction'
    && w.tuple === last.tuples.at(-1) && Math.abs(w.startDbMs - last.endDbMs) <= MERGE_GAP_MS
    && last.statementKind !== undefined && last.statementKind === w.statementKind;
}
export function mergeWaits(waits: readonly Wait[]): WaitInterval[] {
  const out: WaitInterval[] = [];
  const byPid = new Map<number, Wait[]>();
  for (const w of waits) if (w.endDbMs > w.startDbMs) byPid.set(w.pid, [...(byPid.get(w.pid) ?? []), w]);
  for (const [pid, list] of byPid) {
    let last: WaitInterval | undefined;
    for (const w of [...list].sort((a, b) => a.startDbMs - b.startDbMs)) {
      if (last && sameAttempt(last, w)) {
        last.endDbMs = Math.max(last.endDbMs, w.endDbMs); last.waitedMs = last.endDbMs - last.startDbMs;
        last.parts.push(w.lock); last.tuples.push(w.tuple); last.outcome = w.outcome;
        continue;
      }
      last = { pid, startDbMs: w.startDbMs, endDbMs: w.endDbMs, waitedMs: w.waitedMs, parts: [w.lock], tuples: [w.tuple],
        outcome: w.outcome, statementKind: w.statementKind };
      out.push(last);
    }
  }
  return out.sort((a, b) => a.startDbMs - b.startDbMs || a.pid - b.pid);
}

/** Most distinct pids waiting at one instant. Intervals are half-open; empty ones never count. */
export function peakSimultaneous(intervals: readonly Pick<WaitInterval, 'pid' | 'startDbMs' | 'endDbMs'>[]) {
  const points = intervals.filter(i => i.endDbMs > i.startDbMs)
    .flatMap(i => [{ at: i.startDbMs, pid: i.pid, d: 1 }, { at: i.endDbMs, pid: i.pid, d: -1 }])
    .sort((a, b) => a.at - b.at || a.d - b.d);
  const active = new Map<number, number>();
  let peak = 0, at: number | null = null, pids: number[] = [];
  for (const p of points) {
    active.set(p.pid, (active.get(p.pid) ?? 0) + p.d);
    if (!active.get(p.pid)) active.delete(p.pid);
    if (active.size > peak) { peak = active.size; at = p.at; pids = [...active.keys()].sort((a, b) => a - b); }
  }
  return { peak, atDbMs: at, pids };
}

// Sampler output: one `\watch` row per sample, fields separated by '|'.
const ROW = /^(\d+(?:\.\d+)?)\|(\d+)\|((?:\d+[os](?:,\d+[os])*)?)\|(\d+)\|(\(\d+,\d+\))?$/;
/** A non-empty line that is not a sample row is `malformed` (counted by the caller, never dropped silently). */
export function parseSamplerLine(line: string, nodeMs: number): SamplerRow | 'malformed' | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const m = ROW.exec(trimmed);
  if (!m) return 'malformed';
  return { dbMs: Number(m[1]), nodeMs, connections: Number(m[2]), maxWaitMs: Number(m[4]), ctid: m[5] ?? null,
    waiting: m[3] ? m[3].split(',').map(w => ({ pid: Number(w.slice(0, -1)), kind: w.endsWith('o') ? 'owner' as const : 'signin' as const })) : [] };
}

/**
 * A pid waits on X's row when it runs one of the two X-row FOR UPDATE queries, its wait event is a
 * tuple or transaction lock, and pg_locks shows it not granted a tuple lock on accounts or a
 * transaction lock (the pre-registered pg_locks check). Relation and other lock waits never count.
 */
export function samplerQuery(email: string) {
  if (!/^[a-z0-9@.]+$/.test(email)) throw new Error('unexpected email');
  const xRow = `a.wait_event_type = 'Lock' AND a.wait_event IN ('tuple', 'transactionid')
    AND a.query ~ 'FROM accounts WHERE (email|id) = \\$1 FOR UPDATE'
    AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND NOT l.granted
      AND (l.locktype = 'transactionid' OR (l.locktype = 'tuple' AND l.relation = 'accounts'::regclass)))`;
  return `SELECT round((extract(epoch FROM clock_timestamp())*1000)::numeric, 3),
  count(*),
  coalesce(string_agg(a.pid::text || CASE WHEN a.query ~ 'FROM accounts WHERE id = \\$1 FOR UPDATE' THEN 'o' ELSE 's' END, ',' ORDER BY a.pid)
    FILTER (WHERE ${xRow}), ''),
  coalesce(round(max(extract(epoch FROM clock_timestamp() - a.query_start)*1000) FILTER (WHERE ${xRow})), 0),
  (SELECT ctid FROM accounts WHERE email = '${email}')
FROM pg_stat_activity a WHERE a.datname = current_database() AND a.usename = 'fukulow_app' AND a.backend_type = 'client backend'`;
}

/** Achieved sampling interval from consecutive database timestamps (not Node arrival times). */
export function samplerIntervals(rows: readonly SamplerRow[]) {
  const gaps = rows.slice(1).map((r, i) => r.dbMs - rows[i].dbMs).sort((a, b) => a - b);
  if (!gaps.length) return { count: rows.length, medianMs: null, maxMs: null };
  const mid = gaps.length >> 1;
  const medianMs = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return { count: rows.length, medianMs, maxMs: gaps.at(-1)! };
}

/** Sample integrity: malformed lines, and database timestamps that repeat or go backwards. */
export function samplerIntegrity(rows: readonly SamplerRow[], malformed: number) {
  const steps = rows.slice(1).map((r, i) => r.dbMs - rows[i].dbMs);
  const duplicate = steps.filter(s => s === 0).length, backward = steps.filter(s => s < 0).length;
  return { malformed, duplicate, backward, ok: malformed === 0 && duplicate === 0 && backward === 0 };
}

/**
 * Database clock to harness clock as a point estimate: the smallest (arrival - database time). Used only
 * for sampler coverage, the report and the stored harness-clock wait times, never for A0 (clockBound).
 */
export function clockOffset(rows: readonly SamplerRow[]) {
  return rows.length ? Math.min(...rows.map(r => r.nodeMs - r.dbMs)) : null;
}

// log_line_prefix %m (LOCK_LOG_SETTINGS) prints milliseconds, truncated: a logged instant lies in
// [stamp, stamp + LOG_STAMP_MS). This is the resolution of the pre-registered log format, not a tolerance.
export const LOG_STAMP_MS = 1;
/**
 * One clock bracket: the harness read its monotonic clock (nodeSentMs), asked PostgreSQL for
 * clock_timestamp() (dbMs) and read its clock again when the answer arrived (nodeReceivedMs). The database
 * read happened between the two harness reads, so (harness - database) at that instant lies in
 * [nodeSentMs - dbMs, nodeReceivedMs - dbMs]: a guaranteed bound, half a round trip either way.
 */
export type ClockBracket = { nodeSentMs: number; dbMs: number; nodeReceivedMs: number };
export const CLOCK_QUERY = 'SELECT round((extract(epoch FROM clock_timestamp())*1000)::numeric, 3);';

/** Malformed brackets, or brackets that overlap or go backwards on either clock (a clock step), are evidence gaps. */
export function bracketGaps(brackets: unknown): string[] {
  if (!Array.isArray(brackets)) return ['no clock brackets recorded'];
  const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  const bad = brackets.filter(b => !b || !fin(b.nodeSentMs) || !fin(b.dbMs) || !fin(b.nodeReceivedMs) || b.nodeReceivedMs < b.nodeSentMs).length;
  if (bad) return [`${bad} malformed clock brackets`];
  const list = brackets as ClockBracket[];
  const order = list.slice(1).filter((b, i) => b.nodeSentMs < list[i].nodeReceivedMs || b.dbMs <= list[i].dbMs).length;
  return order ? [`${order} clock brackets out of order (overlapping, or a clock going backwards)`] : [];
}

/**
 * Guaranteed (harness - database) bound over the harness interval [startMs, endMs]: the last bracket
 * answered at or before startMs, the first sent at or after endMs, and every bracket in between. With no
 * clock step between them (bracketGaps), the offset moves monotonically from the first to the last, so at
 * every instant of the interval it lies in [lo, hi], the hull of their bounds. Missing either side: null.
 */
export function clockBound(brackets: readonly ClockBracket[], startMs: number, endMs: number) {
  const before = brackets.filter(b => b.nodeReceivedMs <= startMs).at(-1), after = brackets.find(b => b.nodeSentMs >= endMs);
  if (!before || !after) return null;
  const used = brackets.filter(b => b.nodeSentMs >= before.nodeSentMs && b.nodeSentMs <= after.nodeSentMs);
  return { lo: Math.min(...used.map(b => b.nodeSentMs - b.dbMs)), hi: Math.max(...used.map(b => b.nodeReceivedMs - b.dbMs)), brackets: used.length };
}

/**
 * Whose wait: the sampler's query kind for that pid inside the half-open interval, else the log's
 * STATEMENT kind. Disagreeing evidence is `unknown`, never a guess.
 */
export function attribute(interval: WaitInterval, rows: readonly SamplerRow[]) {
  const seen = new Set<'owner' | 'signin'>();
  for (const r of rows) {
    if (r.dbMs < interval.startDbMs || r.dbMs >= interval.endDbMs) continue;
    const hit = r.waiting.find(w => w.pid === interval.pid);
    if (hit) seen.add(hit.kind);
  }
  const statement = interval.statementKind === 'owner' || interval.statementKind === 'signin' ? interval.statementKind : null;
  if (seen.size > 1 || (seen.size === 1 && statement && !seen.has(statement))) return { who: 'unknown' as const, source: 'conflict' as const };
  if (seen.size === 1) return { who: [...seen][0], source: 'sampler' as const };
  if (statement) return { who: statement, source: 'statement' as const };
  return { who: 'unknown' as const, source: 'none' as const };
}
