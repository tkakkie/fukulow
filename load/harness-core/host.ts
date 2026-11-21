import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const GiB = 1024 ** 3;

export function assertNewOutput(path: string) {
  if (existsSync(path)) throw new Error('Output directory already exists');
}

export function assertPinned(git: (args: string[]) => string, commit: string) {
  if (git(['rev-parse', 'HEAD']) !== commit) throw new Error('Harness is not at the pinned commit');
  if (git(['status', '--porcelain']) !== '') throw new Error('Harness worktree is dirty');
}

// Parses `df -Pk <path>` output into free bytes.
export function freeBytes(df: string) {
  const fields = df.trim().split('\n').at(-1)?.trim().split(/\s+/) ?? [];
  const kib = Number(fields[3]);
  if (!Number.isSafeInteger(kib) || kib < 0) throw new Error('Unreadable df output');
  return kib * 1024;
}

export function headroom(free: number, required: number) {
  return { freeBytes: free, requiredBytes: required, ok: free >= required };
}

// Docker Desktop stores volumes in its VM, so host statfs says nothing about them. A throwaway
// container's root filesystem sits on the same VM disk.
export function dockerFreeBytes(image: string) {
  const child = spawnSync('docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
    '--entrypoint', 'df', image, '-Pk', '/'], { encoding: 'utf8', timeout: 60_000 });
  if (child.status !== 0) throw new Error('Docker disk headroom probe failed');
  return freeBytes(child.stdout);
}

export function assertDockerHeadroom(image: string, required: number) {
  const result = headroom(dockerFreeBytes(image), required);
  if (!result.ok) {
    throw new Error(`Docker disk headroom insufficient: ${(result.freeBytes / GiB).toFixed(1)} GiB free, ${(required / GiB).toFixed(1)} GiB needed`);
  }
  return result;
}
