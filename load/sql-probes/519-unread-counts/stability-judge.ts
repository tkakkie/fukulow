import { requirementViolations, type HostRecord } from '../../harness-core/host-record.ts';
import { blockThermal, median, type BlockThermal, type MeasuredWindow, type SampleLine } from '../../harness-core/thermal.ts';
import type { Session } from '../../launcher/launcher.ts';

// Second #796 stability check (pre-registered on #796 and approved 2026-11-24, before any run):
// 3 consecutive runs of the #519 send diagnosis with cooling levers L1 (fan full speed), L2 (boost
// off), L3 (airflow, confirmed by the maintainer and recorded in the launcher session) and L5
// (cool-down gate). Pass criteria are the first check's. The lever, procedure and throttle rules
// can only fail a run.

export const levers = { boost: '0', policyBoost: '0', platformProfile: 'performance', fanControl: { 'hp/pwm1_enable': 0 } };
export const cooldown = { maxTctlC: 50, maxWaitSeconds: 1200 };
export const sampleSeconds = 5;
export const runsRequired = 3;
export const blocksPerRun = 6;
export const limits = { tpsSpread: 0.05, walSpread: 0.02, throttle: 0.05 };
// Timer jitter allowed on a 5 s tick; a missed tick (a 10 s gap) is never allowed.
export const tickToleranceMs = 1000;
// A measured window whose wall length differs from its monotonic length by more is a clock step.
export const clockStepToleranceMs = 1000;
// pgbench start-up (docker exec, connections) inside the window; a longer window is not the measurement.
export const windowSlackSeconds = 10;

type Observation = { busy?: unknown; otherContainers?: unknown };
type Send = {
  order: number; arm: string; tps: number; walBytesPerSend: number; crossed: boolean; errors?: string[];
  measuredWindow?: MeasuredWindow; host?: Observation | null; hostAfter?: Observation | null;
};
export type LaunchCheck = { ok?: boolean; tctlC?: number | null; record?: HostRecord } | null;
export type RunInput = {
  name: string; complete: boolean; sends: Send[];
  metadata: { mode?: string; sendsOnly?: boolean; cpuSets: { server: number[]; client: number[] } | null; sends: { measuredSeconds: number } };
  hostBefore: HostRecord | null; cooldown: { ok?: boolean; maxTctlC?: number; maxWaitSeconds?: number } | null; launchCheck: LaunchCheck;
  samples: SampleLine[]; thermalSampleSeconds: number | undefined;
};

const observationProblems = (o: Observation | null | undefined, when: string) => {
  if (o === null || typeof o !== 'object') return [`no host observation ${when}`];
  const p: string[] = [];
  if (o.busy !== false) p.push(`host busy ${when}`);
  if (!Array.isArray(o.otherContainers)) p.push(`no container list ${when}`);
  else if (o.otherContainers.length > 0) p.push(`other containers ${when}`);
  return p;
};

function windowProblems(w: MeasuredWindow | undefined, measuredSeconds: number): string[] {
  if (!w || ![w.startMs, w.endMs, w.monoMs].every(Number.isFinite)) return ['no measured window'];
  const p: string[] = [];
  if (Math.abs(w.endMs - w.startMs - w.monoMs) > clockStepToleranceMs) p.push(`wall clock stepped (${w.endMs - w.startMs} ms wall, ${Math.round(w.monoMs)} ms monotonic)`);
  if (w.monoMs < measuredSeconds * 1000 || w.monoMs > (measuredSeconds + windowSlackSeconds) * 1000) p.push(`measured window ${Math.round(w.monoMs)} ms is not ${measuredSeconds} s (+${windowSlackSeconds} s)`);
  return p;
}

const empty: BlockThermal = { samples: 0, failed: 0, maxGapMs: Infinity, server: null, client: null, maxTctlC: null };

