import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cpuList } from './harness-core/cpusets.ts';
import { measuredCpus, measurementSlice, sets796 } from './harness-core/frequency-layout.ts';
import { checkPlacement, clientScope, placementEnabled, postgresContainer, recordPlacement, serverPrefix } from './revocation-holds-placement.ts';
import { SetupAbort } from './revocation-holds-setup.ts';

const cgroup = `/${measurementSlice}/run-test.scope`;
function procFiles(affinity: number[], cpuset = measuredCpus, scope = cgroup) {
  const files: Record<string, string> = {
    '/proc/42/status': `Name:\ttest\nCpus_allowed_list:\t${cpuList(affinity)}\n`,
    '/proc/42/cgroup': `0::${scope}\n`,
    [`/sys/fs/cgroup${scope}/cpuset.cpus.effective`]: cpuList(cpuset),
  };
  return (path: string) => {
    if (files[path] === undefined) throw new Error(`missing ${path}`);
    return files[path];
  };
}

test('Linux launch pins Node, the server and Postgres using #796 settings', () => {
  assert.deepEqual(clientScope(), ['systemd-run', '--scope', '--quiet', '--collect', '--no-ask-password',
    `--slice=${measurementSlice}`, '--', 'taskset', '-c', cpuList(sets796.client)]);
  assert.deepEqual(serverPrefix(), ['taskset', '-c', cpuList(sets796.server)]);
  assert.deepEqual(postgresContainer(), {
    options: ['--cgroup-parent', measurementSlice, '--cpuset-cpus', cpuList(sets796.server), '--entrypoint', 'taskset'],
    command: ['-c', cpuList(sets796.server), 'docker-entrypoint.sh', 'postgres'],
  });
});

test('placement reads back each expected affinity and rejects an incorrect slice, affinity or cpuset', () => {
  for (const [role, affinity] of [
    ['server', sets796.server], ['postgres', sets796.server], ['client', sets796.client], ['helper', sets796.client],
  ] as const) {
    const cpuset = role === 'postgres' ? sets796.server : measuredCpus;
    assert.deepEqual(checkPlacement(role, 42, procFiles(affinity, cpuset)), { pid: 42, cgroup, affinity, cpuset });
    assert.throws(() => checkPlacement(role, 42, procFiles(affinity.slice(1), cpuset)), /effective affinity/);
    assert.throws(() => checkPlacement(role, 42, procFiles(affinity, cpuset, '/user.slice/run-test.scope')), /outside fukulow796/);
    assert.throws(() => checkPlacement(role, undefined, procFiles(affinity, cpuset)), /no process id/);
    assert.throws(() => checkPlacement(role, 42, procFiles(affinity, [...cpuset, sets796.housekeeping[0]])), /effective cpuset/);
    assert.throws(() => checkPlacement(role, 42, procFiles(affinity, cpuset.filter(cpu => cpu !== affinity[0]))), /effective cpuset/);
  }
  assert.throws(() => checkPlacement('postgres', 42, procFiles(sets796.server)), /effective cpuset/);
});

test('startup records effective placement and aborts setup on mismatch', t => {
  const dir = mkdtempSync(join(tmpdir(), 'revocation-placement-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const check = recordPlacement(dir, true, procFiles(sets796.client));
  check('client', () => 42);
  assert.throws(() => check('server', () => 42), SetupAbort);
  const record = JSON.parse(readFileSync(join(dir, 'environment.json'), 'utf8'));
  assert.deepEqual(record.placement.client, { pid: 42, cgroup, affinity: sets796.client, cpuset: measuredCpus });
  assert.match(record.placement.server.error, /server effective affinity/);
  assert.doesNotThrow(() => recordPlacement(dir, false, () => { throw new Error('unexpected /proc read'); })('client', () => 42));
});

test('Linux placement is mandatory for formal runs and macOS supports local rehearsal', () => {
  for (const mode of ['preflight', 'rehearsal', 'overhead', 'formal'] as const) assert.equal(placementEnabled('linux', mode), true);
  assert.equal(placementEnabled('darwin', 'rehearsal'), false);
  assert.equal(placementEnabled('darwin', 'preflight'), false);
  assert.throws(() => placementEnabled('darwin', 'formal'), /requires Linux/);
});
