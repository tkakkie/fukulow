// Judges individual #796 runs against their recorded evidence.
import { linuxViolations, requirementViolations, type HostRecord } from '../../harness-core/host-record.ts';
import { blockThermal, median, type BlockThermal, type MeasuredWindow, type SampleLine } from '../../harness-core/thermal.ts';
import type { PolicySnapshot } from '../../harness-core/cpu-policy.ts';
import type { PgbenchWindow } from './probe.ts';
import { judgeFrequency, type Floors } from './frequency-judge.ts';
import { affinityProblems, type Affinity } from './frequency-affinity.ts';
import { hostAffinityProblems, type HostAffinity } from './frequency-host-affinity.ts';
import type { CpuSets } from '../../harness-core/cpusets.ts';
import { same, type CounterBlock, type FrequencyEvidence } from './frequency-evidence.ts';
import { isQuote, type FrequencyStage } from './frequency-approval.ts';
import { legacyFrequencyProblems } from './legacy-frequency.ts';

// Second #796 stability check (pre-registered on #796 and approved 2026-11-24, before any run):
// 3 consecutive runs of the #519 send diagnosis with cooling levers L2 (boost off), L3 (airflow,
// confirmed by the maintainer and recorded in the launcher session) and L5 (cool-down gate). Pass
// criteria are the first check's. The lever, procedure and throttle rules can only fail a run.
// L1 (fan full speed) was dropped (maintainer decision on #796, 2026-11-24, option A: the firmware
// rejects the write), so the fan stays automatic: the host record keeps its mode and speeds, never judged.

export const levers = { boost: '0', policyBoost: '0', platformProfile: 'performance' };
export const cooldown = { maxTctlC: 50, maxWaitSeconds: 1200 };
export const sampleSeconds = 5;
export const blocksPerRun = 6;
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

type Observation = { busy?: unknown; otherContainers?: unknown };
type Send = {
  order: number; arm: string; tps: number; walBytesPerSend: number; crossed: boolean; errors?: string[];
  counters?: CounterBlock; affinity?: Affinity;
  measuredWindow?: MeasuredWindow; pgbenchWindow?: PgbenchWindow | null; host?: Observation | null; hostAfter?: Observation | null;
};
// Every launcher record carries the id of the launcher session that wrote it (launchSession).
type Bound = { launchSession?: unknown };
export type LaunchCheck = (Bound & { ok?: boolean; tctlC?: number | null; record?: HostRecord; frequencyPolicy?: PolicySnapshot }) | null;
// The launcher's journal check for wall-clock set events during the job (PR #875, option 1b).
export type ClockEvents = (Bound & { ok?: boolean; events?: unknown; problem?: unknown }) | null;
export type Cooldown = (Bound & { ok?: boolean; maxTctlC?: number; maxWaitSeconds?: number; readings?: { elapsedMs?: number; tctlC?: number | null }[] }) | null;
export type RunInput = {
  name: string; out: string; complete: boolean; statusSession: unknown; sends: Send[];
  metadata: { frequencyStage?: FrequencyStage; frequencyApproval?: string; frequencyGo?: { quote: string; date: string }; mode?: string; sendsOnly?: boolean; launchSession?: unknown; cpuSets: CpuSets | null; sends: { measuredSeconds: number } };
  hostBefore: (HostRecord & Bound) | null; cooldown: Cooldown; launchCheck: LaunchCheck; clockEvents: ClockEvents;
  samples: SampleLine[]; frequency?: FrequencyEvidence | null; hostAfter?: (HostRecord & Bound) | null;
  hostAffinity?: HostAffinity | null;
};
// What the judged launcher session says: its id, and the sampling period it actually used for the run.
export type Binding = { id: string | null; thermalSampleSeconds: unknown; go?: { quote: string; date: string } };

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
const empty: BlockThermal = { samples: 0, failed: 0, procFailed: 0, ticks: 0, windowMs: NaN, maxGapMs: Infinity, monoComplete: false, offsetSpreadMs: NaN, server: unsampled, client: unsampled, maxTctlC: null };
function judgeProcedure(r: RunInput, bound: Binding, count: number, legacy: boolean) {
  const invalid: string[] = bindingProblems(r, bound.id);
  if (!r.complete) invalid.push('run did not complete');
  if (r.metadata.mode !== 'diagnostic' || r.metadata.sendsOnly !== true) invalid.push('not the #519 send diagnosis (--diagnostic --sends-only)');
  if (r.sends.length !== count) invalid.push(`${r.sends.length} blocks, not ${count}`);
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
    const t = sets && w ? blockThermal(r.samples, w.startMs, w.endMs, sets, 0.5) : empty;
    return { order: s.order, arm: s.arm, tps: s.tps, walBytesPerSend: s.walBytesPerSend, thermal: t };
  });
  for (const b of blocks) {
    const failed = legacy ? b.thermal.failed : b.thermal.procFailed;
    if (failed > 0) invalid.push(`block ${b.order}: ${legacy ? '' : 'F6 '}${failed} failed thermal samples`);
    const t = b.thermal;
    if (!t.monoComplete) invalid.push(`block ${b.order}: thermal ticks without a monotonic stamp`);
    else if (!(t.offsetSpreadMs <= clockStepToleranceMs)) invalid.push(`block ${b.order}: wall clock stepped against the sampler's monotonic clock (${Math.round(t.offsetSpreadMs)} ms)`);
    if (!(t.maxGapMs <= sampleSeconds * 1000 + tickToleranceMs)) invalid.push(`block ${b.order}: missing ${sampleSeconds} s thermal tick (gap ${t.maxGapMs} ms)`);
    const expected = Math.floor((t.windowMs - tickToleranceMs - (Number.isFinite(t.offsetSpreadMs) ? t.offsetSpreadMs : 0)) / (sampleSeconds * 1000));
    if (!(t.ticks >= expected)) invalid.push(`block ${b.order}: ${t.ticks} thermal ticks, fewer than the ${expected} of a ${sampleSeconds} s cadence`);
  }
  const arm = (a: string) => ({ tps: median(blocks.filter(b => b.arm === a).map(b => b.tps)), wal: median(blocks.filter(b => b.arm === a).map(b => b.walBytesPerSend)) });
  return { name: r.name, valid: invalid.length === 0, invalid, current: arm('current'), final: arm('final'), blocks };
}

