import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostRecord } from '../harness-core/host-record.ts';
import { formatHostBusy, parseHostBusy } from './host-busy.ts';
import { clockEvents, dockerPollMs, dockerSettleMs, fixedRate, launch, launchExitCode, pollMs, workers, type Deps } from './launcher.ts';
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
  kills: number; busyAtExit: boolean[];
  // Thermal fakes: Tctl per reading (the last one repeats; null is unreadable), the clock that sleep advances,
  // the host record and the sampler's intervals and stops.
  tctl: (number | null)[]; clock: number; record?: HostRecord; noThermal?: boolean; everyMs: number[]; samplerStops: number;
  freqs?: (number | null)[]; procStat?: (number[] | null)[] | null; thermalThrows?: boolean;
  signal?: { at: 'wait' | 'job' | 'gate'; handler?: (s: string) => void };
  // Workload fakes: the process group's liveness, the signals sent to it, `docker ps --filter label=`
  // answers (the last repeats) and the removed containers.
  alive?: (signals: string[]) => boolean; signals: string[]; labelled: string[]; removed: string[][];
  // The env each spawn got; how far the monotonic clock is from the wall clock (a step moves the wall only);
  // and, when set, a child whose exit is only observed after the given signal (never, for 'none').
  envs: (Record<string, string> | undefined)[]; monoShift: number; exitsOn?: 'SIGKILL' | 'none';
  // `docker ps -a --format '{{.ID}} {{.State}}'` answers, in order (the last repeats).
  psAll: string[];
  // `journalctl` answers: the cursor line (null: the call fails) and the entries after it.
  journalCursor?: string | null; journal?: string; journalFails?: boolean;
};
function world(over: Partial<World> = {}): World {
  return { files: new Map(), containers: '', ps: '1 /sbin/init\n', load: [0.5], violations: [], exits: [0, 0], head: 'abc1234def\n', dirty: '',
    node: '26.13.1\n', free: 100 * GiB, spawned: [], captured: [], stoppedLogs: 0, kills: 0, busyAtExit: [],
    tctl: [40], clock: Date.parse('2026-11-24T00:00:00Z'), everyMs: [], samplerStops: 0, signals: [], labelled: [''], removed: [], envs: [], monoShift: 0, psAll: [''], ...over };
}
function deps(w: World, platform?: Platform): Deps {
  const p: Platform = platform ?? { name: 'fake', inhibit: a => ['inhibit', ...a], violations: () => w.violations,
    loadAverages: () => ({ load1: 2.44, load5: 2.52, load15: w.load.length > 1 ? w.load.shift()! : w.load[0] }),
    record: () => w.record ?? ({ fake: true } as unknown as HostRecord),
    thermal: now => {
      if (w.noThermal) return null;
      if (w.thermalThrows) throw new Error('EIO');
      const t = w.tctl.length > 1 ? w.tctl.shift()! : w.tctl[0];
      const avgFreqKHz = w.freqs ?? [3_000_000];
      const procStat = w.procStat === undefined ? avgFreqKHz.map(() => [1, 0, 0, 1, 0, 0, 0, 0]) : w.procStat;
      return { at: now.toISOString(), avgFreqKHz, procStat, temperaturesC: (t === null ? {} : { 'k10temp/Tctl': t }) as Record<string, number>, fansRpm: {} };
    } };
  return {
    platform: p,
    exec: argv => {
      const k = argv.join(' ');
      if (k === 'docker ps -q') return { status: 0, stdout: w.containers };
      if (k.startsWith('ps ')) return { status: 0, stdout: w.ps };
      if (k === 'git rev-parse HEAD') return { status: 0, stdout: w.head };
      if (k === 'git status --porcelain') return { status: 0, stdout: w.dirty };
      if (k === 'cat .node-version') return { status: 0, stdout: w.node };
      if (k.startsWith('docker ps -a --format')) return { status: 0, stdout: w.psAll.length > 1 ? w.psAll.shift()! : w.psAll[0] };
      if (k.startsWith('docker ps -a -q --filter label=')) return { status: 0, stdout: w.labelled.length > 1 ? w.labelled.shift()! : w.labelled[0] };
      if (k === 'journalctl -n 0 --show-cursor --no-pager') return w.journalCursor === null ? { status: 1, stdout: '' } : { status: 0, stdout: `-- No entries --\n-- cursor: ${w.journalCursor ?? 's=1;i=2'}\n` };
      if (k.startsWith('journalctl --after-cursor ')) return w.journalFails ? { status: 1, stdout: '' } : { status: 0, stdout: w.journal ?? '' };
      if (k.startsWith('docker rm -f')) { w.removed.push(argv.slice(3)); return { status: 0, stdout: '' }; }
      return { status: null, stdout: '' };
    },
    spawn: (argv, opts) => {
      w.spawned.push(argv);
      w.envs.push(opts.env);
      const code = w.exits.shift() ?? 0;
      let exited = () => {};
      const signalled = new Promise<void>(resolve => { exited = resolve; });
      const done = (w.exitsOn ? signalled : Promise.resolve()).then(() => { w.busyAtExit.push(w.files.has('/runs/HOST-BUSY')); return code; });
      const child = { done,
        kill: (signal = 'SIGTERM') => { w.kills++; w.signals.push(signal); if (signal === w.exitsOn) exited(); }, alive: () => w.alive?.(w.signals) ?? false };
      const isJob = argv[0] === 'inhibit';
      if ((w.signal?.at === 'job' && isJob) || (w.signal?.at === 'gate' && !isJob)) queueMicrotask(() => w.signal?.handler?.('SIGTERM'));
      return child;
    },
    captureLogs: (label, file) => { w.captured.push(`${label} -> ${file}`); return () => { w.stoppedLogs++; }; },
    exists: path => w.files.has(path),
    read: path => w.files.get(path) ?? null,
    claim: (path, text) => { if (w.files.has(path)) return false; w.files.set(path, text); return true; },
    remove: path => { w.files.delete(path); },
    append: (path, text) => { w.files.set(path, (w.files.get(path) ?? '') + text); },
    write: (path, text) => { w.files.set(path, text); },
    freeBytes: () => w.free, dockerFreeBytes: () => (w.dockerFree === undefined ? w.free : w.dockerFree),
    nodeVersion: 'v26.13.1', pid: 42, sessionId: () => 'sess-1', now: () => new Date(w.clock), mono: () => w.clock + w.monoShift,
    sleep: async ms => { w.clock += ms; if (w.signal?.at === 'wait') w.signal.handler?.('SIGINT'); },
    pause: async ms => { w.clock += ms; },
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
  const session = JSON.parse(w.files.get('/runs/chain/session.json') ?? '{}');
  assert.deepEqual([session.queue, session.outcome, session.hostBusy, session.jobs.map((j: { name: string; exit: number }) => [j.name, j.exit])],
    ['q', 'done', 'released', [['a', 0], ['b', 0]]]);
});

