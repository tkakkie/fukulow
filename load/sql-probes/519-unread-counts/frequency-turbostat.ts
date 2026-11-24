// Checks the capped control counters against turbostat.
import { cpus796, same } from './frequency-evidence.ts';
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
