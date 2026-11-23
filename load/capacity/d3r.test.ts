import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchTables } from '../search-engines/d3r/rls.ts';
import { appSessionSettings, hash } from '../search-engines/manifest.ts';
import { backfillArchiveBytes, expectedSamples, GiB, judge, margin, needs, rehearsalFigures, type Figures } from './d3r.ts';
import { darwinPool, desktopDisk, desktopDiskLocation, dfMount, dfTotal, hostStore, imageMatchesVm, linuxPool, localDocker, type Pool, type Store } from './stores.ts';

const f: Figures = {archiveBytes: 60 * GiB, vmRoundPeak: 70 * GiB, vmRoundGrowth: 1 * GiB, roundOutputBytes: 4 * 1024 ** 2, formalRounds: 3};
const disk = (free: number, used = 0) => ({free, used});
const store = (id: string, free: number, kind: Store['kind'] = 'host'): Store => ({id, kind, paths: [], free, mounts: []});

test('the margin is 20% of the need and at least 20 GiB', () => {
  assert.equal(margin(10 * GiB), 20 * GiB);
  assert.equal(margin(200 * GiB), 40 * GiB);
});

test('paths in one pool share one store: the lowest free value, needs summed once', () => {
  const pools: Record<string, Pool> = {'/out': {pool: 'apfs:disk3', free: 9 * GiB, mount: '/Volumes/Out', fs: 'apfs'},
    '/docker.raw': {pool: 'apfs:disk3', free: 8 * GiB, mount: '/System/Volumes/Data', fs: 'apfs'},
    '/backfill': {pool: 'volume:disk5s1', free: 5 * GiB, mount: '/Volumes/External SSD', fs: 'exfat'}};
  const {ids, stores} = hostStore(Object.keys(pools), p => pools[p]);
  assert.deepEqual(ids, ['host:apfs:disk3', 'host:apfs:disk3', 'host:volume:disk5s1']);
  assert.deepEqual(stores.map(s => [s.id, s.paths, s.free, s.mounts]), [
    ['host:apfs:disk3', ['/out', '/docker.raw'], 8 * GiB, ['/Volumes/Out', '/System/Volumes/Data']],
    ['host:volume:disk5s1', ['/backfill'], 5 * GiB, ['/Volumes/External SSD']]]);
  assert.throws(() => hostStore(['/x'], () => ({pool: 'p', free: Number.NaN, mount: '/', fs: 'apfs'})), /free space/);
});

const apfs = (container: string, containerFree: number) =>
  ({FilesystemType: 'apfs', APFSContainerReference: container, APFSContainerFree: containerFree, BusProtocol: 'Apple Fabric'});

test('macOS: APFS volumes in one container are one pool; disk images and unknown filesystems are refused', () => {
  assert.deepEqual(darwinPool('/System/Volumes/Data', apfs('disk3', 340 * GiB), 400 * GiB),
    {pool: 'apfs:disk3', free: 340 * GiB, mount: '/System/Volumes/Data', fs: 'apfs'});
  // A volume quota below the container's free space wins.
  assert.equal(darwinPool('/Volumes/Backfill', apfs('disk3', 340 * GiB), 100 * GiB).free, 100 * GiB);
  assert.deepEqual(darwinPool('/Volumes/Ext', {FilesystemType: 'exfat', DeviceIdentifier: 'disk5s1'}, 5).pool, 'volume:disk5s1');
  assert.throws(() => darwinPool('/Volumes/Img', {...apfs('disk9', 1), BusProtocol: 'Disk Image'}, 1), /disk image/);
  assert.throws(() => darwinPool('/Volumes/X', {FilesystemType: 'apfs'}, 1), /APFS container is unknown/);
  assert.throws(() => darwinPool('/Volumes/Share', {FilesystemType: 'smbfs'}, 1), /not a known local volume/);
});

