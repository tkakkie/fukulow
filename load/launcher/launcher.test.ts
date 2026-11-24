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
  head: string; dirty: string; node: string; free: number | null; dockerFree?: number | null; spawned: string[][]; captured: string[]; stoppedLogs: number;
  kills: number; busyAtExit: boolean[]; psLater?: string;
  // Thermal fakes: Tctl per reading (the last one repeats; null is unreadable), the clock that sleep advances,
  // the host record and the sampler's intervals and stops.
  tctl: (number | null)[]; clock: number; record?: HostRecord; noThermal?: boolean; everyMs: number[]; samplerStops: number;
  signal?: { at: 'wait' | 'job' | 'gate'; handler?: (s: string) => void };
};
function world(over: Partial<World> = {}): World {
  return { files: new Map(), containers: '', ps: '1 /sbin/init\n', load: [0.5], violations: [], exits: [0, 0], head: 'abc1234def\n', dirty: '',
    node: '26.13.1\n', free: 100 * GiB, spawned: [], captured: [], stoppedLogs: 0, kills: 0, busyAtExit: [],
    tctl: [40], clock: Date.parse('2026-11-24T00:00:00Z'), everyMs: [], samplerStops: 0, ...over };
}
function deps(w: World, platform?: Platform): Deps {
  const p: Platform = platform ?? { name: 'fake', inhibit: a => ['inhibit', ...a], violations: () => w.violations,
    load15: () => (w.load.length > 1 ? w.load.shift()! : w.load[0]), record: () => w.record ?? ({ fake: true } as unknown as HostRecord),
    thermal: now => {
      if (w.noThermal) return null;
      const t = w.tctl.length > 1 ? w.tctl.shift()! : w.tctl[0];
      return { at: now.toISOString(), avgFreqKHz: [3_000_000], temperaturesC: (t === null ? {} : { 'k10temp/Tctl': t }) as Record<string, number>, fansRpm: {} };
    } };
  return {
    platform: p,
    exec: argv => {
      const k = argv.join(' ');
      if (k === 'docker ps -q') return { status: 0, stdout: w.containers };
      if (k.startsWith('ps ')) { const out = w.ps; if (w.psLater !== undefined) w.ps = w.psLater; return { status: 0, stdout: out }; }
      if (k === 'git rev-parse HEAD') return { status: 0, stdout: w.head };
      if (k === 'git status --porcelain') return { status: 0, stdout: w.dirty };
      if (k === 'cat .node-version') return { status: 0, stdout: w.node };
      return { status: null, stdout: '' };
    },
    spawn: argv => {
      w.spawned.push(argv);
      const code = w.exits.shift() ?? 0;
      const child = { done: Promise.resolve().then(() => { w.busyAtExit.push(w.files.has('/runs/HOST-BUSY')); return code; }), kill: () => { w.kills++; } };
      const isJob = argv[0] === 'inhibit';
      if ((w.signal?.at === 'job' && isJob) || (w.signal?.at === 'gate' && !isJob)) queueMicrotask(() => w.signal?.handler?.('SIGTERM'));
      return child;
    },
    captureLogs: (label, file) => { w.captured.push(`${label} -> ${file}`); return () => { w.stoppedLogs++; }; },
    exists: path => w.files.has(path),
    claim: (path, text) => { if (w.files.has(path)) return false; w.files.set(path, text); return true; },
    remove: path => { w.files.delete(path); },
    append: (path, text) => { w.files.set(path, (w.files.get(path) ?? '') + text); },
    write: (path, text) => { w.files.set(path, text); },
    freeBytes: () => w.free, dockerFreeBytes: () => (w.dockerFree === undefined ? w.free : w.dockerFree),
    nodeVersion: 'v26.13.1', pid: 42, now: () => new Date(w.clock),
    sleep: async ms => { w.clock += ms; if (w.signal?.at === 'wait') w.signal.handler?.('SIGINT'); },
    every: (ms, fn) => { w.everyMs.push(ms); fn(); return () => { w.samplerStops++; }; },
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
    [{ dockerFree: 5 * GiB }, { image: 'postgres:18.6' }, /Docker free 5\.0 GiB < 40 GiB/],
    // A worker that starts after the idle check (the first ps) is caught by the preflight (the second).
    [{ psLater: '1 /sbin/init\n77 cargo test --all\n' }, {}, /workers running: 77 cargo test/],
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
  assert.equal(w.files.has('/runs/HOST-BUSY'), false);
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
  assert.equal(w.files.has('/runs/HOST-BUSY'), false);
});

