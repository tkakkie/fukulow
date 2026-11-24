import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostRecord } from '../harness-core/host-record.ts';
import { launch, workers, type Deps } from './launcher.ts';
import { darwin, linux, type Platform } from './platform.ts';
import { parseQueue, type Queue } from './queue.ts';

const GiB = 1024 ** 3;
const job = (name: string, extra: Record<string, unknown> = {}) => ({
  name, issue: 519, go: { quote: '正式計測を承認', date: '2026-11-24' }, worktree: '/w/' + name, commit: 'abc1234',
  command: ['node', 'load/run.ts'], out: '/runs/out-' + name, ...extra,
});
const queue = (jobs = [job('a'), job('b')]): Queue => parseQueue(JSON.stringify({ name: 'q', chainDir: '/runs/chain', hostBusy: '/runs/HOST-BUSY', jobs }));

type World = {
  files: Map<string, string>; containers: string; ps: string; load: number[]; violations: string[]; exits: number[];
  head: string; dirty: string; node: string; free: number | null; spawned: string[][]; captured: string[]; stoppedLogs: number;
  signal?: { at: 'wait' | 'job'; handler?: (s: string) => void };
};
function world(over: Partial<World> = {}): World {
  return { files: new Map(), containers: '', ps: '1 /sbin/init\n', load: [0.5], violations: [], exits: [0, 0], head: 'abc1234def\n', dirty: '',
    node: '26.13.1\n', free: 100 * GiB, spawned: [], captured: [], stoppedLogs: 0, ...over };
}
function deps(w: World, platform?: Platform): Deps {
  const p: Platform = platform ?? { name: 'fake', inhibit: a => ['inhibit', ...a], violations: () => w.violations,
    load15: () => (w.load.length > 1 ? w.load.shift()! : w.load[0]), record: () => ({ fake: true } as unknown as HostRecord) };
  return {
    platform: p,
    exec: argv => {
      const k = argv.join(' ');
      if (k === 'docker ps -q') return { status: 0, stdout: w.containers };
      if (k.startsWith('ps ')) return { status: 0, stdout: w.ps };
      if (k === 'git rev-parse HEAD') return { status: 0, stdout: w.head };
      if (k === 'git status --porcelain') return { status: 0, stdout: w.dirty };
      if (k === 'cat .node-version') return { status: 0, stdout: w.node };
      return { status: null, stdout: '' };
    },
    spawn: argv => {
      w.spawned.push(argv);
      if (w.signal?.at === 'job' && argv[0] === 'inhibit') w.signal.handler?.('SIGTERM');
      return { done: Promise.resolve(w.exits.shift() ?? 0), kill: () => {} };
    },
    captureLogs: (label, file) => { w.captured.push(`${label} -> ${file}`); return () => { w.stoppedLogs++; }; },
    exists: path => w.files.has(path),
    claim: (path, text) => { if (w.files.has(path)) return false; w.files.set(path, text); return true; },
    remove: path => { w.files.delete(path); },
    append: (path, text) => { w.files.set(path, (w.files.get(path) ?? '') + text); },
    write: (path, text) => { w.files.set(path, text); },
    freeBytes: () => w.free, dockerFreeBytes: () => w.free,
    nodeVersion: 'v26.13.1', pid: 42, now: () => new Date('2026-11-24T00:00:00Z'),
    sleep: async () => { if (w.signal?.at === 'wait') w.signal.handler?.('SIGINT'); },
    onSignal: handler => { if (w.signal) w.signal.handler = handler; },
  };
}
const chain = (w: World) => w.files.get('/runs/chain/chain.log') ?? '';

test('a queue runs every job once, in order, and releases HOST-BUSY', async () => {
  const w = world();
  const r = await launch(queue(), deps(w));
  assert.equal(r.outcome, 'done');
  assert.deepEqual(w.spawned, [['inhibit', 'node', 'load/run.ts'], ['inhibit', 'node', 'load/run.ts']]);
  assert.equal(w.files.has('/runs/HOST-BUSY'), false);
  assert.match(chain(w), /go "正式計測を承認" \(2026-11-24\)/);
  assert.ok(w.files.has('/runs/chain/a-host-before.json') && w.files.has('/runs/chain/b-host-after.json'));
});

test('the launcher waits until the host is idle, then claims HOST-BUSY', async () => {
  const w = world({ load: [5, 5, 0.5] });
  const r = await launch(queue([job('a')]), deps(w));
  assert.equal(r.outcome, 'done');
  assert.equal(w.spawned.length, 1);
  assert.equal(w.files.has('/runs/HOST-BUSY'), false);
});

test('a held HOST-BUSY is never taken over or removed', async () => {
  const w = world({ signal: { at: 'wait' } });
  w.files.set('/runs/HOST-BUSY', 'other chain\n');
  const r = await launch(queue([job('a')]), deps(w));
  assert.equal(r.outcome, 'stop');
  assert.equal(w.files.get('/runs/HOST-BUSY'), 'other chain\n');
  assert.equal(w.spawned.length, 0);
});

test('workers, containers and the launcher itself are told apart', () => {
  const ps = '42 node load/launch.ts --queue q\n7 codex exec -m x\n8 node load/sql-probes/x.ts\n9 /usr/bin/zsh\n10 node load/launch.ts --queue other\n';
  assert.deepEqual(workers(ps, 42), ['7 codex exec -m x', '8 node load/sql-probes/x.ts']);
});