test('sibling APFS volumes sharing 340 GiB are judged together: STOP where per-device stores would pass', () => {
  const pools: Record<string, Pool> = {'/Volumes/Backfill/run': darwinPool('/Volumes/Backfill', apfs('disk3', 340 * GiB), 340 * GiB),
    '/Docker.raw': darwinPool('/System/Volumes/Data', apfs('disk3', 340 * GiB), 340 * GiB)};
  const host = hostStore(Object.keys(pools), p => pools[p]);
  assert.equal(host.stores.length, 1);
  const list = needs('formal', f, {output: host.ids[0], dockerHost: host.ids[1], vm: 'docker-vm'}, GiB);
  assert.equal(judge([...host.stores, store('docker-vm', 900 * GiB, 'docker-vm')], list).ok, false);
  // Positive control: counted per volume, each would pass on its own.
  const perVolume = needs('formal', f, {output: 'host:a', dockerHost: 'host:b', vm: 'docker-vm'}, GiB);
  assert.equal(judge([store('host:a', 340 * GiB), store('host:b', 340 * GiB), store('docker-vm', 900 * GiB, 'docker-vm')], perVolume).ok, true);
});

test('df mount points keep spaces', () => {
  assert.equal(dfMount('Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk5s1 100 10 90 10% /Volumes/External SSD\n'),
    '/Volumes/External SSD');
  assert.equal(dfMount('Filesystem 1024-blocks Used Available Capacity Mounted on\n//u@nas/share 100 10 90 10% /Volumes/a b'), '/Volumes/a b');
  assert.throws(() => dfMount('garbage'), /Unreadable/);
  assert.equal(dfTotal('Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 954925484 177202384 729141828 20% /'), 954925484 * 1024);
});

const nvme = {path: 66_306, sourceRdev: 66_306}; // st_dev of the path, st_rdev of its device node (259:2)

test('Linux: only plain block devices are pools; thin, loop, btrfs and memory filesystems are refused', () => {
  assert.deepEqual(linuxPool({source: '/dev/nvme0n1p2[/srv]', fstype: 'ext4', target: '/srv'}, 7, nvme),
    {pool: 'st_dev:66306', free: 7, mount: '/srv', fs: 'ext4'});
  for (const found of [{source: '/dev/mapper/vg-thin', fstype: 'ext4'}, {source: '/dev/dm-3', fstype: 'xfs'},
    {source: '/dev/loop0', fstype: 'ext4'}, {source: '/dev/sda1', fstype: 'btrfs'}, {source: 'tmpfs', fstype: 'tmpfs'}, {}]) {
    assert.throws(() => linuxPool({...found, target: '/x'}, 1, nvme), /not a plain local block device/);
  }
});

test('Linux: the pool is the kernel device number, so two names for one device are one pool', () => {
  // The output and DockerRootDir are on one ext4 device that findmnt reports under two names.
  const pools: Record<string, Pool> = {
    '/srv/out': linuxPool({source: '/dev/nvme0n1p2', fstype: 'ext4', target: '/srv'}, 200 * GiB, nvme),
    '/var/lib/docker': linuxPool({source: '/dev/disk/by-uuid/0b6e-4f1c', fstype: 'ext4', target: '/var/lib/docker'}, 200 * GiB, nvme)};
  const host = hostStore(Object.keys(pools), p => pools[p]);
  assert.deepEqual(host.ids, ['host:st_dev:66306', 'host:st_dev:66306']);
  assert.deepEqual(host.stores.map(s => s.mounts), [['/srv', '/var/lib/docker']]);
  const list = needs('formal', f, {output: host.ids[0], dockerHost: host.ids[1]}, GiB);
  // STOP: 60 GiB staged copy + 133 GiB cluster + margin > 200 GiB, although each alone would fit in 200 GiB.
  assert.equal(judge(host.stores, list).ok, false);
  const byName = needs('formal', f, {output: 'host:a', dockerHost: 'host:b'}, GiB);
  assert.equal(judge([store('host:a', 200 * GiB), store('host:b', 200 * GiB)], byName).ok, true);
  // Positive control: on a device with room for the combined need, the shared pool passes.
  const roomy = hostStore(['/srv/out', '/var/lib/docker'], () => ({...pools['/srv/out'], free: 500 * GiB}));
  assert.equal(judge(roomy.stores, needs('formal', f, {output: roomy.ids[0], dockerHost: roomy.ids[1]}, GiB)).ok, true);
  // A different device is a different pool.
  assert.equal(linuxPool({source: '/dev/sdb1', fstype: 'xfs', target: '/data'}, 1, {path: 2_065, sourceRdev: 2_065}).pool, 'st_dev:2065');
  // Refused: the named device is not the one the path is on, or the device node is missing or not a block device.
  for (const dev of [{path: 66_306, sourceRdev: 2_065}, {path: 66_306}, {path: 0, sourceRdev: 0}, {path: Number.NaN, sourceRdev: Number.NaN}]) {
    assert.throws(() => linuxPool({source: '/dev/nvme0n1p2', fstype: 'ext4', target: '/srv'}, 1, dev), /device number/);
  }
});

