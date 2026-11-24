import { requirementViolations, type HostRecord } from '../../harness-core/host-record.ts';
import { blockThermal, median, type BlockThermal, type MeasuredWindow, type SampleLine } from '../../harness-core/thermal.ts';
import type { PgbenchWindow } from './probe.ts';
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
// Lateness allowed on one tick. The launcher schedules tick k at k x 5 s on its monotonic clock (no
// drift), so a tick is late only by event-loop delay, which does not add up across ticks. Every gap
// must be at most 5 s + this, and a block needs at least floor((window - this - clock spread) / 5 s)
// ticks: the fewest a 5 s cadence with that lateness can place in the window. A slower period, a
// drifting timer or a missed tick fails one of the two.
export const tickToleranceMs = 500;
// A measured run whose wall length differs from its monotonic length by more, or a block along whose
// thermal ticks wall minus monotonic moves by more, has a clock step. A synchronised clock is slewed
// by at most 500 ppm (adjtimex), 65 ms over a 130 s run, so only a step, or a clock off by a second
// or more, reaches it.
export const clockStepToleranceMs = 1000;
// pgbench stamps its log with monotonic time plus a wall offset taken at its start, the sampler with
// wall time at each tick; a step under the tolerance above can shift one against the other by up to
// it. The ticks within this of either end of pgbench's window are therefore never counted, so a tick
// taken outside the measurement cannot enter it; only ticks taken inside it are judged.
export const windowGuardMs = clockStepToleranceMs;
// pgbench -T counts from its benchmark start, and its first transaction starts within milliseconds of
// it (local connections), so its own interval is never shorter than -T by this much unless it was cut.
export const pgbenchShortfallMs = 1000;
// The workload label final.ts puts on its container; the session must have used it for the cleanup.
export const workloadLabel = 'io.fukulow.probe=519-final';

type Observation = { busy?: unknown; otherContainers?: unknown };
type Send = {
  order: number; arm: string; tps: number; walBytesPerSend: number; crossed: boolean; errors?: string[];
  measuredWindow?: MeasuredWindow; pgbenchWindow?: PgbenchWindow | null; host?: Observation | null; hostAfter?: Observation | null;
};
// Every launcher record carries the id of the launcher session that wrote it (launchSession).
type Bound = { launchSession?: unknown };
export type LaunchCheck = (Bound & { ok?: boolean; tctlC?: number | null; record?: HostRecord }) | null;
export type Cooldown = (Bound & { ok?: boolean; maxTctlC?: number; maxWaitSeconds?: number; readings?: { elapsedMs?: number; tctlC?: number | null }[] }) | null;
export type RunInput = {
  name: string; out: string; complete: boolean; statusSession: unknown; sends: Send[];
  metadata: { mode?: string; sendsOnly?: boolean; launchSession?: unknown; cpuSets: { server: number[]; client: number[] } | null; sends: { measuredSeconds: number } };
  hostBefore: (HostRecord & Bound) | null; cooldown: Cooldown; launchCheck: LaunchCheck;
  samples: SampleLine[];
};
// What the judged launcher session says: its id, and the sampling period it actually used for the run.
export type Binding = { id: string | null; thermalSampleSeconds: unknown };

const observationProblems = (o: Observation | null | undefined, when: string) => {
  if (o === null || typeof o !== 'object') return [`no host observation ${when}`];
  const p: string[] = [];
  if (o.busy !== false) p.push(`host busy ${when}`);
  if (!Array.isArray(o.otherContainers)) p.push(`no container list ${when}`);
  else if (o.otherContainers.length > 0) p.push(`other containers ${when}`);
  return p;
};

// The thermal window is pgbench's own interval (from its log). The wrapper around the run exposes a
// clock step and must contain that interval, which ties pgbench's stamps to this run.
function windowProblems(s: Send, measuredSeconds: number): string[] {
  const w = s.measuredWindow;
  const g = s.pgbenchWindow;
  const p: string[] = [];
  if (!w || ![w.startMs, w.endMs, w.monoMs].every(Number.isFinite)) p.push('no measured window');
  else if (Math.abs(w.endMs - w.startMs - w.monoMs) > clockStepToleranceMs) p.push(`wall clock stepped (${w.endMs - w.startMs} ms wall, ${Math.round(w.monoMs)} ms monotonic)`);
  if (!g || ![g.startMs, g.endMs].every(Number.isFinite)) return [...p, 'no pgbench window'];
  if (w && (g.startMs < w.startMs || g.endMs > w.endMs)) p.push('pgbench window outside the measured run');
  if (g.endMs - g.startMs < measuredSeconds * 1000 - pgbenchShortfallMs) p.push(`pgbench ran ${Math.round(g.endMs - g.startMs)} ms, not ${measuredSeconds} s`);
  return p;
}

// Every artefact must come from the one session being judged; a missing or other id is INVALID.
function bindingProblems(r: RunInput, id: string | null): string[] {
  const p: string[] = [];
  const own = (v: unknown) => id !== null && v === id;
  const named: [string, unknown][] = [['metadata.json', r.metadata.launchSession], ['status.json', r.statusSession], ['host-before', r.hostBefore?.launchSession],
    ['cool-down', r.cooldown?.launchSession], ['launch check', r.launchCheck?.launchSession]];
  for (const [what, v] of named) if (!own(v)) p.push(`${what} is not from launcher session ${id ?? '(none)'}`);
  const foreign = r.samples.filter(s => !own(s.launchSession)).length;
  if (foreign > 0) p.push(`${foreign} thermal lines not from launcher session ${id ?? '(none)'}`);
  return p;
}

