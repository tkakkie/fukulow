// Attribution accounting has no input to the frequency verdict.
import { cpus796, type CpuWork } from './frequency-evidence.ts';
import type { HousekeepingSamples } from './frequency-housekeeping.ts';

const delta = (a: number | undefined, b: number | undefined) =>
  a != null && b != null && Number.isSafeInteger(a) && Number.isSafeInteger(b) && a >= 0 && b >= a ? b - a : null;

export function housekeepingReport(work: Pick<CpuWork, 'c0Ns'>[], samples: HousekeepingSamples | undefined, interval: 'work' | 'tail' = 'work') {
  if (!samples) return null;
  const a = interval === 'tail' ? samples.idle : samples.open;
  const b = interval === 'tail' ? samples.close : samples.idle ?? samples.close;
  if (!a || !b) return null;
  const cgroups = Object.fromEntries(Object.keys(a.cgroups).map(path => [path,
    Object.fromEntries(['usage_usec', 'user_usec', 'system_usec'].map(field =>
      [field, delta(a.cgroups[path]?.[field], b.cgroups[path]?.[field])]))]));
  const c0Usec = work.reduce((sum, w) => sum + Number(w.c0Ns[0]) / Number(w.c0Ns[1]) / 1_000, 0);
  const usageUsec = samples.workload ? cgroups[samples.workload]?.usage_usec ?? null : null;
  const perCpu = cpus796.map(cpu => {
    const start = a.procStat?.[cpu], end = b.procStat?.[cpu];
    const procStatTicks = start && end ? start.slice(0, end.length).map((n, i) => delta(n, end[i])) : null;
    return { cpu, procStatTicks, irqTicks: procStatTicks?.[5] ?? null, softirqTicks: procStatTicks?.[6] ?? null,
      softirqs: a.softirqs && b.softirqs ? Object.fromEntries(Object.keys(a.softirqs).map(name =>
        [name, delta(a.softirqs?.[name]?.[cpu], b.softirqs?.[name]?.[cpu])])) : null };
  });
  const irqTicks = perCpu.flatMap(cpu => [cpu.irqTicks, cpu.softirqTicks]);
  const sliceUsec = [cgroups['/system.slice']?.usage_usec, cgroups['/user.slice']?.usage_usec];
  const ticks = samples.ticksPerSecond;
  // Slice totals can include the workload cgroup.
  const aggregateUsec = ticks && Number.isSafeInteger(ticks) && ticks > 0 && irqTicks.every(x => x !== null) && sliceUsec.every(x => x != null)
    ? sliceUsec.reduce((sum, x) => sum + x, 0) + irqTicks.reduce((sum, x) => sum + x, 0) * 1_000_000 / ticks : null;
  return { c0Usec, workload: samples.workload, usageUsec, c0MinusUsageUsec: usageUsec === null ? null : c0Usec - usageUsec,
    cgroups, perCpu, ticksPerSecond: ticks, aggregateUsec };
}
