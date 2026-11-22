// Host-side seed diagnostic records (#426): macOS disk and memory counters during the seed, and the
// Docker Desktop VM logs and macOS log for the run window, copied before they rotate. All text is redacted.
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { checked, type Executor } from './dms-formal-exec.ts';

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Removes run secrets; credential headers (to the end of the line), Bearer tokens, URI user info and credential
// key=value pairs (also underscored keys such as POSTGRES_PASSWORD); long hex or token-like runs; Docker socket paths;
// and the home path, user name and host name in any letter case.
export function redactHostText(text: string, { secrets = [], home = homedir(), user = userInfo().username, host = hostname() }:
  { secrets?: string[]; home?: string; user?: string; host?: string } = {}) {
  let out = text;
  for (const secret of secrets.filter(value => value.length >= 8)) out = out.replaceAll(secret, '[redacted]');
  out = out.replace(/\b((?:proxy-)?authorization|(?:set-)?cookie|x-api-key)(["']?\s*[=:]\s*)[^\r\n]*/gi, '$1$2[redacted]');
  out = out.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]');
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, '$1[redacted]@');
  out = out.replace(/([A-Za-z0-9_-]*(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_-]*)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;&]+)/gi, '$1$2[redacted]');
  out = out.replace(/(?:unix:\/\/)?\/?[^\s'"]*docker[^\s'"]*\.sock\b/gi, '[docker socket]');
  if (home.length > 1) out = out.replace(new RegExp(escape(home), 'gi'), '~');
  out = out.replace(/\/(Users|home)\/[^/\s'"]+/gi, '/$1/[user]');
  const word = (value: string) => new RegExp(`(?<![A-Za-z0-9])${escape(value)}(?![A-Za-z0-9])`, 'gi');
  if (host.length >= 3) out = out.replace(word(host.replace(/\.local$/i, '')), '[host]');
  if (user.length >= 3) out = out.replace(word(user), '[user]');
  out = out.replace(/\b[a-fA-F0-9]{32,}\b/g, '[hex redacted]');
  return out.replace(/[A-Za-z0-9_-]{40,}/g, '[token redacted]');
}

export type HostSampleCoverage = { attempted: number; iostatFailed: number; vmStatFailed: number; writeFailures: number; commands: number; sampleMs: number; complete: boolean };

// Cumulative counters each second (iostat -I totals since boot, vm_stat page counts): a missed tick loses no
// counts, and each row carries its own wall clock. Ticks run one after another and never overlap.
export function startHostSampler(exec: Executor, path: string, intervalMs = 1_000, now = Date.now) {
  writeFileSync(path, '', { mode: 0o600 });
  const coverage: HostSampleCoverage = { attempted: 0, iostatFailed: 0, vmStatFailed: 0, writeFailures: 0, commands: 0, sampleMs: 0, complete: false };
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, current: Promise<void> = Promise.resolve();
  // A failed command and one that printed nothing are both failed samples (null in the row).
  const read = (program: string, args: string[]) => { coverage.commands++; return checked(exec, { program, args, timeout: 3_000 }).then(out => out || null, () => null); };
  const tick = () => {
    const atMs = now();
    coverage.attempted++;
    current = Promise.all([read('iostat', ['-I']), read('vm_stat', [])])
      .then(([iostat, vmStat]) => {
        if (iostat === null) coverage.iostatFailed++;
        if (vmStat === null) coverage.vmStatFailed++;
        const durationMs = now() - atMs;
        coverage.sampleMs += durationMs;
        appendFileSync(path, JSON.stringify({ atMs, durationMs, iostat, vmStat }) + '\n');
      })
      .catch(() => { coverage.writeFailures++; })
      .finally(() => { if (!stopped) timer = setTimeout(tick, Math.max(0, intervalMs - (now() - atMs))); });
  };
  tick();
  return async (): Promise<HostSampleCoverage> => {
    stopped = true;
    clearTimeout(timer);
    await current;
    coverage.complete = coverage.attempted > 0 && coverage.iostatFailed === 0 && coverage.vmStatFailed === 0 && coverage.writeFailures === 0;
    return { ...coverage };
  };
}

export const dockerVmLogDirectory = (home = homedir()) => join(home, 'Library/Containers/com.docker.docker/Data/log/vm');
export type CopyRecord = { status: 'complete' | 'partial' | 'missing' | 'failed'; files: string[]; skippedOlder: number; truncated: string[]; reason?: string };
const fileLimit = 32 * 1024 * 1024;

// The first ISO-8601 UTC timestamp in a text (Docker VM logs prefix lines with one), or null.
export function firstTimestampMs(text: string) {
  const match = /\b(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d))/.exec(text);
  const ms = match ? Date.parse(match[1]!) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// Copies console.log* and init.log* changed since the run started; a file larger than the limit keeps its last 32 MiB.
// A cut file is complete only if its kept part starts at or before the run start; otherwise the record is partial.
export function copyDockerVmLogs(source: string, destination: string, sinceMs: number, redact: (text: string) => string): CopyRecord {
  let names: string[];
  try { names = readdirSync(source).filter(name => /^(?:console|init)\.log/.test(name)).sort(); }
  catch (error) {
    const absent = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return { status: absent ? 'missing' : 'failed', files: [], skippedOlder: 0, truncated: [], reason: absent ? 'No Docker VM log directory' : 'Docker VM log directory not readable' };
  }
  const record: CopyRecord = { status: 'complete', files: [], skippedOlder: 0, truncated: [] };
  let uncovered = false;
  try {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const name of names) {
      const stat = statSync(join(source, name));
      if (!stat.isFile() || stat.mtimeMs < sinceMs) { record.skippedOlder++; continue; }
      let raw: Buffer;
      if (stat.size > fileLimit) {
        raw = Buffer.alloc(fileLimit);
        const fd = openSync(join(source, name), 'r');
        try { raw = raw.subarray(0, readSync(fd, raw, 0, fileLimit, stat.size - fileLimit)); } finally { closeSync(fd); }
        record.truncated.push(name);
        const firstMs = firstTimestampMs(raw.toString('utf8'));
        if (firstMs === null || firstMs > sinceMs) uncovered = true;
      } else raw = readFileSync(join(source, name));
      writeFileSync(join(destination, name.replace(/[^\w.-]/g, '_')), redact(raw.toString('utf8')), { mode: 0o600 });
      record.files.push(name);
    }
  } catch { return { ...record, status: 'failed', reason: 'Docker VM log copy failed' }; }
  if (record.files.length === 0) return { ...record, status: 'missing', reason: 'No Docker VM log changed during the run' };
  if (uncovered) return { ...record, status: 'partial', reason: 'A cut log does not reach back to the run start' };
  return record;
}

// `log show` takes local wall-clock times.
export function logShowTime(ms: number) {
  const d = new Date(ms), pad = (value: number) => String(value).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Sleep, backup, memory pressure, kernel and Docker/Virtualization events: what the attempt 10 analysis had to rule out.
export const hostLogPredicate = 'process == "kernel" OR process == "powerd" OR process == "backupd" OR process BEGINSWITH "com.docker"'
  + ' OR process CONTAINS "Docker" OR subsystem BEGINSWITH "com.apple.Virtualization" OR eventMessage CONTAINS[c] "memory pressure"'
  + ' OR eventMessage CONTAINS[c] "memorystatus" OR eventMessage CONTAINS[c] "sleep"';

// timeoutMs comes from the runner's deadline budget; skip is set after an interrupt or the deadline, so the
// collection never delays container removal. A skipped log is recorded as failed, with the reason.
export async function saveHostLog(exec: Executor, path: string, startMs: number, endMs: number, redact: (text: string) => string,
  { timeoutMs = 600_000, signal, skip = false }: { timeoutMs?: number; signal?: AbortSignal; skip?: boolean } = {}): Promise<CopyRecord> {
  if (skip) return { status: 'failed', files: [], skippedOlder: 0, truncated: [], reason: 'skipped: run interrupted or deadline reached' };
  const window = [logShowTime(startMs - 60_000), logShowTime(endMs + 60_000)];
  try {
    const raw = await checked(exec, { program: 'log', args: ['show', '--style', 'syslog', '--start', window[0]!, '--end', window[1]!, '--predicate', hostLogPredicate], timeout: timeoutMs, signal });
    writeFileSync(path, redact(raw) + '\n', { mode: 0o600 });
    return { status: 'complete', files: [path.split('/').at(-1)!], skippedOlder: 0, truncated: [] };
  } catch { return { status: 'failed', files: [], skippedOlder: 0, truncated: [], reason: 'log show failed, was interrupted or exceeded the time or output limit' }; }
}
