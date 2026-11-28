import { cappedPolicy, counterWork, referenceRates, reportWork, same, setNames, sets796, validatePolicy,
  type CounterBlock, type CpuWork, type FrequencyEvidence, type SetName } from './frequency-evidence.ts';
import { below, keepFrequency, medianBounds, medianRatio, multiply, restore, store, type Ratio, type StoredRatio } from './frequency-ratios.ts';
import { assessReference, referenceRequired } from './frequency-reference.ts';
import { diagnostic } from './frequency-housekeeping.ts';
import { housekeepingReport } from './frequency-housekeeping-report.ts';
import type { CpuSets } from '../../harness-core/cpusets.ts';
import { halfSet, matches796 } from '../../harness-core/frequency-layout.ts';

export type Floors = Record<SetName, StoredRatio>;
export type FrequencyBlock = { order: number; pgbenchWindow?: { startMs: number; endMs: number } | null; counters?: CounterBlock };
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

function calibration(sets: CpuSets | null, evidence: FrequencyEvidence | null | undefined, session: string | null) {
  if (!evidence) throw new Error('F6 no calibrated counter evidence');
  if (session === null || evidence.startSession !== session || evidence.endSession !== session) throw new Error('F1 calibration or policy snapshots from another session');
  if (!matches796(sets)) throw new Error('F4 unexpected CPU sets');
  const rates = referenceRates(evidence.calibration);
  validatePolicy(evidence.before, evidence.calibration.identity);
  if (!same(evidence.before, evidence.after)) throw new Error('F1 policy changed between launch and completion');
  return { rates, evidence };
}

function checkCounterEvidence(blocks: FrequencyBlock[], host: ReturnType<typeof calibration>, session: string | null,
  control: boolean, reasons: string[]) {
  const referenceReasons: string[] = [];
  const seenIds = new Set<string>();
  let previousClose = 0n;
  const claimIds = (window: Pick<CounterBlock, 'open'>) => {
    const ids = window.open.reads.flatMap(cpu => [cpu.aperfId, cpu.mperfId]);
    if (ids.some(id => seenIds.has(id))) throw new Error('F1 reused event IDs or stale block');
    ids.forEach(id => seenIds.add(id));
  };
  const judged = [...blocks].sort((a, b) => a.order - b.order).map(b => {
    const raw = b.counters;
    const policy = control && b.order === 2 ? cappedPolicy(host.evidence.before) : host.evidence.before;
    const context = [session, host.evidence.calibration.identity, policy, host.rates] as const;
    const prior = previousClose;
    let spans: ReturnType<typeof counterWork> = { work: [], fullSpan: [], idle: null };
    try {
      if (!raw || !b.pgbenchWindow) throw new Error('F6 missing counters or pgbench window');
      const w = counterWork(raw, b.order, b.pgbenchWindow.endMs - b.pgbenchWindow.startMs, ...context, control);
      if (BigInt(raw.open.reads[0].monoNs) <= prior) throw new Error('F1 reused event IDs or stale block');
      claimIds(raw);
      previousClose = BigInt(raw.close.reads.at(-1)!.monoNs);
      spans = w;
    } catch (err) { reasons.push(`block ${b.order}: ${errorText(err)}`); }

    let reference: ReturnType<typeof assessReference> | null = null;
    let referenceHousekeeping: ReturnType<typeof housekeepingReport> = null;
    try {
      const window = raw?.reference;
      if (referenceRequired(b.order, control) !== Boolean(window)) throw new Error(window ? 'unexpected settled reference' : 'missing settled reference');
      if (raw && window) {
        const assessed = assessReference(window, b.order, ...context);
        if (BigInt(window.checkpointNs) <= prior || BigInt(window.close.reads.at(-1)!.monoNs) >= BigInt(raw.open.reads[0].monoNs)) {
          throw new Error('stale reference or overlap with measured block');
        }
        claimIds(window);
        reference = assessed;
        referenceReasons.push(...reference.reasons);
        // The normalized values belong to the STOP rule. Attribution uses the observed C0.
        referenceHousekeeping = diagnostic(() => housekeepingReport(
          assessed.cpus.map(({ c0Ns: [n, d] }) => ({ c0Ns: [BigInt(n), BigInt(d)] })), window.housekeeping));
      }
    } catch (err) { referenceReasons.push(`reference ${b.order}: ${errorText(err)}`); }
    return { order: b.order, raw, ...spans, reference, referenceHousekeeping };
  });
  reasons.push(...referenceReasons);
  return judged;
}

export function checkFrequencyEvidence(blocks: FrequencyBlock[], sets: CpuSets | null, evidence: FrequencyEvidence | null | undefined,
  session: string | null, control: boolean) {
  const reasons: string[] = [];
  let host: ReturnType<typeof calibration>;
  try { host = calibration(sets, evidence, session); }
  catch (err) { return { reasons: [errorText(err)], host: null, judged: [] }; }
  const judged = checkCounterEvidence(blocks, host, session, control, reasons);
  return { reasons, host, judged };
}

