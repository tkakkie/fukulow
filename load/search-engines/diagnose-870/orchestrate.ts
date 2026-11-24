import type { Measurement } from './judge.ts';
import { settleCapMs, type MeasuredStep, type Step } from './plan.ts';

// Walks one stage's fixed sequence once (design rev 2, §2 and §5.1). The I/O lives in the worker; the
// order of the steps and every STOP rule live here, so the tests drive them with fakes.

export const minDockerFreeBytes = 40 * 1024 ** 3;
export const maxInvalid = 4;

export type Deps = {
  dockerFreeBytes(): number | null;
  // Drops any earlier copy and creates `measured` from the restored `base` template.
  copy(): Promise<void>;
  // CHECKPOINT, then wait for dirty memory and autovacuum to settle; false when the cap was reached.
  settle(capMs: number): Promise<boolean>;
  restart(): Promise<void>;
  warmup(step: MeasuredStep): Promise<void>;
  // One measurement. Its own validity reasons (samples, failures, load) are already in `invalid`.
  measure(step: MeasuredStep, opts: {explain: boolean; settleCapped: boolean}): Promise<Measurement>;
  // Adds the sampler reasons to every measurement whose window the samplers have covered.
  revalidate(measurements: Measurement[]): void;
  idle(ms: number): Promise<void>;
  scan(): Promise<void>;
  log(line: string): void;
};

// EXPLAIN runs after a measurement, so it is skipped where the next measurement must follow at once
// (a cache arm's warm and hot measurements); restart-only flushes shared buffers before it is measured.
const explains = (step: MeasuredStep) => step.kind === 'restart-only' || (step.kind === 'copy' && !/^C\d$/.test(step.arm));

export async function execute(steps: Step[], d: Deps) {
  const measurements: Measurement[] = [];
  let stopped: string | null = null;
  const invalidCount = () => { d.revalidate(measurements); return measurements.filter(m => m.invalid.length > 0).length; };
  for (const step of steps) {
    try {
      if (step.kind === 'idle') { d.log(`${step.id}: idle ${step.ms / 60_000} min`); await d.idle(step.ms); continue; }
      if (step.kind === 'scan') { d.log(`${step.id}: completeness scan`); await d.scan(); continue; }
      let settleCapped = false;
      if (step.kind === 'copy') {
        const free = d.dockerFreeBytes();
        if (free === null || free < minDockerFreeBytes) {
          stopped = `${step.id}: Docker free ${free === null ? 'unreadable' : (free / 1024 ** 3).toFixed(1) + ' GiB'} < 40 GiB`;
          break;
        }
        await d.copy();
        if (step.settle) settleCapped = !await d.settle(settleCapMs);
      }
      if (step.kind !== 'hot') await d.restart();
      if (step.kind === 'copy') await d.warmup(step);
      const m = await d.measure(step, {explain: explains(step), settleCapped});
      if (settleCapped) m.invalid.push('settle wait hit its cap');
      measurements.push(m);
      d.log(`${step.id}: measured${m.invalid.length ? ` INVALID (${m.invalid.join('; ')})` : ''}`);
      if (invalidCount() > maxInvalid) { stopped = `more than ${maxInvalid} INVALID measurements`; break; }
    } catch (error) {
      stopped = `${step.id}: ${String(error)}`;
      break;
    }
  }
  if (stopped) d.log(`STOP: ${stopped}`);
  d.revalidate(measurements);
  return {measurements, stopped};
}
