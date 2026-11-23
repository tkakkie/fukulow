import { writeFileSync } from 'node:fs';
import { checked, type Executor } from './dms-formal-exec.ts';

export function postgresCommand(seedDiagnostic = false) {
  const formal = ['postgres','-c','shared_preload_libraries=pg_stat_statements','-c','pg_stat_statements.track=all','-c','max_connections=64'];
  return seedDiagnostic ? [...formal, ...[
    'log_checkpoints=on', 'log_autovacuum_min_duration=0', 'track_io_timing=on',
    'track_wal_io_timing=on', 'log_lock_waits=on', 'log_temp_files=0',
  ].flatMap(setting => ['-c', setting])] : formal;
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
// Retain only server-generated event lines with known formats. The redactor is line by line (it keeps only whether the
// last entry was an autovacuum header), so a streamed log of any size is redacted with bounded memory.
export function dbLogLineRedactor() {
  const prefix = /^(\S+ \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ [A-Z]+ \[\d+\] (?:LOG|ERROR|FATAL|PANIC): +)(.*)$/;
  // Autovacuum and autoanalyze statistics follow their header on tab-indented lines; keep only strict numeric forms.
  const stats = /^\S+ \t(?:system usage: CPU: user: \d+\.\d+ s, system: \d+\.\d+ s, elapsed: \d+\.\d+ s|avg read rate: \d+\.\d+ MB\/s, avg write rate: \d+\.\d+ MB\/s|buffer usage: \d+ hits, \d+ reads, \d+ dirtied|WAL usage: \d+ records, \d+ full page images, \d+ bytes(?:, \d+ buffers full)?)$/;
  let inAutovacuum = false;
  return (line: string): string | null => {
    if (stats.test(line)) return inAutovacuum ? line : null;
    const match = prefix.exec(line);
    // Other continuation lines (pages, tuples) do not end the autovacuum entry; only a new log entry does.
    if (!match) return null;
    inAutovacuum = false;
    if (/^automatic (?:aggressive )?(?:vacuum|analyze) of table /.test(match[2])) inAutovacuum = true;
    const [, header, message] = match;
    if (/^checkpoints are occurring too frequently \(\d+ seconds? apart\)$/.test(message)) return line;
    // log_duration lines (diagnostic batch sessions only) carry no statement text.
    if (/^duration: \d+(?:\.\d+)? ms$/.test(message)) return line;
    if (/^(checkpoint (?:starting|complete):|automatic (?:aggressive )?(?:vacuum|analyze) of table "[\w.]+":|temporary file: path "base\/pgsql_tmp\/pgsql_tmp[\d.]+", size \d+$)/.test(message)) return line;
    const lock = /^(process \d+ (?:still waiting for|acquired) \w+Lock) on .+ (after \d+(?:\.\d+)? ms)$/.exec(message);
    if (lock) return header + lock[1] + ' ' + lock[2];
    if (/(?:ERROR|FATAL|PANIC):\s+$/.test(header)) return header + '[detail redacted]';
    return null;
  };
}

export function redactSeedDbLogs(raw: string) {
  const redact = dbLogLineRedactor();
  return raw.split('\n').flatMap(line => { const kept = redact(line); return kept === null ? [] : [kept]; }).join('\n');
}

// Server-reported statement durations (log_duration) by backend PID, at the PostgreSQL log time (%m, UTC, whole
// milliseconds, written when the statement ends). Lines in another time zone are not read, so they count as missing.
export function serverDurations(dbLog: string) {
  const byPid = new Map<number, { atMs: number; ms: number }[]>();
  for (const line of dbLog.split('\n')) {
    const match = /^\S+ (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d+) (?:UTC|GMT) \[(\d+)\] LOG: +duration: (\d+(?:\.\d+)?) ms$/.exec(line);
    if (!match) continue;
    const atMs = Date.parse(`${match[1]}T${match[2]}Z`), pid = Number(match[3]);
    if (!Number.isFinite(atMs)) continue;
    byPid.set(pid, [...byPid.get(pid) ?? [], { atMs, ms: Number(match[4]) }]);
  }
  return byPid;
}

// Duration lines one diagnostic batch session logs inside its clock window: the start clock query, the Message INSERT
// and the three Channel log statements (PREPARE, EXECUTE, DEALLOCATE) always; the SET before the start clock and the
// end clock query only when their whole-millisecond log time falls on a window edge. The seed test checks the count
// against the batch SQL.
export const batchServerStatements = { min: 5, max: 7 } as const;

// The server-reported time of one batch: the summed durations of its session's statements logged between the two
// clock rows. Client time between statements is not in it. With fewer or more duration lines than the batch's
// statements (a line lost, or a line of another session), serverMs is null: the time is not the batch's.
export function batchServerMs(durations: ReturnType<typeof serverDurations>, pid: number, startMs: number, endMs: number) {
  const lines = (durations.get(pid) ?? []).filter(row => row.atMs >= Math.floor(startMs) && row.atMs <= endMs + 1);
  if (!lines.length) return null;
  const complete = lines.length >= batchServerStatements.min && lines.length <= batchServerStatements.max;
  return { serverMs: complete ? Math.round(lines.reduce((sum, row) => sum + row.ms, 0) * 1000) / 1000 : null, serverStatements: lines.length };
}

export async function saveSeedDbLogs(exec: Executor, container: string, path: string, timeoutMs = 30_000) {
  // docker logs emits PostgreSQL's stderr on the CLI's stderr even on success.
  const raw = await checked(exec, { program: 'sh', args: ['-c','exec docker logs --timestamps "$1" 2>&1','db-logs',container], timeout: timeoutMs });
  writeFileSync(path, redactSeedDbLogs(raw) + '\n', { mode: 0o600 });
}