test('#796 issues its go to the runner and keeps HOST-BUSY while a cpufreq restore is pending', async () => {
  const w = world();
  const d = deps(w);
  const spawn = d.spawn;
  d.spawn = (argv, opts) => {
    w.files.set('/runs/out-a/frequency-restore-pending.json', '{}');
    return spawn(argv, opts);
  };
  const q = queue([job('a', { issue: 796 })]);
  const result = await launch(q, d);
  assert.equal(result.outcome, 'stop');
  assert.equal(w.files.has('/runs/HOST-BUSY'), true);
  const session = JSON.parse(w.files.get('/runs/chain/session.json')!);
  assert.match(session.workloadProblems.join(), /cpufreq restoration is unconfirmed/);
  assert.deepEqual(session.jobs[0].frequencyGo, q.jobs[0].go);
  assert.deepEqual(JSON.parse(w.envs[0]!.FUKULOW_LAUNCH_FREQUENCY).go, q.jobs[0].go);
});

test('#796 snapshots CPU policies before starting the job and stops if they are unreadable', async () => {
  const q = queue([job('a', { issue: 796, command: ['node', 'final.ts', '--frequency-v3=control'] })]);
  const unreadable = world();
  const stopped = await launch(q, deps(unreadable));
  assert.match(stopped.reason ?? '', /F1 CPU policies unreadable/);
  assert.deepEqual(unreadable.spawned, []);
  const w = world();
  const d = deps(w);
  const policy = { bootId: 'boot', kernel: 'kernel', online: '0-15', boost: '0', profile: 'performance', paranoid: '4', policies: [] };
  d.platform.cpuPolicy = () => policy;
  assert.equal((await launch(q, d)).outcome, 'done');
  assert.deepEqual(JSON.parse(w.envs[0]!.FUKULOW_LAUNCH_FREQUENCY).policy, policy);
  assert.deepEqual(JSON.parse(w.files.get('/runs/chain/a-launch-check.json')!).frequencyPolicy, policy);
});

test('the launcher waits until the host is idle, then claims HOST-BUSY', async () => {
  const w = world({ load: [5, 5, 0.5] });
  const r = await launch(queue([job('a')]), deps(w));
  assert.equal(r.outcome, 'done');
  assert.equal(w.spawned.length, 1);
  assert.equal(w.files.has('/runs/HOST-BUSY'), false);
});

// Apply a change after the last Docker snapshot of the first job's workload check.
function afterFirstWorkloadCheck(d: Deps, change: () => void) {
  const exec = d.exec;
  let snapshots = 0;
  d.exec = (argv, cwd) => {
    const result = exec(argv, cwd);
    // One snapshot at claim, then both endpoints of the settle window and every poll between.
    if (argv.join(' ') === 'docker ps -a --format {{.ID}} {{.State}}' && ++snapshots === 2 + dockerSettleMs / dockerPollMs) change();
    return result;
  };
}

test('the second job waits for load15 to drop below the limit and records its idle release', async () => {
  const w = world();
  const d = deps(w);
  afterFirstWorkloadCheck(d, () => { w.load = [3.04, 3.04, 3, 2.1]; });
  const sleep = d.sleep;
  let polls = 0;
  d.sleep = async ms => {
    assert.equal(ms, pollMs);
    assert.equal(w.spawned.length, 1);
    assert.equal(w.files.has('/runs/chain/b-host-before.json'), false);
    assert.equal(w.files.has('/runs/chain/b-cooldown.json'), false);
    polls++;
    await sleep(ms);
  };
  const r = await launch(queue([job('a'), job('b', { ...cooling, gate: ['node', 'gate.ts'] })]), d);
  assert.equal(r.outcome, 'done');
  assert.equal(w.spawned.length, 3);
  assert.equal(polls, 3);
  const { launchSession, ...idle } = JSON.parse(w.files.get('/runs/chain/b-idle.json')!);
  assert.equal(launchSession, 'sess-1');
  assert.deepEqual(idle, {
    load1: 2.44, load5: 2.52, load15: 2.1, at: new Date(w.clock - 2 * dockerSettleMs).toISOString(),
    waitedMs: 3 * pollMs, reasonsSeen: ['load15 3.04 >= 3', 'load15 3.00 >= 3'],
  });
  const session = JSON.parse(w.files.get('/runs/chain/session.json')!);
  assert.deepEqual(session.jobs[1].idle, idle);
  assert.equal(session.jobs[0].idle.waitedMs, 0);
  assert.match(chain(w), /b: waiting for an idle host/);
  assert.equal(chain(w).match(/b: idle wait: load15 3\.04/g)?.length, 1);
  assert.match(chain(w), new RegExp(`b: idle wait done after ${3 * pollMs} ms`));
});

test('the second job waits while either a container or a worker is running', async () => {
  const w = world();
  const d = deps(w);
  afterFirstWorkloadCheck(d, () => { w.containers = 'c1\n'; });
  const sleep = d.sleep;
  const worker = '77 cargo test --all';
  let polls = 0;
  d.sleep = async ms => {
    assert.equal(ms, pollMs);
    assert.equal(w.spawned.length, 1);
    w.containers = '';
    w.ps = ++polls === 1 ? worker : '';
    await sleep(ms);
  };
  assert.equal((await launch(queue(), d)).outcome, 'done');
  assert.equal(w.spawned.length, 2);
  assert.equal(polls, 2);
  const idle = JSON.parse(w.files.get('/runs/chain/b-idle.json')!);
  assert.deepEqual(idle.reasonsSeen, ['containers running', `workers running: ${worker}`]);
});

for (const [command, reason] of [['docker ps -q', 'docker ps failed'], ['ps -Ao pid=,command=', 'ps failed']]) {
  test(`the second job keeps waiting when ${command} fails`, async () => {
    const w = world();
    const d = deps(w);
    let failing = false;
    afterFirstWorkloadCheck(d, () => { failing = true; });
    const exec = d.exec;
    d.exec = (argv, cwd) => failing && argv.join(' ') === command ? { status: 1, stdout: '' } : exec(argv, cwd);
    const sleep = d.sleep;
    let polls = 0;
    d.sleep = async ms => {
      assert.equal(ms, pollMs);
      assert.equal(w.spawned.length, 1);
      assert.equal(w.files.has('/runs/chain/b-idle.json'), false);
      failing = ++polls < 2;
      await sleep(ms);
    };
    assert.equal((await launch(queue(), d)).outcome, 'done');
    assert.equal(w.spawned.length, 2);
    assert.equal(polls, 2);
    const idle = JSON.parse(w.files.get('/runs/chain/b-idle.json')!);
    assert.deepEqual(idle.reasonsSeen, [reason]);
  });
}

test('a missing or replaced HOST-BUSY between jobs stops the queue and preserves a replacement', async () => {
  for (const replacement of [null, formatHostBusy('other', ['c'], new Date(0), 'sess-2')]) {
    const w = world();
    const d = deps(w);
    const q = queue();
    afterFirstWorkloadCheck(d, () => {
      if (replacement === null) w.files.delete(q.hostBusy);
      else w.files.set(q.hostBusy, replacement);
    });
    const r = await launch(q, d);
    assert.equal(r.outcome, 'stop');
    assert.match(r.reason ?? '', /HOST-BUSY missing, unreadable or replaced.*b not started/);
    assert.deepEqual(r.jobs, [{ name: 'a', exit: 0 }]);
    assert.equal(w.spawned.length, 1);
    assert.equal(w.files.get(q.hostBusy) ?? null, replacement);
    const session = JSON.parse(w.files.get('/runs/chain/session.json')!);
    assert.equal(session.hostBusy, 'lost');
  }
});

