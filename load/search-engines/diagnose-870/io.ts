import { spawn, spawnSync } from 'node:child_process';
import { boundedCommand, command, docker, sql } from '../bench.ts';
import { checkPins, pinnedBenchmark, pinnedSession, type DockerLayer } from './cluster.ts';

// Every I/O entry point the worker uses: SQL, docker commands, SQL sessions and the statements inside
// them, every docker cp, exec and pgbench inside a benchmark, docker logs. The worker takes all of them from gatedIo only (review round 7), so once a
// signal has arrived nothing new starts, whichever path asks.
export const rawIo = {sql, docker, command, boundedCommand, spawn, spawnSync, checkPins, pinnedBenchmark, pinnedSession};
export type Io = typeof rawIo;

export class Refused extends Error {}

export function gatedIo(raw: Io, aborted: () => string | null): Io {
  const refuse = (what: string) => {
    const reason = aborted();
    if (reason !== null) throw new Refused(`aborted by ${reason}: ${what} not started`);
  };
  const wrap = <F extends (...args: never[]) => unknown>(what: string, f: F): F =>
    ((...args: Parameters<F>) => { refuse(what); return f(...args); }) as F;
  return {
    sql: wrap('SQL', raw.sql),
    docker: wrap('docker', raw.docker),
    command: wrap('command', raw.command),
    boundedCommand: wrap('command', raw.boundedCommand),
    spawnSync: wrap('command', raw.spawnSync),
    checkPins: wrap('docker', raw.checkPins),
    spawn: wrap('command', raw.spawn),
    // The benchmark's entry and each docker cp, exec and pgbench inside it.
    pinnedBenchmark: (client => wrap('benchmark', raw.pinnedBenchmark(client,
      {docker: wrap('docker', raw.docker), spawn: wrap('pgbench', raw.spawn as DockerLayer['spawn'])}))) as Io['pinnedBenchmark'],
    // The session start and every statement in it.
    pinnedSession: ((container, db, app, client, work) => {
      refuse('SQL session');
      return raw.pinnedSession(container, db, app, client, statement => work(wrap('SQL statement', statement)));
    }) as Io['pinnedSession'],
  };
}
