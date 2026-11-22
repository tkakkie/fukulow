// Seed diagnostic samplers (#426). Each in-container sampler is ONE long-lived docker exec that loops inside
// the DB container, so sampling adds no docker exec per second next to the seed's own one exec per batch.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Executor } from './dms-formal-exec.ts';
import { batchServerMs, serverDurations } from './dms-formal-seed-diagnostic.ts';

export const kernelFiles = [
  '/proc/diskstats', '/proc/pressure/io', '/proc/pressure/memory', '/proc/pressure/cpu', '/proc/meminfo', '/proc/vmstat',
  '/sys/fs/cgroup/memory.stat', '/sys/fs/cgroup/memory.events', '/sys/fs/cgroup/io.stat', '/sys/fs/cgroup/io.pressure',
  '/sys/fs/cgroup/cpu.stat',
] as const;
export const stopFile = '/tmp/fukulow-seed-sampler-stop';

// One tail per second reads every present file; an absent file is marked missing and an unreadable one unreadable
// (a failure), never skipped silently. The shell's own /proc stat (utime, stime and reaped children) gives its CPU cost.
export const kernelLoop = `stop=$1; shift
echo "--- pid $$"
echo "--- clk_tck $(getconf CLK_TCK 2>/dev/null || echo unknown)"
while [ ! -e "$stop" ]; do
  echo "=== $(date +%s.%N)" || exit 1
  read -r self < /proc/$$/stat && echo "--- self $self"
  present=''
  for f in "$@"; do if [ ! -e "$f" ]; then echo "--- missing $f"; elif [ -r "$f" ]; then present="$present $f"; else echo "--- unreadable $f"; fi; done
  [ -z "$present" ] || tail -v -n +1 -- $present 2>&1 || echo "--- tail-exit $?"
  sleep 1
done
read -r self < /proc/$$/stat && echo "--- self $self"
echo "--- stopped"`;

// One psql session repeats the snapshot every second (\watch on the query buffer, so the SQL has no semicolon) and
// restarts every snapshotsPerSession samples to see the stop file: with PGCONNECT_TIMEOUT=2 and statement_timeout=2000 one session
// lasts at most about 2 + 3 x 2 + 2 x 1 = 10 s, inside the 15 s stop grace. printf %s keeps the backslash commands
// literal. psql runs as a child whose PID is printed, so a loop that misses the grace can be killed and checked.
export const snapshotsPerSession = 3;
export const postgresLoop = `stop=$1; sql=$2
echo "--- pid $$"
echo "--- clk_tck $(getconf CLK_TCK 2>/dev/null || echo unknown)"
while [ ! -e "$stop" ]; do
  printf '%s\\n' '\\timing on' "$sql" '\\watch i=1 c=${snapshotsPerSession}' | psql -X -q -At -U fukulow -d fukulow -v ON_ERROR_STOP=1 2>&1 &
  child=$!
  echo "--- child $child" || exit 1
  wait "$child"
  code=$?
  echo "--- psql-exit $code" || exit 1
  read -r self < /proc/$$/stat && echo "--- self $self"
  [ "$code" = 0 ] || sleep 1
done
read -r self < /proc/$$/stat && echo "--- self $self"
echo "--- stopped"`;

// Kills only the named loop shells and psql children (the command name is checked first, so a reused PID is never
// a PostgreSQL backend), then exits 1 if any of them is still running. Shell builtins and sleep only.
export const killLoop = `for p in "$@"; do
  if read -r s < /proc/$p/stat 2>/dev/null; then
    c=\${s#*(}; c=\${c%%)*}
    if [ "$c" = sh ] || [ "$c" = psql ]; then kill -KILL "$p" 2>/dev/null; fi
  fi
done
sleep 1
for p in "$@"; do
  if read -r s < /proc/$p/stat 2>/dev/null; then
    c=\${s#*(}; c=\${c%%)*}; st=\${s##*) }
    if { [ "$c" = sh ] || [ "$c" = psql ]; } && [ "\${st#Z}" = "$st" ]; then echo "--- alive $p"; exit 1; fi
  fi
done`;

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
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  const fields = stat.slice(close + 2).split(' ').map(Number);
  const ticks = fields.slice(11, 15);
  if (ticks.length !== 4 || ticks.some(value => !Number.isFinite(value))) return null;
  return ticks.reduce((sum, value) => sum + value, 0) / clockTicks;
}

