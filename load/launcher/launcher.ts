import { join } from 'node:path';
import { requirementViolations, type HostRecord } from '../harness-core/host-record.ts';
import { tctl, type ThermalSample } from '../harness-core/thermal.ts';
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
  // A new id for this launcher session, written into every artefact it produces and passed to each
  // gate and job as FUKULOW_LAUNCH_SESSION, so a judge can bind evidence to one session (#796).
  sessionId(): string;
  now(): Date;
  // Monotonic milliseconds (performance.now): deadlines, and the reference that exposes a wall-clock step.
  mono(): number;
  // Ends early on a signal (waits that a signal should cut short).
  sleep(ms: number): Promise<void>;
  // Never cut short: the waits while confirming that a stopped job's workload has ended.
  pause(ms: number): Promise<void>;
  // Calls fn every ms until the returned stop is called, at fixed monotonic targets (fixedRate).
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
// After a job's process groups are gone, Docker is watched this long: a container whose start was
// in flight when its client died can still appear, and then HOST-BUSY stays held.
export const dockerSettleMs = 15_000;
export const dockerPollMs = 1_000;
// Container states that are, or can become, a running workload.
const liveStates = new Set(['created', 'running', 'restarting', 'paused']);
// Wall and monotonic elapsed time may differ by this much before it counts as a clock step. A
// synchronised clock is slewed by at most 500 ppm (adjtimex; 0.6 s over the 20 min cool-down), so
// only a step, or a clock off by a second or more, reaches it.
export const clockStepToleranceMs = 1000;
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
  return sampleProblems(s);
}
function sampleProblems(s: ThermalSample | null): string[] {
  if (s === null) return ['no thermal readings on this platform'];
  const unreadable = s.avgFreqKHz.flatMap((f, cpu) => (f === null ? [cpu] : []));
  if (s.avgFreqKHz.length === 0) return ['no CPU frequencies in the thermal sample'];
  return unreadable.length > 0 ? [`CPU frequency unreadable on CPU ${unreadable.join(',')}`] : [];
}

// Calls fn at start + k * ms on the monotonic clock: a late tick does not delay the later ones, so the
// cadence never drifts; a target already passed (a blocked loop) is skipped and shows as a gap.
export function fixedRate(ms: number, fn: () => void, t: { mono(): number; setTimeout(f: () => void, ms: number): unknown; clearTimeout(h: unknown): void }) {
  const start = t.mono();
  let k = 0;
  let stopped = false;
  let handle: unknown;
  const arm = () => {
    const now = t.mono();
    do k++; while (start + k * ms <= now);
    handle = t.setTimeout(() => { if (stopped) return; fn(); if (!stopped) arm(); }, start + k * ms - now);
  };
  arm();
  return () => { stopped = true; t.clearTimeout(handle); };
}

export type Session = {
  id: string; queue: string; outcome: Result['outcome'] | 'error'; reason?: string;
  // thermalSampleSeconds: the period the launcher's sampler actually ran with for the job.
  jobs: (Result['jobs'][number] & { out?: string; workloadLabel?: string; thermalSampleSeconds?: number; confirmations?: Job['confirmations'] })[];
  hostBusy: 'released' | 'kept' | 'never claimed'; workloadProblems: string[]; finished: string;
};

