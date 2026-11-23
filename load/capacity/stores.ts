// #788: which physical allocation pool each path consumes, and which local Docker daemon the preflight
// talks to. Anything it cannot place in a known pool, or tie to the local daemon, is refused (fail closed).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

export type Pool = {pool: string; free: number; mount: string; fs: string};
export type Store = {id: string; kind: 'host' | 'docker-vm'; paths: string[]; free: number; mounts: string[]};

const isBytes = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

// Paths in one pool share one free value (the lowest any of them sees, so a volume quota counts) and one sum of needs.
export function hostStore(paths: string[], probe: (path: string) => Pool) {
  const stores = new Map<string, Store>();
  const ids = paths.map(path => {
    const p = probe(path);
    assert.ok(isBytes(p.free), `${path}: unreadable free space`);
    const id = `host:${p.pool}`;
    const store = stores.get(id) ?? {id, kind: 'host' as const, paths: [], free: p.free, mounts: []};
    store.free = Math.min(store.free, p.free);
    store.paths.push(path);
    if (!store.mounts.includes(p.mount)) store.mounts.push(p.mount);
    stores.set(id, store);
    return id;
  });
  return {ids, stores: [...stores.values()]};
}

// The mount point column of POSIX `df -P` output; it is the last column and may contain spaces.
export function dfMount(df: string) {
  const mount = /^.*?\s+\d+\s+\d+\s+\d+\s+\d+%\s+(\/.*)$/.exec(df.trim().split('\n').at(-1) ?? '')?.[1];
  assert.ok(mount, 'Unreadable df output');
  return mount;
}

// macOS: APFS volumes in one container share its free space, so the container is the pool. A non-APFS
// local volume is its own pool. Disk images, network volumes and anything else are refused.
export function darwinPool(mount: string, info: Record<string, unknown>, volumeFree: number): Pool {
  assert.ok(info.BusProtocol !== 'Disk Image', `${mount} is a mounted disk image, whose backing file uses another store`);
  if (info.FilesystemType === 'apfs') {
    const container = info.APFSContainerReference;
    assert.ok(typeof container === 'string' && /^disk\d+$/.test(container) && isBytes(info.APFSContainerFree),
      `${mount}: its APFS container is unknown`);
    return {pool: `apfs:${container}`, free: Math.min(volumeFree, info.APFSContainerFree), mount, fs: 'apfs'};
  }
  const device = info.DeviceIdentifier;
  assert.ok(['hfs', 'exfat', 'msdos'].includes(String(info.FilesystemType)) && typeof device === 'string' && /^disk\d+s\d+$/.test(device),
    `${mount}: filesystem ${String(info.FilesystemType)} is not a known local volume`);
  return {pool: `volume:${device}`, free: volumeFree, mount, fs: String(info.FilesystemType)};
}

// Linux: only plain block-device filesystems, where the device is the pool. Device-mapper (possibly thin),
// loop images, btrfs, ZFS, network and memory filesystems can share space invisibly, so they are refused.
export function linuxPool(found: {source?: string; fstype?: string; target?: string}, volumeFree: number): Pool {
  const source = found.source?.replace(/\[.*\]$/, '');
  assert.ok(found.target && ['ext2', 'ext3', 'ext4', 'xfs'].includes(found.fstype ?? '') && source &&
    /^\/dev\/(?!loop|mapper\/|dm-)/.test(source), `${found.target}: ${found.fstype} on ${source} is not a plain local block device`);
  return {pool: `dev:${source}`, free: volumeFree, mount: found.target, fs: found.fstype!};
}

const volumeFree = (path: string) => { const s = statfsSync(path, {bigint: true}); return Number(s.bavail * s.bsize); };
const run = (cmd: string, args: string[], input?: string) => execFileSync(cmd, args, {encoding: 'utf8', input});

