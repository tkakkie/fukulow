import { cpuList, pinned } from './cpusets.ts';
import { measurementSlice, sets796 } from './frequency-layout.ts';

export const containerCpuArgs = (set: 'server' | 'client') =>
  ['--cgroup-parent', measurementSlice, '--cpuset-cpus', cpuList(sets796[set])];

export function postgresTaskset(cpus: number[]) {
  const [entrypoint, ...command] = pinned(cpus, ['docker-entrypoint.sh', 'postgres']);
  return { options: ['--entrypoint', entrypoint], command };
}

export function postgresServerContainer() {
  const { options, command } = postgresTaskset(sets796.server);
  return { options: [...containerCpuArgs('server'), ...options], command };
}