export async function launch(q: Queue, d: Deps): Promise<Result> {
  const chainLog = join(q.chainDir, 'chain.log');
  const log = (line: string) => d.append(chainLog, `${d.now().toISOString()} ${line}\n`);
  // For callbacks and cleanup: a failed chain-log write must never skip a kill or a release.
  const note = (line: string) => { try { log(line); } catch { /* the session record still carries the outcome */ } };
  const launchSession = d.sessionId();
  const record = (file: string, value: Record<string, unknown>) => d.write(join(q.chainDir, file), JSON.stringify({ ...value, launchSession }, null, 2) + '\n');
  const jobs: Result['jobs'] = [];
  let claimed = false;
  let child: Child | null = null;
  const started: { child: Child; job: Job }[] = [];
  // At the claim: every container (any state), and those live then. Release compares live state
  // (maintainer decision on PR #875, option A): a container live now that was not live at the claim is
  // the workload's, whether it is new or an old one (re)started; a new container still present is too.
  let known: Set<string> | null = null;
  let liveAtClaim: Set<string> | null = null;
  const periods: Record<string, number> = {};
  let stopLogs: (() => void) | null = null;
  let aborted: string | null = null;
  let onAbort = () => {};
  const abortedP = new Promise<void>(resolve => { onAbort = resolve; });
  const endLogs = () => { const s = stopLogs; stopLogs = null; try { s?.(); } catch (e) { note(`log capture stop failed: ${String(e)}`); } };
  const alive = (c: Child) => { try { return c.alive(); } catch { return true; } };
  const gone = async (c: Child, ms: number) => {
    for (let waited = 0; alive(c); waited += settlePollMs) {
      if (waited >= ms) return false;
      await d.pause(settlePollMs);
    }
    return true;
  };
  const kill = (c: Child, signal: 'SIGTERM' | 'SIGKILL') => { try { c.kill(signal); } catch (e) { note(`${signal} failed: ${String(e)}`); } };
  // The bounded stop of one process group: SIGTERM, then SIGKILL after termGraceMs, then up to
  // killGraceMs more. It runs on its own timer (pause), never waiting on the child's exit.
  const escalations = new Map<Child, Promise<void>>();
  const escalate = (c: Child) => {
    let p = escalations.get(c);
    if (!p) {
      p = (async () => {
        kill(c, 'SIGTERM');
        if (await gone(c, termGraceMs)) return;
        note(`process group alive ${termGraceMs / 1000} s after SIGTERM; SIGKILL`);
        kill(c, 'SIGKILL');
        await gone(c, killGraceMs);
      })().catch(e => note(`stop failed: ${String(e)}`));
      escalations.set(c, p);
    }
    return p;
  };
  // The one stop path for a signal, a failed sampler write or any other fault outside the main flow:
  // start the bounded stop of the running gate or job first, then log. HOST-BUSY is released only
  // after the main flow ends and the workload is confirmed stopped (release).
  const abort = (reason: string) => {
    aborted ??= reason;
    if (child) void escalate(child);
    onAbort();
    note(`STOP: ${reason}`);
  };
  d.onSignal(signal => abort(signal));
  // The child's exit code; null when it was stopped and its exit was not observed after the bounded
  // stop (its group is checked again at the release, which keeps HOST-BUSY if it still runs).
  const run = async (argv: string[], file: string, job: Job): Promise<number | null> => {
    const c = d.spawn(argv, { cwd: job.worktree, log: join(q.chainDir, file), env: { ...job.env, FUKULOW_LAUNCH_SESSION: launchSession } });
    child = c;
    started.push({ child: c, job });
    try {
      const stopped = abortedP.then(() => escalate(c)).then(() => null);
      const first = await Promise.race([c.done, stopped]);
      return first ?? (await Promise.race([c.done, Promise.resolve(null)]));
    } finally { child = null; }
  };
  const stop = (reason: string): Result => { log(`STOP: ${reason}`); return { outcome: 'stop', reason, jobs }; };
  // Every process group the launcher started has ended, and no container is running: none ran when
  // HOST-BUSY was claimed, so any container now is the workload's, whether or not its label was
  // given or typed right (fail closed). Anything unconfirmed keeps HOST-BUSY held.
  const stopWorkload = async () => {
    const problems: string[] = [];
    for (const { child: c, job } of started) {
      try {
        if (await gone(c, 0)) continue;
        // The same bounded stop as an abort; one an abort already ran is not repeated.
        await escalate(c);
        if (alive(c)) problems.push(`${job.name}: process group still running after SIGKILL`);
      } catch (e) { problems.push(`${job.name}: process group check failed: ${String(e)}`); }
    }
    if (started.length > 0) problems.push(...(await dockerSettled()));
    return problems;
  };
  // Labelled containers (any state) are removed and must be gone. Then Docker is watched for
  // dockerSettleMs: any container live (created, running, restarting, paused) at any poll that was not
  // live at the claim, new or an old stopped one started again, and any container created since the
  // claim that is not gone at the last poll, is a workload that outlived the job (a missing or
  // mistyped label, or a start in flight when its client died). HOST-BUSY stays held. Fail closed.
  const dockerSettled = async () => {
    const problems: string[] = [];
    for (const label of new Set(started.flatMap(s => (s.job.workloadLabel ? [s.job.workloadLabel] : [])))) {
      const ps = () => d.exec(['docker', 'ps', '-a', '-q', '--filter', `label=${label}`]);
      let ids = ps();
      if (ids.status === 0 && ids.stdout.trim() !== '') {
        note(`containers with label ${label} still present; removing them`);
        d.exec(['docker', 'rm', '-f', ...ids.stdout.trim().split('\n')]);
        ids = ps();
      }
      if (ids.status !== 0) problems.push(`docker ps for label ${label} failed`);
      else if (ids.stdout.trim() !== '') problems.push(`containers with label ${label} still present`);
    }
    if (known === null || liveAtClaim === null) return [...problems, 'no container snapshot from the claim'];
    const seen = new Map<string, string>();
    let last: string[] = [];
    for (let waited = 0; ; waited += dockerPollMs) {
      const all = d.exec(['docker', 'ps', '-a', '--format', '{{.ID}} {{.State}}']);
      if (all.status !== 0) return [...problems, 'docker ps -a failed'];
      const rows = all.stdout.split('\n').map(l => l.trim().split(/\s+/)).filter(([id]) => id);
      for (const [id, state] of rows) if (liveStates.has(state) && !liveAtClaim!.has(id)) seen.set(id, state);
      last = rows.filter(([id, state]) => !known!.has(id) && state !== 'exited' && state !== 'dead').map(([id, state]) => `${id} ${state}`);
      if (waited >= dockerSettleMs) break;
      await d.pause(dockerPollMs);
    }
    if (seen.size > 0) problems.push(`containers not live at the claim were live after the job: ${[...seen].map(([id, st]) => `${id} ${st}`).join(', ')}`);
    else if (last.length > 0) problems.push(`containers created since the claim still present: ${last.join(', ')}`);
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
  // #796 L5: wait until Tctl is at most maxTctlC. Elapsed time is monotonic and taken after each Tctl
  // read completes, so a reading after maxWaitSeconds never passes, however slow the read or
  // however the wall clock moves; a wall-clock step, an unreadable Tctl or a signal is a STOP.
  // Every reading is kept in <job>-cooldown.json.
  const coolDown = async (job: Job, c: NonNullable<Job['cooldown']>) => {
    const mono0 = d.mono();
    const wall0 = d.now().getTime();
    const limitMs = c.maxWaitSeconds * 1000;
    const readings: { at: string; elapsedMs: number; tctlC: number | null }[] = [];
    for (;;) {
      let t: number | null;
      try { t = tctl(d.platform.thermal(d.now())); } catch { t = null; }
      const elapsedMs = d.mono() - mono0;
      const at = d.now();
      const stepMs = at.getTime() - wall0 - elapsedMs;
      readings.push({ at: at.toISOString(), elapsedMs, tctlC: t });
      const waited = elapsedMs / 1000;
      const problem = aborted ? `${aborted} while cooling down`
        : Math.abs(stepMs) > clockStepToleranceMs ? `wall clock stepped ${Math.round(stepMs)} ms against the monotonic clock`
        : elapsedMs > limitMs ? `no reading <= ${c.maxTctlC} °C within ${c.maxWaitSeconds} s (last ${t ?? 'unreadable'} after ${waited} s)`
        : t === null ? 'Tctl unreadable' : t <= c.maxTctlC ? null : elapsedMs >= limitMs ? `Tctl ${t} °C > ${c.maxTctlC} °C after ${waited} s` : undefined;
      if (problem !== undefined) {
        record(`${job.name}-cooldown.json`, { ...c, waitedSeconds: waited, ok: problem === null, problem, readings });
        if (problem === null) log(`${job.name}: cool-down done, Tctl ${t} °C after ${waited} s`);
        return problem;
      }
      // The last poll lands about 1 s before the deadline, so a real sleep that overshoots still counts.
      const left = limitMs - elapsedMs;
      await d.sleep(Math.min(coolPollMs, left > 1000 ? left - 1000 : left));
    }
  };
  // Right before the spawn (after the host record, preflight and gate): the levers and Tctl again,
  // so a slow gate or a lever changed meanwhile cannot start the job. Kept in <job>-launch-check.json.
  const launchCheck = (job: Job): string[] => {
    if (!job.cooldown && !job.requireHost) return [];
    const at = d.now();
    const host = d.platform.record(q.chainDir);
    const problems = requirementViolations(host, job.requireHost);
    let t: number | null = null;
    if (job.cooldown) {
      try { t = tctl(d.platform.thermal(at)); } catch { t = null; }
      if (t === null) problems.push('Tctl unreadable');
      else if (t > job.cooldown.maxTctlC) problems.push(`Tctl ${t} °C > ${job.cooldown.maxTctlC} °C`);
    }
    record(`${job.name}-launch-check.json`, { at: at.toISOString(), tctlC: t, maxTctlC: job.cooldown?.maxTctlC ?? null, ok: problems.length === 0, problems, record: host });
    return problems;
  };
  // One sample before the spawn, then every thermalSampleSeconds, into <job>-thermal.jsonl. The first
  // sample must succeed with every CPU's frequency readable, or the job does not start (the string
  // returned). Later, a failed read is kept as an error line, so a gap is visible instead of
  // silently missing; a failed write aborts.
  const sampleThermal = (job: Job, seconds: number): string | (() => void) => {
    const file = join(q.chainDir, `${job.name}-thermal.jsonl`);
    const take = (): string | null => {
      const at = d.now();
      const monoMs = d.mono();
      let line: Record<string, unknown>;
      let problem: string | null;
      try {
        const s = d.platform.thermal(at);
        line = s ?? { at: at.toISOString(), error: 'no thermal readings' };
        problem = sampleProblems(s).join('; ') || null;
      } catch (e) { line = { at: at.toISOString(), error: String(e) }; problem = `thermal sample failed: ${String(e)}`; }
      try { d.append(file, JSON.stringify({ ...line, monoMs, launchSession }) + '\n'); } catch (e) { return `thermal sample write failed: ${String(e)}`; }
      return problem;
    };
    const first = take();
    if (first !== null) return first;
    periods[job.name] = seconds;
    return d.every(seconds * 1000, () => { const p = take(); if (p?.startsWith('thermal sample write failed')) abort(p); });
  };
  // A job's chain records are written by this session only: an existing one (an earlier session's)
  // would be mixed with this session's, so it is a STOP.
  const leftovers = (job: Job) => ['cooldown.json', 'host-before.json', 'launch-check.json', 'thermal.jsonl', 'host-after.json']
    .map(f => join(q.chainDir, `${job.name}-${f}`)).filter(f => d.exists(f));
  const body = async (): Promise<Result> => {
    log(`queue ${q.name} (launch session ${launchSession}): ${q.jobs.map(j => `${j.name} (#${j.issue})`).join(', ')}; waiting for an idle host`);
    for (;;) {
      if (aborted) return stop(`${aborted} while waiting`);
      if (busyReasons(d, q.hostBusy).length === 0 && d.claim(q.hostBusy, `${q.name}: ${q.jobs.map(j => j.name).join(', ')} ${d.now().toISOString()} session ${launchSession}\n`)) break;
      await d.sleep(pollMs);
    }
    claimed = true;
    log('HOST-BUSY claimed');
    const snapshot = d.exec(['docker', 'ps', '-a', '--format', '{{.ID}} {{.State}}']);
    if (snapshot.status !== 0) return stop('docker ps -a failed; no container snapshot, nothing started');
    const claimRows = snapshot.stdout.split('\n').map(l => l.trim().split(/\s+/)).filter(([id]) => id);
    known = new Set(claimRows.map(([id]) => id));
    liveAtClaim = new Set(claimRows.filter(([, state]) => liveStates.has(state)).map(([id]) => id));
    for (const job of q.jobs) {
      if (aborted) return stop(`${aborted}; ${job.name} not started`);
      const old = leftovers(job);
      if (old.length > 0) return stop(`${job.name}: chain records from another session exist: ${old.join(', ')}; job not started`);
      log(`${job.name}: go "${job.go.quote}" (${job.go.date})`);
      for (const [what, c] of Object.entries(job.confirmations ?? {})) log(`${job.name}: confirmed ${what}: "${c.quote}" (${c.date})`);
      if (job.cooldown) {
        const problem = await coolDown(job, job.cooldown);
        if (problem !== null) return stop(`${job.name} cool-down: ${problem}; job not started`);
      }
      const before = d.platform.record(q.chainDir);
      record(`${job.name}-host-before.json`, before as unknown as Record<string, unknown>);
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
      const sampling = job.thermalSampleSeconds === undefined ? null : sampleThermal(job, job.thermalSampleSeconds);
      if (typeof sampling === 'string') return stop(`${job.name} first thermal sample: ${sampling}; job not started`);
      if (aborted) { sampling?.(); return stop(`${aborted}; ${job.name} not started`); }
      log(`${job.name}: start (once, no rerun)`);
      let exit: number | null;
      try { exit = await run(d.platform.inhibit(job.command), `${job.name}.log`, job); } finally { sampling?.(); }
      endLogs();
      jobs.push({ name: job.name, exit });
      record(`${job.name}-host-after.json`, d.platform.record(q.chainDir) as unknown as Record<string, unknown>);
      const left = d.exec(['docker', 'ps', '-q']).stdout.trim().split('\n').filter(Boolean).length;
      log(`${job.name}: exit=${exit ?? 'not observed'}; containers left: ${left}`);
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
  // The record a judge binds to: the session id in every artefact, which jobs ran (with their
  // outputs, workload labels, exits and confirmations), and the release.
  const session: Session = {
    id: launchSession, queue: q.name, outcome: result?.outcome ?? 'error', reason: result?.reason ?? (failure ? String(failure.error) : undefined),
    jobs: jobs.map(j => { const x = q.jobs.find(y => y.name === j.name); return { ...j, out: x?.out, workloadLabel: x?.workloadLabel, thermalSampleSeconds: periods[j.name], confirmations: x?.confirmations }; }),
    hostBusy: released.hostBusy, workloadProblems: released.problems, finished: d.now().toISOString(),
  };
  try { d.write(join(q.chainDir, 'session.json'), JSON.stringify(session, null, 2) + '\n'); } catch (e) { note(`session.json: ${String(e)}`); }
  if (failure) throw failure.error;
  return result!;
}