const pids = (raw: string, marker: string) => [...raw.matchAll(new RegExp(`^--- ${marker} (\\d+)$`, 'gm'))].map(match => match[1]!);
const clockTicksOf = (line: string) => { const ticks = Number(line.slice(12)); return Number.isFinite(ticks) && ticks > 0 ? ticks : null; };

export type KernelCoverage = Gaps & {
  samples: number; firstAtMs: number | null; lastAtMs: number | null;
  missing: Record<string, number>; failed: Record<string, number>; tailFailures: number; stopped: boolean; loopCpuSeconds: number | null;
};

export function parseKernelSamples(raw: string, intervalMs = 1_000): KernelCoverage {
  const missing: Record<string, number> = {}, failed: Record<string, number> = {}, times: number[] = [];
  let clockTicks: number | null = null, self: string | undefined, stopped = false, tailFailures = 0;
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
    if (line.startsWith('--- clk_tck ')) { clockTicks = clockTicksOf(line); continue; }
    if (line.startsWith('--- self ')) { self = line.slice(9); continue; }
    if (line === '--- stopped') { stopped = true; continue; }
    // tail exits nonzero when any file failed, even when the failing file's error line names none of ours.
    if (/^--- tail-exit \d+$/.test(line)) { tailFailures++; continue; }
    if (!frame) continue;
    const file = /^==> (.+) <==$/.exec(line)?.[1];
    if (file) frame.present.add(file);
    else if (line.startsWith('--- missing ')) frame.marked.add(line.slice(12));
    // Unreadable (present but not readable) is a failure: the file is left out of both sets.
    else if (line.startsWith('--- unreadable ')) continue;
    // A read error names its file; that file counts as failed for this sample even if its header was printed.
    else if (line.startsWith('tail: ')) for (const name of kernelFiles) if (line.includes(name)) frame.present.delete(name);
  }
  close();
  return { samples: times.length, firstAtMs: times[0] ?? null, lastAtMs: times.at(-1) ?? null, ...gaps(times, intervalMs),
    missing, failed, tailFailures, stopped, loopCpuSeconds: loopCpuSeconds(self, clockTicks) };
}

export type PostgresCoverage = Gaps & {
  samples: number; firstAtMs: number | null; lastAtMs: number | null; sessions: number; failedSessions: number; unterminatedSessions: number;
  shortSessions: number; untimedSamples: number; unexpectedLines: number; stopped: boolean; queryMs: { count: number; total: number; max: number } | null; loopCpuSeconds: number | null;
};