const ratio = (w: CpuWork, base: CpuWork): Ratio => [w.aperf * base.mperf, w.mperf * base.aperf];
type Judged = ReturnType<typeof checkCounterEvidence>[number];

function judgeSet(b: Judged, base: Judged | undefined, set: SetName, floors: Floors | null,
  proposed: Partial<Floors>, capped: boolean, reasons: string[]) {
  const label = `block ${b.order}:`;
  const cpus = sets796[set];
  const minimum = halfSet(cpus);
  const qualifying = b.work.filter(w => cpus.includes(w.cpu) && w.qualifies);
  const cohort = base?.work.filter(w => cpus.includes(w.cpu) && w.qualifies) ?? [];
  const common = cohort.flatMap(w => {
    const current = qualifying.find(q => q.cpu === w.cpu);
    return current ? [{ cpu: w.cpu, ratio: ratio(current, w) }] : [];
  });
  if (qualifying.length < minimum) reasons.push(`${label} F4 ${set} coverage ${qualifying.length}/${cpus.length}`);
  if (common.length < minimum) reasons.push(`${label} F4 ${set} common coverage ${common.length}/${cpus.length}`);
  const medianHz = qualifying.length ? medianRatio(qualifying.map(w => w.busyHz!)) : null;
  let floorMet: boolean | null = null;
  if (b.order === 1 && medianHz && qualifying.length >= minimum) {
    proposed[set] = store(multiply(keepFrequency, medianHz));
    if (floors) {
      try {
        floorMet = !below(medianHz, restore(floors[set]));
        if (!floorMet) reasons.push(`${label} floor ${set} below reviewed minimum`);
      } catch (err) { reasons.push(`${label} floor ${set} invalid (${errorText(err)})`); }
    }
  }
  const f5 = common.length >= minimum ? medianBounds(common.map(w => w.ratio), cohort.length) : null;
  const fullSpanF5 = capped && base && common.length >= minimum
    ? medianBounds(common.map(({ cpu }) => ratio(b.fullSpan[cpu], base.fullSpan[cpu])), cohort.length) : null;
  const throttled = b.order !== 1 && f5?.verdict === 'throttled';
  if (throttled) reasons.push(`${label} F5 throttled ${set}`);
  if (f5?.verdict === 'invalid') reasons.push(`${label} F5 ${set} median bounds straddle 19/20`);
  if (capped && f5?.verdict === 'clear') reasons.push(`${label} F5 ${set} work interval must show throttling`);
  if (capped && fullSpanF5?.verdict !== 'throttled') reasons.push(`${label} F5 ${set} full span must show throttling`);
  return { qualifying: qualifying.map(w => w.cpu), cohort: cohort.map(w => w.cpu), common: common.map(w => w.cpu),
    ratios: common.map(w => ({ cpu: w.cpu, ratio: store(w.ratio) })), f5, fullSpanF5,
    medianHz: medianHz && store(medianHz), floorMet, throttled };
}

export function judgeFrequency(blocks: FrequencyBlock[], sets: CpuSets | null, evidence: FrequencyEvidence | null | undefined,
  session: string | null, floors: Floors | null, control = false) {
  const { reasons, host, judged } = checkFrequencyEvidence(blocks, sets, evidence, session, control);
  if (!host) return { reasons, blocks: [], floorProposal: null, referenceHz: null };
  const base = judged.find(b => b.order === 1);
  if (!base) reasons.push('F4 missing block 1');
  const referenceTotals = judged.filter(b => referenceRequired(b.order, control)).map(b => b.referenceHousekeeping?.aggregateUsec);
  const maxReferenceAggregateUsec = referenceTotals.length === (control ? 3 : 1) && referenceTotals.every(x => x != null)
    ? Math.max(...referenceTotals) : null;
  const proposed: Partial<Floors> = {};
  const details = judged.map(b => {
    const sets = Object.fromEntries(setNames.map(set => [set, judgeSet(b, base, set, floors, proposed, control && b.order === 2, reasons)]));
    const work = b.work.length ? diagnostic(() => housekeepingReport(b.work, b.raw?.housekeeping)) : null;
    const idle = b.idle;
    const tail = idle && diagnostic(() => housekeepingReport(idle, b.raw?.housekeeping, 'tail'));
    const aggregateBurstRatio = maxReferenceAggregateUsec && work?.aggregateUsec != null ? work.aggregateUsec / maxReferenceAggregateUsec : null;
    return { order: b.order, raw: b.raw, cpus: b.work.map(reportWork), fullSpanCpus: b.fullSpan.map(reportWork),
      idle: b.idle?.map(reportWork) ?? null, reference: b.reference, sets,
      housekeeping: { work, tail, reference: b.referenceHousekeeping, maxReferenceAggregateUsec, aggregateBurstRatio } };
  });
  if (!control && !floors) reasons.push('block 1: reviewed frequency floors missing');
  return { reasons, blocks: details, referenceHz: host.rates.map(store),
    floorProposal: proposed.server && proposed.client ? { server: proposed.server, client: proposed.client } : null };
}
