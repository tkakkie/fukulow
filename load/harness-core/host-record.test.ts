import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedCpus, parseCpuList, parseCpuSets, pinned } from './cpusets.ts';
import { groupBy, linuxViolations, parseMeminfo, parseSnapHold, sleepUnits, timerServices, updateUnits, type HostRecord } from './host-record.ts';

const off = (unit: string) => ({ unit, enabled: 'disabled', active: 'inactive' });
const masked = (unit: string) => ({ unit, enabled: 'masked', active: 'inactive' });
const ready: HostRecord = {
  at: '2026-11-24T00:00:00Z', platform: 'linux', kernel: '7.0.0', cpuModel: 'test', logicalCpus: 4,
  governors: { performance: [0, 1, 2, 3] }, energyPreference: null, maxFrequencyKHz: null, boost: '1', policyBoost: null, powerProfile: 'performance',
  memoryBytes: 1, meminfoKiB: null, swappiness: '60', loadAverage: [0, 0, 0], ac: [{ supply: 'ACAD', online: true }],
  temperaturesC: null, disk: null, docker: null, updateUnits: [...updateUnits, ...timerServices].map(off), sleepUnits: sleepUnits.map(masked), snapHold: 'forever',
};

test('a host that meets every Linux condition has no violations', () => {
  assert.deepEqual(linuxViolations(ready), []);
});

const withUnit = (list: 'updateUnits' | 'sleepUnits', state: { unit: string; enabled: string; active: string }) =>
  ({ [list]: ready[list]!.map(u => u.unit === state.unit ? state : u) });

test('each unmet Linux condition is a violation', () => {
  const cases: [Partial<HostRecord>, RegExp][] = [
    [{ governors: { performance: [0, 1], powersave: [2, 3] } }, /governor/],
    [{ governors: { performance: [0, 1, 2] } }, /governor/], // CPU 3 unreadable
    [{ governors: null }, /governor.*unreadable/],
    [{ ac: [{ supply: 'ACAD', online: false }] }, /AC power/],
    [{ ac: [] }, /AC power/],
    [{ ac: null }, /AC power/],
    [withUnit('updateUnits', { unit: 'apt-daily.timer', enabled: 'enabled', active: 'inactive' }), /apt-daily\.timer is enabled\/inactive/],
    [withUnit('updateUnits', { unit: 'apt-daily.timer', enabled: 'disabled', active: 'activating' }), /apt-daily\.timer/],
    [withUnit('updateUnits', { unit: 'unattended-upgrades.service', enabled: 'disabled', active: 'active' }), /unattended-upgrades/],
    [withUnit('updateUnits', { unit: 'fwupd-refresh.timer', enabled: 'unknown', active: 'inactive' }), /fwupd-refresh\.timer is unknown/],
    // A stopped timer whose service is still running.
    [withUnit('updateUnits', { unit: 'apt-daily-upgrade.service', enabled: 'static', active: 'active' }), /update service apt-daily-upgrade\.service/],
    [withUnit('updateUnits', { unit: 'motd-news.service', enabled: 'static', active: 'unknown' }), /motd-news\.service/],
    [{ updateUnits: ready.updateUnits!.filter(u => u.unit !== 'motd-news.timer') }, /motd-news\.timer not recorded/],
    [withUnit('sleepUnits', { unit: 'suspend.target', enabled: 'static', active: 'inactive' }), /sleep target suspend\.target/],
    [{ snapHold: 'none' }, /snap refreshes are not held/],
    [{ snapHold: null }, /snap refresh state unreadable/],
    [{ logicalCpus: 0, governors: null }, /governor/], // no CPUs enumerated
  ];
  for (const [change, pattern] of cases) {
    const v = linuxViolations({ ...ready, ...change });
    assert.equal(v.length, 1, `${JSON.stringify(change)} -> ${JSON.stringify(v)}`);
    assert.match(v[0], pattern);
  }
  // Without systemctl, both unit lists are unreadable.
  assert.deepEqual(linuxViolations({ ...ready, updateUnits: null, sleepUnits: null }).length, 3);
});

test('states that cannot run an update job, or a second idle supply, are not violations', () => {
  assert.deepEqual(linuxViolations({ ...ready, ...withUnit('updateUnits', { unit: 'motd-news.timer', enabled: 'not-found', active: 'inactive' }) }), []);
  assert.deepEqual(linuxViolations({ ...ready, ...withUnit('updateUnits', { unit: 'apt-daily.service', enabled: 'static', active: 'failed' }) }), []);
  assert.deepEqual(linuxViolations({ ...ready, ac: [{ supply: 'ACAD', online: true }, { supply: 'DOCK', online: false }] }), []);
  assert.deepEqual(linuxViolations({ ...ready, snapHold: 'absent' }), []);
});

test('Linux conditions do not apply to other platforms', () => {
  assert.deepEqual(linuxViolations({ ...ready, platform: 'darwin', governors: null, ac: null, updateUnits: null }), []);
});

test('host readings are parsed from their sources', () => {
  assert.deepEqual(groupBy(['performance', null, 'performance', 'powersave']), { performance: [0, 2], powersave: [3] });
  assert.equal(groupBy([null]), null);
  assert.deepEqual(parseMeminfo('MemTotal:       30030000 kB\nSwapTotal:       8388604 kB\nSwapFree: 8388604 kB\nCached: 1 kB\n'),
    { MemTotal: 30030000, SwapTotal: 8388604, SwapFree: 8388604 });
  assert.equal(parseSnapHold('timer: 00:00~24:00/4\nhold: forever\nnext: today (but held)\n'), 'forever');
  assert.equal(parseSnapHold('timer: 00:00~24:00/4\n'), 'none');
});

test('CPU sets are parsed, disjoint and on the host', () => {
  assert.deepEqual(parseCpuList('0,2,4-6'), [0, 2, 4, 5, 6]);
  assert.deepEqual(parseCpuSets('server=0,2;client=1,3', 4), { server: [0, 2], client: [1, 3] });
  assert.throws(() => parseCpuSets('server=0,1;client=1,3', 4), /overlap on 1/);
  assert.throws(() => parseCpuSets('server=0;client=4', 4), /CPU 4 does not exist/);
  assert.throws(() => parseCpuSets('server=0', 4), /exactly server/);
  assert.throws(() => parseCpuList('0,x'), /invalid CPU list/);
  assert.throws(() => parseCpuList('3-1'), /invalid CPU range/);
  assert.throws(() => parseCpuSets('server=0;client=1-9007199254740992', 4), /does not exist/);
});

test('pinning wraps a command with taskset only when a set is given', () => {
  assert.deepEqual(pinned([1, 3], ['pgbench', '-n']), ['taskset', '-c', '1,3', 'pgbench', '-n']);
  assert.deepEqual(pinned(undefined, ['pgbench', '-n']), ['pgbench', '-n']);
  assert.deepEqual(allowedCpus('Name:\tcat\nCpus_allowed_list:\t1,3,5-7\n'), [1, 3, 5, 6, 7]);
  assert.throws(() => allowedCpus('Name:\tcat\n'), /not found/);
});
