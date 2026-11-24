import { readFileSync, statfsSync } from 'node:fs';
import { isMainThread } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const periodMs = 100;
export const tmpfsBytes = 2 ** 31;
export type Tick = { monoMs: number; wallMs: number; spanMs: number; db: number; app: number; used: number };

function cpuFile(pid: string) {
  if (!/^[1-9]\d*$/.test(pid)) throw new Error('invalid container PID');
  const relative = /^0::(\/[^\n]+)$/m.exec(readFileSync(`/proc/${pid}/cgroup`, 'utf8'))?.[1];
  if (!relative || relative.split('/').includes('..')) throw new Error('container cgroup v2 unavailable');
  return `/sys/fs/cgroup${relative}/cpu.stat`;
}

function usage(file: string) {
  const value = /^usage_usec (\d+)$/m.exec(readFileSync(file, 'utf8'))?.[1];
  if (value === undefined) throw new Error('cgroup CPU counter unavailable');
  return Number(value);
}

async function observe(dbPid: string, appPid?: string) {
  const dbFile = cpuFile(dbPid), appFile = appPid ? cpuFile(appPid) : null;
  if (dbFile === appFile) throw new Error('app and DB share a cgroup');
  let target = performance.now();
  while (true) {
    const start = performance.now();
    const wallMs = Date.now(), db = usage(dbFile), app = appFile ? usage(appFile) : 0;
    const storage = statfsSync(`/proc/${dbPid}/root/var/lib/postgresql`);
    if (storage.type !== 0x01021994 || storage.blocks * storage.bsize !== tmpfsBytes) throw new Error('expected 2 GiB tmpfs');
    const used = (storage.blocks - storage.bfree) * storage.bsize;
    const spanMs = performance.now() - start;
    process.stdout.write(JSON.stringify({ monoMs: start + spanMs / 2, wallMs, spanMs, db, app, used }) + '\n');
    do { target += periodMs; } while (target <= performance.now());
    await sleep(target - performance.now());
  }
}

if (isMainThread && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await observe(process.argv[2], process.argv[3]);
}
