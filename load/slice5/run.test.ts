import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { nights, partD, timelineEnv, type Arm } from './config.ts';
import { classifyPartDFailure, judgePartD, parseTimeline, timelineTopics, type RunD, type Verdict } from './judge.ts';
import * as judge from './judge.ts';
import * as report from './report.ts';

// Execute the runner's actual helpers with I/O replaced. Importing run.ts would execute its CLI.
const source = readFileSync(new URL('./run.ts', import.meta.url), 'utf8');
const runBoundary = source.slice(source.indexOf('function run('), source.indexOf('function extract('));
const stopBoundary = source.slice(source.indexOf('let child:'), source.indexOf("process.on('SIGINT'"));
const deadline = source.split('\n').find(line => line.startsWith('const deadline ='))!;
const executeRun = new Function('proc', 'setTimeout', 'clearTimeout', 'config', `
  const check = () => {}, spawn = () => proc;
  ${stripTypeScriptTypes(stopBoundary + runBoundary)}
  ${deadline}
  return run('unused', [], { timeoutMs: 30 * 60_000 });
`) as (proc: EventEmitter, setTimeout: (fire: () => void, ms: number) => number, clearTimeout: (ms: number) => void, config: typeof nights['2']) => Promise<Cargo>;

const boundary = source.slice(source.indexOf('function partDPostgresState('), source.indexOf('let failed = false;'));
const scoring = source.slice(source.indexOf('  for (const part of parts)'));
const execute = new Function('deps', 'runs', `
  const { mkdirSync, readFileSync, docker, sleep, run, writeFileSync, save,
    randomUUID, parseTimeline, timelineTopics, timelineEnv, classifyPartDFailure, partD, judgePartD, spawnSync,
    scanPartDPostgresLog, readResults, scorePartDFiles } = deps;
  const process = { env: {}, exit: code => { exitCode = code; } };
  const console = { log: () => {}, error: () => {} };
  const output = '/unused', project = 'unit-test', smoke = false, tiny = {}, full = { B: 'b975ffa', A: 'f7fe08a' };
  const source = () => '/unused', dbCommand = () => ['postgres'];
  const cleanupErrors = [], faults = [], interrupted = '', check = () => {}, parts = ['D'], scope = 'test', night = '2';
  const results = [], partC = { cells: [] }, scratch = '/unused', deadline = 0, rmSync = () => {};
  const plan = { rounds: [], cellsA: [], cellsB: [] };
  for (const [arm, round] of runs) (plan.rounds[round - 1] ??= []).push(arm);
  let failed = false, exitCode;
  ${stripTypeScriptTypes(boundary)}
  return (async () => {
    ${stripTypeScriptTypes('try {\n' + scoring)}
    return { results, faults, exitCode };
  })();
`) as (deps: Record<string, unknown>, runs: [Arm, number][]) => Promise<{ results: RunD[]; faults: string[]; exitCode: number }>;

type Cargo = { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; nightDeadline: boolean; stdout: string; stderr: string };
const exit = { exitCode: 101, signal: null, timedOut: false };
const alive = { Running: true, OOMKilled: false, ExitCode: 0, Health: 'healthy' };
const password = 'test-only-password';
const running = '    Running unittests src/lib.rs (target/release/deps/fukulow_server-abcdef)';
const target = `messages::tests::topics::measurement::${partD.target}`;
const assertionLog = `${running}
thread '${target}' (234) panicked at server/src/messages/tests/topics/measurement.rs:140:5:
assertion failed: ${password}`;
const summary = `running 1 test
test ${target} ... FAILED
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 123 filtered out`;
const compileLog = 'error[E0308]: mismatched types\nerror: could not compile `fukulow-server` (lib test) due to 1 previous error';
const cargo = (override: Partial<Cargo> = {}): Cargo => ({ code: 101, signal: null, timedOut: false, nightDeadline: false, stdout: '', stderr: '', ...override });
const assertion = cargo({ stderr: assertionLog, stdout: summary });
const compile = cargo({ stderr: compileLog });
const success = cargo({ code: 0, stderr: `${running}
TOPIC_DATA topics=10000 pre_w_topic_messages=100000
TOPIC_PAGE boundary=None n=400 p50_ms=1 p95_ms=10 max_ms=20
TOPIC_PAGE boundary=Some(190000) n=400 p50_ms=1 p95_ms=10 max_ms=20
TOPIC_SEND boundary=None n=20 p50_ms=1 p95_ms=10 max_ms=20
TOPIC_SEND boundary=Some(190000) n=20 p50_ms=1 p95_ms=10 max_ms=20` });
const timeout = cargo({ code: null, signal: 'SIGTERM', timedOut: true });