// The raw lines are statistics JSON, psql timing lines and loop markers; psql error text is only counted.
// Every sample needs its timing line, and every session its exit footer; a cut-off session is a failure. The stop
// file is checked only between sessions, so a session that exits 0 printed exactly snapshotsPerSession samples;
// any other count (none included) is a short session, a failure.
export function parsePostgresSamples(raw: string, intervalMs = 1_000): PostgresCoverage {
  const times: number[] = [], query = { count: 0, total: 0, max: 0 };
  let sessions = 0, failedSessions = 0, unexpectedLines = 0, untimedSamples = 0, stopped = false, clockTicks: number | null = null, self: string | undefined;
  let open = false, awaitingTiming = false, sessionSamples = 0, shortSessions = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('--- clk_tck ')) { clockTicks = clockTicksOf(line); continue; }
    if (line.startsWith('--- self ')) { self = line.slice(9); continue; }
    if (/^--- (?:pid|child) \d+$/.test(line)) { if (line.startsWith('--- child')) { open = true; sessionSamples = 0; } continue; }
    const exit = /^--- psql-exit (\d+)$/.exec(line);
    if (exit) {
      if (awaitingTiming) untimedSamples++;
      if (exit[1] === '0' && sessionSamples !== snapshotsPerSession) shortSessions++;
      awaitingTiming = false; open = false; sessionSamples = 0; sessions++; if (exit[1] !== '0') failedSessions++; continue;
    }
    if (line === '--- stopped') { stopped = true; continue; }
    // psql prints "Time: 1234.567 ms (00:01.235)" from one second on.
    const timing = /^Time: (\d+(?:\.\d+)?) ms\b/.exec(line);
    if (timing) {
      const ms = Number(timing[1]); query.count++; query.total += ms; query.max = Math.max(query.max, ms);
      if (awaitingTiming) awaitingTiming = false; else unexpectedLines++;
      continue;
    }
    try {
      const row = JSON.parse(line) as { atMs?: unknown; checkpointer?: unknown; wal?: unknown; io?: unknown };
      if (typeof row.atMs !== 'number' || !row.checkpointer || !row.wal || !Array.isArray(row.io)) throw new Error('incomplete');
      if (awaitingTiming) untimedSamples++;
      awaitingTiming = true;
      sessionSamples++;
      times.push(row.atMs);
    } catch { unexpectedLines++; }
  }
  if (awaitingTiming) untimedSamples++;
  return { samples: times.length, firstAtMs: times[0] ?? null, lastAtMs: times.at(-1) ?? null, ...gaps(times, intervalMs),
    sessions, failedSessions, unterminatedSessions: open ? 1 : 0, shortSessions, untimedSamples, unexpectedLines, stopped,
    queryMs: query.count ? { count: query.count, total: Math.round(query.total * 1000) / 1000, max: query.max } : null,
    loopCpuSeconds: loopCpuSeconds(self, clockTicks) };
}

export type SamplerOutcome = 'stopped' | 'exited-early' | 'aborted';
// Per loop: not-needed (it stopped by itself), killed (its own shell PID was captured, killed and checked gone),
// unverified (no PID captured, or the kill or its check failed) or skipped (no time left: container removal ends it).
export type KillResult = 'not-needed' | 'killed' | 'unverified' | 'skipped';
export type LoopKill = { kernel: KillResult; postgres: KillResult };
export type SeedSamplerRecord = {
  kernel: KernelCoverage | null; kernelOutcome: SamplerOutcome; postgres: PostgresCoverage | null; postgresOutcome: SamplerOutcome;
  stopCommand: 'ok' | 'failed' | 'skipped'; inContainerKill: LoopKill; dockerExecs: number; failures: string[]; missing: string[];
};
// hurry fires on an interrupt or the deadline, also while stop() is running; untilMs is the wall-clock time by
// which stop() must be done. Every wait is cut to the time left, so stop() never runs past untilMs.
export type StopOptions = { hurry?: AbortSignal; untilMs?: () => number };
export const stopTiming = { stopCommandMs: 10_000, fastStopCommandMs: 5_000, fastGraceMs: 2_000, killMs: 10_000, minStepMs: 1_000 };

