import type { Measurement } from './judge.ts';
import { settleCapMs, type MeasuredStep, type Step } from './plan.ts';

// Walks one stage's fixed sequence once (design rev 2, §2 and §5.1). The I/O lives in the worker; the
// order of the steps and every STOP rule live here, so the tests drive them with fakes.

// §3.3 thresholds are decimal GB, as approved.
export const GB = 1e9;
export const minDockerFreeBytes = 40 * GB;
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
  measure(step: MeasuredStep, opts: {explain: boolean}): Promise<Measurement>;
  // Waits until the samplers have covered every unchecked window (a sample at or after its end in each
  // stream, or the coverage deadline), then adds their reasons. Nothing starts before it resolves.
  validate(measurements: Measurement[]): Promise<void>;
  idle(ms: number): Promise<void>;
  scan(): Promise<void>;
  log(line: string): void;
};

// EXPLAIN runs after every measurement except a cache arm's hot 1, so hot 2 follows hot 1 with nothing
// but the per-measurement statistics and the sampler check between them (N is their spread).
const explains = (step: MeasuredStep) => !(step.kind === 'hot' && step.id.endsWith('.hot1'));

export async function execute(steps: Step[], d: Deps) {
  const measurements: Measurement[] = [];
  let stopped: string | null = null;
  const invalidCount = async () => { await d.validate(measurements); return measurements.filter(m => m.invalid.length > 0).length; };
  for (const step of steps) {
    try {
      if (step.kind === 'idle') { d.log(`${step.id}: idle ${step.ms / 60_000} min`); await d.idle(step.ms); continue; }
      if (step.kind === 'scan') { d.log(`${step.id}: completeness scan`); await d.scan(); continue; }
      let settleCapped = false;
      if (step.kind === 'copy') {
        const free = d.dockerFreeBytes();
        if (free === null || free < minDockerFreeBytes) {
          stopped = `${step.id}: Docker free ${free === null ? 'unreadable' : (free / GB).toFixed(1) + ' GB'} < 40 GB`;
          break;
        }
        await d.copy();
        if (step.settle) settleCapped = !await d.settle(settleCapMs);
      }
      if (step.kind !== 'hot') await d.restart();
      if (step.kind === 'copy') await d.warmup(step);
      const m = await d.measure(step, {explain: explains(step)});
      if (settleCapped) m.invalid.push('settle wait hit its cap');
      measurements.push(m);
      d.log(`${step.id}: measured${m.invalid.length ? ` INVALID (${m.invalid.join('; ')})` : ''}`);
      if (await invalidCount() > maxInvalid) { stopped = `more than ${maxInvalid} INVALID measurements`; break; }
    } catch (error) {
      stopped = `${step.id}: ${String(error)}`;
      break;
    }
  }
  if (stopped) d.log(`STOP: ${stopped}`);
  try { await d.validate(measurements); } catch (error) { stopped ??= `sampler validation: ${String(error)}`; }
  return {measurements, stopped};
}