test('each preflight STOP ends the queue before launch and releases HOST-BUSY', async () => {
  const cases: [Partial<World>, Record<string, unknown>, RegExp][] = [
    [{ head: 'fff0000\n' }, {}, /not at abc1234/],
    [{ dirty: ' M load/x.ts\n' }, {}, /is dirty/],
    [{ node: '26.12.0\n' }, {}, /node v26\.13\.1 is not the pinned 26\.12\.0/],
    [{ violations: ['not on AC power'] }, {}, /not on AC power/],
    [{ free: 10 * GiB }, {}, /host free 10\.0 GiB < 40 GiB/],
    [{ free: null }, { image: 'postgres:18.6' }, /host free unreadable.*Docker free unreadable/],
  ];
  for (const [over, extra, pattern] of cases) {
    const w = world(over);
    const r = await launch(queue([job('a', extra)]), deps(w));
    assert.equal(r.outcome, 'stop', JSON.stringify(over));
    assert.match(r.reason ?? '', pattern);
    assert.equal(w.spawned.length, 0);
    assert.equal(w.files.has('/runs/HOST-BUSY'), false);
  }
  const w = world();
  w.files.set('/runs/out-a', '');
  assert.match((await launch(queue([job('a')]), deps(w))).reason ?? '', /output exists/);
});

test('containers that appear after the idle check stop the job', async () => {
  const w = world();
  const d = deps(w);
  let calls = 0;
  const exec = d.exec;
  d.exec = (argv, cwd) => (argv.join(' ') === 'docker ps -q' && ++calls > 1 ? { status: 0, stdout: 'c1\n' } : exec(argv, cwd));
  const r = await launch(queue([job('a')]), d);
  assert.match(r.reason ?? '', /containers running/);
  assert.equal(w.spawned.length, 0);
});

test('a failed gate stops the queue; the job is not started', async () => {
  const w = world({ exits: [9] });
  const r = await launch(queue([job('a', { gate: ['node', 'load/capacity/d3r.ts'] })]), deps(w));
  assert.equal(r.outcome, 'stop');
  assert.deepEqual(w.spawned, [['node', 'load/capacity/d3r.ts']]);
  assert.match(chain(w), /a gate: exit=9/);
});

test('a failed job ends the queue and is never rerun', async () => {
  const w = world({ exits: [1, 0] });
  const r = await launch(queue(), deps(w));
  assert.equal(r.outcome, 'stop');
  assert.deepEqual(r.jobs, [{ name: 'a', exit: 1 }]);
  assert.equal(w.spawned.length, 1);
  assert.equal(w.files.has('/runs/HOST-BUSY'), false);
});

test('a signal during a job kills it, releases HOST-BUSY and starts nothing else', async () => {
  const w = world({ signal: { at: 'job' }, exits: [143, 0] });
  const r = await launch(queue(), deps(w));
  assert.equal(r.outcome, 'stop');
  assert.equal(w.spawned.length, 1);
  assert.equal(w.files.has('/runs/HOST-BUSY'), false);
  assert.match(chain(w), /STOP: SIGTERM/);
});

test('HOST-BUSY is released when a step throws', async () => {
  const w = world();
  const d = deps(w);
  d.platform = { ...d.platform, record: () => { throw new Error('boom'); } };
  await assert.rejects(launch(queue([job('a')]), d), /boom/);
  assert.equal(w.files.has('/runs/HOST-BUSY'), false);
});

test('PostgreSQL logs are captured for the job only', async () => {
  const w = world();
  await launch(queue([job('a', { postgresLogLabel: 'io.fukulow.search-harness=153' })]), deps(w));
  assert.deepEqual(w.captured, ['io.fukulow.search-harness=153 -> /runs/chain/a-postgres.log']);
  assert.equal(w.stoppedLogs, 1);
});

test('a job without a quoted go, or another bad field, is refused with every problem', () => {
  const bad = { ...job('a'), go: { quote: '', date: '2026-11-24' }, commit: 'xyz', out: 'relative' };
  assert.throws(() => parseQueue(JSON.stringify({ name: 'q', chainDir: '/c', hostBusy: '/b', jobs: [bad] })),
    (e: Error) => /no quoted go/.test(e.message) && /commit must be/.test(e.message) && /out must be/.test(e.message));
  assert.throws(() => parseQueue(JSON.stringify({ name: 'q', chainDir: '/c', hostBusy: '/b', jobs: [job('a'), job('a')] })), /names must be unique/);
  assert.throws(() => parseQueue(JSON.stringify({ name: 'q', chainDir: 'c', hostBusy: '/b', jobs: [] })), /chainDir.*\n- jobs must be/s);
});

test('platform parts: sleep prevention and conditions', () => {
  assert.deepEqual(darwin.inhibit(['node', 'x']), ['caffeinate', '-dimsu', 'node', 'x']);
  assert.deepEqual(linux.inhibit(['node', 'x']), ['node', 'x']);
  assert.ok(linux.violations({ platform: 'linux', logicalCpus: 1, governors: null, ac: null, updateUnits: null, sleepUnits: null, snapHold: null } as unknown as HostRecord).length > 0);
});
