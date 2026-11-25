import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { allowedCpus, parseCpuList } from '../../harness-core/cpusets.ts';
import { cpus796, measuredCpus, measurementSlice, sets796 } from '../../harness-core/frequency-layout.ts';
import { workloadCgroup } from './frequency-housekeeping.ts';

const cgroupRoot = '/sys/fs/cgroup';
const cpuRoot = '/sys/devices/system/cpu';
const irqRoot = '/proc/irq';
const backgroundGroups = ['init.scope', 'system.slice', 'user.slice'];
const services = ['containerd.service', 'docker.service', 'tailscaled.service'];
const housekeeping = sets796.housekeeping;
const list = (value: string) => parseCpuList(value.trim(), cpus796.length);

const host = {
  read: (path: string) => readFileSync(path, 'utf8'),
  directories: (path: string) => readdirSync(path, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name),
  mode: (path: string) => statSync(path).mode,
  command: (program: string, args: string[]) => execFileSync(program, args, { encoding: 'utf8', timeout: 5000 }).trim(),
};

function maskList(value: string) {
  const mask = value.trim();
  if (!/^[\da-f]{1,8}(?:,[\da-f]{8})*$/i.test(mask)) throw new Error(`invalid CPU mask: ${mask}`);
  const bits = BigInt(`0x${mask.replaceAll(',', '')}`);
  if (bits === 0n || bits >> BigInt(cpus796.length)) throw new Error(`CPU mask outside the host: ${mask}`);
  return cpus796.filter(cpu => bits & (1n << BigInt(cpu)));
}

function readGroups(io: typeof host) {
  return Object.fromEntries(io.directories(cgroupRoot).map(name => {
    const path = `${cgroupRoot}/${name}`;
    const populated = /^populated ([01])$/m.exec(io.read(`${path}/cgroup.events`));
    if (!populated) throw new Error(`unreadable ${path}/cgroup.events`);
    const value = io.read(`${path}/cpuset.cpus.effective`).trim();
    return [name, { populated: populated[1] === '1', cpus: value ? list(value) : [] }];
  }));
}

function readDaemon(io: typeof host, unit: string) {
  const pid = io.command('systemctl', ['show', '--property=MainPID', '--value', unit]);
  if (!/^[1-9]\d*$/.test(pid)) throw new Error(`no MainPID for ${unit}`);
  const cgroup = workloadCgroup(pid, io.read);
  const cpus = list(io.read(`${cgroupRoot}/system.slice/${unit}/cpuset.cpus.effective`));
  const threads = Object.fromEntries(io.directories(`/proc/${pid}/task`).map(tid =>
    [tid, allowedCpus(io.read(`/proc/${pid}/task/${tid}/status`))]));
  return { pid, cgroup, cpus, threads };
}

