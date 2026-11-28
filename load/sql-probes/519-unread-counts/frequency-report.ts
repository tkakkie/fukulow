// Reports client CPU equivalents from measured C0.
import { sets796 } from './frequency-evidence.ts';
import type { judgeRun } from './stability-judge.ts';

type Report = ReturnType<typeof judgeRun>['frequency'];

export function clientCpuEquivalents(report: Report) {
  return report.blocks.map(b => {
    if (!b.raw || b.cpus.length !== 16) return { block: b.order, equivalents: null };
    const elapsed = Number(BigInt(b.raw.exitNs) - BigInt(b.raw.startNs));
    const cpus = b.cpus.filter(c => sets796.client.includes(c.cpu));
    const total = (rows: typeof cpus) => rows.reduce((sum, r) => sum + Number(r.c0Ns[0]) / Number(r.c0Ns[1]), 0);
    return { block: b.order, equivalents: total(cpus) / elapsed };
  });
}
