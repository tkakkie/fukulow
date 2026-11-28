// Best-effort snapshots for attribution beside the perf sweeps.
import { readFileSync } from 'node:fs';
import { parseProcStat, type ProcStat } from '../../harness-core/thermal.ts';
import { cpus796 } from './frequency-evidence.ts';

const read = (file: string) => readFileSync(file, 'utf8');
export function diagnostic<T>(capture: () => T): T | null {
  try { return capture(); } catch { return null; }
}

export function workloadCgroup(pid: string, readFile = read) {
  if (!/^[1-9]\d*$/.test(pid)) return null;
  const path = /^0::(\/.+)$/m.exec(readFile(`/proc/${pid}/cgroup`))?.[1];
  return path && !path.split('/').some(part => part === '..' || part === '.') ? path : null;
}

const cpuFields = ['usage_usec', 'user_usec', 'system_usec'] as const;
function cpuStat(text: string) {
  return Object.fromEntries(cpuFields.map(field => {
    const value = Number(new RegExp(`^${field} (\\d+)$`, 'm').exec(text)?.[1]);
    if (!Number.isSafeInteger(value)) throw new Error(`missing cgroup CPU counter ${field}`);
    return [field, value];
  }));
}

function softirqs(text: string) {
  const [header, ...lines] = text.trim().split('\n');
  if (header.trim().split(/\s+/).join(' ') !== cpus796.map(cpu => `CPU${cpu}`).join(' ')) return null;
  return Object.fromEntries(lines.map(line => {
    const [, name, values] = /^\s*([A-Z_]+):\s+([\d\s]+)$/.exec(line) ?? [];
    const counts = values?.trim().split(/\s+/).map(Number);
    if (!counts || counts.length !== cpus796.length || !counts.every(Number.isSafeInteger)) throw new Error('unreadable softirq row');
    return [name, counts];
  }));
}

export type HousekeepingSample = {
  procStat: ProcStat | null;
  softirqs: Record<string, number[]> | null;
  cgroups: Record<string, Record<string, number> | null>;
};
export type HousekeepingSamples = {
  ticksPerSecond: number | null; workload: string | null;
  open: HousekeepingSample; idle?: HousekeepingSample; close: HousekeepingSample;
};

export function housekeepingSampler(workload: string | null, ticksPerSecond: number | null, readFile = read) {
  const paths = [...new Set(['/system.slice', '/user.slice', ...(workload ? [workload] : [])])];
  return {
    workload, ticksPerSecond,
    sample: (): HousekeepingSample => ({
      procStat: diagnostic(() => parseProcStat(readFile('/proc/stat'))),
      softirqs: diagnostic(() => softirqs(readFile('/proc/softirqs'))),
      cgroups: Object.fromEntries(paths.map(path => [path, diagnostic(() => cpuStat(readFile(`/sys/fs/cgroup${path}/cpu.stat`)))])),
    }),
  };
}
