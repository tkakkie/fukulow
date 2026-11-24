import { join } from 'node:path';
import { requirementViolations, type HostRecord } from '../harness-core/host-record.ts';
import { tctl } from '../harness-core/thermal.ts';
import type { Platform } from './platform.ts';
import type { Job, Queue } from './queue.ts';

// One measurement launcher for macOS and Linux (#867). It does the shared steps of every hand-written
// waiter once: wait for an idle host, claim HOST-BUSY and always release it, preflight, the job's
// gate, PostgreSQL log capture, one launch per job and one chain log. Nothing reruns; a STOP or a
// failed job ends the queue. Criteria, gates and margins stay in each harness.

// kill and alive act on the child's whole process group, so tools it started are covered too.
export type Child = { done: Promise<number>; kill(signal?: 'SIGTERM' | 'SIGKILL'): void; alive(): boolean };
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
  // Ends early on a signal (waits that a signal should cut short).
  sleep(ms: number): Promise<void>;
  // Never cut short: the waits while confirming that a stopped job's workload has ended.
  pause(ms: number): Promise<void>;
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
// Stopping a job's process group: SIGTERM, then SIGKILL, each followed by a bounded wait.
export const termGraceMs = 30_000;
export const killGraceMs = 10_000;
export const settlePollMs = 500;
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
  if (job.thermalSampleSeconds !== undefined) r.push(...samplerProblems(d));
  const min = (job.minFreeGiB ?? 40) * GiB;
  const host = d.freeBytes(q.chainDir);
  if (host === null || host < min) r.push(`host free ${host === null ? 'unreadable' : (host / GiB).toFixed(1) + ' GiB'} < ${job.minFreeGiB ?? 40} GiB`);
  if (job.image) {
    const vm = d.dockerFreeBytes(job.image);
    if (vm === null || vm < min) r.push(`Docker free ${vm === null ? 'unreadable' : (vm / GiB).toFixed(1) + ' GiB'} < ${job.minFreeGiB ?? 40} GiB`);
  }
  return r;
}

// The sampler must work before the job starts: a failed read, or any CPU without a measured
// frequency, is a STOP (the CPU sets are subsets of all CPUs).
export function samplerProblems(d: Deps): string[] {
  let s;
  try { s = d.platform.thermal(d.now()); } catch (e) { return [`thermal sample failed: ${String(e)}`]; }
  if (s === null) return ['no thermal readings on this platform'];
  const unreadable = s.avgFreqKHz.flatMap((f, cpu) => (f === null ? [cpu] : []));
  if (s.avgFreqKHz.length === 0) return ['no CPU frequencies in the thermal sample'];
  return unreadable.length > 0 ? [`CPU frequency unreadable on CPU ${unreadable.join(',')}`] : [];
}

export type Session = {
  queue: string; outcome: Result['outcome'] | 'error'; reason?: string; jobs: (Result['jobs'][number] & { confirmations?: Job['confirmations'] })[];
  hostBusy: 'released' | 'kept' | 'never claimed'; workloadProblems: string[]; finished: string;
};