// Starts both long-lived loops. The raw output goes to rawDirectory (outside the artifact directory) and is saved
// redacted at the artifact path after the loops end; the raw file is removed on every path. stop() touches the stop
// file once and checks that it worked, waits for both loops, and kills a loop that did not stop inside the container,
// checking that it is gone. Once hurried, the stop command and the grace are short and the kill is skipped:
// container removal, which follows at once, ends the loops.
export function startSeedSamplers(exec: Executor, container: string, paths: { kernel: string; postgres: string }, rawDirectory: string,
  redact: (text: string) => string = text => text, graceMs = 15_000) {
  let dockerExecs = 0;
  const rawPath = (path: string) => join(rawDirectory, basename(path) + '.raw');
  const loop = (script: string, args: string[], path: string, env: string[] = []) => {
    const abort = new AbortController();
    let exited = false;
    dockerExecs++;
    const done = exec({ program: 'docker', args: ['exec', ...env.flatMap(value => ['-e', value]), container, 'sh', '-c', script, 'fukulow-sampler', stopFile, ...args],
      log: rawPath(path), timeout: 24 * 60 * 60 * 1000, signal: abort.signal })
      .then(result => result.code === 0, () => false)
      .finally(() => { exited = true; });
    return { abort, done, exited: () => exited };
  };
  const kernel = loop(kernelLoop, [...kernelFiles], paths.kernel);
  const postgres = loop(postgresLoop, [snapshotSql], paths.postgres, ['PGOPTIONS=-c statement_timeout=2000', 'PGCONNECT_TIMEOUT=2']);
  return async ({ hurry, untilMs }: StopOptions = {}): Promise<SeedSamplerRecord> => {
    const fast = () => hurry?.aborted === true;
    const left = () => (untilMs?.() ?? Infinity) - Date.now();
    try {
      const early = { kernel: kernel.exited(), postgres: postgres.exited() };
      let stopCommand: SeedSamplerRecord['stopCommand'] = 'skipped';
      const stopMs = Math.min(fast() ? stopTiming.fastStopCommandMs : stopTiming.stopCommandMs, left());
      if (stopMs >= stopTiming.minStepMs) {
        dockerExecs++;
        stopCommand = await exec({ program: 'docker', args: ['exec', container, 'touch', stopFile], timeout: stopMs })
          .then(result => result.code === 0 ? 'ok' as const : 'failed' as const, () => 'failed' as const);
      }
      // Without the stop file the loops cannot end by themselves: no grace. A hurry during the grace shortens it.
      const outcome = (running: typeof kernel, exitedEarly: boolean) => exitedEarly ? Promise.resolve<SamplerOutcome>('exited-early') : new Promise<SamplerOutcome>(resolve => {
        const started = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const arm = () => {
          clearTimeout(timer);
          const now = Date.now();
          const end = stopCommand !== 'ok' ? now : Math.min(started + graceMs, fast() ? now + stopTiming.fastGraceMs : Infinity, now + left());
          timer = setTimeout(() => running.abort.abort(), Math.max(0, end - now));
        };
        hurry?.addEventListener('abort', arm, { once: true });
        arm();
        void running.done.then(ok => {
          clearTimeout(timer);
          hurry?.removeEventListener('abort', arm);
          resolve(ok && !running.abort.signal.aborted ? 'stopped' : 'aborted');
        });
      });
      const [kernelOutcome, postgresOutcome] = await Promise.all([outcome(kernel, early.kernel), outcome(postgres, early.postgres)]);
      const read = (path: string) => { try { return readFileSync(rawPath(path), 'utf8'); } catch { return undefined; } };
      const kernelRaw = read(paths.kernel), postgresRaw = read(paths.postgres);
      const inContainerKill = await killLoops(exec, container, { kernel: kernelOutcome !== 'stopped', postgres: postgresOutcome !== 'stopped' },
        { kernel: pids(kernelRaw ?? '', 'pid'), postgres: pids(postgresRaw ?? '', 'pid') }, pids(postgresRaw ?? '', 'child').slice(-1),
        fast() ? 0 : Math.min(stopTiming.killMs, left()), () => { dockerExecs++; });
      const saved = (path: string, raw: string | undefined) => {
        if (raw === undefined) return false;
        try { writeFileSync(path, redact(raw), { mode: 0o600 }); return true; } catch { return false; }
      };
      const record = summarizeSamplers(kernelRaw === undefined ? null : parseKernelSamples(kernelRaw), kernelOutcome,
        postgresRaw === undefined ? null : parsePostgresSamples(postgresRaw), postgresOutcome, dockerExecs, stopCommand, inContainerKill);
      if (!saved(paths.kernel, kernelRaw)) record.failures.push('kernel: redacted file not saved');
      if (!saved(paths.postgres, postgresRaw)) record.failures.push('postgres: redacted file not saved');
      return record;
    } finally {
      // The raw output can hold unredacted text; it never outlives stop(), whatever failed.
      for (const path of [paths.kernel, paths.postgres]) for (const file of [rawPath(path), rawPath(path) + '-retention.json']) {
        try { rmSync(file, { force: true }); } catch { /* Recorded by the missing redacted file, if any. */ }
      }
    }
  };
}

