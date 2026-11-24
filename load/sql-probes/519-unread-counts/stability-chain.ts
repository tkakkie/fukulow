// Judges #796 stability across runs in a launcher session.
import { median } from '../../harness-core/thermal.ts';
import type { Session } from '../../launcher/launcher.ts';
import type { Binding, RunInput } from './stability-judge.ts';

export const runsRequired = 3;
export const limits = { tpsSpread: 0.05, walSpread: 0.02, throttle: 0.05 };
// The workload label final.ts puts on its container; the session must have used it for the cleanup.
export const workloadLabel = 'io.fukulow.probe=519-final';

// The runs must be the jobs of one completed launcher session that released HOST-BUSY, each with
// the maintainer's L3 airflow confirmation recorded.
export function sessionProblems(session: Session | null, queue: string, runs: { name: string; out: string }[]): string[] {
  if (session === null) return ['no launcher session record'];
  const names = runs.map(r => r.name);
  const p: string[] = [];
  if (typeof session.id !== 'string' || session.id.trim() === '') p.push('launcher session has no id');
  if (session.queue !== queue) p.push(`session is for queue ${session.queue}, not ${queue}`);
  if (session.outcome !== 'done') p.push(`launcher session did not complete (${session.outcome}${session.reason ? `: ${session.reason}` : ''})`);
  if (session.hostBusy !== 'released') p.push(`HOST-BUSY ${session.hostBusy}, not released`);
  const ran = (session.jobs ?? []).map(j => j.name);
  if (ran.join('\n') !== names.join('\n')) p.push(`session ran ${ran.join(', ') || '(nothing)'}, not ${names.join(', ')}`);
  for (const j of session.jobs ?? []) {
    if (j.exit !== 0) p.push(`${j.name} exited ${j.exit}`);
    const out = runs.find(r => r.name === j.name)?.out;
    if (out !== undefined && j.out !== out) p.push(`${j.name}: session output ${j.out ?? '(none)'} is not the judged ${out}`);
    if (j.workloadLabel !== workloadLabel) p.push(`${j.name}: workloadLabel ${j.workloadLabel ?? '(none)'} is not ${workloadLabel}`);
    const airflow = j.confirmations?.airflow;
    if (!airflow?.quote?.trim() || !airflow.date?.trim()) p.push(`${j.name}: no L3 airflow confirmation in the session`);
  }
  return p;
}

const spread = (xs: number[]) => (Math.max(...xs) - Math.min(...xs)) / median(xs);

export function judgeChain<Run extends { name: string; valid: boolean; current: { tps: number; wal: number }; final: { tps: number; wal: number } }>(
  runs: RunInput[], session: Session | null, queue: string, assess: (r: RunInput, bound: Binding) => Run) {
  const id = typeof session?.id === 'string' && session.id.trim() !== '' ? session.id : null;
  // The sampling period is the launcher's own record of the run, never the queue handed to the judge.
  const judged = runs.map(r => assess(r, { id, thermalSampleSeconds: session?.jobs?.find(j => j.name === r.name)?.thermalSampleSeconds, go: session?.jobs?.find(j => j.name === r.name)?.frequencyGo }));
  const reasons: string[] = sessionProblems(session, queue, runs);
  if (runs.length !== runsRequired) reasons.push(`${runs.length} runs, not ${runsRequired}`);
  for (const r of judged) if (!r.valid) reasons.push(`${r.name} INVALID`);
  const arms = Object.fromEntries((['current', 'final'] as const).map(a => {
    const tps = spread(judged.map(r => r[a].tps));
    const wal = spread(judged.map(r => r[a].wal));
    if (!(tps <= limits.tpsSpread)) reasons.push(`${a} tps spread ${(tps * 100).toFixed(2)} % > ${limits.tpsSpread * 100} %`);
    if (!(wal <= limits.walSpread)) reasons.push(`${a} WAL/send spread ${(wal * 100).toFixed(2)} % > ${limits.walSpread * 100} %`);
    return [a, { tpsSpread: tps, walSpread: wal }];
  }));
  return { result: reasons.length === 0 ? 'PASS' : 'FAIL', reasons, arms, runs: judged,
    notes: ['L3 (airflow) is the maintainer confirmation recorded in the launcher session, not machine-checked', 'an INVALID run fails the check; there is no rerun'] };
}
