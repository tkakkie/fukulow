import { appendFileSync, writeFileSync } from 'node:fs';
import { checked, type Executor } from './dms-formal-exec.ts';

export function postgresCommand(seedDiagnostic = false) {
  const formal = ['postgres','-c','shared_preload_libraries=pg_stat_statements','-c','pg_stat_statements.track=all','-c','max_connections=64'];
  return seedDiagnostic ? [...formal, ...[
    'log_checkpoints=on', 'log_autovacuum_min_duration=0', 'track_io_timing=on',
    'track_wal_io_timing=on', 'log_lock_waits=on', 'log_temp_files=0',
  ].flatMap(setting => ['-c', setting])] : formal;
}

const snapshotSql = `
SELECT json_build_object(
  'checkpointer', (SELECT row_to_json(s) FROM pg_stat_checkpointer AS s),
  'bgwriter', (SELECT row_to_json(s) FROM pg_stat_bgwriter AS s),
  'wal', (SELECT row_to_json(s) FROM pg_stat_wal AS s),
  'io', (SELECT json_agg(s ORDER BY object, backend_type, context) FROM (
    SELECT object, backend_type, context, sum(reads) AS reads, sum(read_bytes) AS read_bytes, sum(read_time) AS read_time,
      sum(writes) AS writes, sum(write_bytes) AS write_bytes, sum(write_time) AS write_time,
      sum(writebacks) AS writebacks, sum(writeback_time) AS writeback_time,
      sum(extends) AS extends, sum(extend_bytes) AS extend_bytes, sum(extend_time) AS extend_time,
      sum(hits) AS hits, sum(evictions) AS evictions, sum(reuses) AS reuses,
      sum(fsyncs) AS fsyncs, sum(fsync_time) AS fsync_time, max(stats_reset) AS stats_reset
    FROM pg_stat_io GROUP BY GROUPING SETS ((), (object, backend_type, context))
  ) AS s),
  'waitEvents', (SELECT coalesce(json_agg(s ORDER BY wait_event_type, wait_event), '[]') FROM (
    SELECT wait_event_type, wait_event, count(*) FROM pg_stat_activity
    WHERE pid <> pg_backend_pid() GROUP BY wait_event_type, wait_event
  ) AS s),
  'vacuum', (SELECT coalesce(json_agg(s ORDER BY pid), '[]') FROM (
    SELECT pid, datid, relid, phase, heap_blks_total, heap_blks_scanned, heap_blks_vacuumed,
      index_vacuum_count, indexes_total, indexes_processed, dead_tuple_bytes, num_dead_item_ids, delay_time
    FROM pg_stat_progress_vacuum
  ) AS s)
);`;

export async function seedDiagnosticSample(exec: Executor, container: string, now = Date.now) {
  const startedAtMs = now();
  const docker = (args: string[], input?: string) =>
    checked(exec, { program: 'docker', args, input, timeout: 3_000 });
  const [postgres, containerStats] = await Promise.allSettled([
    docker(['exec','-i',container,'psql','-X','-U','fukulow','-d','fukulow','-v','ON_ERROR_STOP=1','-At'], snapshotSql)
      .then(raw => {
        const { checkpointer, bgwriter, wal, io, waitEvents, vacuum } = JSON.parse(raw);
        if (!checkpointer || !bgwriter || !wal || !Array.isArray(io) || !Array.isArray(waitEvents) || !Array.isArray(vacuum)) {
          throw new Error('PostgreSQL stats unavailable');
        }
        return { atMs: now(), stats: { checkpointer, bgwriter, wal, io, waitEvents, vacuum } };
      }),
    docker(['stats','--no-stream','--format','{{.CPUPerc}}|{{.MemUsage}}|{{.BlockIO}}',container]).then(raw => {
      const stats = /^([\d.]+%)\|([\d.]+[A-Za-z]+ \/ [\d.]+[A-Za-z]+)\|([\d.]+[A-Za-z]+ \/ [\d.]+[A-Za-z]+)$/.exec(raw);
      if (!stats) throw new Error('Docker stats unavailable');
      return { atMs: now(), cpuPercent: stats[1], memoryUsage: stats[2], blockIo: stats[3] };
    }),
  ]);
  return {
    startedAtMs,
    postgres: postgres.status === 'fulfilled' ? postgres.value : null,
    docker: containerStats.status === 'fulfilled' ? containerStats.value : null,
  };
}

export function startSeedSampler(exec: Executor, container: string, path: string) {
  writeFileSync(path, '', { mode: 0o600 });
  const pending = new Set<Promise<void>>();
  let writeFailed = false, hasPostgres = false, hasDocker = false;
  const tick = () => {
    const sample = seedDiagnosticSample(exec, container)
      .then(row => {
        appendFileSync(path, JSON.stringify(row) + '\n');
        hasPostgres ||= row.postgres !== null;
        hasDocker ||= row.docker !== null;
      })
      .catch(() => { writeFailed = true; })
      .finally(() => pending.delete(sample));
    pending.add(sample);
  };
  tick();
  const timer = setInterval(tick, 1_000);
  return async () => {
    clearInterval(timer);
    await Promise.all(pending);
    if (writeFailed || !hasPostgres || !hasDocker) throw new Error('Database samples are incomplete');
  };
}

export type SeedStop = {
  organization: number | null;
  batchIndex: number | null;
  durationMs: number;
  baselineMs: number | null;
  rule: 'message-batch' | 'organization-total' | 'seed-failure';
  limitMs: number | null;
  startedAtMs: number;
  endedAtMs: number;
};

export function seedFailure(startedAtMs: number, endedAtMs: number): SeedStop {
  return { organization: null, batchIndex: null, durationMs: endedAtMs - startedAtMs,
    baselineMs: null, rule: 'seed-failure', limitMs: null, startedAtMs, endedAtMs };
}

// PostgreSQL can attach SQL, parameters or error context to log messages.
// Retain only server-generated event lines with known formats.
export function redactSeedDbLogs(raw: string) {
  const prefix = /^(\S+ \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ [A-Z]+ \[\d+\] (?:LOG|ERROR|FATAL|PANIC): +)(.*)$/;
  return raw.split('\n').flatMap(line => {
    const match = prefix.exec(line);
    if (!match) return [];
    const [, header, message] = match;
    if (/^(checkpoint (?:starting|complete):|automatic (?:aggressive )?(?:vacuum|analyze) of table "[\w.]+":|temporary file: path "base\/pgsql_tmp\/pgsql_tmp[\d.]+", size \d+$)/.test(message)) return [line];
    const lock = /^(process \d+ (?:still waiting for|acquired) \w+Lock) on .+ (after \d+(?:\.\d+)? ms)$/.exec(message);
    if (lock) return [header + lock[1] + ' ' + lock[2]];
    if (/(?:ERROR|FATAL|PANIC):\s+$/.test(header)) return [header + '[detail redacted]'];
    return [];
  }).join('\n');
}

export async function saveSeedDbLogs(exec: Executor, container: string, path: string) {
  // docker logs emits PostgreSQL's stderr on the CLI's stderr even on success.
  const raw = await checked(exec, { program: 'sh', args: ['-c','exec docker logs --timestamps "$1" 2>&1','db-logs',container], timeout: 30_000 });
  writeFileSync(path, redactSeedDbLogs(raw) + '\n', { mode: 0o600 });
}
