import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cpuList } from './harness-core/cpusets.ts';
import { postgresServerContainer } from './harness-core/frequency-container-args.ts';
import { measuredCpus, measurementSlice, sets796 } from './harness-core/frequency-layout.ts';
import { checkPlacement, clientScope, placementEnabled, postgresContainer, recordPlacement, serverPrefix } from './revocation-holds-placement.ts';
import { SetupAbort } from './revocation-holds-setup.ts';

const cgroup = `/${measurementSlice}/run-test.scope`;
function missing(path: string) {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
}

function procFiles(affinity: number[], cpuset = measuredCpus, scope = cgroup, cpusetAt = scope) {
  const files: Record<string, string> = {
    '/proc/42/status': `Name:\ttest\nCpus_allowed_list:\t${cpuList(affinity)}\n`,
    '/proc/42/cgroup': `0::${scope}\n`,
    [`/sys/fs/cgroup${cpusetAt}/cpuset.cpus.effective`]: cpuList(cpuset),
  };
  return (path: string) => {
    if (files[path] === undefined) throw missing(path);
    return files[path];
  };
}

test('Linux launch names the client scope by PID and pins Node on #796', () => {
  assert.deepEqual(clientScope(42), ['systemd-run', '--scope', '--quiet', '--collect', '--no-ask-password',
    `--slice=${measurementSlice}`, '--unit=fukulow668-client-42.scope', '--', 'taskset', '-c', cpuList(sets796.client)]);
  assert.ok(clientScope('$$').includes('--unit=fukulow668-client-$$.scope'));
  assert.deepEqual(serverPrefix(), ['taskset', '-c', cpuList(sets796.server)]);
});

test('Linux Postgres placement reuses the #796 server container arguments', () => {
  assert.equal(postgresContainer, postgresServerContainer);
  assert.deepEqual(postgresContainer(), {
    options: ['--cgroup-parent', measurementSlice, '--cpuset-cpus', cpuList(sets796.server), '--entrypoint', 'taskset'],
    command: ['-c', cpuList(sets796.server), 'docker-entrypoint.sh', 'postgres'],
  });
});

test('CLI help gives the one-time install and a noninteractive PID-named launch', () => {
  const help = execFileSync(process.execPath, [join(import.meta.dirname, 'revocation-holds.ts'), '--help'], { encoding: 'utf8' });
  assert.match(help, /boot-796.ts install --measurement-user USER/);
  assert.match(help, /^Linux launch as the measurement user\n  systemd-run .*--no-ask-password .*--unit=fukulow668-client-\$\$\.scope -- /m);
});

test('placement reads back each expected affinity and rejects an incorrect slice, affinity or cpuset', () => {
  for (const [role, affinity] of [
    ['server', sets796.server], ['postgres', sets796.server], ['client', sets796.client], ['helper', sets796.client],
  ] as const) {
    const cpuset = role === 'postgres' ? sets796.server : measuredCpus;
    assert.deepEqual(checkPlacement(role, 42, procFiles(affinity, cpuset)), { pid: 42, cgroup, affinity, cpuset, cpusetCgroup: cgroup });
    assert.throws(() => checkPlacement(role, 42, procFiles(affinity.slice(1), cpuset)), /effective affinity/);
    assert.throws(() => checkPlacement(role, 42, procFiles(affinity, cpuset, '/user.slice/run-test.scope')), /outside fukulow796/);
    assert.throws(() => checkPlacement(role, undefined, procFiles(affinity, cpuset)), /no process id/);
    assert.throws(() => checkPlacement(role, 42, procFiles(affinity, [...cpuset, sets796.housekeeping[0]])), /effective cpuset/);
    assert.throws(() => checkPlacement(role, 42, procFiles(affinity, cpuset.filter(cpu => cpu !== affinity[0]))), /effective cpuset/);
  }
  assert.throws(() => checkPlacement('postgres', 42, procFiles(sets796.server)), /effective cpuset/);
});