for (const loss of ['deleted', 'unreadable', 'replaced']) {
  test(`HOST-BUSY ${loss} during the final job stops the queue`, async () => {
    const w = world();
    const d = deps(w);
    const q = queue();
    const replacement = formatHostBusy('other', ['c'], new Date(0), 'sess-2');
    const spawn = d.spawn;
    d.spawn = (argv, opts) => {
      const child = spawn(argv, opts);
      if (opts.env?.FUKULOW_LAUNCH_JOB === 'b') {
        if (loss === 'deleted') w.files.delete(q.hostBusy);
        if (loss === 'replaced') w.files.set(q.hostBusy, replacement);
        if (loss === 'unreadable') {
          const read = d.read;
          d.read = path => path === q.hostBusy ? null : read(path);
        }
      }
      return child;
    };
    const r = await launch(q, d);
    assert.deepEqual(r, { outcome: 'stop', reason: 'HOST-BUSY lost before release', jobs: [{ name: 'a', exit: 0 }, { name: 'b', exit: 0 }] });
    assert.equal(launchExitCode(r.outcome), 3);
    const session = JSON.parse(w.files.get('/runs/chain/session.json')!);
    assert.equal(session.outcome, 'stop');
    assert.equal(session.reason, r.reason);
    assert.equal(session.hostBusy, 'lost');
    if (loss === 'replaced') assert.equal(w.files.get(q.hostBusy), replacement);
    else assert.equal(w.files.has(q.hostBusy), loss === 'unreadable');
  });
}

