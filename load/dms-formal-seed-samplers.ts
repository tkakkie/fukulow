// Seed diagnostic samplers (#426). Each in-container sampler is ONE long-lived docker exec that loops inside
// the DB container, so sampling adds no docker exec per second next to the seed's own one exec per batch.
import { readFileSync } from 'node:fs';
import type { Executor } from './dms-formal-exec.ts';

export const kernelFiles = [
  '/proc/diskstats', '/proc/pressure/io', '/proc/pressure/memory', '/proc/pressure/cpu', '/proc/meminfo', '/proc/vmstat',
  '/sys/fs/cgroup/memory.stat', '/sys/fs/cgroup/memory.events', '/sys/fs/cgroup/io.stat', '/sys/fs/cgroup/io.pressure',
  '/sys/fs/cgroup/cpu.stat',
] as const;
export const stopFile = '/tmp/fukulow-seed-sampler-stop';

// One tail per second reads every present file; a missing file is marked, never skipped silently.
// The shell's own /proc stat (utime, stime and reaped children) gives the sampler's CPU cost.
export const kernelLoop = `stop=$1; shift
echo "--- clk_tck $(getconf CLK_TCK 2>/dev/null || echo unknown)"
while [ ! -e "$stop" ]; do
  echo "=== $(date +%s.%N)" || exit 0
  read -r self < /proc/$$/stat && echo "--- self $self"
  present=''
  for f in "$@"; do if [ -r "$f" ]; then present="$present $f"; else echo "--- missing $f"; fi; done
  [ -z "$present" ] || tail -v -n +1 -- $present 2>&1 || echo "--- tail-exit $?"
  sleep 1
done
read -r self < /proc/$$/stat && echo "--- self $self"
echo "--- stopped"`;

// One psql session repeats the snapshot every second (\watch on the query buffer, so the SQL has no semicolon);
// it restarts every 10 samples to see the stop file. printf %s keeps the backslash commands literal.
// statement_timeout cancels a stalled snapshot inside PostgreSQL; the error ends that session and is recorded.
export const postgresLoop = `stop=$1; sql=$2
echo "--- clk_tck $(getconf CLK_TCK 2>/dev/null || echo unknown)"
while [ ! -e "$stop" ]; do
  printf '%s\\n' '\\timing on' "$sql" '\\watch i=1 c=10' | psql -X -q -At -U fukulow -d fukulow -v ON_ERROR_STOP=1 2>&1
  code=$?
  echo "--- psql-exit $code" || exit 0
  [ "$code" = 0 ] || sleep 1
done
read -r self < /proc/$$/stat && echo "--- self $self"
echo "--- stopped"`;

// Statistics views only: no query text, user names or parameters. One line of JSON per sample.
export const snapshotSql = `SELECT jsonb_build_object(
  'atMs', round(extract(epoch FROM clock_timestamp()) * 1000, 3),
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
  'waitEvents', (SELECT coalesce(json_agg(s ORDER BY backend_type, state, wait_event_type, wait_event), '[]') FROM (
    SELECT backend_type, state, wait_event_type, wait_event, count(*) FROM pg_stat_activity
    WHERE pid <> pg_backend_pid() GROUP BY backend_type, state, wait_event_type, wait_event
  ) AS s),
  'vacuum', (SELECT coalesce(json_agg(s ORDER BY pid), '[]') FROM (
    SELECT pid, datid, relid, phase, heap_blks_total, heap_blks_scanned, heap_blks_vacuumed,
      index_vacuum_count, indexes_total, indexes_processed, dead_tuple_bytes, num_dead_item_ids, delay_time
    FROM pg_stat_progress_vacuum
  ) AS s)
)::text`;

const gapLimit = 200;
type Gaps = { maxGapMs: number | null; gaps: { afterAtMs: number; gapMs: number }[]; gapsTruncated: boolean };
// A gap over two intervals is a stretch without samples; it is evidence (the sampler may stall with the seed), listed explicitly.
function gaps(times: number[], intervalMs: number): Gaps {
  const out: Gaps = { maxGapMs: null, gaps: [], gapsTruncated: false };
  for (let i = 1; i < times.length; i++) {
    const gapMs = Math.round(times[i]! - times[i - 1]!);
    out.maxGapMs = Math.max(out.maxGapMs ?? 0, gapMs);
    if (gapMs <= 2 * intervalMs) continue;
    if (out.gaps.length < gapLimit) out.gaps.push({ afterAtMs: times[i - 1]!, gapMs });
    else out.gapsTruncated = true;
  }
  return out;
}