test('a scope without its own cpuset controller reads the nearest ancestor up to the measurement slice only', () => {
  const slice = `/${measurementSlice}`;
  const scope = `${slice}/fukulow668-client-42.scope`;
  assert.deepEqual(checkPlacement('client', 42, procFiles(sets796.client, measuredCpus, scope, slice)),
    { pid: 42, cgroup: scope, affinity: sets796.client, cpuset: measuredCpus, cpusetCgroup: slice });
  assert.throws(() => checkPlacement('client', 42, procFiles(sets796.client, [...measuredCpus, sets796.housekeeping[0]], scope, slice)),
    /effective cpuset/);
  // The cgroup root is above the slice and never counts as the scope's cpuset.
  assert.throws(() => checkPlacement('client', 42, procFiles(sets796.client, measuredCpus, scope, '')), /no cpuset\.cpus\.effective/);
  const denied = procFiles(sets796.client, measuredCpus, scope, slice);
  assert.throws(() => checkPlacement('client', 42, path => {
    if (path.endsWith('.scope/cpuset.cpus.effective')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return denied(path);
  }), /EACCES/);
});

test('the nearest ancestor wins and an empty or malformed cpuset aborts instead of falling back', () => {
  const slice = `/${measurementSlice}`;
  const middle = `${slice}/inner.slice`;
  const scope = `${middle}/fukulow668-client-42.scope`;
  const nested = (middleCpuset: string | undefined) => {
    const base = procFiles(sets796.client, measuredCpus, scope, slice);
    return (path: string) => path === `/sys/fs/cgroup${middle}/cpuset.cpus.effective` && middleCpuset !== undefined
      ? middleCpuset : base(path);
  };
  assert.deepEqual(checkPlacement('client', 42, nested(cpuList(sets796.client))),
    { pid: 42, cgroup: scope, affinity: sets796.client, cpuset: sets796.client, cpusetCgroup: middle });
  assert.equal(checkPlacement('client', 42, nested(undefined)).cpusetCgroup, slice);
  assert.throws(() => checkPlacement('client', 42, nested('')), /invalid CPU list/);
  assert.throws(() => checkPlacement('client', 42, nested('1-x')), /invalid CPU list/);
});

test('Postgres needs its own container cpuset even when an ancestor has the exact server CPUs', () => {
  const slice = `/${measurementSlice}`;
  const container = `${slice}/docker-${'a'.repeat(64)}.scope`;
  assert.equal(checkPlacement('postgres', 42, procFiles(sets796.server, sets796.server, container)).cpusetCgroup, container);
  assert.throws(() => checkPlacement('postgres', 42, procFiles(sets796.server, sets796.server, container, slice)), /ENOENT/);
});

test('placement rejects a lookalike slice, dot path components and invalid process ids', () => {
  for (const scope of [`/${measurementSlice}X/run-test.scope`, `/${measurementSlice}/../user.slice/run.scope`,
    `/${measurementSlice}/./run.scope`]) {
    assert.throws(() => checkPlacement('client', 42, procFiles(sets796.client, measuredCpus, scope)), /outside fukulow796/);
  }
  for (const pid of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => checkPlacement('client', pid, procFiles(sets796.client)), /no process id/);
  }
});

test('startup records effective placement and aborts setup on mismatch', t => {
  const dir = mkdtempSync(join(tmpdir(), 'revocation-placement-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const check = recordPlacement(dir, true, procFiles(sets796.client));
  check('client', () => 42);
  assert.throws(() => check('server', () => 42), SetupAbort);
  const record = JSON.parse(readFileSync(join(dir, 'environment.json'), 'utf8'));
  assert.deepEqual(record.placement.client, { pid: 42, cgroup, affinity: sets796.client, cpuset: measuredCpus, cpusetCgroup: cgroup });
  assert.match(record.placement.server.error, /server effective affinity/);
  assert.doesNotThrow(() => recordPlacement(dir, false, () => { throw new Error('unexpected /proc read'); })('client', () => 42));
});

test('Linux placement is mandatory for formal runs and macOS supports local rehearsal', () => {
  for (const mode of ['preflight', 'rehearsal', 'overhead', 'formal'] as const) assert.equal(placementEnabled('linux', mode), true);
  assert.equal(placementEnabled('darwin', 'rehearsal'), false);
  assert.equal(placementEnabled('darwin', 'preflight'), false);
  assert.throws(() => placementEnabled('darwin', 'formal'), /requires Linux/);
});
