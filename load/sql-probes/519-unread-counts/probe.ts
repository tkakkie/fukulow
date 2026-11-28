// Pure helpers for the #519 Channel-list counts probe (run.ts does the I/O).
import { timed } from '../../harness-core/thermal.ts';

export const organization = '00000000-0000-4000-8000-00000000000a';
export const member = "md5('user-2')::uuid";
export const channels = "(SELECT array_agg(md5('chan-'||g)::uuid ORDER BY g) FROM generate_series(1,200) g)::uuid[]";
export type Arm = 'current' | 'a3';

// The Channel-list counts SQL at the pinned commit.
export function extractListCounts(source: string): string {
  const parts = source.split(/pub\((?:super|in crate::messages)\) const LIST_COUNTS_SQL: &str = r#"/);
  if (parts.length !== 2) throw new Error('LIST_COUNTS_SQL not found exactly once');
  const end = parts[1].indexOf('"#;');
  if (end < 0) throw new Error('LIST_COUNTS_SQL is not terminated');
  return parts[1].slice(0, end).trim();
}

export function listCountsAtCommit(git: (...args: string[]) => string, commit: string): string {
  let source: string;
  try {
    source = git('show', `${commit}:server/src/messages/unread/counts.rs`);
  } catch {
    source = git('show', `${commit}:server/src/messages/unread.rs`);
  }
  return extractListCounts(source);
}

// Replace $1..$4 with literals so one checksum query can wrap the counts query.
export function bindLiterals(sql: string, array: string): string {
  const values: Record<string, string> = { '1': `'${organization}'::uuid`, '2': member, '3': '0::bigint', '4': `'${array}'::uuid[]` };
  return sql.replace(/\$([0-9]+)(?![0-9])/g, (_, n: string) => {
    const value = values[n];
    if (!value) throw new Error(`unexpected parameter $${n}`);
    return value;
  });
}

export function checksumSql(bound: string): string {
  return `SELECT md5(string_agg(concat_ws(',',channel_id,as_of_seq,read_seq,missing_position,main_unread_count,unread_count,` +
    `main_mention_unread_count,mention_unread_count),';' ORDER BY channel_id)) || ' unread=' || sum(unread_count) || ` +
    `' main=' || sum(main_unread_count) || ' mentions=' || sum(mention_unread_count) FROM (${bound}) x;`;
}

// psql `\timing on` lines: "Time: 1.234 ms" (longer runs append a clock form we never reach).
export function timings(output: string): number[] {
  return [...output.matchAll(/^Time: ([0-9.]+) ms/gm)].map(m => Number(m[1]));
}

// Nearest-rank quantile.
export function quantile(values: number[], q: number): number {
  if (values.length === 0) throw new Error('no samples');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

export type Bench = { transactions: number; tps: number; latencyMs: number };
export function pgbench(output: string): Bench {
  const number = (re: RegExp) => {
    const m = output.match(re);
    if (!m) throw new Error(`pgbench output lacks ${re}`);
    return Number(m[1]);
  };
  return {
    transactions: number(/number of transactions actually processed: ([0-9]+)/),
    tps: number(/tps = ([0-9.]+) \(without initial connection time\)/),
    latencyMs: number(/latency average = ([0-9.]+) ms/),
  };
}

export type PlanSummary = { executionMs: number; sharedBlocks: number };
export function planSummary(explain: unknown): PlanSummary {
  const root = (explain as [{ 'Execution Time': number; Plan: Record<string, number> }])[0];
  return { executionMs: root['Execution Time'], sharedBlocks: root.Plan['Shared Hit Blocks'] + root.Plan['Shared Read Blocks'] };
}

// pgbench --log lines: "client_id transaction_no time_us script_no time_epoch time_us_part".
export function logLatenciesMs(log: string): number[] {
  return log.split('\n').filter(l => l.trim() !== '').map(line => {
    const fields = line.trim().split(/\s+/);
    const us = Number(fields[2]);
    if (fields.length < 6 || !Number.isFinite(us)) throw new Error(`bad pgbench log line: ${line}`);
    return us / 1000;
  });
}

// pgbench's own measured interval from its per-transaction log (`client tx latency_us script
// epoch_s epoch_us`, the stamp being the transaction's end): the earliest transaction start to the
// latest end, on the kernel wall clock the launcher's thermal sampler also stamps (#796).
export type PgbenchWindow = { startMs: number; endMs: number };
export function logWindow(log: string): PgbenchWindow {
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const line of log.split('\n').filter(l => l.trim() !== '')) {
    const f = line.trim().split(/\s+/).map(Number);
    if (f.length < 6 || !f.slice(0, 6).every(Number.isFinite)) throw new Error(`bad pgbench log line: ${line}`);
    const end = f[4] * 1000 + f[5] / 1000;
    startMs = Math.min(startMs, end - f[2] / 1000);
    endMs = Math.max(endMs, end);
  }
  if (!Number.isFinite(startMs)) throw new Error('empty pgbench log');
  return { startMs, endMs };
}

// One measured pgbench run of a send block, in the order final.ts needs: the run itself (timed,
// so the wrapper window covers the run only), then the post-run step (the WAL query), then the
// per-transaction log, whose latencies and window are the block's records.
export function measuredPgbench<T>(steps: { run: () => string; after: () => T; log: () => string }, clock?: Parameters<typeof timed>[1]) {
  const { value: output, window: measuredWindow } = timed(steps.run, clock);
  return pgbenchEvidence(output, measuredWindow, steps);
}

export function pgbenchEvidence<T>(output: string, measuredWindow: ReturnType<typeof timed>['window'],
  steps: { after: () => T; log: () => string }) {
  const after = steps.after();
  const errors: string[] = [];
  let latencies: number[] = [];
  let pgbenchWindow: PgbenchWindow | null = null;
  try {
    const log = steps.log();
    latencies = logLatenciesMs(log);
    pgbenchWindow = logWindow(log);
  } catch (e) { errors.push(`latency log: ${e instanceof Error ? e.message : String(e)}`); }
  return { output, measuredWindow, after, latencies, pgbenchWindow, errors };
}

export type PairSend = { pair: number; walBytesPerSend: number; tps: number };
export function sendRatios(current: PairSend[], final: PairSend[]) {
  if (current.length === 0 || current.length !== final.length) throw new Error('unpaired send blocks');
  // A zero, negative or non-finite input, ratio or median is invalid: NaN reads as "no stop" and
  // the others give a meaningless verdict, so the run fails instead (#803).
  const positive = (label: string, x: number) => {
    if (!Number.isFinite(x) || x <= 0) throw new Error(`stop rule input is not a positive finite number: ${label}=${x}`);
    return x;
  };
  const ratios = current.map((c, i) => {
    const f = final[i];
    if (f.pair !== c.pair) throw new Error('pair order mismatch');
    for (const [arm, s] of [['current', c], ['final', f]] as const) {
      positive(`pair ${s.pair} ${arm} walBytesPerSend`, s.walBytesPerSend);
      positive(`pair ${s.pair} ${arm} tps`, s.tps);
    }
    return { pair: c.pair, walPerSend: positive(`pair ${c.pair} WAL/send ratio`, f.walBytesPerSend / c.walBytesPerSend),
      tps: positive(`pair ${c.pair} tps ratio`, f.tps / c.tps) };
  });
  const median = (xs: number[]) => quantile(xs, 0.5);
  const walPerSend = positive('median WAL/send ratio', median(ratios.map(r => r.walPerSend)));
  const tps = positive('median tps ratio', median(ratios.map(r => r.tps)));
  return { ratios, medianWalPerSend: walPerSend, medianTps: tps };
}

export const exceedsSendLimits = (walPerSend: number, tps: number) => walPerSend > 1.2 || tps < 0.9;

// §10 step 1 stop rule, fixed before the run: per pair, a3-final against current;
// the rule fires when the median pair ratio exceeds a limit. Every pair is reported.
export function stopRule(current: PairSend[], final: PairSend[]) {
  const comparison = sendRatios(current, final);
  return { ...comparison, stop: exceedsSendLimits(comparison.medianWalPerSend, comparison.medianTps),
    limits: 'stop if median WAL/send ratio > 1.20 or median tps ratio < 0.90' };
}

// message_counts_check result as `SELECT count(*)` under a statement_timeout. Anything but
// exactly 0 rows fails the run; a timeout is a failed verification, never a skipped one.
export type CountsCheck = { status: 'ok' | 'drift' | 'timeout' | 'error'; rows: number | null; detail: string | null };
export function countsCheckOutcome(code: number | null, stdout: string, stderr: string): CountsCheck {
  if (code !== 0) {
    const timeout = /canceling statement due to statement timeout/.test(stderr);
    return { status: timeout ? 'timeout' : 'error', rows: null, detail: stderr.slice(-500) || `exit ${code}` };
  }
  const out = stdout.trim();
  if (!/^[0-9]+$/.test(out)) return { status: 'error', rows: null, detail: `unexpected output: ${out.slice(0, 200)}` };
  return { status: out === '0' ? 'ok' : 'drift', rows: Number(out), detail: null };
}

// The A3 migration under the same statement_timeout: its backfill guard runs message_counts_check,
// so a timeout there is a failed verification too.
export function migrationOutcome(code: number | null, stderr: string): CountsCheck {
  if (code === 0) return { status: 'ok', rows: null, detail: null };
  return { ...countsCheckOutcome(code, '', stderr), status: /canceling statement due to statement timeout/.test(stderr) ? 'timeout' : 'error' };
}

// Checkpoint start lines from the server log (log_checkpoints=on, log_line_prefix starting with %m
// in UTC). The checkpointer logs each start before it does any work and in start order, unlike the
// cumulative counters, which are published only after a checkpoint completes. A requested start
// carries `force`; a start caused only by WAL volume or by checkpoint_timeout is automatic. A start
// line without a readable server timestamp is undeterminable, so it fails instead of being skipped.
export type CheckpointStart = { atMs: number; forced: boolean; automatic: boolean; line: string };
export function checkpointStartLines(log: string): CheckpointStart[] {
  return log.split('\n').filter(l => /checkpoint starting:/.test(l)).map(line => {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?) (?:UTC|GMT) /);
    const atMs = m ? Date.parse(`${m[1]}T${m[2]}Z`) : NaN;
    if (!Number.isFinite(atMs)) throw new Error(`checkpoint start without a server-log timestamp (undeterminable): ${line}`);
    const flags = line.slice(line.indexOf('checkpoint starting:'));
    const forced = /\bforce\b/.test(flags);
    return { atMs, forced, automatic: !forced && /\b(wal|time)\b/.test(flags), line };
  });
}

