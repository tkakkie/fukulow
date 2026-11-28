import assert from 'node:assert/strict';
import test from 'node:test';
import { measurementSlice, sets796 } from '../../harness-core/frequency-layout.ts';
import { containerCpuReadback } from './frequency-containers.ts';
import { checkFrequencyHost } from './frequency-host-check.ts';
import { hostAffinity } from './frequency-fixture.ts';

type CheckIo = NonNullable<Parameters<typeof checkFrequencyHost>[1]>;
type Record = Parameters<Parameters<typeof checkFrequencyHost>[0]>[0];

function fixture({ badAffinity = false, busy = false, badCpuset = false, badSocket = false,
  badSpot = false, badCleanup = false, lateRootTask = false } = {}) {
  const calls: string[][] = [], launched: string[] = [], removed: string[] = [];
  let spotCalls = 0;
  const io: CheckIo = {
    readHostAffinity: session => {
      const affinity = hostAffinity(session);
      if (badAffinity) affinity.irqbalance = 'active';
      if (lateRootTask && launched.length === 2 && removed.length === 2) {
        affinity.rootTasks = { '42': { name: 'late-kthread', cpus: [6], movable: true } };
      }
      return affinity;
    },
    docker: argv => {
      calls.push(argv);
      const [command, option] = argv;
      if (command === 'ps') return option === '-q' ? (busy ? 'foreign-id' : '') : launched.filter(name => !removed.includes(name)).join('\n');
      if (command === 'run') launched.push(argv[argv.indexOf('--name') + 1]);
      else if (command === 'inspect') return argv.at(-1) === launched[0] ? `${'a'.repeat(64)} 100` : `${'b'.repeat(64)} 200`;
      else if (command === 'exec' && argv.includes('psql')) return badSocket ? 'f' : 't';
      else if (command === 'rm') {
        if (badCleanup && argv.at(-1) === launched[1]) throw new Error('client removal failed');
        removed.push(argv.at(-1)!);
      }
      return '';
    },
    containerCpuReadback: (inspect, set) => containerCpuReadback(inspect, set, path =>
      path.startsWith('/proc/') ? `0::/${measurementSlice}/docker-${inspect.split(' ')[0]}.scope\n`
        : badCpuset && set === 'client' ? '0-15' : sets796[set].join(',')),
    withSpotCheck: async (work, _signal, keep) => {
      spotCalls++;
      if (badSpot) throw new Error('turbostat exited before its opening sample');
      keep({ startNs: '1', stopNs: '2', stdout: 'FUKULOW_TURBOSTAT_READY\n', stderr: '' });
      return work();
    },
  };
  const records: Record[] = [];
  const run = async () => {
    const ok = await checkFrequencyHost(record => records.push(record), io);
    assert.equal(records.length, 1);
    assert.equal(records[0].label, 'not evidence');
    assert.equal(records[0].ok, ok);
    return { ok, record: records[0], calls, launched, removed, spotCalls };
  };
  return run;
}

test('the host check exercises two pinned containers, the abstract socket and the scoped observer', async () => {
  const { ok, record, calls, launched, removed, spotCalls } = await fixture()();
  assert.ok(ok);
  assert.deepEqual(record.problems, []);
  assert.equal(launched.length, 2);
  const [server, client] = calls.filter(args => args[0] === 'run');
  const has = (args: string[], flag: string, value: string) => assert.equal(args[args.indexOf(flag) + 1], value);
  has(server, '--network', 'none');
  assert.ok(server.includes('unix_socket_directories=/var/run/postgresql,@/fukulow796'));
  has(client, '--network', `container:${launched[0]}`);
  has(client, '-e', 'PGHOST=@/fukulow796');
  for (const [args, set] of [[server, 'server'], [client, 'client']] as const) {
    has(args, '--cgroup-parent', measurementSlice);
    has(args, '--cpuset-cpus', sets796[set].join(','));
    assert.deepEqual(record.containerCpusets?.[set].effective, sets796[set]);
  }
  const psql = calls.find(args => args.includes('psql'));
  assert.deepEqual(psql?.slice(0, 8), ['exec', '--user', 'postgres', launched[1], 'taskset', '-c', sets796.client.join(','), 'psql']);
  assert.ok(psql?.includes('SELECT inet_client_addr() IS NULL AND inet_server_addr() IS NULL'));
  assert.equal(record.abstractSocket, 't');
  assert.equal(spotCalls, 1);
  assert.match(record.turbostat?.stdout ?? '', /FUKULOW_TURBOSTAT_READY/);
  assert.deepEqual(removed, [...launched].reverse());
  assert.deepEqual(record.affinityAfter, record.affinity);
});

test('host check fails on a movable kthread outside housekeeping in the post-cleanup readback', async () => {
  const { ok, record, launched, removed } = await fixture({ lateRootTask: true })();
  assert.deepEqual(removed, [...launched].reverse());
  assert.deepEqual(record.affinity?.rootTasks, {});
  assert.deepEqual(record.affinityAfter?.rootTasks, { '42': { name: 'late-kthread', cpus: [6], movable: true } });
  assert.equal(ok, false);
  assert.deepEqual(record.problems, ['finish: movable root task 42 (late-kthread) affinity differs from housekeeping']);
});

test('host check stops before containers when affinity fails', async () => {
  const { ok, record, calls, spotCalls } = await fixture({ badAffinity: true })();
  assert.equal(ok, false);
  assert.match(record.problems.join(), /irqbalance must be inactive/);
  assert.deepEqual(calls, []);
  assert.equal(spotCalls, 0);
});

test('host check stops before launching anything when another container is running', async () => {
  const { ok, record, calls, spotCalls } = await fixture({ busy: true })();
  assert.equal(ok, false);
  assert.match(record.problems.join(), /needs an idle host/);
  assert.deepEqual(calls, [['ps', '-q']]);
  assert.equal(spotCalls, 0);
});

test('host check fails on container, socket, observer or cleanup errors', async () => {
  for (const [fault, expected, spotCalls] of [
    ['badCpuset', /client container effective cpuset/, 0],
    ['badSocket', /expected a psql round trip/, 0],
    ['badSpot', /turbostat exited before its opening sample/, 1],
    ['badCleanup', /host check containers remain/, 1],
  ] as const) {
    const result = await fixture({ [fault]: true })();
    assert.equal(result.ok, false);
    assert.match(result.record.problems.join(), expected);
    assert.equal(result.spotCalls, spotCalls);
    if (fault === 'badCleanup') assert.deepEqual(result.removed, [result.launched[0]]);
    else assert.deepEqual(result.removed, [...result.launched].reverse());
  }
});
