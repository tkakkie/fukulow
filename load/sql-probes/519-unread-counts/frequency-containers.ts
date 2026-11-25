import { readFileSync } from 'node:fs';
import { cpuList, parseCpuList } from '../../harness-core/cpusets.ts';
import { cpus796, measurementSlice, sets796 } from '../../harness-core/frequency-layout.ts';
import { workloadCgroup } from './frequency-housekeeping.ts';

// An abstract Unix socket keeps the original transport across separate cpuset cgroups.
// Only the client container joins the server's private network namespace.
export const probeSocket = '@/fukulow796';
export const probeImage = 'postgres:18.6@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42';
export const containerCpuArgs = (set: 'server' | 'client') =>
  ['--cgroup-parent', measurementSlice, '--cpuset-cpus', cpuList(sets796[set])];

export const serverImageArgs = (cpus?: number[]) => cpus
  ? ['--entrypoint', 'taskset', probeImage, '-c', cpuList(cpus), 'docker-entrypoint.sh', 'postgres'] : [probeImage];

export const frequencyServerArgs = () => [
  ...containerCpuArgs('server'), ...serverImageArgs(sets796.server),
  '-c', `unix_socket_directories=/var/run/postgresql,${probeSocket}`,
];

export const frequencyClientArgs = (server: string, options: string[] = []) => [
  '--network', `container:${server}`, '-e', `PGHOST=${probeSocket}`, ...options,
  ...containerCpuArgs('client'), '--entrypoint', 'sleep', probeImage, 'infinity',
];

type ContainerCpuReadback = { cgroup: string; effective: number[] };
export type ContainerCpusets = { launchSession: string | null; server: ContainerCpuReadback; client: ContainerCpuReadback };
const dockerScope = new RegExp(`^/${measurementSlice.replaceAll('.', '\\.')}/docker-[a-f0-9]{64}\\.scope$`);
const hasEffectiveCpus = (effective: number[] | undefined, set: 'server' | 'client') =>
  Array.isArray(effective) && effective.length === sets796[set].length && effective.every((cpu, i) => cpu === sets796[set][i]);

export function containerCpuProblems(record: ContainerCpusets | null | undefined, session: string | null) {
  if (!record || !session || record.launchSession !== session) return ['missing frequency-container-cpusets.json for this session'];
  return (['server', 'client'] as const).flatMap(set => {
    const row = record[set];
    if (typeof row?.cgroup !== 'string' || !dockerScope.test(row.cgroup)) return [`${set} container is outside ${measurementSlice}`];
    if (!hasEffectiveCpus(row.effective, set)) return [`${set} container effective cpuset differs from #796`];
    if (set === 'client' && row.cgroup === record.server?.cgroup) return ['server and client share a Docker scope'];
    return [];
  });
}

export function containerCpuReadback(inspect: string, set: 'server' | 'client', read = (p: string) => readFileSync(p, 'utf8')) {
  const [id, pid] = inspect.trim().split(' ');
  const cgroup = workloadCgroup(pid, read);
  if (!/^[a-f0-9]{64}$/.test(id) || cgroup !== `/${measurementSlice}/docker-${id}.scope`) {
    throw new Error(`${set} container is outside ${measurementSlice}`);
  }
  const effective = parseCpuList(read(`/sys/fs/cgroup${cgroup}/cpuset.cpus.effective`).trim(), cpus796.length);
  if (!hasEffectiveCpus(effective, set)) throw new Error(`${set} container effective cpuset is ${cpuList(effective)}`);
  return { cgroup, effective };
}

export function frequencyContainerReadbacks(launchSession: string, server: string, client: string,
  docker: (args: string[]) => string, readback = containerCpuReadback): ContainerCpusets {
  const inspect = (name: string) => docker(['inspect', '--format', '{{.Id}} {{.State.Pid}}', name]);
  return { launchSession, server: readback(inspect(server), 'server'), client: readback(inspect(client), 'client') };
}
