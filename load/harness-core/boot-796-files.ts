// The versioned #796 boot files (#996), where each one installs, and their agreement with the #796 CPU layout.
import { fileURLToPath } from 'node:url';
import { parseCpuList } from './cpusets.ts';
import { cpus796, measuredCpus, measurementSlice, sets796 } from './frequency-layout.ts';

export const sourceDir = fileURLToPath(new URL('./boot-796/', import.meta.url));
export const unitDir = 'etc/systemd/system';
export const hostService = 'fukulow796-host.service';
export const libexecDir = 'usr/local/libexec/fukulow796';
export const grubTarget = 'etc/default/grub.d/fukulow-796.cfg';
export const stateFile = 'etc/fukulow-796/install-state.json';
export const multiUserTarget = '/usr/lib/systemd/system/multi-user.target';
export const wantsLink = `${unitDir}/multi-user.target.wants/${hostService}`;
export const irqbalanceLink = `${unitDir}/irqbalance.service`;
export const defaultTargetLink = `${unitDir}/default.target`;

export type HostFile = { source: string; target: string; mode: number };
const dropIn = (unit: string, source: string): HostFile => ({ source, target: `${unitDir}/${unit}.d/fukulow-796.conf`, mode: 0o644 });
// The units whose cpusets the host check reads (frequency-host-affinity.ts).
export const housekeepingScopes = ['init.scope'];
export const housekeepingSlices = ['system.slice', 'user.slice'];
export const housekeepingServices = ['containerd.service', 'docker.service', 'tailscaled.service'];
export const hostFiles: HostFile[] = [
  { source: measurementSlice, target: `${unitDir}/${measurementSlice}`, mode: 0o644 },
  { source: hostService, target: `${unitDir}/${hostService}`, mode: 0o644 },
  ...housekeepingScopes.map(unit => dropIn(unit, 'housekeeping-scope.conf')),
  ...housekeepingSlices.map(unit => dropIn(unit, 'housekeeping-slice.conf')),
  ...housekeepingServices.map(unit => dropIn(unit, 'housekeeping-service.conf')),
  { source: 'frequency.sh', target: `${libexecDir}/frequency.sh`, mode: 0o755 },
  { source: 'affinity.sh', target: `${libexecDir}/affinity.sh`, mode: 0o755 },
  { source: 'grub.cfg', target: grubTarget, mode: 0o644 },
];

// The #796 queue's requireHost and the Control's restore baseline (README "#796 frequency validity v3").
export const frequency = { profile: 'performance', governor: 'performance', boost: '0', max_khz: '2000000' };
export const housekeepingMask = sets796.housekeeping.reduce((bits, cpu) => bits | (1n << BigInt(cpu)), 0n).toString(16);

const values = (text: string, key: string) => [...text.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))].map(m => m[1]);
const sameCpus = (value: string | undefined, expected: number[]) => {
  try { return value !== undefined && JSON.stringify(parseCpuList(value, cpus796.length)) === JSON.stringify(expected); }
  catch { return false; }
};

function unitProblems(name: string, text: string, section: string, expected: number[]) {
  const allowed = values(text, 'AllowedCPUs');
  const problems = [];
  if (!new RegExp(`^\\[${section}\\]$`, 'm').test(text)) problems.push(`${name}: needs a [${section}] section`);
  if (allowed.length !== 1 || !sameCpus(allowed[0], expected)) {
    problems.push(`${name}: AllowedCPUs ${JSON.stringify(allowed)} differs from ${expected.join(',')}`);
  }
  return problems;
}

// Every disagreement between the versioned files and the #796 layout; install refuses unless empty.
export function layoutProblems(read: (source: string) => string): string[] {
  const problems: string[] = [];
  const check = (ok: boolean, problem: string) => { if (!ok) problems.push(problem); };
  const one = (text: string, key: string) => { const v = values(text, key); return v.length === 1 ? v[0] : undefined; };
  problems.push(...unitProblems(measurementSlice, read(measurementSlice), 'Slice', measuredCpus));
  problems.push(...unitProblems('housekeeping-scope.conf', read('housekeeping-scope.conf'), 'Scope', sets796.housekeeping));
  problems.push(...unitProblems('housekeeping-slice.conf', read('housekeeping-slice.conf'), 'Slice', sets796.housekeeping));
  problems.push(...unitProblems('housekeeping-service.conf', read('housekeeping-service.conf'), 'Service', sets796.housekeeping));
  const service = read(hostService);
  check(JSON.stringify(values(service, 'ExecStart')) === JSON.stringify(['frequency.sh', 'affinity.sh'].map(s => `/${libexecDir}/${s}`)),
    `${hostService}: ExecStart must run frequency.sh, then affinity.sh, from /${libexecDir}`);
  check(one(service, 'Wants') === measurementSlice, `${hostService}: Wants must be ${measurementSlice}`);
  check(one(service, 'WantedBy') === 'multi-user.target', `${hostService}: WantedBy must be multi-user.target`);
  const affinity = read('affinity.sh');
  check(sameCpus(one(affinity, 'housekeeping'), sets796.housekeeping), `affinity.sh: housekeeping differs from ${sets796.housekeeping.join(',')}`);
  check(one(affinity, 'mask') === housekeepingMask, `affinity.sh: mask differs from ${housekeepingMask}`);
  const freq = read('frequency.sh');
  for (const [key, value] of Object.entries(frequency)) check(one(freq, key) === value, `frequency.sh: ${key} must be ${value}`);
  const irq = [...read('grub.cfg').matchAll(/\birqaffinity=(\S+?)"?$/gm)].map(m => m[1]);
  check(irq.length === 1 && sameCpus(irq[0], sets796.housekeeping), `grub.cfg: irqaffinity ${JSON.stringify(irq)} differs from ${sets796.housekeeping.join(',')}`);
  return problems;
}
