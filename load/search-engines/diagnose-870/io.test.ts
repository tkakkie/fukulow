import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
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
  raw.pinnedBenchmark = (() => async () => { start('pgbench'); return {}; }) as unknown as Io['pinnedBenchmark'];
  raw.pinnedSession = (async (_c: string, _d: string, _a: boolean, _cl: unknown, work: (s: (t: string) => Promise<string>) => Promise<unknown>) => {
    start('session');
    return work(async text => { start(`statement ${text}`); return ''; });
  }) as unknown as Io['pinnedSession'];
  return {io: gatedIo(raw, () => reason), started, abort: (r: string) => { reason = r; }};
}

test('after the abort no gated I/O entry point starts anything (review round 7)', async () => {
  const f = fakeIo();
  f.io.sql('c', 'db', 'SELECT 1');
  f.io.docker('restart', 'c');
  assert.deepEqual(f.started, ['sql', 'docker']);
  const bench = f.io.pinnedBenchmark([1]);
  // A session open when the signal arrives: its next statement does not start.
  await assert.rejects(f.io.pinnedSession('c', 'measured', true, undefined, async search => {
    await search('SELECT 2');
    f.abort('SIGTERM');
    await search('SELECT 3');
  }), Refused);
  assert.deepEqual(f.started, ['sql', 'docker', 'session', 'statement SELECT 2']);
  for (const k of Object.keys(rawIo) as (keyof Io)[]) {
    if (k === 'pinnedBenchmark' || k === 'pinnedSession') continue;
    assert.throws(() => (f.io[k] as (...a: unknown[]) => unknown)('x'), Refused, k);
  }
  assert.throws(() => bench('c', 'db', 's', 'd', 1), Refused);
  assert.throws(() => f.io.pinnedBenchmark([1])('c', 'db', 's', 'd', 1), Refused);
  assert.throws(() => f.io.pinnedSession('c', 'db', true, undefined, async () => 1), Refused);
  // The PostgreSQL log is skipped and recorded as missing evidence.
  assert.match(postgresLog(f.io, 'c', '/nonexistent') ?? '', /postgres log not saved: .*aborted by SIGTERM/);
  assert.deepEqual(f.started, ['sql', 'docker', 'session', 'statement SELECT 2']);
});

test('the worker reaches I/O only through gatedIo: run.ts imports no raw entry point but docker for the launcher', () => {
  const source = readFileSync(new URL('./run.ts', import.meta.url), 'utf8');
  const imports = source.split('\n').filter(l => l.startsWith('import ')).join('\n');
  for (const name of ['sql', 'command', 'boundedCommand', 'benchmark', 'spawnSync', 'checkPins', 'pinnedBenchmark', 'pinnedSession'])
    assert.doesNotMatch(imports, new RegExp(`[{,] ?${name}[ ,}]`), name);
  const worker = source.slice(source.indexOf('async function worker('), source.indexOf('\nexport function workerGate'));
  assert.match(worker, /const io = gatedIo\(rawIo, \(\) => abortReason\);/);
  assert.doesNotMatch(worker, /rawDocker|rawIo\./);
});
