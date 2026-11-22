// Host-side seed diagnostic records (#426): macOS disk and memory counters during the seed, and the
// Docker Desktop VM logs and macOS log for the run window, copied before they rotate. All text is redacted.
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
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
const fileLimit = 32 * 1024 * 1024;

// The first ISO-8601 UTC timestamp in a text (Docker VM logs prefix lines with one), or null.
export function firstTimestampMs(text: string) {
  const match = /\b(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d))/.exec(text);
  const ms = match ? Date.parse(match[1]!) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// A rotation renames console.log to console.log.0 (or .1), .0 to .1 and so on, and the next entry starts the new
// file, so a file's first entry follows the older file's last write closely. A longer gap is treated as lost entries.
export const rotationGapMs = 60_000;
// Time kept free per VM log file (read, redact and write of at most 32 MiB took about 1.3 s on the developer Mac).
export const vmLogFileMs = 5_000;
type RotatedFile = { suffix: number | null; mtimeMs: number; copied: boolean; firstMs: number | null; cut: boolean };

// The last limit bytes of a file, starting at a line boundary: the partial first line is dropped, so a cut can never
// leave a credential value without the key that the redaction matches.
function tail(path: string, size: number, limit: number) {
  const raw = Buffer.alloc(limit), fd = openSync(path, 'r');
  let read: number;
  try { read = readSync(fd, raw, 0, limit, size - limit); } finally { closeSync(fd); }
  const newline = raw.subarray(0, read).indexOf(0x0a);
  return newline < 0 ? '' : raw.subarray(newline + 1, read).toString('utf8');
}

// One set (console or init), newest first. It covers the run if its files form an unbroken rotation chain back to the
// run start: contiguous numbering (live file, then .0 or .1, then each next number), each newer file's first entry
// within rotationGapMs of the older file's last write, ending at a copied entry at or before the start or at a file
// last written before it. A cut file must itself reach back to the start: its cut-off head was not kept.
function setCovers(files: RotatedFile[], sinceMs: number) {
  if (files.some(file => Number.isNaN(file.suffix))) return false;
  const chain = [...files].sort((a, b) => (a.suffix ?? -1) - (b.suffix ?? -1));
  for (let i = 0; i < chain.length; i++) {
    const file = chain[i]!, newer = chain[i - 1];
    if (i === 0 ? file.suffix !== null : i === 1 ? file.suffix! > 1 : file.suffix !== newer!.suffix! + 1) return false;
    if (newer && (newer.firstMs === null || newer.firstMs - file.mtimeMs > rotationGapMs)) return false;
    if (!file.copied) return i > 0;
    if (file.cut && (file.firstMs === null || file.firstMs > sinceMs)) return false;
    if (file.firstMs !== null && file.firstMs <= sinceMs) return true;
  }
  return false;
}

// Copies console.log* and init.log* changed since the run started; a file larger than the limit keeps its last 32 MiB
// from a line boundary, and it is redacted after the cut. Each copied set must cover the run (setCovers); otherwise the
// record is partial. untilMs bounds the copy (the cleanup allowances after an interrupt or the deadline): a file is
// started only with vmLogFileMs left, and a copy cut short is failed.
export function copyDockerVmLogs(source: string, destination: string, sinceMs: number, redact: (text: string) => string,
  { untilMs = Infinity }: { untilMs?: number } = {}): CopyRecord {
  let names: string[];
  try { names = readdirSync(source).filter(name => /^(?:console|init)\.log/.test(name)).sort(); }
  catch (error) {
    const absent = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return { status: absent ? 'missing' : 'failed', files: [], skippedOlder: 0, truncated: [], reason: absent ? 'No Docker VM log directory' : 'Docker VM log directory not readable' };
  }
  const record: CopyRecord = { status: 'complete', files: [], skippedOlder: 0, truncated: [] };
  const sets = new Map<string, RotatedFile[]>();
  try {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const name of names) {
      const path = join(source, name), stat = statSync(path);
      if (!stat.isFile()) { record.skippedOlder++; continue; }
      const match = /^(?:console|init)\.log(?:\.(\d+))?$/.exec(name);
      const file: RotatedFile = { suffix: !match ? NaN : match[1] === undefined ? null : Number(match[1]), mtimeMs: stat.mtimeMs, copied: false, firstMs: null, cut: false };
      const key = name.replace(/\.log.*$/, '');
      sets.set(key, [...sets.get(key) ?? [], file]);
      if (stat.mtimeMs < sinceMs) { record.skippedOlder++; continue; }
      if (Date.now() + vmLogFileMs > untilMs) return { ...record, status: 'failed', reason: 'Docker VM log copy cut short: no time left before cleanup' };
      file.cut = stat.size > fileLimit;
      const text = file.cut ? tail(path, stat.size, fileLimit) : readFileSync(path, 'utf8');
      if (file.cut) record.truncated.push(name);
      file.firstMs = firstTimestampMs(text);
      file.copied = true;
      writeFileSync(join(destination, name.replace(/[^\w.-]/g, '_')), redact(text), { mode: 0o600 });
      record.files.push(name);
    }
  } catch { return { ...record, status: 'failed', reason: 'Docker VM log copy failed' }; }
  if (record.files.length === 0) return { ...record, status: 'missing', reason: 'No Docker VM log changed during the run' };
  const uncovered = [...sets].filter(([, files]) => files.some(file => file.copied) && !setCovers(files, sinceMs)).map(([key]) => key);
  if (uncovered.length) return { ...record, status: 'partial', reason: `No unbroken ${uncovered.join(' and ')} log rotation chain reaches back to the run start` };
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