test('Docker: only the local default daemon, with its own disk image, is measured', () => {
  const home = '/Users/u';
  const socket = `${home}/.docker/run/docker.sock`;
  const real = (p: string) => (p === '/var/run/docker.sock' ? socket : p);
  const desktop = {endpoint: `unix://${socket}`, os: 'Docker Desktop', root: '/var/lib/docker'};
  const ok = {confirmed: true, folders: []};
  assert.deepEqual(localDocker('darwin', home, desktop, real, ok), {desktop: true, disk: desktopDisk(home)});
  assert.deepEqual(localDocker('darwin', home, {...desktop, endpoint: 'unix:///var/run/docker.sock'}, real, ok).disk, desktopDisk(home));
  assert.equal(localDocker('darwin', home, desktop, real, ok, desktopDisk(home)).disk, desktopDisk(home));
  const custom = {confirmed: true, folders: ['/Volumes/Big/Docker']};
  const refused: [Parameters<typeof localDocker>, RegExp][] = [
    [['darwin', home, {...desktop, endpoint: 'tcp://10.0.0.5:2376'}, real, ok], /not a local socket/],
    [['darwin', home, {...desktop, endpoint: 'ssh://builder'}, real, ok], /not a local socket/],
    [['darwin', home, {...desktop, envHost: 'tcp://10.0.0.5:2376'}, real, ok], /DOCKER_HOST differs/],
    [['darwin', home, {...desktop, endpoint: `unix://${home}/.colima/default/docker.sock`, os: 'Ubuntu 24.04 LTS'}, real, ok], /not supported on macOS/],
    [['darwin', home, {...desktop, endpoint: `unix://${home}/.orbstack/run/docker.sock`, os: 'OrbStack'}, real, ok], /not supported on macOS/],
    [['darwin', home, {...desktop, endpoint: `unix://${home}/.colima/default/docker.sock`}, real, ok], /not the local Docker Desktop socket/],
    [['darwin', home, desktop, real, ok, '/Volumes/Other/Docker.raw'], /not the local Docker Desktop disk image/],
    [['linux', home, {endpoint: 'unix:///var/run/docker.sock', os: 'Docker Desktop', root: '/var/lib/docker'}, real], /Docker Desktop for Linux/],
    [['linux', home, {endpoint: 'unix:///var/run/docker.sock', os: 'Ubuntu', root: '/var/lib/docker'}, real, undefined, '/srv'], /DockerRootDir/],
    [['win32', home, {...desktop, endpoint: 'unix:///x'}, real], /Unsupported platform/]];
  for (const [args, message] of refused) assert.throws(() => localDocker(...args), message);
  assert.deepEqual(localDocker('linux', home, {endpoint: 'unix:///var/run/docker.sock', os: 'Ubuntu', root: '/var/lib/docker'}, real),
    {desktop: false, disk: '/var/lib/docker'});
  imageMatchesVm(994_609_987_584, 954_925_484 * 1024);
  assert.throws(() => imageMatchesVm(994_609_987_584, 60 * GiB), /does not match/);
  assert.throws(() => imageMatchesVm(60 * GiB, 900 * GiB), /does not match/);
});

