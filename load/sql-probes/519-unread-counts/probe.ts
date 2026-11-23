// Pure helpers for the #519 Channel-list counts probe (run.ts does the I/O).

export const organization = '00000000-0000-4000-8000-00000000000a';
export const member = "md5('user-2')::uuid";
export const channels = "(SELECT array_agg(md5('chan-'||g)::uuid ORDER BY g) FROM generate_series(1,200) g)::uuid[]";
export type Arm = 'current' | 'a3';

// The Channel-list counts SQL as committed in unread.rs at the pinned commit.
export function extractListCounts(source: string): string {
  const parts = source.split('pub(super) const LIST_COUNTS_SQL: &str = r#"');
  if (parts.length !== 2) throw new Error('LIST_COUNTS_SQL not found exactly once');
  const end = parts[1].indexOf('"#;');
  if (end < 0) throw new Error('LIST_COUNTS_SQL is not terminated');
  return parts[1].slice(0, end).trim();
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

// §10 step 1 stop rule, fixed before the run: per pair, a3-final against current;
// the rule fires when the median pair ratio exceeds a limit. Every pair is reported.
export type PairSend = { pair: number; walBytesPerSend: number; tps: number };
export function stopRule(current: PairSend[], final: PairSend[]) {
  if (current.length === 0 || current.length !== final.length) throw new Error('unpaired send blocks');
  const ratios = current.map((c, i) => {
    const f = final[i];
    if (f.pair !== c.pair) throw new Error('pair order mismatch');
    return { pair: c.pair, walPerSend: f.walBytesPerSend / c.walBytesPerSend, tps: f.tps / c.tps };
  });
  const median = (xs: number[]) => quantile(xs, 0.5);
  const walPerSend = median(ratios.map(r => r.walPerSend));
  const tps = median(ratios.map(r => r.tps));
  return { ratios, medianWalPerSend: walPerSend, medianTps: tps,
    stop: walPerSend > 1.2 || tps < 0.9, limits: 'stop if median WAL/send ratio > 1.20 or median tps ratio < 0.90' };
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

// Checkpoint start lines from the server log (log_checkpoints=on). Each start is logged by the
// checkpointer before it does any work, unlike the cumulative counters, which are published only
// after a checkpoint completes. A start caused by WAL volume or by checkpoint_timeout is automatic.
export function checkpointStarts(log: string): { all: number; automatic: number } {
  const starts = log.split('\n').filter(l => /checkpoint starting:/.test(l));
  return { all: starts.length, automatic: starts.filter(l => /checkpoint starting:.*\b(wal|time)\b/.test(l)).length };
}

// Send blocks in run order: each pair keeps its fixed arm order, and every block gets its own
// database cloned from the arm's template, so no block inherits rows or vacuum debt from another.
export type SendBlock = { order: number; pair: number; arm: string; db: string };
export function sendBlocks(pairs: string[][]): SendBlock[] {
  return pairs.flatMap((pair, i) => {
    if (pair.length !== 2 || new Set(pair).size !== 2) throw new Error('each pair needs both arms once');
    return pair.map(arm => ({ pair: i + 1, arm }));
  }).map((b, i) => ({ order: i + 1, ...b, db: `s${i + 1}_${b.arm}` }));
}
