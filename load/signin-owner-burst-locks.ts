// #756 exact lock waits on X's Account row: the PostgreSQL lock-wait log (log_lock_waits with
// deadlock_timeout = 10ms, prefix '%m [%p] ' in UTC) and the 20 ms pg_stat_activity sampler.
// FOR UPDATE waiters show up in two forms: the first waiter as `ShareLock on transaction <xid>` with
// `CONTEXT: while locking tuple (p,i) in relation "accounts"`, later waiters as `<mode>ExclusiveLock on
// tuple (p,i) of relation <oid> of database <oid>` (SELECT ... FOR UPDATE takes AccessExclusiveLock on
// the tuple; the pre-registered `ExclusiveLock on tuple` is matched as a suffix). Each pid's wait is
// [end - waited, end]; a tuple wait followed by a transaction wait of the same pid is merged.

export type Tuple = { page: number; item: number };
export type LockTarget = { type: 'tuple'; tuple: Tuple; relation: number; database: number }
  | { type: 'transaction'; xid: number } | { type: 'other' };
export type LockEvent = { pid: number; kind: 'waiting' | 'acquired' | 'failed'; mode: string; target: LockTarget;
  atDbMs: number; waitedMs: number; context?: { tuple: Tuple; relation: string }; statement?: string };
export type Wait = { pid: number; lock: 'tuple' | 'transaction'; tuple: string; startDbMs: number; endDbMs: number;
  waitedMs: number; outcome: 'acquired' | 'failed'; statement?: string };
export type WaitInterval = { pid: number; startDbMs: number; endDbMs: number; waitedMs: number; parts: Wait['lock'][];
  tuples: string[]; outcome: Wait['outcome']; statement?: string };
export type SamplerRow = { dbMs: number; nodeMs: number; connections: number; waiting: { pid: number; kind: 'owner' | 'signin' }[];
  maxWaitMs: number; ctid: string | null };

const PREFIX = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d{3}) (\S+) \[(\d+)\] ([A-Z]+):\s+(.*)$/;
const MESSAGE = /^process (\d+) (still waiting for|acquired|failed to acquire) (\w+) on (.+) after (\d+(?:\.\d+)?) ms$/;
const TUPLE = /^tuple \((\d+),(\d+)\) of relation (\d+) of database (\d+)$/;
const TRANSACTION = /^transaction (\d+)$/;
const CONTEXT = /^while locking tuple \((\d+),(\d+)\) in relation "([^"]+)"$/;
// A LOG line that names a lock wait but does not parse must not be skipped silently.
const LOOKS_LIKE_WAIT = /\bprocess \d+ (still waiting for|acquired|failed to acquire|avoided deadlock|detected deadlock)\b/;
export const tupleKey = (t: Tuple) => `(${t.page},${t.item})`;

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
      if (!m || Number(m[1]) !== pid || !Number.isFinite(atDbMs)) { unparsed++; continue; }
      const tuple = TUPLE.exec(m[4]), xact = TRANSACTION.exec(m[4]);
      const target: LockTarget = tuple ? { type: 'tuple', tuple: { page: Number(tuple[1]), item: Number(tuple[2]) },
        relation: Number(tuple[3]), database: Number(tuple[4]) } : xact ? { type: 'transaction', xid: Number(xact[1]) } : { type: 'other' };
      const kind = m[2] === 'still waiting for' ? 'waiting' : m[2] === 'acquired' ? 'acquired' : 'failed';
      const event: LockEvent = { pid, kind, mode: m[3], target, atDbMs, waitedMs: Number(m[5]) };
      events.push(event); open.set(pid, event);
    } else if (level === 'CONTEXT' || level === 'STATEMENT') {
      const event = open.get(pid);
      if (!event) continue;
      if (level === 'STATEMENT') { event.statement = body; continue; }
      const c = CONTEXT.exec(body);
      if (c) event.context = { tuple: { page: Number(c[1]), item: Number(c[2]) }, relation: c[3] };
    } else if (level !== 'DETAIL') open.delete(pid);
  }
  return { events, lines, unparsed, deadlockMessages };
}

export type Target = { accountsOid: number; databaseOid: number; ctids: ReadonlySet<string> };
type Kind = 'x' | 'foreign' | 'other';

/** Which waits are on X's Account row. An accounts-row wait on a tuple not known to be X's is `foreign`. */
function classify(e: LockEvent, x: Target): { kind: Kind; lock?: Wait['lock']; tuple?: string } {
  if (e.target.type === 'tuple' && /ExclusiveLock$/.test(e.mode)) {
    if (e.target.relation !== x.accountsOid || e.target.database !== x.databaseOid) return { kind: 'other' };
    const tuple = tupleKey(e.target.tuple);
    return x.ctids.has(tuple) ? { kind: 'x', lock: 'tuple', tuple } : { kind: 'foreign' };
  }
  if (e.target.type === 'transaction' && e.mode === 'ShareLock' && e.context?.relation === 'accounts') {
    const tuple = tupleKey(e.context.tuple);
    return x.ctids.has(tuple) ? { kind: 'x', lock: 'transaction', tuple } : { kind: 'foreign' };
  }
  return { kind: 'other' };
}

