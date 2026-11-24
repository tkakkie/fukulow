import { counterWork, referenceRates, reportWork, same, setNames, sets796, validatePolicy,
  type CounterBlock, type FrequencyEvidence, type SetName } from './frequency-evidence.ts';
import { below, keepFrequency, medianRatio, multiply, restore, store, type Ratio, type StoredRatio } from './frequency-ratios.ts';
import type { CpuSets } from '../../harness-core/cpusets.ts';

export type Floors = Record<SetName, StoredRatio>;
export type FrequencyBlock = { order: number; pgbenchWindow?: { startMs: number; endMs: number } | null; counters?: CounterBlock };
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export function judgeFrequency(blocks: FrequencyBlock[], sets: CpuSets | null, evidence: FrequencyEvidence | null | undefined,
  session: string | null, floors: Floors | null, control = false) {
  const reasons: string[] = [];
  const calibrated = () => {
    if (!evidence) throw new Error('F6 no calibrated counter evidence');
    if (session === null || evidence.startSession !== session || evidence.endSession !== session) throw new Error('F1 calibration or policy snapshots from another session');
    if (!sets || !setNames.every(set => same(sets[set], sets796[set]))) throw new Error('F4 unexpected CPU sets');
    const rates = referenceRates(evidence.calibration);
    validatePolicy(evidence.before, evidence.calibration.identity);
    if (!same(evidence.before, evidence.after)) throw new Error('F1 policy changed between launch and completion');
    return { rates, evidence };
  };
  let host: ReturnType<typeof calibrated>;
  try { host = calibrated(); } catch (err) { return { reasons: [errorText(err)], blocks: [], floorProposal: null, referenceHz: null }; }
  const seenIds = new Set<string>();
  let previousClose = 0n;
  const judged = [...blocks].sort((a, b) => a.order - b.order).map(b => {
    try {
      if (!b.counters || !b.pgbenchWindow) throw new Error('F6 missing counters or pgbench window');
      const policy = control && b.order === 2
        ? { ...host.evidence.before, policies: host.evidence.before.policies.map(p => ({ ...p, max: '1700000' })) }
        : host.evidence.before;
      const w = counterWork(b.counters, b.order, b.pgbenchWindow.endMs - b.pgbenchWindow.startMs,
        session, host.evidence.calibration.identity, policy, host.rates, control);
      const ids = b.counters.open.reads.flatMap(cpu => [cpu.aperfId, cpu.mperfId]);
      if (ids.some(id => seenIds.has(id)) || BigInt(b.counters.open.reads[0].monoNs) <= previousClose) throw new Error('F1 reused event IDs or stale block');
      ids.forEach(id => seenIds.add(id));
      previousClose = BigInt(b.counters.close.reads.at(-1)!.monoNs);
      return { order: b.order, raw: b.counters, ...w };
    } catch (err) {
      reasons.push(`block ${b.order}: ${errorText(err)}`);
      return { order: b.order, raw: b.counters, work: [], idle: null };
    }
  });
  const base = judged.find(b => b.order === 1);
  if (!base) reasons.push('F4 missing block 1');
  const proposed: Partial<Floors> = {};
  const details = judged.map(b => {
    const idle = b.idle;
    if (idle?.cpusAtFloor.length) reasons.push(`block ${b.order}: projected idle-only C0 reached 20 ms on CPUs ${idle.cpusAtFloor.join(',')}`);
    const sets = setNames.map(set => {
      const qualified = b.work.filter(w => sets796[set].includes(w.cpu) && w.qualifies);
      const common = qualified.flatMap(w => {
        const x = base?.work.find(q => q.cpu === w.cpu && q.qualifies);
        return x ? [{ cpu: w.cpu, ratio: [w.aperf * x.mperf, w.mperf * x.aperf] as Ratio }] : [];
      });
      const medianHz = qualified.length > 0 ? medianRatio(qualified.map(w => w.busyHz!)) : null;
      if (qualified.length < 4) reasons.push(`block ${b.order}: F4 ${set} coverage ${qualified.length}/8`);
      if (common.length < 4) reasons.push(`block ${b.order}: F4 ${set} common coverage ${common.length}/8`);
      let floorMet: boolean | null = null;
      if (b.order === 1 && medianHz && qualified.length >= 4) {
        proposed[set] = store(multiply(keepFrequency, medianHz));
        if (floors) {
          try {
            floorMet = !below(medianHz, restore(floors[set]));
            if (!floorMet) reasons.push(`block 1: floor ${set} below reviewed minimum`);
          } catch (err) { reasons.push(`block 1: floor ${set} invalid (${errorText(err)})`); }
        }
      }
      const median = common.length >= 4 ? medianRatio(common.map(w => w.ratio)) : null;
      const throttled = b.order !== 1 && median !== null && below(median, keepFrequency);
      if (throttled) reasons.push(`block ${b.order}: F5 throttled ${set}`);
      return [set, { qualifying: qualified.map(w => w.cpu), common: common.map(w => w.cpu),
        ratios: common.map(w => ({ cpu: w.cpu, ratio: store(w.ratio) })), medianRatio: median && store(median),
        medianHz: medianHz && store(medianHz), floorMet, throttled }] as const;
    });
    return { order: b.order, raw: b.raw, cpus: b.work.map(reportWork), idle, sets: Object.fromEntries(sets) };
  });
  if (!control && !floors) reasons.push('block 1: reviewed frequency floors missing');
  return { reasons, blocks: details, referenceHz: host.rates.map(store),
    floorProposal: proposed.server && proposed.client ? { server: proposed.server, client: proposed.client } : null };
}