// One block judged by server-log timestamps. The opening and closing starts are the first forced
// starts stamped at or after each CHECKPOINT request (%m truncates to the millisecond). Every start
// logged between them that is stamped at or before the end of the measured block crossed the block;
// a later one (for example a WAL-driven start after the block) is kept as afterBlock, not flagged.
// null: the closing start is not logged yet, so nothing can be decided.
export type CheckpointWindow = { openAtMs: number; closeAtMs: number; blockEndMs: number; inBlock: CheckpointStart[]; afterBlock: CheckpointStart[] };
export function checkpointWindow(starts: CheckpointStart[], openRequestMs: number, closeRequestMs: number, blockEndMs: number): CheckpointWindow | null {
  if (![openRequestMs, closeRequestMs, blockEndMs].every(Number.isFinite)) throw new Error('checkpoint window times are undeterminable');
  const forcedFrom = (ms: number, from: number) => starts.findIndex((s, i) => i >= from && s.forced && s.atMs >= Math.floor(ms));
  const open = forcedFrom(openRequestMs, 0);
  const close = open < 0 ? -1 : forcedFrom(closeRequestMs, open + 1);
  if (close < 0) return null;
  const between = starts.slice(open + 1, close);
  return { openAtMs: starts[open].atMs, closeAtMs: starts[close].atMs, blockEndMs,
    inBlock: between.filter(s => s.atMs <= blockEndMs), afterBlock: between.filter(s => s.atMs > blockEndMs) };
}