test('Docker Desktop: a custom disk image location, or one that cannot be confirmed, is refused', () => {
  const home = '/Users/u';
  const desktop = {endpoint: `unix://${home}/.docker/run/docker.sock`, os: 'Docker Desktop', root: '/var/lib/docker'};
  const real = (p: string) => p.replace(/\/$/, '');
  const settings = (files: Record<string, string>) => desktopDiskLocation(file => files[file]);
  // Confirmed default: a settings file without the key, with an empty value, or naming the default folder.
  const defaults = [settings({'settings-store.json': '{"AutoStart":true}'}), settings({'settings.json': '{"dataFolder":""}'}),
    settings({'settings-store.json': JSON.stringify({DataFolder: `${home}/Library/Containers/com.docker.docker/Data/vms/0/data/`})})];
  for (const location of defaults) assert.equal(localDocker('darwin', home, desktop, real, location).disk, desktopDisk(home));
  const unconfirmed = [settings({}), settings({'settings-store.json': '{"DataFolder":null}'}), settings({'settings.json': '[]'}),
    settings({'settings-store.json': '{"diskImageLocation":42}', 'settings.json': '{}'})];
  for (const location of unconfirmed) {
    assert.equal(location.confirmed, false);
    assert.throws(() => localDocker('darwin', home, desktop, real, location), /cannot be confirmed/);
  }
  assert.throws(() => localDocker('darwin', home, desktop, real), /cannot be confirmed/);
  assert.throws(() => desktopDiskLocation(() => 'not json'));
  // Custom: always STOP, whichever file names it and whatever --docker-disk says, even beside a default value.
  const custom = [settings({'settings-store.json': '{"DataFolder":"/Volumes/Big/Docker"}'}),
    settings({'settings.json': '{"diskImageLocation":"/Volumes/Big/Docker"}'}),
    settings({'settings-store.json': '{"DataFolder":""}', 'settings.json': '{"dataFolder":"/Volumes/Big/Docker"}'})];
  for (const location of custom) {
    assert.deepEqual(location, {confirmed: true, folders: ['/Volumes/Big/Docker']});
    for (const override of [undefined, '/Volumes/Big/Docker/Docker.raw', desktopDisk(home)]) {
      assert.throws(() => localDocker('darwin', home, desktop, real, location, override), /custom disk image location .* unsupported/);
    }
  }
  // An unresolvable folder cannot be shown to be the default one, so it counts as custom.
  const throwing = (p: string) => { if (p.startsWith('/Volumes/Gone')) throw new Error('ENOENT'); return real(p); };
  assert.throws(() => localDocker('darwin', home, desktop, throwing, {confirmed: true, folders: ['/Volumes/Gone']}), /custom disk image location/);
});

test('formal on Docker Desktop: the VM need lands on the VM disk and on the host disk image, the staged archive on the output store', () => {
  const list = needs('formal', f, {output: 'host:1', dockerHost: 'host:1', vm: 'docker-vm'}, GiB);
  const cluster = (60 + 70 + 3) * GiB;
  const image = (60 + 3 * 71) * GiB; // the host image pays the round peak every round
  assert.deepEqual(list.map(n => [n.store, n.bytes]), [['host:1', 60 * GiB], ['host:1', 12 * 1024 ** 2], ['docker-vm', cluster], ['host:1', image]]);
  // One shared host store: its free value is compared once with the sum of everything written to it.
  const shared = judge([store('host:1', 350 * GiB), store('docker-vm', 900 * GiB, 'docker-vm')], list);
  const row = shared.stores[0];
  assert.equal(row.need, 60 * GiB + 12 * 1024 ** 2 + image);
  assert.equal(row.ok, 350 * GiB >= row.need + margin(row.need));
  assert.equal(shared.ok, false);
  assert.equal(judge([store('host:1', 500 * GiB), store('docker-vm', 900 * GiB, 'docker-vm')], list).ok, true);
});