test('run distinguishes its 30-minute timer from a hard night deadline kill', async () => {
  for (const [code, signal, timedOut, nightDeadline] of [
    [101, null, false, false], [null, 'SIGTERM', false, false], [null, 'SIGTERM', true, false], [null, 'SIGTERM', false, true],
  ] as const) {
    const killed: string[] = [];
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: (signal: string) => { killed.push(signal); return true; },
    });
    const timers = new Map<number, () => void>();
    const result = executeRun(proc, (callback, ms) => { timers.set(ms, callback); return ms; }, ms => { timers.delete(ms); }, nights['2']);
    if (timedOut) timers.get(30 * 60_000)!();
    if (nightDeadline) timers.get(210 * 60_000)!();
    proc.emit('exit', code, signal);
    assert.equal(timers.has(30 * 60_000), false);
    proc.emit('close', code, signal);
    assert.deepEqual(await result, cargo({ code, signal, timedOut, nightDeadline }));
    assert.deepEqual(killed, timedOut || nightDeadline ? ['SIGTERM'] : []);
  }
});

test('classification requires a target-test panic, failed libtest summary and evidence the test binary ran', () => {
  const log = `${assertionLog}\n${summary}`;
  assert.deepEqual(classifyPartDFailure(exit, log, alive), { ...exit, cause: 'assertion',
    evidence: ['Running unittests', 'target test panicked at', 'test result: FAILED'] });
  assert.equal(classifyPartDFailure(exit, log.replace(running, ''), alive)?.cause, 'assertion');
  for (const incomplete of [log.replace(running, '').replace('running 1 test', ''), log.replace(`thread '${target}'`, "thread 'other_test'"),
    log.replace('test result: FAILED', ''), `${log}\n${compileLog}`.replace('test result: FAILED', ''),
    log.replace(`assertion failed: ${password}`, '')]) {
    assert.equal(classifyPartDFailure(exit, incomplete, alive)?.cause, 'unknown');
  }
});

const panicWith = (message: string) => cargo({ ...assertion, stderr: assertionLog.replace(`assertion failed: ${password}`, message) });
const connectionReset = panicWith('called `Result::unwrap()` on an `Err` value: Io(Os { message: "Connection reset by peer" })');
const http500 = panicWith("assertion `left == right` failed\n  left: 500\n right: 200");
const gateMiss = panicWith('feasibility gate missed: stop; do not add a limit');

test('target HTTP 5xx panic with running PostgreSQL is unknown even with no crash markers', async () => {
  for (const failed of [http500, panicWith('StatusCode(503)'), panicWith('500 Internal Server Error')]) {
    const { results, starts, nightSummary } = await exercise([['A', 1]], [failed]);
    assert.equal(results[0].failure?.cause, 'unknown');
    assert.ok(results[0].failure.evidence.includes('HTTP 5xx status'));
    assert.equal(starts, 1);
    assert.match(nightSummary.verdicts[0].reasons[0], /unknown.*investigate/);
  }
});