export function probePool(path: string): Pool {
  if (process.platform === 'darwin') {
    const mount = dfMount(run('df', ['-P', path]));
    const info = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', '-'], run('diskutil', ['info', '-plist', mount])));
    return darwinPool(mount, info, volumeFree(path));
  }
  assert.ok(process.platform === 'linux', `Unsupported platform ${process.platform}`);
  const found = JSON.parse(run('findmnt', ['-J', '-n', '-o', 'SOURCE,FSTYPE,TARGET', '--target', path])).filesystems?.[0] ?? {};
  return linuxPool(found, volumeFree(path));
}

export type DockerSide = {endpoint: string; envHost?: string; os: string; root: string};
export const desktopDisk = (home: string) => join(home, 'Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw');

// The daemon that `docker info` and the VM probe reach must be the local one whose storage is budgeted on the host.
// macOS: only Docker Desktop through its own socket (Colima, OrbStack, remote contexts are refused); its disk image
// is the default one, or, with a custom disk image location, a --docker-disk inside that location.
// Linux: only a native daemon on a local socket; its storage is DockerRootDir.
export function localDocker(platform: string, home: string, docker: DockerSide, realpath: (p: string) => string,
  dataFolder?: string, override?: string): {desktop: boolean; disk: string} {
  assert.ok(docker.envHost === undefined || docker.envHost === docker.endpoint, 'DOCKER_HOST differs from the active Docker context');
  const socket = /^unix:\/\/(\/.+)$/.exec(docker.endpoint)?.[1];
  assert.ok(socket, `Docker endpoint ${docker.endpoint} is not a local socket`);
  if (platform === 'darwin') {
    assert.ok(docker.os === 'Docker Desktop', `Docker runtime "${docker.os}" is not supported on macOS; only Docker Desktop is`);
    assert.ok(realpath(socket) === realpath(join(home, '.docker/run/docker.sock')), 'The Docker endpoint is not the local Docker Desktop socket');
    if (dataFolder) {
      assert.ok(override && realpath(override).startsWith(realpath(dataFolder) + '/'),
        `Docker Desktop uses a custom disk image location (${dataFolder}); pass --docker-disk=PATH inside it`);
      return {desktop: true, disk: realpath(override)};
    }
    const disk = desktopDisk(home);
    assert.ok(override === undefined || realpath(override) === realpath(disk), '--docker-disk is not the local Docker Desktop disk image');
    return {desktop: true, disk};
  }
  assert.ok(platform === 'linux', `Unsupported platform ${platform}`);
  assert.ok(!/Docker Desktop/.test(docker.os), 'Docker Desktop for Linux is not supported');
  assert.ok(override === undefined || override === docker.root, '--docker-disk must be the daemon\'s DockerRootDir on Linux');
  return {desktop: false, disk: docker.root};
}

// The VM filesystem the probe saw must be the one inside this disk image: its size within 10% under the image's.
export function imageMatchesVm(imageBytes: number, vmTotalBytes: number) {
  assert.ok(isBytes(imageBytes) && isBytes(vmTotalBytes) && vmTotalBytes <= imageBytes && vmTotalBytes >= 0.9 * imageBytes,
    'The Docker VM disk the probe measured does not match the host disk image');
}

// Total size column of `df -Pk` output, in bytes.
export function dfTotal(df: string) {
  const kib = Number(df.trim().split('\n').at(-1)?.trim().split(/\s+/)[1]);
  assert.ok(isBytes(kib), 'Unreadable df output');
  return kib * 1024;
}

// A custom disk image location in Docker Desktop's settings, if any (any key naming a data folder or disk image location).
export function desktopDataFolder(home: string) {
  for (const file of ['Library/Group Containers/group.com.docker/settings-store.json', 'Library/Group Containers/group.com.docker/settings.json']) {
    let text: string;
    try {
      text = readFileSync(join(home, file), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const settings: Record<string, unknown> = JSON.parse(text);
    const value = Object.entries(settings).find(([key]) => /data.?folder|disk.?image.?location/i.test(key))?.[1];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

export const realpath = (p: string) => realpathSync(p);
