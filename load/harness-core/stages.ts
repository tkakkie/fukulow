import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A failure before the first measured sample is a setup failure: the harness may be fixed and the
// job rerun once the same night. Once sampling starts, any failure is a result and never reruns.
export type Mode = 'smoke' | 'rehearsal' | 'recorded';
export type Outcome = 'success' | 'setup-failure' | 'result-failure' | 'interrupted';

export function outcome(o: { failed: boolean; interrupted: boolean; sampling: boolean }): Outcome {
  if (o.interrupted) return 'interrupted';
  if (!o.failed) return 'success';
  return o.sampling ? 'result-failure' : 'setup-failure';
}

export function modeOf(flags: { smoke?: boolean; rehearsal?: boolean; recorded?: boolean }): Mode {
  const set = (['smoke', 'rehearsal', 'recorded'] as const).filter(name => flags[name]);
  if (set.length !== 1) throw new Error('Pass exactly one of --smoke, --rehearsal or --recorded');
  return set[0];
}

export function stages(out: string, mode: Mode) {
  let stage = 'initialization';
  let sampling = false;
  const complete: string[] = [];
  return {
    get stage() { return stage; },
    get sampling() { return sampling; },
    enter(name: string) { stage = name; console.log(`${name}`); },
    // Call immediately before the first measured sample is taken.
    startSampling() { sampling = true; },
    done(name: string) { complete.push(name); },
    write(o: { failed: boolean; interrupted: boolean }) {
      const status = { mode, evidence: mode === 'recorded', outcome: outcome({ ...o, sampling }), sampling, lastStage: stage,
        complete, finished: new Date().toISOString() };
      writeFileSync(join(out, 'status.json'), JSON.stringify(status, null, 2) + '\n');
      return status;
    },
  };
}
