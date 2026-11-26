import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { clientBenchmark } from './cluster.ts';
import { gatedIo, rawIo, Refused, type Io } from './io.ts';
import { postgresLog } from './run.ts';

// A fake I/O layer that records every start and fails the test if anything starts after the abort.
function fakeIo() {
  let reason: string | null = null;
  const started: string[] = [];
  const start = (what: string) => {
    if (reason !== null) throw new Error(`I/O started after the abort: ${what}`);
    started.push(what);
  };
  const raw = Object.fromEntries(Object.keys(rawIo).map(k => [k, (..._: unknown[]) => { start(k); return ''; }])) as unknown as Io;
  raw.clientBenchmark = (() => async () => { start('pgbench'); return {}; }) as unknown as Io['clientBenchmark'];
  raw.clientSession = (async (_c: string, _d: string, _a: boolean, work: (s: (t: string) => Promise<string>) => Promise<unknown>) => {
    start('session');
    return work(async text => { start(`statement ${text}`); return ''; });
  }) as unknown as Io['clientSession'];
  return {io: gatedIo(raw, () => reason), started, abort: (r: string) => { reason = r; }};
}

test('after the abort no gated I/O entry point starts anything (review round 7)', async () => {
  const f = fakeIo();
  f.io.sql('c', 'db', 'SELECT 1');
  f.io.docker('restart', 'c');
  assert.deepEqual(f.started, ['sql', 'docker']);
  const bench = f.io.clientBenchmark();
  // A session open when the signal arrives: its next statement does not start.
  await assert.rejects(f.io.clientSession('c', 'measured', true, async search => {
    await search('SELECT 2');
    f.abort('SIGTERM');
    await search('SELECT 3');
  }), Refused);
  assert.deepEqual(f.started, ['sql', 'docker', 'session', 'statement SELECT 2']);
  for (const k of Object.keys(rawIo) as (keyof Io)[]) {
    if (k === 'clientBenchmark' || k === 'clientSession') continue;
    assert.throws(() => (f.io[k] as (...a: unknown[]) => unknown)('x'), Refused, k);
  }
  assert.throws(() => bench('c', 'db', 's', 'd', 1), Refused);
  assert.throws(() => f.io.clientBenchmark()('c', 'db', 's', 'd', 1), Refused);
  assert.throws(() => f.io.clientSession('c', 'db', true, async () => 1), Refused);
  // The PostgreSQL log is skipped and recorded as missing evidence.
  assert.match(postgresLog(f.io, 'c', '/nonexistent') ?? '', /postgres log not saved: .*aborted by SIGTERM/);
  assert.deepEqual(f.started, ['sql', 'docker', 'session', 'statement SELECT 2']);
});

test('the worker reaches I/O only through gatedIo: run.ts imports no raw entry point but docker for the launcher', () => {
  const source = readFileSync(new URL('./run.ts', import.meta.url), 'utf8');
  const imports = source.split('\n').filter(l => l.startsWith('import ')).join('\n');
  for (const name of ['sql', 'command', 'boundedCommand', 'benchmark', 'spawnSync', 'clientBenchmark', 'clientSession'])
    assert.doesNotMatch(imports, new RegExp(`[{,] ?${name}[ ,}]`), name);
  const worker = source.slice(source.indexOf('async function worker('), source.indexOf('\nexport function workerGate'));
  assert.match(worker, /const io = gatedIo\(rawIo, \(\) => abortReason\);/);
  assert.doesNotMatch(worker, /rawDocker|rawIo\./);
  // Its one raw spawn starts the sampler (a node process, stopped on a signal), never docker.
  assert.deepEqual(worker.match(/\bspawn\([^,]*/g), ['spawn(process.execPath']);
});

test('a signal during pgbench starts no further docker command in the real cluster.ts benchmark flow (review round 8)', async () => {
  let reason: string | null = null;
  const commands: string[] = [];
  const raw = {...rawIo,
    docker: (...args: string[]) => { if (reason !== null) assert.fail(`docker ${args[0]} started after the abort`); commands.push(`docker ${args.slice(0, 2).join(' ')}`); return ''; },
    spawn: (command: string, args: string[]) => {
      if (reason !== null) assert.fail('spawn after the abort');
      commands.push(`${command} ${args.includes('pgbench') ? 'pgbench' : args[0]}`);
      const child = Object.assign(new EventEmitter(), {stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true});
      // SIGTERM arrives while pgbench runs; pgbench then finishes normally.
      setTimeout(() => { reason = 'SIGTERM'; child.emit('close', 0); }, 1);
      return child;
    },
    clientBenchmark} as unknown as Io;
  const io = gatedIo(raw, () => reason);
  const dest = join(mkdtempSync(join(tmpdir(), 'diag870-bench-')), 'q1');
  await assert.rejects(io.clientBenchmark()('c', 'measured', 'SELECT 1;', dest, 1, 1), Refused);
  // The copy-in and mkdir ran, pgbench ran, and the copy-out after it did not start.
  assert.deepEqual(commands, ['docker cp ' + `${dest}.sql`, 'docker exec c', 'docker pgbench']);
});
