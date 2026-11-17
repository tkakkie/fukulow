import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { timelineEnv } from './config.ts';
import { judgePartD, parseTimeline, timelineTopics, type RunD } from './judge.ts';

// Execute the runner's actual Part D + retry boundary with all I/O replaced.
// Importing run.ts itself would execute its CLI and Docker operations.
const source = readFileSync(new URL('./run.ts', import.meta.url), 'utf8');
const boundary = source.slice(source.indexOf('async function partDRun('), source.indexOf('let failed = false;'));
const execute = new Function('deps', `
  const { mkdirSync, readFileSync, docker, sleep, run, writeFileSync, save,
    randomUUID, parseTimeline, timelineTopics, timelineEnv } = deps;
  const output = '/unused', project = 'unit-test', smoke = false, tiny = {}, full = { B: 'b975ffa' };
  const source = () => '/unused', dbCommand = () => ['postgres'], partD = { target: 'test' };
  const cleanupErrors = [], faults = [], interrupted = '', check = () => {};
  let failed = false;
  ${stripTypeScriptTypes(boundary)}
  return attempt('D', 'D-1-B', () => partDRun('B', 1)).then(result => ({ result, failed, faults }));
`) as (deps: Record<string, unknown>) => Promise<{ result: RunD; failed: boolean; faults: string[] }>;

test('Part D correctness panic before any rows is reported as a run failure without a rerun (N13)', async () => {
  let invocations = 0, saved: RunD | undefined;
  const { result, failed, faults } = await execute({
    mkdirSync: () => {}, readFileSync: () => 'image: postgres:18.6',
    docker: (...args: string[]) => args[0] === 'exec' ? 'ok' : '127.0.0.1:1234',
    sleep: async () => {}, run: async () => { invocations++; return { code: 101, stdout: '', stderr: "thread 'test' panicked: assertion failed" }; },
    writeFileSync: () => {}, save: (_path: string, value: RunD) => { saved = value; }, randomUUID: () => 'test-only-password',
    parseTimeline, timelineTopics, timelineEnv,
  });
  assert.equal(invocations, 1);
  assert.equal(failed, true);
  assert.deepEqual(faults, []);
  assert.equal(result.exitCode, 101);
  assert.deepEqual(result.rows, []);
  assert.equal(saved, result);
  assert.equal(judgePartD([result])[0].status, 'FAIL');
});
