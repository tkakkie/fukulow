import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backingDevices, resolveMount } from './disk-device.ts';
import { samplerCpu } from './disk-sampling.ts';

const mounts = [
  { Type: 'volume', Source: '/var/lib/docker/volumes/pg/_data', Destination: '/var/lib/postgresql' },
  { Type: 'bind', Source: '/srv/wal disk/pgwal', Destination: '/var/lib/postgresql/18/docker/pg_wal' },
];
const mountinfo = [
  '20 1 8:1 / / rw - ext4 /dev/sda1 rw',
  '21 20 253:0 / /var/lib/docker rw - ext4 /dev/mapper/data rw',
  '22 20 259:2 / /srv/wal\\040disk rw - xfs /dev/nvme0n1p2 rw',
].join('\n');
const data = { path: '/var/lib/postgresql/18/docker', device: '253:0' };
const wal = { path: data.path + '/pg_wal', device: '259:2' };

test('Docker volume and nested WAL bind resolve to their exact host filesystem devices', () => {
  assert.deepEqual(resolveMount(mounts, mountinfo, data), {
    ...data, dockerMount: mounts[0], hostPath: '/var/lib/docker/volumes/pg/_data/18/docker',
    hostMount: { device: '253:0', root: '/', mountpoint: '/var/lib/docker', fs: 'ext4', source: '/dev/mapper/data' },
  });
  assert.equal(resolveMount(mounts, mountinfo, wal).hostMount.mountpoint, '/srv/wal disk');
});

test('device resolution fails closed on overlay, path-prefix lookalikes, ambiguity or a host mismatch', () => {
  assert.throws(() => resolveMount([], mountinfo, data), /no unambiguous Docker mount/);
  assert.throws(() => resolveMount(mounts, mountinfo, { ...data, path: '/var/lib/postgresql-other/18/docker' }), /no unambiguous Docker mount/);
  assert.throws(() => resolveMount([{ ...mounts[0], Type: 'tmpfs' }], mountinfo, data), /not a host volume or bind/);
  assert.throws(() => resolveMount(mounts, mountinfo, { ...data, device: '8:1' }), /disagrees with host mount/);
  assert.throws(() => resolveMount(mounts, mountinfo + '\n' + mountinfo.split('\n')[1], data), /no unambiguous host mount/);
});

test('stacked device, partition and whole disk are kept once each', () => {
  const links: Record<string, string[]> = { '253:0': ['259:2', '8:0'], '259:2': ['259:0'], '259:0': [], '8:0': [] };
  assert.deepEqual(backingDevices(['253:0', '259:2'], id => links[id]), ['253:0', '259:2', '259:0', '8:0']);
});

test('sampler picks an allowed housekeeping CPU and rejects a workload-only mask', () => {
  const pins = { server: [1, 3], client: [2, 4], housekeeping: [0, 5] };
  assert.equal(samplerCpu(pins, [2, 3, 5]), 5);
  assert.equal(samplerCpu({ server: pins.server, client: pins.client }, [1, 2, 5]), 5);
  assert.throws(() => samplerCpu(pins, [1, 2, 3, 4]), /outside both workload CPU sets/);
});