// Polls the server log until the closing forced start is visible (log capture can lag). Because
// starts are logged in order, every earlier start is visible then too. A read failure or running out
// of polls throws: an undecided block is never a clean one.
export function waitForCheckpointWindow(readLog: () => string, openRequestMs: number, closeRequestMs: number, blockEndMs: number,
  polls: number, sleep: () => void): CheckpointWindow {
  for (let i = 0; i < polls; i++) {
    const window = checkpointWindow(checkpointStartLines(readLog()), openRequestMs, closeRequestMs, blockEndMs);
    if (window) return window;
    sleep();
  }
  throw new Error(`closing CHECKPOINT start not logged after ${polls} polls (undeterminable)`);
}

// Lower bound (whole seconds) for the post-block `docker events` query: at least 1 s before the
// pre-block `docker ps`, so a container started between the two is not lost to rounding.
export const eventsSince = (psMs: number) => Math.floor((psMs - 1000) / 1000);

// One send block. The row is built as soon as pgbench completes; the closing checkpoint and the
// host probe run after it, and their failures are recorded on the row. The row is kept (written to
// sends.json) before any failure is raised, so a failed run still has every finished block.
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
export type BlockOutcome<H> = { crossed: boolean; checkpointLog: CheckpointWindow | null; hostAfter: H | null; errors: string[] };
export function runBlock<R extends { crossed: boolean; errors: string[] }, H extends { busy: boolean }>(steps: {
  label: string; measure: () => R; closeCheckpoint: () => CheckpointWindow; hostAfter?: () => H; keep: (row: R & BlockOutcome<H>) => void;
}): R & BlockOutcome<H> {
  return finishBlock(steps.measure(), steps);
}

