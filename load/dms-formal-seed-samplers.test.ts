import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from './dms-formal-exec.ts';
import { batchSummaryFailures, kernelFiles, killLoop, kernelLoop, loopCpuSeconds, parseKernelSamples, parsePostgresSamples, postgresLoop, seedBatchSummary,
  seedShape, snapshotSql, snapshotsPerSession, startSeedSamplers, stopFile, stopTiming, summarizeSamplers } from './dms-formal-seed-samplers.ts';

const self = '77 (sh) S 0 77 77 0 -1 4194560 100 0 0 0 30 20 140 60 20 0 1 0 100 4000000 200';
const snapshot = (atMs: number) => JSON.stringify({ atMs, checkpointer: {}, bgwriter: {}, wal: {}, io: [], waitEvents: [], vacuum: [] });
// One complete psql session: its child marker, snapshotsPerSession timed samples and a zero exit.
const session = (child: number, firstAtMs: number, count = snapshotsPerSession) =>
  ['--- child ' + child, ...Array.from({ length: count }, (_, i) => [snapshot(firstAtMs + i * 1000), 'Time: 1.0 ms']).flat(), '--- psql-exit 0'];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'seed-samplers-')); mkdirSync(join(dir, 'raw')); mkdirSync(join(dir, 'out')); return dir; };
const frame = (atS: string, skip: string[] = [], failed?: string) => [
  '=== ' + atS, '--- self ' + self,
  ...skip.map(file => '--- missing ' + file),
  ...kernelFiles.filter(file => !skip.includes(file)).flatMap(file => ['==> ' + file + ' <==', 'nr_dirty 12', '']),
  ...(failed ? [`tail: error reading '${failed}': Input/output error`] : []),
];

test('kernel loop reads every listed file once a second and marks missing files', () => {
  assert.match(kernelLoop, /while \[ ! -e "\$stop" \]/);
  assert.match(kernelLoop, /--- missing \$f/);
  assert.match(kernelLoop, /--- unreadable \$f/, 'an unreadable file is a failure, not missing');
  assert.match(kernelLoop, /--- pid \$\$/);
  assert.doesNotMatch(kernelLoop, /exit 0/, 'a write failure is a nonzero exit');
  assert.match(kernelLoop, /tail -v -n \+1/);
  assert.match(kernelLoop, /sleep 1/);
  assert.doesNotMatch(kernelLoop, /docker|psql/);
  for (const file of ['/proc/diskstats', '/proc/pressure/io', '/proc/pressure/memory', '/proc/pressure/cpu', '/proc/meminfo', '/proc/vmstat',
    '/sys/fs/cgroup/memory.stat', '/sys/fs/cgroup/memory.events', '/sys/fs/cgroup/io.stat', '/sys/fs/cgroup/io.pressure', '/sys/fs/cgroup/cpu.stat']) {
    assert.ok(kernelFiles.includes(file as never), file);
  }
});

test('kernel samples: missing files are counted as missing, read errors as failed, gaps listed', () => {
  const raw = ['--- clk_tck 100', ...frame('1000.000000000'), ...frame('1001.000000000', ['/proc/pressure/io']),
    ...frame('1013.500000000', [], '/proc/vmstat'), '--- self ' + self, '--- stopped'].join('\n');
  const coverage = parseKernelSamples(raw);
  assert.equal(coverage.samples, 3);
  assert.deepEqual([coverage.firstAtMs, coverage.lastAtMs, coverage.maxGapMs], [1_000_000, 1_013_500, 12_500]);
  assert.deepEqual(coverage.gaps, [{ afterAtMs: 1_001_000, gapMs: 12_500 }]);
  assert.deepEqual(coverage.missing, { '/proc/pressure/io': 1 });
  assert.deepEqual(coverage.failed, { '/proc/vmstat': 1 });
  assert.equal(coverage.stopped, true);
  assert.equal(coverage.loopCpuSeconds, 2.5);
  const truncated = parseKernelSamples(['=== 5.0', '--- self ' + self, '==> /proc/diskstats <=='].join('\n'));
  assert.equal(truncated.failed['/proc/vmstat'], 1, 'a cut-off frame marks its unread files failed');
  assert.equal(truncated.loopCpuSeconds, null, 'no clock tick rate means no CPU figure, not a guess');
});

