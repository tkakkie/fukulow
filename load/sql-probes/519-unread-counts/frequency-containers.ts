import { readFileSync } from 'node:fs';
import { cpuList, parseCpuList } from '../../harness-core/cpusets.ts';
import { cpus796, measurementSlice, sets796 } from '../../harness-core/frequency-layout.ts';
import { workloadCgroup } from './frequency-housekeeping.ts';

// An abstract Unix socket keeps the original transport across separate cpuset cgroups.
// Only the client container joins the server's private network namespace.
export const probeSocket = '@/fukulow796';
export const containerCpuArgs = (set: 'server' | 'client') =>
  ['--cgroup-parent', measurementSlice, '--cpuset-cpus', cpuList(sets796[set])];

export function containerCpuReadback(inspect: string, set: 'server' | 'client', read = (p: string) => readFileSync(p, 'utf8')) {
  const [id, pid] = inspect.trim().split(' ');
  const cgroup = workloadCgroup(pid, read);
  if (!/^[a-f0-9]{64}$/.test(id) || cgroup !== `/${measurementSlice}/docker-${id}.scope`) {
    throw new Error(`${set} container is outside ${measurementSlice}`);
  }
  const effective = parseCpuList(read(`/sys/fs/cgroup${cgroup}/cpuset.cpus.effective`).trim(), cpus796.length);
  if (cpuList(effective) !== cpuList(sets796[set])) throw new Error(`${set} container effective cpuset is ${cpuList(effective)}`);
  return { cgroup, effective };
}