export function judgeRun(r: RunInput) {
  const invalid: string[] = [];
  if (!r.complete) invalid.push('run did not complete');
  if (r.metadata.mode !== 'diagnostic' || r.metadata.sendsOnly !== true) invalid.push('not the #519 send diagnosis (--diagnostic --sends-only)');
  if (r.sends.length !== blocksPerRun) invalid.push(`${r.sends.length} blocks, not ${blocksPerRun}`);
  const measured = r.metadata.sends.measuredSeconds;
  for (const s of r.sends) {
    for (const e of s.errors ?? []) invalid.push(`block ${s.order}: ${e}`);
    if (s.crossed) invalid.push(`block ${s.order}: crossed a checkpoint`);
    for (const p of [...observationProblems(s.host, 'before'), ...observationProblems(s.hostAfter, 'after')]) invalid.push(`block ${s.order}: ${p}`);
    for (const p of windowProblems(s.measuredWindow, measured)) invalid.push(`block ${s.order}: ${p}`);
  }
  if (r.hostBefore === null) invalid.push('no host record before the run');
  else invalid.push(...requirementViolations(r.hostBefore, levers).map(v => `lever: ${v}`));
  if (r.cooldown?.ok !== true || r.cooldown.maxTctlC !== cooldown.maxTctlC || r.cooldown.maxWaitSeconds !== cooldown.maxWaitSeconds) {
    invalid.push(`lever: no passed cool-down gate (Tctl <= ${cooldown.maxTctlC} °C within ${cooldown.maxWaitSeconds} s)`);
  }
  const lc = r.launchCheck;
  if (lc?.ok !== true || typeof lc.tctlC !== 'number' || lc.tctlC > cooldown.maxTctlC || !lc.record) invalid.push(`lever: no passed launch check (Tctl <= ${cooldown.maxTctlC} °C right before the start)`);
  else invalid.push(...requirementViolations(lc.record, levers).map(v => `lever at launch: ${v}`));
  if (r.thermalSampleSeconds !== sampleSeconds) invalid.push(`thermal samples every ${r.thermalSampleSeconds ?? '(none)'} s, not ${sampleSeconds} s`);
  const unplaced = r.samples.filter(s => s.at === null).length;
  if (unplaced > 0) invalid.push(`${unplaced} thermal lines without a time`);
  const sets = r.metadata.cpuSets;
  if (sets === null) invalid.push('no CPU sets in the run metadata');
  const blocks = [...r.sends].sort((a, b) => a.order - b.order).map(s => {
    const w = s.measuredWindow;
    const t = sets && w ? blockThermal(r.samples, w.startMs, w.endMs, sets) : empty;
    return { order: s.order, arm: s.arm, tps: s.tps, walBytesPerSend: s.walBytesPerSend, thermal: t };
  });
  for (const b of blocks) {
    if (b.thermal.failed > 0) invalid.push(`block ${b.order}: ${b.thermal.failed} failed thermal samples`);
    if (!(b.thermal.maxGapMs <= sampleSeconds * 1000 + tickToleranceMs)) invalid.push(`block ${b.order}: missing ${sampleSeconds} s thermal tick (gap ${b.thermal.maxGapMs} ms)`);
    if (b.thermal.server === null || b.thermal.client === null) invalid.push(`block ${b.order}: unreadable CPU frequency`);
  }
  const first = blocks[0]?.thermal;
  for (const b of blocks.slice(1)) {
    for (const set of ['server', 'client'] as const) {
      const base = first?.[set]?.medianKHz;
      const got = b.thermal[set]?.medianKHz;
      if (base !== undefined && got !== undefined && got < base * (1 - limits.throttle)) {
        invalid.push(`block ${b.order}: throttled, ${set} median ${Math.round(got)} kHz < ${100 - limits.throttle * 100} % of block 1 (${Math.round(base)} kHz)`);
      }
    }
  }
  const arm = (a: string) => ({ tps: median(blocks.filter(b => b.arm === a).map(b => b.tps)), wal: median(blocks.filter(b => b.arm === a).map(b => b.walBytesPerSend)) });
  return { name: r.name, valid: invalid.length === 0, invalid, current: arm('current'), final: arm('final'), blocks };
}

// The runs must be the jobs of one completed launcher session that released HOST-BUSY, each with
// the maintainer's L3 airflow confirmation recorded.
export function sessionProblems(session: Session | null, queue: string, names: string[]): string[] {
  if (session === null) return ['no launcher session record'];
  const p: string[] = [];
  if (session.queue !== queue) p.push(`session is for queue ${session.queue}, not ${queue}`);
  if (session.outcome !== 'done') p.push(`launcher session did not complete (${session.outcome}${session.reason ? `: ${session.reason}` : ''})`);
  if (session.hostBusy !== 'released') p.push(`HOST-BUSY ${session.hostBusy}, not released`);
  const ran = (session.jobs ?? []).map(j => j.name);
  if (ran.join('\n') !== names.join('\n')) p.push(`session ran ${ran.join(', ') || '(nothing)'}, not ${names.join(', ')}`);
  for (const j of session.jobs ?? []) {
    if (j.exit !== 0) p.push(`${j.name} exited ${j.exit}`);
    const airflow = j.confirmations?.airflow;
    if (!airflow?.quote?.trim() || !airflow.date?.trim()) p.push(`${j.name}: no L3 airflow confirmation in the session`);
  }
  return p;
}

const spread = (xs: number[]) => (Math.max(...xs) - Math.min(...xs)) / median(xs);

export function judge(runs: RunInput[], session: Session | null, queue: string) {
  const judged = runs.map(judgeRun);
  const reasons: string[] = sessionProblems(session, queue, runs.map(r => r.name));
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
