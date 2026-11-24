import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Tick } from './c3-observer.ts';

const exec = promisify(execFile);
const maxBuffer = 32 * 1024 * 1024;
export const dump = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
export const read = (path: string) => readFileSync(path, 'utf8');
export const json = <T>(value: string): T => JSON.parse(value) as T;

export function remaining(deadline: number, now = performance.now()) {
  const milliseconds = Math.floor(deadline - now);
  if (milliseconds <= 0) throw new Error('run reached its 60 minute hard stop');
  return milliseconds;
}

export async function bounded<T>(work: Promise<T>, cap: number, signal: AbortSignal, message: string) {
  const timer = new AbortController();
  try {
    return await Promise.race([work, sleep(cap, undefined, { signal: AbortSignal.any([signal, timer.signal]) })
      .then(() => { throw new Error(message); })]);
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally { timer.abort(); }
}

export type Runtime = ReturnType<typeof runtime>;
export function runtime(deadline: number, pg: string, label: string, signal: AbortSignal) {
  const active = () => { signal.throwIfAborted(); return remaining(deadline); };
  function docker(operation: string, args: string[], input?: string, timeout = Math.min(180000, active())) {
    const result = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer, timeout });
    if (result.status !== 0) throw new Error(`${operation}: Docker exited ${(result.error as NodeJS.ErrnoException | undefined)?.code ?? result.signal ?? result.status}`);
    return result.stdout.trim();
  }
  const sqlArgs = (db: string, role: string) => ['exec', '-i', pg, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', role, '-d', db];
  const sql = (db: string, query: string, operation: string, role = 'fukulow') => docker(operation, sqlArgs(db, role), query);
  const asyncSQL = async (db: string, query: string) => {
    try {
      return (await exec('docker', [...sqlArgs(db, 'fukulow'), '-c', query], { timeout: Math.min(5000, active()), maxBuffer, signal })).stdout.trim();
    } catch { throw new Error('maintenance observation unavailable'); }
  };
  function task(args: string[], path: string) {
    active();
    const stdout = openSync(path, 'w'), stderr = openSync(`${path}.stderr`, 'w');
    let child: ChildProcess;
    try { child = spawn('docker', args, { stdio: ['ignore', stdout, stderr] }); }
    finally { closeSync(stdout); closeSync(stderr); }
    const done = new Promise<number | null>(resolve => {
      child.once('error', () => resolve(null));
      child.once('close', resolve);
    });
    return { done, stop: () => child.kill() };
  }
  async function wait<T>(operation: string, probe: () => T | Promise<T>, cap = 15000): Promise<NonNullable<T>> {
    const end = performance.now() + Math.min(cap, active());
    while (performance.now() < end) {
      active();
      const result = await probe();
      if (result) return result;
      await sleep(50);
    }
    throw new Error(`${operation} timed out`);
  }
  const pid = (name: string) => docker('inspect container PID', ['inspect', '--format', '{{.State.Pid}}', name]);
  function remove(name: string) {
    const id = docker('locate disposable container', ['ps', '-aq', '--filter', `label=${label}`,
      '--filter', `name=^/${name}$`], undefined, 5000);
    if (id) docker('remove disposable container', ['rm', '-fv', id], undefined, 10000);
  }
  const logs = (timeout?: number) => {
    const result = spawnSync('docker', ['logs', pg], { encoding: 'utf8', maxBuffer, timeout: timeout ?? remaining(deadline) });
    if (result.status !== 0) throw new Error('PostgreSQL log capture unavailable');
    return `${result.stderr}\n${result.stdout}`;
  };
  function cleanup() {
    for (const [command, list, remove] of [['container', ['ps', '-aq'], ['rm', '-fv']],
      ['network', ['network', 'ls', '-q'], ['network', 'rm']]] as const) {
      const ids = docker(`list ${command}`, [...list, '--filter', `label=${label}`], undefined, 10000).split('\n').filter(Boolean);
      if (ids.length) docker(`remove ${command}`, [...remove, ...ids], undefined, 15000);
    }
  }
  return { docker, sql, asyncSQL, task, wait, pid, logs, cleanup, active, remove };
}

export function ticks(path: string): Tick[] {
  const text = read(path);
  return text.slice(0, text.lastIndexOf('\n') + 1).trim().split('\n').filter(Boolean).map(line => json<Tick>(line));
}
