import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Sql } from '../d3r/engine.ts';
import { modelLabel, sampleSeconds } from './design.ts';

export const heap = 'public.message_search_terms';
export const lookup = 'public.message_search_terms_lookup';
export const maintenance = 'public.message_search_terms_maintenance';
export const relations = {heap, lookup, maintenance};

const stats = (table: string) =>
  `(SELECT to_jsonb(s) FROM pg_stat_user_tables s WHERE relid = '${table}'::regclass)`;
export const sampleSql = `SELECT jsonb_build_object('at', clock_timestamp(), 'lsn', pg_current_wal_insert_lsn(),
  'bytes', jsonb_build_object(${Object.entries(relations).map(([key, name]) => `'${key}', pg_relation_size('${name}')`).join(', ')}),
  'dbBytes', pg_database_size(current_database()),
  'terms', ${stats(heap)}, 'messages', ${stats('public.messages')},
  'vacuum', (SELECT coalesce(jsonb_agg(to_jsonb(v) || jsonb_build_object('relid', v.relid::bigint) ORDER BY pid), '[]')
    FROM pg_stat_progress_vacuum v WHERE datname = current_database()),
  'dbStatsReset', (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()),
  'checkpointer', (SELECT to_jsonb(c) FROM pg_stat_checkpointer c));`;

type TableStats = Record<typeof counters[number] | typeof durations[number], number> & Record<typeof times[number], string | null>;
type Checkpointer = Record<typeof checkpoints[number], number> & {stats_reset: string};
export type Sample = {
  at: string; lsn: string; bytes: Record<keyof typeof relations, number>; dbBytes: number; dbStatsReset: string | null;
  terms: TableStats; messages: TableStats; vacuum: Record<string, unknown>[]; checkpointer: Checkpointer;
};
const counters = ['n_tup_ins', 'n_tup_upd', 'n_live_tup', 'n_dead_tup', 'n_ins_since_vacuum',
  'autovacuum_count', 'autoanalyze_count'] as const;
const times = ['last_autovacuum', 'last_autoanalyze'] as const;
const durations = ['total_autovacuum_time', 'total_autoanalyze_time'] as const;
const checkpoints = ['num_timed', 'num_requested', 'num_done', 'buffers_written', 'write_time', 'sync_time'] as const;
export const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const timestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nonnegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function lsnBytes(lsn: string) {
  assert.match(lsn, /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/i, 'Missing or malformed WAL LSN');
  const [high, low] = lsn.split('/');
  return (BigInt('0x' + high) << 32n) + BigInt('0x' + low);
}

export function parseSample(raw: string) {
  const sample: Sample = JSON.parse(raw);
  assert.ok(timestamp(sample?.at) && count(sample.dbBytes), 'Missing sample time or database size');
  lsnBytes(sample.lsn);
  assert.ok(sample.dbStatsReset === null || timestamp(sample.dbStatsReset), 'Missing database statistics reset time');
  assert.ok(Object.keys(relations).every(key => count(sample.bytes?.[key as keyof typeof relations])), 'Missing relation sizes');
  for (const table of [sample.terms, sample.messages]) {
    assert.ok(counters.every(key => count(table?.[key])) &&
      times.every(key => table?.[key] === null || timestamp(table?.[key])) &&
      durations.every(key => nonnegative(table?.[key])), 'Missing table statistics');
  }
  assert.ok(Array.isArray(sample.vacuum) && sample.vacuum.every(row => count(row?.pid) &&
    typeof row?.phase === 'string' && typeof row?.relid === 'number'), 'Missing vacuum progress');
  assert.ok(checkpoints.every(key => nonnegative(sample.checkpointer?.[key])) &&
    timestamp(sample.checkpointer?.stats_reset), 'Missing checkpointer statistics');
  return sample;
}

export type Window = 'W1' | typeof modelLabel | 'W3 IDLE' | 'W3 VACUUM' | 'W3 REINDEX';
export type Tick = {second: number; startedMs: number; completedMs: number; sample: Sample};

export async function tick(sql: Sql, second: number): Promise<Tick> {
  const startedMs = Date.now();
  const sample = parseSample(await sql(sampleSql));
  return {second, startedMs, completedMs: Date.now(), sample};
}

export function interval(window: Window, before: Sample, after: Sample) {
  const walBytes = Number(lsnBytes(after.lsn) - lsnBytes(before.lsn));
  assert.ok(count(walBytes) && after.checkpointer.stats_reset === before.checkpointer.stats_reset &&
    after.dbStatsReset === before.dbStatsReset,
    'WAL or checkpointer statistics reset during sampling');
  const counter = window === 'W1' ? 'n_tup_ins' : 'n_tup_upd';
  const operations = window.startsWith('W3 ') ? 0 : after.messages[counter] - before.messages[counter];
  assert.ok(count(operations), 'Message statistics reset during sampling');
  return {walBytes, operations, walBytesPerOperation: operations ? walBytes / operations : null};
}

export async function sampleWindow(seconds: number, start: number, sample: (second: number) => Promise<void>, signal: AbortSignal) {
  for (let second = sampleSeconds; second <= seconds; second += sampleSeconds) {
    await delay(Math.max(0, start + second * 1000 - performance.now()), undefined, {signal});
    await sample(second);
  }
}
