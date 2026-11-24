import { requirementViolations, type HostRecord } from '../../harness-core/host-record.ts';
import { blockThermal, exactFraction, median, type BlockThermal, type MeasuredWindow, type SampleLine } from '../../harness-core/thermal.ts';
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
// Frequency judgement (maintainer decision on PR #875, 2026-11-24, F1-F7, option A: both sets). An idle
// CPU reads the cpuinfo_min_freq placeholder, so only active readings are judged. A CPU is active in a
// tick when its /proc/stat busy fraction since the previous tick is >= minBusy (F1, F2). It qualifies in
// a block when active in >= minTickShare of the block's ticks; its block value is the median of its
// active readings (F3). A set needs >= minCpuShare of its CPUs qualifying, else the block is INVALID
// (F4). Throttle (F5): over the CPUs qualifying in both block 1 and block k (again >= minCpuShare of the
// set, else INVALID), block k is throttled when the median of per-CPU value ratios k / 1 is
// < 1 - limits.throttle; exactly 5.0 % is allowed. Comparing each CPU with itself keeps a change in
// which CPUs are busy from looking like throttling. Missing data is INVALID (F6, blockThermal). Every
// threshold is compared exactly in integers (exactFraction), never through floating-point rounding.
export const activity = { minBusy: 0.5, minTickShare: 0.5, minCpuShare: 0.5 };
// Lateness allowed on one tick. The launcher schedules tick k at k x 5 s on its monotonic clock (no
// drift), so a tick is late only by event-loop delay, which does not add up across ticks. Every gap
// must be at most 5 s + this, and a block needs at least floor((window - this - clock spread) / 5 s)
// ticks: the fewest a 5 s cadence with that lateness can place in the window. A slower period, a
// drifting timer or a missed tick fails one of the two.
export const tickToleranceMs = 500;
// Clock step (maintainer decision on PR #875, 2026-11-24, option A). Wall minus monotonic time may move
// by at most this much: across a measured run (the probe's own clocks), and along a block's thermal ticks
// (the sampler's). More is a wall-clock step and the run is INVALID, never judged. pgbench stamps its
// log with monotonic time plus a wall offset taken at its start, the sampler each tick with wall time,
// so a step between them would misplace ticks against pgbench's window; with both checks passed, every
// tick inside that window is counted, none dropped near an edge.
export const clockStepToleranceMs = 50;
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
// The launcher's journal check for wall-clock set events during the job (PR #875, option 1b).
export type ClockEvents = (Bound & { ok?: boolean; events?: unknown; problem?: unknown }) | null;
export type Cooldown = (Bound & { ok?: boolean; maxTctlC?: number; maxWaitSeconds?: number; readings?: { elapsedMs?: number; tctlC?: number | null }[] }) | null;
export type RunInput = {
  name: string; out: string; complete: boolean; statusSession: unknown; sends: Send[];
  metadata: { mode?: string; sendsOnly?: boolean; launchSession?: unknown; cpuSets: { server: number[]; client: number[] } | null; sends: { measuredSeconds: number } };
  hostBefore: (HostRecord & Bound) | null; cooldown: Cooldown; launchCheck: LaunchCheck; clockEvents: ClockEvents;
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
    ['cool-down', r.cooldown?.launchSession], ['launch check', r.launchCheck?.launchSession], ['clock events', r.clockEvents?.launchSession]];
  for (const [what, v] of named) if (!own(v)) p.push(`${what} is not from launcher session ${id ?? '(none)'}`);
  const foreign = r.samples.filter(s => !own(s.launchSession)).length;
  if (foreign > 0) p.push(`${foreign} thermal lines not from launcher session ${id ?? '(none)'}`);
  return p;
}

const unsampled = { cpus: [], problem: 'no thermal window' };
const empty: BlockThermal = { samples: 0, failed: 0, ticks: 0, windowMs: NaN, maxGapMs: Infinity, monoComplete: false, offsetSpreadMs: NaN, server: unsampled, client: unsampled, maxTctlC: null };
type CpuSet = 'server' | 'client';

// The qualifying CPUs of a set in a block (F3), by CPU number with twice their block value (the sum
// of the two middle active readings), so ratios stay exact integers.
// n / total >= share, in integers (no rounding at the boundary).
const atLeast = (n: number, total: number, share: number) => { const [a, b] = exactFraction(share); return BigInt(n) * b >= a * BigInt(total); };
function qualifying(t: BlockThermal, set: CpuSet): Map<number, bigint> {
  return new Map(t[set].cpus.flatMap(c => (c.mid !== null && atLeast(c.activeTicks, t.ticks, activity.minTickShare) ? [[c.cpu, BigInt(c.mid[0]) + BigInt(c.mid[1])] as const] : [])));
}

