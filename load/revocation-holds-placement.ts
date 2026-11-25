// Effective CPU placement for #668 on the #796 Ubuntu host.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { allowedCpus, cpuList, parseCpuList, pinned } from './harness-core/cpusets.ts';
import { measuredCpus, measurementSlice, sets796 } from './harness-core/frequency-layout.ts';
import { SetupAbort } from './revocation-holds-setup.ts';
export { postgresServerContainer as postgresContainer } from './harness-core/frequency-container-args.ts';

type Role = 'client' | 'server' | 'helper' | 'postgres';
type Placement = { pid: number; cgroup: string; affinity: number[]; cpuset: number[]; cpusetCgroup: string };
const readFile = (file: string) => readFileSync(file, 'utf8');
const cpuSet = (role: Role) => sets796[role === 'client' || role === 'helper' ? 'client' : 'server'];

export function checkPlacement(role: Role, pid: number | undefined, read = readFile): Placement {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) throw new Error(`${role} has no process id`);
  const affinity = allowedCpus(read(`/proc/${pid}/status`));
  const cgroup = /^0::(\/[^\n]+)$/m.exec(read(`/proc/${pid}/cgroup`))?.[1];
  if (!cgroup || !cgroup.startsWith(`/${measurementSlice}/`) || cgroup.split('/').some(part => part === '.' || part === '..')) {
    throw new Error(`${role} affinity ${cpuList(affinity)} in cgroup ${cgroup ?? 'missing'} is outside ${measurementSlice}`);
  }
  const { cpuset, cpusetCgroup } = effectiveCpuset(cgroup, read);
  const expected = cpuSet(role);
  if (cpuList(affinity) !== cpuList(expected)) throw new Error(`${role} effective affinity ${cpuList(affinity)} differs from ${cpuList(expected)}`);
  if (cpuset.some(cpu => !measuredCpus.includes(cpu)) || expected.some(cpu => !cpuset.includes(cpu)) ||
    (role === 'postgres' && cpuList(cpuset) !== cpuList(expected))) {
    throw new Error(`${role} effective cpuset ${cpuList(cpuset)} does not match #796 placement`);
  }
  return { pid, cgroup, affinity, cpuset, cpusetCgroup };
}

// systemd enables the cpuset controller only for units that set AllowedCPUs, so a
// fukulow668 scope has no cpuset file and runs on its nearest ancestor's effective CPUs.
function effectiveCpuset(cgroup: string, read: (file: string) => string) {
  for (let group = cgroup; group.startsWith(`/${measurementSlice}`); group = group.slice(0, group.lastIndexOf('/'))) {
    let text: string;
    try { text = read(`/sys/fs/cgroup${group}/cpuset.cpus.effective`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    return { cpuset: parseCpuList(text.trim()), cpusetCgroup: group };
  }
  throw new Error(`no cpuset.cpus.effective in ${cgroup} or its ancestors up to /${measurementSlice}`);
}

export function placementEnabled(platform: string, mode: 'preflight' | 'rehearsal' | 'overhead' | 'formal') {
  if (platform === 'linux') return true;
  if (platform === 'darwin' && mode !== 'formal') return false; // Local rehearsal needs its own preflight.
  throw new Error(`#668 ${mode} requires Linux #796 CPU placement`);
}

export function recordPlacement(dir: string, enabled: boolean, read = readFile) {
  const placement: Partial<Record<Role, Placement | { error: string }>> = {};
  const save = () => writeFileSync(resolve(dir, 'environment.json'), JSON.stringify({ linuxPlacement: enabled, placement }, null, 2));
  save();
  return (role: Role, pid: () => number | undefined) => {
    if (!enabled) return;
    try { placement[role] = checkPlacement(role, pid(), read); }
    catch (error) {
      const message = (error as Error).message;
      placement[role] = { error: message };
      throw new SetupAbort(`CPU placement: ${message}`);
    } finally { save(); }
  };
}

export const clientScope = (pid: number | '$$') => ['systemd-run', '--scope', '--quiet', '--collect', '--no-ask-password',
  `--slice=${measurementSlice}`, `--unit=fukulow668-client-${pid}.scope`, '--', ...pinned(sets796.client, [])];
export const serverPrefix = () => pinned(sets796.server, []);

export const postgresPid = (name: string) =>
  Number(execFileSync('docker', ['inspect', '--format', '{{.State.Pid}}', name], { encoding: 'utf8' }).trim());
