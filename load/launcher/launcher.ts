import { join } from 'node:path';
import type { HostRecord } from '../harness-core/host-record.ts';
import type { Platform } from './platform.ts';
import type { Job, Queue } from './queue.ts';

// One measurement launcher for macOS and Linux (#867). It does the shared steps of every hand-written
// waiter once: wait for an idle host, claim HOST-BUSY and always release it, preflight, the job's
// gate, PostgreSQL log capture, one launch per job and one chain log. Nothing reruns; a STOP or a
// failed job ends the queue. Criteria, gates and margins stay in each harness.

export type Child = { done: Promise<number>; kill(): void };
export type Deps = {
  platform: Platform;
  // Synchronous command for checks; status null means it could not run.
  exec(argv: string[], cwd?: string): { status: number | null; stdout: string };
  spawn(argv: string[], opts: { cwd: string; log: string; env?: Record<string, string> }): Child;
  // Follows the logs of containers with this label into the file until the returned stop is called.
  captureLogs(label: string, file: string): () => void;
  exists(path: string): boolean;
  // Creates the file only if it does not exist (O_EXCL); false when it already exists.
  claim(path: string, text: string): boolean;
  remove(path: string): void;
  append(path: string, text: string): void;
  write(path: string, text: string): void;
  freeBytes(path: string): number | null;
  dockerFreeBytes(image: string): number | null;
  nodeVersion: string;
  pid: number;
  now(): Date;
  sleep(ms: number): Promise<void>;
  onSignal(handler: (signal: string) => void): void;
};
export type Result = { outcome: 'done' | 'stop'; reason?: string; jobs: { name: string; exit: number | null }[] };

// Processes that make a host busy (same list as the hand-written waiters).
export const workerPattern = /codex exec|agy -p|cargo (test|build|nextest|check|clippy)|playwright|vitest|k6 run|node load\//;
export const maxLoad15 = 3;
export const pollMs = 60_000;
const GiB = 1024 ** 3;

export function workers(ps: string, self: number): string[] {
  return ps.split('\n').map(l => l.trim()).filter(Boolean).filter(l => {
    const [pid, ...cmd] = l.split(/\s+/);
    return Number(pid) !== self && !cmd.join(' ').includes('load/launch.ts') && workerPattern.test(cmd.join(' '));
  });
}

export function busyReasons(d: Deps, busyPath: string): string[] {
  const r: string[] = [];
  if (d.exists(busyPath)) r.push(`HOST-BUSY held: ${busyPath}`);
  const containers = d.exec(['docker', 'ps', '-q']);
  if (containers.status !== 0) r.push('docker ps failed');
  else if (containers.stdout.trim() !== '') r.push('containers running');
  const ps = d.exec(['ps', '-Ao', 'pid=,command=']);
  if (ps.status !== 0) r.push('ps failed');
  else if (workers(ps.stdout, d.pid).length > 0) r.push(`workers running: ${workers(ps.stdout, d.pid).slice(0, 3).join(' | ')}`);
  const load = d.platform.load15();
  if (!(load < maxLoad15)) r.push(`load15 ${load.toFixed(2)} >= ${maxLoad15}`);
  return r;
}

export function preflight(d: Deps, q: Queue, job: Job, record: HostRecord): string[] {
  const r: string[] = [];
  if (d.exists(job.out)) r.push(`output exists: ${job.out}`);
  const head = d.exec(['git', 'rev-parse', 'HEAD'], job.worktree);
  if (head.status !== 0 || !head.stdout.trim().startsWith(job.commit)) r.push(`${job.worktree} is not at ${job.commit}`);
  const dirty = d.exec(['git', 'status', '--porcelain'], job.worktree);
  if (dirty.status !== 0 || dirty.stdout.trim() !== '') r.push(`${job.worktree} is dirty`);
  const pinned = d.exec(['cat', '.node-version'], job.worktree);
  if (pinned.status !== 0 || `v${pinned.stdout.trim()}` !== d.nodeVersion) r.push(`node ${d.nodeVersion} is not the pinned ${pinned.stdout.trim() || '(unreadable)'}`);
  const containers = d.exec(['docker', 'ps', '-q']);
  if (containers.status !== 0 || containers.stdout.trim() !== '') r.push('containers running or docker unavailable');
  r.push(...d.platform.violations(record));
  const min = (job.minFreeGiB ?? 40) * GiB;
  const host = d.freeBytes(q.chainDir);
  if (host === null || host < min) r.push(`host free ${host === null ? 'unreadable' : (host / GiB).toFixed(1) + ' GiB'} < ${job.minFreeGiB ?? 40} GiB`);
  if (job.image) {
    const vm = d.dockerFreeBytes(job.image);
    if (vm === null || vm < min) r.push(`Docker free ${vm === null ? 'unreadable' : (vm / GiB).toFixed(1) + ' GiB'} < ${job.minFreeGiB ?? 40} GiB`);
  }
  return r;
}