// CPU seconds of the loop shell and its reaped children (tail, date, sleep, psql) from /proc/<pid>/stat.
export function loopCpuSeconds(stat: string | undefined, clockTicks: number | null) {
  if (!stat || !clockTicks) return null;
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ').map(Number);
  const ticks = fields.slice(11, 15);
  if (ticks.length !== 4 || ticks.some(value => !Number.isFinite(value))) return null;
  return ticks.reduce((sum, value) => sum + value, 0) / clockTicks;
}

export type KernelCoverage = Gaps & {
  samples: number; firstAtMs: number | null; lastAtMs: number | null;
  missing: Record<string, number>; failed: Record<string, number>; stopped: boolean; loopCpuSeconds: number | null;
};

export function parseKernelSamples(raw: string, intervalMs = 1_000): KernelCoverage {
  const missing: Record<string, number> = {}, failed: Record<string, number> = {}, times: number[] = [];
  let clockTicks: number | null = null, self: string | undefined, stopped = false;
  let frame: { present: Set<string>; marked: Set<string> } | undefined;
  const close = () => {
    if (!frame) return;
    for (const file of kernelFiles) {
      if (frame.marked.has(file)) missing[file] = (missing[file] ?? 0) + 1;
      else if (!frame.present.has(file)) failed[file] = (failed[file] ?? 0) + 1;
    }
  };
  for (const line of raw.split('\n')) {
    const header = /^=== (\d+(?:\.\d+)?)$/.exec(line);
    if (header) { close(); frame = { present: new Set(), marked: new Set() }; times.push(Number(header[1]) * 1000); continue; }
    if (line.startsWith('--- clk_tck ')) { const ticks = Number(line.slice(12)); clockTicks = Number.isFinite(ticks) && ticks > 0 ? ticks : null; continue; }
    if (line.startsWith('--- self ')) { self = line.slice(9); continue; }
    if (line === '--- stopped') { stopped = true; continue; }
    if (!frame) continue;
    const file = /^==> (.+) <==$/.exec(line)?.[1];
    if (file) frame.present.add(file);
    else if (line.startsWith('--- missing ')) frame.marked.add(line.slice(12));
    // A read error names its file; that file counts as failed for this sample even if its header was printed.
    else if (line.startsWith('tail: ')) for (const name of kernelFiles) if (line.includes(name)) frame.present.delete(name);
  }
  close();
  return { samples: times.length, firstAtMs: times[0] ?? null, lastAtMs: times.at(-1) ?? null, ...gaps(times, intervalMs),
    missing, failed, stopped, loopCpuSeconds: loopCpuSeconds(self, clockTicks) };
}

export type PostgresCoverage = Gaps & {
  samples: number; firstAtMs: number | null; lastAtMs: number | null; sessions: number; failedSessions: number;
  unexpectedLines: number; stopped: boolean; queryMs: { count: number; total: number; max: number } | null; loopCpuSeconds: number | null;
};

// The raw lines are statistics JSON, psql timing lines and loop markers; psql error text is only counted.
export function parsePostgresSamples(raw: string, intervalMs = 1_000): PostgresCoverage {
  const times: number[] = [], query = { count: 0, total: 0, max: 0 };
  let sessions = 0, failedSessions = 0, unexpectedLines = 0, stopped = false, clockTicks: number | null = null, self: string | undefined;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('--- clk_tck ')) { const ticks = Number(line.slice(12)); clockTicks = Number.isFinite(ticks) && ticks > 0 ? ticks : null; continue; }
    if (line.startsWith('--- self ')) { self = line.slice(9); continue; }
    const exit = /^--- psql-exit (\d+)$/.exec(line);
    if (exit) { sessions++; if (exit[1] !== '0') failedSessions++; continue; }
    if (line === '--- stopped') { stopped = true; continue; }
    const timing = /^Time: (\d+(?:\.\d+)?) ms\b/.exec(line);
    if (timing) { const ms = Number(timing[1]); query.count++; query.total += ms; query.max = Math.max(query.max, ms); continue; }
    try {
      const row = JSON.parse(line) as { atMs?: unknown; checkpointer?: unknown; wal?: unknown; io?: unknown };
      if (typeof row.atMs !== 'number' || !row.checkpointer || !row.wal || !Array.isArray(row.io)) throw new Error('incomplete');
      times.push(row.atMs);
    } catch { unexpectedLines++; }
  }
  return { samples: times.length, firstAtMs: times[0] ?? null, lastAtMs: times.at(-1) ?? null, ...gaps(times, intervalMs),
    sessions, failedSessions, unexpectedLines, stopped,
    queryMs: query.count ? { count: query.count, total: Math.round(query.total * 1000) / 1000, max: query.max } : null,
    loopCpuSeconds: loopCpuSeconds(self, clockTicks) };
}