test('PostgreSQL crash evidence makes a 5xx or ordinary target panic unknown while PostgreSQL runs', async () => {
  for (const failed of [http500, assertion]) {
    const { results, starts } = await exercise([['A', 1]], [failed],
      { postgresLog: 'LOG: server process (PID 12) was terminated by signal 9' });
    assert.equal(results[0].failure?.cause, 'unknown');
    assert.ok(results[0].failure.evidence.includes('terminated by signal'));
    assert.equal(starts, 1);
  }
});

test('explicit gate miss and FAILED beat a later PostgreSQL OOM', async () => {
  const failure = classifyPartDFailure(exit, `${gateMiss.stderr}\n${summary}`, { ...alive, Running: false, OOMKilled: true });
  assert.equal(failure?.cause, 'assertion');
  for (const marker of ['feasibility gate missed', 'PostgreSQL OOMKilled', 'PostgreSQL stopped'])
    assert.ok(failure.evidence.includes(marker));
  const { results, starts, nightSummary } = await exercise([['A', 1]], [gateMiss],
    { inspect: '[false,true,137,null]', postgresLog: 'LOG: redo starts at 0/123' });
  assert.equal(starts, 1);
  assert.ok(results[0].failure?.evidence.includes('redo starts at'));
  assert.equal(nightSummary.verdicts[0].status, 'FAIL');
});

test('explicit gate miss and FAILED beat unknown PostgreSQL state', () => {
  const failure = classifyPartDFailure(exit, `${gateMiss.stderr}\n${summary}`);
  assert.equal(failure?.cause, 'assertion');
  assert.ok(failure.evidence.includes('feasibility gate missed'));
  assert.ok(failure.evidence.includes('PostgreSQL state unknown'));
  assert.equal(classifyPartDFailure(exit, gateMiss.stderr)?.cause, 'unknown');
  assert.equal(classifyPartDFailure(exit, `${gateMiss.stderr} (other)\n${summary}`)?.cause, 'unknown');
});

test('explicit gate miss and FAILED beat timeout, night deadline and process/binary signals', () => {
  const termination = { exitCode: null, signal: 'SIGTERM', timedOut: true, nightDeadline: true } as const;
  const log = `${gateMiss.stderr}\n${summary}\nerror: process didn't exit successfully: target (signal: 9, SIGKILL)`;
  const failure = classifyPartDFailure(termination, log);
  assert.equal(failure?.cause, 'assertion');
  for (const marker of ['feasibility gate missed', 'runner timeout fired', 'night-deadline',
    'process terminated by signal', 'test binary terminated by signal 9'])
    assert.ok(failure.evidence.includes(marker));
});

test('PostgreSQL log collection records the allowlisted markers only, and reports an unavailable read', async () => {
  const markers = ['terminated by signal', 'terminating any other active server processes',
    'database system was interrupted', 'redo starts at', 'No space left on device', 'out of memory',
    'could not fork', 'the database system is in recovery mode'];
  const postgresLog = [...markers, markers[0], 'database system is ready to accept connections']
    .map(marker => `LOG: ${marker.toUpperCase()} ${password}`).join('\n');
  const { results, logs } = await exercise([['A', 1]], [assertion], { postgresLog });
  assert.deepEqual(results[0].failure?.evidence.slice(-markers.length), markers);
  assert.doesNotMatch(JSON.stringify({ results, logs }), /test-only-password|LOG:|ready to accept/);
  const unavailable = await exercise([['A', 1]], [assertion], { postgresLog: new Error(password) });
  assert.ok(unavailable.results[0].failure?.evidence.includes('PostgreSQL log unavailable'));
  assert.doesNotMatch(JSON.stringify(unavailable.results), /test-only-password/);
});