test('a failed gate stops the queue; the job is not started', async () => {
  const w = world({ exits: [9] });
  const r = await launch(queue([job('a', { gate: ['node', 'load/capacity/d3r.ts'] })]), deps(w));
  assert.equal(r.outcome, 'stop');
  assert.deepEqual(w.spawned, [['node', 'load/capacity/d3r.ts']]);
  assert.match(chain(w), /a gate: exit=9/);
  assert.equal(w.files.has('/runs/HOST-BUSY'), false);
});

test('a failed job ends the queue and is never rerun', async () => {
  const w = world({ exits: [1, 0] });
  const r = await launch(queue(), deps(w));
  assert.equal(r.outcome, 'stop');
  assert.deepEqual(r.jobs, [{ name: 'a', exit: 1 }]);
  assert.equal(w.spawned.length, 1);
  assert.equal(w.files.has('/runs/HOST-BUSY'), false);
});

test('a signal during a job kills it, keeps HOST-BUSY until it exits, then releases it and starts nothing else', async () => {
  const w = world({ signal: { at: 'job' }, exits: [143, 0] });
  const r = await launch(queue(), deps(w));
  assert.equal(r.outcome, 'stop');
  assert.equal(w.spawned.length, 1);
  assert.equal(w.kills, 1);
  assert.deepEqual(w.busyAtExit, [true]);
  assert.equal(w.files.has('/runs/HOST-BUSY'), false);
  assert.match(chain(w), /STOP: SIGTERM/);
});

test('a signal on the last job is a STOP even if the job exits 0', async () => {
  const w = world({ signal: { at: 'job' }, exits: [0] });
  const r = await launch(queue([job('a')]), deps(w));
  assert.equal(r.outcome, 'stop');
  assert.match(r.reason ?? '', /SIGTERM during a/);
});