test('loop CPU uses utime, stime and reaped children from /proc stat, even with spaces in the command name', () => {
  assert.equal(loopCpuSeconds('9 (a b) S 1 9 9 0 -1 0 0 0 0 0 100 100 50 50 20', 100), 3);
  assert.equal(loopCpuSeconds(undefined, 100), null);
  assert.equal(loopCpuSeconds('9 (sh) S 1', 100), null);
  assert.equal(loopCpuSeconds('9 sh S 1 9 9 0 -1 0 0 0 0 0 100 100 50 50 20', 100), null, 'no command name parentheses');
});

test('PostgreSQL loop: one session repeats the statistics snapshot, timed, with a server-side timeout', () => {
  assert.equal(snapshotsPerSession, 3);
  assert.match(postgresLoop, /\\watch i=1 c=3'/, 'one session (2 s connect + 3 x 2 s timeout + 2 x 1 s) fits the 15 s grace');
  assert.match(postgresLoop, /--- child \$child/);
  assert.equal(postgresLoop.match(/--- self/g)?.length, 2, 'CPU is printed after every session and at the end');
  assert.match(postgresLoop, /\\timing on/);
  assert.match(postgresLoop, /--- psql-exit \$code/);
  for (const view of ['checkpointer', 'bgwriter', 'wal', 'io', 'activity', 'progress_vacuum']) assert.match(snapshotSql, new RegExp('FROM pg_stat_' + view + '\\b'));
  assert.match(snapshotSql, /'atMs', round\(extract\(epoch FROM clock_timestamp\(\)\)/);
  assert.match(snapshotSql, /::text$/, 'jsonb text is one line per sample');
  assert.doesNotMatch(snapshotSql, /\b(query|query_id|usename)\b/);
});

test('PostgreSQL samples: failed sessions and error text are counted, never kept as text', () => {
  const sample = (atMs: number) => JSON.stringify({ atMs, checkpointer: {}, bgwriter: {}, wal: {}, io: [], waitEvents: [], vacuum: [] });
  const raw = ['--- clk_tck 100', '--- child 5', sample(1000), 'Time: 3.500 ms', sample(2000), 'Time: 4.000 ms', sample(3000), 'Time: 1.000 ms', '--- psql-exit 0',
    '--- child 6', 'ERROR:  canceling statement due to statement timeout', '--- psql-exit 1', '--- child 7', sample(7000), 'Time: 1.000 ms', '',
    sample(8000), 'Time: 1.000 ms', sample(9000), 'Time: 1.000 ms', '--- psql-exit 0', '--- self ' + self, '--- stopped'].join('\n');
  const coverage = parsePostgresSamples(raw);
  assert.deepEqual({ ...coverage, gaps: undefined }, {
    samples: 6, firstAtMs: 1000, lastAtMs: 9000, maxGapMs: 4000, gaps: undefined, gapsTruncated: false,
    sessions: 3, failedSessions: 1, unterminatedSessions: 0, shortSessions: 0, untimedSamples: 0, unexpectedLines: 1, stopped: true, queryMs: { count: 6, total: 11.5, max: 4 }, loopCpuSeconds: 2.5,
  });
  assert.deepEqual(coverage.gaps, [{ afterAtMs: 3000, gapMs: 4000 }]);
  assert.doesNotMatch(JSON.stringify(coverage), /canceling/);
  const kernelOk = parseKernelSamples(['--- clk_tck 100', ...frame('1.0'), '--- stopped'].join('\n'));
  const record = summarizeSamplers(kernelOk, 'stopped', coverage, 'stopped', 3);
  assert.deepEqual(record.failures, ['postgres: failed psql sessions', 'postgres: unexpected output']);
  assert.deepEqual(summarizeSamplers(null, 'exited-early', null, 'aborted', 2).failures,
    ['kernel: no samples', 'kernel: exited-early', 'postgres: no samples', 'postgres: aborted']);
  const postgresOk = parsePostgresSamples(['--- clk_tck 100', '--- child 5', sample(1), 'Time: 1234.567 ms (00:01.235)', sample(2), 'Time: 1.0 ms', sample(3), 'Time: 1.0 ms', '--- psql-exit 0', '--- self ' + self, '--- stopped'].join('\n'));
  assert.deepEqual(postgresOk.queryMs, { count: 3, total: 1236.567, max: 1234.567 }, 'timing from one second on');
  const missing = summarizeSamplers(parseKernelSamples(['--- clk_tck 100', ...frame('1.0', ['/proc/pressure/cpu']), '--- stopped'].join('\n')), 'stopped', postgresOk, 'stopped', 3);
  assert.deepEqual([missing.failures, missing.missing], [[], ['kernel: /proc/pressure/cpu']]);
});

test('incomplete sampler output is a collection failure, never complete', () => {
  const sample = (atMs: number) => JSON.stringify({ atMs, checkpointer: {}, wal: {}, io: [] });
  const kernel = (lines: string[]) => parseKernelSamples(['--- clk_tck 100', ...lines].join('\n'));
  const postgres = (lines: string[]) => parsePostgresSamples(['--- clk_tck 100', ...lines].join('\n'));
  const kernelOk = kernel([...frame('1.0'), '--- stopped']);
  const postgresOk = postgres([...session(5, 1), '--- self ' + self, '--- stopped']);
  const failures = (k = kernelOk, p = postgresOk) => summarizeSamplers(k, 'stopped', p, 'stopped', 3).failures;
  assert.deepEqual(failures(), []);
  assert.deepEqual(failures(kernel([...frame('1.0'), '--- tail-exit 1', '--- stopped'])), ['kernel: tail failed'], 'tail-exit with every header present');
  assert.deepEqual(failures(kernel(frame('1.0'))), ['kernel: no stop marker']);
  assert.deepEqual(failures(kernel(['=== 1.0', ...kernelFiles.flatMap(file => ['==> ' + file + ' <==']), '--- stopped'])), ['kernel: loop CPU missing']);
  const unreadable = kernel([...frame('1.0').filter(line => line !== '==> /proc/vmstat <=='), '--- unreadable /proc/vmstat', '--- stopped']);
  assert.deepEqual([unreadable.missing, failures(unreadable)], [{}, ['kernel: read failed /proc/vmstat']], 'unreadable is failed, not missing');
  assert.deepEqual(failures(kernelOk, postgres([...session(5, 1), '--- self ' + self])), ['postgres: no stop marker']);
  assert.deepEqual(failures(kernelOk, postgres([...session(5, 1).filter((line, i) => i !== 2), '--- self ' + self, '--- stopped'])), ['postgres: sample timing missing']);
  assert.deepEqual(failures(kernelOk, postgres(['--- child 5', sample(1), 'Time: 1.0 ms', '--- self ' + self, '--- stopped'])),
    ['postgres: no session footer', 'postgres: session cut off']);
  assert.deepEqual(failures(kernelOk, postgres([...session(5, 1), '--- child 6', sample(4000), 'Time: 1.0 ms', '--- self ' + self, '--- stopped'])),
    ['postgres: session cut off']);
  assert.deepEqual(failures(kernelOk, postgres([...session(5, 1), '--- stopped'])), ['postgres: loop CPU missing']);
  assert.deepEqual(summarizeSamplers(kernelOk, 'stopped', postgresOk, 'stopped', 3, 'failed').failures, ['kernel: stop command failed', 'postgres: stop command failed']);
  assert.deepEqual(summarizeSamplers(kernelOk, 'stopped', postgresOk, 'aborted', 4, 'ok', { kernel: 'not-needed', postgres: 'unverified' }).failures,
    ['postgres: in-container loop not verified stopped', 'postgres: aborted']);
});

test('every zero-exit PostgreSQL session must print its snapshotsPerSession samples, or the shortfall is a failure', () => {
  const postgres = (lines: string[]) => parsePostgresSamples(['--- clk_tck 100', ...lines, '--- self ' + self, '--- stopped'].join('\n'));
  const kernelOk = parseKernelSamples(['--- clk_tck 100', ...frame('1.0'), '--- stopped'].join('\n'));
  const failures = (lines: string[]) => summarizeSamplers(kernelOk, 'stopped', postgres(lines), 'stopped', 3).failures;
  assert.deepEqual(failures([...session(5, 1), ...session(6, 4000)]), []);
  // One full session, then a session that exits 0 with no snapshot at all: the sample count alone cannot show it.
  const empty = postgres([...session(5, 1), '--- child 6', '--- psql-exit 0']);
  assert.deepEqual([empty.samples, empty.sessions, empty.shortSessions], [3, 2, 1]);
  assert.deepEqual(failures([...session(5, 1), '--- child 6', '--- psql-exit 0']), ['postgres: 1 sessions without 3 snapshots']);
  assert.deepEqual(failures([...session(5, 1), ...session(6, 4000, 2)]), ['postgres: 1 sessions without 3 snapshots']);
  assert.deepEqual(failures([...session(5, 1, 4)]), ['postgres: 1 sessions without 3 snapshots'], 'more than asked is also not the expected session');
});

test('in-container kill names only loop shells and psql and fails if one is still running', () => {
  assert.match(killLoop, /\[ "\$c" = sh \] \|\| \[ "\$c" = psql \]/, 'a reused PID that is a PostgreSQL backend is never killed');
  assert.match(killLoop, /kill -KILL/);
  assert.match(killLoop, /--- alive \$p"; exit 1/);
});

test('samplers use two long-lived docker execs plus one stop exec, then parse what the loops wrote', async () => {
  const dir = scratch();
  const commands: Command[] = [];
  let release: () => void = () => {};
  const stopped = new Promise<void>(resolve => { release = resolve; });
  const exec = async (command: Command) => {
    commands.push(command);
    if (command.args.includes('touch')) { release(); return { code: 0, stdout: '' }; }
    const script = command.args[command.args.indexOf('-c') + 1];
    // A Docker CLI error can name the per-user socket and password-like settings; the saved file is redacted.
    writeFileSync(command.log!, script === postgresLoop
      ? ['--- pid 40', '--- clk_tck 100', ...session(41, 1), '--- self ' + self, '--- stopped'].join('\n')
      : ['--- pid 30', '--- clk_tck 100', ...frame('1.0'), 'POSTGRES_PASSWORD=pw123', '--- self ' + self, '--- stopped'].join('\n'));
    await stopped;
    return { code: 0, stdout: '' };
  };
  const stop = startSeedSamplers(exec, 'stub-db', { kernel: join(dir, 'out', 'k.txt'), postgres: join(dir, 'out', 'p.txt') }, join(dir, 'raw'), text => text.replaceAll('pw123', '[redacted]'));
  const record = await stop();
  assert.equal(commands.length, 3);
  assert.deepEqual(commands.slice(0, 2).map(command => command.log), [join(dir, 'raw', 'k.txt.raw'), join(dir, 'raw', 'p.txt.raw')], 'raw output is written outside the artifact directory');
  assert.match(readFileSync(join(dir, 'out', 'k.txt'), 'utf8'), /POSTGRES_PASSWORD=\[redacted\]/);
  assert.deepEqual([readdirSync(join(dir, 'out')).sort(), readdirSync(join(dir, 'raw'))], [['k.txt', 'p.txt'], []], 'no unredacted copy is left');
  assert.equal(record.dockerExecs, 3);
  assert.deepEqual(commands[0]!.args.slice(0, 5), ['exec', 'stub-db', 'sh', '-c', kernelLoop]);
  assert.deepEqual(commands[0]!.args.slice(6), [stopFile, ...kernelFiles]);
  assert.deepEqual(commands[1]!.args.slice(0, 9), ['exec', '-e', 'PGOPTIONS=-c statement_timeout=2000', '-e', 'PGCONNECT_TIMEOUT=2', 'stub-db', 'sh', '-c', postgresLoop]);
  assert.deepEqual(commands[2]!.args, ['exec', 'stub-db', 'touch', stopFile]);
  assert.deepEqual([record.kernelOutcome, record.postgresOutcome, record.failures, record.missing], ['stopped', 'stopped', [], []]);
  assert.equal(record.kernel?.samples, 1);
  assert.equal(record.postgres?.queryMs?.total, 3);
});

test('a failed redacted write leaves no raw sampler output anywhere', async () => {
  const dir = scratch();
  let release: () => void = () => {};
  const stopped = new Promise<void>(resolve => { release = resolve; });
  const exec = async (command: Command) => {
    if (command.args.includes('touch')) { release(); return { code: 0, stdout: '' }; }
    writeFileSync(command.log!, ['--- pid 30', 'Cannot connect at unix:///Users/someone/.docker/run/docker.sock POSTGRES_PASSWORD=pw123'].join('\n'));
    writeFileSync(command.log! + '-retention.json', '{}');
    await stopped;
    return { code: 0, stdout: '' };
  };
  // A directory in the way of each redacted file makes both final writes fail (EISDIR).
  mkdirSync(join(dir, 'out', 'k.txt'));
  mkdirSync(join(dir, 'out', 'p.txt'));
  const record = await startSeedSamplers(exec, 'stub-db', { kernel: join(dir, 'out', 'k.txt'), postgres: join(dir, 'out', 'p.txt') }, join(dir, 'raw'))();
  assert.ok(record.failures.includes('kernel: redacted file not saved') && record.failures.includes('postgres: redacted file not saved'));
  assert.deepEqual(readdirSync(join(dir, 'raw')), [], 'raw output and its retention record are removed');
  assert.deepEqual(readdirSync(join(dir, 'out')).sort(), ['k.txt', 'p.txt'], 'nothing unredacted in the artifact directory');
  assert.deepEqual([readdirSync(join(dir, 'out', 'k.txt')), readdirSync(join(dir, 'out', 'p.txt'))], [[], []]);
});

test('raw sampler output that cannot be removed from the private scratch is a collection failure', { skip: process.getuid?.() === 0 }, async () => {
  const dir = scratch();
  let release: () => void = () => {};
  const stopped = new Promise<void>(resolve => { release = resolve; });
  const exec = async (command: Command) => {
    if (command.args.includes('touch')) { release(); return { code: 0, stdout: '' }; }
    const script = command.args[command.args.indexOf('-c') + 1];
    writeFileSync(command.log!, script === postgresLoop
      ? ['--- pid 40', '--- clk_tck 100', ...session(41, 1), '--- self ' + self, '--- stopped'].join('\n')
      : ['--- pid 30', '--- clk_tck 100', ...frame('1.0'), '--- self ' + self, '--- stopped'].join('\n'));
    await stopped;
    return { code: 0, stdout: '' };
  };
  const stop = startSeedSamplers(exec, 'stub-db', { kernel: join(dir, 'out', 'k.txt'), postgres: join(dir, 'out', 'p.txt') }, join(dir, 'raw'));
  await new Promise(resolve => setTimeout(resolve, 5));
  // The scratch directory refuses deletion (EACCES); the redacted copies are written elsewhere and succeed.
  chmodSync(join(dir, 'raw'), 0o500);
  try {
    const record = await stop();
    assert.ok(record.failures.includes('kernel: raw output not removed from the private scratch'), record.failures.join('; '));
    assert.ok(record.failures.includes('postgres: raw output not removed from the private scratch'));
    assert.ok(existsSync(join(dir, 'out', 'k.txt')) && existsSync(join(dir, 'out', 'p.txt')));
  } finally { chmodSync(join(dir, 'raw'), 0o700); }
});

test('a loop that died before stop, or that ignores the stop file, is a recorded collection failure', async () => {
  const dir = scratch();
  const kills: string[][] = [];
  const exec = async (command: Command) => {
    if (command.args.includes('touch')) return { code: 0, stdout: '' };
    if (command.args.includes(killLoop)) { kills.push(command.args.slice(command.args.indexOf('fukulow-kill') + 1)); return { code: 0, stdout: '' }; }
    if (command.args.includes(kernelLoop)) return { code: 1, stdout: '' };
    writeFileSync(command.log!, ['--- pid 40', '--- clk_tck 100', '--- child 41', '--- psql-exit 0', '--- child 42', ''].join('\n'));
    await new Promise<void>(resolve => command.signal!.addEventListener('abort', () => resolve()));
    throw new Error('aborted');
  };
  const stop = startSeedSamplers(exec, 'stub-db', { kernel: join(dir, 'out', 'k.txt'), postgres: join(dir, 'out', 'p.txt') }, join(dir, 'raw'), undefined, 20);
  await new Promise(resolve => setTimeout(resolve, 5));
  const record = await stop();
  // The kernel loop printed no PID, so it was never killed or checked: unverified, even though the kill exec succeeded.
  assert.deepEqual([record.kernelOutcome, record.postgresOutcome, record.inContainerKill], ['exited-early', 'aborted', { kernel: 'unverified', postgres: 'killed' }]);
  assert.deepEqual(kills, [['40', '42']], 'the in-container loop shell and its current psql are killed by PID');
  assert.ok(record.failures.includes('kernel: in-container loop not verified stopped'));
  assert.ok(!record.failures.includes('postgres: in-container loop not verified stopped'));
  assert.equal(record.kernel, null, 'no output file is no data, not zero counts');
  assert.ok(record.failures.includes('kernel: exited-early') && record.failures.includes('postgres: aborted'));
  assert.ok(record.failures.includes('kernel: redacted file not saved'));
});

test('a failed stop command skips the grace, kills the loops and fails if the kill is not verified', async () => {
  const dir = scratch();
  let killed = 0;
  const exec = async (command: Command) => {
    if (command.args.includes('touch')) return { code: 1, stdout: '' };
    if (command.args.includes(killLoop)) { killed++; return { code: 1, stdout: '' }; }
    writeFileSync(command.log!, '--- pid 30\n');
    await new Promise<void>(resolve => command.signal!.addEventListener('abort', () => resolve()));
    return { code: 137, stdout: '' };
  };
  const started = Date.now();
  const record = await startSeedSamplers(exec, 'stub-db', { kernel: join(dir, 'out', 'k.txt'), postgres: join(dir, 'out', 'p.txt') }, join(dir, 'raw'), undefined, 60_000)();
  assert.ok(Date.now() - started < 5_000, 'no 60 s grace without a stop file');
  assert.deepEqual([record.stopCommand, record.inContainerKill, killed, record.dockerExecs], ['failed', { kernel: 'unverified', postgres: 'unverified' }, 1, 4]);
  assert.ok(record.failures.includes('kernel: stop command failed') && record.failures.includes('postgres: in-container loop not verified stopped'));
});

test('after an interrupt the stop is short and the kill is left to container removal, recorded as a failure', async () => {
  const dir = scratch();
  const timeouts: number[] = [];
  const exec = async (command: Command) => {
    if (command.args.includes('touch')) { timeouts.push(command.timeout!); return { code: 0, stdout: '' }; }
    assert.ok(!command.args.includes(killLoop), 'no kill exec');
    await new Promise<void>(resolve => command.signal!.addEventListener('abort', () => resolve()));
    return { code: 137, stdout: '' };
  };
  const started = Date.now();
  const record = await startSeedSamplers(exec, 'stub-db', { kernel: join(dir, 'out', 'k.txt'), postgres: join(dir, 'out', 'p.txt') }, join(dir, 'raw'), undefined, 60_000)({ hurry: AbortSignal.abort() });
  assert.ok(Date.now() - started < 4_000);
  assert.deepEqual([timeouts, record.inContainerKill], [[5_000], { kernel: 'skipped', postgres: 'skipped' }]);
  assert.ok(record.failures.includes('kernel: in-container loop left to container removal'));
});

test('an interrupt that arrives after a normal stop began shortens the grace, skips the kill and ends by untilMs', async () => {
  const dir = scratch();
  const hurry = new AbortController(), timeouts: number[] = [];
  const exec = async (command: Command) => {
    // The deadline fires while the normal stop command runs.
    if (command.args.includes('touch')) { timeouts.push(command.timeout!); hurry.abort(); return { code: 0, stdout: '' }; }
    assert.ok(!command.args.includes(killLoop), 'no kill exec once hurried');
    await new Promise<void>(resolve => command.signal!.addEventListener('abort', () => resolve()));
    return { code: 137, stdout: '' };
  };
  const started = Date.now(), untilMs = started + 1_500;
  const record = await startSeedSamplers(exec, 'stub-db', { kernel: join(dir, 'out', 'k.txt'), postgres: join(dir, 'out', 'p.txt') }, join(dir, 'raw'), undefined, 60_000)({ hurry: hurry.signal, untilMs: () => untilMs });
  assert.ok(Date.now() <= untilMs + 150, `ended ${Date.now() - untilMs} ms after untilMs; the 60 s grace and the 2 s fast grace are both cut`);
  assert.ok(timeouts.length === 1 && timeouts[0]! <= 1_500, 'the normal 10 s stop command is cut to the time left');
  assert.deepEqual([record.kernelOutcome, record.postgresOutcome, record.inContainerKill], ['aborted', 'aborted', { kernel: 'skipped', postgres: 'skipped' }]);
  // With no time left at all, not even the stop command runs.
  const none = await startSeedSamplers(async command => {
    assert.ok(!command.args.includes('touch'));
    await new Promise<void>(resolve => command.signal!.addEventListener('abort', () => resolve()));
    return { code: 137, stdout: '' };
  }, 'stub-db', { kernel: join(dir, 'out', 'k2.txt'), postgres: join(dir, 'out', 'p2.txt') }, join(dir, 'raw'))({ untilMs: () => Date.now() + stopTiming.minStepMs - 1 });
  assert.deepEqual([none.stopCommand, none.dockerExecs], ['skipped', 2]);
  assert.ok(none.failures.includes('kernel: stop command skipped'));
});

const at = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', ' UTC');
const durationLine = (ms: number, pid: number, durationMs: string) => `2026-11-22T00:00:00.000000000Z ${at(ms)} [${pid}] LOG:  duration: ${durationMs} ms`;
const clock = (startMs: number, spanMs: number, pid: number) => ({ dbClockStartMs: startMs, dbClockEndMs: startMs + spanMs, dbClockSpanMs: spanMs, dbBackendPid: pid });
// Instrumented rows, exactly as the diagnostic seed writes them.
const batch = (organization: number, batchIndex: number, durationMs: number, extra: object = { dbClock: 'missing' }, recorderMs = 0.5) =>
  ({ kind: 'batch', organization, batchIndex, durationMs, startedAtMs: 1, endedAtMs: 1 + durationMs, ...extra, recorderMs });
const organizationRow = (organization: number) => ({ kind: 'organization', organization, durationMs: 30_000, startedAtMs: 1, endedAtMs: 30_001 });
const jsonl = (rows: unknown[]) => rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n';

test('batch summary separates PostgreSQL time from docker exec/psql cost and excludes batch 0 from the medians only', () => {
  const rows = [
    batch(0, 0, 20_000, clock(1_000, 19_900, 10), 9), batch(0, 1, 900, clock(30_000, 850, 11), 0.25),
    batch(0, 2, 1_000, clock(40_000, 930, 12), 0.75), batch(0, 3, 12_000), organizationRow(0),
  ];
  // Five statements per batch inside its clock window: start clock, Message INSERT, PREPARE, EXECUTE, DEALLOCATE.
  const dbLog = [durationLine(1_000, 10, '0.050'), durationLine(15_000, 10, '1.000'), durationLine(15_001, 10, '1.000'), durationLine(20_000, 10, '19000.000'),
    durationLine(20_001, 10, '0.000'),
    durationLine(29_999, 11, '5.000'), durationLine(30_000, 11, '0.100'), durationLine(30_100, 11, '700.000'), durationLine(30_101, 11, '0.100'),
    durationLine(30_849, 11, '100.300'), durationLine(30_850, 11, '0.000'), durationLine(30_200, 99, '900.000'),
    durationLine(40_900, 12, '800.000')].join('\n');
  const { perBatch, ...summary } = seedBatchSummary(jsonl(rows), dbLog, { shape: { organizations: 1, batchesPerOrganization: 4 }, arm: 'instrumented' });
  assert.deepEqual(summary, { arm: 'instrumented', batches: 4, medianBatches: 3, malformedLines: 0, expectedRows: 5, missingRows: 0, unexpectedRows: 0,
    dbClockMissing: 1, serverMissing: 2, medianMs: 1_000, medianDbClockSpanMs: 890, medianOutsideDbClockSpanMs: 60, medianServerMs: 800.5,
    medianOutsideServerMs: 99.5, recorderMs: { median: 0.625, max: 9, total: 10.5 } });
  assert.deepEqual(perBatch.map(row => [row.batchIndex, row.serverMs, row.serverStatements]), [[0, 19002.05, 5], [1, 800.5, 5], [2, null, 1], [3, null, 0]],
    'joined by backend PID inside the clock window: the line before the window and the other PID are left out; one line is not a batch');
  assert.deepEqual(batchSummaryFailures(summary), ['seed-timing.jsonl: dbClock missing on 1 of 4 batches', 'db.log: server duration missing or incomplete on 2 of 4 batches']);
});

test('batch clock coverage includes batch 0, and malformed timing lines are failures, not dropped', () => {
  const timed = clock(1, 1, 7), shape = { organizations: 1, batchesPerOrganization: 3 };
  const batch0Missing = seedBatchSummary(jsonl([batch(0, 0, 900), batch(0, 1, 900, timed), batch(0, 2, 900, timed), organizationRow(0)]), undefined, { shape, arm: 'instrumented' });
  assert.deepEqual([batch0Missing.batches, batch0Missing.dbClockMissing, batch0Missing.medianBatches, batch0Missing.medianDbClockSpanMs], [3, 1, 2, 1],
    'batch 0 has no clock: missing, though it stays out of the median');
  const malformed = seedBatchSummary(jsonl([batch(0, 0, 900, timed), 'not json', '{"kind":"batch","organization":0}', '{"kind":"batch"']), undefined, { shape, arm: 'instrumented', stop: { rule: 'seed-failure' } as never });
  assert.deepEqual([malformed.batches, malformed.malformedLines], [1, 3]);
  assert.equal(seedBatchSummary(jsonl([batch(0, 0, 900, timed)]), undefined, { shape, arm: 'instrumented', stop: { rule: 'seed-failure' } as never }).serverMissing, 1,
    'without the DB log every server duration is missing');
});

test('the timing file must hold every expected row in order and in full, or the batch summary reports a collection failure', () => {
  const shape = { organizations: 2, batchesPerOrganization: 3 };
  const complete = [0, 1].flatMap(o => [batch(o, 0, 900), batch(o, 1, 900), batch(o, 2, 900), organizationRow(o)]);
  const summary = (rows: unknown[], stop?: object, arm: 'instrumented' | 'baseline' = 'instrumented') => {
    const { perBatch: _, ...rest } = seedBatchSummary(jsonl(rows), undefined, { shape, stop: stop as never, arm });
    return rest;
  };
  const counts = (rows: unknown[], stop?: object, arm?: 'instrumented' | 'baseline') => {
    const result = summary(rows, stop, arm);
    return [result.expectedRows, result.missingRows, result.unexpectedRows, result.malformedLines];
  };
  assert.deepEqual(counts(complete), [8, 0, 0, 0]);
  // An empty timing file after a completed seed is eight missing rows, not zero failures.
  assert.deepEqual(counts([]), [8, 8, 0, 0]);
  assert.deepEqual(batchSummaryFailures(summary([])).slice(0, 1), ['seed-timing.jsonl: 8 of 8 expected rows missing']);
  // A whole batch row lost in the middle: one missing, and every later row is out of place.
  assert.deepEqual(counts(complete.filter((_, i) => i !== 1)), [8, 1, 6, 0]);
  // Rows that do not have the shape the arm writes are malformed.
  for (const bad of ['{"kind":"organization"}', JSON.stringify({ ...organizationRow(0), extra: 1 }), JSON.stringify({ kind: 'batch', organization: 0, batchIndex: 0, durationMs: 900 }),
    JSON.stringify({ ...batch(0, 0, 900), batchIndex: -1 }), JSON.stringify({ ...batch(0, 0, 900), durationMs: 'slow' }), JSON.stringify({ ...batch(0, 0, 900, { ...clock(1, 1, 7), dbClock: 'missing' }) }),
    JSON.stringify((({ recorderMs: _, ...row }) => row)(batch(0, 0, 900))), '[]', 'null'])
    assert.equal(summary([bad, ...complete.slice(1)]).malformedLines, 1, bad);
  // After a stop rule the rows run exactly through the stopping batch or Organization row.
  const messageStop = { rule: 'message-batch', organization: 1, batchIndex: 1 };
  assert.deepEqual(counts(complete.slice(0, 6), messageStop), [6, 0, 0, 0]);
  assert.deepEqual(counts(complete.slice(0, 5), messageStop), [6, 1, 0, 0]);
  assert.deepEqual(counts(complete.slice(0, 8), { rule: 'organization-total', organization: 1, batchIndex: 2 }), [8, 0, 0, 0]);
  assert.deepEqual(counts(complete.slice(0, 7), { rule: 'organization-total', organization: 1, batchIndex: 2 }), [8, 1, 0, 0]);
  // After another seed failure any prefix is complete, but a gap is still out of place.
  assert.deepEqual(counts(complete.slice(0, 3), { rule: 'seed-failure' }), [3, 0, 0, 0]);
  assert.deepEqual(counts([complete[0], complete[2]], { rule: 'seed-failure' }), [2, 0, 1, 0]);
  // The baseline arm (the formal seed) writes the origin/main fields exactly, and has no clocks or server times by design.
  const formal = [0, 1].flatMap(o => [0, 1, 2].map(b => ({ kind: 'batch', organization: o, batchIndex: b, durationMs: 900 })).concat([{ kind: 'organization', organization: o, durationMs: 30_000 } as never]));
  assert.deepEqual(counts(formal, undefined, 'baseline'), [8, 0, 0, 0]);
  assert.deepEqual(batchSummaryFailures(summary(formal, undefined, 'baseline')), []);
  assert.deepEqual(counts(complete, undefined, 'baseline'), [8, 8, 0, 8], 'instrumented rows are not baseline rows');
  assert.deepEqual(seedShape('main'), { organizations: 10, batchesPerOrganization: 200 });
});
