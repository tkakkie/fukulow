// #756 outcome over the 3 pre-registered recorded runs:
//   node load/signin-owner-burst-aggregate.ts RUN_DIR_1 RUN_DIR_2 RUN_DIR_3
// A run counts only if its status.json says evidence (a recorded run, not invalidated) and its judged
// verdict is `holds` or `fails`. Smoke and rehearsal outputs are never evidence.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aggregate, type Verdict } from './signin-owner-burst-judgment.ts';

export function readRun(dir: string) {
  const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as { mode?: string; evidence?: boolean };
  let verdict: Verdict | null = null;
  try {
    const results = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')) as { judgment?: { verdict?: Verdict }; mode?: string };
    verdict = results.judgment?.verdict ?? null;
  } catch { verdict = null; }
  return { dir, evidence: status.mode === 'recorded' && status.evidence === true, verdict };
}

if (import.meta.main) {
  const runs = process.argv.slice(2).map(readRun);
  console.log(JSON.stringify({ ...aggregate(runs), runs }, null, 2));
}
