import assert from 'node:assert/strict';
import test from 'node:test';
import { measuredSetsArg, matches796, measurementSlice, sets796 } from '../../harness-core/frequency-layout.ts';
import { parseCpuSets } from '../../harness-core/cpusets.ts';
import { hostAffinityProblems, readHostAffinity } from './frequency-host-affinity.ts';
import { containerCpuArgs, containerCpuReadback } from './frequency-containers.ts';
import { policy, session } from './frequency-fixture.ts';

function fixture() {
  const root = '/sys/fs/cgroup';
  const irq = '/proc/irq';
  const workqueue = '/sys/devices/virtual/workqueue/cpumask';
  const units = ['docker.service', 'containerd.service', 'tailscaled.service'];
  const groups = ['init.scope', 'system.slice', 'user.slice', measurementSlice];
  const dirs: Record<string, string[]> = { [root]: groups, [irq]: ['10', '11', '12'] };
  const modes: Record<string, number> = {};
  const files: Record<string, string> = {
    '/proc/sys/kernel/random/boot_id': policy.bootId,
    '/sys/devices/system/cpu/online': '0-15\n',
    '/proc/interrupts': '            CPU0 CPU1\n  10: 12 0 device\n  11:  0 5 managed\n  12: 0 0 idle\nLOC: 5 2 local timers\n',
    [workqueue]: '00000000,00008181\n',
    [`${irq}/default_smp_affinity`]: '8181\n',
  };
  const mask = '0,7-8,15';
  for (const group of groups) {
    files[`${root}/${group}/cpuset.cpus.effective`] = group === measurementSlice ? '1-6,9-14' : mask;
    files[`${root}/${group}/cgroup.events`] = group === measurementSlice ? 'populated 0\nfrozen 0' : 'populated 1\nfrozen 0';
  }
  for (let cpu = 0; cpu < 16; cpu++) {
    files[`/sys/devices/system/cpu/cpu${cpu}/topology/thread_siblings_list`] = `${cpu % 8},${cpu % 8 + 8}`;
  }
  for (const [i, unit] of units.entries()) {
    const pid = 100 + i * 10;
    const group = `/system.slice/${unit}`;
    files[`${root}${group}/cpuset.cpus.effective`] = mask;
    files[`/proc/${pid}/cgroup`] = `0::${group}\n`;
    dirs[`/proc/${pid}/task`] = [String(pid), String(pid + 1)];
    files[`/proc/${pid}/task/${pid}/status`] = `Cpus_allowed_list:\t${mask}\n`;
    files[`/proc/${pid}/task/${pid + 1}/status`] = 'Cpus_allowed_list:\t0,8\n';
  }
  for (const id of dirs[irq]) {
    const path = `${irq}/${id}/smp_affinity_list`;
    modes[path] = id === '11' ? 0o444 : 0o644;
    files[path] = id === '11' ? '5' : mask;
    files[`${irq}/${id}/effective_affinity_list`] = id === '11' ? '5' : id === '12' ? '\n' : '7';
  }
  const state = { irqbalance: 'inactive', driver: 'systemd 2' };
  const get = <T>(map: Record<string, T>, key: string) => {
    if (!Object.hasOwn(map, key)) throw new Error(`unreadable ${key}`);
    return map[key];
  };
  const readback = () => readHostAffinity(session, {
    read: p => get(files, p), directories: p => get(dirs, p), mode: p => get(modes, p),
    command: (program, args) => program === 'docker' ? state.driver : args.at(-1) === 'irqbalance.service'
      ? state.irqbalance : String(100 + units.indexOf(args.at(-1)!) * 10),
  });
  return { readback, files, dirs, state, root, irq, workqueue };
}

const problems = (record: ReturnType<typeof readHostAffinity>) => hostAffinityProblems(record, session, policy.bootId);

test('v3 accepts only the exact three-set layout', () => {
  assert.ok(matches796(parseCpuSets(`${measuredSetsArg};housekeeping=0,7-8,15`, 16)));
  assert.equal(matches796(parseCpuSets(measuredSetsArg, 16)), false);
  assert.equal(matches796(parseCpuSets(`${measuredSetsArg};housekeeping=0,8`, 16)), false);
  assert.equal(matches796(parseCpuSets('server=0,2,4,6,8,10,12,14;client=1,3,5,7,9,11,13,15', 16)), false);
});

