import { parseWalInspection, type Snapshot, type WalInspection } from './attribution.ts';

export const installAttributionSql = `
CREATE SCHEMA send_attribution;
CREATE EXTENSION pg_stat_statements WITH SCHEMA send_attribution;
CREATE EXTENSION pg_walinspect WITH SCHEMA send_attribution;`;

export const snapshotSql = `
SELECT json_build_object(
  'deallocations', dealloc,
  'statsReset', stats_reset,
  'statements', COALESCE((
    SELECT json_agg(json_build_object(
      'identity', json_build_object('queryId', queryid::text, 'topLevel', toplevel, 'query', query, 'statsSince', stats_since),
      'counters', json_build_object(
        'calls', calls, 'execMs', total_exec_time, 'rows', rows,
        'sharedBlksHit', shared_blks_hit, 'sharedBlksRead', shared_blks_read,
        'sharedBlksDirtied', shared_blks_dirtied, 'sharedBlksWritten', shared_blks_written,
        'walRecords', wal_records, 'walFpi', wal_fpi, 'walBytes', wal_bytes
      )) ORDER BY queryid, toplevel)
    FROM send_attribution.pg_stat_statements
    WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND userid = 'fukulow_app'::regrole
  ), '[]'::json),
  'functions', COALESCE((
    SELECT json_agg(json_build_object(
      'identity', json_build_object('oid', funcid::text, 'name',
        format('%I.%I(%s)', schemaname, funcname, pg_get_function_identity_arguments(funcid))),
      'counters', json_build_object('calls', calls, 'totalMs', total_time, 'selfMs', self_time)
    ) ORDER BY funcid)
    FROM pg_stat_user_functions
    -- The snapshot's own extension calls are not send work.
    WHERE schemaname <> 'send_attribution'
  ), '[]'::json)
)
FROM send_attribution.pg_stat_statements_info;`;

export function parseBoundary<T>(output: string): T & { snapshot: Snapshot } {
  const [wal, snapshot] = output.trimEnd().split('\n');
  return { ...JSON.parse(wal), snapshot: JSON.parse(snapshot) };
}

// walinspect stops at flushed WAL. Wait for the insert-LSN endpoint without moving it,
// and check every segment, including windows that cross a segment boundary.
function walInspectionSql(beforeLsn: string, afterLsn: string) {
  if (![beforeLsn, afterLsn].every(lsn => /^[\dA-F]+\/[\dA-F]+$/i.test(lsn))) throw new Error('Invalid WAL window LSN');
  const before = `'${beforeLsn}'::pg_lsn`, after = `'${afterLsn}'::pg_lsn`;
  return `
SET statement_timeout = '5min';
DO $check$
DECLARE
  seg_size bigint := pg_size_bytes(current_setting('wal_segment_size'));
  first_segment pg_lsn := ${before} - mod(${before} - '0/0'::pg_lsn, seg_size);
  missing text;
BEGIN
  IF ${before} >= ${after} THEN
    RAISE EXCEPTION 'Empty or reversed WAL window';
  END IF;
  FOR attempt IN 1..20 LOOP
    EXIT WHEN pg_current_wal_flush_lsn() >= ${after};
    PERFORM pg_sleep(0.1);
  END LOOP;
  IF pg_current_wal_flush_lsn() < ${after} THEN
    RAISE EXCEPTION 'Measured WAL endpoint is not flushed';
  END IF;
  SELECT pg_walfile_name(first_segment + seg.offset_bytes + 1) INTO missing
  FROM generate_series(0::bigint, (${after} - first_segment - 1)::bigint, seg_size) AS seg(offset_bytes)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_ls_waldir() w WHERE w.name = pg_walfile_name(first_segment + seg.offset_bytes + 1)
  )
  LIMIT 1;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Measured WAL segment % is missing', missing;
  END IF;
END;
$check$;
WITH stats AS (
  SELECT "resource_manager/record_type" AS label, count AS records, record_size AS "recordBytes", fpi_size AS "fpiBytes"
  FROM send_attribution.pg_get_wal_stats(${before}, ${after}, per_record => true)
  WHERE count > 0
), images AS (
  SELECT resource_manager || '/' || record_type AS label, count(*) AS "fpiCount", sum(block_fpi_length) AS "countedFpiBytes"
  FROM send_attribution.pg_get_wal_block_info(${before}, ${after}, show_data => false)
  WHERE block_fpi_length > 0
  GROUP BY 1
)
SELECT json_agg(json_build_object(
  'label', label, 'records', records, 'recordBytes', "recordBytes", 'fpiBytes', "fpiBytes",
  'fpiCount', COALESCE("fpiCount", 0), 'countedFpiBytes', "countedFpiBytes"
) ORDER BY label)
FROM stats FULL JOIN images USING (label);`;
}

export function inspectWal(query: (sql: string) => string, beforeLsn: string, afterLsn: string, sends: number): WalInspection {
  try {
    return parseWalInspection(query(walInspectionSql(beforeLsn, afterLsn)), sends);
  } catch (error) {
    return { complete: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function walDiskPreflight(df: string, minFreeGiB: number) {
  const availableKiB = df.trimEnd().split('\n').at(-1)?.trim().split(/\s+/)[3];
  const freeBytes = availableKiB && /^\d+$/.test(availableKiB) ? Number(availableKiB) * 1024 : NaN;
  if (!Number.isSafeInteger(freeBytes) || freeBytes < minFreeGiB * 1024 ** 3) {
    throw new Error(`Attribution needs ${minFreeGiB} GiB free on the PostgreSQL WAL filesystem (found ${Number.isFinite(freeBytes) ? (freeBytes / 1024 ** 3).toFixed(1) + ' GiB' : 'unreadable'})`);
  }
  return { freeBytes, minFreeGiB };
}
