import type { Measurement } from './judge.ts';
import { settleCapMs, type MeasuredStep, type Step } from './plan.ts';

// Walks one stage's fixed sequence once (design rev 2, §2 and §5.1). The I/O lives in the worker; the
// order of the steps and every STOP rule live here, so the tests drive them with fakes.

// §3.3 thresholds are decimal GB, as approved.
export const GB = 1e9;
export const minFreeBytes = 40 * GB;
export const minDockerStartBytes = 175 * GB;
export const maxInvalid = 4;

// Free bytes before each copy (§3.3): Docker storage and the host filesystems of the snapshot tar and of
// the output. null is unreadable.
export type Free = {docker: number | null; snapshot: number | null; output: number | null};
export type Deps = {
  freeBytes(): Free;
  // Drops any earlier copy and creates `measured` from the restored `base` template.
  copy(): Promise<void>;
  // CHECKPOINT, then wait for dirty memory and autovacuum to settle; false when the cap was reached.
  settle(capMs: number): Promise<boolean>;
  restart(): Promise<void>;
  warmup(step: MeasuredStep): Promise<void>;
  // One measurement. Its own validity reasons (samples, failures, load) are already in `invalid`.
  measure(step: MeasuredStep, opts: {explain: boolean}): Promise<Measurement>;
  // Waits until the samplers have covered every unchecked window (a sample at or after its end in each
  // stream, or the coverage deadline), then adds their reasons. Nothing starts before it resolves.
  validate(measurements: Measurement[]): Promise<void>;
  // Returns early once aborted() is set.
  idle(ms: number): Promise<void>;
  scan(): Promise<void>;
  // The reason once a signal has arrived, else null. Nothing new starts after it (review round 6).
  aborted(): string | null;
  log(line: string): void;
};

// EXPLAIN runs after every measurement except a cache arm's warm and hot 1 (decision 2026-11-24, option
// A): nothing touches the copy between warm, hot 1 and hot 2 but the per-measurement statistics, the
// read-counter wait and the sampler check. The sweep after hot 2 stands for all three; restart-only has its own.
export const explains = (step: MeasuredStep) => !((step.arm === 'C1' || step.arm === 'C2') && /\.(warm|hot1)$/.test(step.id));

export function diskStop(free: Free) {
  const low = (Object.entries(free) as [keyof Free, number | null][]).filter(([, b]) => b === null || b < minFreeBytes);
  return low.length ? low.map(([k, b]) => `${k} free ${b === null ? 'unreadable' : (b / GB).toFixed(1) + ' GB'} < 40 GB`).join('; ') : null;
}

// §3.3 at start: Docker storage >= 175 GB, and >= 40 GB on the host filesystems of the snapshot tar (beyond
// the tar, which is already on it) and of the output. Unreadable is a failure.
export function startDiskProblems(free: Free) {
  const p: string[] = [];
  if (free.docker === null || free.docker < minDockerStartBytes) p.push(`Docker free ${free.docker ?? 'unreadable'} < 175 GB`);
  for (const k of ['snapshot', 'output'] as const) {
    if (free[k] === null || free[k] < minFreeBytes) p.push(`${k} filesystem free ${free[k] ?? 'unreadable'} < 40 GB`);
  }
  return p;
}

// The settle wait (§2): CHECKPOINT, then poll until Dirty plus Writeback is under 64 MiB and no autovacuum
// worker runs. A reading taken within the cap (15 min exactly included) that meets both ends the wait;
// once more than the cap has passed it is false, and that round is INVALID.
export const settleDirtyBytes = 64 * 1024 ** 2;
export type SettleIo = {checkpoint(): void; reading(): {dirtyWritebackBytes: number; autovacuumWorkers: number};
  now(): number; sleep(ms: number): Promise<void>};
export async function settleWait(io: SettleIo, capMs: number) {
  const start = io.now();
  const elapsed = () => io.now() - start;
  io.checkpoint();
  const met = (r: ReturnType<SettleIo['reading']>) => r.dirtyWritebackBytes < settleDirtyBytes && r.autovacuumWorkers === 0;
  for (;;) {
    // Past the cap (a CHECKPOINT or a sleep that overran it) no reading starts: INVALID, never a failed
    // reading turned into a STOP.
    if (elapsed() > capMs) return false;
    const r = io.reading();
    if (elapsed() > capMs) return false;
    if (met(r)) return true;
    if (elapsed() >= capMs) return false;
    await io.sleep(Math.min(1_000, capMs - elapsed()));
  }
}

class Aborted extends Error {}

export async function execute(steps: Step[], d: Deps) {
  const measurements: Measurement[] = [];
  let stopped: string | null = null;
  // Checked before every action that starts work (a step, a copy, a settle, a restart, a warm-up, a
  // measurement), so a signal ends the sequence before anything new starts.
  const go = () => { const reason = d.aborted(); if (reason !== null) throw new Aborted(reason); };
  const invalidCount = async () => { await d.validate(measurements); return measurements.filter(m => m.invalid.length > 0).length; };
  for (const step of steps) {
    try {
      go();
      if (step.kind === 'idle') { d.log(`${step.id}: idle ${step.ms / 60_000} min`); await d.idle(step.ms); continue; }
      if (step.kind === 'scan') { d.log(`${step.id}: completeness scan`); await d.scan(); continue; }
      let settleCapped = false;
      if (step.kind === 'copy') {
        const low = diskStop(d.freeBytes());
        if (low) { stopped = `${step.id}: ${low}`; break; }
        await d.copy();
        go();
        if (step.settle) settleCapped = !await d.settle(settleCapMs);
      }
      go();
      if (step.kind !== 'hot') await d.restart();
      go();
      if (step.kind === 'copy') await d.warmup(step);
      go();
      const m = await d.measure(step, {explain: explains(step)});
      if (settleCapped) m.invalid.push('settle wait hit its cap');
      measurements.push(m);
      d.log(`${step.id}: measured${m.invalid.length ? ` INVALID (${m.invalid.join('; ')})` : ''}`);
      if (await invalidCount() > maxInvalid) { stopped = `more than ${maxInvalid} INVALID measurements`; break; }
    } catch (error) {
      stopped = error instanceof Aborted ? `${step.id}: aborted by ${error.message}` : `${step.id}: ${String(error)}`;
      break;
    }
  }
  // A signal that arrives after the last step still makes the stage abnormal.
  const late = d.aborted();
  if (late !== null) stopped ??= `aborted by ${late}`;
  if (stopped) d.log(`STOP: ${stopped}`);
  // After a signal nothing waits on sampler coverage; the unchecked windows are incomplete evidence.
  if (late === null) {
    try { await d.validate(measurements); } catch (error) { stopped ??= `sampler validation: ${String(error)}`; }
  }
  return {measurements, stopped};
}

// An idle wait in slices of at most `sliceMs`, ending early once aborted() is set.
export async function abortableIdle(ms: number, aborted: () => string | null, now: () => number, sleep: (ms: number) => Promise<void>, sliceMs = 1_000) {
  const end = now() + ms;
  while (aborted() === null && now() < end) await sleep(Math.min(sliceMs, end - now()));
}
