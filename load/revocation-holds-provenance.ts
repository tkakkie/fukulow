import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { arch, cpus, hostname, platform, release, totalmem } from 'node:os';

export type SessionIdentity = {
  session: string; commit: string; node: string;
  hostname: string; platform: string; arch: string; cpus: number; memoryBytes: number; release: string;
  gitClean: boolean; bootId: string; serverSha256: string; stallHelperSha256: string;
};

const stdout = (program: string, args: string[], cwd?: string) =>
  execFileSync(program, args, { cwd, encoding: 'utf8' });

export function readBootId(os: string, read = (path: string) => readFileSync(path, 'utf8'), command = stdout): string {
  if (os === 'linux') {
    const id = read('/proc/sys/kernel/random/boot_id').trim();
    if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) return id;
  } else if (os === 'darwin') {
    const boot = /^\{\s*sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)\s*\}/.exec(command('sysctl', ['-n', 'kern.boottime']));
    if (boot) return `${boot[1]}.${boot[2]}`;
  }
  throw new Error(`SA2: could not identify the current ${os} boot`);
}

async function binarySha256(path: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

export async function collectSessionIdentity(
  { session, checkout, binary, helperBinary }: { session: string; checkout: string; binary: string; helperBinary: string },
  command = stdout,
): Promise<SessionIdentity> {
  if (command('git', ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'], checkout) !== '') {
    throw new Error('SA2: the measurement checkout must have a clean git working tree');
  }
  const commit = command('git', ['rev-parse', 'HEAD'], checkout).trim();
  const os = platform();
  const bootId = readBootId(os);
  const [serverSha256, stallHelperSha256] = await Promise.all([binarySha256(binary), binarySha256(helperBinary)]);
  return {
    session, commit, node: process.version, hostname: hostname(), platform: os, arch: arch(), cpus: cpus().length,
    memoryBytes: totalmem(), release: release(), gitClean: true, bootId, serverSha256, stallHelperSha256,
  };
}

export function sameSessionIdentity(saved: SessionIdentity, current: SessionIdentity): boolean {
  const keys = ['session', 'commit', 'node', 'hostname', 'platform', 'arch', 'cpus', 'memoryBytes', 'release',
    'bootId', 'serverSha256', 'stallHelperSha256'] as const;
  return Boolean(current.session) && saved.gitClean === true && current.gitClean === true &&
    keys.every(key => saved[key] === current[key]);
}