const empty: BlockThermal = { samples: 0, failed: 0, ticks: 0, windowMs: NaN, maxGapMs: Infinity, monoComplete: false, offsetSpreadMs: NaN, server: null, client: null, maxTctlC: null };

export function judgeRun(r: RunInput, bound: Binding) {
  const invalid: string[] = bindingProblems(r, bound.id);
  if (!r.complete) invalid.push('run did not complete');
  if (r.metadata.mode !== 'diagnostic' || r.metadata.sendsOnly !== true) invalid.push('not the #519 send diagnosis (--diagnostic --sends-only)');
  if (r.sends.length !== blocksPerRun) invalid.push(`${r.sends.length} blocks, not ${blocksPerRun}`);
  const measured = r.metadata.sends.measuredSeconds;
  for (const s of r.sends) {
    for (const e of s.errors ?? []) invalid.push(`block ${s.order}: ${e}`);
    if (s.crossed) invalid.push(`block ${s.order}: crossed a checkpoint`);
    for (const p of [...observationProblems(s.host, 'before'), ...observationProblems(s.hostAfter, 'after')]) invalid.push(`block ${s.order}: ${p}`);
    for (const p of windowProblems(s, measured)) invalid.push(`block ${s.order}: ${p}`);
  }
  if (r.hostBefore === null) invalid.push('no host record before the run');
  else invalid.push(...requirementViolations(r.hostBefore, levers).map(v => `lever: ${v}`));
  if (r.cooldown?.ok !== true || r.cooldown.maxTctlC !== cooldown.maxTctlC || r.cooldown.maxWaitSeconds !== cooldown.maxWaitSeconds) {
    invalid.push(`lever: no passed cool-down gate (Tctl <= ${cooldown.maxTctlC} °C within ${cooldown.maxWaitSeconds} s)`);
  } else {
    const last = r.cooldown.readings?.at(-1);
    if (!(typeof last?.elapsedMs === 'number' && last.elapsedMs <= cooldown.maxWaitSeconds * 1000 && typeof last.tctlC === 'number' && last.tctlC <= cooldown.maxTctlC)) {
      invalid.push(`lever: the cool-down's accepted reading is not <= ${cooldown.maxTctlC} °C within ${cooldown.maxWaitSeconds} s`);
    }
  }
  const lc = r.launchCheck;
  if (lc?.ok !== true || typeof lc.tctlC !== 'number' || lc.tctlC > cooldown.maxTctlC || !lc.record) invalid.push(`lever: no passed launch check (Tctl <= ${cooldown.maxTctlC} °C right before the start)`);
  else invalid.push(...requirementViolations(lc.record, levers).map(v => `lever at launch: ${v}`));
  if (bound.thermalSampleSeconds !== sampleSeconds) invalid.push(`thermal samples every ${String(bound.thermalSampleSeconds ?? '(none)')} s in the launcher session, not ${sampleSeconds} s`);
  const unplaced = r.samples.filter(s => s.at === null).length;
  if (unplaced > 0) invalid.push(`${unplaced} thermal lines without a time`);
  const sets = r.metadata.cpuSets;
  if (sets === null) invalid.push('no CPU sets in the run metadata');
  const blocks = [...r.sends].sort((a, b) => a.order - b.order).map(s => {
    const w = s.pgbenchWindow;
    const t = sets && w ? blockThermal(r.samples, w.startMs, w.endMs, sets, windowGuardMs) : empty;
    return { order: s.order, arm: s.arm, tps: s.tps, walBytesPerSend: s.walBytesPerSend, thermal: t };
  });
  for (const b of blocks) {
    if (b.thermal.failed > 0) invalid.push(`block ${b.order}: ${b.thermal.failed} failed thermal samples`);
    const t = b.thermal;
    if (!t.monoComplete) invalid.push(`block ${b.order}: thermal ticks without a monotonic stamp`);
    else if (!(t.offsetSpreadMs <= clockStepToleranceMs)) invalid.push(`block ${b.order}: wall clock stepped against the sampler's monotonic clock (${Math.round(t.offsetSpreadMs)} ms)`);
    if (!(t.maxGapMs <= sampleSeconds * 1000 + tickToleranceMs)) invalid.push(`block ${b.order}: missing ${sampleSeconds} s thermal tick (gap ${t.maxGapMs} ms)`);
    const expected = Math.floor((t.windowMs - tickToleranceMs - (Number.isFinite(t.offsetSpreadMs) ? t.offsetSpreadMs : 0)) / (sampleSeconds * 1000));
    if (!(t.ticks >= expected)) invalid.push(`block ${b.order}: ${t.ticks} thermal ticks, fewer than the ${expected} of a ${sampleSeconds} s cadence`);
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

export function judge(runs: RunInput[], session: Session | null, queue: string) {
  const id = typeof session?.id === 'string' && session.id.trim() !== '' ? session.id : null;
  // The sampling period is the launcher's own record of the run, never the queue handed to the judge.
  const judged = runs.map(r => judgeRun(r, { id, thermalSampleSeconds: session?.jobs?.find(j => j.name === r.name)?.thermalSampleSeconds }));
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
