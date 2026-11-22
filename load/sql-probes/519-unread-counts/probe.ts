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