test('native Docker: the cluster is counted once, on the Docker root store', () => {
  const list = needs('formal', f, {output: 'host:1', dockerHost: 'host:2'}, GiB);
  assert.deepEqual(list.map(n => n.store), ['host:1', 'host:1', 'host:2']);
  const backfill = needs('backfill-only', f, {output: 'host:1', dockerHost: 'host:1'}, GiB);
  assert.deepEqual(backfill.map(n => [n.store, n.bytes]), [['host:1', 60 * GiB], ['host:1', 121 * GiB]]);
});

test('STOP when any store is short, and when a need has no measured store', () => {
  const list = needs('backfill-only', f, {output: 'host:1', dockerHost: 'host:2', vm: 'docker-vm'}, GiB);
  const stores = (vmFree: number) => [store('host:1', 100 * GiB), store('host:2', 500 * GiB), store('docker-vm', vmFree, 'docker-vm')];
  assert.equal(judge(stores(500 * GiB), list).ok, true);
  assert.equal(judge(stores(130 * GiB), list).ok, false);
  assert.throws(() => judge(stores(500 * GiB).slice(0, 2), list));
});

const frozen = {rounds: 3, querySet: [['q1', 'a'], ['q2', 'b']] as const};
function rehearsal() {
  const free = [700, 690, 640, 630, 630, 699].map(n => n * GiB);
  const used = [60, 70, 120, 130, 130, 61].map(n => n * GiB);
  const samples = expectedSamples(frozen.querySet).map((at, i) => ({at, docker: disk(free[i], used[i]), output: disk(1)}));
  return {ok: true, problems: [], rehearsalRounds: 1, formalRounds: 3, samples, projection: {docker: {roundGrowth: GiB}}};
}

test('rehearsal figures come only from a complete one-round record of the frozen round count', () => {
  const handoff = {snapshot: {bytes: 60 * GiB}};
  assert.deepEqual(expectedSamples(frozen.querySet), ['round 1 start', 'round 1 after warm-up', 'round 1 after q1', 'round 1 after q2',
    'round 1 before dropping measured', 'round 1 end']);
  assert.deepEqual(rehearsalFigures(handoff, rehearsal(), 5, frozen),
    {archiveBytes: 60 * GiB, vmRoundPeak: 70 * GiB, vmRoundGrowth: GiB, roundOutputBytes: 5, formalRounds: 3});
  const h = rehearsal();
  const broken: [unknown, RegExp][] = [
    [{...h, ok: false}, /valid one-round record/],
    [{...h, formalRounds: 0}, /frozen formal round count/],
    [{...h, samples: [h.samples[0], h.samples[5]]}, /lacks samples/], // only start and end: the clone peak is hidden
    [{...h, samples: h.samples.filter(s => s.at !== 'round 1 after q2')}, /lacks samples/],
    [{...h, samples: h.samples.map((s, i) => (i === 3 ? {at: s.at, output: s.output} : s))}, /valid Docker samples/],
    [{...h, samples: h.samples.map((s, i) => (i === 3 ? {...s, docker: disk(Number.NaN)} : s))}, /valid Docker samples/],
    [{...h, samples: h.samples.map((s, i) => (i === 3 ? {...s, error: 'df failed'} : s))}, /valid Docker samples/],
    [{...h, projection: {docker: {roundGrowth: 0}}}, /round growth does not match/],
    // All Docker counters zero (growth 0 matches): the measured clone would be charged nothing.
    [{...h, samples: h.samples.map(s => ({...s, docker: disk(0, 0)})), projection: {docker: {roundGrowth: 0}}}, /valid Docker samples/],
    [{...h, samples: h.samples.map((s, i) => (i === 2 ? {...s, docker: disk(s.docker.free, 0)} : s))}, /valid Docker samples/],
    // Every sample in use but free never drops below the start: no round peak.
    [{...h, samples: h.samples.map(s => ({...s, docker: disk(700 * GiB, 60 * GiB)})), projection: {docker: {roundGrowth: 0}}}, /no Docker peak/],
    [{...h, samples: h.samples.map((s, i) => ({...s, docker: disk(i === 0 ? 600 * GiB : 650 * GiB, s.docker.used)}))}, /no Docker peak/]];
  for (const [record, message] of broken) assert.throws(() => rehearsalFigures(handoff, record as never, 5, frozen), message);
  assert.throws(() => rehearsalFigures(handoff, rehearsal(), 5, {...frozen, rounds: 0}), /frozen formal round count/);
  assert.throws(() => rehearsalFigures({snapshot: {bytes: 0}}, rehearsal(), 5, frozen), /archive/);
  assert.throws(() => rehearsalFigures({snapshot: {}}, rehearsal(), 5, frozen), /archive/);
});

