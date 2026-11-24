import { cpus796, same, setNames, sets796, type SetName } from './frequency-evidence.ts';
import { restore } from './frequency-ratios.ts';
import { spotReadings, type SpotCheck } from './frequency-spot-check.ts';
import type { judgeRun } from './stability-judge.ts';

type Report = ReturnType<typeof judgeRun>['frequency'];
const asNumber = (r: ReturnType<typeof restore>) => Number(r[0]) / Number(r[1]);

export function controlSpotCheck(raw: SpotCheck | null, report: Report) {
  try {
    const capped = report.blocks.find(b => b.order === 2);
    if (!raw || !capped?.raw || !report.referenceHz) throw new Error('no capped turbostat observation or calibrated counters');
    if (BigInt(raw.startNs) > BigInt(capped.raw.open.reads[0].monoNs) ||
        BigInt(raw.stopNs) < BigInt(capped.raw.close.reads.at(-1)!.monoNs)) throw new Error('turbostat did not span the capped counter interval');
    const rows = spotReadings(raw);
    if (!same(rows.map(r => r.cpu), cpus796)) throw new Error('turbostat did not report all 16 CPUs exactly once');
    const rowsCompared = rows.map(r => {
      const w = capped.cpus[r.cpu];
      const helperTscMhz = asNumber(restore(report.referenceHz![r.cpu])) / 1e6;
      const helperRatio = w.mperf === '0' ? null : Number(w.aperf) / Number(w.mperf);
      const referenceError = Math.abs(r.tscMhz / helperTscMhz - 1);
      const ratioError = w.qualifies && helperRatio !== null ? (r.ratio === null ? 1 : Math.abs(r.ratio / helperRatio - 1)) : null;
      return { ...r, helperTscMhz, helperRatio, referenceError, ratioError };
    });
    const problems = rowsCompared.flatMap(r => r.referenceError > 0.02 || (r.ratioError !== null && r.ratioError > 0.02)
      ? [`turbostat discrepancy >2% on CPU ${r.cpu}`] : []);
    return { raw, cpus: rowsCompared, problems };
  } catch (error) { return { raw, cpus: [], problems: [String(error)] }; }
}

export function legacyDisagreements(legacy: string[], v3: Report, orders: number[]) {
  return orders.flatMap(order => setNames.flatMap(set => {
    const containsSet = (reason: string, s: SetName) => new RegExp(`\\b${s}\\b`).test(reason);
    const fromBlock = (reason: string) => reason.startsWith(`block ${order}:`);
    const old = legacy.filter(r => fromBlock(r) && containsSet(r, set));
    const current = v3.reasons.filter(r => (fromBlock(r) &&
      (containsSet(r, set) || /^block \d+: F[1236]\b/.test(r))) || /^F[1-7]\b/.test(r));
    const verdict = (rs: string[]) => rs.some(r => r.includes('throttled')) ? 'throttled' : rs.length > 0 ? 'invalid evidence' : 'clear';
    return verdict(old) === verdict(current) ? [] : [{ block: order, set, legacy: old, v3: current }];
  }));
}

export function clientCpuEquivalents(report: Report) {
  return report.blocks.map(b => {
    if (!b.raw || b.cpus.length !== 16) return { block: b.order, equivalents: null };
    const elapsed = Number(BigInt(b.raw.exitNs) - BigInt(b.raw.startNs));
    const cpus = b.cpus.filter(c => sets796.client.includes(c.cpu));
    const idle = b.idle?.perCpu.filter(c => sets796.client.includes(c.cpu)) ?? [];
    const total = (rows: typeof cpus) => rows.reduce((sum, r) => sum + Number(r.c0Ns[0]) / Number(r.c0Ns[1]), 0);
    return { block: b.order, equivalents: (total(cpus) - total(idle)) / elapsed };
  });
}