type Ratio = [bigint, bigint]; // numerator, positive denominator
const below = (a: Ratio, b: Ratio) => a[0] * b[1] < b[0] * a[1];
// The median of exact ratios as an exact ratio: the middle one, or the mean of the two middle ones.
function medianRatio(rs: Ratio[]): Ratio {
  const s = [...rs].sort((a, b) => (below(a, b) ? -1 : below(b, a) ? 1 : 0));
  const [a, b] = [s[(s.length - 1) >> 1], s[s.length >> 1]];
  return [a[0] * b[1] + b[0] * a[1], 2n * a[1] * b[1]];
}
// A ratio rounded down to 4 decimals, so a printed "x < limit" is always true.
const floor4 = (r: Ratio) => (Number((r[0] * 10_000n) / r[1]) / 10_000).toFixed(4);

// F4 and F5 for one set over the run's blocks. The baseline is block 1 itself: without it nothing is
// compared and the run is INVALID. An empty or malformed set is INVALID, never judged as passing.
function frequencyProblems(blocks: { order: number; thermal: BlockThermal }[], set: CpuSet, cpus: number[]): string[] {
  const size = cpus.length;
  if (size === 0 || new Set(cpus).size !== size || !cpus.every(c => Number.isSafeInteger(c) && c >= 0)) return [`${set} set is empty or not distinct CPU numbers: [${cpus.join(',')}]`];
  const p: string[] = [];
  const enough = (n: number) => atLeast(n, size, activity.minCpuShare);
  const judgeable = blocks.map(b => {
    const a = b.thermal[set];
    if (a.problem !== null) { p.push(`block ${b.order}: ${set} set: ${a.problem}`); return null; }
    const q = qualifying(b.thermal, set);
    if (!enough(q.size)) { p.push(`block ${b.order}: too few active CPUs to judge frequency, ${set} set ${q.size} of ${size} qualify`); return null; }
    return q;
  });
  const i1 = blocks.findIndex(b => b.order === 1);
  if (i1 < 0) return [...p, `${set} set: no block 1 to compare frequency with`];
  const base = judgeable[i1];
  if (!base) return p; // block 1 is already INVALID; nothing to compare with
  const keep = exactFraction(1 - limits.throttle);
  for (const [i, b] of blocks.entries()) {
    const got = judgeable[i];
    if (i === i1 || !got) continue;
    const ratios = [...got].flatMap(([cpu, v]): Ratio[] => (base.has(cpu) ? [[v, base.get(cpu)!]] : []));
    if (!enough(ratios.length)) { p.push(`block ${b.order}: ${set} set: ${ratios.length} of ${size} CPUs qualify in both block 1 and this block, too few to compare`); continue; }
    const m = medianRatio(ratios);
    if (below(m, keep)) p.push(`block ${b.order}: throttled, ${set} median per-CPU ratio ${floor4(m)} < ${1 - limits.throttle} of block 1 (${ratios.length} CPUs)`);
  }
  return p;
}

export function judgeRun(r: RunInput, bound: Binding) {
  const invalid: string[] = bindingProblems(r, bound.id);
  if (!r.complete) invalid.push('run did not complete');
  if (r.metadata.mode !== 'diagnostic' || r.metadata.sendsOnly !== true) invalid.push('not the #519 send diagnosis (--diagnostic --sends-only)');
  if (r.sends.length !== blocksPerRun) invalid.push(`${r.sends.length} blocks, not ${blocksPerRun}`);
  const orders = r.sends.map(s => s.order).sort((a, b) => a - b);
  if (orders.join() !== Array.from({ length: r.sends.length }, (_, i) => i + 1).join()) invalid.push(`blocks numbered ${orders.join(',')}, not 1 to ${r.sends.length}`);
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
  const ce = r.clockEvents;
  if (ce?.ok !== true || !Array.isArray(ce.events)) invalid.push(`no readable journal clock check for the run (${String(ce?.problem ?? 'missing')})`);
  else if (ce.events.length > 0) invalid.push(`wall clock set during the run: ${ce.events.join(' | ')}`);
  if (bound.thermalSampleSeconds !== sampleSeconds) invalid.push(`thermal samples every ${String(bound.thermalSampleSeconds ?? '(none)')} s in the launcher session, not ${sampleSeconds} s`);
  const unplaced = r.samples.filter(s => s.at === null).length;
  if (unplaced > 0) invalid.push(`${unplaced} thermal lines without a time`);
  const sets = r.metadata.cpuSets;
  if (sets === null) invalid.push('no CPU sets in the run metadata');
  const blocks = [...r.sends].sort((a, b) => a.order - b.order).map(s => {
    const w = s.pgbenchWindow;
    const t = sets && w ? blockThermal(r.samples, w.startMs, w.endMs, sets, activity.minBusy) : empty;
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
  }
  if (sets) for (const set of ['server', 'client'] as const) invalid.push(...frequencyProblems(blocks, set, sets[set]));
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