export function finishBlock<R extends { crossed: boolean; errors: string[] }, H extends { busy: boolean }>(measured: R, steps: {
  label: string; closeCheckpoint: () => CheckpointWindow; hostAfter?: () => H; keep: (row: R & BlockOutcome<H>) => void;
}): R & BlockOutcome<H> {
  const row: R & BlockOutcome<H> = { ...measured, checkpointLog: null, hostAfter: null, errors: [...measured.errors] };
  try {
    row.checkpointLog = steps.closeCheckpoint();
    if (row.checkpointLog.inBlock.length > 0) row.crossed = true;
  } catch (e) { row.errors.push(`closing CHECKPOINT: ${message(e)}`); }
  if (steps.hostAfter) {
    try { row.hostAfter = steps.hostAfter(); } catch (e) { row.errors.push(`host probe (docker ps/events): ${message(e)}`); }
  }
  steps.keep(row);
  if (row.errors.length > 0) throw new Error(`${steps.label}: ${row.errors.join('; ')}`);
  if (row.crossed) throw new Error(`${steps.label}: checkpoint inside a send block`);
  if (row.hostAfter?.busy) throw new Error(`${steps.label}: host not idle ${JSON.stringify(row.hostAfter)}`);
  return row;
}

// Send blocks in run order: each pair keeps its fixed arm order, and every block gets its own
// database cloned from the arm's template, so no block inherits rows or vacuum debt from another.
export type SendBlock = { order: number; pair: number; arm: string; db: string };
export function sendBlocks<A extends string>(pairs: A[][]): (SendBlock & { arm: A })[] {
  return pairs.flatMap((pair, i) => {
    if (pair.length !== 2 || new Set(pair).size !== 2) throw new Error('each pair needs both arms once');
    return pair.map(arm => ({ pair: i + 1, arm }));
  }).map((b, i) => ({ order: i + 1, ...b, db: `s${i + 1}_${b.arm}` }));
}
