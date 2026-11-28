import assert from 'node:assert/strict';
import test from 'node:test';
import { cpuList } from '../../harness-core/cpusets.ts';
import { measurementSlice, sets796 } from '../../harness-core/frequency-layout.ts';
import { ownershipLabel } from '../runtime.ts';
import { diagnosticCluster, resourceNames } from './placement.ts';

const names = resourceNames('test');
const settings = {snapshotDirectory: '/snapshot', image: 'sha256:image', shmBytes: 1024, startupAttempts: 2, startupPollMs: 123};

function fake() {
  const calls: string[][] = [];
  const reads: string[] = [];
  const sleeps: number[] = [];
  const connection = {ready: true};
  let serverPid = 11;
  const clientPid = 22;
  const id = {server: 'a'.repeat(64), client: 'b'.repeat(64)};
  const cgroup = {server: `/${measurementSlice}/docker-${id.server}.scope`, client: `/${measurementSlice}/docker-${id.client}.scope`};
  const files: Record<string, string> = {};
  for (const [role, pid] of [['server', serverPid], ['client', clientPid], ['server', 33]] as const) {
    files[`/proc/${pid}/cgroup`] = `0::${cgroup[role]}\n`;
    files[`/proc/${pid}/status`] = `Cpus_allowed_list:\t${cpuList(sets796[role])}\n`;
    files[`/sys/fs/cgroup${cgroup[role]}/cpuset.cpus.effective`] = cpuList(sets796[role]);
  }
  const read = (path: string) => {
    reads.push(path);
    assert.ok(Object.hasOwn(files, path), `missing readback: ${path}`);
    return files[path];
  };
  const docker = (...args: string[]) => {
    calls.push(args);
    if (args[0] === 'inspect') {
      assert.match(args.at(-1)!, new RegExp(`^(${names.server}|${names.client})$`));
      return args.at(-1) === names.server ? `${id.server} ${serverPid}` : `${id.client} ${clientPid}`;
    }
    if (args[0] === 'restart') serverPid = 33;
    return '';
  };
  const io = {
    docker,
    command: (program: string, args: string[]) => { assert.equal(program, 'docker'); return docker(...args); },
    boundedCommand: (program: string, args: string[]) => { assert.equal(program, 'docker'); return docker(...args); },
    sql: (client: string, db: string, statement: string) => {
      calls.push(['sql', client, db, statement]);
      return connection.ready ? 't' : 'f';
    },
  };
  const cluster = diagnosticCluster(io, names, settings, 'session', async ms => { sleeps.push(ms); }, read);
  return {cluster, calls, reads, sleeps, connection, files, cgroup};
}

test('qualified containers get distinct cpusets and share the PostgreSQL Unix-socket volume', async () => {
  const f = fake();
  const evidence = await f.cluster.start('password');
  assert.deepEqual(f.calls.filter(args => args[0] === 'volume').map(args => args.at(-1)), [names.data, names.socket]);
  const [server, client] = f.calls.filter(args => args[0] === 'run');
  for (const [args, role] of [[server, 'server'], [client, 'client']] as const) {
    assert.equal(args[args.indexOf('--name') + 1], names[role]);
    assert.equal(args[args.indexOf('--label') + 1], ownershipLabel);
    assert.equal(args[args.indexOf('--cgroup-parent') + 1], measurementSlice);
    assert.equal(args[args.indexOf('--cpuset-cpus') + 1], cpuList(sets796[role]));
    assert.ok(args.includes('--network=none'));
  }
  const socket = `type=volume,source=${names.socket},target=/var/run/postgresql`;
  assert.ok(server.includes(socket));
  assert.ok(client.includes(`${socket},readonly,volume-nocopy`));
  assert.ok(client.includes('PGHOST=/var/run/postgresql'));
  assert.equal(client[client.indexOf('--tmpfs') + 1], '/var/lib/postgresql');
  assert.deepEqual(evidence.cpusets, {launchSession: 'session',
    server: {cgroup: f.cgroup.server, effective: sets796.server}, client: {cgroup: f.cgroup.client, effective: sets796.client}});
  assert.deepEqual(evidence.processes.client?.affinity, sets796.client);
  assert.equal(evidence.transport, 'unix-socket');
});

test('placement refuses wrong or unreadable cgroups, cpusets, and process affinities', async () => {
  const cases = [
    ['/proc/11/cgroup', '0::/system.slice/docker.service', /outside fukulow796.slice/],
    ['/proc/22/cgroup', undefined, /missing readback/],
    ['/proc/22/status', 'Cpus_allowed_list:\t1,3', /effective affinity.*differs/],
    ['/proc/11/status', '', /Cpus_allowed_list not found/],
    [`/sys/fs/cgroup/${measurementSlice}/docker-${'b'.repeat(64)}.scope/cpuset.cpus.effective`, '1-6,9-14', /client container effective cpuset/],
    [`/sys/fs/cgroup/${measurementSlice}/docker-${'a'.repeat(64)}.scope/cpuset.cpus.effective`, undefined, /missing readback/],
  ] as const;
  for (const [path, value, reason] of cases) {
    const f = fake();
    if (value === undefined) delete f.files[path];
    else f.files[path] = value;
    await assert.rejects(f.cluster.start('password'), reason, path);
  }
});

test('restart leaves the client in place, checks its Unix-socket connection and reads the new postmaster', async () => {
  const f = fake();
  const initial = await f.cluster.start('password');
  f.calls.length = 0;
  f.reads.length = 0;
  const restarted = await f.cluster.restart();
  assert.deepEqual(f.calls.slice(0, 3).map(args => args.slice(0, 3)),
    [['restart', names.server], ['exec', names.client, 'pg_isready'], ['sql', names.client, 'postgres']]);
  assert.match(f.calls[2][3], /inet_server_addr\(\) IS NULL AND inet_client_addr\(\) IS NULL/);
  assert.ok(f.reads.includes('/proc/33/status'));
  assert.ok(f.reads.includes('/proc/22/status'));
  assert.deepEqual(restarted.processes.client, initial.processes.client);
  assert.equal(restarted.processes.server?.pid, 33);
  assert.ok(f.calls.every(args => args[0] !== 'run' && args[0] !== 'volume'));

  f.connection.ready = false;
  await assert.rejects(f.cluster.restart(), /waiting for the client Unix socket/);
  assert.deepEqual(f.sleeps, [settings.startupPollMs, settings.startupPollMs]);
  f.connection.ready = true;
  delete f.files['/proc/33/status'];
  await assert.rejects(f.cluster.restart(), /missing readback/);
});