function readRootTasks(io: typeof host) {
  const tids = io.read(`${cgroupRoot}/cgroup.threads`).trim().split(/\s+/);
  if (!tids.every(tid => /^[1-9]\d*$/.test(tid))) throw new Error('unreadable root cgroup thread list');
  const tasks: Record<string, { name: string; cpus: number[]; movable: boolean }> = {};
  for (const tid of new Set(tids)) {
    try {
      const cpus = allowedCpus(io.read(`/proc/${tid}/status`));
      const stat = io.read(`/proc/${tid}/stat`);
      const end = stat.lastIndexOf(')');
      const flags = stat.slice(end + 2).split(/\s+/)[6]; // Field 9 follows the parenthesized comm.
      if (!stat.startsWith(`${tid} (`) || end < 0 || !/^\d+$/.test(flags ?? '')) {
        throw new Error(`unreadable root task ${tid} stat`);
      }
      const movable = (Number(flags) & 0x04000000) === 0; // Linux PF_NO_SETAFFINITY
      if (cpus.length > 1 || (movable && !onHousekeeping(cpus))) {
        tasks[tid] = { name: stat.slice(stat.indexOf('(') + 1, end), cpus, movable };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ESRCH') throw error;
    }
  }
  return tasks;
}

function readIrqs(io: typeof host) {
  const active = [...io.read('/proc/interrupts').matchAll(/^\s*(\d+):/gm)].map(match => match[1]);
  const rows = Object.fromEntries(io.directories(irqRoot).filter(id => /^\d+$/.test(id)).map(id => {
    const path = `${irqRoot}/${id}`;
    const affinity = `${path}/smp_affinity_list`;
    // The proc IRQ interface exposes user-settable affinity with the owner write bit.
    const writable = Boolean(io.mode(affinity) & 0o200);
    const configured = list(io.read(affinity));
    const effective = io.read(`${path}/effective_affinity_list`).trim();
    return [id, { writable, configured, effective: effective ? list(effective) : [] }];
  }));
  return { active, rows };
}

export function readHostAffinity(launchSession: string, io = host) {
  const unreadable: string[] = [];
  const capture = <T>(name: string, read: () => T) => {
    try { return read(); }
    catch (error) { unreadable.push(`${name}: ${String(error)}`); return null; }
  };
  return {
    launchSession, unreadable,
    bootId: capture('boot ID', () => io.read('/proc/sys/kernel/random/boot_id').trim()),
    online: capture('online CPUs', () => list(io.read(`${cpuRoot}/online`))),
    siblings: capture('SMT topology', () => cpus796.map(cpu =>
      list(io.read(`${cpuRoot}/cpu${cpu}/topology/thread_siblings_list`)))),
    docker: capture('Docker cgroup settings', () => io.command('docker', ['info', '--format', '{{.CgroupDriver}} {{.CgroupVersion}}'])),
    groups: capture('top-level cgroups', () => readGroups(io)),
    rootTasks: capture('root cgroup tasks', () => readRootTasks(io)),
    daemons: Object.fromEntries(services.map(unit => [unit, capture(unit, () => readDaemon(io, unit))])),
    irqbalance: capture('irqbalance', () => io.command('systemctl', ['show', '--property=ActiveState', '--value', 'irqbalance.service'])),
    workqueue: capture('workqueue cpumask', () => maskList(io.read('/sys/devices/virtual/workqueue/cpumask'))),
    defaultIrq: capture('default IRQ mask', () => maskList(io.read(`${irqRoot}/default_smp_affinity`))),
    irqs: capture('device IRQs', () => readIrqs(io)),
  };
}

export type HostAffinity = ReturnType<typeof readHostAffinity>;
const exact = (actual: number[] | undefined | null, expected: number[]) =>
  Array.isArray(actual) && actual.length === expected.length && actual.every((cpu, i) => cpu === expected[i]);
const onHousekeeping = (cpus: number[]) => Array.isArray(cpus) && cpus.every(cpu => housekeeping.includes(cpu));
const isCpuList = (cpus: number[]) => Array.isArray(cpus) && cpus.every(cpu => cpus796.includes(cpu));

export function hostAffinityProblems(record: HostAffinity | undefined | null, session: string | null, bootId: string | undefined) {
  if (!record || !session || record.launchSession !== session || !bootId || record.bootId !== bootId) {
    return ['missing housekeeping readback for this session and boot'];
  }
  const problems = Array.isArray(record.unreadable) ? [...record.unreadable] : ['missing housekeeping readback status'];
  if (!exact(record.online, cpus796) || record.siblings?.length !== cpus796.length ||
      !cpus796.every(cpu => exact(record.siblings?.[cpu], [cpu % 8, cpu % 8 + 8]))) problems.push('unexpected #796 SMT topology');
  if (record.docker !== 'systemd 2') problems.push('Docker needs the systemd cgroup driver on cgroup v2');
  if (record.irqbalance !== 'inactive') problems.push('irqbalance must be inactive');
  if (!exact(record.workqueue, housekeeping)) problems.push('unbound workqueue cpumask differs from housekeeping');
  if (!exact(record.defaultIrq, housekeeping)) problems.push('default IRQ affinity differs from housekeeping');
  for (const name of backgroundGroups) {
    if (!exact(record.groups?.[name]?.cpus, housekeeping)) problems.push(`${name} effective cpuset differs from housekeeping`);
  }
  const workload = record.groups?.[measurementSlice];
  if (!exact(workload?.cpus, measuredCpus) || workload?.populated !== false) problems.push(`${measurementSlice} needs the measured CPUs and an empty cgroup`);
  for (const [name, group] of Object.entries(record.groups ?? {})) {
    if (name !== measurementSlice && group.populated && (!group.cpus.length || !onHousekeeping(group.cpus))) {
      problems.push(`${name} has processes outside housekeeping`);
    }
  }
  if (!record.rootTasks || typeof record.rootTasks !== 'object' || Array.isArray(record.rootTasks)) {
    problems.push('missing root cgroup task affinities');
  }
  for (const [tid, task] of Object.entries(record.rootTasks ?? {})) {
    if (typeof task?.movable !== 'boolean' || !isCpuList(task.cpus) || !task.cpus.length) {
      problems.push(`unreadable root task ${tid} affinity evidence`);
    } else if (task.movable && !onHousekeeping(task.cpus)) {
      problems.push(`movable root task ${tid} (${task.name}) affinity differs from housekeeping`);
    }
  }
  for (const unit of services) {
    const daemon = record.daemons?.[unit];
    const threads = Object.values(daemon?.threads ?? {});
    if (!daemon || daemon.cgroup !== `/system.slice/${unit}` || !exact(daemon.cpus, housekeeping) ||
        !daemon.threads?.[daemon.pid] || threads.some(cpus => !cpus.length || !onHousekeeping(cpus))) {
      problems.push(`${unit} cgroup or thread affinity differs from housekeeping`);
    }
  }
  const active = record.irqs?.active, rows = record.irqs?.rows ?? {};
  if (!Array.isArray(active) || !active.length || !active.every(id => Object.hasOwn(rows, id))) {
    problems.push('missing numeric IRQ affinity evidence');
  }
  for (const [id, irq] of Object.entries(rows)) {
    if (typeof irq?.writable !== 'boolean' || !isCpuList(irq.configured) || !irq.configured.length || !isCpuList(irq.effective)) {
      problems.push(`unreadable IRQ ${id} affinity evidence`);
    } else if (irq.writable && (!exact(irq.configured, housekeeping) || !onHousekeeping(irq.effective))) {
      problems.push(`movable IRQ ${id} affinity differs from housekeeping`);
    }
  }
  return problems;
}

export function runHostAffinityProblems(before: HostAffinity | null | undefined, after: HostAffinity | null | undefined,
  session: string | null, bootId: string | undefined) {
  return [
    ...hostAffinityProblems(before, session, bootId).map(problem => `start: ${problem}`),
    ...hostAffinityProblems(after, session, bootId).map(problem => `finish: ${problem}`),
  ];
}