test('a signal during the gate kills it and the job never starts, even if the gate exits 0', async () => {
  const w = world({ signal: { at: 'gate' }, exits: [0, 0] });
  const r = await launch(queue([job('a', { gate: ['node', 'gate.ts'] })]), deps(w));
  assert.equal(r.outcome, 'stop');
  assert.deepEqual(w.spawned, [['node', 'gate.ts']]);
  assert.equal(w.kills, 1);
  assert.deepEqual(w.busyAtExit, [true]);
  assert.equal(w.files.has('/runs/HOST-BUSY'), false);
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

test('HOST-BUSY is released even if stopping the log capture throws', async () => {
  const w = world();
  const d = deps(w);
  d.captureLogs = () => () => { throw new Error('follower'); };
  d.platform = { ...d.platform, record: (() => { let n = 0; return () => { if (++n > 1) throw new Error('after'); return {} as HostRecord; }; })() };
  await assert.rejects(launch(queue([job('a', { postgresLogLabel: 'l' })]), d), /after/);
  assert.equal(w.files.has('/runs/HOST-BUSY'), false);
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

const cooling = { cooldown: { maxTctlC: 50, maxWaitSeconds: 1200 } };

test('the cool-down waits until Tctl is at most the limit, then starts the job, and keeps every reading', async () => {
  const w = world({ tctl: [70, 60, 50] });
  const r = await launch(queue([job('a', cooling)]), deps(w));
  assert.equal(r.outcome, 'done');
  assert.equal(w.spawned.length, 1);
  const record = JSON.parse(w.files.get('/runs/chain/a-cooldown.json') ?? '{}');
  assert.deepEqual([record.ok, record.waitedSeconds, record.readings.map((x: { tctlC: number }) => x.tctlC)], [true, 30, [70, 60, 50]]);
  assert.match(chain(w), /a: cool-down done, Tctl 50 °C after 30 s/);
});

test('a host that stays hot, an unreadable Tctl or a signal during the cool-down is a STOP before the job', async () => {
  const hot = world({ tctl: [51] });
  const r = await launch(queue([job('a', cooling)]), deps(hot));
  assert.match(r.reason ?? '', /a cool-down: Tctl 51 °C > 50 °C after 1200 s; job not started/);
  assert.equal(JSON.parse(hot.files.get('/runs/chain/a-cooldown.json') ?? '{}').ok, false);
  assert.deepEqual([hot.spawned.length, hot.files.has('/runs/HOST-BUSY')], [0, false]);

  for (const over of [{ tctl: [null] }, { noThermal: true }]) {
    const w = world(over);
    assert.match((await launch(queue([job('a', cooling)]), deps(w))).reason ?? '', /Tctl unreadable/);
    assert.equal(w.spawned.length, 0);
  }

  const signalled = world({ tctl: [70] });
  const d = deps(signalled);
  let handler: ((s: string) => void) | undefined;
  d.onSignal = h => { handler = h; };
  d.sleep = async ms => { signalled.clock += ms; handler?.('SIGTERM'); };
  assert.match((await launch(queue([job('a', cooling)]), d)).reason ?? '', /SIGTERM while cooling down/);
  assert.deepEqual([signalled.spawned.length, signalled.files.has('/runs/HOST-BUSY')], [0, false]);
});

test('required host settings are checked before the job; unreadable or different is a STOP', async () => {
  const base = { platform: 'linux', logicalCpus: 2, boost: '0', policyBoost: { 0: [0, 1] }, platformProfile: 'performance', fanControl: { 'hp/pwm1_enable': 0 } };
  const requireHost = { boost: '0', policyBoost: '0', platformProfile: 'performance', fanControl: { 'hp/pwm1_enable': 0 } };
  const ok = world({ record: base as unknown as HostRecord });
  assert.equal((await launch(queue([job('a', { requireHost })]), deps(ok))).outcome, 'done');
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ boost: '1' }, /boost is 1, required 0/],
    [{ policyBoost: { 0: [0], 1: [1] } }, /per-CPU boost is not 0 on every CPU/],
    [{ platformProfile: 'balanced' }, /platform profile is balanced/],
    [{ fanControl: { 'hp/pwm1_enable': 2 } }, /fan control hp\/pwm1_enable is 2, required 0/],
    [{ fanControl: null }, /fan control hp\/pwm1_enable is unreadable/],
  ];
  for (const [over, pattern] of cases) {
    const w = world({ record: { ...base, ...over } as unknown as HostRecord });
    const r = await launch(queue([job('a', { requireHost })]), deps(w));
    assert.match(r.reason ?? '', pattern);
    assert.equal(w.spawned.length, 0);
  }
});

test('thermal samples are taken while the job runs and stop when it exits, even if it fails', async () => {
  const w = world({ exits: [3] });
  const r = await launch(queue([job('a', { thermalSampleSeconds: 5 })]), deps(w));
  assert.equal(r.outcome, 'stop');
  assert.deepEqual([w.everyMs, w.samplerStops], [[5000], 1]);
  const lines = (w.files.get('/runs/chain/a-thermal.jsonl') ?? '').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 2); // one at start, one tick from the fake interval
  assert.equal(lines[0]['temperaturesC']['k10temp/Tctl'], 40);
  const none = world({ noThermal: true });
  assert.match((await launch(queue([job('a', { thermalSampleSeconds: 5 })]), deps(none))).reason ?? '', /no thermal readings on this platform/);
});

test('bad cooling fields are refused', () => {
  const bad = [{ cooldown: { maxTctlC: 0, maxWaitSeconds: 10 } }, { thermalSampleSeconds: -1 }, { requireHost: {} },
    { requireHost: { boost: 0 } }, { requireHost: { turbo: '0' } }, { requireHost: { fanControl: { 'hp/pwm1_enable': '0' } } }];
  for (const extra of bad) assert.throws(() => queue([job('a', extra)]), /cooldown|thermalSampleSeconds|requireHost/, JSON.stringify(extra));
});
