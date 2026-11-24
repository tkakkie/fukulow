import { join } from 'node:path';
import { requirementViolations, type HostRecord } from '../harness-core/host-record.ts';
import { tctl } from '../harness-core/thermal.ts';
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
  // Calls fn every ms until the returned stop is called.
  every(ms: number, fn: () => void): () => void;
  onSignal(handler: (signal: string) => void): void;
};
export type Result = { outcome: 'done' | 'stop'; reason?: string; jobs: { name: string; exit: number | null }[] };

// Processes that make a host busy (same list as the hand-written waiters).
export const workerPattern = /codex exec|agy -p|cargo (test|build|nextest|check|clippy)|playwright|vitest|k6 run|node load\//;
export const maxLoad15 = 3;
export const pollMs = 60_000;
export const coolPollMs = 15_000;
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
  const ps = d.exec(['ps', '-Ao', 'pid=,command=']);
  const busy = ps.status === 0 ? workers(ps.stdout, d.pid) : ['ps failed'];
  if (busy.length > 0) r.push(`workers running: ${busy.slice(0, 3).join(' | ')}`);
  r.push(...d.platform.violations(record));
  r.push(...requirementViolations(record, job.requireHost));
  if (job.thermalSampleSeconds !== undefined && d.platform.thermal(d.now()) === null) r.push('no thermal readings on this platform');
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
  const endLogs = () => { const s = stopLogs; stopLogs = null; try { s?.(); } catch (e) { log(`log capture stop failed: ${String(e)}`); } };
  const release = () => {
    try { endLogs(); } finally {
      if (claimed) { d.remove(q.hostBusy); claimed = false; log('HOST-BUSY released'); }
    }
  };
  // A signal kills the running gate or job; HOST-BUSY is released only after it has exited (finally).
  d.onSignal(signal => { signalled = signal; log(`STOP: ${signal}`); child?.kill(); });
  const run = async (argv: string[], file: string, job: Job) => {
    child = d.spawn(argv, { cwd: job.worktree, log: join(q.chainDir, file), env: job.env });
    try { return await child.done; } finally { child = null; }
  };
  const stop = (reason: string): Result => { log(`STOP: ${reason}`); return { outcome: 'stop', reason, jobs }; };
  // #796 L5: wait until Tctl is at most maxTctlC; past maxWaitSeconds, or unreadable, is a STOP.
  // Every reading is kept in <job>-cooldown.json.
  const coolDown = async (job: Job, c: NonNullable<Job['cooldown']>) => {
    const start = d.now().getTime();
    const readings: { at: string; tctlC: number | null }[] = [];
    for (;;) {
      const at = d.now();
      const t = tctl(d.platform.thermal(at));
      readings.push({ at: at.toISOString(), tctlC: t });
      const waited = (at.getTime() - start) / 1000;
      const problem = signalled ? `${signalled} while cooling down` : t === null ? 'Tctl unreadable' : t <= c.maxTctlC ? null
        : waited >= c.maxWaitSeconds ? `Tctl ${t} °C > ${c.maxTctlC} °C after ${waited} s` : undefined;
      if (problem !== undefined) {
        d.write(join(q.chainDir, `${job.name}-cooldown.json`), JSON.stringify({ ...c, waitedSeconds: waited, ok: problem === null, problem, readings }, null, 2) + '\n');
        if (problem === null) log(`${job.name}: cool-down done, Tctl ${t} °C after ${waited} s`);
        return problem;
      }
      await d.sleep(Math.min(coolPollMs, c.maxWaitSeconds * 1000 - (at.getTime() - start)));
    }
  };
  // One sample at start, then every thermalSampleSeconds, into <job>-thermal.jsonl. A failed read is
  // kept as an error line, so a gap is visible instead of silently missing.
  const sampleThermal = (job: Job, seconds: number) => {
    const file = join(q.chainDir, `${job.name}-thermal.jsonl`);
    const take = () => {
      const at = d.now();
      let line: unknown;
      try { line = d.platform.thermal(at) ?? { at: at.toISOString(), error: 'no thermal readings' }; } catch (e) { line = { at: at.toISOString(), error: String(e) }; }
      d.append(file, JSON.stringify(line) + '\n');
    };
    take();
    return d.every(seconds * 1000, take);
  };
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
      if (job.cooldown) {
        const problem = await coolDown(job, job.cooldown);
        if (problem !== null) return stop(`${job.name} cool-down: ${problem}; job not started`);
      }
      const before = d.platform.record(q.chainDir);
      d.write(join(q.chainDir, `${job.name}-host-before.json`), JSON.stringify(before, null, 2) + '\n');
      const problems = preflight(d, q, job, before);
      if (problems.length > 0) return stop(`${job.name} preflight: ${problems.join('; ')}`);
      if (job.gate) {
        const gate = await run(job.gate, `${job.name}-gate.log`, job);
        log(`${job.name} gate: exit=${gate}`);
        if (signalled) return stop(`${signalled} during the gate; ${job.name} not started`);
        if (gate !== 0) return stop(`${job.name} gate did not pass; job not started`);
      }
      if (job.postgresLogLabel) stopLogs = d.captureLogs(job.postgresLogLabel, join(q.chainDir, `${job.name}-postgres.log`));
      log(`${job.name}: start (once, no rerun)`);
      const stopSampling = job.thermalSampleSeconds === undefined ? null : sampleThermal(job, job.thermalSampleSeconds);
      let exit: number;
      try { exit = await run(d.platform.inhibit(job.command), `${job.name}.log`, job); } finally { stopSampling?.(); }
      endLogs();
      jobs.push({ name: job.name, exit });
      d.write(join(q.chainDir, `${job.name}-host-after.json`), JSON.stringify(d.platform.record(q.chainDir), null, 2) + '\n');
      const left = d.exec(['docker', 'ps', '-q']).stdout.trim().split('\n').filter(Boolean).length;
      log(`${job.name}: exit=${exit}; containers left: ${left}`);
      if (signalled) return stop(`${signalled} during ${job.name}; the queue ends (no rerun)`);
      if (exit !== 0) return stop(`${job.name} exited ${exit}; the queue ends (no rerun)`);
    }
    log('queue done');
    return { outcome: 'done', jobs };
  } finally {
    release();
  }
}