const backfillRecord = (messages: number) => ({durationMs: 1, walBytes: 1000, tableBytes: 2000, termRows: messages * 4,
  inserted: messages * 4, indexes: {message_search_terms_lookup: 3000, message_search_terms_maintenance: 1000},
  verification: {checked: messages, expectedTermRows: messages * 4, mismatches: 0, equal: true, durationMs: 1}});
function backfill(bytes = 60 * GiB) {
  const manifestHash = 'm';
  const receipt = {manifestHash, snapshot: {file: 'verified-cluster.tar', sha256: 'x', bytes, systemIdentifier: '123'},
    records: {base: backfillRecord(1000), small: backfillRecord(10), denial: backfillRecord(20_011)},
    rls: {session: {settings: appSessionSettings, plannerOverrides: 0}, role: 'fukulow_app|f|f\n0\n0',
      tables: Object.fromEntries(searchTables.map(t => [t, [true, true, true]]))}};
  return {receipt, finished: {manifestHash, runKind: 'backfill-only', backfillReceiptHash: hash(JSON.stringify(receipt))},
    status: {manifestHash, valid: true, cleanupVerified: true}, archive: {isFile: true, size: bytes}};
}

test('--from-backfill accepts only a completed, verified backfill-only run of this manifest with a matching, non-empty archive', () => {
  assert.equal(backfillArchiveBytes(backfill(), 'm', 1000, 10), 60 * GiB);
  assert.throws(() => backfillArchiveBytes(backfill(), 'other', 1000, 10), /completed, verified/);
  const cases: [(b: ReturnType<typeof backfill>) => void, RegExp][] = [
    [b => { b.finished.runKind = 'rehearsal'; }, /completed, verified/],
    [b => { b.status.valid = false; }, /completed, verified/],
    [b => { b.status.cleanupVerified = false; }, /completed, verified/],
    [b => { b.status.manifestHash = 'old'; }, /completed, verified/],
    [b => { b.finished.backfillReceiptHash = 'edited'; }, /completed, verified/],
    [b => { b.receipt.records.base.verification.mismatches = 1; b.finished.backfillReceiptHash = hash(JSON.stringify(b.receipt)); },
      /verification record/],
    [b => { b.archive.size -= 1; }, /does not match its receipt/],
    [b => { b.archive.isFile = false; }, /does not match its receipt/]];
  for (const [edit, message] of cases) {
    const b = backfill();
    edit(b);
    assert.throws(() => backfillArchiveBytes(b, 'm', 1000, 10), message);
  }
  assert.throws(() => backfillArchiveBytes(backfill(0), 'm', 1000, 10), /backfill archive/);
});
