import assert from 'node:assert/strict';
import test from 'node:test';
import { cpus796, measurementSlice, sets796 } from '../../harness-core/frequency-layout.ts';
import type { HostRecord } from '../../harness-core/host-record.ts';
import { hostAffinity, policy, session } from '../../sql-probes/519-unread-counts/frequency-fixture.ts';
import { readHostGate } from './host-gate.ts';

const record = {logicalCpus: cpus796.length, boost: '0', policyBoost: {'0': cpus796},
  platformProfile: 'performance', maxFrequencyKHz: {'4000000': cpus796}} as unknown as HostRecord;
const fake = () => ({
  os: (): NodeJS.Platform => 'linux',
  service: () => 'active',
  coordinator: () => sets796.housekeeping,
  record: () => record,
  policy: (cpus: number[]) => { assert.deepEqual(cpus, cpus796); return structuredClone(policy); },
  affinity: hostAffinity,
});

test('the #870 host gate records live #796 isolation and uses the effective cap', () => {
  const result = readHostGate(session, '/fake', fake());
  assert.deepEqual(result.problems, []);
  assert.equal(result.service, 'active');
  assert.equal(result.affinity?.docker, 'systemd 2');
  assert.deepEqual(result.coordinator, sets796.housekeeping);
  assert.ok(result.policy?.policies.every(p => p.max === '2000000'));
});

test('the #870 host gate refuses inactive service, wrong Docker cgroups, and stale or missing affinity', () => {
  const io = fake();
  assert.match(readHostGate(session, '/fake', {...io, service: () => 'inactive'}).problems.join(), /host\.service must be active/);
  const missingSlice = hostAffinity();
  delete missingSlice.groups![measurementSlice];
  for (const [affinity, reason] of [
    [{...hostAffinity(), docker: 'cgroupfs 1'}, /systemd cgroup driver/],
    [{...hostAffinity(), bootId: 'other'}, /session and boot/],
    [missingSlice, /needs the measured CPUs/],
    [{...hostAffinity(), groups: {...hostAffinity().groups, 'user.slice': {cpus: sets796.server, populated: true}}}, /differs from housekeeping/],
  ] as const) {
    const problems = readHostGate(session, '/fake', {...io, affinity: () => affinity}).problems;
    assert.match(problems.join(), reason);
  }
  assert.match(readHostGate(session, '/fake', {...io, coordinator: () => sets796.server}).problems.join(), /coordinator must run on housekeeping/);
});

test('the #870 host gate refuses the wrong cap and missing policy or boost readbacks', () => {
  const io = fake();
  const check = (override: Partial<typeof io>) => readHostGate(session, '/fake', {...io, ...override}).problems.join();
  assert.match(check({policy: cpus => {
    const snapshot = io.policy(cpus);
    snapshot.policies[4].max = '1700000';
    return snapshot;
  }}), /2000000 kHz/);
  assert.match(check({policy: () => { throw new Error('missing scaling_max_freq'); }}), /missing scaling_max_freq/);
  assert.match(check({record: () => ({...record, boost: null, policyBoost: null, platformProfile: 'balanced'})}),
    /boost is unreadable.*per-CPU boost.*platform profile is balanced/);
});
