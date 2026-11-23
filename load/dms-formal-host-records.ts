// Host-side seed diagnostic records (#426): macOS disk and memory counters during the seed and the macOS log for the
// run window (the Docker Desktop VM logs are streamed in dms-formal-log-stream.ts). All text is redacted.
import { appendFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { checked, type Executor } from './dms-formal-exec.ts';

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Removes run secrets; credential headers (to the end of the line), Bearer tokens, URI user info and credential
// key=value pairs (also underscored keys such as POSTGRES_PASSWORD; a quoted value ends at its unescaped closing
// quote, an unterminated or doubly escaped one at the end of the line); long hex or token-like runs; Docker socket
// paths; and the home path, user name and host name in any letter case.
export function redactHostText(text: string, { secrets = [], home = homedir(), user = userInfo().username, host = hostname() }:
  { secrets?: string[]; home?: string; user?: string; host?: string } = {}) {
  let out = text;
  for (const secret of secrets.filter(value => value.length >= 8)) out = out.replaceAll(secret, '[redacted]');
  out = out.replace(/\b((?:proxy-)?authorization|(?:set-)?cookie|x-api-key)(["']?\s*[=:]\s*)[^\r\n]*/gi, '$1$2[redacted]');
  out = out.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]');
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, '$1[redacted]@');
  // The lookbehinds start a key or a socket path only at the start of its word, so the redaction of a 32 MiB log with
  // long words stays linear (about a second), not quadratic, inside the vmLogFileMs budget.
  out = out.replace(/((?<![A-Za-z0-9_-])[A-Za-z0-9_-]*(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_-]*)(\\?["']?\s*[=:]\s*)(\\"[^\r\n]*|"(?:[^"\\\r\n]|\\.)*"?|'(?:[^'\\\r\n]|\\.)*'?|[^\s"',;&]+)/gi, '$1$2[redacted]');
  out = out.replace(/(?<![^\s'"])(?:unix:\/\/)?\/?[^\s'"]*docker[^\s'"]*\.sock\b/gi, '[docker socket]');
  if (home.length > 1) out = out.replace(new RegExp(escape(home), 'gi'), '~');
  out = out.replace(/\/(Users|home)\/[^/\s'"]+/gi, '/$1/[user]');
  const word = (value: string) => new RegExp(`(?<![A-Za-z0-9])${escape(value)}(?![A-Za-z0-9])`, 'gi');
  if (host.length >= 3) out = out.replace(word(host.replace(/\.local$/i, '')), '[host]');
  if (user.length >= 3) out = out.replace(word(user), '[user]');
  out = out.replace(/\b[a-fA-F0-9]{32,}\b/g, '[hex redacted]');
  return out.replace(/[A-Za-z0-9_-]{40,}/g, '[token redacted]');
}

export const hostCommandTimeoutMs = 3_000;
export type HostSampleCoverage = { attempted: number; iostatFailed: number; vmStatFailed: number; writeFailures: number; commands: number; sampleMs: number; complete: boolean };

// Cumulative counters each second (iostat -I totals since boot, vm_stat page counts): a missed tick loses no
// counts, and each row carries its own wall clock. Ticks run one after another and never overlap.
export function startHostSampler(exec: Executor, path: string, intervalMs = 1_000, now = Date.now) {
  writeFileSync(path, '', { mode: 0o600 });
  const coverage: HostSampleCoverage = { attempted: 0, iostatFailed: 0, vmStatFailed: 0, writeFailures: 0, commands: 0, sampleMs: 0, complete: false };
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, current: Promise<void> = Promise.resolve();
  // A failed command and one that printed nothing are both failed samples (null in the row).
  const read = (program: string, args: string[]) => { coverage.commands++; return checked(exec, { program, args, timeout: hostCommandTimeoutMs }).then(out => out || null, () => null); };
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

// The first ISO-8601 UTC timestamp in a text (Docker VM logs prefix lines with one), or null.
export function firstTimestampMs(text: string) {
  const match = /\b(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d))/.exec(text);
  const ms = match ? Date.parse(match[1]!) : NaN;
  return Number.isFinite(ms) ? ms : null;
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
