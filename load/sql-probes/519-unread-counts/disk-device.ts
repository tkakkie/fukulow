import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { parseDiskstats, type Device } from './diskstats.ts';

const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
const covers = (base: string, path: string) => path === base || path.startsWith(base === '/' ? '/' : base + '/');
const deviceId = /^\d+:\d+$/;
type Mount = { Type: string; Source: string; Destination: string };
type ContainerPath = { path: string; device: string };

function enclosing<T>(rows: T[], target: (row: T) => string, path: string, source: string): T {
  const matches = rows.filter(row => covers(target(row), path)).sort((a, b) => target(b).length - target(a).length);
  if (!matches[0] || matches[1] && target(matches[1]).length === target(matches[0]).length) {
    throw new Error(`no unambiguous ${source} mount for ${path}`);
  }
  return matches[0];
}

export function resolveMount(mounts: Mount[], mountinfo: string, target: ContainerPath) {
  if (!isAbsolute(target.path) || !deviceId.test(target.device)) throw new Error('invalid container path or st_dev');
  const dockerMount = enclosing(mounts, row => row.Destination, target.path, 'Docker');
  if (!['volume', 'bind'].includes(dockerMount.Type) || !isAbsolute(dockerMount.Source)) {
    throw new Error(`Docker mount for ${target.path} is not a host volume or bind`);
  }
  const hostPath = join(dockerMount.Source, relative(dockerMount.Destination, target.path));
  const hostMounts = mountinfo.trim().split('\n').map(line => {
    const [left, right] = line.split(' - ');
    const [, , device, root, mountpoint] = left.split(' ');
    const [fs, source] = (right ?? '').split(' ');
    if (!deviceId.test(device) || !root || !mountpoint || !fs || !source) throw new Error('invalid host mountinfo');
    return { device, root: unescape(root), mountpoint: unescape(mountpoint), fs, source: unescape(source) };
  });
  const hostMount = enclosing(hostMounts, row => row.mountpoint, hostPath, 'host');
  if (hostMount.device !== target.device) {
    throw new Error(`${target.path} st_dev ${target.device} disagrees with host mount ${hostMount.device} at ${hostMount.mountpoint}`);
  }
  return { ...target, dockerMount, hostPath, hostMount };
}

// Include partitions, their whole disks (where flushes are counted), and stacked-device slaves.
export function backingDevices(roots: string[], parents: (id: string) => string[]) {
  const found = new Set<string>();
  const visit = (id: string) => {
    if (!deviceId.test(id)) throw new Error(`invalid sysfs block device ID ${id}`);
    if (found.has(id)) return;
    found.add(id);
    parents(id).forEach(visit);
  };
  roots.forEach(visit);
  return [...found];
}

const read = (path: string) => readFileSync(path, 'utf8');
function sysfsParents(id: string) {
  const device = realpathSync(`/sys/dev/block/${id}`);
  if (existsSync(join(device, 'partition'))) return [read(join(dirname(device), 'dev')).trim()];
  return readdirSync(join(device, 'slaves')).sort().map(slave => read(join(device, 'slaves', slave, 'dev')).trim());
}

export function postgresDevices(container: string, dataDirectory: string, docker: (args: string[]) => string) {
  const mounts: Mount[] = JSON.parse(docker(['inspect', '--format', '{{json .Mounts}}', container]));
  const lines = docker(['exec', '--user', '0', container, 'sh', '-ec', `
    cat /proc/sys/kernel/random/boot_id
    for path in "$1" "$1/pg_wal"; do
      canonical=$(readlink -ef -- "$path")
      printf '%s\\n' "$canonical"
      stat -Lc '%Hd:%Ld' -- "$canonical"
    done
  `, 'disk-device', dataDirectory]).trimEnd().split('\n');
  const [bootId, data, dataDevice, wal, walDevice] = lines;
  if (lines.length !== 5 || bootId !== read('/proc/sys/kernel/random/boot_id').trim()) {
    throw new Error('cannot verify Docker mount paths against this Linux host boot');
  }
  const mountinfo = read('/proc/self/mountinfo');
  const pgdata = resolveMount(mounts, mountinfo, { path: data, device: dataDevice });
  const pgWal = resolveMount(mounts, mountinfo, { path: wal, device: walDevice });
  const topology: Record<string, string[]> = {};
  const ids = backingDevices([pgdata.device, pgWal.device], id => topology[id] = sysfsParents(id));
  const devices: Device[] = parseDiskstats(read('/proc/diskstats'), ids).map(({ id, name }) => ({ id, name }));
  return { method: 'Docker mounts and container st_dev matched to host mountinfo on the same boot, then sysfs partition parents and slaves', bootId,
    pgdata, pgWal, topology, devices };
}