test('a signal interrupts the second job idle wait, stops the queue and releases HOST-BUSY', async () => {
  const w = world({ signal: { at: 'wait' } });
  const d = deps(w);
  const q = queue();
  afterFirstWorkloadCheck(d, () => { w.load = [5]; });
  let polls = 0;
  d.sleep = async ms => {
    assert.equal(ms, pollMs);
    assert.equal(w.spawned.length, 1);
    assert.equal(w.files.has(q.hostBusy), true);
    polls++;
    w.signal?.handler?.('SIGINT');
  };
  const r = await launch(q, d);
  assert.equal(r.outcome, 'stop');
  assert.match(r.reason ?? '', /SIGINT while waiting for idle; b not started/);
  assert.equal(w.spawned.length, 1);
  assert.equal(w.kills, 0);
  assert.equal(polls, 1);
  assert.equal(w.files.has('/runs/chain/b-idle.json'), false);
  assert.equal(w.files.has(q.hostBusy), false);
  assert.match(chain(w), /b: idle wait stopped after 0 ms/);
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
    [{ free: null }, { image: 'postgres:18.6', workloadLabel: 'l' }, /host free unreadable.*Docker free unreadable/],
    [{ dockerFree: 5 * GiB }, { image: 'postgres:18.6', workloadLabel: 'l' }, /Docker free 5\.0 GiB < 40 GiB/],
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

test('a worker that starts after the per-job idle check is caught by preflight', async () => {
  const w = world();
  const d = deps(w);
  const record = d.platform.record;
  d.platform.record = path => {
    w.ps = '77 cargo test --all\n';
    return record(path);
  };
  const r = await launch(queue([job('a')]), d);
  assert.equal(r.outcome, 'stop');
  assert.match(r.reason ?? '', /a preflight: workers running: 77 cargo test/);
  assert.equal(w.spawned.length, 0);
  assert.equal(w.files.has('/runs/HOST-BUSY'), false);
});

test('containers that appear after the idle check stop the job', async () => {
  const w = world();
  const d = deps(w);
  let calls = 0;
  const exec = d.exec;
  d.exec = (argv, cwd) => (argv.join(' ') === 'docker ps -q' && ++calls > 2 ? { status: 0, stdout: 'c1\n' } : exec(argv, cwd));
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

test('a job that ends with exit 2 (the #870 driver: not a normal finish) ends the queue; the next job never starts', async () => {
  const w = world({ exits: [2, 0] });
  const r = await launch(queue(), deps(w));
  assert.equal(r.outcome, 'stop');
  assert.deepEqual(r.jobs, [{ name: 'a', exit: 2 }]);
  assert.equal(w.spawned.length, 1);
  assert.match(chain(w), /a exited 2; the queue ends \(no rerun\)/);
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

for (const loss of ['deleted', 'unreadable', 'replaced']) {
  for (const phase of ['cool-down', 'preflight', 'gate run']) {
    test(`HOST-BUSY ${loss} during the ${phase} blocks the next spawn`, async () => {
      const w = world({ tctl: [70, 40] });
      const d = deps(w);
      const gate = ['node', 'gate.ts'];
      const q = queue([job('a', { ...cooling, gate, thermalSampleSeconds: 5, postgresLogLabel: 'io.fukulow.test=a' })]);
      const original = formatHostBusy(q.name, ['a'], d.now(), 'sess-1');
      const replacement = formatHostBusy('other', ['c'], new Date(0), 'sess-2');
      const loseMarker = () => {
        assert.ok(w.files.has('/runs/chain/a-idle.json'));
        assert.equal(w.files.get(q.hostBusy), original);
        if (loss === 'deleted') w.files.delete(q.hostBusy);
        if (loss === 'replaced') w.files.set(q.hostBusy, replacement);
        if (loss === 'unreadable') {
          const read = d.read;
          d.read = path => path === q.hostBusy ? null : read(path);
        }
      };
      if (phase === 'cool-down') {
        const sleep = d.sleep;
        d.sleep = ms => { loseMarker(); return sleep(ms); };
      } else if (phase === 'preflight') {
        const freeBytes = d.freeBytes;
        d.freeBytes = path => { loseMarker(); return freeBytes(path); };
      } else {
        const spawn = d.spawn;
        d.spawn = (argv, opts) => {
          const child = spawn(argv, opts);
          if (argv === q.jobs[0].gate) return { ...child, done: child.done.then(code => { loseMarker(); return code; }) };
          return child;
        };
      }

      const r = await launch(q, d);
      const gateRan = phase === 'gate run';
      const reason = gateRan ? 'before a; job not started' : 'before the gate; a not started';
      assert.deepEqual(r, { outcome: 'stop', reason: `HOST-BUSY missing, unreadable or replaced ${reason}`, jobs: [] });
      assert.equal(launchExitCode(r.outcome), 3);
      assert.deepEqual(w.spawned, gateRan ? [gate] : []);
      assert.doesNotMatch(chain(w), /a: start \(once, no rerun\)/);
      assert.deepEqual([w.captured.length, w.stoppedLogs, w.samplerStops], gateRan ? [1, 1, 1] : [0, 0, 0]);
      const session = JSON.parse(w.files.get('/runs/chain/session.json')!);
      assert.equal(session.hostBusy, 'lost');
      assert.equal(w.files.get(q.hostBusy), loss === 'deleted' ? undefined : loss === 'replaced' ? replacement : original);
    });
  }
}

test('the claim is checked after job setup and an unreadable marker is left in place even if it becomes readable again', async () => {
  const w = world();
  const d = deps(w);
  const q = queue([job('a', { thermalSampleSeconds: 5, postgresLogLabel: 'io.fukulow.test=a' })]);
  const read = d.read;
  const inhibit = d.platform.inhibit;
  d.platform = { ...d.platform, inhibit: argv => {
    assert.deepEqual(w.everyMs, [5000]);
    assert.equal(w.captured.length, 1);
    d.read = path => {
      if (path !== q.hostBusy) return read(path);
      d.read = read;
      return null;
    };
    return inhibit(argv);
  } };
  const r = await launch(q, d);
  assert.deepEqual(r, { outcome: 'stop', reason: 'HOST-BUSY missing, unreadable or replaced before a; job not started', jobs: [] });
  assert.equal(launchExitCode(r.outcome), 3);
  assert.deepEqual(w.spawned, []);
  assert.deepEqual([w.samplerStops, w.stoppedLogs], [1, 1]);
  assert.equal(JSON.parse(w.files.get('/runs/chain/session.json')!).hostBusy, 'lost');
  assert.equal(w.files.get(q.hostBusy), formatHostBusy(q.name, ['a'], d.now(), 'sess-1'));
});

test('the second job does not spawn when HOST-BUSY is replaced after its idle wait', async () => {
  const w = world();
  const d = deps(w);
  const q = queue();
  const replacement = formatHostBusy('other', ['c'], new Date(0), 'sess-2');
  const freeBytes = d.freeBytes;
  d.freeBytes = path => {
    if (w.files.has('/runs/chain/b-idle.json')) w.files.set(q.hostBusy, replacement);
    return freeBytes(path);
  };
  const r = await launch(q, d);
  assert.deepEqual(r, { outcome: 'stop', reason: 'HOST-BUSY missing, unreadable or replaced before b; job not started',
    jobs: [{ name: 'a', exit: 0 }] });
  assert.equal(launchExitCode(r.outcome), 3);
  assert.deepEqual(w.envs.map(env => env?.FUKULOW_LAUNCH_JOB), ['a']);
  assert.match(chain(w), /a: start \(once, no rerun\)/);
  assert.doesNotMatch(chain(w), /b: start \(once, no rerun\)/);
  assert.equal(JSON.parse(w.files.get('/runs/chain/session.json')!).hostBusy, 'lost');
  assert.equal(w.files.get(q.hostBusy), replacement);
});

test('a lost claim before the job spawn preserves the marker and reports a lingering gate workload', async () => {
  const w = world();
  const d = deps(w);
  const gate = ['node', 'gate.ts'];
  const q = queue([job('a', { gate })]);
  const replacement = formatHostBusy('other', ['c'], new Date(0), 'sess-2');
  const spawn = d.spawn;
  d.spawn = (argv, opts) => {
    const child = spawn(argv, opts);
    return { ...child, done: child.done.then(code => {
      w.files.set(q.hostBusy, replacement);
      w.psAll = ['c1 running\n'];
      return code;
    }) };
  };

  const r = await launch(q, d);
  const session = JSON.parse(w.files.get('/runs/chain/session.json')!);
  const problem = /containers not live at the claim were live after the job: c1 running/;
  assert.deepEqual(w.spawned, [gate]);
  assert.equal(w.files.get(q.hostBusy), replacement);
  assert.equal(session.hostBusy, 'lost');
  assert.match(session.workloadProblems.join(), problem);
  assert.equal(r.outcome, 'stop');
  assert.equal(session.reason, r.reason);
  assert.match(session.reason, /HOST-BUSY lost.*workload not confirmed stopped/);
  assert.match(session.reason, problem);
  assert.match(chain(w), /HOST-BUSY lost.*workload not confirmed stopped.*c1 running/);
});

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
  const cases: [Partial<World>, RegExp][] = [
    [{ noThermal: true }, /no thermal readings on this platform/],
    [{ thermalThrows: true }, /thermal sample failed: Error: EIO/],
    [{ freqs: [3_000_000, null, 3_000_000, null] }, /CPU frequency unreadable on CPU 1,3/],
    [{ freqs: [] }, /no CPU frequencies/],
    [{ procStat: null }, /\/proc\/stat unreadable/],
    [{ freqs: [3_000_000, 3_000_000], procStat: [[1, 0, 0, 1, 0, 0, 0, 0]] }, /\/proc\/stat counters unreadable on CPU 1/],
  ];
  for (const [over, pattern] of cases) {
    const bad = world(over);
    assert.match((await launch(queue([job('a', { thermalSampleSeconds: 5 })]), deps(bad))).reason ?? '', pattern);
    assert.deepEqual([bad.spawned.length, bad.files.has('/runs/HOST-BUSY')], [0, false]);
  }
});

test('bad cooling fields are refused', () => {
  const bad = [{ cooldown: { maxTctlC: 0, maxWaitSeconds: 10 } }, { thermalSampleSeconds: -1 }, { requireHost: {} },
    { requireHost: { boost: 0 } }, { requireHost: { turbo: '0' } }, { requireHost: { fanControl: { 'hp/pwm1_enable': '0' } } },
    { confirmations: {} }, { confirmations: { airflow: { quote: '', date: '2026-11-25' } } }, { workloadLabel: 'a b' }];
  for (const extra of bad) assert.throws(() => queue([job('a', extra)]), /cooldown|thermalSampleSeconds|requireHost|confirmations|workloadLabel/, JSON.stringify(extra));
});

test('a cool reading after the deadline does not pass the cool-down', async () => {
  const w = world();
  const d = deps(w);
  const start = w.clock;
  d.platform = { ...d.platform, thermal: now => ({ at: now.toISOString(), avgFreqKHz: [1], temperaturesC: { 'k10temp/Tctl': now.getTime() - start > 1_200_000 ? 49 : 51 }, fansRpm: {} }) };
  d.sleep = async ms => { w.clock += ms + 50; }; // every real sleep overshoots a little
  const r = await launch(queue([job('a', cooling)]), d);
  assert.match(r.reason ?? '', /a cool-down: no reading <= 50 °C within 1200 s \(last 49 after 1200\.\d+ s\)/);
  assert.deepEqual([JSON.parse(w.files.get('/runs/chain/a-cooldown.json') ?? '{}').ok, w.spawned.length], [false, 0]);
});

test('Tctl and the levers are checked again right before the spawn, after the host record, preflight and gate', async () => {
  const levers = { requireHost: { boost: '0' }, ...cooling, gate: ['node', 'gate.ts'] };
  const hot = world({ tctl: [45, 55], record: { boost: '0' } as unknown as HostRecord });
  const r = await launch(queue([job('a', levers)]), deps(hot));
  assert.match(r.reason ?? '', /a launch check: Tctl 55 °C > 50 °C; job not started/);
  assert.deepEqual(hot.spawned, [['node', 'gate.ts']]);
  assert.equal(JSON.parse(hot.files.get('/runs/chain/a-launch-check.json') ?? '{}').ok, false);

  const changed = world({ tctl: [45] });
  const d = deps(changed);
  let n = 0;
  d.platform = { ...d.platform, record: () => ({ boost: ++n > 1 ? '1' : '0' }) as unknown as HostRecord };
  assert.match((await launch(queue([job('a', levers)]), d)).reason ?? '', /a launch check: boost is 1, required 0/);
  assert.deepEqual([changed.spawned.length, changed.files.has('/runs/HOST-BUSY')], [1, false]);

  const ok = world({ tctl: [45], record: { boost: '0' } as unknown as HostRecord });
  assert.equal((await launch(queue([job('a', levers)]), deps(ok))).outcome, 'done');
  assert.deepEqual(JSON.parse(ok.files.get('/runs/chain/a-launch-check.json') ?? '{}').tctlC, 45);
});

test('a failed sampler write stops the job through the same path as a signal, and HOST-BUSY is released after it exits', async () => {
  const w = world({ exits: [143, 0] });
  const d = deps(w);
  let tick: (() => void) | null = null;
  d.every = (ms, fn) => { w.everyMs.push(ms); tick = fn; return () => { w.samplerStops++; }; };
  const spawn = d.spawn;
  d.spawn = (argv, opts) => { const c = spawn(argv, opts); queueMicrotask(() => tick?.()); return c; };
  const append = d.append;
  let writes = 0;
  d.append = (path, text) => { if (path.endsWith('-thermal.jsonl') && ++writes > 1) throw new Error('ENOSPC: no space left on device'); append(path, text); };
  const r = await launch(queue([job('a', { thermalSampleSeconds: 5 }), job('b')]), d);
  assert.match(r.reason ?? '', /thermal sample write failed: Error: ENOSPC.* during a; the queue ends/);
  assert.deepEqual([w.spawned.length, w.signals, w.busyAtExit, w.samplerStops, w.files.has('/runs/HOST-BUSY')], [1, ['SIGTERM'], [true], 1, false]);
  assert.equal(JSON.parse(w.files.get('/runs/chain/session.json') ?? '{}').hostBusy, 'released');
});

test('a signal still kills the job when the chain log cannot be written', async () => {
  const w = world({ signal: { at: 'job' }, exits: [143] });
  const d = deps(w);
  const append = d.append;
  d.append = (path, text) => { if (/STOP: SIGTERM/.test(text)) throw new Error('ENOSPC'); append(path, text); };
  await assert.rejects(launch(queue([job('a')]), d), /ENOSPC/);
  assert.deepEqual([w.signals, w.files.has('/runs/HOST-BUSY')], [['SIGTERM'], false]);
});

test('HOST-BUSY is released only after the job\'s process group and labelled containers are gone', async () => {
  // A group that outlives the job gets SIGTERM, then SIGKILL; one that survives both keeps HOST-BUSY.
  const term = world({ alive: s => s.length < 1 });
  assert.equal((await launch(queue([job('a')]), deps(term))).outcome, 'done');
  assert.deepEqual([term.signals, term.files.has('/runs/HOST-BUSY')], [['SIGTERM'], false]);
  const between = world({ alive: s => s.length < 1 });
  assert.equal((await launch(queue(), deps(between))).outcome, 'done');
  assert.deepEqual([between.spawned.length, between.signals], [2, ['SIGTERM']]); // job a's group was stopped before b started
  const stubborn = world({ alive: () => true });
  const r = await launch(queue([job('a')]), deps(stubborn));
  assert.match(r.reason ?? '', /HOST-BUSY kept: a: process group still running after SIGKILL/);
  assert.deepEqual([stubborn.signals, stubborn.files.has('/runs/HOST-BUSY')], [['SIGTERM', 'SIGKILL'], true]); // after the job; the release does not repeat it
  assert.equal(JSON.parse(stubborn.files.get('/runs/chain/session.json') ?? '{}').hostBusy, 'kept');
  // The job's containers (by its workloadLabel) are removed, and must be gone afterwards.
  const left = world({ labelled: ['c1\nc2\n', ''], exits: [143] });
  assert.equal((await launch(queue([job('a', { workloadLabel: 'io.fukulow.probe=519-final' })]), deps(left))).outcome, 'stop');
  assert.deepEqual([left.removed, left.files.has('/runs/HOST-BUSY')], [[['c1', 'c2']], false]);
  const stuck = world({ labelled: ['c1\n'] });
  assert.match((await launch(queue([job('a', { workloadLabel: 'io.fukulow.probe=519-final' })]), deps(stuck))).reason ?? '', /containers with label io\.fukulow\.probe=519-final still present/);
  assert.equal(stuck.files.has('/runs/HOST-BUSY'), true);
});

test('maintainer confirmations go to the chain log and the session record', async () => {
  const w = world();
  const confirmations = { airflow: { quote: '蓋を開けて台に載せた', date: '2026-11-25' } };
  await launch(queue([job('a', { confirmations })]), deps(w));
  assert.match(chain(w), /a: confirmed airflow: "蓋を開けて台に載せた" \(2026-11-25\)/);
  assert.deepEqual(JSON.parse(w.files.get('/runs/chain/session.json') ?? '{}').jobs[0].confirmations, confirmations);
});

const files = (w: World, suffix: string) => [...w.files.entries()].filter(([k]) => k.endsWith(suffix)).map(([, v]) => v);

test('the HOST-BUSY formatter preserves the marker line and round-trips the jobs and session', () => {
  const at = new Date('2026-11-26T00:00:00.000Z');
  const jobs = ['smoke-870', 'stage1-870', 'stage2-870'];
  const line = formatHostBusy('diagnosis: #870', jobs, at, 'sess-1');
  assert.equal(line, 'diagnosis: #870: smoke-870, stage1-870, stage2-870 2026-11-26T00:00:00.000Z session sess-1\n');
  assert.deepEqual(parseHostBusy(line), { jobs, session: 'sess-1' });
  assert.equal(parseHostBusy(line.replace(' session sess-1', '')), null);
  assert.equal(parseHostBusy(line + 'extra line\n'), null);
});

test('every artefact, the HOST-BUSY marker and each spawn carry the one launch session id', async () => {
  const w = world({ tctl: [45], record: { boost: '0' } as unknown as HostRecord });
  const label = { workloadLabel: 'io.fukulow.probe=519-final', requireHost: { boost: '0' }, ...cooling, thermalSampleSeconds: 5, gate: ['node', 'gate.ts'] };
  const d = deps(w);
  let marker = '';
  const claim = d.claim;
  d.claim = (path, text) => { marker = text; return claim(path, text); };
  assert.equal((await launch(queue([job('a', label)]), d)).outcome, 'done');
  assert.deepEqual(parseHostBusy(marker), { jobs: ['a'], session: 'sess-1' });
  assert.deepEqual(w.envs.map(e => e?.FUKULOW_LAUNCH_SESSION), ['sess-1', 'sess-1']); // gate and job
  for (const f of ['a-idle.json', 'a-cooldown.json', 'a-host-before.json', 'a-launch-check.json', 'a-host-after.json']) {
    assert.equal(JSON.parse(w.files.get('/runs/chain/' + f) ?? '{}').launchSession, 'sess-1', f);
  }
  const lines = files(w, '-thermal.jsonl')[0].trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => l.launchSession), ['sess-1', 'sess-1']);
  const session = JSON.parse(w.files.get('/runs/chain/session.json') ?? '{}');
  assert.deepEqual([session.id, session.jobs[0].out, session.jobs[0].workloadLabel], ['sess-1', '/runs/out-a', 'io.fukulow.probe=519-final']);
});

test('chain records an earlier session left for the job are a STOP, never appended to', async () => {
  for (const f of ['a-idle.json', 'a-thermal.jsonl', 'a-cooldown.json', 'a-host-before.json']) {
    const w = world();
    w.files.set('/runs/chain/' + f, '{"launchSession":"old"}\n');
    const r = await launch(queue([job('a', { thermalSampleSeconds: 5 })]), deps(w));
    assert.match(r.reason ?? '', new RegExp(`a: chain records from another session exist: /runs/chain/${f}`));
    assert.deepEqual([w.spawned.length, w.files.get('/runs/chain/' + f), w.files.has('/runs/HOST-BUSY')], [0, '{"launchSession":"old"}\n', false]);
  }
});

test('the cool-down deadline is monotonic, taken after the Tctl read: a slow read that ends after 1200 s fails', async () => {
  const w = world();
  const d = deps(w);
  const start = w.clock;
  // Each read takes 2 s; a read that starts at 1199 s (cool from 1195 s) ends at 1201 s.
  d.platform = { ...d.platform, thermal: now => { w.clock += 2000; return { at: now.toISOString(), avgFreqKHz: [1], temperaturesC: { 'k10temp/Tctl': now.getTime() - start >= 1_195_000 ? 49 : 51 }, fansRpm: {} }; } };
  const r = await launch(queue([job('a', cooling)]), d);
  assert.match(r.reason ?? '', /a cool-down: no reading <= 50 °C within 1200 s \(last 49 after 1201 s\)/);
  const record = JSON.parse(w.files.get('/runs/chain/a-cooldown.json') ?? '{}');
  assert.deepEqual([record.ok, record.readings.at(-1).elapsedMs, w.spawned.length], [false, 1_201_000, 0]);
});

test('a wall-clock step during the cool-down is a STOP, even with a cool reading', async () => {
  for (const stepMs of [-60_000, 5_000]) {
    const w = world({ tctl: [70, 45] });
    const d = deps(w);
    let n = 0;
    const thermal = d.platform.thermal;
    d.platform = { ...d.platform, thermal: now => { if (++n === 2) { w.clock += stepMs; w.monoShift -= stepMs; } return thermal(now); } };
    const r = await launch(queue([job('a', cooling)]), d);
    assert.match(r.reason ?? '', new RegExp(`a cool-down: wall clock stepped ${stepMs} ms against the monotonic clock`));
    assert.deepEqual([w.spawned.length, w.files.has('/runs/HOST-BUSY')], [0, false]);
  }
  // A drift within the tolerance is not a step.
  const w = world({ tctl: [70, 45] });
  const d = deps(w);
  d.sleep = async ms => { w.clock += ms; w.monoShift -= 900; };
  assert.equal((await launch(queue([job('a', cooling)]), d)).outcome, 'done');
});

test('a failed first sampler read after a passed preflight blocks the spawn', async () => {
  const cases: [(n: number) => 'throw' | 'unreadable' | 'none' | 'ok', RegExp][] = [
    [n => (n === 2 ? 'throw' : 'ok'), /a first thermal sample: thermal sample failed: Error: EIO; job not started/],
    [n => (n === 2 ? 'unreadable' : 'ok'), /a first thermal sample: CPU frequency unreadable on CPU 0; job not started/],
    [n => (n === 2 ? 'none' : 'ok'), /a first thermal sample: no thermal readings on this platform; job not started/],
  ];
  for (const [mode, pattern] of cases) {
    const w = world();
    const d = deps(w);
    let n = 0;
    d.platform = { ...d.platform, thermal: now => {
      const m = mode(++n);
      if (m === 'throw') throw new Error('EIO');
      if (m === 'none') return null;
      return { at: now.toISOString(), avgFreqKHz: [m === 'unreadable' ? null : 3_000_000], procStat: [[1, 0, 0, 1, 0, 0, 0, 0]], temperaturesC: {}, fansRpm: {} };
    } };
    const r = await launch(queue([job('a', { thermalSampleSeconds: 5 })]), d);
    assert.match(r.reason ?? '', pattern);
    assert.deepEqual([w.spawned.length, w.everyMs, w.files.has('/runs/HOST-BUSY')], [0, [], false]);
    assert.equal((files(w, '-thermal.jsonl')[0] ?? '').trim().split('\n').length, 1); // the failed sample is kept
  }
  const w = world();
  const d = deps(w);
  const append = d.append;
  d.append = (path, text) => { if (path.endsWith('-thermal.jsonl')) throw new Error('ENOSPC'); append(path, text); };
  assert.match((await launch(queue([job('a', { thermalSampleSeconds: 5 })]), d)).reason ?? '', /a first thermal sample: thermal sample write failed: Error: ENOSPC/);
  assert.equal(w.spawned.length, 0);
});

test('the preflight alone needs /proc/stat counters: a preflight-only read failure stops before the spawn', async () => {
  const w = world({ freqs: [3_000_000, 3_000_000] });
  const d = deps(w);
  let n = 0;
  const thermal = d.platform.thermal;
  d.platform = { ...d.platform, thermal: now => { const s = thermal(now)!; return ++n === 1 ? { ...s, procStat: null } : s; } };
  const r = await launch(queue([job('a', { thermalSampleSeconds: 5 })]), d);
  assert.match(r.reason ?? '', /\/proc\/stat unreadable/);
  assert.doesNotMatch(r.reason ?? '', /first thermal sample/);
  assert.deepEqual([n, w.spawned.length, w.everyMs, w.files.has('/runs/HOST-BUSY')], [1, 0, [], false]);
});

test('the first recorded sample needs /proc/stat counters too, even after a passed preflight', async () => {
  const cases: [(number[] | null)[] | null, RegExp][] = [
    [null, /a first thermal sample: \/proc\/stat unreadable; job not started/],
    [[[1, 0, 0, 1, 0, 0, 0, 0], null], /a first thermal sample: \/proc\/stat counters unreadable on CPU 1; job not started/],
  ];
  for (const [procStat, pattern] of cases) {
    const w = world({ freqs: [3_000_000, 3_000_000] });
    const d = deps(w);
    let n = 0;
    const thermal = d.platform.thermal;
    d.platform = { ...d.platform, thermal: now => { const s = thermal(now)!; return ++n === 2 ? { ...s, procStat } : s; } };
    const r = await launch(queue([job('a', { thermalSampleSeconds: 5 })]), d);
    assert.match(r.reason ?? '', pattern);
    assert.deepEqual([w.spawned.length, w.everyMs, w.files.has('/runs/HOST-BUSY')], [0, [], false]);
  }
});

test('on a signal the stop escalates to SIGKILL on its own timer, even while the child has not exited', { timeout: 10_000 }, async () => {
  // The child exits only on SIGKILL; it stays alive until then.
  const w = world({ signal: { at: 'job' }, exitsOn: 'SIGKILL', exits: [137], alive: s => !s.includes('SIGKILL') });
  const r = await launch(queue([job('a'), job('b')]), deps(w));
  assert.match(r.reason ?? '', /SIGTERM during a/);
  assert.deepEqual([w.signals, w.spawned.length, w.busyAtExit, w.files.has('/runs/HOST-BUSY')], [['SIGTERM', 'SIGKILL'], 1, [true], false]);
  assert.match(chain(w), /process group alive 30 s after SIGTERM; SIGKILL/);
  // A child that survives SIGKILL and never reports an exit: the launcher still ends, HOST-BUSY kept.
  const stuck = world({ signal: { at: 'job' }, exitsOn: 'none', alive: () => true });
  const s = await launch(queue([job('a')]), deps(stuck));
  assert.equal(s.outcome, 'stop');
  assert.deepEqual([s.jobs, stuck.files.has('/runs/HOST-BUSY')], [[{ name: 'a', exit: null }], true]);
  assert.equal(JSON.parse(stuck.files.get('/runs/chain/session.json') ?? '{}').hostBusy, 'kept');
});

test('a container left without a matching workloadLabel keeps HOST-BUSY; a Docker job without a label is refused', async () => {
  for (const extra of [{}, { workloadLabel: 'io.fukulow.probe=519' }]) {
    const w = world({ psAll: ['old1 exited\n'] });
    const d = deps(w);
    const spawn = d.spawn;
    d.spawn = (argv, opts) => { w.psAll = ['old1 exited\nc1 running\n']; return spawn(argv, opts); }; // the job starts a container that outlives it
    const r = await launch(queue([job('a', extra), job('b')]), d);
    assert.match(r.reason ?? '', /HOST-BUSY kept: containers not live at the claim were live after the job: c1 running/, JSON.stringify(extra));
    assert.match(chain(w), /STOP: a workload still running: containers not live at the claim were live/);
    assert.deepEqual([w.spawned.length, w.files.has('/runs/HOST-BUSY')], [1, true]);
    assert.match(JSON.parse(w.files.get('/runs/chain/session.json') ?? '{}').workloadProblems.join(), /c1 running/);
  }
  assert.throws(() => queue([job('a', { image: 'postgres:18.6' })]), /a job with an image needs its workloadLabel/);
  assert.equal(queue([job('a', { image: 'postgres:18.6', workloadLabel: 'io.fukulow.probe=519-final' })]).jobs.length, 1);
});

test('a container whose start was in flight when the job died keeps HOST-BUSY, even if it appears seconds later', async () => {
  // Docker is clean at the first polls after the job; the container appears (created, then running) later.
  const w = world({ psAll: ['old1 exited\n'] });
  const d = deps(w);
  const spawn = d.spawn;
  d.spawn = (argv, opts) => { w.psAll = ['', '', '', '', 'late1 created\n', 'late1 running\n']; return spawn(argv, opts); };
  const r = await launch(queue([job('a', { workloadLabel: 'io.fukulow.probe=519-final' })]), d);
  assert.match(r.reason ?? '', /containers not live at the claim were live after the job: late1 running/);
  assert.equal(w.files.has('/runs/HOST-BUSY'), true);
  // A container of the job that is only being removed, and gone before the settle ends, is not a workload.
  const removing = world({ psAll: [''] });
  const d2 = deps(removing);
  const spawn2 = d2.spawn;
  d2.spawn = (argv, opts) => { removing.psAll = ['x1 removing\n', 'x1 removing\n', '']; return spawn2(argv, opts); };
  assert.equal((await launch(queue([job('a')]), d2)).outcome, 'done');
  assert.equal(removing.files.has('/runs/HOST-BUSY'), false);
  // One still present at the end of the settle, or a failed listing, keeps HOST-BUSY.
  const stays = world();
  const d3 = deps(stays);
  const spawn3 = d3.spawn;
  d3.spawn = (argv, opts) => { stays.psAll = ['x1 removing\n']; return spawn3(argv, opts); };
  assert.match((await launch(queue([job('a')]), d3)).reason ?? '', /containers created since the claim still present: x1 removing/);
  assert.equal(stays.files.has('/runs/HOST-BUSY'), true);
});

// Runs one job whose start sets the `docker ps -a` answers to `after`; `claim` is the answer at the claim.
async function dockerCase(claim: string, after: string[], over: Partial<World> = {}) {
  const w = world({ psAll: [claim], ...over });
  const d = deps(w);
  const spawn = d.spawn;
  d.spawn = (argv, opts) => { w.psAll = after; return spawn(argv, opts); };
  const r = await launch(queue([job('a', { workloadLabel: 'io.fukulow.probe=519-final' })]), d);
  return { r, w, released: !w.files.has('/runs/HOST-BUSY'), session: JSON.parse(w.files.get('/runs/chain/session.json') ?? '{}') };
}

test('release compares the live containers at the claim with those after the job (#875 option A)', async () => {
  // Created only at the claim, never run, then running after the job: the job started it.
  const created = await dockerCase('old1 created\n', ['old1 running\n']);
  assert.deepEqual([created.r.outcome, created.released], ['stop', false]);
  assert.match(created.r.reason ?? '', /containers not live at the claim were live after the job: old1 running/);
  // Restart: a container stopped at the claim and started by the job keeps HOST-BUSY, also when the
  // start finishes after the client died (exited at the first polls, running later).
  for (const after of [['old1 running\n'], ['old1 exited\n', 'old1 exited\n', 'old1 exited\n', 'old1 restarting\n', 'old1 running\n'], ['old1 paused\n']]) {
    const c = await dockerCase('old1 exited\n', after);
    assert.deepEqual([c.r.outcome, c.released, c.session.hostBusy], ['stop', false, 'kept'], after.join('|'));
    assert.match(c.r.reason ?? '', /containers not live at the claim were live after the job: old1 (running|restarting|paused)/);
  }
  // Start: a new container that is still running keeps it.
  const started = await dockerCase('old1 exited\n', ['old1 exited\nnew1 running\n']);
  assert.deepEqual([started.released, started.session.workloadProblems.join()], [false, 'containers not live at the claim were live after the job: new1 running']);
  // Stop: the job's container exited and the old one still stopped release it; so does one that was
  // already running at the claim and still is, or has stopped since. (One live at the claim that the
  // job stopped and started again looks the same; the preflight refuses a job while any runs.)
  for (const [claim, after] of [['old1 exited\n', 'old1 exited\nnew1 exited\n'], ['old1 running\n', 'old1 running\n'], ['old1 running\n', 'old1 exited\n'], ['', '']]) {
    const c = await dockerCase(claim, [after]);
    assert.deepEqual([c.r.outcome, c.released, c.session.hostBusy], ['done', true, 'released'], `${claim}->${after}`);
  }
});

const entry = (id: string, message: unknown) => JSON.stringify({ SYSLOG_IDENTIFIER: id, MESSAGE: message, __CURSOR: 'c' });

test('journal clock events: steps, detected jumps, clock changes and clock commands count; other entries do not', () => {
  const events = [entry('chronyd', 'System clock was stepped by -0.900000 seconds'), entry('chronyd', 'System clock wrong by 1.2 seconds'),
    entry('chronyd', 'Backward time jump detected!'), entry('systemd', 'Time has been changed'), entry('systemd-timedated', 'Changed local time to Tue 2026-11-24'),
    entry('sudo', 'tomoya : TTY=pts/0 ; PWD=/home/tomoya ; USER=root ; COMMAND=/usr/bin/date -s 12:00'), entry('sudo', 'tomoya : USER=root ; COMMAND=/usr/bin/timedatectl set-time 12:00')];
  assert.equal(clockEvents(events.join('\n')).events.length, events.length);
  const quiet = [entry('chronyd', 'Selected source 185.125.190.122'), entry('systemd-logind', 'Time has been changed'), entry('sudo', 'tomoya : COMMAND=/usr/bin/docker ps'), entry('kernel', 'x')];
  assert.deepEqual(clockEvents(quiet.join('\n')), { events: [], unparsed: 0 });
  // A torn line or a binary MESSAGE cannot be matched, so it is reported, never skipped silently.
  assert.deepEqual(clockEvents(`{"MESSAGE":\n${entry('chronyd', [83, 121])}\n`), { events: [], unparsed: 2 });
});

test('a thermal job records the journal clock events after its cursor; an unreadable cursor starts nothing', async () => {
  const w = world({ journalCursor: 's=ab;i=7', journal: [entry('chronyd', 'Selected source x'), entry('chronyd', 'System clock was stepped by 0.9 seconds')].join('\n') });
  const r = await launch(queue([job('a', { thermalSampleSeconds: 5 })]), deps(w));
  assert.equal(r.outcome, 'done');
  const rec = JSON.parse(w.files.get('/runs/chain/a-clock-events.json') ?? '{}');
  assert.deepEqual([rec.cursor, rec.ok, rec.events, typeof rec.launchSession], ['s=ab;i=7', true, ['chronyd: System clock was stepped by 0.9 seconds'], 'string']);
  const failing = world({ journalFails: true });
  await launch(queue([job('a', { thermalSampleSeconds: 5 })]), deps(failing));
  assert.deepEqual(JSON.parse(failing.files.get('/runs/chain/a-clock-events.json') ?? '{}').ok, false);
  const noCursor = world({ journalCursor: null });
  const n = await launch(queue([job('a', { thermalSampleSeconds: 5 })]), deps(noCursor));
  assert.deepEqual([n.outcome, n.reason, noCursor.spawned.length], ['stop', 'a: journal cursor unreadable (clock check); job not started', 0]);
  // A job without thermal sampling does not touch the journal.
  const plain = world({ journalCursor: null });
  assert.equal((await launch(queue([job('a')]), deps(plain))).outcome, 'done');
});

test('a failed Docker listing at the claim starts nothing; one at the release keeps HOST-BUSY', async () => {
  const w = world();
  const d = deps(w);
  const exec = d.exec;
  d.exec = (argv, cwd) => (argv.join(' ').startsWith('docker ps -a --format') ? { status: 1, stdout: '' } : exec(argv, cwd));
  const r = await launch(queue([job('a')]), d);
  assert.deepEqual([r.outcome, r.reason, w.spawned.length, w.files.has('/runs/HOST-BUSY')], ['stop', 'docker ps -a failed; no container snapshot, nothing started', 0, false]);
  const late = world({ psAll: [''] });
  const d2 = deps(late);
  const exec2 = d2.exec;
  let failing = false;
  d2.exec = (argv, cwd) => (failing && argv.join(' ').startsWith('docker ps -a --format') ? { status: null, stdout: '' } : exec2(argv, cwd));
  const spawn2 = d2.spawn;
  d2.spawn = (argv, opts) => { failing = true; return spawn2(argv, opts); };
  const r2 = await launch(queue([job('a')]), d2);
  assert.deepEqual([r2.outcome, late.files.has('/runs/HOST-BUSY')], ['stop', true]);
  assert.match(r2.reason ?? '', /HOST-BUSY kept: docker ps -a failed/);
});

test('the sampler period actually used and each tick\'s monotonic time are recorded', async () => {
  const w = world();
  const r = await launch(queue([job('a', { thermalSampleSeconds: 5 }), job('b')]), deps(w));
  assert.equal(r.outcome, 'done');
  const session = JSON.parse(w.files.get('/runs/chain/session.json') ?? '{}');
  assert.deepEqual(session.jobs.map((j: { thermalSampleSeconds?: number }) => j.thermalSampleSeconds), [5, undefined]);
  const lines = files(w, '-thermal.jsonl')[0].trim().split('\n').map(l => JSON.parse(l));
  assert.ok(lines.length === 2 && lines.every(l => l.monoMs === Date.parse(l.at))); // the fake monotonic clock runs with the wall clock
});

test('fixedRate keeps ticks on k x period: lateness does not add up, a passed target is skipped', () => {
  let now = 0;
  const timers: { f: () => void; at: number }[] = [];
  const ticks: number[] = [];
  const stop = fixedRate(5000, () => ticks.push(now), { mono: () => now, setTimeout: (f, ms) => { timers.push({ f, at: now + ms }); return timers.length; }, clearTimeout: () => {} });
  const fire = (lateMs: number) => { const t = timers.shift()!; now = t.at + lateMs; t.f(); };
  fire(300); fire(300); fire(0); fire(6000); fire(0);
  assert.deepEqual(ticks, [5300, 10_300, 15_000, 26_000, 30_000]); // the 25 s target was passed while blocked
  stop();
  const pending = timers.shift()!;
  now = pending.at;
  pending.f();
  assert.equal(ticks.length, 5);
});

test('a signal during a later job stops only that job; a job that already exited is never signalled', async () => {
  const w = world({ exits: [0, 143] });
  const d = deps(w);
  let handler: ((s: string) => void) | undefined;
  d.onSignal = h => { handler = h; };
  const perChild: string[][] = [];
  const spawn = d.spawn;
  d.spawn = (argv, opts) => {
    const c = spawn(argv, opts);
    const mine: string[] = [];
    perChild.push(mine);
    if (perChild.length === 2) queueMicrotask(() => handler?.('SIGTERM'));
    return { ...c, kill: (signal?: 'SIGTERM' | 'SIGKILL') => { mine.push(signal ?? 'SIGTERM'); c.kill(signal); } };
  };
  const r = await launch(queue(), d);
  assert.equal(r.outcome, 'stop');
  // Job a exited 0 before b started; the abort during b must not reach a's (possibly reused) process group.
  assert.deepEqual(perChild, [[], ['SIGTERM']]);
});

test('each gate and job is told the HOST-BUSY this queue holds and its own name', async () => {
  const w = world({ exits: [0, 0, 0] });
  await launch(queue([job('a', { gate: ['node', 'gate.ts'], env: { X: '1' } }), job('b')]), deps(w));
  assert.deepEqual(w.envs, [
    { X: '1', FUKULOW_HOST_BUSY: '/runs/HOST-BUSY', FUKULOW_LAUNCH_JOB: 'a', FUKULOW_LAUNCH_SESSION: 'sess-1', FUKULOW_LAUNCH_GATE_LOG: '/runs/chain/a-gate.log' },
    { X: '1', FUKULOW_HOST_BUSY: '/runs/HOST-BUSY', FUKULOW_LAUNCH_JOB: 'a', FUKULOW_LAUNCH_SESSION: 'sess-1', FUKULOW_LAUNCH_GATE_LOG: '/runs/chain/a-gate.log' },
    { FUKULOW_HOST_BUSY: '/runs/HOST-BUSY', FUKULOW_LAUNCH_JOB: 'b', FUKULOW_LAUNCH_SESSION: 'sess-1' },
  ]);
});
