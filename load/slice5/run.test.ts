import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { partD, timelineEnv, type Arm } from './config.ts';
import { classifyPartDFailure, judgePartD, parseTimeline, timelineTopics, type RunD } from './judge.ts';

// Execute the runner's actual helpers with I/O replaced. Importing run.ts would execute its CLI.
const source = readFileSync(new URL('./run.ts', import.meta.url), 'utf8');
const runBoundary = source.slice(source.indexOf('function run('), source.indexOf('function extract('));
const executeRun = new Function('proc', 'setTimeout', 'clearTimeout', `
  let child, childName;
  const check = () => {}, spawn = () => proc;
  ${stripTypeScriptTypes(runBoundary)}
  return run('unused', [], { timeoutMs: 30 * 60_000 });
`) as (proc: EventEmitter, setTimeout: (fire: () => void, ms: number) => void, clearTimeout: () => void) => Promise<Cargo>;

const boundary = source.slice(source.indexOf('async function partDRun('), source.indexOf('let failed = false;'));
const execute = new Function('deps', 'runs', `
  const { mkdirSync, readFileSync, docker, sleep, run, writeFileSync, save,
    randomUUID, parseTimeline, timelineTopics, timelineEnv, classifyPartDFailure, partD } = deps;
  const output = '/unused', project = 'unit-test', smoke = false, tiny = {}, full = { B: 'b975ffa', A: 'f7fe08a' };
  const source = () => '/unused', dbCommand = () => ['postgres'];
  const cleanupErrors = [], faults = [], interrupted = '', check = () => {};
  ${stripTypeScriptTypes(boundary)}
  return (async () => {
    const results = [];
    for (const [arm, round] of runs) results.push(await attemptPartD(arm, round));
    return { results, faults };
  })();
`) as (deps: Record<string, unknown>, runs: [Arm, number][]) => Promise<{ results: RunD[]; faults: string[] }>;

type Cargo = { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; stdout: string; stderr: string };
const exit = { exitCode: 101, signal: null, timedOut: false };
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
const cargo = (override: Partial<Cargo> = {}): Cargo => ({ code: 101, signal: null, timedOut: false, stdout: '', stderr: '', ...override });
const assertion = cargo({ stderr: assertionLog, stdout: summary });
const compile = cargo({ stderr: compileLog });
const success = cargo({ code: 0, stderr: `${running}
TOPIC_DATA topics=10000 pre_w_topic_messages=100000
TOPIC_PAGE boundary=None n=400 p50_ms=1 p95_ms=10 max_ms=20
TOPIC_PAGE boundary=Some(190000) n=400 p50_ms=1 p95_ms=10 max_ms=20
TOPIC_SEND boundary=None n=20 p50_ms=1 p95_ms=10 max_ms=20
TOPIC_SEND boundary=Some(190000) n=20 p50_ms=1 p95_ms=10 max_ms=20` });
const timeout = cargo({ ...assertion, code: null, signal: 'SIGTERM', timedOut: true });

test('run records the raw exit code, signal and whether its own 30-minute timer fired', async () => {
  for (const [code, signal, timedOut] of [[101, null, false], [null, 'SIGTERM', false], [null, 'SIGTERM', true]] as const) {
    const killed: string[] = [];
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: (signal: string) => killed.push(signal),
    });
    let fire: (() => void) | undefined;
    const result = executeRun(proc, (callback, ms) => { assert.equal(ms, 30 * 60_000); fire = callback; }, () => { fire = undefined; });
    if (timedOut) fire!();
    proc.emit('exit', code, signal);
    assert.equal(fire, undefined);
    proc.emit('close', code, signal);
    assert.deepEqual(await result, cargo({ code, signal, timedOut }));
    assert.deepEqual(killed, timedOut ? ['SIGTERM'] : []);
  }
});

test('classification requires a target-test panic, failed libtest summary and evidence the test binary ran', () => {
  const log = `${assertionLog}\n${summary}`;
  assert.deepEqual(classifyPartDFailure(exit, log), { ...exit, cause: 'assertion',
    evidence: ['Running unittests', 'target test panicked at', 'test result: FAILED'] });
  assert.equal(classifyPartDFailure(exit, log.replace(running, ''))?.cause, 'assertion');
  for (const incomplete of [log.replace(running, '').replace('running 1 test', ''), log.replace(`thread '${target}'`, "thread 'other_test'"),
    log.replace('test result: FAILED', ''), `${log}\n${compileLog}`.replace('test result: FAILED', '')]) {
    assert.equal(classifyPartDFailure(exit, incomplete)?.cause, 'unknown');
  }
});

test('classification recognizes build and compile markers before the test binary runs', () => {
  assert.deepEqual(classifyPartDFailure(exit, compileLog), { ...exit, cause: 'infrastructure', evidence: ['compiler error[E…]', 'could not compile'] });
  for (const log of ['error: could not compile `fukulow-server`', 'error: failed to run custom build command for `dep`']) {
    assert.equal(classifyPartDFailure(exit, log)?.cause, 'infrastructure');
  }
  assert.equal(classifyPartDFailure(exit, `running 1 test\n${compileLog}`)?.cause, 'unknown');
});