test('readback records daemon threads, slice masks, workqueues and movable and read-only IRQs', () => {
  const record = fixture().readback();
  assert.deepEqual(problems(record), []);
  assert.deepEqual(record.workqueue, sets796.housekeeping);
  assert.deepEqual(record.groups?.['user.slice'].cpus, sets796.housekeeping);
  assert.deepEqual(record.daemons['docker.service']?.threads['101'], [0, 8]);
  assert.deepEqual(record.irqs?.rows['11'], { writable: false, configured: [5], effective: [5] });
  assert.deepEqual(record.irqs?.rows['12'].effective, []);
  assert.match(hostAffinityProblems(record, session, 'other-boot').join(), /session and boot/);
  assert.match(hostAffinityProblems(record, 'other-session', policy.bootId).join(), /session and boot/);
});

test('preflight fails closed on changed or unreadable host affinity', () => {
  const cases: [RegExp, (f: ReturnType<typeof fixture>) => void][] = [
    [/system\.slice effective cpuset/, ({ files, root }) => { files[`${root}/system.slice/cpuset.cpus.effective`] = '0-15'; }],
    [/user\.slice effective cpuset/, ({ files, root }) => { delete files[`${root}/user.slice/cpuset.cpus.effective`]; }],
    [/init\.scope effective cpuset/, ({ files, root }) => { files[`${root}/init.scope/cpuset.cpus.effective`] = '0-15'; }],
    [/needs the measured CPUs and an empty cgroup/, ({ files, root }) => { files[`${root}/${measurementSlice}/cgroup.events`] = 'populated 1'; }],
    [/unconfined.slice has processes outside housekeeping/, ({ dirs, files, root }) => {
      dirs[root].push('unconfined.slice');
      files[`${root}/unconfined.slice/cpuset.cpus.effective`] = '0-15';
      files[`${root}/unconfined.slice/cgroup.events`] = 'populated 1';
    }],
    [/docker\.service cgroup or thread affinity/, ({ files }) => { files['/proc/100/task/101/status'] = 'Cpus_allowed_list:\t2'; }],
    [/containerd\.service cgroup or thread affinity/, ({ files }) => { files['/proc/110/cgroup'] = '0::/user.slice'; }],
    [/tailscaled\.service.*unreadable/, ({ files }) => { delete files['/proc/120/task/121/status']; }],
    [/unbound workqueue cpumask/, ({ files, workqueue }) => { files[workqueue] = 'ffff'; }],
    [/invalid CPU mask/, ({ files, workqueue }) => { files[workqueue] = 'not hex'; }],
    [/default IRQ affinity/, ({ files, irq }) => { files[`${irq}/default_smp_affinity`] = 'ffff'; }],
    [/movable IRQ 10 affinity/, ({ files, irq }) => { files[`${irq}/10/smp_affinity_list`] = '0-15'; }],
    [/movable IRQ 10 affinity/, ({ files, irq }) => { files[`${irq}/10/effective_affinity_list`] = '5'; }],
    [/unreadable \/proc\/irq\/11/, ({ files, irq }) => { delete files[`${irq}/11/effective_affinity_list`]; }],
    [/missing numeric IRQ affinity/, ({ dirs, irq }) => { dirs[irq] = ['10']; }],
    [/irqbalance must be inactive/, ({ state }) => { state.irqbalance = 'active'; }],
    [/Docker needs the systemd cgroup driver/, ({ state }) => { state.driver = 'cgroupfs 2'; }],
    [/SMT topology/, ({ files }) => { files['/sys/devices/system/cpu/cpu0/topology/thread_siblings_list'] = '0,1'; }],
  ];
  for (const [expected, mutate] of cases) {
    const f = fixture();
    mutate(f);
    assert.match(problems(f.readback()).join(), expected);
  }
});

test('both Docker cpusets use their own measured CPUs under the workload slice', () => {
  const id = 'a'.repeat(64);
  const cgroup = `/${measurementSlice}/docker-${id}.scope`;
  const read = (path: string) => path.startsWith('/proc/') ? `0::${cgroup}\n` : '2,4,6,10,12,14';
  assert.deepEqual(containerCpuArgs('server'), ['--cgroup-parent', measurementSlice, '--cpuset-cpus', '2,4,6,10,12,14']);
  assert.deepEqual(containerCpuArgs('client'), ['--cgroup-parent', measurementSlice, '--cpuset-cpus', '1,3,5,9,11,13']);
  assert.deepEqual(containerCpuReadback(`${id} 123`, 'server', read), { cgroup, effective: sets796.server });
  assert.throws(() => containerCpuReadback(`${id} 123`, 'client', read), /client container effective cpuset/);
  assert.throws(() => containerCpuReadback(`${id} 123`, 'server', () => '0::/system.slice/docker.scope'), /outside fukulow796.slice/);
});