export async function launch(q: Queue, d: Deps): Promise<Result> {
  const chainLog = join(q.chainDir, 'chain.log');
  const log = (line: string) => d.append(chainLog, `${d.now().toISOString()} ${line}\n`);
  const jobs: Result['jobs'] = [];
  let claimed = false;
  let child: Child | null = null;
  let stopLogs: (() => void) | null = null;
  let signalled: string | null = null;
  const release = () => {
    stopLogs?.(); stopLogs = null;
    if (claimed) { d.remove(q.hostBusy); claimed = false; log('HOST-BUSY released'); }
  };
  d.onSignal(signal => { signalled = signal; log(`STOP: ${signal}`); child?.kill(); release(); });
  const stop = (reason: string): Result => { log(`STOP: ${reason}`); return { outcome: 'stop', reason, jobs }; };
  try {
    log(`queue ${q.name}: ${q.jobs.map(j => `${j.name} (#${j.issue})`).join(', ')}; waiting for an idle host`);
    for (;;) {
      if (signalled) return stop(`${signalled} while waiting`);
      if (busyReasons(d, q.hostBusy).length === 0 && d.claim(q.hostBusy, `${q.name}: ${q.jobs.map(j => j.name).join(', ')} ${d.now().toISOString()}\n`)) break;
      await d.sleep(pollMs);
    }
    claimed = true;
    log('HOST-BUSY claimed');
    for (const job of q.jobs) {
      if (signalled) return stop(`${signalled}; ${job.name} not started`);
      log(`${job.name}: go "${job.go.quote}" (${job.go.date})`);
      const before = d.platform.record(q.chainDir);
      d.write(join(q.chainDir, `${job.name}-host-before.json`), JSON.stringify(before, null, 2) + '\n');
      const problems = preflight(d, q, job, before);
      if (problems.length > 0) return stop(`${job.name} preflight: ${problems.join('; ')}`);
      if (job.gate) {
        const gate = await d.spawn(job.gate, { cwd: job.worktree, log: join(q.chainDir, `${job.name}-gate.log`), env: job.env }).done;
        log(`${job.name} gate: exit=${gate}`);
        if (gate !== 0) return stop(`${job.name} gate did not pass; job not started`);
      }
      if (job.postgresLogLabel) stopLogs = d.captureLogs(job.postgresLogLabel, join(q.chainDir, `${job.name}-postgres.log`));
      log(`${job.name}: start (once, no rerun)`);
      child = d.spawn(d.platform.inhibit(job.command), { cwd: job.worktree, log: join(q.chainDir, `${job.name}.log`), env: job.env });
      const exit = await child.done;
      child = null;
      stopLogs?.(); stopLogs = null;
      jobs.push({ name: job.name, exit });
      d.write(join(q.chainDir, `${job.name}-host-after.json`), JSON.stringify(d.platform.record(q.chainDir), null, 2) + '\n');
      const left = d.exec(['docker', 'ps', '-q']).stdout.trim().split('\n').filter(Boolean).length;
      log(`${job.name}: exit=${exit}; containers left: ${left}`);
      if (exit !== 0) return stop(`${job.name} exited ${exit}; the queue ends (no rerun)`);
    }
    log('queue done');
    return { outcome: 'done', jobs };
  } finally {
    release();
  }
}