// Kills each loop that did not stop, by its own shell PID (and the current psql child for the PostgreSQL loop), in
// one docker exec. A loop is killed only if its shell PID was captured and the check found it gone; a loop without
// a captured PID is unverified whatever happened to the other.
async function killLoops(exec: Executor, container: string, needed: { kernel: boolean; postgres: boolean },
  shells: { kernel: string[]; postgres: string[] }, children: string[], timeoutMs: number, counted: () => void): Promise<LoopKill> {
  const result: LoopKill = { kernel: 'not-needed', postgres: 'not-needed' };
  const loops = (['kernel', 'postgres'] as const).filter(name => needed[name]);
  if (loops.length === 0) return result;
  if (timeoutMs < stopTiming.minStepMs) { for (const name of loops) result[name] = 'skipped'; return result; }
  for (const name of loops) result[name] = 'unverified';
  const targets = loops.flatMap(name => shells[name].length ? [...shells[name], ...(name === 'postgres' ? children : [])] : []);
  if (targets.length === 0) return result;
  counted();
  const ok = await exec({ program: 'docker', args: ['exec', container, 'sh', '-c', killLoop, 'fukulow-kill', ...targets], timeout: timeoutMs })
    .then(outcome => outcome.code === 0, () => false);
  if (ok) for (const name of loops) if (shells[name].length) result[name] = 'killed';
  return result;
}

// failures: the collection broke (no data, loop died or was cut off, read errors). missing: a file this kernel does not provide.
export function summarizeSamplers(kernel: KernelCoverage | null, kernelOutcome: SamplerOutcome,
  postgres: PostgresCoverage | null, postgresOutcome: SamplerOutcome, dockerExecs: number,
  stopCommand: SeedSamplerRecord['stopCommand'] = 'ok', inContainerKill: LoopKill = { kernel: 'not-needed', postgres: 'not-needed' }): SeedSamplerRecord {
  const failures: string[] = [];
  if (stopCommand !== 'ok') failures.push(`kernel: stop command ${stopCommand}`, `postgres: stop command ${stopCommand}`);
  for (const name of ['kernel', 'postgres'] as const) {
    if (inContainerKill[name] === 'skipped') failures.push(name + ': in-container loop left to container removal');
    if (inContainerKill[name] === 'unverified') failures.push(name + ': in-container loop not verified stopped');
  }
  if (!kernel || kernel.samples === 0) failures.push('kernel: no samples');
  if (kernelOutcome !== 'stopped') failures.push('kernel: ' + kernelOutcome);
  if (kernel && !kernel.stopped) failures.push('kernel: no stop marker');
  if (kernel?.tailFailures) failures.push('kernel: tail failed');
  if (kernel && kernel.loopCpuSeconds === null) failures.push('kernel: loop CPU missing');
  for (const file of Object.keys(kernel?.failed ?? {})) failures.push('kernel: read failed ' + file);
  if (!postgres || postgres.samples === 0) failures.push('postgres: no samples');
  if (postgresOutcome !== 'stopped') failures.push('postgres: ' + postgresOutcome);
  if (postgres && !postgres.stopped) failures.push('postgres: no stop marker');
  if (postgres && postgres.sessions === 0) failures.push('postgres: no session footer');
  if (postgres?.unterminatedSessions) failures.push('postgres: session cut off');
  if (postgres?.shortSessions) failures.push(`postgres: ${postgres.shortSessions} sessions without ${snapshotsPerSession} snapshots`);
  if (postgres?.untimedSamples) failures.push('postgres: sample timing missing');
  if (postgres && postgres.loopCpuSeconds === null) failures.push('postgres: loop CPU missing');
  if (postgres?.failedSessions) failures.push('postgres: failed psql sessions');
  if (postgres?.unexpectedLines) failures.push('postgres: unexpected output');
  const missing = Object.keys(kernel?.missing ?? {}).map(file => 'kernel: ' + file);
  return { kernel, kernelOutcome, postgres, postgresOutcome, stopCommand, inContainerKill, dockerExecs, failures, missing };
}