test('explicit database, IO and pool panic markers exclude assertions with live PostgreSQL', () => {
  for (const message of ['Database(PgDatabaseError { message: "could not write" })', 'Io(Custom { kind: Other })',
    'Protocol("invalid response")', 'Tls("handshake failed")', 'WorkerCrashed', 'PoolTimedOut', 'PoolClosed',
    'Connection reset by peer', 'Connection refused', 'Connection closed', 'Connection is closed', 'Connection aborted', 'Connection timed out',
    'Broken pipe', 'Unexpected EOF', 'Unexpected end of file', 'server closed the connection unexpectedly', 'No space left on device',
    'I/O error', 'IO error', 'error communicating with database', 'pool timed out', 'pool closed', 'pool is closed',
    'timed out while waiting for an open connection']) {
    const failure = classifyPartDFailure(exit, `${panicWith(`unwrap failed:\n  ${message}`).stderr}\n${summary}`, alive);
    assert.equal(failure?.cause, 'unknown', message);
    assert.ok(failure.evidence.includes('database/IO/pool panic'), message);
  }
  const unrelated = `thread 'other_test' panicked at src/lib.rs:1:1:\nPoolClosed`;
  assert.equal(classifyPartDFailure(exit, `${assertionLog}\n${unrelated}\n${summary}`, alive)?.cause, 'assertion');
});

test('classification recognizes build and compile markers before the test binary runs', () => {
  assert.deepEqual(classifyPartDFailure(exit, compileLog, alive)?.evidence.slice(-2), ['compiler error[E…]', 'could not compile']);
  for (const log of ['error: could not compile `fukulow-server`', 'error: failed to run custom build command for `dep`']) {
    assert.equal(classifyPartDFailure(exit, log)?.cause, 'infrastructure');
  }
  assert.equal(classifyPartDFailure(exit, `running 1 test\n${compileLog}`)?.cause, 'unknown');
});

test('an exit code alone gives unknown with a missing summary marker', () => {
  assert.deepEqual(classifyPartDFailure(exit, '', alive), { ...exit, cause: 'unknown', evidence: ['missing libtest summary'] });
  assert.equal(classifyPartDFailure({ ...exit, exitCode: 0 }, ''), null);
});

type Summary = { failed: boolean; cleanupErrors: string[]; verdicts: Verdict[] };
type Options = { dbUnavailable?: boolean; inspect?: string | Error; postgresLog?: string | Error; halfCreated?: boolean;
  failWrites?: string[]; failLastAggregate?: boolean };