export async function launch(q: Queue, d: Deps): Promise<Result> {
  const chainLog = join(q.chainDir, 'chain.log');
  const log = (line: string) => d.append(chainLog, `${d.now().toISOString()} ${line}\n`);
  // For callbacks and cleanup: a failed chain-log write must never skip a kill or a release.
  const note = (line: string) => { try { log(line); } catch { /* the session record still carries the outcome */ } };
  const jobs: Result['jobs'] = [];
  let claimed = false;
  let child: Child | null = null;
  const started: { child: Child; job: Job }[] = [];
  let stopLogs: (() => void) | null = null;
  let aborted: string | null = null;
  const endLogs = () => { const s = stopLogs; stopLogs = null; try { s?.(); } catch (e) { note(`log capture stop failed: ${String(e)}`); } };
  // The one stop path for a signal, a failed sampler write or any other fault outside the main flow:
  // kill the running gate or job first, then log. HOST-BUSY is released only after the main flow ends
  // and the workload is confirmed stopped (release).
  const abort = (reason: string) => {
    aborted ??= reason;
    try { child?.kill('SIGTERM'); } catch (e) { note(`kill failed: ${String(e)}`); }
    note(`STOP: ${reason}`);
  };
  d.onSignal(signal => abort(signal));
  const run = async (argv: string[], file: string, job: Job) => {
    child = d.spawn(argv, { cwd: job.worktree, log: join(q.chainDir, file), env: job.env });
    started.push({ child, job });
    if (aborted) child.kill('SIGTERM');
    try { return await child.done; } finally { child = null; }
  };
  const stop = (reason: string): Result => { log(`STOP: ${reason}`); return { outcome: 'stop', reason, jobs }; };
  const gone = async (c: Child, ms: number) => {
    for (let waited = 0; c.alive(); waited += settlePollMs) {
      if (waited >= ms) return false;
      await d.pause(settlePollMs);
    }
    return true;
  };
  // Every process group the launcher started has ended, and no container with a job's workload
  // label is running. Anything unconfirmed keeps HOST-BUSY held.
  const stopWorkload = async () => {
    const problems: string[] = [];
    for (const { child: c, job } of started) {
      try {
        if (await gone(c, 0)) continue;
        c.kill('SIGTERM');
        if (await gone(c, termGraceMs)) continue;
        c.kill('SIGKILL');
        if (!(await gone(c, killGraceMs))) problems.push(`${job.name}: process group still running after SIGKILL`);
      } catch (e) { problems.push(`${job.name}: process group check failed: ${String(e)}`); }
    }
    for (const label of new Set(started.flatMap(s => (s.job.workloadLabel ? [s.job.workloadLabel] : [])))) {
      const ps = () => d.exec(['docker', 'ps', '-q', '--filter', `label=${label}`]);
      let ids = ps();
      if (ids.status === 0 && ids.stdout.trim() !== '') {
        note(`containers with label ${label} still running; removing them`);
        d.exec(['docker', 'rm', '-f', ...ids.stdout.trim().split('\n')]);
        ids = ps();
      }
      if (ids.status !== 0) problems.push(`docker ps for label ${label} failed`);
      else if (ids.stdout.trim() !== '') problems.push(`containers with label ${label} still running`);
    }
    return problems;
  };
  const release = async (): Promise<{ hostBusy: Session['hostBusy']; problems: string[] }> => {
    endLogs();
    if (!claimed) return { hostBusy: 'never claimed', problems: [] };
    let problems: string[];
    try { problems = await stopWorkload(); } catch (e) { problems = [`workload check failed: ${String(e)}`]; }
    if (problems.length === 0) {
      try { d.remove(q.hostBusy); claimed = false; } catch (e) { problems.push(`HOST-BUSY removal failed: ${String(e)}`); }
    }
    note(problems.length === 0 ? 'HOST-BUSY released' : `HOST-BUSY kept: ${problems.join('; ')}`);
    return { hostBusy: problems.length === 0 ? 'released' : 'kept', problems };
  };
  // #796 L5: wait until Tctl is at most maxTctlC. The deadline is checked before a reading is
  // accepted, so a reading after maxWaitSeconds never passes; unreadable or a signal is a STOP.
  // Every reading is kept in <job>-cooldown.json.
  const coolDown = async (job: Job, c: NonNullable<Job['cooldown']>) => {
    const start = d.now().getTime();
    const readings: { at: string; tctlC: number | null }[] = [];
    for (;;) {
      const at = d.now();
      let t: number | null;
      try { t = tctl(d.platform.thermal(at)); } catch { t = null; }
      readings.push({ at: at.toISOString(), tctlC: t });
      const left = c.maxWaitSeconds * 1000 - (at.getTime() - start);
      const waited = (at.getTime() - start) / 1000;
      const problem = aborted ? `${aborted} while cooling down` : left < 0 ? `no reading <= ${c.maxTctlC} °C within ${c.maxWaitSeconds} s (last ${t ?? 'unreadable'} after ${waited} s)`
        : t === null ? 'Tctl unreadable' : t <= c.maxTctlC ? null : left === 0 ? `Tctl ${t} °C > ${c.maxTctlC} °C after ${waited} s` : undefined;
      if (problem !== undefined) {
        d.write(join(q.chainDir, `${job.name}-cooldown.json`), JSON.stringify({ ...c, waitedSeconds: waited, ok: problem === null, problem, readings }, null, 2) + '\n');
        if (problem === null) log(`${job.name}: cool-down done, Tctl ${t} °C after ${waited} s`);
        return problem;
      }
      // The last poll lands about 1 s before the deadline, so a real sleep that overshoots still counts.
      await d.sleep(Math.min(coolPollMs, left > 1000 ? left - 1000 : left));
    }
  };
  // Right before the spawn (after the host record, preflight and gate): the levers and Tctl again,
  // so a slow gate or a lever changed meanwhile cannot start the job. Kept in <job>-launch-check.json.
  const launchCheck = (job: Job): string[] => {
    if (!job.cooldown && !job.requireHost) return [];
    const at = d.now();
    const record = d.platform.record(q.chainDir);
    const problems = requirementViolations(record, job.requireHost);
    let t: number | null = null;
    if (job.cooldown) {
      try { t = tctl(d.platform.thermal(at)); } catch { t = null; }
      if (t === null) problems.push('Tctl unreadable');
      else if (t > job.cooldown.maxTctlC) problems.push(`Tctl ${t} °C > ${job.cooldown.maxTctlC} °C`);
    }
    d.write(join(q.chainDir, `${job.name}-launch-check.json`), JSON.stringify({ at: at.toISOString(), tctlC: t, maxTctlC: job.cooldown?.maxTctlC ?? null,
      ok: problems.length === 0, problems, record }, null, 2) + '\n');
    return problems;
  };
  // One sample at start, then every thermalSampleSeconds, into <job>-thermal.jsonl. A failed read is
  // kept as an error line, so a gap is visible instead of silently missing; a failed write aborts.
  const sampleThermal = (job: Job, seconds: number) => {
    const file = join(q.chainDir, `${job.name}-thermal.jsonl`);
    const take = () => {
      try {
        const at = d.now();
        let line: unknown;
        try { line = d.platform.thermal(at) ?? { at: at.toISOString(), error: 'no thermal readings' }; } catch (e) { line = { at: at.toISOString(), error: String(e) }; }
        d.append(file, JSON.stringify(line) + '\n');
      } catch (e) { abort(`thermal sample write failed: ${String(e)}`); }
    };
    take();
    return d.every(seconds * 1000, take);
  };
  const body = async (): Promise<Result> => {
    log(`queue ${q.name}: ${q.jobs.map(j => `${j.name} (#${j.issue})`).join(', ')}; waiting for an idle host`);
    for (;;) {
      if (aborted) return stop(`${aborted} while waiting`);
      if (busyReasons(d, q.hostBusy).length === 0 && d.claim(q.hostBusy, `${q.name}: ${q.jobs.map(j => j.name).join(', ')} ${d.now().toISOString()}\n`)) break;
      await d.sleep(pollMs);
    }
    claimed = true;
    log('HOST-BUSY claimed');
    for (const job of q.jobs) {
      if (aborted) return stop(`${aborted}; ${job.name} not started`);
      log(`${job.name}: go "${job.go.quote}" (${job.go.date})`);
      for (const [what, c] of Object.entries(job.confirmations ?? {})) log(`${job.name}: confirmed ${what}: "${c.quote}" (${c.date})`);
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
        if (aborted) return stop(`${aborted} during the gate; ${job.name} not started`);
        if (gate !== 0) return stop(`${job.name} gate did not pass; job not started`);
      }
      const late = launchCheck(job);
      if (late.length > 0) return stop(`${job.name} launch check: ${late.join('; ')}; job not started`);
      if (job.postgresLogLabel) stopLogs = d.captureLogs(job.postgresLogLabel, join(q.chainDir, `${job.name}-postgres.log`));
      const stopSampling = job.thermalSampleSeconds === undefined ? null : sampleThermal(job, job.thermalSampleSeconds);
      if (aborted) { stopSampling?.(); return stop(`${aborted}; ${job.name} not started`); }
      log(`${job.name}: start (once, no rerun)`);
      let exit: number;
      try { exit = await run(d.platform.inhibit(job.command), `${job.name}.log`, job); } finally { stopSampling?.(); }
      endLogs();
      jobs.push({ name: job.name, exit });
      d.write(join(q.chainDir, `${job.name}-host-after.json`), JSON.stringify(d.platform.record(q.chainDir), null, 2) + '\n');
      const left = d.exec(['docker', 'ps', '-q']).stdout.trim().split('\n').filter(Boolean).length;
      log(`${job.name}: exit=${exit}; containers left: ${left}`);
      if (aborted) return stop(`${aborted} during ${job.name}; the queue ends (no rerun)`);
      // The next job starts only after this one's workload is gone, as at the release.
      const lingering = await stopWorkload();
      if (lingering.length > 0) return stop(`${job.name} workload still running: ${lingering.join('; ')}; the queue ends`);
      if (exit !== 0) return stop(`${job.name} exited ${exit}; the queue ends (no rerun)`);
    }
    log('queue done');
    return { outcome: 'done', jobs };
  };
  let result: Result | null = null;
  let failure: { error: unknown } | null = null;
  try { result = await body(); } catch (error) { failure = { error }; }
  const released = await release();
  if (result && released.problems.length > 0) result = { outcome: 'stop', reason: `workload not confirmed stopped, HOST-BUSY kept: ${released.problems.join('; ')}`, jobs };
  // The record a judge binds to: which jobs ran, their exits and confirmations, and the release.
  const session: Session = {
    queue: q.name, outcome: result?.outcome ?? 'error', reason: result?.reason ?? (failure ? String(failure.error) : undefined),
    jobs: jobs.map(j => ({ ...j, confirmations: q.jobs.find(x => x.name === j.name)?.confirmations })),
    hostBusy: released.hostBusy, workloadProblems: released.problems, finished: d.now().toISOString(),
  };
  try { d.write(join(q.chainDir, 'session.json'), JSON.stringify(session, null, 2) + '\n'); } catch (e) { note(`session.json: ${String(e)}`); }
  if (failure) throw failure.error;
  return result!;
}