export function replayLegacyRun(r: RunInput, bound: Binding) {
  const procedural = judgeProcedure(r, bound, blocksPerRun, true);
  const sets = r.metadata.cpuSets;
  const legacy = sets ? (['server', 'client'] as const).flatMap(set => legacyFrequencyProblems(procedural.blocks, set, sets[set])) : [];
  const invalid = [...procedural.invalid, ...legacy];
  return { ...procedural, valid: invalid.length === 0, invalid, legacy };
}

export function judgeRun(r: RunInput, bound: Binding, floors: Floors | null, stage: FrequencyStage, approval?: string) {
  const control = stage === 'control';
  const p = judgeProcedure(r, bound, control ? 3 : blocksPerRun, false);
  const invalid = [...p.invalid];
  if (!isQuote(bound.go) || bound.go.quote !== r.metadata.frequencyGo?.quote || bound.go.date !== r.metadata.frequencyGo?.date) {
    invalid.push('no matching #796 go in the launcher session');
  }
  if (r.metadata.frequencyStage !== stage || r.metadata.frequencyApproval !== approval) invalid.push('wrong #796 stage or reviewed floor digest');
  const expectedArms = control ? 'current,current,current' : 'current,final,final,current,current,final';
  if ([...r.sends].sort((a, b) => a.order - b.order).map(s => s.arm).join(',') !== expectedArms) invalid.push('incorrect send arm order');
  if (r.metadata.sends.measuredSeconds !== 120) invalid.push('incorrect 120 s workload');
  if (!r.hostAfter || r.hostAfter.platform !== 'linux' || r.hostAfter.launchSession !== bound.id) invalid.push('missing launcher host-after record');
  else invalid.push(...linuxViolations(r.hostAfter), ...requirementViolations(r.hostAfter, levers));
  for (const s of r.sends) {
    if (stage === 'rehearsal2') invalid.push(...affinityProblems(s.affinity).map(problem => `block ${s.order}: ${problem}`));
    if (s.counters && s.measuredWindow) {
      try {
        const monotonicMs = Number(BigInt(s.counters.exitNs) - BigInt(s.counters.startNs)) / 1e6;
        if (monotonicMs !== s.measuredWindow.monoMs) invalid.push(`block ${s.order}: F2 perf/runner clock interval differs`);
      } catch { invalid.push(`block ${s.order}: F2 unreadable perf/runner interval`); }
    }
  }
  if (!r.launchCheck?.frequencyPolicy || !same(r.launchCheck.frequencyPolicy, r.frequency?.before)) {
    invalid.push('F1 launcher and run CPU policy snapshots differ');
  }
  invalid.push(...hostAffinityProblems(r.hostAffinity, bound.id, r.launchCheck?.frequencyPolicy?.bootId));
  const frequency = judgeFrequency(r.sends, r.metadata.cpuSets, r.frequency, bound.id, floors, control);
  if (control && !(r.frequency?.permissionCheck?.go.exit === 0 && same(r.frequency.permissionCheck.identity, r.frequency.calibration.identity))) {
    invalid.push('no passed permission check for the control collector');
  }
  const expected = control ? ['block 2: F5 throttled server', 'block 2: F5 throttled client'] : [];
  invalid.push(...frequency.reasons.filter(reason => !expected.includes(reason)));
  invalid.push(...expected.filter(reason => !frequency.reasons.includes(reason)).map(reason => `control failed to show ${reason}`));
  return { ...p, invalid, valid: invalid.length === 0, frequency };
}