async function exercise(runs: [Arm, number][], outputs: Cargo[], options: Options = {}) {
  const dir = mkdtempSync(`${tmpdir()}/slice5-run-test-`);
  const onDisk = (path: string) => path.replace('/unused', dir);
  const saved = new Map<string, RunD>(), logs: string[] = [], containerCalls: string[] = [], writes: string[] = [];
  let nightSummary: Summary | undefined, containerPresent = false;
  let invocations = 0, starts = 0, aggregateWrites = 0;
  const write = (path: string) => {
    writes.push(path);
    if (options.failWrites?.some(suffix => path.endsWith(suffix)) ||
      (path.endsWith('/results.json') && ++aggregateWrites === runs.length && options.failLastAggregate))
      throw new Error('test artifact write failed');
  };
  const execution = await execute({
    mkdirSync: (path: string) => { write(path); mkdirSync(onDisk(path), { recursive: true }); },
    readFileSync: () => 'image: postgres:18.6',
    spawnSync: (file: string, args: string[]) => {
      assert.equal(file, 'docker');
      assert.deepEqual(args, ['logs', args[1]]);
      assert.equal(containerPresent, true);
      if (options.postgresLog instanceof Error) return { status: 1, stdout: '', stderr: options.postgresLog.message };
      const lines = (options.postgresLog ?? '').split('\n');
      return { status: 0, stdout: lines.slice(0, 1).join('\n'), stderr: lines.slice(1).join('\n') };
    },
    docker: (command: string, ...args: string[]) => {
      if (['run', 'inspect', 'rm'].includes(command)) containerCalls.push(command);
      if (command === 'run') {
        assert.ok(!args.includes('--rm'));
        assert.equal(containerPresent, false, 'container name already in use');
        starts++;
        containerPresent = true;
        if (options.halfCreated && starts === 1) throw new Error('docker run failed after creating container');
      }
      if (command === 'exec') return options.dbUnavailable && starts === 1 ? 'no' : 'ok';
      if (command === 'inspect') {
        assert.equal(containerPresent, true);
        assert.deepEqual(args, ['--format', '[{{json .State.Running}},{{json .State.OOMKilled}},{{json .State.ExitCode}},{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}]', args[2]]);
        if (options.inspect instanceof Error) throw options.inspect;
        return options.inspect ?? '[true,false,0,"healthy"]';
      }
      if (command === 'rm') {
        if (!containerPresent) throw Object.assign(new Error('absent'), { stderr: 'Error response from daemon: No such container' });
        containerPresent = false;
      }
      return '127.0.0.1:1234';
    },
    sleep: async () => {}, run: async () => { assert.ok(outputs[invocations], 'unexpected Cargo invocation'); return outputs[invocations++]; },
    writeFileSync: (path: string, log: string) => { write(path); logs.push(log); },
    save: (path: string, value: RunD | Summary) => {
      write(path);
      writeFileSync(onDisk(path), JSON.stringify(value));
      if (path.endsWith('/result.json')) saved.set(path, value as RunD);
      if (path.endsWith('/summary.json')) nightSummary = value as Summary;
    },
    readResults: (path: string) => report.readResults(onDisk(path)),
    scorePartDFiles: (...[path, aggregate, schedule]: Parameters<typeof report.scorePartDFiles>) =>
      report.scorePartDFiles(onDisk(path), aggregate, schedule),
    randomUUID: () => password, parseTimeline, timelineTopics, timelineEnv, classifyPartDFailure, partD, judgePartD,
    scanPartDPostgresLog: judge.scanPartDPostgresLog,
  }, runs).then(result => {
    if (!options.failLastAggregate) return { ...result, mergedReport: '' };
    writeFileSync(`${dir}/metadata.json`, JSON.stringify({ night: '2', parts: ['B', 'C', 'D'], smoke: false }));
    const n2 = report.load(dir);
    const n1 = { ...n2, metadata: { ...n2.metadata, night: '1', parts: ['A'] }, results: [] };
    assert.equal(n2.results.length, runs.length - 1);
    return { ...result, mergedReport: report.render(n1, n2) };
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(invocations, outputs.length);
  assert.equal(containerPresent, false);
  assert.ok(nightSummary);
  return { ...execution, saved, logs, starts, writes, containerCalls, nightSummary };
}

test('A assertion with live PostgreSQL stays FAIL and sets summary.failed without a rerun', async () => {
  const { results, saved, logs, faults, starts, nightSummary, exitCode, containerCalls } = await exercise([['A', 1]], [assertion]);
  assert.equal(starts, 1);
  assert.deepEqual(faults, []);
  assert.equal(results[0].failure?.cause, 'assertion');
  assert.deepEqual(results[0].postgres, alive);
  assert.deepEqual(containerCalls, ['rm', 'run', 'inspect', 'rm']);
  assert.deepEqual(results[0].rows, []);
  assert.equal(saved.get('/unused/runs/D-1-A/result.json'), results[0]);
  assert.ok(logs[0].includes('<redacted>'));
  assert.ok(!logs[0].includes(password) && !JSON.stringify(results[0]).includes(password));
  assert.equal(nightSummary.failed, true);
  assert.equal(exitCode, 1);
  const verdict = nightSummary.verdicts[0];
  assert.equal(verdict.status, 'FAIL');
  assert.match(verdict.reasons[0], /A1: assertion/);
});

test('a connection-reset panic with live PostgreSQL is unknown and gets no rerun', async () => {
  const { results, starts, nightSummary } = await exercise([['A', 1]], [connectionReset]);
  assert.equal(starts, 1);
  assert.equal(results[0].failure?.cause, 'unknown');
  assert.ok(results[0].failure?.evidence.includes('database/IO/pool panic'));
  assert.equal(nightSummary.verdicts[0].status, 'INVALID');
  assert.equal(nightSummary.failed, true);
});

test('failed, missing or malformed PostgreSQL inspect leaves the state unknown and prevents an assertion', async () => {
  for (const inspect of [new Error('inspect failed'), '', '[true,false,0,"unexpected field"]']) {
    const { results, starts, containerCalls } = await exercise([['A', 1]], [assertion], { inspect });
    assert.equal(starts, 1);
    assert.equal(results[0].postgres, null);
    assert.equal(results[0].failure?.cause, 'unknown');
    assert.ok(results[0].failure?.evidence.includes('PostgreSQL state unknown'));
    assert.deepEqual(containerCalls, ['rm', 'run', 'inspect', 'rm']);
  }
});

test('a target panic with stopped or OOM-killed PostgreSQL is confirmed infrastructure', async () => {
  for (const [inspect, marker] of [['[false,true,137,null]', 'PostgreSQL OOMKilled'],
    ['[false,false,1,null]', 'PostgreSQL stopped'], ['[true,true,0,null]', 'PostgreSQL OOMKilled']]) {
    const { saved, results, starts } = await exercise([['A', 1]], [assertion, success], { inspect });
    assert.equal(starts, 2);
    const initial = saved.get('/unused/runs/D-1-A/result.json');
    assert.equal(initial?.failure?.cause, 'infrastructure');
    assert.ok(initial?.failure?.evidence.includes(marker));
    const [Running, OOMKilled, ExitCode, Health] = JSON.parse(inspect);
    assert.deepEqual(initial?.postgres, { Running, OOMKilled, ExitCode, Health });
    assert.equal(results[0].failure, null);
  }
});

test('A round 1 assertion stays FAIL when A round 2 times out', async () => {
  const { results, starts } = await exercise([['A', 1], ['A', 2]], [assertion, timeout]);
  assert.equal(starts, 2);
  assert.equal(judgePartD(results)[0].status, 'FAIL');
  assert.match(judgePartD(results)[0].reasons[1], /A2: timeout.*investigate/);
});

test('A assertion stays FAIL when another run uses the infrastructure rerun', async () => {
  const { results, saved, faults, starts } = await exercise([['A', 1], ['B', 2]], [assertion, compile, success]);
  assert.equal(starts, 3);
  assert.equal(faults.filter(f => f.includes('single infrastructure rerun')).length, 1);
  assert.equal(saved.get('/unused/runs/D-2-B/result.json')?.failure?.cause, 'infrastructure');
  assert.equal(saved.get('/unused/runs/D-2-B-rerun/result.json')?.failure, null);
  assert.equal(judgePartD(results)[0].status, 'FAIL');
});

test('B assertion makes Part D INVALID without a rerun', async () => {
  const { results, starts } = await exercise([['B', 1]], [assertion]);
  assert.equal(starts, 1);
  const verdict = judgePartD(results)[0];
  assert.equal(verdict.status, 'INVALID');
  assert.match(verdict.reasons[0], /B1: assertion \(no baseline\)/);
});

test('confirmed A assertion takes precedence over a later timeout or signal and preserves the markers', async () => {
  for (const termination of [timeout, cargo({ code: null, signal: 'SIGTERM' }),
    cargo({ code: null, signal: 'SIGTERM', nightDeadline: true })]) {
    const { results, starts, nightSummary } = await exercise([['A', 1]], [cargo({ ...assertion,
      code: termination.code, signal: termination.signal, timedOut: termination.timedOut, nightDeadline: termination.nightDeadline })]);
    assert.equal(starts, 1);
    const failure = results[0].failure;
    assert.equal(failure?.cause, 'assertion');
    assert.equal(failure.signal, 'SIGTERM');
    assert.ok(failure.evidence.includes('process terminated by signal'));
    assert.equal(failure.evidence.includes('runner timeout fired'), termination.timedOut);
    assert.equal(failure.evidence.includes('night-deadline'), termination.nightDeadline);
    assert.equal(nightSummary.verdicts[0].status, 'FAIL');
  }
});

test('runner timeout and night-deadline kill without assertion evidence are INVALID without a rerun', async () => {
  for (const [termination, marker] of [[timeout, 'runner timeout fired'],
    [cargo({ code: null, signal: 'SIGTERM', nightDeadline: true }), 'night-deadline']] as const) {
    const { results, starts, nightSummary } = await exercise([['A', 1]], [termination]);
    assert.equal(starts, 1);
    assert.equal(results[0].failure?.cause, 'timeout');
    assert.deepEqual(results[0].failure.evidence, [marker, 'process terminated by signal', 'missing libtest summary']);
    assert.equal(nightSummary.verdicts[0].status, 'INVALID');
    assert.match(nightSummary.verdicts[0].reasons[0], /timeout.*investigate/);
  }
});

test('an unknown exit or unexpected signal makes Part D INVALID without a rerun', async () => {
  const { results, starts } = await exercise([['A', 1], ['B', 1]], [cargo(), cargo({ code: null, signal: 'SIGKILL' })]);
  assert.equal(starts, 2);
  assert.deepEqual(results.map(r => r.failure?.cause), ['unknown', 'unknown']);
  const verdict = judgePartD(results)[0];
  assert.equal(verdict.status, 'INVALID');
  assert.match(verdict.reasons[0], /unknown.*investigate.*101/);
  assert.match(verdict.reasons[1], /unknown.*investigate.*SIGKILL/);
});

test('Cargo test-binary signal and missing libtest summary are recorded without a rerun', async () => {
  for (const prefix of ['error: ', "error: test failed, to rerun pass `--lib`\n\nCaused by:\n  "]) {
    const killed = cargo({ stderr: `${running}\n${prefix}process didn't exit successfully: \`target/release/deps/fukulow_server --ignored\` (signal: 9, SIGKILL)` });
    const { results, starts, nightSummary } = await exercise([['A', 1]], [killed]);
    assert.equal(starts, 1);
    assert.equal(results[0].failure?.cause, 'unknown');
    assert.ok(results[0].failure.evidence.includes('test binary terminated by signal 9'));
    assert.ok(results[0].failure.evidence.includes('missing libtest summary'));
    assert.equal(nightSummary.verdicts[0].status, 'INVALID');
  }
});

test('result.json is saved before a failing cargo.log write and the A FAIL still scores', async () => {
  const { results, saved, starts, writes, nightSummary } = await exercise([['A', 1], ['B', 1]], [assertion, success], { failWrites: ['D-1-A/cargo.log'] });
  assert.equal(starts, 2);
  const result = '/unused/runs/D-1-A/result.json', log = '/unused/runs/D-1-A/cargo.log';
  assert.ok(writes.indexOf(result) < writes.indexOf(log));
  assert.equal(saved.get(result), results[0]);
  assert.equal(nightSummary.verdicts[0].status, 'FAIL');
  assert.deepEqual(nightSummary.cleanupErrors, ['D-1-A/cargo.log: artifact write failed']);
});

test('Part D directory, result and aggregate write errors make a missing round INVALID and preserve subsequent runs', async () => {
  const { results, starts, nightSummary } = await exercise([['A', 1], ['B', 1]], [assertion, success],
    { failWrites: ['D-1-A', 'D-1-A/result.json', '/results.json'] });
  assert.equal(starts, 2);
  assert.equal(results.length, 2);
  assert.equal(nightSummary.verdicts[0].status, 'INVALID');
  assert.match(nightSummary.verdicts[0].reasons[0], /D-1-A\/result\.json/);
  for (const marker of ['D-1-A/', 'D-1-A/result.json', 'results.json']) {
    assert.ok(nightSummary.cleanupErrors.includes(`${marker}: artifact write failed`));
  }
});

test('last results.json write failure leaves a stale aggregate but A3 FAIL survives in the report and summary', async () => {
  const { mergedReport, nightSummary } = await exercise([['B', 1], ['A', 1], ['A', 2], ['B', 2], ['B', 3], ['A', 3]],
    [success, success, success, success, success, gateMiss], { failLastAggregate: true });
  assert.match(mergedReport, /\| D \| timeline \| FAIL \| A3: assertion/);
  assert.match(mergedReport, /results\.json disagrees with Part D round files/);
  assert.equal(nightSummary.verdicts[0].status, 'FAIL');
  assert.ok(nightSummary.verdicts[0].reasons.includes('results.json disagrees with Part D round files'));
  assert.ok(nightSummary.cleanupErrors.includes('results.json: artifact write failed'));
});

test('compile failure uses the one infrastructure rerun across all Part D rounds', async () => {
  const { results, saved, faults, starts } = await exercise([['B', 1], ['A', 1]], [compile, compile, compile]);
  assert.equal(starts, 3);
  assert.equal(saved.size, 3);
  assert.equal(faults.filter(f => f.includes('single infrastructure rerun')).length, 1);
  assert.ok(results.every(r => r.failure?.cause === 'infrastructure'));
  const verdict = judgePartD(results)[0];
  assert.equal(verdict.status, 'INVALID');
  assert.match(verdict.reasons[0], /infrastructure.*could not compile/);
});

test('a successful infrastructure rerun supplies the timeline rows and leaves summary.failed false', async () => {
  const { results, saved, nightSummary, exitCode } = await exercise([['B', 1], ['A', 1], ['A', 2], ['B', 2], ['B', 3], ['A', 3]],
    [compile, success, success, success, success, success, success]);
  assert.equal(saved.get('/unused/runs/D-1-B/result.json')?.failure?.cause, 'infrastructure');
  const retry = saved.get('/unused/runs/D-1-B-rerun/result.json');
  assert.equal(results[0], retry);
  assert.equal(retry?.topics, 10000);
  assert.equal(retry?.rows.length, 4);
  assert.deepEqual(nightSummary.verdicts.map(v => v.status), ['PASS', 'PASS', 'REPORT ONLY', 'REPORT ONLY']);
  assert.equal(nightSummary.failed, false);
  assert.equal(exitCode, 0);
});

test('a DB readiness failure is saved before Cargo and uses the same Part D rerun budget', async () => {
  const { results, saved, starts } = await exercise([['A', 1], ['B', 1]], [success, compile], { dbUnavailable: true });
  assert.equal(starts, 3);
  assert.deepEqual(saved.get('/unused/runs/D-1-A/result.json')?.failure, {
    cause: 'infrastructure', exitCode: null, signal: null, timedOut: false, evidence: ['PostgreSQL readiness failed'],
  });
  assert.equal(results[0].failure, null);
  assert.equal(results[1].failure?.cause, 'infrastructure');
});

test('a half-created container is inspected and removed before the rerun reuses its name', async () => {
  const { saved, starts, containerCalls, nightSummary } = await exercise([['B', 1]], [success], { halfCreated: true });
  assert.equal(starts, 2);
  assert.deepEqual(containerCalls, ['rm', 'run', 'inspect', 'rm', 'rm', 'run', 'inspect', 'rm']);
  assert.deepEqual(saved.get('/unused/runs/D-1-B/result.json')?.failure?.evidence, ['PostgreSQL docker run failed']);
  assert.equal(nightSummary.failed, false);
  assert.deepEqual(nightSummary.cleanupErrors, []);
});