test('an exit code alone gives no classification evidence', () => {
  assert.deepEqual(classifyPartDFailure(exit, ''), { ...exit, cause: 'unknown', evidence: [] });
  assert.equal(classifyPartDFailure({ ...exit, exitCode: 0 }, ''), null);
});

async function exercise(runs: [Arm, number][], outputs: Cargo[], dbUnavailable = false) {
  const saved = new Map<string, RunD>(), logs: string[] = [];
  let invocations = 0, starts = 0;
  const execution = await execute({
    mkdirSync: () => {}, readFileSync: () => 'image: postgres:18.6',
    docker: (command: string) => {
      if (command === 'run') starts++;
      if (command === 'exec') return dbUnavailable && starts === 1 ? 'no' : 'ok';
      return '127.0.0.1:1234';
    },
    sleep: async () => {}, run: async () => { assert.ok(outputs[invocations], 'unexpected Cargo invocation'); return outputs[invocations++]; },
    writeFileSync: (_path: string, log: string) => logs.push(log),
    save: (path: string, value: RunD) => saved.set(path, value), randomUUID: () => password,
    parseTimeline, timelineTopics, timelineEnv, classifyPartDFailure, partD,
  }, runs);
  assert.equal(invocations, outputs.length);
  return { ...execution, saved, logs, starts };
}

test('A assertion without rows is saved as FAIL without a rerun and with redacted artifacts', async () => {
  const { results, saved, logs, faults, starts } = await exercise([['A', 1]], [assertion]);
  assert.equal(starts, 1);
  assert.deepEqual(faults, []);
  assert.equal(results[0].failure?.cause, 'assertion');
  assert.deepEqual(results[0].rows, []);
  assert.equal(saved.get('/unused/runs/D-1-A/result.json'), results[0]);
  assert.ok(logs[0].includes('<redacted>'));
  assert.ok(!logs[0].includes(password) && !JSON.stringify(results[0]).includes(password));
  const verdict = judgePartD(results)[0];
  assert.equal(verdict.status, 'FAIL');
  assert.match(verdict.reasons[0], /A1: assertion/);
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

test('the runner timeout takes precedence over assertion markers and gets no rerun', async () => {
  const { results, starts } = await exercise([['A', 1]], [timeout]);
  assert.equal(starts, 1);
  assert.deepEqual(results[0].failure, { cause: 'timeout', exitCode: null, signal: 'SIGTERM', timedOut: true, evidence: ['runner timeout fired'] });
  const verdict = judgePartD(results)[0];
  assert.equal(verdict.status, 'INVALID');
  assert.match(verdict.reasons[0], /timeout.*investigate/);
});

test('an unknown exit or unexpected signal makes Part D INVALID without a rerun', async () => {
  const { results, starts } = await exercise([['A', 1], ['B', 1]], [cargo(), cargo({ ...assertion, code: null, signal: 'SIGKILL' })]);
  assert.equal(starts, 2);
  assert.deepEqual(results.map(r => r.failure?.cause), ['unknown', 'unknown']);
  const verdict = judgePartD(results)[0];
  assert.equal(verdict.status, 'INVALID');
  assert.match(verdict.reasons[0], /unknown.*investigate.*101/);
  assert.match(verdict.reasons[1], /unknown.*investigate.*SIGKILL/);
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

test('a successful infrastructure rerun supplies the timeline rows for its round', async () => {
  const { results, saved } = await exercise([['B', 1], ['A', 1], ['A', 2], ['B', 2], ['B', 3], ['A', 3]],
    [compile, success, success, success, success, success, success]);
  assert.equal(saved.get('/unused/runs/D-1-B/result.json')?.failure?.cause, 'infrastructure');
  const retry = saved.get('/unused/runs/D-1-B-rerun/result.json');
  assert.equal(results[0], retry);
  assert.equal(retry?.topics, 10000);
  assert.equal(retry?.rows.length, 4);
  assert.deepEqual(judgePartD(results).map(v => v.status), ['PASS', 'PASS', 'REPORT ONLY', 'REPORT ONLY']);
});

test('a DB readiness failure is saved before Cargo and uses the same Part D rerun budget', async () => {
  const { results, saved, starts } = await exercise([['A', 1], ['B', 1]], [success, compile], true);
  assert.equal(starts, 3);
  assert.deepEqual(saved.get('/unused/runs/D-1-A/result.json')?.failure, {
    cause: 'infrastructure', exitCode: null, signal: null, timedOut: false, evidence: ['PostgreSQL readiness failed'],
  });
  assert.equal(results[0].failure, null);
  assert.equal(results[1].failure?.cause, 'infrastructure');
});
