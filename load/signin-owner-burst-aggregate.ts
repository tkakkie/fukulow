// #756 outcome over the 3 pre-registered recorded runs:
//   node load/signin-owner-burst-aggregate.ts RUN_DIR_1 RUN_DIR_2 RUN_DIR_3
// A run is evidence only when its status.json, results.json and metadata.json are one completed
// recorded run: the same run identity in all three, a successful recorded status that is evidence,
// complete results with a recorded harness and server commit, the pre-registered recorded plan, and a stored verdict that the stored
// samples reproduce (which includes the workload-completeness check). Smoke and rehearsal outputs, repeated directories and repeated run identities
// are never evidence. Fewer than 3 valid runs is INCONCLUSIVE.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { PLANS } from './signin-owner-burst-config.ts';
import { aggregate, judgeBurst, type AggregateRun, type BurstRun, type Verdict } from './signin-owner-burst-judgment.ts';

const SHA = /^[0-9a-f]{40}$/;
type Status = { runId?: unknown; mode?: unknown; evidence?: unknown; outcome?: unknown };
type Results = Partial<BurstRun> & { runId?: unknown; mode?: unknown; evidence?: unknown; complete?: unknown; stoppedEarly?: unknown;
  harnessCommit?: unknown; serverCommit?: unknown; judgment?: { verdict?: Verdict } };
type Meta = { project?: unknown; harnessCommit?: unknown; serverCommit?: unknown };

const read = <T>(dir: string, name: string): T | null => {
  try { return JSON.parse(readFileSync(join(dir, name), 'utf8')) as T; } catch { return null; }
};

export function readRun(dir: string): AggregateRun & { dir: string; harnessCommit: string | null; serverCommit: string | null } {
  const status = read<Status>(dir, 'status.json'), results = read<Results>(dir, 'results.json'), meta = read<Meta>(dir, 'metadata.json');
  const id = typeof status?.runId === 'string' ? status.runId : null;
  const verdict = results?.judgment?.verdict ?? null;
  const harnessCommit = typeof meta?.harnessCommit === 'string' ? meta.harnessCommit : null;
  const serverCommit = typeof meta?.serverCommit === 'string' ? meta.serverCommit : null;
  const reject = (problem: string) => ({ dir, id, evidence: false, verdict, harnessCommit, serverCommit, problem });
  if (!status || !results || !meta) return reject('missing status.json, results.json or metadata.json');
  if (status.mode !== 'recorded' || status.evidence !== true || status.outcome !== 'success') return reject('status is not a completed recorded evidence run');
  if (!id || results.runId !== id || meta.project !== id) return reject('artifacts belong to different runs');
  if (results.mode !== 'recorded' || results.evidence !== true || results.complete !== true || results.stoppedEarly !== null)
    return reject('results are not a complete recorded evidence run');
  if (!SHA.test(String(meta.harnessCommit)) || meta.harnessCommit !== results.harnessCommit
    || !SHA.test(String(meta.serverCommit)) || meta.serverCommit !== results.serverCommit) return reject('harness or server commit not recorded');
  const planned = PLANS.recorded, plan = results.plan;
  if (!plan || plan.b0Ms !== planned.b0Ms || plan.bursts !== planned.bursts || plan.b1TailMs !== planned.b1TailMs || plan.b2Ms !== planned.b2Ms)
    return reject('results were not produced with the pre-registered recorded plan');
  let recomputed: Verdict | null = null;
  try { recomputed = judgeBurst(results as BurstRun).verdict; } catch { recomputed = null; }
  if (recomputed === null || recomputed !== verdict) return reject('stored verdict is not reproduced from the stored run');
  return { dir, id, evidence: true, verdict, harnessCommit, serverCommit };
}

/**
 * Reads the 3 run directories. The same directory twice is not evidence, and runs from different
 * harness or server commits are not one measurement (approved 2026-11-22): then none is evidence.
 */
export function readRuns(dirs: readonly string[]) {
  const real = dirs.map(d => { try { return realpathSync(d); } catch { return d; } });
  const runs = dirs.map(readRun).map((r, i) => real.indexOf(real[i]) !== i ? { ...r, evidence: false, problem: 'same directory twice' } : r);
  const valid = runs.filter(r => r.evidence);
  const differ = new Set(valid.map(r => r.harnessCommit)).size > 1 ? 'runs used different harness commits'
    : new Set(valid.map(r => r.serverCommit)).size > 1 ? 'runs tested different server commits' : null;
  return differ ? runs.map(r => ({ ...r, evidence: false, problem: r.problem ?? differ })) : runs;
}

if (import.meta.main) {
  const runs = readRuns(process.argv.slice(2));
  console.log(JSON.stringify({ ...aggregate(runs), runs }, null, 2));
}
