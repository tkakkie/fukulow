import { spawnSync } from 'node:child_process';
import { benchmark, boundedCommand, command, docker, sql } from '../bench.ts';
import { checkPins, pinnedBenchmark, pinnedSession } from './cluster.ts';

// Every I/O entry point the worker uses: SQL, docker commands, SQL sessions and the statements inside
// them, pgbench, docker logs. The worker takes all of them from gatedIo only (review round 7), so once a
// signal has arrived nothing new starts, whichever path asks.
export const rawIo = {sql, docker, command, boundedCommand, spawnSync, checkPins, benchmark, pinnedBenchmark, pinnedSession};
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
    benchmark: wrap('pgbench', raw.benchmark),
    pinnedBenchmark: (client => wrap('pgbench', raw.pinnedBenchmark(client))) as Io['pinnedBenchmark'],
    // The session start and every statement in it.
    pinnedSession: ((container, db, app, client, work) => {
      refuse('SQL session');
      return raw.pinnedSession(container, db, app, client, statement => work(wrap('SQL statement', statement)));
    }) as Io['pinnedSession'],
  };
}