type BatchRow = { kind?: string; organization?: number; batchIndex?: number; durationMs?: number; dbClockStartMs?: number; dbClockEndMs?: number;
  dbClockSpanMs?: number; dbBackendPid?: number; recorderMs?: number };
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return (sorted[middle]! + sorted[Math.floor((sorted.length - 1) / 2)]!) / 2;
};
export type BatchServerRow = { organization: number | null; batchIndex: number; durationMs: number; dbClockSpanMs: number | null;
  serverMs: number | null; serverStatements: number };

// Per Message batch: the batch time, the DB clock span (an upper bound on PostgreSQL time) and the server-reported
// statement time from the DB log (log_duration, joined by backend PID and the clock window). Coverage counts every
// batch, batch 0 included; the medians exclude batch 0, as the stop rule does. A line that is not a JSON timing row
// is malformed, a collection failure. None of this is the instrumentation's effect on the seed: that needs a matched
// seed without it. recorderMs is the per-batch parse cost the diagnostic adds after the batch timer.
export function seedBatchSummary(jsonl: string, dbLog?: string) {
  let malformedLines = 0;
  const rows = jsonl.split('\n').filter(line => line.trim()).flatMap(line => {
    try {
      const row = JSON.parse(line) as BatchRow;
      if (row && typeof row === 'object' && (row.kind === 'organization' || (row.kind === 'batch' && typeof row.batchIndex === 'number' && typeof row.durationMs === 'number'))) return [row];
    } catch { /* Counted below. */ }
    malformedLines++;
    return [];
  }).filter(row => row.kind === 'batch');
  const durations = dbLog === undefined ? undefined : serverDurations(dbLog);
  const perBatch: BatchServerRow[] = rows.map(row => {
    const clock = typeof row.dbClockSpanMs === 'number' && typeof row.dbClockStartMs === 'number' && typeof row.dbClockEndMs === 'number' && typeof row.dbBackendPid === 'number';
    const server = clock && durations ? batchServerMs(durations, row.dbBackendPid!, row.dbClockStartMs!, row.dbClockEndMs!) : null;
    return { organization: row.organization ?? null, batchIndex: row.batchIndex!, durationMs: row.durationMs!, dbClockSpanMs: clock ? row.dbClockSpanMs! : null,
      serverMs: server?.serverMs ?? null, serverStatements: server?.serverStatements ?? 0 };
  });
  const judged = perBatch.filter(row => row.batchIndex !== 0), timed = judged.filter(row => row.dbClockSpanMs !== null);
  const served = judged.filter(row => row.serverMs !== null);
  const recorder = rows.flatMap(row => typeof row.recorderMs === 'number' ? [row.recorderMs] : []);
  return {
    batches: perBatch.length, medianBatches: judged.length, malformedLines,
    dbClockMissing: perBatch.filter(row => row.dbClockSpanMs === null).length,
    serverMissing: perBatch.filter(row => row.serverMs === null).length,
    medianMs: median(judged.map(row => row.durationMs)),
    medianDbClockSpanMs: median(timed.map(row => row.dbClockSpanMs!)),
    medianOutsideDbClockSpanMs: median(timed.map(row => row.durationMs - row.dbClockSpanMs!)),
    medianServerMs: median(served.map(row => row.serverMs!)),
    medianOutsideServerMs: median(served.map(row => row.durationMs - row.serverMs!)),
    recorderMs: recorder.length ? { median: median(recorder), max: Math.max(...recorder), total: Math.round(recorder.reduce((a, b) => a + b, 0) * 1000) / 1000 } : null,
    perBatch,
  };
}