export type SamplerOutcome = 'stopped' | 'exited-early' | 'aborted';
export type SeedSamplerRecord = {
  kernel: KernelCoverage | null; kernelOutcome: SamplerOutcome; postgres: PostgresCoverage | null; postgresOutcome: SamplerOutcome;
  dockerExecs: number; failures: string[]; missing: string[];
};

// Starts both long-lived loops. stop() touches the stop file once, waits for both loops, then reads the raw outputs.
export function startSeedSamplers(exec: Executor, container: string, paths: { kernel: string; postgres: string }, graceMs = 15_000) {
  let dockerExecs = 0;
  const loop = (script: string, args: string[], path: string, env: string[] = []) => {
    const abort = new AbortController();
    let exited = false;
    dockerExecs++;
    const done = exec({ program: 'docker', args: ['exec', ...env.flatMap(value => ['-e', value]), container, 'sh', '-c', script, 'fukulow-sampler', stopFile, ...args],
      log: path, timeout: 24 * 60 * 60 * 1000, signal: abort.signal })
      .then(result => result.code === 0, () => false)
      .finally(() => { exited = true; });
    return { abort, done, exited: () => exited };
  };
  const kernel = loop(kernelLoop, [...kernelFiles], paths.kernel);
  const postgres = loop(postgresLoop, [snapshotSql], paths.postgres, ['PGOPTIONS=-c statement_timeout=2000']);
  return async (): Promise<SeedSamplerRecord> => {
    const early = { kernel: kernel.exited(), postgres: postgres.exited() };
    dockerExecs++;
    await exec({ program: 'docker', args: ['exec', container, 'touch', stopFile], timeout: 10_000 }).catch(() => undefined);
    const outcome = async (running: typeof kernel, exitedEarly: boolean): Promise<SamplerOutcome> => {
      if (exitedEarly) return 'exited-early';
      const timer = setTimeout(() => running.abort.abort(), graceMs);
      const ok = await running.done;
      clearTimeout(timer);
      return ok && !running.abort.signal.aborted ? 'stopped' : 'aborted';
    };
    const [kernelOutcome, postgresOutcome] = await Promise.all([outcome(kernel, early.kernel), outcome(postgres, early.postgres)]);
    const read = (path: string) => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } };
    const kernelRaw = read(paths.kernel), postgresRaw = read(paths.postgres);
    return summarizeSamplers(kernelRaw === undefined ? null : parseKernelSamples(kernelRaw), kernelOutcome,
      postgresRaw === undefined ? null : parsePostgresSamples(postgresRaw), postgresOutcome, dockerExecs);
  };
}

// failures: the collection broke (no data, loop died, read errors). missing: a file this kernel does not provide.
export function summarizeSamplers(kernel: KernelCoverage | null, kernelOutcome: SamplerOutcome,
  postgres: PostgresCoverage | null, postgresOutcome: SamplerOutcome, dockerExecs: number): SeedSamplerRecord {
  const failures: string[] = [];
  if (!kernel || kernel.samples === 0) failures.push('kernel: no samples');
  if (kernelOutcome !== 'stopped') failures.push('kernel: ' + kernelOutcome);
  for (const file of Object.keys(kernel?.failed ?? {})) failures.push('kernel: read failed ' + file);
  if (!postgres || postgres.samples === 0) failures.push('postgres: no samples');
  if (postgresOutcome !== 'stopped') failures.push('postgres: ' + postgresOutcome);
  if (postgres?.failedSessions) failures.push('postgres: failed psql sessions');
  if (postgres?.unexpectedLines) failures.push('postgres: unexpected output');
  const missing = Object.keys(kernel?.missing ?? {}).map(file => 'kernel: ' + file);
  return { kernel, kernelOutcome, postgres, postgresOutcome, dockerExecs, failures, missing };
}

type BatchRow = { kind?: string; organization?: number; batchIndex?: number; durationMs?: number; dbDurationMs?: number };
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return (sorted[middle]! + sorted[Math.floor((sorted.length - 1) / 2)]!) / 2;
};
// The effect check: Message batch medians (batch 0 excluded, as in the stop rule) with sampling on, split into
// PostgreSQL time and docker exec/psql cost, comparable with earlier seeds' medians.
export function seedBatchSummary(jsonl: string) {
  const rows = jsonl.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as BatchRow]; } catch { return []; } })
    .filter(row => row.kind === 'batch' && row.batchIndex !== 0 && typeof row.durationMs === 'number');
  const timed = rows.filter(row => typeof row.dbDurationMs === 'number');
  return {
    batches: rows.length, dbClockMissing: rows.length - timed.length,
    medianMs: median(rows.map(row => row.durationMs!)),
    medianDbMs: median(timed.map(row => row.dbDurationMs!)),
    medianOutsideDbMs: median(timed.map(row => row.durationMs! - row.dbDurationMs!)),
  };
}
