// Host-side seed diagnostic records (#426): macOS disk and memory counters during the seed, and the
// Docker Desktop VM logs and macOS log for the run window, copied before they rotate. All text is redacted.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { checked, type Executor } from './dms-formal-exec.ts';

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Removes run secrets, credentials in key=value or Bearer form, long hex or token-like runs, and the user's home path and name.
export function redactHostText(text: string, { secrets = [], home = homedir(), user = userInfo().username }: { secrets?: string[]; home?: string; user?: string } = {}) {
  let out = text;
  for (const secret of secrets.filter(value => value.length >= 8)) out = out.replaceAll(secret, '[redacted]');
  if (home.length > 1) out = out.replaceAll(home, '~');
  out = out.replace(/\/Users\/[^/\s]+/g, '/Users/[user]');
  if (user.length >= 3) out = out.replace(new RegExp(`\\b${escape(user)}\\b`, 'g'), '[user]');
  out = out.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]');
  out = out.replace(/\b(password|passwd|pwd|token|secret|api[_-]?key|authorization|cookie|credentials?)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2[redacted]');
  out = out.replace(/\b[a-fA-F0-9]{32,}\b/g, '[hex redacted]');
  return out.replace(/[A-Za-z0-9_-]{40,}/g, '[token redacted]');
}

export type HostSampleCoverage = { attempted: number; iostatMissing: number; vmStatMissing: number; writeFailures: number; commands: number; sampleMs: number; complete: boolean };

// Cumulative counters each second (iostat -I totals since boot, vm_stat page counts): a missed tick loses no
// counts, and each row carries its own wall clock. Ticks run one after another and never overlap.
export function startHostSampler(exec: Executor, path: string, intervalMs = 1_000, now = Date.now) {
  writeFileSync(path, '', { mode: 0o600 });
  const coverage: HostSampleCoverage = { attempted: 0, iostatMissing: 0, vmStatMissing: 0, writeFailures: 0, commands: 0, sampleMs: 0, complete: false };
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, current: Promise<void> = Promise.resolve();
  const read = (program: string, args: string[]) => { coverage.commands++; return checked(exec, { program, args, timeout: 3_000 }).catch(() => null); };
  const tick = () => {
    const atMs = now();
    coverage.attempted++;
    current = Promise.all([read('iostat', ['-I']), read('vm_stat', [])])
      .then(([iostat, vmStat]) => {
        if (iostat === null) coverage.iostatMissing++;
        if (vmStat === null) coverage.vmStatMissing++;
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
    coverage.complete = coverage.attempted > 0 && coverage.iostatMissing === 0 && coverage.vmStatMissing === 0 && coverage.writeFailures === 0;
    return { ...coverage };
  };
}

export const dockerVmLogDirectory = (home = homedir()) => join(home, 'Library/Containers/com.docker.docker/Data/log/vm');
export type CopyRecord = { status: 'complete' | 'missing' | 'failed'; files: string[]; skippedOlder: number; truncated: string[]; reason?: string };
const fileLimit = 32 * 1024 * 1024;

// Copies console.log* and init.log* changed since the run started; a file larger than the limit keeps its last 32 MiB.
export function copyDockerVmLogs(source: string, destination: string, sinceMs: number, redact: (text: string) => string): CopyRecord {
  let names: string[];
  try { names = readdirSync(source).filter(name => /^(?:console|init)\.log/.test(name)).sort(); }
  catch { return { status: 'missing', files: [], skippedOlder: 0, truncated: [], reason: 'Docker VM log directory not readable' }; }
  const record: CopyRecord = { status: 'complete', files: [], skippedOlder: 0, truncated: [] };
  try {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const name of names) {
      const stat = statSync(join(source, name));
      if (!stat.isFile() || stat.mtimeMs < sinceMs) { record.skippedOlder++; continue; }
      let raw = readFileSync(join(source, name));
      if (raw.length > fileLimit) { raw = raw.subarray(raw.length - fileLimit); record.truncated.push(name); }
      writeFileSync(join(destination, name.replace(/[^\w.-]/g, '_')), redact(raw.toString('utf8')), { mode: 0o600 });
      record.files.push(name);
    }
  } catch { return { ...record, status: 'failed', reason: 'Docker VM log copy failed' }; }
  if (record.files.length === 0) return { ...record, status: 'missing', reason: 'No Docker VM log changed during the run' };
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

export async function saveHostLog(exec: Executor, path: string, startMs: number, endMs: number, redact: (text: string) => string): Promise<CopyRecord> {
  const window = [logShowTime(startMs - 60_000), logShowTime(endMs + 60_000)];
  try {
    const raw = await checked(exec, { program: 'log', args: ['show', '--style', 'syslog', '--start', window[0]!, '--end', window[1]!, '--predicate', hostLogPredicate], timeout: 600_000 });
    writeFileSync(path, redact(raw) + '\n', { mode: 0o600 });
    return { status: 'complete', files: [path.split('/').at(-1)!], skippedOlder: 0, truncated: [] };
  } catch { return { status: 'failed', files: [], skippedOlder: 0, truncated: [], reason: 'log show failed or exceeded the output limit' }; }
}