export function xWaits(events: readonly LockEvent[], x: Target) {
  const waits: Wait[] = [];
  let foreign = 0, other = 0, unmatched = 0;
  const pending = new Map<string, LockEvent>();
  const key = (e: LockEvent) => `${e.pid}|${e.mode}|${JSON.stringify(e.target)}`;
  for (const e of events) {
    if (e.kind === 'waiting') { if (pending.has(key(e))) unmatched++; pending.set(key(e), e); continue; }
    const start = pending.get(key(e));
    pending.delete(key(e));
    const withContext = { ...e, context: e.context ?? start?.context, statement: e.statement ?? start?.statement };
    const c = classify(withContext, x);
    if (c.kind === 'foreign') { foreign++; continue; }
    if (c.kind === 'other') { other++; continue; }
    waits.push({ pid: e.pid, lock: c.lock!, tuple: c.tuple!, startDbMs: e.atDbMs - e.waitedMs, endDbMs: e.atDbMs,
      waitedMs: e.waitedMs, outcome: e.kind === 'acquired' ? 'acquired' : 'failed', statement: withContext.statement });
  }
  for (const e of pending.values()) if (classify(e, x).kind !== 'other') unmatched++;
  return { waits, foreign, other, unmatched };
}

// The log timestamp has 1 ms resolution, so a transaction wait that starts as the tuple wait ends can
// appear up to ~1 ms early or late.
export const MERGE_GAP_MS = 2;
export function mergeWaits(waits: readonly Wait[]): WaitInterval[] {
  const out: WaitInterval[] = [];
  const byPid = new Map<number, Wait[]>();
  for (const w of waits) byPid.set(w.pid, [...(byPid.get(w.pid) ?? []), w]);
  for (const [pid, list] of byPid) {
    let last: WaitInterval | undefined;
    for (const w of [...list].sort((a, b) => a.startDbMs - b.startDbMs)) {
      if (last && last.parts.at(-1) === 'tuple' && w.lock === 'transaction' && Math.abs(w.startDbMs - last.endDbMs) <= MERGE_GAP_MS) {
        last.endDbMs = Math.max(last.endDbMs, w.endDbMs); last.waitedMs = last.endDbMs - last.startDbMs;
        last.parts.push(w.lock); last.tuples.push(w.tuple); last.outcome = w.outcome; last.statement ??= w.statement;
        continue;
      }
      last = { pid, startDbMs: w.startDbMs, endDbMs: w.endDbMs, waitedMs: w.waitedMs, parts: [w.lock], tuples: [w.tuple],
        outcome: w.outcome, statement: w.statement };
      out.push(last);
    }
  }
  return out.sort((a, b) => a.startDbMs - b.startDbMs || a.pid - b.pid);
}

/** Most distinct pids waiting at one instant. Intervals are half-open, so touching waits do not overlap. */
export function peakSimultaneous(intervals: readonly WaitInterval[]) {
  const points = intervals.flatMap(i => [{ at: i.startDbMs, pid: i.pid, d: 1 }, { at: i.endDbMs, pid: i.pid, d: -1 }])
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
export function parseSamplerLine(line: string, nodeMs: number): SamplerRow | null {
  const m = ROW.exec(line.trim());
  if (!m) return null;
  return { dbMs: Number(m[1]), nodeMs, connections: Number(m[2]), maxWaitMs: Number(m[4]), ctid: m[5] ?? null,
    waiting: m[3] ? m[3].split(',').map(w => ({ pid: Number(w.slice(0, -1)), kind: w.endsWith('o') ? 'owner' as const : 'signin' as const })) : [] };
}

export function samplerQuery(email: string) {
  if (!/^[a-z0-9@.]+$/.test(email)) throw new Error('unexpected email');
  const xRow = `query ~ 'FROM accounts WHERE (email|id) = \\$1 FOR UPDATE'`;
  return `SELECT round((extract(epoch FROM clock_timestamp())*1000)::numeric, 3),
  count(*),
  coalesce(string_agg(pid::text || CASE WHEN query ~ 'FROM accounts WHERE id = \\$1 FOR UPDATE' THEN 'o' ELSE 's' END, ',' ORDER BY pid)
    FILTER (WHERE wait_event_type = 'Lock' AND ${xRow}), ''),
  coalesce(round(max(extract(epoch FROM clock_timestamp() - query_start)*1000) FILTER (WHERE wait_event_type = 'Lock' AND ${xRow})), 0),
  (SELECT ctid FROM accounts WHERE email = '${email}')
FROM pg_stat_activity WHERE datname = current_database() AND usename = 'fukulow_app' AND backend_type = 'client backend'`;
}

/** Achieved sampling interval from consecutive database timestamps (not Node arrival times). */
export function samplerIntervals(rows: readonly SamplerRow[]) {
  const gaps = rows.slice(1).map((r, i) => r.dbMs - rows[i].dbMs).sort((a, b) => a - b);
  if (!gaps.length) return { count: rows.length, medianMs: null, maxMs: null };
  const mid = gaps.length >> 1;
  const medianMs = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return { count: rows.length, medianMs, maxMs: gaps.at(-1)! };
}

/** Database clock to harness clock: the smallest (arrival - database time); pipe latency only adds. */
export function clockOffset(rows: readonly SamplerRow[]) {
  return rows.length ? Math.min(...rows.map(r => r.nodeMs - r.dbMs)) : null;
}

const OWNER_STATEMENT = /FROM accounts WHERE id = \$1 FOR UPDATE/, SIGNIN_STATEMENT = /FROM accounts WHERE email = \$1 FOR UPDATE/;
/** Whose wait: the sampler's query text for that pid during the interval, else the log STATEMENT line. */
export function attribute(interval: WaitInterval, rows: readonly SamplerRow[]) {
  for (const r of rows) {
    if (r.dbMs < interval.startDbMs || r.dbMs > interval.endDbMs) continue;
    const hit = r.waiting.find(w => w.pid === interval.pid);
    if (hit) return { who: hit.kind, source: 'sampler' as const };
  }
  if (interval.statement && OWNER_STATEMENT.test(interval.statement)) return { who: 'owner' as const, source: 'statement' as const };
  if (interval.statement && SIGNIN_STATEMENT.test(interval.statement)) return { who: 'signin' as const, source: 'statement' as const };
  return { who: 'unknown' as const, source: 'none' as const };
}
