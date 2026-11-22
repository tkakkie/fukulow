import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmd } from '../515-replay/stack.ts';
import type { Arm } from '../../slice5/config.ts';

const patchDir = fileURLToPath(new URL('.', import.meta.url));
const version = '0.8.6';
const checksum = 'ee6798b1838b6a0f69c007c133b8df5866302197e404e8b6ee8ed3e3a5e68dc6';
const lockEntry = `name = "sqlx-core"\nversion = "${version}"\n`;
const registry = `source = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${checksum}"\n`;
export const variants = ['patched', 'control'] as const;
export type Variant = typeof variants[number];
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export function archive(commit: string, work: string, arm: Arm) {
  const source = join(work, arm);
  const tar = join(work, arm + '.tar');
  mkdirSync(source);
  cmd('git', ['archive', '--format=tar', '--output=' + tar, commit]);
  cmd('tar', ['-xf', tar, '-C', source]);
  return source;
}

export async function prepareDriver(work: string) {
  const response = await fetch(`https://static.crates.io/crates/sqlx-core/sqlx-core-${version}.crate`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error('Could not download the locked SQLx crate');
  const data = Buffer.from(await response.arrayBuffer());
  if (sha256(data) !== checksum) throw new Error('SQLx crate checksum mismatch');
  const tar = join(work, 'sqlx-core.crate');
  const driver = join(work, 'sqlx-core');
  mkdirSync(driver);
  writeFileSync(tar, data);
  cmd('tar', ['-xf', tar, '--strip-components=1', '-C', driver]);
  const patch = join(patchDir, 'patch-sqlx-core.diff');
  cmd('git', ['-C', driver, 'apply', '--whitespace=error', patch]);
  return { driver, sha256: sha256(readFileSync(patch)) };
}

export function applyArmPatch(source: string, arm: Arm, driver: Awaited<ReturnType<typeof prepareDriver>>) {
  const patch = join(patchDir, `patch-${arm}.diff`);
  const lock = readFileSync(join(source, 'Cargo.lock'), 'utf8');
  if (lock.split(lockEntry + registry).length !== 2) throw new Error('Arm does not use the expected locked SQLx crate');
  // Keep the original lock for the dependency and WASM Docker layers.
  writeFileSync(join(source, 'fk515-Cargo.lock'), lock.replace(lockEntry + registry, lockEntry));
  cpSync(driver.driver, join(source, 'fk515-sqlx-core'), { recursive: true });
  cmd('git', ['-C', source, 'apply', '--whitespace=error', patch]);
  return { arm: sha256(readFileSync(patch)), driver: driver.sha256 };
}

export async function build(source: string, commit: string, patches: ReturnType<typeof applyArmPatch> | null) {
  const revision = 'org.opencontainers.image.revision';
  const patch = 'io.fukulow.fk515a.patch-sha256';
  const driver = 'io.fukulow.fk515a.driver-patch-sha256';
  const labels = { [revision]: commit, [patch]: patches?.arm ?? 'none', [driver]: patches?.driver ?? 'none' };
  const tag = `fukulow-fk515a:${commit.slice(0, 12)}-${patches ? patches.arm.slice(0, 12) + '-' + patches.driver.slice(0, 12) : 'control'}`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', ['build', ...Object.entries(labels).flatMap(([key, value]) => ['--label', key + '=' + value]),
      '-t', tag, source], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 60 * 60_000 });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Docker build failed (${signal ?? code})`)));
  });
  const image = JSON.parse(cmd('docker', ['image', 'inspect', '--format', '{{json .}}', tag]));
  if (Object.entries(labels).some(([key, value]) => image.Config.Labels[key] !== value)) throw new Error('Build labels differ');
  return { tag, id: image.Id as string, labels };
}
